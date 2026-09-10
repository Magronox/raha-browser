// History panel: import browsing history from other browsers, search it,
// open an entry as a tab. Data is PULLED via api.historyList/historySources —
// the history store is far too large to ride along in snapshot pushes, so
// this panel fetches on open and after every change (see engine.historyList).
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, captureFocusedField, restoreFocusedField, captureScrollTop, restoreScrollTop } from './util.js';
import { displayUrl } from '../../shared/urls.js';

/** @type {HTMLElement} */ let root;
let fetchSeq = 0; // drops stale list responses when typing fast
let sourcesSeq = 0; // drops a stale scan when the panel is closed + reopened

/** Rows fetched per page. The store holds up to HISTORY_MAX (20 000)
 * entries, so the list pages instead of rendering everything: each "Show
 * more" appends the next page (engine.historyList takes an offset and
 * returns the full `total`). */
const PAGE = 200;

export function initHistory(/** @type {HTMLElement} */ el) {
  root = el;
  render();
}

/** Reset + open the panel, kick off both fetches. */
export function openHistory() {
  store.setLocal({
    historyOpen: true, historyQuery: '', historyData: null,
    historySources: null, historySel: {}, historyBusy: false, historyMoreBusy: false, historyReport: null,
    openTabSources: null, openTabsBusy: null, openTabsReport: null,
  });
  void refreshList();
  void loadSources();
  void loadOpenTabSources();
}

async function refreshList() {
  const seq = ++fetchSeq;
  const r = await api.historyList({ query: store.local.historyQuery, limit: PAGE, offset: 0 });
  if (seq === fetchSeq && store.local.historyOpen) store.setLocal({ historyData: r, historyMoreBusy: false });
}

/**
 * Append the next page. Guarded by the same fetchSeq as refreshList, so a
 * search typed (or an import finished) mid-flight wins and this response is
 * dropped rather than pasted onto a list it no longer belongs to. Entries
 * are unique by URL in the store, so a visit recorded between the two
 * requests can only shift rows across the page boundary — dedupe by URL
 * rather than showing the same page twice.
 */
async function loadMore() {
  const d = store.local.historyData;
  if (!d || store.local.historyMoreBusy || d.entries.length >= d.total) return;
  store.setLocal({ historyMoreBusy: true });
  const seq = ++fetchSeq;
  const r = /** @type {{ entries: import('../../shared/history.js').HistoryEntry[], total: number }} */ (
    await api.historyList({ query: store.local.historyQuery, limit: PAGE, offset: d.entries.length }));
  if (seq !== fetchSeq || !store.local.historyOpen) return; // a newer fetch owns the list
  const seen = new Set(d.entries.map((e) => e.url));
  const entries = [...d.entries, ...r.entries.filter((e) => !seen.has(e.url))];
  store.setLocal({ historyData: { entries, total: r.total }, historyMoreBusy: false });
}

async function loadSources() {
  const seq = ++sourcesSeq;
  const r = await api.historySources();
  if (seq !== sourcesSeq || !store.local.historyOpen) return; // a newer open owns the panel
  /** @type {Record<string, boolean>} */
  const sel = {};
  for (const s of r.sources) sel[s.id] = true;
  store.setLocal({ historySources: r.sources, historySel: sel });
}

async function runImport() {
  const ids = Object.entries(store.local.historySel).filter(([, on]) => on).map(([id]) => id);
  store.setLocal({ historyBusy: true, historyReport: null });
  const r = await api.historyImport(ids);
  store.setLocal({ historyBusy: false, historyReport: r });
  void refreshList();
}

async function runImportFile() {
  store.setLocal({ historyBusy: true, historyReport: null });
  const r = await api.historyImportFile();
  // A canceled picker is not a report-worthy event.
  store.setLocal({ historyBusy: false, historyReport: r && r.canceled ? null : r });
  void refreshList();
}

async function loadOpenTabSources() {
  const seq = sourcesSeq; // reuse the panel-generation guard from loadSources
  const r = await api.openTabsSources();
  if (seq !== sourcesSeq || !store.local.historyOpen) return;
  store.setLocal({ openTabSources: r.sources });
}

