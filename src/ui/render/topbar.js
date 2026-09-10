// Topbar: navigation buttons, the omnibox, active-tab controls (pin, memory
// limit, per-site blocking shield), settings gear.
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, MOD } from './util.js';
import { displayUrl, resolveOmnibox, findTabByUrl } from '../../shared/urls.js';
import { hostOf } from '../../shared/rules.js';
import { isShieldOff } from '../../shared/blocking.js';
import { normalizeSiteHost } from '../../shared/validate.js';
import { openHistory } from './history.js';

/** @type {HTMLElement} */ let root;
let omniboxHasFocus = false;
let findHasFocus = false;
/** True while render() swaps the DOM. The swap fires blur on the focused
 * omnibox with the node STILL CONNECTED (measured — isConnected can't tell
 * a swap-blur from a real one), and that blur must not close the dropdown. */
let rerendering = false;

export function initTopbar(/** @type {HTMLElement} */ el) {
  root = el;
  render();
}

export function focusOmnibox() {
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('.omnibox'));
  if (input) { input.focus(); input.select(); }
}

export function focusFind() {
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('.findbox'));
  if (input) { input.focus(); input.select(); }
}

/** Last evt:findResult. Module state, NOT store state: a result must never
 * trigger a topbar re-render — replacing the focused findbox node aborts an
 * in-flight IME composition, which would fire on every CJK keystroke
 * (each keystroke's own result lands ~ms later). The count span is patched
 * in place instead.
 * @type {{ tabId: string, matches: number, activeMatchOrdinal: number }|null} */
let findResult = null;

/** @param {{ tabId: string, matches: number, activeMatchOrdinal: number }|null} r */
export function setFindResult(r) {
  findResult = r;
  const span = /** @type {HTMLElement|null} */ (root.querySelector('.findcount'));
  if (!span) return;
  const box = /** @type {HTMLInputElement|null} */ (root.querySelector('.findbox'));
  span.textContent = findCountText(r, box?.value ?? '');
  span.classList.toggle('none', r != null && r.matches === 0 && Boolean(box?.value));
}

/** @param {{ matches: number, activeMatchOrdinal: number }|null} r @param {string} needle */
function findCountText(r, needle) {
  if (!r || !needle) return '';
  return `${r.matches === 0 ? 0 : r.activeMatchOrdinal}/${r.matches}`;
}

// ---------------------------------------------------------------- omnibox
// suggestions (R-113 + R-106): LOCAL ONLY — open tabs matched from the
// snapshot + the on-disk history store via history:list. Never a network
// request. Module state patched into a static container, never a topbar
// re-render per keystroke (same IME lesson as the find bar).
//
// The dropdown opens with an ACTIONS block: what Enter will do with the text
// as typed, and the alternatives — open it in this tab (the default whenever
// a tab is showing), switch to a tab that already has the page, or open a
// new tab, naming the folder it would land in (the default on the grid). A
// new tab must never appear somewhere the user cannot see. Tab and history
// matches follow the block.

/**
 * @typedef {Object} Suggestion
 * @property {'action'|'tab'|'history'} kind
 * @property {'here'|'new'|'switch'} [mode]  action rows: the nav:omnibox mode they send
 * @property {string} [id]      tab rows: the tab to activate
 * @property {string} title     tab/history: page title; actions: the label ("Open here")
 * @property {string} url       tab/history: the page; 'here'/'new': the resolved URL; 'switch': the open tab's URL
 * @property {string} [detail]  'switch': the open tab's title
 */
/** @type {Suggestion[]} */ let suggestItems = [];
let suggestSel = -1;
/** Row Enter takes while the user has not moved the highlight (always an action row). */
let suggestDefault = -1;
/** The user moved the highlight with the arrows since the last keystroke. */
let suggestMoved = false;
let suggestOpen = false;
let suggestSeq = 0;

/** Overlay the modals need — the dropdown must not lower the chrome under one. */
function modalOverlayUp() {
  const l = store.local;
  return l.settingsOpen || l.historyOpen || l.organizeOpen
    || Boolean(l.limitPromptId) || l.defaultBrowserAsk || Boolean(l.externalAsk) || Boolean(l.permissionAsk) || Boolean(store.snap?.runaway);
}

function closeSuggest() {
  suggestSeq += 1; // invalidate any in-flight query
  if (!suggestOpen && suggestItems.length === 0) return;
  suggestItems = [];
  suggestSel = -1;
  suggestDefault = -1;
  suggestMoved = false;
  if (suggestOpen) {
    suggestOpen = false;
    // The dropdown hangs over the native page view; it needed the chrome
    // raised. Hand the flag back to whatever a modal needs right now.
    void api.overlaySet(modalOverlayUp());
  }
  renderSuggestList();
}

