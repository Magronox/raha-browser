// Sidebar: the nested folder/tab tree with drag-drop, inline rename,
// collapse, and per-node context menus.
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, faviconHtml, wireImgFallbacks, MOD, captureFocusedField, restoreFocusedField, captureScrollTop, restoreScrollTop } from './util.js';
import { wireDnd, isDragging } from '../dnd.js';
import { openOrganize } from './organize.js';

/** @type {HTMLElement} */ let root;
/** Last rendered markup — unchanged content skips the innerHTML swap. */
let lastHtml = '';

export function initSidebar(/** @type {HTMLElement} */ el) {
  root = el;
  render();
}

export function render() {
  const snap = store.snap;
  if (!snap) { root.innerHTML = ''; lastHtml = ''; return; }
  if (isDragging()) return; // never yank the DOM mid-drag; dragend re-renders

  /** @type {string[]} */
  const rows = [];
  const walk = (/** @type {string} */ folderId, /** @type {number} */ depth) => {
    for (const child of store.childrenOf(folderId)) {
      if (child.kind === 'folder') {
        const f = child.folder;
        const { tabs, running } = store.subtreeStats(f.id);
        const selected = store.local.selectedFolderId === f.id && snap.activeTabId == null;
        rows.push(`
          <div class="row folder ${selected ? 'selected' : ''}" draggable="true"
               data-id="${esc(f.id)}" data-kind="folder" data-depth="${depth}">
            <button class="chev ${f.collapsed ? '' : 'open'}" data-toggle="${esc(f.id)}" title="${f.collapsed ? 'Expand' : 'Collapse'}">${icons.chevron}</button>
            <span class="ico">${f.collapsed ? icons.folder : icons.folderOpen}</span>
            ${store.local.renamingId === f.id
              ? `<input class="rename" data-rename="${esc(f.id)}" value="${esc(f.name)}" spellcheck="false">`
              : `<span class="name" data-open-folder="${esc(f.id)}">${esc(f.name)}</span>`}
            <span class="count" title="${running} running / ${tabs} tabs">${running > 0 ? `<b>${running}</b>/` : ''}${tabs}</span>
          </div>`);
        if (!f.collapsed) walk(f.id, depth + 1);
      } else {
        const t = child.tab;
        rows.push(`
          <div class="row tab state-${t.state}" draggable="true"
               data-id="${esc(t.id)}" data-kind="tab" data-depth="${depth}" title="${esc(t.title)}\n${esc(t.url)}">
            <span class="dot" title="${t.state}"></span>
            <span class="fav">${faviconHtml(t)}</span>
            <span class="name" data-activate="${esc(t.id)}">${esc(t.title)}</span>
            ${t.audible ? `<span class="mini audio" title="Playing audio">${icons.audio}</span>` : ''}
            ${t.keepAliveEffective ? `<span class="mini pin ${t.keepAlive ? '' : 'rule'}" title="${t.keepAlive ? 'Kept alive (pinned)' : 'Kept alive by a domain rule'}">${icons.pin}</span>` : ''}
            <span class="rowbtns">
              ${t.state === 'asleep'
                ? `<button class="mini act" data-wake="${esc(t.id)}" title="Wake">${icons.sun}</button>`
                : `<button class="mini act" data-sleep="${esc(t.id)}" title="Sleep now">${icons.moon}</button>`}
              <button class="mini act danger" data-close="${esc(t.id)}" title="Close">${icons.close}</button>
            </span>
          </div>`);
      }
    }
  };
  walk(snap.rootId, 0);

  const { tabs: allTabs, running: allRunning } = store.subtreeStats(snap.rootId);
  const allSelected = store.local.selectedFolderId === snap.rootId && snap.activeTabId == null;
  const html = `
    <div class="side-head">
      <span class="brand">${icons.bird}<b>Raha</b></span>
      <span class="side-actions">
        <button class="iconbtn" data-newtab title="New tab (${MOD}+T)">${icons.plus}</button>
        <button class="iconbtn" data-newfolder title="New folder">${icons.folder}</button>
        <button class="iconbtn" data-organize title="Organize loose tabs into folders">${icons.sparkle}</button>
      </span>
    </div>
    <div class="row folder rootrow ${allSelected ? 'selected' : ''}" data-id="${esc(snap.rootId)}" data-kind="folder" data-depth="0">
      <span class="ico">${icons.grid}</span>
      <span class="name" data-open-folder="${esc(snap.rootId)}">All tabs</span>
      <span class="count">${allRunning > 0 ? `<b>${allRunning}</b>/` : ''}${allTabs}</span>
    </div>
    <div class="tree">${rows.join('')}</div>
    <div class="side-drop" data-dropzone="root"></div>
  `;
  // Identical content -> keep the existing DOM: an innerHTML swap recreates
  // every favicon <img>, refetching them (dead ones from the NETWORK) and
  // flashing rows on each governor tick. See grid.js for the same guard.
  if (html === lastHtml) return;
  lastHtml = html;

  const typing = captureFocusedField(root); // e.g. a rename mid-word
  const treeScroll = captureScrollTop(root, '.tree'); // mid-scroll tick must not jump to top
  root.innerHTML = html;

  // Indentation depth via CSSOM, not style="" attributes — the page CSP
  // (style-src 'self') blocks inline style attributes but not property sets.
  root.querySelectorAll('.row[data-depth]').forEach((el) => {
    const row = /** @type {HTMLElement} */ (el);
    row.style.setProperty('--depth', row.dataset.depth ?? '0');
  });

  restoreFocusedField(root, typing);
  restoreScrollTop(root, '.tree', treeScroll);

  // --- events
  root.querySelector('[data-newtab]')?.addEventListener('click', () => {
    void api.tabShowGrid();
    document.dispatchEvent(new CustomEvent('raha:focus-omnibox'));
  });
  root.querySelector('[data-newfolder]')?.addEventListener('click', () => {
    void api.folderCreate('New folder', store.local.selectedFolderId);
  });
  root.querySelector('[data-organize]')?.addEventListener('click', () => openOrganize());

  root.querySelectorAll('[data-toggle]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (el).dataset.toggle;
      const f = store.folderById(/** @type {string} */ (id));
      if (f) void api.folderToggle(f.id, !f.collapsed);
    }));

  root.querySelectorAll('[data-open-folder]').forEach((el) =>
    el.addEventListener('click', () => {
      const id = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.openFolder);
      store.setLocal({ selectedFolderId: id });
      void api.tabShowGrid();
    }));

  root.querySelectorAll('[data-activate]').forEach((el) =>
    el.addEventListener('click', () => void api.tabActivate(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.activate))));
  root.querySelectorAll('[data-wake]').forEach((el) =>
    el.addEventListener('click', (e) => { e.stopPropagation(); void api.tabActivate(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.wake)); }));
  root.querySelectorAll('[data-sleep]').forEach((el) =>
    el.addEventListener('click', (e) => { e.stopPropagation(); void api.tabSleep(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.sleep)); }));
  root.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', (e) => { e.stopPropagation(); void api.tabClose(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.close)); }));

  // Inline rename
  const renameInput = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-rename]'));
  if (renameInput) {
    // Select-all only when the rename just started; when a re-render carried
    // over an in-progress rename, restoreFocusedField already focused it and
    // select-all would make the next keystroke wipe the user's text.
    if (document.activeElement !== renameInput) {
      renameInput.focus();
      renameInput.select();
    }
    const commit = () => {
      const id = /** @type {string} */ (renameInput.dataset.rename);
      const name = renameInput.value.trim();
      store.setLocal({ renamingId: null });
      if (name) void api.folderRename(id, name);
    };
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') store.setLocal({ renamingId: null });
    });
    // Only a real blur commits. Re-renders REMOVE the input, which also fires
    // blur (focus-fixup rule) — committing there would save a half-typed name
    // on every governor tick.
    renameInput.addEventListener('blur', () => { if (renameInput.isConnected) commit(); });
  }

  // Context menu
  root.querySelectorAll('.row').forEach((el) =>
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const me = /** @type {MouseEvent} */ (e);
      const h = /** @type {HTMLElement} */ (el);
      store.setLocal({
        ctxMenu: {
          x: me.clientX, y: me.clientY,
          nodeId: /** @type {string} */ (h.dataset.id),
          isFolder: h.dataset.kind === 'folder',
        },
      });
    }));

  wireDnd(root);
  wireImgFallbacks(root);
}
