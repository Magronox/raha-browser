// chrome-identity.js on a fake webContents.debugger: the protocol
// choreography that keeps every frame of a tab looking like Chrome, and —
// more important — the discipline that keeps a page from hanging: a child
// target delivered paused is ALWAYS resumed, whatever else fails. Real
// Electron is exercised by tests/e2e/security-qa.spec.js; this pins the
// logic where it is cheap to break on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachChromeIdentity } from '../../src/main/electron/chrome-identity.js';
import { chromeClientHints } from '../../src/shared/client-hints.js';

const IDENTITY = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  navigatorPlatform: 'MacIntel',
  hints: chromeClientHints({ chromeVersion: '150.0.7871.224', platform: 'darwin', arch: 'x64', osVersion: '14.6.1' }),
};
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/**
 * A stand-in for Electron's webContents.debugger.
 * @param {{ attachThrows?: boolean, reject?: (method: string, sessionId?: string) => boolean, hang?: (method: string, sessionId?: string) => boolean }} [opts]
 */
function fakeWebContents(opts = {}) {
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  /** @type {{ method: string, params: any, sessionId: string|undefined }[]} */
  const sent = [];
  let attached = false;
  /** Rejecters of hung commands: Electron rejects everything in flight when the target closes. @type {((e: Error) => void)[]} */
  const pending = [];
  const dbg = {
    on(/** @type {string} */ ev, /** @type {Function} */ fn) { (listeners[ev] ??= []).push(fn); return dbg; },
    removeListener(/** @type {string} */ ev, /** @type {Function} */ fn) { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn); return dbg; },
    attach(/** @type {string} */ version) {
      assert.equal(version, '1.3');
      if (opts.attachThrows) throw new Error('Debugger is already attached to this target');
      attached = true;
    },
    detach() { attached = false; },
    isAttached() { return attached; },
    sendCommand(/** @type {string} */ method, /** @type {any} */ params, /** @type {string} */ sessionId) {
      sent.push({ method, params, sessionId });
      if (opts.hang?.(method, sessionId)) return new Promise((_resolve, reject) => { pending.push(reject); });
      if (opts.reject?.(method, sessionId)) return Promise.reject(new Error(`Target closed (${method})`));
      return Promise.resolve({});
    },
  };
  /** @type {string[]} */
  const logs = [];
  return {
    wc: /** @type {any} */ ({ debugger: dbg }),
    sent,
    logs,
    log: (/** @type {string} */ area, /** @type {string} */ msg) => logs.push(`${area}: ${msg}`),
    listenerCount: (/** @type {string} */ ev) => (listeners[ev] ?? []).length,
    /** Deliver a CDP event the way Electron does: (event, method, params, sessionId). */
    emit(/** @type {string} */ method, /** @type {any} */ params, /** @type {string} */ sessionId = '') {
      for (const fn of listeners.message ?? []) fn({}, method, params, sessionId);
    },
    /** Electron's order on target close: pending commands are rejected, then 'detach' is emitted (the rejections land as microtasks, after the sync emit). */
    detachEvent(/** @type {string} */ reason) {
      attached = false;
      for (const reject of pending.splice(0)) reject(new Error('target closed while handling command'));
      for (const fn of listeners.detach ?? []) fn({}, reason);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const attachedTo = (/** @type {string} */ type, /** @type {string} */ sessionId, waiting = true) => ({
  sessionId,
  targetInfo: { targetId: `t-${sessionId}`, type, url: '' },
  waitingForDebugger: waiting,
});

test('root: listeners registered before attach, then override → auto-attach, no Runtime/Page.enable', async () => {
  // The override's reply can wait for the first navigation (measured), so
  // auto-attach must go out in the same tick, not chained on that reply.
  const f = fakeWebContents({ hang: (m, sid) => m === 'Emulation.setUserAgentOverride' && sid === undefined });
  const h = attachChromeIdentity(f.wc, f.log, { identity: IDENTITY, commandTimeoutMs: 5000 });
  assert.equal(f.listenerCount('message'), 1);
  assert.equal(f.listenerCount('detach'), 1);
  assert.equal(h.isAttached(), true);
  assert.deepEqual(f.sent.map((s) => s.method), ['Emulation.setUserAgentOverride', 'Target.setAutoAttach'], 'both issued synchronously');
  await tick();
  assert.deepEqual(f.sent[0].params, {
    userAgent: IDENTITY.userAgent,
    platform: 'MacIntel',
    userAgentMetadata: IDENTITY.hints.userAgentMetadata,
  });
  assert.equal(f.sent[0].sessionId, undefined, 'root session');
  assert.deepEqual(f.sent[1].params, AUTO_ATTACH);
  assert.ok(f.sent[0].params.userAgentMetadata.brands.some((/** @type {any} */ b) => b.brand === 'Google Chrome'));
  assert.ok(!f.sent.some((s) => /^(Runtime|Page)\.enable$/.test(s.method)), 'F6: never Runtime.enable/Page.enable');
  assert.deepEqual(f.logs, []);
});

test('a paused iframe target is branded, asked for its children, then resumed — in that order, on its session', async () => {
  const f = fakeWebContents();
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.sent.length = 0;
  f.emit('Target.attachedToTarget', attachedTo('iframe', 'S1'));
  await tick(); await tick(); await tick();
  assert.deepEqual(f.sent.map((s) => [s.method, s.sessionId]), [
    ['Emulation.setUserAgentOverride', 'S1'],
    ['Target.setAutoAttach', 'S1'],
    ['Runtime.runIfWaitingForDebugger', 'S1'],
  ]);
  assert.deepEqual(f.sent[0].params.userAgentMetadata, IDENTITY.hints.userAgentMetadata);
  assert.deepEqual(f.sent[1].params, AUTO_ATTACH);
});

test('a nested target announced on a child session is handled the same (flatten)', async () => {
  const f = fakeWebContents();
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.sent.length = 0;
  f.emit('Target.attachedToTarget', attachedTo('iframe', 'S2'), 'S1');
  await tick(); await tick(); await tick();
  assert.deepEqual(f.sent.map((s) => [s.method, s.sessionId]), [
    ['Emulation.setUserAgentOverride', 'S2'],
    ['Target.setAutoAttach', 'S2'],
    ['Runtime.runIfWaitingForDebugger', 'S2'],
  ]);
});

test('a worker target is only resumed (it inherits its frame\'s override)', async () => {
  const f = fakeWebContents();
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.sent.length = 0;
  f.emit('Target.attachedToTarget', attachedTo('worker', 'W1'));
  f.emit('Target.attachedToTarget', attachedTo('service_worker', 'SW1'));
  await tick(); await tick();
  assert.deepEqual(f.sent.map((s) => [s.method, s.sessionId]), [
    ['Runtime.runIfWaitingForDebugger', 'W1'],
    ['Runtime.runIfWaitingForDebugger', 'SW1'],
  ]);
});

test('a target that is not waiting is branded but never sent a resume', async () => {
  const f = fakeWebContents();
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.sent.length = 0;
  f.emit('Target.attachedToTarget', attachedTo('page', 'P1', false));
  f.emit('Target.attachedToTarget', attachedTo('worker', 'W2', false));
  await tick(); await tick(); await tick();
  assert.deepEqual(f.sent.map((s) => [s.method, s.sessionId]), [
    ['Emulation.setUserAgentOverride', 'P1'],
    ['Target.setAutoAttach', 'P1'],
  ]);
});

test('the resume ALWAYS happens: override rejected', async () => {
  const f = fakeWebContents({ reject: (m, sid) => m === 'Emulation.setUserAgentOverride' && sid === 'S1' });
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.sent.length = 0;
  f.emit('Target.attachedToTarget', attachedTo('iframe', 'S1'));
  await tick(); await tick(); await tick();
  // setAutoAttach is not chained on the override's reply (both go out
  // back-to-back), so it is still sent; the resume comes last regardless.
  assert.deepEqual(f.sent.map((s) => s.method), ['Emulation.setUserAgentOverride', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /^identity: could not brand a iframe target/);
});

test('the resume ALWAYS happens: override hangs past the deadline', async () => {
  const f = fakeWebContents({ hang: (m) => m === 'Emulation.setUserAgentOverride' });
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY, commandTimeoutMs: 20 });
  await wait(40); // the root override simply stays pending (no deadline there)
  f.sent.length = 0;
  f.emit('Target.attachedToTarget', attachedTo('iframe', 'S1'));
  await wait(60);
  assert.deepEqual(f.sent.map((s) => s.method), ['Emulation.setUserAgentOverride', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
});

test('the resume ALWAYS happens: sendCommand throws synchronously (destroyed target)', async () => {
  const f = fakeWebContents();
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.sent.length = 0;
  let calls = 0;
  f.wc.debugger.sendCommand = (/** @type {string} */ method, /** @type {any} */ params, /** @type {string} */ sessionId) => {
    f.sent.push({ method, params, sessionId });
    calls += 1;
    if (calls === 1) throw new Error('Object has been destroyed');
    return Promise.resolve({});
  };
  f.emit('Target.attachedToTarget', attachedTo('iframe', 'S1'));
  await tick(); await tick(); await tick();
  assert.deepEqual(f.sent.map((s) => s.method), ['Emulation.setUserAgentOverride', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
});

test('errors log at most once per tab PER FAILURE CLASS; a failing resume is still attempted for every target', async () => {
  const f = fakeWebContents({ reject: (m, sid) => sid !== undefined });
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.emit('Target.attachedToTarget', attachedTo('iframe', 'S1'));
  f.emit('Target.attachedToTarget', attachedTo('iframe', 'S2'));
  f.emit('Target.attachedToTarget', attachedTo('worker', 'W1'));
  await tick(); await tick(); await tick();
  // Order is not fixed (the worker skips the override step and resumes
  // first); every target being resumed is what matters.
  const resumes = f.sent.filter((s) => s.method === 'Runtime.runIfWaitingForDebugger').map((s) => s.sessionId).sort();
  assert.deepEqual(resumes, ['S1', 'S2', 'W1']);
  // Two classes failed (branding, resume): one line each, not one per
  // target and not one for the whole tab — a benign failure must never
  // silence a different, real one.
  assert.equal(f.logs.length, 2);
  assert.ok(f.logs.some((l) => /could not brand a iframe target/.test(l)), 'the branding class');
  assert.ok(f.logs.some((l) => /resume of a paused \w+ target failed/.test(l)), 'the resume class');
});

test('root: a slow first commit is not a failure — no deadline on the root, no log, and a later child failure is still reported', async () => {
  // The root override's reply waits for the first navigation to COMMIT
  // (measured: 6 s against a 6 s server) while the override is already in
  // effect. A deadline there would log a false alarm about the tabs a user
  // is most likely to report — and, worse, spend the log budget a real
  // failure on the same tab needs.
  const f = fakeWebContents({
    hang: (_m, sid) => sid === undefined,
    reject: (m, sid) => sid === 'S1' && m === 'Emulation.setUserAgentOverride',
  });
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY, commandTimeoutMs: 20 });
  await wait(60);
  assert.deepEqual(f.logs, [], 'the root session is never on a deadline');
  f.emit('Target.attachedToTarget', attachedTo('iframe', 'S1'));
  await wait(60);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /could not brand a iframe target/);
});

test('a tab closed before its first commit is silent: the root commands reject only because the target went away', async () => {
  const f = fakeWebContents({ hang: (_m, sid) => sid === undefined });
  const h = attachChromeIdentity(f.wc, f.log, { identity: IDENTITY, commandTimeoutMs: 20 });
  await tick();
  f.detachEvent('target closed');
  await tick(); await tick();
  assert.equal(h.isAttached(), false);
  assert.deepEqual(f.logs, [], 'not a branding failure, and the normal end is silent');
});

test('the handle\'s send() keeps the deadline by default and drops it on request', async () => {
  const f = fakeWebContents({ hang: (m) => m === 'Page.setWebLifecycleState' });
  const h = attachChromeIdentity(f.wc, f.log, { identity: IDENTITY, commandTimeoutMs: 20 });
  await tick();
  await assert.rejects(h.send('Page.setWebLifecycleState', { state: 'frozen' }), /no reply in 20ms/);
  const pending = h.send('Page.setWebLifecycleState', { state: 'frozen' }, undefined, 0);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await wait(50);
  assert.equal(settled, false, 'deadline 0 = wait for the reply');
  f.detachEvent('target closed');
  await assert.rejects(pending, /target closed/);
});

test('malformed announcements and other events are ignored', async () => {
  const f = fakeWebContents();
  attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.sent.length = 0;
  f.emit('Target.attachedToTarget', undefined);
  f.emit('Target.attachedToTarget', { targetInfo: { type: 'iframe' }, waitingForDebugger: true });
  f.emit('Target.attachedToTarget', { sessionId: '', targetInfo: { type: 'iframe' }, waitingForDebugger: true });
  f.emit('Target.detachedFromTarget', { sessionId: 'S1' });
  f.emit('Target.targetInfoChanged', { targetInfo: { type: 'iframe' } });
  await tick(); await tick();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.logs, []);
});

test('attach failure → no-op handle, listeners removed, one log line, nothing sent', async () => {
  const f = fakeWebContents({ attachThrows: true });
  const h = attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  assert.equal(h.isAttached(), false);
  assert.deepEqual(f.sent, []);
  assert.equal(f.listenerCount('message'), 0);
  assert.equal(f.listenerCount('detach'), 0);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /CDP attach failed/);
  await assert.rejects(h.send('Emulation.setUserAgentOverride', {}), /not attached/);
  h.detach(); // must not throw
});

