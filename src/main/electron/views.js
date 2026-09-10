// The views port implementation: one WebContentsView per running tab.
// This file is the ONLY place tab renderers are created/destroyed. Web pages
// get maximum isolation: sandbox on, context isolation on, node off, and NO
// preload — pages have zero bridge into Raha (docs/INVARIANTS.md #5). The
// one DevTools-protocol session each tab carries (chrome-identity.js) is
// main-process-side and exposes nothing to the page either: it only tells
// the renderer what browser to claim to be.
import { WebContentsView } from 'electron';
import fs from 'node:fs';
import { thumbPath } from './paths.js';
import { sanitizeNavEntries, isNavigableUrl } from '../../shared/urls.js';
import { CAPTURE_SCRIPT, restoreScript, pageStateFor } from '../../shared/page-state.js';
import { attachPageContextMenu } from './context-menu.js';
import { attachChromeIdentity } from './chrome-identity.js';
import { log } from './log.js';

export const WEB_PARTITION = 'persist:main';
const THUMB_WIDTH = 480;
const NAV_ENTRY_CAP = 25;

/**
 * @param {{ attach: (view: any) => void, detach: (view: any) => void, setChromeOnTop: (on: boolean) => void, setSidebarVisible: (visible: boolean) => void }} windowHost
 * @returns {{
 *   create: (tabId: string, cb: any) => any,
 *   lookupByWebContentsId: (wcId: number|undefined) => { tabId: string, onBlocked: () => void }|null,
 *   setChromeOnTop: (on: boolean) => void,
 *   setSidebarVisible: (visible: boolean) => void,
 * }}
 */