/** @param {string} sourceId */
async function runOpenTabsImport(sourceId) {
  store.setLocal({ openTabsBusy: sourceId, openTabsReport: null });
  const r = await api.openTabsImport(sourceId);
  store.setLocal({ openTabsBusy: null, openTabsReport: r });
}

export function render() {
  if (!store.local.historyOpen || !store.snap) {
    root.innerHTML = '';
    root.classList.remove('open');
    return;
  }
  root.classList.add('open');
  const typing = captureFocusedField(root); // search text mid-word survives governor ticks
  const modalScroll = captureScrollTop(root, '.modal'); // mid-scroll tick must not jump to top
  const d = store.local.historyData;
  const sources = store.local.historySources;
  const sel = store.local.historySel;
  const busy = store.local.historyBusy;
  const rep = store.local.historyReport;
  const tabSources = store.local.openTabSources;
  const tabsBusy = store.local.openTabsBusy;
  const tabsRep = store.local.openTabsReport;

  root.innerHTML = `
    <div class="modal-backdrop" data-close-history></div>
    <div class="modal history" role="dialog" aria-label="History">
      <div class="modal-head"><h2>History</h2><button class="iconbtn" data-close-history title="Close">${icons.close}</button></div>

      <h3>Import from another browser</h3>
      ${sources === null ? '<p class="mini-sub">Looking for other browsers…</p>'
    : sources.length === 0 ? '<p class="mini-sub">No importable browser profiles found on this machine.</p>'
    : `<div class="hist-srcs">
        ${sources.map((s) => `<label class="hist-src"><input type="checkbox" data-src="${esc(s.id)}" ${sel[s.id] ? 'checked' : ''}> <span>${esc(s.browser)} — ${esc(s.label)}</span></label>`).join('')}
       </div>
       <div class="mini-row">
         <button class="btn" data-import ${busy || Object.values(sel).every((v) => !v) ? 'disabled' : ''}>${busy ? 'Importing…' : 'Import history'}</button>
         <button class="btn subtle" data-import-file ${busy ? 'disabled' : ''} title="Pick a copied history database — e.g. Safari's History.db copied to your Desktop, if macOS blocks direct access">From a file…</button>
         <span class="mini-sub">History only — passwords, cookies and payment data are never read.</span>
       </div>`}
      ${renderReport(rep)}

      <h3>Open tabs &amp; windows</h3>
      ${tabSources === null ? '<p class="mini-sub">Looking for open browsers…</p>'
    : tabSources.length === 0 ? '<p class="mini-sub">No running browsers or saved sessions found.</p>'
    : `<div class="hist-srcs">
        ${tabSources.map((s) => `
          <div class="hist-src">
            <span>${esc(s.browser)} — ${esc(s.label)}</span>
            <button class="btn subtle" data-opentabs="${esc(s.id)}" ${tabsBusy ? 'disabled' : ''}>${tabsBusy === s.id ? 'Importing…' : 'Import'}</button>
          </div>`).join('')}
       </div>
       <p class="mini-sub">Copies every window and tab into a new folder — tabs arrive asleep, so nothing loads until you click it. For a running browser, macOS will ask once to let Raha read its tabs (Automation permission — not Full Disk Access). Firefox and Zen are read from their session file directly.</p>`}
      ${renderOpenTabsReport(tabsRep)}

      <h3>Browse</h3>
      <div class="mini-row">
        <input type="search" class="hist-search" data-hist-search spellcheck="false" autocomplete="off"
               placeholder="Search history" value="${esc(store.local.historyQuery)}">
        ${d && d.total > 0 ? '<button class="btn subtle" data-hist-clear>Clear all history</button>' : ''}
      </div>
      ${d === null ? '<p class="mini-sub">Loading…</p>'
    : d.total === 0 ? `<p class="mini-sub">${store.local.historyQuery ? 'Nothing matches.' : 'No history yet — import from another browser above.'}</p>`
    : `<div class="hist-list">
        ${d.entries.map((e) => `
          <button class="hist-row" data-url="${esc(e.url)}" title="${esc(e.url)}">
            <span class="hist-title">${esc(e.title || displayUrl(e.url))}</span>
            <span class="hist-meta">${esc(displayUrl(e.url))} · ${esc(fmtWhen(e.lastVisitMs))}${e.source ? ` · ${esc(e.source)}` : ''}</span>
          </button>`).join('')}
       </div>
       <div class="mini-row hist-more">
         <span class="mini-sub">Showing ${d.entries.length} of ${d.total}.</span>
         ${d.entries.length < d.total ? `<button class="btn subtle" data-hist-more ${store.local.historyMoreBusy ? 'disabled' : ''}>${store.local.historyMoreBusy ? 'Loading…' : `Show ${Math.min(PAGE, d.total - d.entries.length)} more`}</button>` : ''}
       </div>`}
    </div>`;

  root.querySelectorAll('[data-close-history]').forEach((el) =>
    el.addEventListener('click', () => store.setLocal({ historyOpen: false })));

  root.querySelectorAll('[data-src]').forEach((el) =>
    el.addEventListener('change', () => {
      const box = /** @type {HTMLInputElement} */ (el);
      store.setLocal({ historySel: { ...store.local.historySel, [box.dataset.src ?? '']: box.checked } });
    }));

  root.querySelector('[data-import]')?.addEventListener('click', () => void runImport());
  root.querySelector('[data-import-file]')?.addEventListener('click', () => void runImportFile());
  root.querySelectorAll('[data-opentabs]').forEach((el) =>
    el.addEventListener('click', () => {
      const id = /** @type {HTMLElement} */ (el).dataset.opentabs;
      if (id) void runOpenTabsImport(id);
    }));

  root.querySelector('[data-hist-clear]')?.addEventListener('click', () => {
    void api.historyClear().then(() => refreshList());
  });

  // Paging, not an infinite scroll: the modal's scroll position survives the
  // re-render (restoreScrollTop below), so the appended rows land under the
  // ones already on screen instead of jumping the list to the top.
  root.querySelector('[data-hist-more]')?.addEventListener('click', () => void loadMore());

  const search = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-hist-search]'));
  search?.addEventListener('input', () => {
    store.setLocal({ historyQuery: search.value });
    void refreshList();
  });

  root.querySelectorAll('.hist-row').forEach((el) =>
    el.addEventListener('click', () => {
      const url = /** @type {HTMLElement} */ (el).dataset.url;
      if (!url) return;
      store.setLocal({ historyOpen: false });
      void api.tabCreate({ url, activate: true });
    }));

  restoreFocusedField(root, typing);
  restoreScrollTop(root, '.modal', modalScroll);
}

