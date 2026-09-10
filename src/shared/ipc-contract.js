// ============================================================================
// THE IPC CONTRACT — the ONLY place channel names are defined.
// ============================================================================
// Main handlers (src/main/electron/ipc.js), the preload bridge
// (src/preload/ui.cjs) and the UI api wrapper (src/ui/api.js) all import
// from here. Adding a channel? Follow docs/PLAYBOOKS/add-an-ipc-channel.md —
// it updates all four places in one sitting and adds a contract test.
//
// Direction 1: UI -> main, request/response via invoke(channel, payload).
// Direction 2: main -> UI, fire-and-forget events via send(channel, payload).

/** UI -> main. Values are the wire channel names. */
export const INVOKE = {
  stateGet: 'state:get',              // () -> Snapshot
  tabCreate: 'tab:create',            // ({url?, folderId?, activate?}) -> {tabId}
  tabClose: 'tab:close',              // ({tabId}) -> {ok}
  tabActivate: 'tab:activate',        // ({tabId}) -> {ok}   wakes if asleep
  tabSleep: 'tab:sleep',              // ({tabId}) -> {ok}   manual sleep
  tabSetKeepAlive: 'tab:setKeepAlive',// ({tabId, keepAlive}) -> {ok}
  tabSetMemLimit: 'tab:setMemLimit',  // ({tabId, memLimitMB|null}) -> {ok}
  tabShowGrid: 'tab:showGrid',        // () -> {ok}          deactivate content view, show grid
  navOmnibox: 'nav:omnibox',          // ({input, tabId|null, folderId?, mode?: 'here'|'new'|'switch'}) -> {ok, switched?}|{tabId}  resolve+load. Default mode: 'here' with a tabId (navigate it in place), 'new' without (tab created in folderId — the folder being viewed — not at root). 'new' with a tabId opens beside it (its folder, never the sidebar's selection); 'switch' activates a tab already showing that page, else the default
  navBack: 'nav:back',                // ({tabId}) -> {ok}
  navForward: 'nav:forward',          // ({tabId}) -> {ok}
  navReload: 'nav:reload',            // ({tabId}) -> {ok}
  navHardReload: 'nav:hardReload',    // ({tabId}) -> {ok}  reload ignoring the HTTP cache (stale-frontend rescue)
  navStop: 'nav:stop',                // ({tabId}) -> {ok}
  findStart: 'find:start',            // ({tabId, text, forward?, newSession?}) -> {ok}|{error}  results arrive via evt:findResult
  findStop: 'find:stop',              // ({tabId, keepSelection?}) -> {ok}   clears highlights (and selection unless kept)
  folderCreate: 'folder:create',      // ({name, parentId?}) -> {folderId}
  folderRename: 'folder:rename',      // ({folderId, name}) -> {ok}
  folderToggle: 'folder:toggle',      // ({folderId, collapsed}) -> {ok}
  folderSleepAll: 'folder:sleepAll',  // ({folderId}) -> {slept: number}
  nodeRemove: 'node:remove',          // ({nodeId}) -> {ok}  tab or folder(+subtree)
  nodeMove: 'node:move',              // ({nodeId, parentId, index}) -> {ok}
  settingsGet: 'settings:get',        // () -> RahaSettings
  settingsSet: 'settings:set',        // (partial RahaSettings) -> {settings, problems}
  zoomSet: 'zoom:set',                // ({tabId, direction: 'in'|'out'|'reset'}) -> {ok}
  historySources: 'history:sources',  // () -> {sources: HistorySource[]}   detected browser profiles
  historyImport: 'history:import',    // ({sourceIds}) -> {added, updated, total, problems}
  historyImportFile: 'history:importFile', // () -> {added, updated, total, problems}|{canceled} — native file picker, MAIN owns the path (renderer never names files); accepts a copied History.db / History / places.sqlite
  uiOverlay: 'ui:overlay',              // ({active}) -> {ok}   raise the chrome above the page view while a modal/overlay is open (else it renders BEHIND the tab)
  uiSidebar: 'ui:sidebar',              // ({visible}) -> {ok}  sidebar toggled: main re-lays the content view over the freed space
  defaultBrowserSet: 'defaultBrowser:set', // () -> {ok, isDefault}  register as http/https handler (macOS shows its own confirm dialog)
  externalOpen: 'external:open',        // ({id, remember?}) -> {ok}|{error}  confirm the app-link ask `id` names; the engine opens ITS stored URL — the UI never sends one; remember adds the scheme to settings
  externalDismiss: 'external:dismiss',  // ({id}) -> {ok}   user declined the app-link ask `id` names (stale id = no-op)
  siteDataClear: 'siteData:clear',      // ({host}) -> {ok, cookiesRemoved}  cookies+storage for a host, its subdomains, and its partitioned 3p jar
  siteDataClearAll: 'siteData:clearAll', // () -> {ok}|{canceled}  EVERYTHING (native confirm dialog in main first)
  openTabsSources: 'openTabs:sources',  // () -> {sources: [{id, browser, label, kind}]}   running browsers (macOS Automation) + Firefox/Zen session files
  openTabsImport: 'openTabs:import',    // ({sourceId}) -> {windows, tabs, problems}|{error}   folders per window, tabs created asleep
  historyList: 'history:list',        // ({query?, limit?, offset?, suggest?}) -> {entries: HistoryEntry[], total}   suggest=true ranks by visitCount then recency over ALL matches (omnibox)
  historyClear: 'history:clear',      // () -> {ok}
  organizePreview: 'organize:preview',// () -> {groups: [{name, folderId|null, tabs: [{id, title}]}], loose, leftover}
  organizeApply: 'organize:apply',    // () -> {moved, foldersCreated}   recomputes the plan, never trusts one from the UI
  runawayResolve: 'runaway:resolve',  // ({tabId, action: 'sleep'|'snooze'}) -> {ok}   answer the runaway-tab prompt
  permissionAnswer: 'permission:answer', // ({id, decision: 'once'|'always'|'never'|'dismiss'}) -> {ok}|{error}  answer the site-permission ask `id` names (stale id = error, nothing granted); always/never persist per kind under the site
  permissionForget: 'permission:forget', // ({host, kind?}) -> {ok}|{error}  drop a remembered decision (one kind, or the whole site when kind is omitted)
};

