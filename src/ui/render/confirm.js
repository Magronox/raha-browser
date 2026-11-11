// One question before an action that cannot be undone (0.3.3): Clear
// history, Delete folder, Clear site data. Rendered into its own slot
// (#confirm); one ask at a time.
//
// - The text names what is lost (built by the caller, rendered with esc()).
// - Cancel has the focus. Escape and the backdrop mean Cancel; Escape here
//   closes only this ask, not the panel behind it.
// - The affirmative button ignores clicks and keys for ARM_MS after it is
//   drawn, so a double click or a held Enter cannot answer it by accident.
// Clear all cookies & site data keeps its native dialog in main (ipc.js),
// which already asks with Cancel as the default.
import { api } from '../api.js';
import { store } from '../store.js';
import { esc } from './util.js';
import { hostOf } from '../../shared/rules.js';

export const ARM_MS = 500;

/** @type {HTMLElement|null} */ let root = null;
/** @type {((yes: boolean) => void)|null} */ let settle = null;
/** @type {Element|null} */ let returnFocus = null;
/** @type {(() => void)|null} */ let unwatch = null;
let escBound = false;

/** @param {HTMLElement} el */
export function initConfirm(el) {
  root = el;
  if (escBound) return;
  escBound = true;
  // Capture phase on window: runs before the document's Escape handler,
  // which would otherwise close the panel under this ask too.
  window.addEventListener('keydown', (e) => {
    if (!settle || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close(false);
  }, true);
}

/** @param {boolean} yes */
function close(yes) {
  const done = settle;
  settle = null;
  unwatch?.(); unwatch = null;
  const back = returnFocus;
  returnFocus = null;
  if (root) { root.innerHTML = ''; root.classList.remove('open'); }
  store.setLocal({ confirmOpen: false });
  // Focus goes back where it was. A panel that re-rendered behind the
  // question has replaced the button with a twin: find it by its id or
  // data- attribute. Nothing found, nothing focused.
  const target = back?.isConnected ? back : twinOf(back);
  if (target instanceof HTMLElement) target.focus();
  done?.(yes);
}

/** @param {Element|null} el @returns {Element|null} */
function twinOf(el) {
  if (!el) return null;
  if (el.id) return document.getElementById(el.id);
  const a = Array.from(el.attributes).find((x) => x.name.startsWith('data-'));
  if (!a) return null;
  const found = document.querySelectorAll(`${el.tagName}[${a.name}="${window.CSS.escape(a.value)}"]`);
  return found.length === 1 ? found[0] : null;
}

/**
 * @param {{ title: string, body: string, yes: string, stillValid?: () => boolean }} q
 *   plain text; stillValid, if given, is checked on every store change while
 *   the question is open and again on a yes: once it is false (the tab or
 *   folder went away, or now names something else) the question closes as Cancel.
 * @returns {Promise<boolean>} true only for the affirmative button
 */
export function askConfirm(q) {
  if (!root) return Promise.resolve(false);
  if (settle) close(false); // a newer ask replaces the old one, which is refused
  if (q.stillValid && !q.stillValid()) return Promise.resolve(false);
  const el = root;
  const prev = document.activeElement;
  returnFocus = prev && !el.contains(prev) ? prev : null;
  el.classList.add('open');
  el.innerHTML = `
    <div class="modal-backdrop" data-confirm-no></div>
    <div class="modal mini" role="alertdialog" aria-label="${esc(q.title)}">
      <h3>${esc(q.title)}</h3>
      <p class="mini-sub">${esc(q.body)}</p>
      <div class="mini-row">
        <button class="btn subtle" data-confirm-no>Cancel</button>
        <button class="btn danger" data-confirm-yes>${esc(q.yes)}</button>
      </div>
    </div>`;
  const armedAt = window.performance.now() + ARM_MS;
  const yes = /** @type {HTMLButtonElement} */ (el.querySelector('[data-confirm-yes]'));
  yes.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && window.performance.now() < armedAt) e.preventDefault();
  });
  yes.addEventListener('click', (e) => {
    if (window.performance.now() < armedAt) { e.preventDefault(); return; }
    close(q.stillValid ? q.stillValid() : true);
  });
  el.querySelectorAll('[data-confirm-no]').forEach((b) => b.addEventListener('click', () => close(false)));
  /** @type {HTMLButtonElement|null} */ (el.querySelector('button[data-confirm-no]'))?.focus();
  return new Promise((resolve) => {
    settle = resolve;
    store.setLocal({ confirmOpen: true });
    const check = q.stillValid;
    if (check) unwatch = store.subscribe(() => { if (settle === resolve && !check()) close(false); });
  });
}

/**
 * Clear site data for one host, after asking: the tab menu's route and the
 * page's own right-click route (evt:askClearSiteData) share these words.
 * @param {string} host @param {string|null} tabId reloaded after, if running
 * @param {boolean} reload
 */
export function confirmClearSiteData(host, tabId, reload) {
  // A page's question goes with its tab: closed, or moved to another site.
  const stillValid = tabId ? () => {
    const t = store.tabById(tabId);
    return Boolean(t && hostOf(t.url) === host);
  } : undefined;
  return askConfirm({
    title: `Clear site data for ${host}?`,
    body: 'Its cookies and storage, and its subdomains\', are deleted. You will be signed out of it. This cannot be undone.',
    yes: 'Clear site data',
    stillValid,
  }).then((yes) => yes && api.siteDataClear(host)).then((done) => {
    // A running tab shows the effect immediately; a sleeping one wakes clean.
    if (done && tabId && reload) void api.navReload(tabId);
  });
}
