// Present one consistent Chrome identity to every frame of a tab.
//
// WHY (all measured live on Electron 43.4.0 / Chromium 150, 2026-08-26;
// ADR-0012 has the full story):
//  - The session UA override (privacy.js) reaches the main frame's UA
//    string but not its client-hint brand list: navigator.userAgentData
//    still says "Chromium" only. A DevTools-protocol
//    Emulation.setUserAgentOverride carrying the userAgentMetadata that
//    src/shared/client-hints.js computes fixes the JS view AND the
//    renderer's own subresource headers, applies live without a
//    navigation, and persists across navigations (F1).
//  - Navigation requests never carry client hints from the renderer,
//    override or not — Electron has no browser-side client-hints delegate.
//    privacy.js's header hook synthesizes those; this file is the
//    JS-and-renderer half of the fix (F2). (Worker requests are bare too,
//    but real Chrome's are as well, so the hook leaves them alone.)
//  - Cross-origin iframes are out of process and ignore the session UA
//    entirely: inside them navigator.userAgent is the raw
//    "... Chrome/150.0.7871.224 Electron/43.4.0 ..." string and it goes on
//    the wire — where Cloudflare's Turnstile widget lives.
//    Target.setAutoAttach (flatten) hands each such frame to us as a
//    child session, paused; the same override on that session, then a
//    resume, fixes it before its first script runs (F3).
//  - Detaching reverts everything at once, so the session stays attached
//    for the tab's lifetime; Chromium tears it down with the WebContents
//    ('detach' fires with reason 'target closed') (F4).
//  - Attaching is not itself a tell: navigator.webdriver stays false —
//    Electron's debugger sets no automation flag (F5).
//  - Never Runtime.enable (anti-bot scripts detect its side effects), and
//    Page.enable is not needed for any of this (F6).
//  - A command sent before the tab has a renderer (we attach before the
//    first loadURL) takes effect at once but its REPLY waits for the first
//    navigation to COMMIT — 6 s on a 6 s server (measured). So nothing here
//    is chained on a reply: commands are issued in order on their session —
//    CDP processes them in order — and awaited only to log; and the root
//    session's commands get no deadline, since nothing is paused waiting on
//    them and a slow first page is not a failure. Opening DevTools on the
//    tab does NOT detach this session (measured; the Electron typing's
//    comment saying otherwise is stale).
//
// This handle is THE one CDP client per WebContents. Electron's
// webContents.debugger is a single session, so a later feature that needs
// the protocol (the planned tab freeze, for one) must reuse it through
// views.js's cdp() rather than attach again. It lives in the main process
// and exposes nothing to the page — no preload, no bridge
// (docs/INVARIANTS.md #5).
//
// Failure discipline: browsing must never break because of this. Attach
// failure degrades to a no-op handle (the header hook still covers the
// wire), every child-session command is wrapped in a timeout and a catch,
// errors log at most once per tab per failure class (so a benign early
// failure cannot silence a later real one), and a child target delivered
// paused (waitingForDebugger) is ALWAYS resumed — a target left waiting is
// a hung page, the one outcome worse than a leaked Electron token.
import { chromeIdentity } from './privacy.js';

export { chromeIdentity };

