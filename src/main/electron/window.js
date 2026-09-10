// The single application window: a BaseWindow hosting
//   1. the UI view (our chrome — sidebar, topbar, grid, live bar) full-bleed,
//   2. the active tab's WebContentsView, positioned in the content rectangle.
// Layout constants live in src/shared/layout.js (UI mirrors them in CSS).
import { app, BaseWindow, WebContentsView, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentRect } from '../../shared/layout.js';
import { UI_CHROME_URL, isUiChromeUrl } from '../../shared/urls.js';
import { ALL_INVOKE_CHANNELS, ALL_EVENT_CHANNELS } from '../../shared/ipc-contract.js';
import { installRahaProtocol } from './protocol.js';
import { standardUserAgent, alignSessionClientHints } from './privacy.js';
import { attachChromeContextMenu } from './context-menu.js';
import { log } from './log.js';

export const UI_PARTITION = 'raha-ui'; // in-memory, isolated from web session

export function createMainWindow() {
  const win = new BaseWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'Raha',
    backgroundColor: '#0e1116',
    show: false,
  });

  const uiSession = session.fromPartition(UI_PARTITION);
  // Favicon fetches from the chrome must not leak a Raha/Electron UA either.
  uiSession.setUserAgent(standardUserAgent());
  // …and its client hints must agree with that UA, or every favicon fetch
  // re-broadcasts the automation tell the web session stopped sending.
  alignSessionClientHints(uiSession);
  installRahaProtocol(uiSession, { allowThumbs: true, allowChrome: true });

  const preloadPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'preload', 'ui.cjs',
  );
  const uiView = new WebContentsView({
    webPreferences: {
      partition: UI_PARTITION,
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Hand the preload its channel allow-list. A sandboxed preload is CJS
      // and cannot import the ESM contract, and additionalArguments is the
      // documented way to pass small data down to one — so the contract stays
      // the single source of channel names (docs/INVARIANTS.md #7).
      additionalArguments: [
        `--raha-invoke=${JSON.stringify(ALL_INVOKE_CHANNELS)}`,
        `--raha-events=${JSON.stringify(ALL_EVENT_CHANNELS)}`,
        `--raha-version=${app.getVersion()}`, // shown in Settings → About
      ],
    },
  });
  win.contentView.addChildView(uiView);
  attachChromeContextMenu(uiView.webContents); // native cut/copy/paste on the omnibox etc.

  // ---------------------------------------------------------------------
  // Pin the chrome view to its own page. This view is the only one with the
  // preload bridge; if it ever lands on another origin, that origin gets
  // window.raha and therefore every IPC channel. Electron security checklist
  // items 13 and 14. Nothing in the chrome navigates on purpose, so anything
  // arriving here is a bug or an attack — most plausibly a file dropped onto
  // the window, which Chromium navigates to by default.
  //
  // Note these only fire for renderer-initiated navigation: our own
  // loadURL() calls below (first load, crash recovery) are unaffected.
  const denyNavigation = (/** @type {Electron.Event} */ e, /** @type {string} */ url) => {
    if (isUiChromeUrl(url)) return;
    e.preventDefault();
    log('ui', `blocked chrome-view navigation to ${url.slice(0, 120)}`);
  };
  uiView.webContents.on('will-navigate', denyNavigation);
  uiView.webContents.on('will-redirect', denyNavigation);
  uiView.webContents.setWindowOpenHandler(({ url }) => {
    log('ui', `blocked chrome-view window.open to ${String(url).slice(0, 120)}`);
    return { action: 'deny' };
  });

  /** @type {any|null} the currently attached content view */
  let attachedContent = null;
  // Child-view order is z-order, and attach() adds the tab view AFTER the
  // chrome — so chrome HTML overlapping the content rect (centered modals,
  // toasts) is invisible while a tab is attached. When the UI opens an
  // overlay it asks main to raise the chrome above the page (ui:overlay);
  // attach() must respect the flag or a governor-driven tab swap mid-modal
  // would put the page back on top.
  let chromeOnTop = false;
  let sidebarVisible = true; // mirrors the UI's toggle (ui:sidebar)

  const layout = () => {
    const b = win.getContentBounds();
    uiView.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
    if (attachedContent) attachedContent.setBounds(contentRect({ width: b.width, height: b.height }, { sidebarVisible }));
  };
  win.on('resize', layout);
  layout();

  void uiView.webContents.loadURL(UI_CHROME_URL);
  uiView.webContents.on('render-process-gone', (_e, details) => {
    log('ui', `UI renderer gone (${details.reason}); reloading`);
    void uiView.webContents.loadURL(UI_CHROME_URL);
  });

  if (process.env.RAHA_DEV === '1') {
    uiView.webContents.openDevTools({ mode: 'detach' });
  }

  const windowHost = {
    /** @param {any} view */
    attach(view) {
      if (attachedContent === view) return;
      if (attachedContent) win.contentView.removeChildView(attachedContent);
      attachedContent = view;
      win.contentView.addChildView(view);
      if (chromeOnTop) win.contentView.addChildView(uiView); // re-adding re-orders to top
      layout();
    },
    /** Sidebar toggled in the UI: content view takes (or returns) its space. @param {boolean} visible */
    setSidebarVisible(visible) {
      sidebarVisible = Boolean(visible);
      layout();
    },
    /** Raise the chrome above the page while a modal is open (and back). @param {boolean} on */
    setChromeOnTop(on) {
      chromeOnTop = Boolean(on);
      if (chromeOnTop) {
        win.contentView.addChildView(uiView);
      } else if (attachedContent) {
        win.contentView.addChildView(attachedContent); // page back on top
        layout();
      }
    },
    /** @param {any} view */
    detach(view) {
      if (attachedContent === view) {
        win.contentView.removeChildView(view);
        attachedContent = null;
      } else {
        // Detaching a non-attached view is legal (idempotent).
        try { win.contentView.removeChildView(view); } catch { /* not a child */ }
      }
    },
  };

  // BaseWindow has no 'ready-to-show'; show once the UI chrome has rendered.
  uiView.webContents.once('did-finish-load', () => { if (!win.isDestroyed()) win.show(); });
  return { win, uiView, windowHost };
}