test('detach: handle reports detached, send rejects; an early detach is logged once', async () => {
  const f = fakeWebContents();
  const h = attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.detachEvent('target closed');
  assert.equal(h.isAttached(), false);
  assert.deepEqual(f.logs, [], 'the normal end is silent');
  await assert.rejects(h.send('Target.setAutoAttach', AUTO_ATTACH), /not attached/);

  const g = fakeWebContents();
  const hg = attachChromeIdentity(g.wc, g.log, { identity: IDENTITY });
  await tick();
  g.detachEvent('replaced with devtools');
  assert.equal(hg.isAttached(), false);
  assert.equal(g.logs.length, 1);
  assert.match(g.logs[0], /CDP session ended early/);
  // Nothing re-attaches, so the line must not promise a reload will fix it.
  assert.match(g.logs[0], /rest of this tab's life/);
  assert.doesNotMatch(g.logs[0], /until it reloads/);

  const k = fakeWebContents();
  const hk = attachChromeIdentity(k.wc, k.log, { identity: IDENTITY });
  hk.detach();
  assert.equal(hk.isAttached(), false);
  assert.equal(k.wc.debugger.isAttached(), false);
});

test('the handle is the tab\'s shared CDP client: send() forwards method, params and sessionId', async () => {
  const f = fakeWebContents();
  const h = attachChromeIdentity(f.wc, f.log, { identity: IDENTITY });
  await tick();
  f.sent.length = 0;
  await h.send('Page.setWebLifecycleState', { state: 'frozen' });
  await h.send('Page.setWebLifecycleState', { state: 'frozen' }, 'S9');
  assert.deepEqual(f.sent, [
    { method: 'Page.setWebLifecycleState', params: { state: 'frozen' }, sessionId: undefined },
    { method: 'Page.setWebLifecycleState', params: { state: 'frozen' }, sessionId: 'S9' },
  ]);
});