export function createViewsPort(windowHost) {
  /** @type {Map<number, { tabId: string, onBlocked: () => void }>} */
  const byWcId = new Map();

  return {
    lookupByWebContentsId(wcId) {
      return wcId == null ? null : byWcId.get(wcId) ?? null;
    },

    /** Chrome modals must outrank the page view (see window.js). @param {boolean} on */
    setChromeOnTop(on) { windowHost.setChromeOnTop(on); },

    /** Sidebar show/hide re-lays the content view (see window.js). @param {boolean} visible */
    setSidebarVisible(visible) { windowHost.setSidebarVisible(visible); },

    create(tabId, cb) {
      const view = new WebContentsView({
        webPreferences: {
          partition: WEB_PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // Electron defaults this to true, and on Windows/Linux Chromium then
          // fetches Hunspell dictionaries from Google's servers on first use —
          // app-initiated network traffic, which invariant #6 says we do not
          // do. macOS would use the native checker with no download, but a
          // browser whose spellchecking depends on your OS is worse than one
          // without it. Restoring it without the network is ROADMAP R-118.
          spellcheck: false,
        },
      });
      const wc = view.webContents;
      // R-122: with Electron's default policy any page can enumerate the
      // machine's local IPs through WebRTC host candidates — a tracking
      // vector no page needs. Public-interface-only keeps calls working but
      // exposes only the default route; local addresses surface as mDNS
      // .local names, which is what desktop Chrome does with "anonymize
      // local IPs" on.
      wc.setWebRTCIPHandlingPolicy('default_public_interface_only');
      // R-114: brand this tab as Chrome at the protocol level — main frame,
      // its subresources and every cross-origin iframe report the Chrome UA
      // and "Google Chrome" brands (chrome-identity.js explains what
      // Electron gets wrong without it). Must happen before the engine's
      // loadURL/restoreHistory, which follow create() in the same tick;
      // the session lives as long as the WebContents does.
      const identity = attachChromeIdentity(wc, log);
      byWcId.set(wc.id, { tabId, onBlocked: () => cb.onBlocked() });

      let attached = false;
      let dead = false;
      /** @type {Promise<unknown>|null} */
      let captureInFlight = null;

      const navState = () => {
        try {
          const nh = /** @type {any} */ (wc).navigationHistory;
          if (nh) return { back: nh.canGoBack(), fwd: nh.canGoForward() };
        } catch { /* fall through */ }
        try {
          const anyWc = /** @type {any} */ (wc);
          return { back: Boolean(anyWc.canGoBack?.()), fwd: Boolean(anyWc.canGoForward?.()) };
        } catch { return { back: false, fwd: false }; }
      };
      const pushUrl = () => {
        const { back, fwd } = navState();
        cb.onUrl(wc.getURL(), back, fwd);
      };

      wc.on('page-title-updated', (_e, title) => cb.onTitle(title));
      wc.on('page-favicon-updated', (_e, favicons) => {
        if (favicons && favicons[0]) cb.onFavicon(favicons[0]);
      });
      wc.on('did-navigate', () => pushUrl());
      wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => { if (isMainFrame) pushUrl(); });
      wc.on('did-start-loading', () => cb.onLoading(true));
      wc.on('did-stop-loading', () => cb.onLoading(false));
      wc.on('audio-state-changed', (event) => cb.onAudible(Boolean(event.audible)));
      // Interim results stream while Chromium scans; only the final one counts.
      wc.on('found-in-page', (_e, result) => {
        if (result.finalUpdate) cb.onFindResult(result.matches, result.activeMatchOrdinal);
      });
      wc.on('destroyed', () => {
        byWcId.delete(wc.id);
        if (!dead) { dead = true; cb.onDestroyed(); }
      });
      wc.on('render-process-gone', (_e, details) => {
        log('tabs', `renderer gone for ${tabId}: ${details.reason}`);
        cleanup();
        if (!dead) { dead = true; cb.onDestroyed(); }
        // The engine treats the tab as asleep from here (waking creates a
        // fresh view), so tear the crashed WebContents down now rather than
        // leave it — and its CDP session, which sees no 'detach' on a crash
        // — to the garbage collector. close() on a crashed page is
        // immediate: 'detach' (target closed) and 'destroyed' follow within
        // milliseconds (measured), and 'destroyed' runs the byWcId cleanup.
        try { wc.close(); } catch { /* already gone */ }
      });
      wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // -3 = ERR_ABORTED (normal on redirects/stop); ignore.
        if (!isMainFrame || errorCode === -3 || dead) return;
        // Tell the engine BEFORE the in-place error page sets document.title:
        // that synthetic title must never overwrite a recorded history title.
        cb.onLoadFailed();
        // Render the error IN PLACE — never loadURL here. A loadURL pushes a
        // new history entry, so a dead entry reached via Back (e.g. a blob:
        // whose data died with its pre-sleep renderer) traps the user in a
        // bounce between that entry and the error page — found by
        // tests/e2e/security-qa.spec.js walking a restored back-stack.
        // In-place rendering keeps the entry and its index, so Back continues
        // past it, like mainstream browsers. The failed URL is page-
        // controlled: it is passed as data and rendered via textContent only.
        const args = JSON.stringify([String(validatedURL), errorCode, String(errorDescription)]);
        void wc.executeJavaScript(`(([url, code, desc]) => {
          document.documentElement.innerHTML = '';
          const body = document.createElement('body');
          body.style.cssText = 'background:#0e1116;color:#dce3ec;font:15px/1.6 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:96vh;margin:0';
          const box = document.createElement('div');
          box.style.cssText = 'max-width:560px;padding:24px';
          const h = document.createElement('h1');
          h.textContent = 'This page failed to load';
          h.style.cssText = 'font-size:20px;color:#e06c75;margin:0 0 10px';
          const u = document.createElement('p');
          u.textContent = url;
          u.style.cssText = 'word-break:break-all;color:#8b98a9;margin:0 0 10px';
          const d = document.createElement('p');
          d.textContent = desc + ' (' + code + ')';
          d.style.cssText = 'color:#8b98a9;margin:0';
          const hint = document.createElement('p');
          hint.textContent = 'Back and Reload still work — this entry keeps its place in history.';
          hint.style.cssText = 'color:#55627a;margin:14px 0 0;font-size:13px';
          box.append(h, u, d, hint);
          body.append(box);
          document.documentElement.append(body);
          document.title = 'Failed to load';
        })(${args})`).catch(() => {});
      });
      wc.setWindowOpenHandler(({ url }) => {
        if (url && url !== 'about:blank') cb.onOpenUrl(url);
        return { action: 'deny' };
      });
      // A clicked app link (zoommtg:, msteams:…) NAVIGATES rather than
      // popping up, and Chromium simply refuses a scheme it cannot handle —
      // the click did nothing and the user got no explanation. Route those
      // through the same sink as window.open so the engine can ask.
      // Web schemes are left completely alone: this must never interfere
      // with ordinary browsing.
      wc.on('will-navigate', (e, url) => {
        if (isNavigableUrl(url)) return;
        e.preventDefault();
        cb.onOpenUrl(url);
      });
      // Right-click menu. Open/search actions go through the engine callbacks
      // (same path as window.open) so the scheme gate stays at the sink.
      attachPageContextMenu(wc, {
        openUrl: (url) => cb.onOpenUrl(url),
        searchSelection: (text) => cb.onSearchSelection(text),
        navState: () => navState(),
      });

      const cleanup = () => {
        if (attached) { windowHost.detach(view); attached = false; }
      };

      const handle = {
        loadURL(/** @type {string} */ url) {
          void wc.loadURL(url).catch(() => { /* did-fail-load handles it */ });
        },
        restoreHistory(/** @type {string} */ navJson) {
          try {
            const parsed = JSON.parse(navJson);
            const nh = /** @type {any} */ (wc).navigationHistory;
            if (!nh || typeof nh.restore !== 'function') return false;
            // Entries are URLs read back from state.json — same untrusted
            // input as node.url. Drop the unsafe ones and keep the rest, so a
            // single about:blank cannot cost the user their whole history.
            const safe = sanitizeNavEntries(parsed);
            if (!safe) return false;
            void nh.restore({ entries: safe.entries, index: safe.index }).catch(() => {});
            return true;
          } catch {
            return false;
          }
        },
        getNav() {
          const { back, fwd } = navState();
          let navJson = null;
          try {
            const nh = /** @type {any} */ (wc).navigationHistory;
            if (nh && typeof nh.getAllEntries === 'function') {
              let entries = nh.getAllEntries();
              let index = nh.getActiveIndex();
              if (entries.length > NAV_ENTRY_CAP) {
                const start = Math.max(0, index - Math.floor(NAV_ENTRY_CAP / 2));
                entries = entries.slice(start, start + NAV_ENTRY_CAP);
                index -= start;
              }
              navJson = JSON.stringify({ entries, index });
            }
          } catch { /* url fallback is fine */ }
          return { canGoBack: back, canGoForward: fwd, navJson };
        },
        destroy() {
          dead = true; // engine-initiated: suppress the onDestroyed callback
          cleanup();
          try { wc.close(); } catch { /* already gone */ }
        },
        focus() { try { wc.focus(); } catch { /* gone */ } },
        back() { try { /** @type {any} */ (wc).navigationHistory?.goBack?.(); } catch { /* noop */ } },
        forward() { try { /** @type {any} */ (wc).navigationHistory?.goForward?.(); } catch { /* noop */ } },
        reload() { try { wc.reload(); } catch { /* noop */ } },
        // Bypasses the HTTP cache (stale-frontend rescue). NOTE: a
        // controlling service worker still serves unless the site updates
        // it; this matches Chrome's Cmd+Shift+R semantics.
        hardReload() { try { wc.reloadIgnoringCache(); } catch { /* noop */ } },
        stop() { try { wc.stop(); } catch { /* noop */ } },
        // Electron's `findNext` flag means "begin a NEW find session" (true
        // for the initial request, false for next/prev follow-ups) — the
        // port calls it newSession so nobody trips over the name.
        // https://www.electronjs.org/docs/latest/api/web-contents#contentsfindinpagetext-options
        findInPage(/** @type {string} */ text, /** @type {{forward?: boolean, newSession?: boolean}} */ opts) {
          try { wc.findInPage(text, { forward: opts?.forward ?? true, findNext: opts?.newSession ?? false, matchCase: false }); } catch { /* gone */ }
        },
        stopFind(/** @type {'clearSelection'|'keepSelection'} */ action) {
          try { wc.stopFindInPage(action); } catch { /* gone */ }
        },
        getOSPid() {
          try { return dead ? null : wc.getOSProcessId(); } catch { return null; }
        },
        setAttached(/** @type {boolean} */ want) {
          if (dead || want === attached) return;
          if (want) {
            windowHost.attach(view);
            attached = true;
          } else {
            // Let an in-flight thumbnail finish before the view goes invisible.
            const doDetach = () => { if (attached && !dead) { windowHost.detach(view); attached = false; } };
            if (captureInFlight) {
              const timeout = new Promise((r) => setTimeout(r, 400));
              void Promise.race([captureInFlight, timeout]).then(doDetach);
            } else {
              doDetach();
            }
          }
        },
        captureThumb() {
          if (dead) return Promise.resolve(false);
          const p = wc.capturePage()
            .then((/** @type {Electron.NativeImage} */ img) => {
              if (img.isEmpty()) return false;
              const resized = img.resize({ width: THUMB_WIDTH });
              fs.writeFileSync(thumbPath(tabId), resized.toPNG());
              return true;
            })
            .catch(() => false)
            .finally(() => { captureInFlight = null; });
          captureInFlight = p;
          return p;
        },
        zoom(/** @type {'in'|'out'|'reset'} */ dir) {
          try {
            if (dir === 'reset') wc.setZoomLevel(0);
            else wc.setZoomLevel(wc.getZoomLevel() + (dir === 'in' ? 0.5 : -0.5));
          } catch { /* noop */ }
        },
        capturePageState() {
          if (dead) return Promise.resolve(null);
          return wc.executeJavaScript(CAPTURE_SCRIPT).catch(() => null);
        },
        /** @param {import('../../shared/page-state.js').PageState} state */
        restorePageState(state) {
          if (dead) return;
          const plan = pageStateFor(state, state.url, Date.now());
          if (!plan.scroll && plan.fields.length === 0) return;
          /** @type {(() => void)|null} */ let cleanup = null;
          const onLoad = () => {
            try {
              const currentUrl = wc.getURL();
              if (currentUrl === state.url) {
                void wc.executeJavaScript(restoreScript(plan)).catch(() => {});
              }
            } catch { /* gone */ }
            if (cleanup) cleanup();
          };
          const onFail = () => { if (cleanup) cleanup(); };
          wc.once('did-finish-load', onLoad);
          wc.once('did-fail-load', onFail);
          cleanup = () => {
            wc.removeListener('did-finish-load', onLoad);
            wc.removeListener('did-fail-load', onFail);
            cleanup = null;
          };
        },
        /** Adapter-only extra (not part of the engine port): DevTools access. */
        devWebContents() { return dead ? null : wc; },
        /**
         * Adapter-only extra: the tab's ONE CDP session (chrome-identity.js).
         * Anything else needing the protocol on this tab reuses it — Electron
         * allows a single debugger client per WebContents.
         */
        cdp() { return dead ? null : identity; },
      };
      return handle;
    },
  };
}
