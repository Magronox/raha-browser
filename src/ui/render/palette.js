// Command palette (R-111): Ctrl/⌘+K. One input, a ranked list of open tabs,
// folders and actions (src/shared/palette.js decides what and in which
// order); ↑/↓ + Enter or a click runs the row. Picking a tab activates it
// (an asleep one wakes — that is what jumping to it means), a folder shows
// its grid, an action does what its toolbar/menu twin does.
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, shortUrl, captureFocusedField, restoreFocusedField } from './util.js';
import { buildPaletteItems, rankPalette } from '../../shared/palette.js';
import { openHistory } from './history.js';
import { openDownloads } from './downloads.js';
import { openOrganize } from './organize.js';

/** @type {HTMLElement} */ let root;
/** @type {{ newTab: () => void, openFind: () => void, toggleSidebar: () => void }} */ let host;
let query = '';
let cursor = 0;
/** @type {import('../../shared/palette.js').PaletteItem[]} */ let shown = [];

/**
 * @param {HTMLElement} el
 * @param {{ newTab: () => void, openFind: () => void, toggleSidebar: () => void }} hostActions
 *        chrome-level moves that live in app.js (they touch focus/layout)
 */
export function initPalette(el, hostActions) {
  root = el;
  host = hostActions;
  render();
}

export function openPalette() {
  query = '';
  cursor = 0;
  store.setLocal({ paletteOpen: true });
  queueMicrotask(() => root.querySelector('input')?.focus());
}

function close() {
  store.setLocal({ paletteOpen: false });
}

/** @param {import('../../shared/palette.js').PaletteItem} item */
function run(item) {
  const tab = store.activeTab();
  close();
  if (item.kind === 'tab') { void api.tabActivate(item.id); return; }
  if (item.kind === 'folder') { store.setLocal({ selectedFolderId: item.id }); void api.tabShowGrid(); return; }
  switch (item.id) {
    case 'new-tab': host.newTab(); break;
    case 'grid': void api.tabShowGrid(); break;
    case 'sleep-tab': if (tab) void api.tabSleep(tab.id); break;
    case 'freeze-tab': if (tab) void api.tabFreeze(tab.id); break;
    case 'pin-tab': if (tab) void api.tabSetKeepAlive(tab.id, !tab.keepAlive); break;
    case 'sleep-all': if (store.snap) void api.folderSleepAll(store.snap.rootId); break;
    case 'new-folder': void api.folderCreate('New folder', store.local.selectedFolderId); break;
    case 'organize': openOrganize(); break;
    case 'history': openHistory(); break;
    case 'downloads': openDownloads(); break;
    case 'settings': store.setLocal({ settingsOpen: true }); break;
    case 'toggle-sidebar': host.toggleSidebar(); break;
    case 'find': host.openFind(); break;
    default: break;
  }
}

/** Current ranked rows for the query (test seam too). */
export function paletteRows() {
  const snap = store.snap;
  if (!snap) return [];
  const items = buildPaletteItems(snap, shortUrl, (id) => store.subtreeStats(id).tabs);
  return rankPalette(items, query);
}

export function render() {
  if (!store.local.paletteOpen || !store.snap) {
    root.innerHTML = '';
    root.classList.remove('open');
    return;
  }
  root.classList.add('open');
  const typing = captureFocusedField(root); // a governor tick mid-word must not eat the query
  shown = paletteRows();
  if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);

  root.innerHTML = `
    <div class="modal-backdrop" data-close-palette></div>
    <div class="modal palette" role="dialog" aria-label="Command palette">
      <input type="text" class="palette-input" placeholder="Jump to a tab or folder, or run a command…" value="${esc(query)}" spellcheck="false" autocomplete="off">
      <div class="palette-list" role="listbox">
        ${shown.length === 0 ? '<div class="palette-empty">Nothing matches.</div>' : shown.map((it, i) => `
          <button class="palette-row ${i === cursor ? 'sel' : ''}" role="option" aria-selected="${i === cursor}" data-row="${i}">
            <span class="palette-kind">${it.kind === 'tab' ? (it.state === 'asleep' ? icons.moon : it.state === 'frozen' ? icons.snowflake : icons.sun) : it.kind === 'folder' ? icons.folder : icons.sparkle}</span>
            <span class="palette-title">${esc(it.title)}</span>
            <span class="palette-sub">${esc(it.subtitle)}</span>
          </button>`).join('')}
      </div>
      <div class="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> go · <kbd>Esc</kbd> close</div>
    </div>`;

  restoreFocusedField(root, typing);
  const input = /** @type {HTMLInputElement} */ (root.querySelector('input'));
  input.addEventListener('input', () => { query = input.value; cursor = 0; renderList(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) { cursor = (cursor + 1) % shown.length; renderList(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { cursor = (cursor - 1 + shown.length) % shown.length; renderList(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[cursor]) run(shown[cursor]); }
  });
  root.querySelectorAll('[data-close-palette]').forEach((el) => el.addEventListener('click', close));
  wireRows();
}

/** Re-render only the list: the input keeps its caret and IME state. */
function renderList() {
  const list = root.querySelector('.palette-list');
  if (!list) return;
  shown = paletteRows();
  if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);
  list.innerHTML = shown.length === 0 ? '<div class="palette-empty">Nothing matches.</div>' : shown.map((it, i) => `
    <button class="palette-row ${i === cursor ? 'sel' : ''}" role="option" aria-selected="${i === cursor}" data-row="${i}">
      <span class="palette-kind">${it.kind === 'tab' ? (it.state === 'asleep' ? icons.moon : it.state === 'frozen' ? icons.snowflake : icons.sun) : it.kind === 'folder' ? icons.folder : icons.sparkle}</span>
      <span class="palette-title">${esc(it.title)}</span>
      <span class="palette-sub">${esc(it.subtitle)}</span>
    </button>`).join('');
  wireRows();
  list.querySelector('.palette-row.sel')?.scrollIntoView({ block: 'nearest' });
}

function wireRows() {
  root.querySelectorAll('[data-row]').forEach((el) =>
    el.addEventListener('click', () => {
      const i = Number(/** @type {HTMLElement} */ (el).dataset.row);
      if (shown[i]) run(shown[i]);
    }));
}
