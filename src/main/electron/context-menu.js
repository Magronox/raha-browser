// Native right-click menus. Two attachment points:
//   - attachPageContextMenu: web-content views. Electron shows NO menu unless
//     the app builds one from the 'context-menu' event; the template comes
//     from src/shared/page-menu.js (pure, unit-tested), this file only maps
//     items to native MenuItems and routes clicks.
//   - attachChromeContextMenu: the UI chrome view. Only text fields get a
//     menu there (cut/copy/paste for the omnibox and inputs) — everything
//     else in the chrome has its own HTML menus.
// Electron APIs used: WebContents 'context-menu' event (params.x/y/linkURL/
// srcURL/mediaType/selectionText/isEditable), Menu.buildFromTemplate,
// menu.popup, webContents.inspectElement, clipboard.writeText —
// https://www.electronjs.org/docs/latest/api/web-contents#event-context-menu
// https://www.electronjs.org/docs/latest/api/menu
import { Menu, clipboard } from 'electron';
import { buildPageMenuTemplate } from '../../shared/page-menu.js';
import { clearSiteData } from './site-data.js';

/**
 * @param {Electron.WebContents} wc
 * @param {{ openUrl: (url: string) => void,
 *           searchSelection: (text: string) => void,
 *           navState: () => { back: boolean, fwd: boolean } }} hooks
 *        openUrl/searchSelection route through the engine (cb.onOpenUrl /
 *        cb.onSearchSelection) so the isNavigableUrl sink gate stays the
 *        single authority on what may load.
 */
export function attachPageContextMenu(wc, hooks) {
  wc.on('context-menu', (_e, params) => {
    const { back, fwd } = hooks.navState();
    const items = buildPageMenuTemplate(params, {
      canGoBack: back,
      canGoForward: fwd,
      devMode: process.env.RAHA_DEV === '1',
      canClearSiteData: /^https?:$/.test((() => { try { return new URL(wc.getURL()).protocol; } catch { return ''; } })()),
    });
    if (items.length === 0) return;

    /** @type {Record<string, () => void>} */
    const actions = {
      'open-link': () => hooks.openUrl(params.linkURL),
      'copy-link': () => clipboard.writeText(params.linkURL),
      'open-image': () => hooks.openUrl(params.srcURL),
      'copy-image-url': () => clipboard.writeText(params.srcURL),
      'search-selection': () => hooks.searchSelection(params.selectionText),
      back: () => { /** @type {any} */ (wc).navigationHistory?.goBack?.(); },
      forward: () => { /** @type {any} */ (wc).navigationHistory?.goForward?.(); },
      reload: () => wc.reload(),
      'clear-site-data': () => {
        try {
          const host = new URL(wc.getURL()).hostname.toLowerCase();
          void clearSiteData(wc.session, host).then(() => wc.reload());
        } catch { /* page navigated away mid-click */ }
      },
      inspect: () => wc.inspectElement(params.x, params.y),
    };

    const template = items.map((item) => {
      if (item.type === 'separator') return { type: /** @type {const} */ ('separator') };
      if (item.role) return { role: /** @type {any} */ (item.role) };
      return {
        label: item.label ?? '',
        enabled: item.enabled !== false,
        click: actions[item.id ?? ''] ?? (() => {}),
      };
    });
    Menu.buildFromTemplate(template).popup();
  });
}

/**
 * Chrome view: native edit menu on text fields only.
 * @param {Electron.WebContents} wc
 */
export function attachChromeContextMenu(wc) {
  wc.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]).popup();
  });
}
