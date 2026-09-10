// Typed wrapper over the window.raha bridge. The ONLY file that touches
// window.raha directly; every other UI module imports { api } from here.
// In the offline UI test harness (tests/ui/), window.raha is a mock that
// implements this same surface over the real Engine logic.
import { INVOKE, EVENT } from '../shared/ipc-contract.js';

/** @returns {{ invoke: (c: string, p?: unknown) => Promise<any>, on: (c: string, h: (p: any) => void) => () => void }} */
function bridge() {
  const b = /** @type {any} */ (window).raha;
  if (!b) throw new Error('window.raha bridge missing — preload did not run');
  return b;
}

export const api = {
  // --- queries
  stateGet: () => bridge().invoke(INVOKE.stateGet),
  settingsGet: () => bridge().invoke(INVOKE.settingsGet),

  // --- tabs
  /** @param {{ url?: string, folderId?: string, activate?: boolean }} [p] */
  tabCreate: (p) => bridge().invoke(INVOKE.tabCreate, p),
  /** @param {string} tabId */
  tabClose: (tabId) => bridge().invoke(INVOKE.tabClose, { tabId }),
  /** @param {string} tabId */
  tabActivate: (tabId) => bridge().invoke(INVOKE.tabActivate, { tabId }),
  /** @param {string} tabId */
  tabSleep: (tabId) => bridge().invoke(INVOKE.tabSleep, { tabId }),
  /** @param {string} tabId @param {boolean} keepAlive */
  tabSetKeepAlive: (tabId, keepAlive) => bridge().invoke(INVOKE.tabSetKeepAlive, { tabId, keepAlive }),
  /** @param {string} tabId @param {number|null} memLimitMB */
  tabSetMemLimit: (tabId, memLimitMB) => bridge().invoke(INVOKE.tabSetMemLimit, { tabId, memLimitMB }),
  tabShowGrid: () => bridge().invoke(INVOKE.tabShowGrid),

  // --- navigation
  /**
   * @param {string} input @param {string|null} tabId
   * @param {string} [folderId] target folder when creating with no tab showing (the folder being viewed)
   * @param {'here'|'new'|'switch'} [mode] omitted = the engine's default: 'here' with a tab, 'new' without
   */
  navOmnibox: (input, tabId, folderId, mode) => bridge().invoke(INVOKE.navOmnibox, { input, tabId, folderId, mode }),
  /** @param {string} tabId */
  navBack: (tabId) => bridge().invoke(INVOKE.navBack, { tabId }),
  /** @param {string} tabId */
  navForward: (tabId) => bridge().invoke(INVOKE.navForward, { tabId }),
  /** @param {string} tabId */
  navReload: (tabId) => bridge().invoke(INVOKE.navReload, { tabId }),
  /** @param {string} tabId */
  navHardReload: (tabId) => bridge().invoke(INVOKE.navHardReload, { tabId }),
  /** @param {string} tabId */
  navStop: (tabId) => bridge().invoke(INVOKE.navStop, { tabId }),
  /** @param {string} tabId @param {string} text @param {{ forward?: boolean, newSession?: boolean }} [opts] */
  findStart: (tabId, text, opts) => bridge().invoke(INVOKE.findStart, { tabId, text, ...opts }),
  /** @param {string} tabId @param {boolean} [keepSelection] */
  findStop: (tabId, keepSelection) => bridge().invoke(INVOKE.findStop, { tabId, keepSelection }),
  /** @param {number} id the ask being confirmed @param {boolean} [remember] */
  externalOpen: (id, remember) => bridge().invoke(INVOKE.externalOpen, { id, remember }),
  /** @param {number} id the ask being declined */
  externalDismiss: (id) => bridge().invoke(INVOKE.externalDismiss, { id }),

  // --- folders / nodes
  /** @param {string} name @param {string} [parentId] */
  folderCreate: (name, parentId) => bridge().invoke(INVOKE.folderCreate, { name, parentId }),
  /** @param {string} folderId @param {string} name */
  folderRename: (folderId, name) => bridge().invoke(INVOKE.folderRename, { folderId, name }),
  /** @param {string} folderId @param {boolean} collapsed */
  folderToggle: (folderId, collapsed) => bridge().invoke(INVOKE.folderToggle, { folderId, collapsed }),
  /** @param {string} folderId */
  folderSleepAll: (folderId) => bridge().invoke(INVOKE.folderSleepAll, { folderId }),
  /** @param {string} nodeId */
  nodeRemove: (nodeId) => bridge().invoke(INVOKE.nodeRemove, { nodeId }),
  /** @param {string} nodeId @param {string} parentId @param {number} [index] */
  nodeMove: (nodeId, parentId, index) => bridge().invoke(INVOKE.nodeMove, { nodeId, parentId, index }),

  // --- settings
  /** @param {Partial<import('../shared/defaults.js').RahaSettings>} patch */
  settingsSet: (patch) => bridge().invoke(INVOKE.settingsSet, patch),

  // --- history (pull-based: too large to ride in snapshots)
  historySources: () => bridge().invoke(INVOKE.historySources),
  /** @param {string[]} sourceIds */
  historyImport: (sourceIds) => bridge().invoke(INVOKE.historyImport, { sourceIds }),
  historyImportFile: () => bridge().invoke(INVOKE.historyImportFile),
  /** @param {boolean} active */
  overlaySet: (active) => bridge().invoke(INVOKE.uiOverlay, { active }),
  /** @param {boolean} visible */
  sidebarSet: (visible) => bridge().invoke(INVOKE.uiSidebar, { visible }),
  defaultBrowserSet: () => bridge().invoke(INVOKE.defaultBrowserSet),
  /** @param {string} host */
  siteDataClear: (host) => bridge().invoke(INVOKE.siteDataClear, { host }),
  siteDataClearAll: () => bridge().invoke(INVOKE.siteDataClearAll),
  openTabsSources: () => bridge().invoke(INVOKE.openTabsSources),
  /** @param {string} sourceId */
  openTabsImport: (sourceId) => bridge().invoke(INVOKE.openTabsImport, { sourceId }),
  /** @param {{ query?: string, limit?: number, offset?: number, suggest?: boolean }} [p] */
  historyList: (p) => bridge().invoke(INVOKE.historyList, p),
  historyClear: () => bridge().invoke(INVOKE.historyClear),

  // --- tab organizer
  organizePreview: () => bridge().invoke(INVOKE.organizePreview),
  organizeApply: () => bridge().invoke(INVOKE.organizeApply),

  // --- runaway-tab guard
  /** @param {string} tabId @param {'sleep'|'snooze'} action */
  runawayResolve: (tabId, action) => bridge().invoke(INVOKE.runawayResolve, { tabId, action }),

  // --- site permissions (R-103)
  /** @param {number} id the ask being answered @param {'once'|'always'|'never'|'dismiss'} decision */
  permissionAnswer: (id, decision) => bridge().invoke(INVOKE.permissionAnswer, { id, decision }),
  /** @param {string} host @param {import('../shared/permissions.js').PermissionKind} [kind] omitted = the whole site */
  permissionForget: (host, kind) => bridge().invoke(INVOKE.permissionForget, { host, kind }),

  // --- events
  /** @param {(snap: import('../shared/ipc-contract.js').Snapshot) => void} h */
  onSnapshot: (h) => bridge().on(EVENT.snapshot, h),
  /** @param {(t: { kind: string, text: string }) => void} h */
  onToast: (h) => bridge().on(EVENT.toast, h),
  /** @param {() => void} h */
  onFocusOmnibox: (h) => bridge().on(EVENT.focusOmnibox, () => h()),
  /** @param {() => void} h */
  onOpenSettings: (h) => bridge().on(EVENT.openSettings, () => h()),
  /** @param {() => void} h */
  onOpenHistory: (h) => bridge().on(EVENT.openHistory, () => h()),
  /** @param {() => void} h */
  onOpenFind: (h) => bridge().on(EVENT.openFind, () => h()),
  /** @param {(r: { tabId: string, matches: number, activeMatchOrdinal: number }) => void} h */
  onFindResult: (h) => bridge().on(EVENT.findResult, /** @type {(p: unknown) => void} */ (h)),
  /** @param {() => void} h */
  onToggleSidebar: (h) => bridge().on(EVENT.toggleSidebar, () => h()),
  /** @param {() => void} h */
  onAskDefaultBrowser: (h) => bridge().on(EVENT.askDefaultBrowser, () => h()),
  /** @param {(r: { id: number, url: string, scheme: string|null, app: string }) => void} h */
  onAskExternal: (h) => bridge().on(EVENT.askExternal, /** @type {(p: unknown) => void} */ (h)),
  /** @param {(ask: import('../shared/ipc-contract.js').PermissionAsk|null) => void} h */
  onAskPermission: (h) => bridge().on(EVENT.askPermission, /** @type {(p: unknown) => void} */ (h)),
};
