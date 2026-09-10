// Pure builder for the right-click menu inside web pages. The Electron side
// (src/main/electron/context-menu.js) maps the returned items onto a native
// Menu; keeping the WHAT here (electron-free) makes every branch unit-testable
// in tests/unit/page-menu.test.js.
//
// Item vocabulary the adapter understands:
//   { id, label, enabled? }  an action it wires to a click handler
//   { role: '...' }          a native edit role (cut/copy/paste/selectAll) —
//                            Electron implements these against the focused
//                            frame, including their enabled state
//   { type: 'separator' }

import { isNavigableUrl } from './urls.js';

const SELECTION_LABEL_MAX = 30;

/**
 * @typedef {{ id?: string, label?: string, enabled?: boolean, role?: string, type?: 'separator' }} PageMenuItem
 */

/**
 * @param {{ linkURL?: string, srcURL?: string, mediaType?: string,
 *           selectionText?: string, isEditable?: boolean }} params
 *        subset of Electron's context-menu params (all page-controlled!)
 * @param {{ canGoBack: boolean, canGoForward: boolean, devMode: boolean, canClearSiteData?: boolean }} caps
 * @returns {PageMenuItem[]}
 */
export function buildPageMenuTemplate(params, caps) {
  /** @type {PageMenuItem[]} */
  const items = [];
  const linkURL = str(params.linkURL);
  const srcURL = str(params.srcURL);
  const selection = str(params.selectionText).replace(/\s+/g, ' ').trim();

  if (linkURL) {
    // Only offer to LOAD gate-passing links (javascript:/file:/... would be
    // refused at the engine sink anyway — don't dangle a dead item). Copying
    // any link text is harmless and standard.
    if (isNavigableUrl(linkURL)) items.push({ id: 'open-link', label: 'Open Link in New Tab' });
    items.push({ id: 'copy-link', label: 'Copy Link Address' });
    items.push({ type: 'separator' });
  }

  if (params.mediaType === 'image' && srcURL) {
    if (isNavigableUrl(srcURL)) items.push({ id: 'open-image', label: 'Open Image in New Tab' });
    items.push({ id: 'copy-image-url', label: 'Copy Image Address' });
    items.push({ type: 'separator' });
  }

  if (params.isEditable) {
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    items.push({ type: 'separator' });
  } else if (selection) {
    items.push({ role: 'copy' });
    items.push({ id: 'search-selection', label: `Search for “${truncate(selection)}”` });
    items.push({ type: 'separator' });
  }

  items.push(
    { id: 'back', label: 'Back', enabled: caps.canGoBack },
    { id: 'forward', label: 'Forward', enabled: caps.canGoForward },
    { id: 'reload', label: 'Reload' },
  );

  // The un-wedge for cookie-based lockouts (consent walls, bot-check loops):
  // only offered on http(s) pages — clearing "data" for raha:// is nonsense.
  if (caps.canClearSiteData) {
    items.push({ type: 'separator' });
    items.push({ id: 'clear-site-data', label: 'Clear Cookies & Data for This Site' });
  }

  if (caps.devMode) {
    items.push({ type: 'separator' });
    items.push({ id: 'inspect', label: 'Inspect Element' });
  }

  return items;
}

/** @param {unknown} v */
function str(v) { return typeof v === 'string' ? v : ''; }

/** @param {string} s */
function truncate(s) {
  return s.length > SELECTION_LABEL_MAX ? `${s.slice(0, SELECTION_LABEL_MAX)}…` : s;
}
