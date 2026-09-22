// Downloads panel (R-106): this session's downloads from the snapshot —
// progress, open, reveal, cancel, remove. Nothing here is persisted; the
// list is gone when Raha quits, on purpose.
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, shortUrl, captureScrollTop, restoreScrollTop } from './util.js';

/** @type {HTMLElement} */ let root;

export function initDownloads(/** @type {HTMLElement} */ el) {
  root = el;
  render();
}

export function openDownloads() {
  store.setLocal({ downloadsOpen: true });
}

/** @param {number} n bytes */
export function fmtBytes(n) {
  if (!(n > 0)) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** @param {import('../../shared/ipc-contract.js').DownloadView} d */
function statusLine(d) {
  const host = shortUrl(d.url);
  switch (d.state) {
    case 'progressing':
      return d.totalBytes > 0
        ? `${fmtBytes(d.receivedBytes)} of ${fmtBytes(d.totalBytes)} · ${host}`
        : `${fmtBytes(d.receivedBytes)} · ${host}`;
    case 'completed': return `${fmtBytes(d.totalBytes || d.receivedBytes)} · ${host}`;
    case 'cancelled': return `Cancelled · ${host}`;
    default: return `Failed · ${host}`;
  }
}

export function render() {
  if (!store.local.downloadsOpen || !store.snap) {
    root.innerHTML = '';
    root.classList.remove('open');
    return;
  }
  root.classList.add('open');
  const modalScroll = captureScrollTop(root, '.modal');
  const list = store.snap.downloads;
  const finished = list.filter((d) => d.state !== 'progressing').length;

  root.innerHTML = `
    <div class="modal-backdrop" data-close-downloads></div>
    <div class="modal downloads" role="dialog" aria-label="Downloads">
      <div class="modal-head"><h2>Downloads</h2><button class="iconbtn" data-close-downloads title="Close">${icons.close}</button></div>
      ${list.length === 0
    ? '<p class="mini-sub">Nothing downloaded this session. Files you download appear here until Raha quits — this list is never saved.</p>'
    : `<div class="dl-list">
        ${list.map((d) => `
          <div class="dl-row state-${d.state}" data-dl="${esc(d.id)}" title="${esc(d.url)}">
            <div class="dl-main">
              <span class="dl-name">${esc(d.filename)}</span>
              <span class="dl-meta">${esc(statusLine(d))}</span>
              ${d.state === 'progressing' ? `<progress class="dl-bar" ${d.totalBytes > 0 ? `max="${d.totalBytes}" value="${d.receivedBytes}"` : ''}></progress>` : ''}
            </div>
            <div class="dl-acts">
              ${d.state === 'progressing' ? `<button class="btn subtle" data-dl-act="cancel">Cancel</button>` : ''}
              ${d.state === 'completed' ? `<button class="btn" data-dl-act="open">Open</button><button class="btn subtle" data-dl-act="reveal">Show in folder</button>` : ''}
              ${d.state !== 'progressing' ? `<button class="iconbtn" data-dl-act="remove" title="Remove from list">${icons.close}</button>` : ''}
            </div>
          </div>`).join('')}
       </div>
       ${finished > 0 ? '<div class="mini-row"><button class="btn subtle" data-dl-clear>Clear finished</button><span class="mini-sub">Removes entries from this list only — files stay where they are.</span></div>' : ''}`}
    </div>`;

  restoreScrollTop(root, '.modal', modalScroll);

  root.querySelectorAll('[data-close-downloads]').forEach((el) =>
    el.addEventListener('click', () => store.setLocal({ downloadsOpen: false })));
  root.querySelector('[data-dl-clear]')?.addEventListener('click', () => void api.downloadAct('', 'clear'));
  root.querySelectorAll('[data-dl-act]').forEach((el) =>
    el.addEventListener('click', () => {
      const btn = /** @type {HTMLElement} */ (el);
      const id = /** @type {HTMLElement} */ (btn.closest('[data-dl]')).dataset.dl ?? '';
      void api.downloadAct(id, /** @type {'cancel'|'open'|'reveal'|'remove'} */ (btn.dataset.dlAct));
    }));
}
