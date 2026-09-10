// IPC wiring: one handler per INVOKE channel, each delegating 1:1 to an
// Engine method. Payloads from the UI are treated as untrusted-ish (the UI is
// our code, but bugs happen): every handler goes through the engine, which
// validates ids and clamps numbers. Events flow back via pushSnapshot/toast.
import { app, dialog, ipcMain, session } from 'electron';
import { INVOKE, EVENT } from '../../shared/ipc-contract.js';
import { isUiChromeUrl } from '../../shared/urls.js';
import { normalizeSiteHost } from '../../shared/validate.js';
import { clearSiteData, clearAllSiteData } from './site-data.js';
import { WEB_PARTITION } from './views.js';
import { log } from './log.js';

/**
 * @param {import('../core/engine.js').Engine} engine
 * @param {Electron.WebContentsView} uiView
 */
export function wireIpc(engine, uiView) {
  /** @type {Record<string, (payload: any) => unknown>} */
  const handlers = {
    [INVOKE.stateGet]: () => engine.snapshot(),
    [INVOKE.tabCreate]: (p) => engine.tabCreate(p ?? {}),
    [INVOKE.tabClose]: (p) => engine.tabClose(p),
    [INVOKE.tabActivate]: (p) => engine.tabActivate(p),
    [INVOKE.tabSleep]: (p) => engine.tabSleep(p),
    [INVOKE.tabSetKeepAlive]: (p) => engine.tabSetKeepAlive(p),
    [INVOKE.tabSetMemLimit]: (p) => engine.tabSetMemLimit(p),
    [INVOKE.tabShowGrid]: () => engine.tabShowGrid(),
    [INVOKE.navOmnibox]: (p) => engine.navOmnibox(p),
    [INVOKE.navBack]: (p) => engine.navOp(p, 'back'),
    [INVOKE.navForward]: (p) => engine.navOp(p, 'forward'),
    [INVOKE.navReload]: (p) => engine.navOp(p, 'reload'),
    [INVOKE.navHardReload]: (p) => engine.navOp(p, 'hardReload'),
    [INVOKE.navStop]: (p) => engine.navOp(p, 'stop'),
    [INVOKE.findStart]: (p) => engine.findStart(p),
    [INVOKE.findStop]: (p) => engine.findStop(p),
    // The URL is NOT taken from the renderer: the engine opens the request it
    // stored when it asked, so the UI can only confirm the user's answer.
    [INVOKE.externalOpen]: (p) => engine.externalOpen(p ?? {}),
    [INVOKE.externalDismiss]: (p) => engine.externalDismiss(p ?? {}),
    [INVOKE.folderCreate]: (p) => engine.folderCreate(p),
    [INVOKE.folderRename]: (p) => engine.folderRename(p),
    [INVOKE.folderToggle]: (p) => engine.folderToggle(p),
    [INVOKE.folderSleepAll]: (p) => engine.folderSleepAll(p),
    [INVOKE.nodeRemove]: (p) => engine.nodeRemove(p),
    [INVOKE.nodeMove]: (p) => engine.nodeMove(p),
    [INVOKE.settingsGet]: () => engine.settingsGet(),
    [INVOKE.settingsSet]: (p) => engine.settingsSet(p ?? {}),
    [INVOKE.zoomSet]: (p) => engine.zoomSet(p),
    [INVOKE.historySources]: () => engine.historySources(),
    [INVOKE.historyImport]: (p) => engine.historyImport(p ?? {}),
    // The dialog lives HERE, not in the engine and not behind a renderer
    // path argument: the renderer must never be able to name a file
    // (import-history.js safety note — sourceIds are opaque, paths are not).
    [INVOKE.historyImportFile]: async () => {
      const r = await dialog.showOpenDialog({
        title: 'Import browsing history from a file',
        message: 'Pick a copy of a browser history database: Safari History.db, Chrome/Chromium History, or Firefox places.sqlite',
        properties: ['openFile', 'showHiddenFiles'],
      });
      if (r.canceled || r.filePaths.length === 0) return { canceled: true };
      return engine.historyImportFile(r.filePaths[0]);
    },
    [INVOKE.historyList]: (p) => engine.historyList(p ?? {}),
    [INVOKE.historyClear]: () => engine.historyClear(),
    [INVOKE.uiOverlay]: (p) => engine.overlaySet(p ?? {}),
    [INVOKE.uiSidebar]: (p) => engine.sidebarSet(p ?? {}),
    // Site-data clearing: session ops, no engine state. The host is
    // renderer-supplied, so it goes through the same normalizer as every
    // other host input before touching the session.
    [INVOKE.siteDataClear]: async (p) => {
      const host = normalizeSiteHost(p?.host);
      if (!host) return { error: 'bad host' };
      const r = await clearSiteData(session.fromPartition(WEB_PARTITION), host);
      return { ok: true, ...r };
    },
    [INVOKE.siteDataClearAll]: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: 'Clear ALL cookies and site data?',
        detail: 'This signs you out of every website and empties all site storage and the cache. Your tabs, folders, history, and settings are untouched.',
        buttons: ['Cancel', 'Clear Everything'],
        defaultId: 0,
        cancelId: 0,
      });
      if (response !== 1) return { canceled: true };
      await clearAllSiteData(session.fromPartition(WEB_PARTITION));
      return { ok: true };
    },
    // OS integration, no engine state — lives here like the file dialog does.
    [INVOKE.defaultBrowserSet]: () => {
      app.setAsDefaultProtocolClient('http');
      app.setAsDefaultProtocolClient('https');
      return { ok: true, isDefault: app.isDefaultProtocolClient('http') };
    },
    [INVOKE.openTabsSources]: () => engine.openTabsSources(),
    [INVOKE.openTabsImport]: (p) => engine.openTabsImport(p ?? {}),
    [INVOKE.organizePreview]: () => engine.organizePreview(),
    [INVOKE.organizeApply]: () => engine.organizeApply(),
    [INVOKE.runawayResolve]: (p) => engine.runawayResolve(p ?? {}),
    // Like app links: the UI answers an id, never names a site or a kind —
    // the engine holds the ask and is the only place that grants.
    [INVOKE.permissionAnswer]: (p) => engine.permissionAnswer(p ?? {}),
    [INVOKE.permissionForget]: (p) => engine.permissionForget(p ?? {}),
  };

  // Electron security checklist item 17: validate the sender. Only the chrome
  // view's own main frame may drive the engine. Today it is the only view with
  // a preload, so nothing else CAN invoke — but this is the check that
  // contains the damage if that ever stops being true (a stray iframe in the
  // chrome, a navigation that slips past the guards in window.js).
  const isTrustedSender = (/** @type {Electron.IpcMainInvokeEvent} */ event) => {
    const frame = event.senderFrame;
    if (!frame || frame !== uiView.webContents.mainFrame) return false;
    return isUiChromeUrl(frame.url);
  };

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, payload) => {
      if (!isTrustedSender(event)) {
        log('ipc', `refused ${channel} from an untrusted frame (${event.senderFrame?.url ?? 'gone'})`);
        throw new Error('refused: untrusted sender');
      }
      return fn(payload);
    });
  }

  let snapshotQueued = false;
  const send = (/** @type {string} */ channel, /** @type {unknown} */ payload) => {
    const wc = uiView.webContents;
    if (!wc.isDestroyed()) wc.send(channel, payload);
  };

  return {
    /** Debounced full-snapshot push (engine emits on every mutation). */
    pushSnapshot() {
      if (snapshotQueued) return;
      snapshotQueued = true;
      setTimeout(() => {
        snapshotQueued = false;
        send(EVENT.snapshot, engine.snapshot());
      }, 30);
    },
    /** @param {{ kind: string, text: string }} t */
    pushToast(t) { send(EVENT.toast, t); },
    focusOmnibox() { send(EVENT.focusOmnibox, {}); },
    toggleSidebar() { send(EVENT.toggleSidebar, {}); },
    askDefaultBrowser() { send(EVENT.askDefaultBrowser, {}); },
    openSettings() { send(EVENT.openSettings, {}); },
    openHistory() { send(EVENT.openHistory, {}); },
    openFind() { send(EVENT.openFind, {}); },
    /** @param {{ id: number, url: string, scheme: string|null, app: string }} r */
    askExternal(r) { send(EVENT.askExternal, { id: r.id, url: r.url, scheme: r.scheme, app: r.app }); },
    /** @param {import('../../shared/ipc-contract.js').PermissionAsk|null} ask null withdraws the ask on screen */
    askPermission(ask) {
      send(EVENT.askPermission, ask
        ? { id: ask.id, tabId: ask.tabId, kinds: [...ask.kinds], host: ask.host, requestingHost: ask.requestingHost, isMainFrame: ask.isMainFrame }
        : null);
    },
    /** @param {{ tabId: string, matches: number, activeMatchOrdinal: number }} r */
    pushFindResult(r) { send(EVENT.findResult, { tabId: r.tabId, matches: r.matches, activeMatchOrdinal: r.activeMatchOrdinal }); },
  };
}