/** @param {Suggestion} a @param {Suggestion} b */
function sameRow(a, b) {
  return a.kind === b.kind && (a.kind === 'action' ? a.mode === b.mode : a.url === b.url);
}

/** @param {Suggestion[]} items @param {number} defaultSel index of the row Enter takes */
function setSuggest(items, defaultSel) {
  // A result landing between the user's ArrowDown and their Enter must not
  // silently drop the highlight: keep the row they chose if it's still here.
  // Otherwise the highlight sits on the default row, so what Enter will do
  // is visible before it is pressed.
  const chosen = suggestMoved && suggestSel >= 0 ? suggestItems[suggestSel] : undefined;
  suggestItems = items;
  suggestDefault = defaultSel;
  const kept = chosen ? items.findIndex((s) => sameRow(s, chosen)) : -1;
  suggestSel = kept >= 0 ? kept : defaultSel;
  if (items.length > 0 && !suggestOpen) {
    suggestOpen = true;
    void api.overlaySet(true);
  } else if (items.length === 0 && suggestOpen) {
    closeSuggest();
    return;
  }
  renderSuggestList();
}

/** Patch the dropdown container in place (no topbar re-render). */
function renderSuggestList() {
  const box = /** @type {HTMLElement|null} */ (root.querySelector('.omnisuggest'));
  if (!box) return;
  box.classList.toggle('open', suggestOpen && suggestItems.length > 0);
  box.innerHTML = suggestItems.map((s, i) => {
    const sel = i === suggestSel ? 'sel' : '';
    if (s.kind === 'action') {
      return `
    <div class="sug action ${sel}" data-sug="${i}" data-mode="${esc(s.mode)}">
      <span class="sug-act">${esc(s.title)}</span>
      ${s.detail ? `<span class="sug-title">${esc(s.detail)}</span>` : ''}
      <span class="sug-url">${esc(displayUrl(s.url))}</span>
      ${s.mode === 'new' ? `<span class="sug-key">${MOD}+Enter</span>` : ''}
    </div>`;
    }
    return `
    <div class="sug ${sel}" data-sug="${i}">
      <span class="sug-title">${esc(s.title || s.url)}</span>
      <span class="sug-url">${esc(displayUrl(s.url))}</span>
      ${s.kind === 'tab' ? '<span class="sug-tab">switch to tab</span>' : ''}
    </div>`;
  }).join('');
  // mousedown, not click: it fires before the omnibox blur can close us.
  box.querySelectorAll('[data-sug]').forEach((el) =>
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acceptSuggestion(Number(/** @type {HTMLElement} */ (el).dataset.sug));
    }));
}

/** @param {number} i */
function acceptSuggestion(i) {
  const s = suggestItems[i];
  if (!s) return;
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('.omnibox'));
  closeSuggest();
  if (s.kind === 'tab' && s.id) void api.tabActivate(s.id);
  else go(s.url, s.kind === 'action' ? s.mode : undefined);
  input?.blur();
}

/**
 * Hand text to the engine. No mode = its default: the showing tab, else a
 * new tab in the folder the grid shows (never a folder the user can't see).
 * @param {string} text @param {'here'|'new'|'switch'} [mode]
 */
function go(text, mode) {
  const active = store.snap?.activeTabId ?? null;
  void api.navOmnibox(text, active, active == null ? store.local.selectedFolderId : undefined, mode);
}

/**
 * The actions block for the text as typed: a pure function of store state,
 * no bridge call, so it is ready on the same keystroke.
 * @param {string} q
 * @returns {{ rows: Suggestion[], defaultSel: number }}
 */
function actionRows(q) {
  const snap = store.snap;
  const st = snap?.settings;
  const { url } = resolveOmnibox(q, {
    httpsFirst: st?.httpsFirst ?? true,
    searchEngine: st?.searchEngine ?? 'duckduckgo',
  });
  const active = store.activeTab();
  /** @type {Suggestion[]} */
  const rows = [];
  if (active) rows.push({ kind: 'action', mode: 'here', title: 'Open here', url });
  // An OFFER, never the default: the tab that already has this page.
  const other = findTabByUrl((snap?.tabs ?? []).filter((t) => t.id !== active?.id), url);
  if (other) rows.push({ kind: 'action', mode: 'switch', title: 'Switch to open tab', url: other.url, detail: other.title });
  // Where a new tab would land: beside the showing tab, else the folder the
  // grid shows — named, so it is never a surprise.
  const f = store.folderById(active ? active.parentId : store.local.selectedFolderId);
  const folderName = f && f.id !== snap?.rootId ? f.name : 'All tabs';
  rows.push({ kind: 'action', mode: 'new', title: `Open in new tab → ${folderName}`, url });
  return { rows, defaultSel: active ? 0 : rows.length - 1 };
}

