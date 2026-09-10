// Overlays: toasts, the context menu, the memory-limit mini-prompt, and the
// consent asks (default browser, app links, site permissions).
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, captureFocusedField, restoreFocusedField } from './util.js';
import { hostOf } from '../../shared/rules.js';
import { permissionAskTitle } from '../../shared/permissions.js';

/** @type {HTMLElement} */ let toastRoot;
/** @type {HTMLElement} */ let ctxRoot;
/** @type {HTMLElement} */ let promptRoot;
/** @type {HTMLElement} */ let runawayRoot;

export function initOverlays(/** @type {HTMLElement} */ toasts, /** @type {HTMLElement} */ ctx, /** @type {HTMLElement} */ prompt, /** @type {HTMLElement} */ runaway) {
  toastRoot = toasts;
  ctxRoot = ctx;
  promptRoot = prompt;
  runawayRoot = runaway;
  document.addEventListener('click', () => {
    if (store.local.ctxMenu) store.setLocal({ ctxMenu: null });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Escape snoozes the runaway alert ONLY when it is the sole thing open.
      // An Escape aimed at a rename/modal must never silently quiet a
      // resource warning for five minutes as a side effect.
      const l = store.local;
      const somethingElseOpen = Boolean(
        l.ctxMenu || l.settingsOpen || l.historyOpen || l.organizeOpen || l.limitPromptId || l.renamingId || l.externalAsk || l.permissionAsk,
      );
      const alert = store.snap?.runaway;
      if (alert && !somethingElseOpen) void api.runawayResolve(alert.tabId, 'snooze');
      // The app-link ask has engine-side pending state — Escape must decline
      // it there too, or the next confirm click would hit a live request.
      if (l.externalAsk) void api.externalDismiss(l.externalAsk.id);
      // Same for a site-permission ask: Escape = "Not now" (refused for this
      // request, nothing remembered); the engine then shows the next one.
      if (l.permissionAsk) void api.permissionAnswer(l.permissionAsk.id, 'dismiss');
      store.setLocal({ ctxMenu: null, settingsOpen: false, historyOpen: false, organizeOpen: false, limitPromptId: null, renamingId: null, externalAsk: null, permissionAsk: null });
    }
  });
}

