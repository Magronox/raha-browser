// UI state: the latest Snapshot from main + purely-local view state
// (selected folder, open modals). Subscribers re-render on change.

/**
 * @typedef {Object} UiLocal
 * @property {string} selectedFolderId
 * @property {boolean} sidebarHidden  toggled with the topbar button / Cmd-B; session-local
 * @property {boolean} settingsOpen
 * @property {{ x: number, y: number, nodeId: string, isFolder: boolean }|null} ctxMenu
 * @property {string|null} renamingId
 * @property {string|null} limitPromptId
 * @property {boolean} defaultBrowserAsk  one-time first-launch "make Raha default?" prompt (routed from main)
 * @property {{ id: number, url: string, scheme: string|null, app: string }|null} externalAsk  pending "open this in another app?" request (routed from main); id must echo back on the answer
 * @property {import('../shared/ipc-contract.js').PermissionAsk|null} permissionAsk  the site-permission ask on screen (routed from main; null = withdrawn); id must echo back on the answer
 * @property {boolean} historyOpen
 * @property {string} historyQuery
 * @property {{ entries: import('../shared/history.js').HistoryEntry[], total: number }|null} historyData   pulled, not from snapshots
 * @property {import('../shared/ipc-contract.js').HistorySource[]|null} historySources  null = scan in flight
 * @property {Record<string, boolean>} historySel  source id -> import checkbox
 * @property {boolean} historyBusy
 * @property {boolean} historyMoreBusy  a "Show more" page is in flight (the button disables itself)
 * @property {any} historyReport  last import result ({added,total,problems} or {error})
 * @property {import('../shared/ipc-contract.js').HistorySource[]|null} openTabSources  open-tabs sources; null = scan in flight
 * @property {string|null} openTabsBusy  sourceId of the import in flight
 * @property {any} openTabsReport  last open-tabs import result ({windows,tabs,problems} or {error})
 * @property {boolean} organizeOpen
 * @property {any} organizePlan  preview from organize:preview; null = fetch in flight
 * @property {boolean} findOpen  find-in-page bar visible (Cmd/Ctrl+F; only with an active tab).
 *           The match count itself is topbar module state, NOT store state — a
 *           result re-render would abort IME compositions in the find box.
 */

/** @type {import('../shared/ipc-contract.js').Snapshot|null} */
let snapshot = null;

/** @type {UiLocal} */
const local = {
  selectedFolderId: 'root',
  sidebarHidden: false,
  settingsOpen: false,
  ctxMenu: null,
  renamingId: null,
  limitPromptId: null,
  defaultBrowserAsk: false,
  externalAsk: null,
  permissionAsk: null,
  historyOpen: false,
  historyQuery: '',
  historyData: null,
  historySources: null,
  historySel: {},
  historyBusy: false,
  historyMoreBusy: false,
  historyReport: null,
  openTabSources: null,
  openTabsBusy: null,
  openTabsReport: null,
  organizeOpen: false,
  organizePlan: null,
  findOpen: false,
};

/** @type {Set<() => void>} */
const subs = new Set();

export const store = {
  /** @returns {import('../shared/ipc-contract.js').Snapshot|null} */
  get snap() { return snapshot; },
  get local() { return local; },

  /** @param {import('../shared/ipc-contract.js').Snapshot} s */
  setSnapshot(s) {
    snapshot = s;
    // Selected folder can disappear (deleted elsewhere) — fall back to root.
    if (!s.folders.some((f) => f.id === local.selectedFolderId)) {
      local.selectedFolderId = s.rootId;
    }
    notify();
  },

  /** @param {Partial<UiLocal>} patch */
  setLocal(patch) {
    Object.assign(local, patch);
    notify();
  },

  /** @param {() => void} fn @returns {() => void} */
  subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },

  // ---- convenient selectors
  /** @param {string} id @returns {import('../shared/ipc-contract.js').SnapshotTab|null} */
  tabById(id) { return snapshot?.tabs.find((t) => t.id === id) ?? null; },
  /** @param {string} id @returns {import('../shared/ipc-contract.js').SnapshotFolder|null} */
  folderById(id) { return snapshot?.folders.find((f) => f.id === id) ?? null; },
  activeTab() { return snapshot?.activeTabId ? this.tabById(snapshot.activeTabId) : null; },
  /** Running tabs, active first, then by recency. */
  runningTabs() {
    if (!snapshot) return [];
    return snapshot.tabs
      .filter((t) => t.state !== 'asleep')
      .sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active') || b.lastActiveAt - a.lastActiveAt);
  },
  /** Direct children (folders + tabs) of a folder, in stored order. */
  childrenOf(/** @type {string} */ folderId) {
    const f = this.folderById(folderId);
    if (!f || !snapshot) return [];
    /** @type {Array<{ kind: 'folder', folder: import('../shared/ipc-contract.js').SnapshotFolder }|{ kind: 'tab', tab: import('../shared/ipc-contract.js').SnapshotTab }>} */
    const out = [];
    for (const id of f.childIds) {
      const folder = this.folderById(id);
      if (folder) { out.push({ kind: 'folder', folder }); continue; }
      const tab = this.tabById(id);
      if (tab) out.push({ kind: 'tab', tab });
    }
    return out;
  },
  /** Count of tabs in a folder's subtree + how many are running. */
  subtreeStats(/** @type {string} */ folderId) {
    let tabs = 0;
    let running = 0;
    const walk = (/** @type {string} */ id) => {
      for (const child of this.childrenOf(id)) {
        if (child.kind === 'tab') {
          tabs += 1;
          if (child.tab.state !== 'asleep') running += 1;
        } else {
          walk(child.folder.id);
        }
      }
    };
    walk(folderId);
    return { tabs, running };
  },
  /** Breadcrumb path root -> folder. @param {string} folderId */
  pathTo(folderId) {
    /** @type {import('../shared/ipc-contract.js').SnapshotFolder[]} */
    const path = [];
    let cur = this.folderById(folderId);
    let guard = 0;
    while (cur && guard < 100) {
      path.unshift(cur);
      cur = cur.parentId ? this.folderById(cur.parentId) : null;
      guard += 1;
    }
    return path;
  },
};

function notify() {
  for (const fn of subs) fn();
}