/** @param {HTMLInputElement} input */
async function updateSuggestions(input) {
  const q = input.value.trim();
  const seq = ++suggestSeq;
  suggestMoved = false; // fresh text: the highlight returns to the default row
  if (!q) { closeSuggest(); return; }
  const ql = q.toLowerCase();
  const snap = store.snap;
  const actions = actionRows(q);
  /** @type {Suggestion[]} */
  const tabs = (snap?.tabs ?? [])
    .filter((t) => t.id !== snap?.activeTabId
      && (t.title.toLowerCase().includes(ql) || t.url.toLowerCase().includes(ql)))
    .slice(0, 3)
    .map((t) => ({ kind: /** @type {const} */ ('tab'), id: t.id, title: t.title, url: t.url }));
  /** @type {Suggestion[]} */
  let hist = [];
  try {
    // suggest=true: engine ranks by visit count then recency over ALL
    // matches — client-side sorting of a recency slice starved frequent pages.
    const r = /** @type {{ entries?: import('../../shared/history.js').HistoryEntry[] }} */ (
      await api.historyList({ query: q, limit: 8, suggest: true }));
    hist = (r?.entries ?? []).map((e) => ({ kind: /** @type {const} */ ('history'), title: e.title, url: e.url }));
  } catch { /* bridge hiccup — tabs-only suggestions are still useful */ }
  if (seq !== suggestSeq) return; // user typed on / closed meanwhile
  const seen = new Set(tabs.map((t) => t.url));
  const pages = [...tabs, ...hist.filter((h) => !seen.has(h.url))].slice(0, 6);
  setSuggest([...actions.rows, ...pages], actions.defaultSel);
}

/** Close the find bar: clear highlights, hand focus back to the page. */
export function closeFind() {
  const t = store.activeTab();
  if (t) void api.findStop(t.id);
  findResult = null;
  store.setLocal({ findOpen: false });
  if (t) void api.tabActivate(t.id); // already active -> just refocuses the view
}

