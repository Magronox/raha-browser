// UI entrypoint: fetch the first snapshot, subscribe to pushes, wire the
// render modules to their DOM regions, route global UI events.
import { api } from './api.js';
import { store } from './store.js';
import { SIDEBAR_WIDTH, TOPBAR_HEIGHT, LIVEBAR_HEIGHT } from '../shared/layout.js';
import { initTopbar, render as renderTopbar, focusOmnibox, focusFind, setFindResult } from './render/topbar.js';
import { initSidebar, render as renderSidebar } from './render/sidebar.js';
import { initLivebar, render as renderLivebar } from './render/livebar.js';
import { initGrid, render as renderGrid } from './render/grid.js';
import { initSettings, render as renderSettings } from './render/settings.js';
import { initHistory, render as renderHistory, openHistory } from './render/history.js';
import { initOrganize, render as renderOrganize } from './render/organize.js';
import { initOverlays, showToast, renderCtxMenu, renderLimitPrompt, renderRunaway } from './render/overlays.js';

function mustGet(/** @type {string} */ id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

async function main() {
  // Mirror layout constants into CSS so main-process view placement and CSS
  // regions can never drift apart.
  const cssRoot = document.documentElement;
  cssRoot.style.setProperty('--sidebar-w', `${SIDEBAR_WIDTH}px`);
  cssRoot.style.setProperty('--topbar-h', `${TOPBAR_HEIGHT}px`);
  cssRoot.style.setProperty('--livebar-h', `${LIVEBAR_HEIGHT}px`);

  initTopbar(mustGet('topbar'));
  initSidebar(mustGet('sidebar'));
  initLivebar(mustGet('livebar'));
  initGrid(mustGet('content'));
  initSettings(mustGet('settings'));
  initHistory(mustGet('history'));
  initOrganize(mustGet('organize'));
  initOverlays(mustGet('toasts'), mustGet('ctxmenu'), mustGet('prompt'), mustGet('runaway'));

  // The page is a NATIVE view layered above the chrome's HTML, so any modal
  // overlapping the content rect renders invisibly behind it. Whenever an
  // overlay opens/closes, tell main to raise/lower the chrome (ui:overlay).
  // Sidebar toggle: the UI owns the state; main must re-lay the content view
  // (ui:sidebar) and the CSS grid collapses via the shared width variable.
  // Both watchers start from null so the FIRST run always sends the current
  // state to main: a crash-reloaded chrome would otherwise boot believing
  // the defaults while main still holds the pre-crash flags (sidebar hidden,
  // chrome raised) — a permanent desync with the page covering the sidebar.
  /** @type {boolean|null} */ let sidebarHiddenWas = null;
  const syncSidebar = () => {
    const hidden = store.local.sidebarHidden;
    if (hidden === sidebarHiddenWas) return;
    sidebarHiddenWas = hidden;
    document.body.classList.toggle('sidebar-hidden', hidden);
    cssRoot.style.setProperty('--sidebar-w', hidden ? '0px' : `${SIDEBAR_WIDTH}px`);
    void api.sidebarSet(!hidden);
  };

  /** @type {boolean|null} */ let overlayWas = null;
  const syncOverlay = () => {
    const l = store.local;
    const overlay = l.settingsOpen || l.historyOpen || l.organizeOpen
      || Boolean(l.limitPromptId) || l.defaultBrowserAsk || Boolean(l.externalAsk) || Boolean(l.permissionAsk) || Boolean(store.snap?.runaway);
    if (overlay !== overlayWas) {
      overlayWas = overlay;
      void api.overlaySet(overlay);
    }
  };

  store.subscribe(() => {
    renderTopbar();
    renderSidebar();
    renderLivebar();
    renderGrid();
    renderSettings();
    renderHistory();
    renderOrganize();
    renderCtxMenu();
    renderLimitPrompt();
    renderRunaway();
    syncOverlay();
    syncSidebar();
  });

  // Swallow every drop that no widget claimed. An unhandled file drop makes
  // Chromium navigate the frame to that file — and this frame is the one
  // holding the bridge, so it must never navigate anywhere (main also refuses
  // it via will-navigate; this is the half that keeps the UX sane).
  // The sidebar's own dragover/drop handlers run first and are unaffected:
  // preventDefault here only ADDS acceptance, it cannot cancel their work.
  //
  // Known cosmetic cost: because dragover is accepted everywhere, the drag
  // cursor reads as "droppable" over the grid/topbar/livebar, which accept
  // nothing. The tidy fix (dataTransfer.dropEffect = 'none' when unclaimed)
  // is deliberately NOT applied — whether a 'none' effect still suppresses
  // Chromium's navigate-to-file default cannot be verified here (a real OS
  // file drag can't be simulated), and a wrong guess silently reopens the
  // hole this exists to close. Cursor cosmetics are not worth that trade.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  api.onSnapshot((snap) => {
    // A find session belongs to ONE tab AND one document: switching away,
    // landing on the grid, or navigating the tab all close the bar (the old
    // document's match count would otherwise describe a page that was never
    // searched — Chromium's find session dies with the document anyway).
    const prev = store.snap;
    const prevActive = prev?.activeTabId ?? null;
    if (store.local.findOpen) {
      const switched = snap.activeTabId !== prevActive;
      const prevUrl = prevActive ? prev?.tabs.find((x) => x.id === prevActive)?.url : undefined;
      const nowUrl = prevActive ? snap.tabs.find((x) => x.id === prevActive)?.url : undefined;
      if (switched || (prevUrl !== undefined && nowUrl !== undefined && prevUrl !== nowUrl)) {
        if (prevActive) void api.findStop(prevActive);
        setFindResult(null);
        store.setLocal({ findOpen: false });
      }
    }
    store.setSnapshot(snap);
  });
  api.onToast((t) => showToast(t));
  api.onFocusOmnibox(() => focusOmnibox());
  api.onOpenSettings(() => store.setLocal({ settingsOpen: true }));
  api.onOpenHistory(() => openHistory());
  api.onOpenFind(() => {
    if (!store.snap?.activeTabId) return; // the grid has no page to search
    // With a modal up, the find bar would render (and steal focus) UNDER the
    // backdrop — same predicate as syncOverlay.
    const l = store.local;
    if (l.settingsOpen || l.historyOpen || l.organizeOpen
      || Boolean(l.limitPromptId) || l.defaultBrowserAsk || Boolean(l.externalAsk) || Boolean(l.permissionAsk) || Boolean(store.snap?.runaway)) return;
    store.setLocal({ findOpen: true });
    focusFind();
  });
  // Results patch the count span in place — never a re-render (IME safety).
  api.onFindResult((r) => {
    if (store.local.findOpen && r.tabId === store.snap?.activeTabId) setFindResult(r);
  });
  api.onToggleSidebar(() => store.setLocal({ sidebarHidden: !store.local.sidebarHidden }));
  api.onAskDefaultBrowser(() => store.setLocal({ defaultBrowserAsk: true }));
  api.onAskExternal((r) => store.setLocal({ externalAsk: r }));
  // null withdraws the ask (its tab left the screen); the engine re-sends
  // the same ask, same id, when the tab comes back.
  api.onAskPermission((ask) => store.setLocal({ permissionAsk: ask }));
  document.addEventListener('raha:focus-omnibox', () => focusOmnibox());

  const snap = await api.stateGet();
  store.setSnapshot(snap);
}

void main().catch((err) => {
  // Styled via CSSOM — the page CSP (style-src 'self') blocks style="" attributes.
  const pre = document.createElement('pre');
  pre.style.color = '#e06c75';
  pre.style.padding = '2rem';
  pre.textContent = `Raha UI failed to start:\n${String(err)}`;
  document.body.replaceChildren(pre);
});