const AUTO_ATTACH = Object.freeze({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
/**
 * Target types that own a document and so a UA/brand view of their own.
 * A dedicated worker is auto-attached too but only resumed: it inherits
 * its creator frame's override — measured in exactly this configuration
 * (auto-attach on, worker resumed without an override): inside the worker
 * navigator.userAgent and userAgentData.brands equal the page's, and
 * pinned by the e2e worker test. Anything else (service workers, shared
 * workers, ...) is only resumed as well; their JS view is not measured.
 */
const OVERRIDDEN_TARGETS = new Set(['iframe', 'page']);
const COMMAND_TIMEOUT_MS = 3000;

/**
 * @typedef {{
 *   send: (method: string, params?: object, sessionId?: string, deadlineMs?: number) => Promise<any>,
 *   isAttached: () => boolean,
 *   detach: () => void,
 * }} ChromeIdentityHandle
 */

/** @returns {ChromeIdentityHandle} */
function noopHandle() {
  return {
    send: () => Promise.reject(new Error('chrome identity: not attached')),
    isAttached: () => false,
    detach() { /* nothing to detach */ },
  };
}

/**
 * Attach the tab's CDP session and brand every frame Chrome-style. Call
 * right after the WebContentsView is constructed — the first loadURL may
 * follow in the same tick; the override still covers that first document.
 *
 * @param {import('electron').WebContents} wc a tab view's webContents
 * @param {(area: string, msg: string) => void} log
 * @param {{ identity?: ReturnType<typeof chromeIdentity>, commandTimeoutMs?: number }} [opts]
 *   test seams: a fixed identity (unit tests run outside Electron) and a
 *   short command deadline
 * @returns {ChromeIdentityHandle}
 */
export function attachChromeIdentity(wc, log, opts = {}) {
  const identity = opts.identity ?? chromeIdentity();
  const timeoutMs = opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const dbg = wc.debugger;
  let attached = false;
  /** Failure classes already reported for this tab. */
  const logged = new Set();
  const logOnce = (/** @type {string} */ key, /** @type {string} */ msg) => {
    if (logged.has(key)) return;
    logged.add(key);
    log('identity', msg);
  };

  const override = {
    userAgent: identity.userAgent,
    platform: identity.navigatorPlatform,
    userAgentMetadata: identity.hints.userAgentMetadata,
  };

  /**
   * sendCommand with a deadline: a command that never settles must not
   * hold a paused child target hostage. A closed target rejects; a
   * destroyed WebContents may throw synchronously — both become rejections.
   * @param {string} method @param {object} [params] @param {string} [sessionId]
   * @param {number} [deadlineMs] 0 = none (the root session before its
   *   first commit: the reply is late by design, not missing)
   * @returns {Promise<any>}
   */
  const send = (method, params = {}, sessionId, deadlineMs = timeoutMs) => {
    if (!attached) return Promise.reject(new Error('chrome identity: not attached'));
    return new Promise((resolve, reject) => {
      const timer = deadlineMs > 0
        ? setTimeout(() => reject(new Error(`${method}: no reply in ${deadlineMs}ms`)), deadlineMs)
        : undefined;
      try {
        const p = sessionId ? dbg.sendCommand(method, params, sessionId) : dbg.sendCommand(method, params);
        p.then(
          (r) => { clearTimeout(timer); resolve(r); },
          (e) => { clearTimeout(timer); reject(e); },
        );
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  };

  /**
   * Brand a session and ask it for its children. Both commands go out
   * back-to-back (the session processes them in order); the settled
   * results only feed the log. The root session gets no deadline: its
   * reply waits for the first commit, and nothing is paused on it. A child
   * session is a paused frame, so there the deadline protects the page.
   * @param {string} what for the log line
   * @param {string} [sessionId] omitted = the root session
   */
  const brand = async (what, sessionId) => {
    const deadline = sessionId ? timeoutMs : 0;
    const results = await Promise.allSettled([
      send('Emulation.setUserAgentOverride', override, sessionId, deadline),
      send('Target.setAutoAttach', AUTO_ATTACH, sessionId, deadline),
    ]);
    const failed = results.find((r) => r.status === 'rejected');
    // A session that ended meanwhile (tab closed before its first commit)
    // rejects everything in flight; onDetach already said what there is
    // to say, so that is not a branding failure.
    if (failed && failed.status === 'rejected' && attached) {
      logOnce(sessionId ? 'child' : 'root', `could not brand ${what} (${String(failed.reason)}); its scripts may see Chromium-only brands`);
    }
  };

  /**
   * A child target (OOPIF, worker, ...) arrived, paused if we asked. Brand
   * the ones that carry a document, ask them for THEIR children, and —
   * whatever happened above — let it run.
   * @param {any} params Target.attachedToTarget params
   */
  const onAttached = async (params) => {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const type = String(params?.targetInfo?.type ?? '');
    try {
      if (OVERRIDDEN_TARGETS.has(type)) await brand(`a ${type} target`, sessionId);
    } catch (err) {
      logOnce('child', `could not brand a ${type} target (${String(err)})`);
    } finally {
      if (params?.waitingForDebugger) {
        try {
          await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        } catch (err) {
          logOnce('resume', `resume of a paused ${type} target failed: ${String(err)}`);
        }
      }
    }
  };

  const onMessage = (/** @type {unknown} */ _event, /** @type {string} */ method, /** @type {any} */ params) => {
    if (method === 'Target.attachedToTarget') void onAttached(params);
    // Target.detachedFromTarget and everything else: nothing to do.
  };
  const onDetach = (/** @type {unknown} */ _event, /** @type {string} */ reason) => {
    attached = false;
    // 'target closed' is the normal end (tab closed/slept/crashed — views.js
    // closes a crashed WebContents). Anything else means the identity just
    // reverted for this tab (F4), and nothing re-attaches: it stays that
    // way until the tab sleeps and wakes (a fresh view attaches afresh);
    // the wire stays Chrome-branded through the header hook. Say so once.
    if (reason !== 'target closed') {
      logOnce('detach', `CDP session ended early (${reason}); this tab's pages see Chromium brands for the rest of this tab's life (sleep/wake attaches afresh); the wire stays Chrome via the header hook`);
    }
  };

  try {
    // Listeners first: a child target can be announced the moment
    // auto-attach is on, and a missed announcement is a paused frame.
    dbg.on('message', onMessage);
    dbg.on('detach', onDetach);
    dbg.attach('1.3');
    attached = true;
  } catch (err) {
    try {
      dbg.removeListener('message', onMessage);
      dbg.removeListener('detach', onDetach);
    } catch { /* noop */ }
    logOnce('attach', `CDP attach failed — this tab's pages will report Chromium-only brands: ${String(err)}`);
    return noopHandle();
  }

  // Root session: brand the main frame and ask for every child target to
  // be delivered paused so it can be branded before it runs. Not awaited —
  // the engine's loadURL follows in this same tick, and the override still
  // covers that first document (measured).
  void brand("this tab's main frame");

  return {
    send,
    isAttached() {
      try { return attached && dbg.isAttached(); } catch { return false; }
    },
    detach() {
      attached = false;
      try { dbg.detach(); } catch { /* already gone */ }
    },
  };
}
