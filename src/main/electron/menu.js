// Application menu = the keyboard shortcut surface. Accelerators here work
// no matter which view (UI chrome or web content) has focus, which is why
// shortcuts live in the menu rather than in DOM key handlers.
// Shortcut list is documented in README.md — keep the two in sync.
import { Menu } from 'electron';

/**
 * @param {import('../core/engine.js').Engine} engine
 * @param {{ focusOmnibox: () => void, toggleSidebar: () => void, openHistory: () => void, openFind: () => void }} ui
 * @param {() => void} openSettings
 */
export function installMenu(engine, ui, openSettings) {
  const activeId = () => engine.state.activeTabId;
  const withActive = (/** @type {(tabId: string) => void} */ fn) => () => {
    const id = activeId();
    if (id) fn(id);
  };

  /** Running tabs, most recently used first. */
  const runningByRecency = () => [...engine.runtime.keys()]
    .map((id) => engine.tabNode(id))
    .filter((n) => n != null)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  /** Cycle through RUNNING tabs only (never wakes a sleeping tab). */
  const cycle = (/** @type {1|-1} */ dir) => () => {
    const running = [...engine.runtime.keys()];
    if (running.length === 0) return;
    const cur = activeId();
    const idx = cur ? running.indexOf(cur) : -1;
    const next = running[(idx + dir + running.length) % running.length];
    engine.tabActivate({ tabId: next });
  };

  const closeTab = () => {
    const id = activeId();
    if (id) return void engine.tabClose({ tabId: id });
    // On the grid (no active tab) Cmd/Ctrl+W dismisses it the way closing a
    // new-tab page does: back to the most recently used running tab.
    const recent = runningByRecency()[0];
    if (recent) engine.tabActivate({ tabId: recent.id });
  };

  /** Jump to the Nth running tab, livebar order; 9 = last (browser convention). */
  const jumpTo = (/** @type {number} */ n) => () => {
    const running = [...engine.runtime.keys()];
    if (running.length === 0) return;
    const id = n === 9 ? running[running.length - 1] : running[n - 1];
    if (id) engine.tabActivate({ tabId: id });
  };

  const template = [
    ...(process.platform === 'darwin' ? [{ role: /** @type {const} */ ('appMenu') }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => { engine.tabShowGrid(); ui.focusOmnibox(); } },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: closeTab },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => engine.tabReopen() },
        { type: /** @type {const} */ ('separator') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
        { type: /** @type {const} */ ('separator') },
        { role: /** @type {const} */ ('quit') },
      ],
    },
    { role: /** @type {const} */ ('editMenu') },
    {
      label: 'View',
      submenu: [
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => ui.focusOmnibox() },
        { id: 'find-in-page', label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: () => ui.openFind() },
        { label: 'Show Grid / Home', accelerator: 'CmdOrCtrl+E', click: () => engine.tabShowGrid() },
        // Shift+B, not plain B: menu accelerators fire before the page sees
        // keys, and Cmd/Ctrl+B is Bold in every web editor.
        { id: 'toggle-sidebar', label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+Shift+B', click: () => ui.toggleSidebar() },
        { label: 'History', accelerator: process.platform === 'darwin' ? 'Cmd+Y' : 'Ctrl+H', click: () => ui.openHistory() },
        { type: /** @type {const} */ ('separator') },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: withActive((id) => engine.navOp({ tabId: id }, 'reload')) },
        { label: 'Hard Reload (ignore cache)', accelerator: 'CmdOrCtrl+Shift+R', click: withActive((id) => engine.navOp({ tabId: id }, 'hardReload')) },
        { label: 'Back', accelerator: 'Alt+Left', click: withActive((id) => engine.navOp({ tabId: id }, 'back')) },
        { label: 'Forward', accelerator: 'Alt+Right', click: withActive((id) => engine.navOp({ tabId: id }, 'forward')) },
        // macOS natives expect Cmd+[ / Cmd+] — hidden duplicates (accelerators
        // of hidden items still fire on macOS; acceleratorWorksWhenHidden).
        ...(process.platform === 'darwin' ? [
          { label: 'Back', accelerator: 'Cmd+[', visible: false, click: withActive((id) => engine.navOp({ tabId: id }, 'back')) },
          { label: 'Forward', accelerator: 'Cmd+]', visible: false, click: withActive((id) => engine.navOp({ tabId: id }, 'forward')) },
        ] : []),
        { type: /** @type {const} */ ('separator') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: withActive((id) => engine.zoomSet({ tabId: id, direction: 'in' })) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: withActive((id) => engine.zoomSet({ tabId: id, direction: 'out' })) },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: withActive((id) => engine.zoomSet({ tabId: id, direction: 'reset' })) },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Running Tab', accelerator: 'Ctrl+Tab', click: cycle(1) },
        { label: 'Previous Running Tab', accelerator: 'Ctrl+Shift+Tab', click: cycle(-1) },
        {
          label: 'Switch to Running Tab',
          submenu: Array.from({ length: 9 }, (_, i) => ({
            label: i === 8 ? 'Last Running Tab' : `Running Tab ${i + 1}`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: jumpTo(i + 1),
          })),
        },
        { type: /** @type {const} */ ('separator') },
        { label: 'Sleep This Tab', accelerator: 'CmdOrCtrl+Shift+S', click: withActive((id) => engine.tabSleep({ tabId: id })) },
        { label: 'Sleep All Tabs', accelerator: 'CmdOrCtrl+Shift+A', click: () => engine.folderSleepAll({ folderId: engine.state.tree.rootId }) },
        { label: 'Keep This Tab Alive (toggle)', accelerator: 'CmdOrCtrl+Shift+K', click: withActive((id) => {
          const node = engine.tabNode(id);
          if (node) engine.tabSetKeepAlive({ tabId: id, keepAlive: !node.keepAlive });
        }) },
      ],
    },
    ...(process.platform === 'darwin' ? [{ role: /** @type {const} */ ('windowMenu') }] : []),
    {
      label: 'Developer',
      submenu: [
        { label: 'Toggle DevTools (page)', accelerator: 'F12', click: withActive((id) => {
          const rt = engine.runtime.get(id);
          const wc = rt?.view?.devWebContents?.();
          if (wc) wc.toggleDevTools();
        }) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(/** @type {any} */ (template)));
}