/** @param {any} rep */
function renderOpenTabsReport(rep) {
  if (!rep) return '';
  if (rep.error) return `<p class="hist-report warn">${esc(String(rep.error))}</p>`;
  const problems = Array.isArray(rep.problems) ? rep.problems : [];
  const head = rep.tabs > 0
    ? `<p class="hist-report">Imported ${rep.tabs} ${rep.tabs === 1 ? 'tab' : 'tabs'} across ${rep.windows} ${rep.windows === 1 ? 'window' : 'windows'} — check the sidebar.</p>`
    : '';
  return head + problems.map((/** @type {string} */ p) => `<p class="hist-report warn">${esc(p)}</p>`).join('');
}

/** @param {any} rep */
function renderReport(rep) {
  if (!rep) return '';
  if (rep.error) return `<p class="hist-report warn">${esc(String(rep.error))}</p>`;
  const problems = Array.isArray(rep.problems) ? rep.problems : [];
  return `<p class="hist-report">Imported ${rep.added} new ${rep.added === 1 ? 'entry' : 'entries'} (${rep.total} total).</p>` +
    problems.map((/** @type {string} */ p) => `<p class="hist-report warn">${esc(p)}</p>`).join('');
}

/** @param {number} ms */
function fmtWhen(ms) {
  const d = new Date(ms);
  return Number.isFinite(ms) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}