export function render() {
  const t = store.activeTab();
  // Re-rendering replaces the input node, which would steal focus mid-word
  // whenever a governor tick lands — so carry the user's text and restore
  // focus + caret onto the new node below. Everything must be captured BEFORE
  // the innerHTML swap: removing a focused element fires blur synchronously
  // (the spec's focus-fixup rule), which resets omniboxHasFocus.
  const prev = /** @type {HTMLInputElement|null} */ (root.querySelector('.omnibox'));
  const hadFocus = omniboxHasFocus;
  const omniboxValue = hadFocus
    ? prev?.value ?? ''
    : t ? displayUrl(t.url) : '';
  const caretStart = prev?.selectionStart ?? null;
  const caretEnd = prev?.selectionEnd ?? null;

  // Find bar (R-101): same carry-across-the-swap treatment as the omnibox.
  const findOpen = store.local.findOpen && t != null;
  const prevFind = /** @type {HTMLInputElement|null} */ (root.querySelector('.findbox'));
  const hadFindFocus = findHasFocus;
  const findValue = prevFind?.value ?? '';
  const findCaretStart = prevFind?.selectionStart ?? null;
  const findCaretEnd = prevFind?.selectionEnd ?? null;
  const fr = findResult && findResult.tabId === t?.id ? findResult : null;
  const findCount = findOpen ? findCountText(fr, findValue) : '';

  // Per-site blocking shield (R-102): a real button with three states.
  // `host` is page-controlled — every interpolation goes through esc().
  const s = store.snap?.settings ?? null;
  const host = t ? hostOf(t.url) : null;
  const globalOn = Boolean(s && (s.blockAds || s.blockTrackers));
  const siteOff = Boolean(host && s && isShieldOff(host, s.noBlockHosts));
  const shieldState = !globalOn || !host ? 'dim' : siteOff ? 'off' : 'on';
  const shieldTip = !globalOn
    ? 'Ad & tracker blocking is off in Settings — click to open Settings'
    : !host
      ? 'Nothing to block on this page'
      : siteOff
        ? `Blocking is off for ${host} — click to re-enable and reload`
        : `${t?.blockedCount ?? 0} requests blocked on this tab — click to turn blocking off for ${host}`;

  rerendering = true;
  root.innerHTML = `
    <button class="iconbtn" data-act="togglesidebar" title="${store.local.sidebarHidden ? 'Show' : 'Hide'} sidebar (${MOD}+Shift+B)">${icons.sidebar}</button>
    <button class="iconbtn" data-act="back" title="Back (Alt+Left)" ${t?.canGoBack ? '' : 'disabled'}>${icons.back}</button>
    <button class="iconbtn" data-act="forward" title="Forward (Alt+Right)" ${t?.canGoForward ? '' : 'disabled'}>${icons.forward}</button>
    <button class="iconbtn" data-act="reload" title="${t?.loading ? 'Stop' : `Reload (${MOD}+R)`}" ${t ? '' : 'disabled'}>${t?.loading ? icons.stop : icons.reload}</button>
    <div class="omniwrap">
      <input class="omnibox" type="text" spellcheck="false" autocomplete="off"
        placeholder="Search with DuckDuckGo or type a URL — ${MOD}+L"
        value="${esc(omniboxValue)}">
      ${t ? `<button class="shieldbtn ${shieldState}" data-act="shield" title="${esc(shieldTip)}" aria-label="${esc(shieldTip)}" ${globalOn && !host ? 'disabled' : ''}>${icons.shield}${shieldState === 'on' && t.blockedCount > 0 ? `<b>${t.blockedCount}</b>` : ''}</button>` : ''}
      <div class="omnisuggest" role="listbox" aria-label="Suggestions"></div>
    </div>
    ${findOpen ? `
      <span class="findwrap">
        <input class="findbox" type="text" spellcheck="false" autocomplete="off" maxlength="200"
          placeholder="Find in page" value="${esc(findValue)}" aria-label="Find in page">
        <span class="findcount ${fr && fr.matches === 0 && findValue ? 'none' : ''}">${esc(findCount)}</span>
        <button class="iconbtn mini-find" data-act="findprev" title="Previous match (Shift+Enter)"><span class="rot-up">${icons.chevron}</span></button>
        <button class="iconbtn mini-find" data-act="findnext" title="Next match (Enter)"><span class="rot-down">${icons.chevron}</span></button>
        <button class="iconbtn mini-find" data-act="findclose" title="Close (Esc)">${icons.close}</button>
      </span>
    ` : ''}
    ${t ? `
      <button class="iconbtn ${t.keepAlive ? 'on' : ''}" data-act="pin" title="${t.keepAlive ? 'Unpin: allow auto-sleep' : `Keep alive: never auto-sleep (${MOD}+Shift+K)`}">${icons.pin}</button>
      <button class="iconbtn ${t.memLimitMB ? 'on' : ''}" data-act="limit" title="${t.memLimitMB ? `Memory limit: ${t.memLimitMB} MB — click to change` : 'Set a memory limit for this tab'}">${icons.gauge}</button>
      <button class="iconbtn" data-act="sleep" title="Sleep this tab (${MOD}+Shift+S)">${icons.moon}</button>
    ` : ''}
    <button class="iconbtn" data-act="grid" title="Grid / Home (${MOD}+E)">${icons.grid}</button>
    <button class="iconbtn" data-act="history" title="History">${icons.clock}</button>
    <button class="iconbtn" data-act="settings" title="Settings (${MOD}+,)">${icons.gear}</button>
  `;

  const input = /** @type {HTMLInputElement} */ (root.querySelector('.omnibox'));
  input.addEventListener('focus', () => { omniboxHasFocus = true; input.select(); });
  input.addEventListener('blur', () => {
    omniboxHasFocus = false;
    // Only a REAL blur (user left the omnibox) closes the dropdown — the
    // blur fired by render()'s own DOM swap must not (see `rerendering`).
    if (!rerendering) closeSuggest();
  });
  if (hadFocus) {
    input.focus(); // fires the select-all above...
    if (caretStart !== null && caretEnd !== null) {
      input.setSelectionRange(caretStart, caretEnd); // ...then put the caret back
    }
  }
  input.addEventListener('input', () => { void updateSuggestions(input); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // IME commit keys are not navigation
    // ⌘/Ctrl+Enter = a new tab, whatever the dropdown highlights.
    const modEnter = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
    if (suggestOpen && suggestItems.length > 0 && !modEnter) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggestItems.length;
        // From no selection, Down enters at the top, Up enters at the BOTTOM.
        suggestSel = suggestSel < 0
          ? (e.key === 'ArrowDown' ? 0 : n - 1)
          : (suggestSel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        suggestMoved = true;
        renderSuggestList();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault(); // fill the box, keep typing
        // Action rows ARE the typed text — nothing to fill from them: take
        // the highlighted page row, else the first page row.
        const cur = suggestItems[suggestSel];
        const s = cur && cur.kind !== 'action' ? cur : suggestItems.find((x) => x.kind !== 'action');
        if (s) { input.value = s.url; void updateSuggestions(input); }
        return;
      }
      if (e.key === 'Enter') {
        const i = suggestSel >= 0 ? suggestSel : suggestDefault;
        if (suggestItems[i]) { acceptSuggestion(i); return; }
      }
      if (e.key === 'Escape') {
        closeSuggest(); // first Esc: dropdown; a second falls through to blur
        return;
      }
    }
    if (e.key === 'Enter') {
      // Plain Enter with no dropdown = the engine's default (this tab; on the
      // grid a new tab in the folder being viewed, never at the root).
      go(input.value, modEnter ? 'new' : undefined);
      input.blur();
    } else if (e.key === 'Escape') {
      input.blur();
      render();
    }
  });

  const findbox = /** @type {HTMLInputElement|null} */ (root.querySelector('.findbox'));
  if (findbox) {
    findbox.addEventListener('focus', () => { findHasFocus = true; });
    findbox.addEventListener('blur', () => { findHasFocus = false; });
    if (hadFindFocus) {
      findbox.focus();
      if (findCaretStart !== null && findCaretEnd !== null) {
        findbox.setSelectionRange(findCaretStart, findCaretEnd);
      }
    }
    findbox.addEventListener('input', () => {
      const tab = store.activeTab();
      if (!tab) return;
      if (findbox.value) void api.findStart(tab.id, findbox.value, { newSession: true });
      else { void api.findStop(tab.id); setFindResult(null); }
    });
    findbox.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // an IME commit-Enter is not a "next match"
      const tab = store.activeTab();
      if (e.key === 'Enter' && tab && findbox.value) {
        void api.findStart(tab.id, findbox.value, { newSession: false, forward: !e.shiftKey });
      } else if (e.key === 'Escape') {
        closeFind();
      }
    });
  }

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = /** @type {HTMLElement} */ (btn).dataset.act;
      const tab = store.activeTab();
      if (act === 'togglesidebar') store.setLocal({ sidebarHidden: !store.local.sidebarHidden });
      else if (act === 'back' && tab) void api.navBack(tab.id);
      else if (act === 'forward' && tab) void api.navForward(tab.id);
      else if (act === 'reload' && tab) void (tab.loading ? api.navStop(tab.id) : api.navReload(tab.id));
      else if (act === 'pin' && tab) void api.tabSetKeepAlive(tab.id, !tab.keepAlive);
      else if (act === 'limit' && tab) store.setLocal({ limitPromptId: tab.id });
      else if (act === 'sleep' && tab) void api.tabSleep(tab.id);
      else if (act === 'shield' && tab) {
        const st = store.snap?.settings;
        if (!st) return;
        // Global blocking off: the shield can't do anything per-site — take
        // the user to the switches instead.
        if (!st.blockAds && !st.blockTrackers) { store.setLocal({ settingsOpen: true }); return; }
        const key = normalizeSiteHost(hostOf(tab.url));
        if (!key) return;
        const list = isShieldOff(key, st.noBlockHosts)
          ? st.noBlockHosts.filter((h) => !(key === h || key.endsWith('.' + h)))
          : [...st.noBlockHosts, key];
        // Blocking only affects FUTURE requests: reload so the click's
        // promise ("this site now works" / "blocking is back") is true.
        void api.settingsSet({ noBlockHosts: list }).then(() => api.navReload(tab.id));
      }
      else if (act === 'findprev' && tab) {
        const v = /** @type {HTMLInputElement|null} */ (root.querySelector('.findbox'))?.value;
        if (v) void api.findStart(tab.id, v, { newSession: false, forward: false });
      }
      else if (act === 'findnext' && tab) {
        const v = /** @type {HTMLInputElement|null} */ (root.querySelector('.findbox'))?.value;
        if (v) void api.findStart(tab.id, v, { newSession: false, forward: true });
      }
      else if (act === 'findclose') closeFind();
      else if (act === 'grid') void api.tabShowGrid();
      else if (act === 'history') openHistory();
      else if (act === 'settings') store.setLocal({ settingsOpen: true });
    });
  });

  // A tick re-render rebuilt the (empty) dropdown container — re-patch it
  // from module state so an open dropdown survives, like the inputs do.
  renderSuggestList();
  rerendering = false;
}
