// Organize-tabs dialog: preview the plan from shared/organize.js, apply on
// confirm. The apply channel recomputes the plan in the engine — this dialog
// only shows what will happen, it cannot inject moves.
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, captureScrollTop, restoreScrollTop } from './util.js';

/** @type {HTMLElement} */ let root;
/** Snapshot identity the current preview was computed from. Apply recomputes
 * the plan engine-side; keeping the preview refreshed on every snapshot means
 * what the user confirms is what actually runs. */
/** @type {unknown} */ let planSnap = null;

export function initOrganize(/** @type {HTMLElement} */ el) {
  root = el;
  render();
}

/** Open the dialog and fetch a fresh preview. */
export function openOrganize() {
  store.setLocal({ organizeOpen: true, organizePlan: null });
  planSnap = store.snap;
  void fetchPreview();
}

async function fetchPreview() {
  const r = await api.organizePreview();
  if (store.local.organizeOpen) store.setLocal({ organizePlan: r });
}

export function render() {
  if (!store.local.organizeOpen || !store.snap) {
    root.innerHTML = '';
    root.classList.remove('open');
    return;
  }
  root.classList.add('open');
  if (store.snap !== planSnap) {
    // Tree changed under the open dialog (tab opened/closed, governor moved
    // something) — re-plan so the preview never drifts from what apply does.
    planSnap = store.snap;
    void fetchPreview();
  }
  const plan = store.local.organizePlan;

  const modalScroll = captureScrollTop(root, '.modal'); // mid-scroll tick must not jump to top
  root.innerHTML = `
    <div class="modal-backdrop" data-organize-cancel></div>
    <div class="modal organize" role="dialog" aria-label="Organize tabs">
      <div class="modal-head"><h2>Organize tabs</h2><button class="iconbtn" data-organize-cancel title="Close">${icons.close}</button></div>
      ${plan === null ? '<p class="mini-sub">Looking at your loose tabs…</p>' : renderPlan(plan)}
    </div>`;

  root.querySelectorAll('[data-organize-cancel]').forEach((el) =>
    el.addEventListener('click', () => store.setLocal({ organizeOpen: false })));
  root.querySelector('[data-organize-apply]')?.addEventListener('click', () => {
    store.setLocal({ organizeOpen: false });
    void api.organizeApply();
  });
  restoreScrollTop(root, '.modal', modalScroll);
}

/** @param {any} plan */
function renderPlan(plan) {
  const groups = Array.isArray(plan.groups) ? plan.groups : [];
  if (groups.length === 0) {
    return `<p class="mini-sub">${plan.loose === 0
      ? 'No loose tabs under “All tabs” — everything is already filed.'
      : `Your ${plan.loose === 1 ? 'loose tab doesn’t' : `${plan.loose} loose tabs don’t`} form any groups yet. Tabs are grouped by site category, or when 3+ share a domain.`}</p>`;
  }
  return `
    <p class="mini-sub">Only loose tabs under “All tabs” are filed — folders you made are never touched.</p>
    <div class="org-groups">
      ${groups.map((/** @type {any} */ g) => `
        <div class="org-group">
          <div class="org-head">${icons.folder}<b>${esc(g.name)}</b>${g.folderId ? '<span class="org-reuse">existing folder</span>' : ''}</div>
          ${g.tabs.map((/** @type {any} */ t) => `<div class="org-tab">${esc(t.title || '(untitled)')}</div>`).join('')}
        </div>`).join('')}
    </div>
    ${plan.leftover > 0 ? `<p class="mini-sub">${plan.leftover} ${plan.leftover === 1 ? 'tab stays' : 'tabs stay'} put (no clear group).</p>` : ''}
    <div class="mini-row">
      <button class="btn" data-organize-apply>Organize</button>
      <button class="btn subtle" data-organize-cancel>Cancel</button>
    </div>`;
}
