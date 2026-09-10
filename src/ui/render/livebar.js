// Live bar: the always-visible strip of RUNNING tabs — the user's real-time
// answer to "what is spending my RAM and CPU right now?".
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, fmtMB, memClass, faviconHtml, wireImgFallbacks } from './util.js';

/** @type {HTMLElement} */ let root;

export function initLivebar(/** @type {HTMLElement} */ el) {
  root = el;
  render();
}

export function render() {
  const snap = store.snap;
  if (!snap) { root.innerHTML = ''; return; }
  const running = store.runningTabs();
  const over = snap.stats.runningCount > snap.stats.maxLiveTabs;

  const chips = running.map((t) => `
    <button class="chip ${t.state === 'active' ? 'active' : ''}" data-chip="${esc(t.id)}"
            title="${esc(t.title)}\n${fmtMB(t.memMB)}${t.memShared ? ' (shared process)' : ''} · CPU ${t.cpuPct ?? '—'}%${t.keepAliveEffective ? '\nKept alive' : ''}">
      <span class="fav">${faviconHtml(t)}</span>
      <span class="chip-title">${esc(t.title)}</span>
      ${t.audible ? `<span class="mini audio">${icons.audio}</span>` : ''}
      ${t.keepAliveEffective ? `<span class="mini pin">${icons.pin}</span>` : ''}
      <span class="membadge ${memClass(t.memMB)}">${t.memMB == null ? '…' : fmtMB(t.memMB)}${t.memShared ? '*' : ''}</span>
      <span class="mini act sleepbtn" data-chipsleep="${esc(t.id)}" title="Sleep now">${icons.moon}</span>
    </button>`).join('');

  root.innerHTML = `
    <span class="live-stats ${over ? 'over' : ''}"
          title="Running tabs / your cap. Total sampled memory of running tabs.${over ? '\nOver cap: pinned or audio tabs exceed the limit.' : ''}">
      <b>${snap.stats.runningCount}</b>/${snap.stats.maxLiveTabs} live · ${fmtMB(snap.stats.totalMemMB)}
    </span>
    <div class="chips">${chips || '<span class="live-empty">No tabs running — everything is asleep. RAM says thanks.</span>'}</div>
  `;

  root.querySelectorAll('[data-chip]').forEach((el) => {
    el.addEventListener('click', () => void api.tabActivate(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.chip)));
    // Same context menu as the sidebar rows — live chips ARE tabs.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const me = /** @type {MouseEvent} */ (e);
      store.setLocal({
        ctxMenu: {
          x: me.clientX,
          y: me.clientY,
          nodeId: /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.chip),
          isFolder: false,
        },
      });
    });
  });
  root.querySelectorAll('[data-chipsleep]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      void api.tabSleep(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.chipsleep));
    }));
  wireImgFallbacks(root);
}
