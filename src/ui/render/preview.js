// Wake-preview hover (R-105): rest the pointer on an asleep or frozen tab in
// the sidebar and its stored thumbnail appears large — without waking it.
//
// The card lives INSIDE the sidebar's width on purpose. The chrome sits
// under the active page except where the sidebar is, so a card spilling
// over the content rect would render invisibly (or need the chrome raised,
// which hides the page — fine for a modal, wrong for a hover). Events are
// delegated on the sidebar root, so the sidebar's innerHTML re-renders
// never have to know about it.
import { store } from '../store.js';
import { esc, shortUrl, thumbUrl } from './util.js';

const HOVER_DELAY_MS = 400;
const PREVIEWABLE = new Set(['asleep', 'frozen']);

/** @type {HTMLElement} */ let card;
/** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
/** @type {string|null} */ let shownFor = null;

/** @param {HTMLElement} sidebar */
export function initPreview(sidebar) {
  card = document.createElement('div');
  card.id = 'preview';
  card.hidden = true;
  document.body.append(card);

  sidebar.addEventListener('mouseover', (e) => {
    const row = /** @type {HTMLElement|null} */ ((/** @type {Element} */ (e.target)).closest('.row.tab'));
    if (!row || row.dataset.id === shownFor) return;
    hide();
    const id = row.dataset.id ?? '';
    const tab = store.tabById(id);
    if (!tab || !PREVIEWABLE.has(tab.state)) return;
    timer = setTimeout(() => { timer = null; show(row, tab); }, HOVER_DELAY_MS);
  });
  sidebar.addEventListener('mouseout', (e) => {
    const to = /** @type {Element|null} */ (e.relatedTarget);
    const row = /** @type {HTMLElement|null} */ ((/** @type {Element} */ (e.target)).closest('.row.tab'));
    if (row && to && row.contains(to)) return; // moving within the same row
    hide();
  });
  // Anything that changes what the row means (click, drag, scroll, the tree
  // re-rendering under the pointer) ends the preview.
  for (const type of ['mousedown', 'dragstart', 'scroll', 'wheel']) sidebar.addEventListener(type, hide, { capture: true, passive: true });
  store.subscribe(() => { if (shownFor && store.tabById(shownFor)?.state !== (card.dataset.state ?? '')) hide(); });
}

/** @param {HTMLElement} row @param {import('../../shared/ipc-contract.js').SnapshotTab} tab */
function show(row, tab) {
  card.innerHTML = `
    <img class="thumb" src="${thumbUrl(tab)}" alt="">
    <div class="preview-meta">
      <div class="preview-title">${esc(tab.title || tab.url)}</div>
      <div class="preview-url">${esc(shortUrl(tab.url))} · ${tab.state === 'frozen' ? 'frozen' : 'asleep'} — click to ${tab.state === 'frozen' ? 'continue' : 'wake'}</div>
    </div>`;
  const img = /** @type {HTMLImageElement} */ (card.querySelector('img'));
  // No thumbnail yet (never shown, or captured before this profile had one):
  // nothing to preview — the title is already on the row.
  img.addEventListener('error', hide, { once: true });
  shownFor = tab.id;
  card.dataset.state = tab.state;
  card.hidden = false;
  place(row);
}

/** Below the row, clamped to the viewport; above it when there is no room. @param {HTMLElement} row */
function place(row) {
  const r = row.getBoundingClientRect();
  const h = card.offsetHeight || 200;
  const top = r.bottom + 4 + h <= window.innerHeight ? r.bottom + 4 : Math.max(4, r.top - 4 - h);
  card.style.top = `${top}px`;
}

export function hide() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!shownFor) return;
  shownFor = null;
  card.hidden = true;
  card.innerHTML = '';
}

/** Test seam: is a preview currently showing, and for which tab? */
export function previewShownFor() { return shownFor; }
