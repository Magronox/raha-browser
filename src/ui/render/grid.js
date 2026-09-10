// The grid: thumbnail cards for the selected folder's children. Visible when
// no tab is active (the content view is detached) — this IS the new-tab page.
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, fmtMB, memClass, shortUrl, faviconHtml, thumbUrl, wireImgFallbacks, MOD, captureScrollTop, restoreScrollTop } from './util.js';
import { wireGridDnd, isDragging } from '../dnd.js';

/** @type {HTMLElement} */ let root;
/** Last rendered markup — unchanged content skips the innerHTML swap. */
let lastHtml = '';

export function initGrid(/** @type {HTMLElement} */ el) {
  root = el;
  render();
}

export function render() {
  const snap = store.snap;
  if (!snap) { root.innerHTML = ''; lastHtml = ''; return; }
  if (isDragging()) return; // never yank the DOM mid-drag; dragend re-renders

  // When a tab is active the content view covers this area; skip the work.
  if (snap.activeTabId != null) { root.innerHTML = ''; lastHtml = ''; return; }

  const folderId = store.local.selectedFolderId;
  const crumbs = store.pathTo(folderId)
    .map((f, i, arr) => i === arr.length - 1
      ? `<b>${esc(f.id === snap.rootId ? 'All tabs' : f.name)}</b>`
      : `<a data-crumb="${esc(f.id)}">${esc(f.id === snap.rootId ? 'All tabs' : f.name)}</a>`)
    .join('<span class="crumb-sep">/</span>');

  const children = store.childrenOf(folderId);
  const cards = children.map((child) => {
    if (child.kind === 'folder') {
      const f = child.folder;
      const { tabs, running } = store.subtreeStats(f.id);
      return `
        <div class="card foldercard" draggable="true" data-openfolder="${esc(f.id)}" title="${esc(f.name)}">
          <div class="card-body folderbody">${icons.folderOpen}<span class="foldername">${esc(f.name)}</span></div>
          <div class="card-foot">
            <span class="card-title">${tabs} tab${tabs === 1 ? '' : 's'}${running ? ` · <b class="runhint">${running} live</b>` : ''}</span>
            <button class="mini act" data-sleepfolder="${esc(f.id)}" title="Sleep all tabs in this folder">${icons.moon}</button>
          </div>
        </div>`;
    }
    const t = child.tab;
    return `
      <div class="card tabcard state-${t.state}" draggable="true" data-opentab="${esc(t.id)}" title="${esc(t.title)}\n${esc(t.url)}">
        <div class="card-body">
          <img class="thumb" src="${thumbUrl(t)}" alt="" loading="lazy">
          <div class="thumb-fallback">${faviconHtml(t)}</div>
          <span class="state-chip ${t.state}">${t.state === 'asleep' ? icons.moon + ' asleep' : t.state === 'active' ? 'active' : icons.sun + ' running'}</span>
          ${t.keepAliveEffective ? `<span class="card-pin" title="Kept alive">${icons.pin}</span>` : ''}
          ${t.memMB != null ? `<span class="membadge ${memClass(t.memMB)}">${fmtMB(t.memMB)}</span>` : ''}
        </div>
        <div class="card-foot">
          <span class="fav">${faviconHtml(t)}</span>
          <span class="card-title">${esc(t.title)}</span>
          <span class="card-host">${esc(shortUrl(t.url))}</span>
          <span class="card-btns">
            ${t.state === 'asleep'
              ? `<button class="mini act" data-wake="${esc(t.id)}" title="Wake">${icons.sun}</button>`
              : `<button class="mini act" data-sleep="${esc(t.id)}" title="Sleep">${icons.moon}</button>`}
            <button class="mini act danger" data-close="${esc(t.id)}" title="Close">${icons.close}</button>
          </span>
        </div>
      </div>`;
  }).join('');

  const html = `
    <div class="grid-head">
      <span class="crumbs">${crumbs}</span>
      <span class="grid-actions">
        <button class="btn" data-newtabhere>${icons.plus} New tab here</button>
        <button class="btn" data-newfolderhere>${icons.folder} New folder</button>
        ${folderId !== snap.rootId ? `<button class="btn" data-sleepall>${icons.moon} Sleep all</button>` : ''}
      </span>
    </div>
    <div class="cards">
      ${cards || `<div class="empty-state">${icons.bird}<p>Nothing here yet.<br>Press <kbd>${MOD}+L</kbd> and go somewhere.</p></div>`}
    </div>
  `;
  // Identical content -> keep the existing DOM. An innerHTML swap recreates
  // every thumbnail/favicon <img>, and the missing ones (never-woken
  // imported tabs) each flash their fallback as the failures land — a
  // shimmer sweeping the grid on every governor tick.
  if (html === lastHtml) return;
  lastHtml = html;

  const gridScroll = captureScrollTop(root); // #content scrolls itself
  root.innerHTML = html;

  root.querySelectorAll('[data-crumb]').forEach((el) =>
    el.addEventListener('click', () => store.setLocal({ selectedFolderId: /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.crumb) })));
  root.querySelectorAll('[data-openfolder]').forEach((el) =>
    el.addEventListener('click', () => store.setLocal({ selectedFolderId: /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.openfolder) })));
  root.querySelectorAll('[data-opentab]').forEach((el) =>
    el.addEventListener('click', () => void api.tabActivate(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.opentab))));

  const stop = (/** @type {Event} */ e, /** @type {() => void} */ fn) => { e.stopPropagation(); fn(); };
  root.querySelectorAll('[data-wake]').forEach((el) =>
    el.addEventListener('click', (e) => stop(e, () => void api.tabActivate(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.wake)))));
  root.querySelectorAll('[data-sleep]').forEach((el) =>
    el.addEventListener('click', (e) => stop(e, () => void api.tabSleep(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.sleep)))));
  root.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', (e) => stop(e, () => void api.tabClose(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.close)))));
  root.querySelectorAll('[data-sleepfolder]').forEach((el) =>
    el.addEventListener('click', (e) => stop(e, () => void api.folderSleepAll(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.sleepfolder)))));
  root.querySelector('[data-newtabhere]')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('raha:focus-omnibox'));
  });
  root.querySelector('[data-newfolderhere]')?.addEventListener('click', () =>
    void api.folderCreate('New folder', folderId));
  root.querySelector('[data-sleepall]')?.addEventListener('click', () =>
    void api.folderSleepAll(folderId));
  wireGridDnd(root, folderId);
  wireImgFallbacks(root);
  restoreScrollTop(root, undefined, gridScroll);
}
