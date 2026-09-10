// ============================================================================
// Raha entrypoint: wire the pure Engine to the Electron adapters.
// This file (and src/main/electron/*) are the only places 'electron' is
// imported — enforced by tests/unit/boundaries.test.js and eslint.
// ============================================================================
import { app, session, shell } from 'electron';
import path from 'node:path';
import { Engine } from './core/engine.js';
import { registerRahaScheme, installRahaProtocol } from './electron/protocol.js';
import { createMainWindow } from './electron/window.js';
import { createViewsPort, WEB_PARTITION } from './electron/views.js';
import { createMetricsPort } from './electron/metrics.js';
import { createPersistPort } from './electron/persist.js';
import { createImportersPort } from './electron/import-history.js';
import { createTabImportersPort } from './electron/import-tabs.js';
import { hardenWebSession, configureChromeIdentity } from './electron/privacy.js';
import { loadBlockerEngines } from './electron/blocker.js';
import { wireIpc } from './electron/ipc.js';
import { installMenu } from './electron/menu.js';
import { installAutoUpdater } from './electron/updater.js';
import { hostOf } from '../shared/rules.js';
import { log } from './electron/log.js';
import { runSmokeTest } from './smoke.js';

const TICK_MS = Number(process.env.RAHA_TICK_MS || 2500);
const SMOKE = process.argv.includes('--raha-smoke');

// RAHA_PROFILE_DIR runs (tests, smoke) must be hermetic: userData is where
// Chromium keeps session data AND where requestSingleInstanceLock() keys its
// lock. Without this, a from-source run shares both with a packaged Raha.app
// (same productName -> same userData) — e2e/smoke silently quit whenever the
// real app is open, and test cookies land in the real profile. Must happen
// before the lock below.
if (process.env.RAHA_PROFILE_DIR) {
  app.setPath('userData', path.resolve(process.env.RAHA_PROFILE_DIR));
}

// Containers/CI without a setuid sandbox need --no-sandbox for CHROMIUM's
// process sandbox. Packaged builds refuse it outright (R-117): not a
// privilege boundary — whoever sets your environment already runs code —
// but a shipped binary has no reason to honor it.
if (process.env.RAHA_NO_SANDBOX === '1') {
  if (app.isPackaged) {
    log('boot', 'RAHA_NO_SANDBOX ignored — packaged builds always keep the Chromium sandbox on');
  } else {
    app.commandLine.appendSwitch('no-sandbox');
    log('boot', 'chromium sandbox disabled via RAHA_NO_SANDBOX (dev/CI only!)');
  }
}

registerRahaScheme();