/** @param {{ kind: string, text: string }} t */
export function showToast(t) {
  const el = document.createElement('div');
  el.className = `toast toast-${t.kind}`;
  el.innerHTML = `${t.kind === 'sleep' ? icons.moon : t.kind === 'download' ? icons.forward : t.kind === 'warn' ? icons.shield : icons.bird}<span>${esc(t.text)}</span>`;
  toastRoot.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

export function renderCtxMenu() {
  const m = store.local.ctxMenu;
  if (!m) { ctxRoot.innerHTML = ''; return; }
  const isRoot = m.nodeId === store.snap?.rootId;
  const tab = m.isFolder ? null : store.tabById(m.nodeId);

  /** @type {Array<{ label: string, act: string, danger?: boolean }|null>} */
  const items = m.isFolder
    ? [
        { label: 'New tab here', act: 'newtab' },
        { label: 'New subfolder', act: 'newfolder' },
        isRoot ? null : { label: 'Rename', act: 'rename' },
        { label: 'Sleep all tabs inside', act: 'sleepall' },
        isRoot ? null : { label: 'Delete folder (and tabs)', act: 'delete', danger: true },
      ]
    : [
        tab?.state === 'asleep' ? { label: 'Wake', act: 'wake' } : { label: 'Sleep now', act: 'sleep' },
        { label: tab?.keepAlive ? 'Unpin (allow auto-sleep)' : 'Keep alive (pin)', act: 'pin' },
        { label: tab?.memLimitMB ? `Memory limit: ${tab.memLimitMB} MB…` : 'Set memory limit…', act: 'limit' },
        tab && hostOf(tab.url) ? { label: 'Clear cookies & data for this site', act: 'clearsitedata' } : null,
        { label: 'Close tab', act: 'delete', danger: true },
      ];

  ctxRoot.innerHTML = `
    <div class="ctxmenu">
      ${items.filter(Boolean).map((i) => `<button class="ctx-item ${i && i.danger ? 'danger' : ''}" data-ctx="${i?.act}">${esc(i?.label ?? '')}</button>`).join('')}
    </div>`;
  // Position via CSSOM — the page CSP (style-src 'self') blocks style="" attributes.
  const menuEl = /** @type {HTMLElement|null} */ (ctxRoot.querySelector('.ctxmenu'));
  if (menuEl) {
    menuEl.style.left = `${m.x}px`;
    menuEl.style.top = `${m.y}px`;
  }

  ctxRoot.querySelectorAll('[data-ctx]').forEach((el) =>
    el.addEventListener('click', () => {
      const act = /** @type {HTMLElement} */ (el).dataset.ctx;
      const id = m.nodeId;
      store.setLocal({ ctxMenu: null });
      if (act === 'newtab') { store.setLocal({ selectedFolderId: id }); void api.tabShowGrid(); document.dispatchEvent(new CustomEvent('raha:focus-omnibox')); }
      else if (act === 'newfolder') void api.folderCreate('New folder', id);
      else if (act === 'rename') store.setLocal({ renamingId: id });
      else if (act === 'sleepall') void api.folderSleepAll(id);
      else if (act === 'delete') void api.nodeRemove(id);
      else if (act === 'wake') void api.tabActivate(id);
      else if (act === 'sleep') void api.tabSleep(id);
      else if (act === 'pin') { const t = store.tabById(id); if (t) void api.tabSetKeepAlive(id, !t.keepAlive); }
      else if (act === 'limit') store.setLocal({ limitPromptId: id });
      else if (act === 'clearsitedata') {
        const t = store.tabById(id);
        const host = t ? hostOf(t.url) : null;
        if (host) {
          void api.siteDataClear(host).then(() => {
            // A running tab shows the effect immediately; a sleeping one
            // simply wakes clean later.
            if (t && t.state !== 'asleep') void api.navReload(id);
          });
        }
      }
    }));
}

/**
 * The runaway-tab prompt. Engine-driven: it exists exactly while
 * snapshot.runaway is set, so it survives re-renders and disappears on its
 * own if the tab calms down, sleeps, or crashes. Both buttons answer
 * through runaway:resolve; there is no local open/closed state to desync.
 */
/** One-time first-launch ask. The OS is only touched after a YES here —
 * consent comes from Raha, not from a surprise system dialog (and on
 * Windows/Linux there IS no system dialog; calling the API unprompted
 * would silently force the change). */
function renderDefaultBrowserAsk() {
  if (promptRoot.querySelector('[data-db-yes]')) return; // already rendered
  promptRoot.classList.add('open');
  promptRoot.innerHTML = `
    <div class="modal-backdrop" data-db-no></div>
    <div class="modal mini" role="dialog" aria-label="Default browser">
      <h3>Make Raha your default browser?</h3>
      <p class="mini-sub">Links from other apps would open here. ${navigator.platform.startsWith('Mac') ? 'macOS will ask you to confirm.' : ''} You can change this anytime in Settings.</p>
      <div class="mini-row">
        <button class="btn" data-db-yes>Make default</button>
        <button class="btn subtle" data-db-no>Not now</button>
      </div>
    </div>`;
  promptRoot.querySelector('[data-db-yes]')?.addEventListener('click', () => {
    store.setLocal({ defaultBrowserAsk: false });
    void api.defaultBrowserSet();
  });
  promptRoot.querySelectorAll('[data-db-no]').forEach((el) =>
    el.addEventListener('click', () => store.setLocal({ defaultBrowserAsk: false })));
}

/**
 * "Open this in Zoom?" — a page asked to hand a link to another app. The OS
 * is touched only if the user says yes here (ADR-0011). The URL is shown in
 * full: it is page-controlled, so it goes through esc() and is never trusted
 * as markup.
 */
function renderExternalAsk() {
  const ask = store.local.externalAsk;
  if (!ask) return;
  // Re-render when a NEWER ask replaced the one on screen: the engine only
  // honors the latest id, so leaving an old URL visible would let the user
  // approve one thing while meaning another (the bait-and-switch the id
  // exists to kill). Same id -> keep the DOM (checkbox state, focus).
  const open = /** @type {HTMLElement|null} */ (promptRoot.querySelector('[data-ext-open]'));
  if (open && Number(open.dataset.extId) === ask.id) return;
  promptRoot.classList.add('open');
  promptRoot.innerHTML = `
    <div class="modal-backdrop" data-ext-cancel></div>
    <div class="modal mini" role="dialog" aria-label="Open in another app">
      <h3>Open this link in ${esc(ask.app)}?</h3>
      <p class="mini-sub">A page wants to hand this link to another app on your computer. Raha will not open it unless you say so.</p>
      <p class="ext-url">${esc(ask.url)}</p>
      <label class="ext-remember"><input type="checkbox" data-ext-remember> Always open <code>${esc(ask.scheme ?? '')}</code> links without asking</label>
      <div class="mini-row">
        <button class="btn" data-ext-open data-ext-id="${Number(ask.id)}">Open</button>
        <button class="btn subtle" data-ext-cancel>Cancel</button>
      </div>
    </div>`;
  promptRoot.querySelector('[data-ext-open]')?.addEventListener('click', () => {
    const remember = /** @type {HTMLInputElement|null} */ (promptRoot.querySelector('[data-ext-remember]'))?.checked;
    store.setLocal({ externalAsk: null });
    void api.externalOpen(ask.id, Boolean(remember));
  });
  promptRoot.querySelectorAll('[data-ext-cancel]').forEach((el) =>
    el.addEventListener('click', () => {
      store.setLocal({ externalAsk: null });
      void api.externalDismiss(ask.id);
    }));
}

/**
 * "meet.example wants to use your camera and microphone" — a page asked
 * for something sensitive (R-103, ADR-0013). Shown only for the tab on
 * screen (the engine withdraws it when that tab leaves). Allow once /
 * Always allow / Never for this site / Not now; Escape and the backdrop
 * are Not now. Host strings are page-controlled: esc() everywhere.
 */
function renderPermissionAsk() {
  const ask = store.local.permissionAsk;
  if (!ask) return;
  // Keyed on the id like the app-link ask: a NEWER ask re-renders, so a
  // click can never land on text that described a different request.
  const open = /** @type {HTMLElement|null} */ (promptRoot.querySelector('[data-perm-id]'));
  if (open && Number(open.dataset.permId) === ask.id) return;
  promptRoot.classList.add('open');
  const frameLine = ask.isMainFrame
    ? ''
    : `<p class="mini-sub perm-frame">Asked by an embedded frame from ${esc(ask.requestingHost || 'another site')}.</p>`;
  promptRoot.innerHTML = `
    <div class="modal-backdrop" data-perm-dismiss></div>
    <div class="modal mini" role="dialog" aria-label="Site permission" data-perm-id="${Number(ask.id)}">
      <h3 class="perm-title">${esc(permissionAskTitle(ask.host, ask.kinds))}</h3>
      ${frameLine}
      <p class="mini-sub">Raha asks before a site gets anything sensitive. <b>Always allow</b> and <b>Never</b> are remembered for this site (change your mind in Settings → Site permissions); <b>Allow once</b> lasts until you leave the page.</p>
      <div class="mini-row perm-row-btns">
        <button class="btn" data-perm="once">Allow once</button>
        <button class="btn" data-perm="always">Always allow</button>
        <button class="btn subtle" data-perm="never">Never for this site</button>
        <button class="btn subtle perm-later" data-perm-dismiss>Not now</button>
      </div>
    </div>`;
  promptRoot.querySelectorAll('[data-perm]').forEach((el) =>
    el.addEventListener('click', () => {
      const decision = /** @type {'once'|'always'|'never'} */ (/** @type {HTMLElement} */ (el).dataset.perm);
      store.setLocal({ permissionAsk: null });
      void api.permissionAnswer(ask.id, decision);
    }));
  promptRoot.querySelectorAll('[data-perm-dismiss]').forEach((el) =>
    el.addEventListener('click', () => {
      store.setLocal({ permissionAsk: null });
      void api.permissionAnswer(ask.id, 'dismiss');
    }));
}

export function renderRunaway() {
  const alert = store.snap?.runaway ?? null;
  const tab = alert ? store.tabById(alert.tabId) : null;
  if (!alert || !tab) {
    runawayRoot.innerHTML = '';
    runawayRoot.classList.remove('open');
    return;
  }
  runawayRoot.classList.add('open');
  const detail = alert.kind === 'cpu'
    ? `It has been burning ~${Math.round(tab.cpuPct ?? 0)}% CPU for the last several seconds.`
    : `It is holding ${tab.memMB ?? '?'} MB of memory.`;
  runawayRoot.innerHTML = `
    <div class="modal-backdrop" data-runaway-snooze></div>
    <div class="modal mini runaway" role="alertdialog" aria-label="Runaway tab">
      <h3>${icons.shield}<span>“${esc(tab.title || tab.url)}” is running away</span></h3>
      <p class="mini-sub">${esc(detail)} Terminate it? The process is killed immediately — the page, its history and its place in your sidebar all survive, asleep.</p>
      <div class="mini-row">
        <button class="btn danger" data-runaway-kill>Terminate now</button>
        <button class="btn subtle" data-runaway-snooze>Not now (5 min)</button>
      </div>
    </div>`;
  runawayRoot.querySelector('[data-runaway-kill]')?.addEventListener('click', () =>
    void api.runawayResolve(alert.tabId, 'sleep'));
  runawayRoot.querySelectorAll('[data-runaway-snooze]').forEach((el) =>
    el.addEventListener('click', () => void api.runawayResolve(alert.tabId, 'snooze')));
}

export function renderLimitPrompt() {
  const id = store.local.limitPromptId;
  // App-link ask first: it answers a click the user JUST made. A site
  // permission ask next — it belongs to the page on screen.
  if (!id && store.local.externalAsk) return renderExternalAsk();
  if (!id && store.local.permissionAsk) return renderPermissionAsk();
  if (!id && store.local.defaultBrowserAsk) return renderDefaultBrowserAsk();
  if (!id) { promptRoot.innerHTML = ''; promptRoot.classList.remove('open'); return; }
  const tab = store.tabById(id);
  if (!tab) { store.setLocal({ limitPromptId: null }); return; }
  promptRoot.classList.add('open');
  const typing = captureFocusedField(promptRoot); // a limit value mid-edit
  promptRoot.innerHTML = `
    <div class="modal-backdrop" data-cancel></div>
    <div class="modal mini" role="dialog" aria-label="Memory limit">
      <h3>Memory limit for “${esc(tab.title)}”</h3>
      <p class="mini-sub">If this tab exceeds the limit it is put to sleep — even when pinned. Current: ${tab.memMB == null ? 'not sampled' : `${tab.memMB} MB`}.</p>
      <div class="mini-row">
        <input type="number" data-limit-val min="50" max="16384" step="50"
               value="${tab.memLimitMB ?? 500}" autofocus> MB
        <button class="btn" data-limit-save>Set</button>
        ${tab.memLimitMB ? '<button class="btn subtle" data-limit-clear>Remove limit</button>' : ''}
        <button class="btn subtle" data-cancel>Cancel</button>
      </div>
    </div>`;

  const commit = (/** @type {number|null} */ v) => {
    store.setLocal({ limitPromptId: null });
    void api.tabSetMemLimit(id, v);
  };
  promptRoot.querySelectorAll('[data-cancel]').forEach((el) =>
    el.addEventListener('click', () => store.setLocal({ limitPromptId: null })));
  promptRoot.querySelector('[data-limit-save]')?.addEventListener('click', () => {
    const v = Number(/** @type {HTMLInputElement} */ (promptRoot.querySelector('[data-limit-val]')).value);
    if (Number.isFinite(v) && v >= 50) commit(v);
  });
  promptRoot.querySelector('[data-limit-clear]')?.addEventListener('click', () => commit(null));
  restoreFocusedField(promptRoot, typing);
  const input = /** @type {HTMLInputElement|null} */ (promptRoot.querySelector('[data-limit-val]'));
  if (input && document.activeElement !== input) input.focus();
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = Number(input.value);
      if (Number.isFinite(v) && v >= 50) commit(v);
    }
  });
}