/** main -> UI events. */
export const EVENT = {
  snapshot: 'evt:snapshot',           // full Snapshot push (state or metrics changed)
  toast: 'evt:toast',                 // {kind:'info'|'warn'|'sleep'|'download', text}
  focusOmnibox: 'evt:focusOmnibox',   // {} (keyboard shortcut routed from main)
  openSettings: 'evt:openSettings',   // {} (menu/shortcut routed from main)
  openHistory: 'evt:openHistory',     // {} (menu/shortcut routed from main)
  openFind: 'evt:openFind',           // {} (Cmd/Ctrl+F routed from main — UI opens the find bar)
  findResult: 'evt:findResult',       // {tabId, matches, activeMatchOrdinal} final result of a find:start
  toggleSidebar: 'evt:toggleSidebar', // {} (Cmd/Ctrl+B routed from main — UI owns the state)
  askDefaultBrowser: 'evt:askDefaultBrowser', // {} first packaged launch, once: show the IN-APP ask; only a yes there triggers the OS registration
  askExternal: 'evt:askExternal',     // {id, url, scheme, app} a page asked to open an app link — show the ask; the OS is touched only on a yes echoing this id
  askPermission: 'evt:askPermission', // PermissionAsk|null  show this site-permission ask (the ACTIVE tab's, one at a time) — or null: withdraw what is on screen (tab switched/closed/slept/navigated)
};

/**
 * Flat allow-lists. src/main/electron/window.js passes these to the preload
 * through webPreferences.additionalArguments, and src/preload/ui.cjs refuses
 * any channel that is not in them — the preload cannot import this file
 * directly because it is sandboxed CommonJS and this module is ESM.
 */
export const ALL_INVOKE_CHANNELS = Object.values(INVOKE);
export const ALL_EVENT_CHANNELS = Object.values(EVENT);

/**
 * @typedef {Object} SnapshotTab   What the UI knows about one tab.
 * @property {string} id
 * @property {string} parentId
 * @property {string} url
 * @property {string} title
 * @property {string|null} faviconUrl
 * @property {'active'|'running'|'asleep'} state
 * @property {boolean} keepAlive        the persisted per-tab flag
 * @property {boolean} keepAliveEffective includes domain rules
 * @property {number|null} memLimitMB
 * @property {number|null} memMB        null when asleep/not yet sampled
 * @property {number|null} cpuPct       null when asleep/not yet sampled
 * @property {boolean} memShared        renderer process shared with another tab
 * @property {boolean} audible
 * @property {boolean} loading
 * @property {boolean} canGoBack
 * @property {boolean} canGoForward
 * @property {number} lastActiveAt
 * @property {number} thumbSeq          bump = re-fetch raha://thumb/<id>?s=<seq>
 * @property {number} blockedCount      tracker requests blocked in this tab (session)
 *
 * @typedef {Object} SnapshotFolder
 * @property {string} id
 * @property {string|null} parentId
 * @property {string} name
 * @property {string[]} childIds
 * @property {boolean} collapsed
 *
 * @typedef {Object} Snapshot
 * @property {SnapshotTab[]} tabs
 * @property {SnapshotFolder[]} folders
 * @property {string} rootId
 * @property {string|null} activeTabId
 * @property {import('./defaults.js').RahaSettings} settings
 * @property {{ runningCount: number, totalMemMB: number, maxLiveTabs: number }} stats
 * @property {{ tabId: string, kind: 'cpu'|'mem' }|null} runaway  open runaway-tab prompt (live values are on the tab itself)
 *
 * @typedef {Object} PermissionAsk  A pending "site wants X" ask (R-103, ADR-0013), as the UI sees it.
 * @property {number} id             nonce the answer must echo (permission:answer)
 * @property {string} tabId
 * @property {import('./permissions.js').PermissionKind[]} kinds  what is being asked about, canonical order
 * @property {string} host           the tab's site (normalized host) the decision is filed under
 * @property {string|null} requestingHost  the asking frame's host (page-controlled; display only)
 * @property {boolean} isMainFrame   false = an embedded frame asked
 *
 * @typedef {Object} HistorySource  One importable browser profile on this machine.
 * @property {string} id       opaque token, only valid for the scan that produced it
 * @property {string} browser  e.g. 'Chrome', 'Firefox', 'Safari', 'Zen'
 * @property {string} label    profile label, e.g. 'Default' or 'Work'
 * @property {'chromium'|'firefox'|'safari'} kind
 */