// External links (Raha as default browser). macOS delivers them via
// 'open-url' — possibly BEFORE the app is ready, so buffer until the engine
// exists; Windows/Linux deliver them as argv of a second instance (handled
// below) or of the first launch. Every URL goes through engine.tabCreate,
// i.e. the same scheme gate as everything else (invariant #13).
/** @type {string[]} */
const pendingExternalUrls = [];
/** @type {((url: string) => void)|null} */
let openExternalUrl = null;
const acceptExternalUrl = (/** @type {string} */ url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  if (openExternalUrl) openExternalUrl(url.slice(0, 4096));
  else pendingExternalUrls.push(url.slice(0, 4096));
};
app.on('open-url', (e, url) => { e.preventDefault(); acceptExternalUrl(url); });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /** @type {import('electron').BaseWindow|null} */
  let mainWin = null;
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => /^https?:\/\//i.test(a));
    if (url) acceptExternalUrl(url);
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
    }
  });
  void app.whenReady().then(() => {
    // Host facts the Chrome identity needs before the first session or tab
    // exists (createMainWindow already aligns the UI session): an x64
    // build under Rosetta / Windows ARM64 emulation must say "arm", as
    // Chrome does on that machine.
    configureChromeIdentity({ arm64Translation: app.runningUnderARM64Translation === true });
    const { win, uiView, windowHost } = createMainWindow();
    const viewsPort = createViewsPort(windowHost);

    /** @type {ReturnType<typeof wireIpc>} */
    let push; // assigned right after engine construction; events queue via microtask

    const engine = new Engine({
      views: viewsPort,
      metrics: createMetricsPort(),
      persist: createPersistPort(),
      importers: { ...createImportersPort(), ...createTabImportersPort() },
      // The ONLY path from Raha to the OS's app handlers. The engine calls it
      // solely after the user answers the app-link ask (ADR-0011); shell is
      // imported nowhere else. shell.openExternal reports "no app registered
      // for this scheme" as a promise REJECTION, not a throw — surface it,
      // or the user's click does nothing with no explanation.
      shell: {
        openExternal: (/** @type {string} */ url) => {
          shell.openExternal(url).catch(() => {
            engine.toast('warn', 'That app link could not be opened — is the app installed?');
          });
        },
      },
      now: () => Date.now(),
      onEvent: (evt) => {
        queueMicrotask(() => {
          if (!push) return;
          if (evt.type === 'snapshot') push.pushSnapshot();
          else if (evt.type === 'toast') push.pushToast(evt);
          else if (evt.type === 'focusOmnibox') push.focusOmnibox();
          else if (evt.type === 'findResult') push.pushFindResult(evt);
          else if (evt.type === 'askExternal') push.askExternal(evt);
          else if (evt.type === 'askPermission') push.askPermission(evt.ask);
        });
      },
    });
    push = wireIpc(engine, uiView);
    for (const p of engine.loadProblems) log('boot', p);
    mainWin = win;

    // External links: open as activated tabs (tabCreate = the scheme gate).
    openExternalUrl = (url) => { engine.tabCreate({ url, activate: true }); };
    for (const u of pendingExternalUrls.splice(0)) openExternalUrl(u);
    const argvUrl = process.argv.find((a) => /^https?:\/\//i.test(a));
    if (argvUrl) acceptExternalUrl(argvUrl);

    // Ask ONCE to become the default browser — IN RAHA first. Consent order
    // matters: setAsDefaultProtocolClient is only called after the user says
    // yes in our own prompt (macOS then shows its confirmation as a second
    // check; Windows/Linux would change the association with NO OS dialog,
    // so calling it unprompted would force the change). Packaged builds
    // only, and the ask waits for the chrome to actually be on screen.
    if (app.isPackaged && !engine.settings.defaultBrowserPrompted
        && !app.isDefaultProtocolClient('http')) {
      uiView.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          push.askDefaultBrowser();
          engine.settingsSet({ defaultBrowserPrompted: true });
        }, 1500);
      });
    }

    // Web-content session: raha:// pages (home/error) + privacy hardening.
    const webSession = session.fromPartition(WEB_PARTITION);
    installRahaProtocol(webSession, { allowThumbs: false, allowChrome: false });

    // Bundled filter-list engines (ADR-0009). A load failure must never
    // break browsing or boot: blocking fails OPEN and the user is told.
    /** @type {import('../shared/blocking.js').Matchers|null} */
    let matchers = null;
    try {
      matchers = loadBlockerEngines();
    } catch (err) {
      log('privacy', `blocker engines failed to load — blocking is OFF: ${String(err)}`);
      queueMicrotask(() => push.pushToast({ kind: 'warn', text: 'Ad/tracker blocking failed to load — blocking is off' }));
    }

    hardenWebSession(webSession, {
      getSettings: () => engine.settings,
      matchers,
      topHostForWebContentsId: (wcId) => {
        const hit = viewsPort.lookupByWebContentsId(wcId);
        const node = hit ? engine.tabNode(hit.tabId) : null;
        return node ? hostOf(node.url) : null;
      },
      onBlocked: (wcId) => viewsPort.lookupByWebContentsId(wcId)?.onBlocked(),
      toast: (kind, text) => push.pushToast({ kind, text }),
      // Site permissions (R-103, ADR-0013): the decision is filed under the
      // TAB's page host (top-level), never the asking frame's — an embedded
      // widget asks on behalf of the site the user is looking at. Unknown
      // WebContents (a view already torn down) = refused.
      askPermission: (wcId, kinds, requestingUrl, isMainFrame) => {
        const hit = viewsPort.lookupByWebContentsId(wcId);
        const node = hit ? engine.tabNode(hit.tabId) : null;
        if (!hit || !node) return Promise.resolve(false);
        return engine.permissionRequest({
          tabId: hit.tabId, kinds, host: hostOf(node.url) ?? '', requestingHost: hostOf(requestingUrl), isMainFrame,
        });
      },
      checkPermission: (wcId, kind) => {
        const hit = viewsPort.lookupByWebContentsId(wcId);
        const node = hit ? engine.tabNode(hit.tabId) : null;
        if (!hit || !node) return false;
        return engine.permissionCheck({ tabId: hit.tabId, host: hostOf(node.url) ?? '', kind });
      },
    });

    installMenu(engine, {
      focusOmnibox: () => push.focusOmnibox(),
      toggleSidebar: () => push.toggleSidebar(),
      openHistory: () => push.openHistory(),
      openFind: () => push.openFind(),
    }, () => push.openSettings());

    // Auto-updates (ADR-0008): packaged builds only, honors settings.autoUpdate.
    installAutoUpdater({
      isEnabled: () => engine.settings.autoUpdate,
      toast: (kind, text) => push.pushToast({ kind, text }),
    });

    // First-run welcome: only on a virgin profile, never during the smoke
    // self-test, and suppressible for e2e via RAHA_NO_WELCOME=1.
    if (engine.firstRun && !SMOKE && process.env.RAHA_NO_WELCOME !== '1') {
      engine.seedWelcome();
    }

    // Governor heartbeat.
    const ticker = setInterval(() => engine.tick(), TICK_MS);

    // Graceful shutdown: save nav history + state, stop the ticker.
    let shuttingDown = false;
    app.on('before-quit', () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(ticker);
      engine.shutdown();
    });
    win.on('closed', () => app.quit());
    app.on('window-all-closed', () => app.quit());

    log('boot', `raha up (tick=${TICK_MS}ms, profile=${process.env.RAHA_PROFILE_DIR || 'default'})`);

    if (SMOKE) {
      void runSmokeTest(engine).then((code) => {
        engine.shutdown();
        app.exit(code);
      });
    }
  });
}
