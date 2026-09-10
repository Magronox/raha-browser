// ============================================================================
// ENGINE — the electron-agnostic brain of Raha.
// ============================================================================
// Owns: the folder/tab tree, settings, the runtime table of live renderers,
// the active tab, persistence dirtiness, and the governor loop body (tick).
// Talks to the platform ONLY through injected ports (see PORTS below), which
// is why tests/unit/engine.test.js can run it entirely with fakes, offline.
//
// One instance per app. All methods are synchronous except where a port is
// awaited; IPC handlers in src/main/electron/ipc.js call these 1:1.
//
// PORTS (injected via constructor):
//   views: {
//     setChromeOnTop(on)                  raise the chrome above the page view
//                                         while a UI overlay/modal is open
//     setSidebarVisible(visible)          sidebar toggled: content view takes
//                                         or returns the sidebar's space
//     create(tabId, cb) -> ViewHandle     cb = {onTitle,onFavicon,onUrl,onLoading,
//                                               onAudible,onDestroyed,onOpenUrl,
//                                               onBlocked,onSearchSelection,
//                                               onFindResult(matches, activeMatchOrdinal),
//                                               onLoadFailed()  main-frame load failed;
//                                               the error page's synthetic title follows}
//   }
//   ViewHandle: { loadURL(url), restoreHistory(navJson)->boolean, destroy(),
//                 focus(), back(), forward(), reload(), hardReload(), stop(),
//                 getNav()->{canGoBack,canGoForward,navJson},
//                 getOSPid()->number|null, setAttached(bool),
//                 captureThumb()->Promise<boolean>, zoom(dir),
//                 findInPage(text, {forward, newSession}), stopFind(action),
//                 capturePageState()->Promise<unknown|null>,
//                 restorePageState(state)->void }
//   metrics: { sample() -> Array<{pid:number, memMB:number, cpuPct:number}> }
//   persist: { readJson(name)->unknown, writeJsonAtomic(name, obj)->void,
//              deleteThumb(tabId)->void }
//   importers (optional): {
//     scanHistorySources() -> Array<{id, browser, label, kind}>
//     readHistory(sourceId) -> { entries: Array<{url,title,lastVisitMs,
//                                visitCount}>, problems: string[] }
//     readHistoryFile(filePath) -> same shape; filePath comes from a native
//                                dialog owned by the ipc adapter, NEVER IPC
//     scanOpenTabSources() -> Array<{id, browser, label, kind}>
//     readOpenTabs(sourceId) -> Promise<{ browser, windows: [{tabs:
//                                [{url,title}]}], problems: string[] }>
//   }   adapters: src/main/electron/import-history.js + import-tabs.js
//       (merged into one port by index.js); entries are untrusted
//        and go through normalizeHistoryEntry before touching the store
//   shell (optional): { openExternal(url) -> void }   hand an app link to the
//                     OS. Called ONLY after the user says yes in-app, and
//                     only for a scheme classifyExternal() calls safe.
//                     Failure surfaces as a toast from whichever layer sees
//                     it: the engine catches sync throws; the real adapter
//                     catches the async rejection ("no app registered").
//   now: () -> ms epoch
//   onEvent: (evt) -> void   evt: {type:'snapshot'} | {type:'toast', kind, text}
//                            | {type:'focusOmnibox'}
//                            | {type:'findResult', tabId, matches, activeMatchOrdinal}
//                            | {type:'askExternal', url, scheme, app}
//                            | {type:'askPermission', ask}   ask = {id, tabId,
//                              kinds, host, requestingHost, isMainFrame} to
//                              show, or null to withdraw what is on screen
//                              (tab switched/closed/slept/navigated; ADR-0013)
//
// INBOUND (adapter -> engine; not a port the engine calls): the privacy
// adapter's permission handlers reach permissionRequest({tabId, kinds,
// host, requestingHost, isMainFrame}) -> Promise<boolean> and
// permissionCheck({tabId, host, kind}) -> boolean through the hooks wired
// in src/main/index.js. The promise IS the answer Electron's permission
// callback receives; the boolean IS the check handler's return. Tests call
// both directly.
// ============================================================================

import {
  addFolder, addTab, removeNode, moveNode, folder, tab,
  allTabIds, tabIdsInSubtree,
} from '../../shared/tree.js';
import { decide, runawayAssess, RUNAWAY } from '../../shared/policy.js';
import { effectivePolicy, hostOf } from '../../shared/rules.js';
import { resolveOmnibox, searchUrl, isNavigableUrl, findTabByUrl } from '../../shared/urls.js';
import { validateSettings, normalizeSiteHost } from '../../shared/validate.js';
import { isPermissionKind, normalizeKinds, rememberedVerdict, withSitePermission, withoutSitePermission } from '../../shared/permissions.js';
import { sanitizePageState } from '../../shared/page-state.js';
import { migrateState, migrateSettings, migrateHistory } from '../../shared/migrate.js';
import { RANGES, HISTORY_SCHEMA_VERSION } from '../../shared/defaults.js';
import { sanitizeWindows, MAX_IMPORT_TABS } from '../../shared/open-tabs.js';
import { normalizeHistoryEntry, mergeHistory, searchHistory, suggestHistory, recordVisit, touchHistoryTitle } from '../../shared/history.js';
import { planOrganize } from '../../shared/organize.js';
import { classifyExternal, schemeOf, isRememberedScheme, appLabelForScheme } from '../../shared/external.js';

export const STATE_FILE = 'state.json';
export const SETTINGS_FILE = 'settings.json';
export const HISTORY_FILE = 'history.json';
/** Min gap between batched history.json writes (visits mark dirty, the tick
 * flushes, shutdown forces). The write is SYNCHRONOUS on the main process
 * and a capped store serializes to ~4MB (~85-235ms measured) — 5 minutes
 * keeps that stall rare; the crash-loss window is bounded visits only,
 * matching what mainstream browsers batch. */
const HISTORY_WRITE_MS = 300_000;
/** Quiet window between remembered-scheme auto-opens (and between
 * blocked-link toasts): one launch per window, extras fall back to asking. */
const EXTERNAL_QUIET_MS = 3_000;
/** Pending permission asks per tab beyond which surplus requests are refused
 * outright — a looping page must not build an endless dialog backlog
 * (identical asks coalesce before this counts). */
const PERMISSION_QUEUE_CAP = 8;

/**
 * @typedef {Object} PermissionAsk  One pending "site wants X" ask (ADR-0013)
 * @property {number} id            nonce the answer must echo
 * @property {string} tabId
 * @property {import('../../shared/permissions.js').PermissionKind[]} kinds  the UNDECIDED kinds, canonical order
 * @property {string} host          normalized site host of the TAB's page (not the asking frame)
 * @property {string|null} requestingHost  the asking frame's host, display only (page-controlled)
 * @property {boolean} isMainFrame
 * @property {Array<(granted: boolean) => void>} resolvers  every waiter — coalesced asks share one entry
 */

/**
 * @typedef {Object} Runtime  Per-tab runtime info (exists only while running)
 * @property {ReturnType<any>} view ViewHandle from the views port
 * @property {number|null} pid
 * @property {boolean} audible
 * @property {boolean} loading
 * @property {boolean} canGoBack
 * @property {boolean} canGoForward
 * @property {number|null} memMB
 * @property {number|null} cpuPct
 * @property {boolean} memShared
 * @property {number} blockedCount
 * @property {number} cpuHotTicks   consecutive ticks at/above RUNAWAY.cpuPct
 * @property {number} memHotTicks   consecutive ticks at/above RUNAWAY.memMB
 * @property {import('../../shared/page-state.js').PageState|null} pageState  cached page state from last capture (R-104)
 */

export class Engine {
  /**
   * @param {{ views: any, metrics: any, persist: any, shell?: any, now: () => number,
   *           onEvent: (evt: any) => void, importers?: any }} deps
   */
  constructor(deps) {
    this.views = deps.views;
    this.metrics = deps.metrics;
    this.persist = deps.persist;
    this.now = deps.now;
    this.onEvent = deps.onEvent;
    this.importers = deps.importers ?? null;
    this.shell = deps.shell ?? null;
    /** The one app link awaiting the user's answer. Holding it here (rather
     * than trusting a URL sent back from the UI) means a compromised chrome
     * cannot ask the OS to open something the user never saw. The id is a
     * nonce the confirmation must echo: a newer ask invalidates every older
     * one, so a stale modal can never approve a URL it did not display.
     * @type {{ id: number, url: string }|null} */
    this.pendingExternal = null;
    /** @type {number} */ this.externalAskSeq = 0;
    /** ms epoch of the last remembered-scheme auto-open / refusal toast —
     * both are rate-limited so a looping page can neither turn "always
     * allow" into a launch hose nor storm the toast rail. */
    this.lastExternalAutoOpenMs = -Infinity;
    this.lastExternalToastMs = -Infinity;
    /** Per-site permission asks (R-103, ADR-0013), queued per tab; only
     * the head of the ACTIVE tab's queue is ever on screen. Same nonce
     * rule as app links: the answer must echo the id of the ask it read.
     * @type {Map<string, PermissionAsk[]>} tabId -> pending asks, oldest first */
    this.permissionQueues = new Map();
    /** id of the ask the UI is showing, or null. @type {number|null} */
    this.permissionShownId = null;
    /** @type {number} */ this.permissionAskSeq = 0;
    /** "Allow once" grants, per tab: they last for the page visit — checks
     * and repeat requests on that tab pass silently until it leaves the
     * site, sleeps, or closes (dropPermissionAsks). Never persisted.
     * @type {Map<string, { host: string, kinds: Set<import('../../shared/permissions.js').PermissionKind> }>} */
    this.permissionOnce = new Map();

    const rawState = this.persist.readJson(STATE_FILE);
    /** True when no state file existed — this profile has never run Raha.
     * The wiring layer uses this to seed the first-run welcome experience. */
    this.firstRun = rawState === undefined;
    const { state, problems: sp } = migrateState(rawState);
    const { settings, problems: gp } = migrateSettings(this.persist.readJson(SETTINGS_FILE));
    const { history, problems: hp } = migrateHistory(this.persist.readJson(HISTORY_FILE));
    /** @type {import('../../shared/migrate.js').PersistedState} */
    this.state = state;
    /** @type {import('../../shared/defaults.js').RahaSettings} */
    this.settings = settings;
    /** @type {import('../../shared/migrate.js').PersistedHistory} */
    this.history = history;
    this.loadProblems = [...sp, ...gp, ...hp];

    /** @type {Map<string, Runtime>} */
    this.runtime = new Map();
    /** @type {Map<string, number>} */
    this.thumbSeq = new Map();
    /** @type {{ tabId: string, kind: 'cpu'|'mem' }|null} the one open runaway prompt */
    this.runawayAlert = null;
    /** @type {Map<string, number>} tabId -> ms epoch until which "Not now" quiets
     * prompts. Engine-level (not on Runtime) so a snooze survives the tab
     * sleeping/crashing/waking inside its window. Not persisted on purpose. */
    this.runawaySnoozes = new Map();
    /** @type {{ url: string, title: string, parentId: string, index: number }[]}
     * Recently closed tabs, oldest first (reopen pops the newest). Session-only
     * on purpose — not persisted, so no migration and nothing lingers on disk. */
    this.closedTabs = [];
    /** All tabs start asleep after a restart — that is the product philosophy. */
    this.state.activeTabId = null;
    this.dirty = false;
    /** Own-visit recording (R-106): batched — a navigation marks dirty, the
     * tick writes at most every HISTORY_WRITE_MS (plus shutdown). Writing
     * history.json per navigation would grind the disk for no benefit. */
    this.historyDirty = false;
    this.lastHistoryWriteMs = 0;
  }

  // ---------------------------------------------------------------- helpers

  emitSnapshot() { this.onEvent({ type: 'snapshot' }); }
  /** @param {'info'|'warn'|'sleep'|'download'} kind @param {string} text */
  toast(kind, text) { this.onEvent({ type: 'toast', kind, text }); }
  markDirty() { this.dirty = true; }

  /** @param {string} tabId @returns {import('../../shared/tree.js').TabNode|null} */
  tabNode(tabId) { return tab(this.state.tree, tabId); }

  /** Effective keepAlive/memLimit for a tab (per-tab flag OR domain rule). */
  effPolicy(/** @type {import('../../shared/tree.js').TabNode} */ node) {
    return effectivePolicy(
      { keepAlive: node.keepAlive, memLimitMB: node.memLimitMB, host: hostOf(node.url) },
      this.settings.rules,
    );
  }

  isRunning(/** @type {string} */ tabId) { return this.runtime.has(tabId); }

  // ------------------------------------------------------------------ tabs

  /**
   * @param {{ url?: string, folderId?: string, activate?: boolean }} [opts]
   * @returns {{ tabId: string }|{ error: string }}
   */
  tabCreate(opts = {}) {
    // Scheme gate. Tab URLs arrive from three places — the omnibox, the UI's
    // tab:create, and a page's window.open (see wake()/onOpenUrl) — and only
    // the first is pre-sanitized. Everything funnels through here, so this is
    // the one place that has to be right.
    if (opts.url != null && !isNavigableUrl(opts.url)) return { error: 'unsupported url' };
    const parentId = opts.folderId ?? this.state.tree.rootId;
    if (!folder(this.state.tree, parentId)) return { error: 'no such folder' };
    const node = addTab(this.state.tree, { url: opts.url || 'raha://home', parentId, now: this.now() });
    if (!node) return { error: 'could not create tab' };
    this.markDirty();
    if (opts.activate !== false) this.tabActivate({ tabId: node.id });
    else this.emitSnapshot();
    return { tabId: node.id };
  }

  /**
   * Activate a tab; wakes it if asleep. The single entry point for switching.
   * @param {{ tabId: string }} p
   */
  tabActivate(p) {
    const node = this.tabNode(p.tabId);
    if (!node) return { error: 'no such tab' };

    const prevId = this.state.activeTabId;
    if (prevId === p.tabId && this.isRunning(p.tabId)) {
      this.runtime.get(p.tabId)?.view.focus();
      return { ok: true };
    }

    // Thumbnail + page state the outgoing tab while it is still visible, then detach.
    if (prevId && prevId !== p.tabId) {
      const prev = this.runtime.get(prevId);
      if (prev) {
        void prev.view.captureThumb().then((/** @type {boolean} */ saved) => {
          if (saved) this.bumpThumb(prevId);
        });
        this.capturePageState(prevId);
        prev.view.setAttached(false);
      }
    }

    if (!this.isRunning(p.tabId)) this.wake(node);
    const rt = this.runtime.get(p.tabId);
    if (!rt) return { error: 'wake failed' };

    this.state.activeTabId = p.tabId;
    node.lastActiveAt = this.now();
    rt.view.setAttached(true);
    rt.view.focus();
    this.syncPermissionAsk(); // this tab's waiting ask (if any) may show now
    this.markDirty();
    this.governNow();
    this.emitSnapshot();
    return { ok: true };
  }

  /** Create the renderer for a tab node. @param {import('../../shared/tree.js').TabNode} node */
  wake(node) {
    /** Last url this renderer LOADED (visit dedupe — see onUrl). Fresh per
     * wake on purpose: waking an asleep tab is a revisit. @type {string|null} */
    let lastVisitUrl = null;
    /** Url whose visit was recorded — a title may only be stamped onto THIS
     * entry (navOmnibox updates node.url before the load commits, so node.url
     * alone can misattribute an old page's title). @type {string|null} */
    let lastRecordedUrl = null;
    /** One title per visit: title-ticker pages (inbox counters) must not
     * re-dirty a multi-MB store every 30s forever. */
    let titleTouched = false;
    /** Set on did-fail-load: the in-place error page's synthetic
     * "Failed to load" title must never clobber a recorded title.
     * @type {string|null} */
    let failedUrl = null;
    const view = this.views.create(node.id, {
      onTitle: (/** @type {string} */ t) => {
        node.title = (t || node.title).slice(0, 300);
        // Stamp the title onto the recorded entry — once per visit, only for
        // the url this renderer actually recorded, and never after a failed
        // load (the error page sets a synthetic title).
        if (this.settings.recordHistory && !titleTouched
          && node.url === lastRecordedUrl && node.url !== failedUrl
          && touchHistoryTitle(this.history.entries, node.url, node.title)) {
          this.historyDirty = true;
          titleTouched = true;
        }
        this.markDirty(); this.emitSnapshot();
      },
      onFavicon: (/** @type {string} */ u) => { node.faviconUrl = u || null; this.markDirty(); this.emitSnapshot(); },
      onUrl: (/** @type {string} */ url, /** @type {boolean} */ back, /** @type {boolean} */ fwd) => {
        // Own-visit recording (R-106). Dedupe against the LAST LOADED url of
        // this renderer (closure — node.url is already updated by the time
        // fresh navigations load, so it can't be the reference): reloads
        // aren't new visits, but waking a tab or navigating anywhere is.
        // recordVisit itself refuses non-web URLs (raha://, blob:).
        if (this.settings.recordHistory && url !== lastVisitUrl) {
          this.history.entries = recordVisit(this.history.entries, { url, title: '', nowMs: this.now() });
          this.historyDirty = true;
          lastRecordedUrl = url;
        }
        // Any committed navigation clears failure state and re-arms the
        // one-title-per-visit latch (a reload's fresh title may stamp again).
        failedUrl = null;
        titleTouched = false;
        lastVisitUrl = url;
        node.url = url;
        // Leaving the site refuses any permission ask still pending for it:
        // a dialog must never outlive the page that raised it.
        this.dropPermissionAsks(node.id, normalizeSiteHost(hostOf(url)));
        const rt = this.runtime.get(node.id);
        if (rt) { rt.canGoBack = back; rt.canGoForward = fwd; }
        this.markDirty(); this.emitSnapshot();
      },
      onLoading: (/** @type {boolean} */ l) => {
        const rt = this.runtime.get(node.id);
        if (rt) { rt.loading = l; this.emitSnapshot(); }
      },
      onAudible: (/** @type {boolean} */ a) => {
        const rt = this.runtime.get(node.id);
        if (rt) { rt.audible = a; this.emitSnapshot(); }
      },
      onDestroyed: () => this.onViewGone(node.id),
      onOpenUrl: (/** @type {string} */ url) => {
        // window.open() / an external-scheme link from an untrusted page.
        if (!isNavigableUrl(url)) return this.externalRequest(url);
        this.tabCreate({ url, folderId: node.parentId, activate: true });
      },
      onSearchSelection: (/** @type {string} */ text) => {
        // "Search selection" from the page context menu. The selection is
        // page-controlled and the menu PROMISED a search — so always build a
        // search-engine URL. Never route through resolveOmnibox here: it
        // treats host-shaped text ("evil-phish.example") as a URL and would
        // navigate to an attacker-picked site under a "Search for…" label.
        const q = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
        if (!q) return;
        this.tabCreate({
          url: searchUrl(q, this.settings.searchEngine),
          folderId: node.parentId,
          activate: true,
        });
      },
      onFindResult: (/** @type {number} */ matches, /** @type {number} */ activeMatchOrdinal) => {
        this.onEvent({ type: 'findResult', tabId: node.id, matches, activeMatchOrdinal });
      },
      onLoadFailed: () => { failedUrl = node.url; },
      onBlocked: () => {
        const rt = this.runtime.get(node.id);
        if (rt) rt.blockedCount += 1; // snapshot flows on next tick; avoid event storms
      },
    });
    /** @type {Runtime} */
    const rt = {
      view, pid: null, audible: false, loading: true,
      canGoBack: false, canGoForward: false,
      memMB: null, cpuPct: null, memShared: false, blockedCount: 0,
      cpuHotTicks: 0, memHotTicks: 0,
      pageState: node.pageState,
    };
    this.runtime.set(node.id, rt);
    const restored = node.navJson ? view.restoreHistory(node.navJson) : false;
    // node.url comes back from state.json, which is just a file on disk —
    // re-check it at the sink rather than trusting what we persisted.
    if (!restored) view.loadURL(isNavigableUrl(node.url) ? node.url : 'raha://home');
    if (node.pageState && this.settings.restorePageState) {
      view.restorePageState(node.pageState);
    }
    node.navJson = null;
    node.pageState = null;
    this.markDirty();
  }

  /**
   * Put a running tab to sleep: save nav history, destroy the renderer.
   * @param {{ tabId: string }} p
   * @param {'manual'|'tab-limit'|'idle'|'cap'|'global-budget'|'runaway'} [reason]
   */
  tabSleep(p, reason = 'manual') {
    const node = this.tabNode(p.tabId);
    const rt = this.runtime.get(p.tabId);
    if (!node || !rt) return { error: 'not running' };

    const wasActive = this.state.activeTabId === p.tabId;
    try {
      const nav = rt.view.getNav();
      node.navJson = nav.navJson ?? null;
    } catch { /* keep node.url as restore point */ }
    node.pageState = rt.pageState;

    this.runtime.delete(p.tabId); // remove first: onDestroyed becomes a no-op
    rt.view.destroy();
    if (wasActive) this.state.activeTabId = null;
    this.clearRunawayFor(p.tabId);
    this.dropPermissionAsks(p.tabId);
    this.markDirty();
    if (reason !== 'manual') {
      this.toast('sleep', `${sleepReasonText(reason)}: “${node.title || node.url}” went to sleep`);
    }
    this.emitSnapshot();
    return { ok: true };
  }

  /** Renderer died underneath us (crash or expected destroy). @param {string} tabId */
  onViewGone(tabId) {
    if (!this.runtime.has(tabId)) return; // we initiated it
    this.runtime.delete(tabId);
    this.clearRunawayFor(tabId);
    if (this.state.activeTabId === tabId) this.state.activeTabId = null;
    this.dropPermissionAsks(tabId);
    const node = this.tabNode(tabId);
    this.toast('warn', `Tab crashed and was put to sleep: ${node ? node.title : tabId}`);
    this.emitSnapshot();
  }

  /** @param {{ tabId: string }} p */
  tabClose(p) { return this.nodeRemove({ nodeId: p.tabId }); }

  /**
   * Reopen the most recently closed tab (Cmd/Ctrl+Shift+T). Restores URL,
   * title, and — when the folder still exists — its old place in it.
   * @returns {{ tabId: string }|{ error: string }}
   */
  tabReopen() {
    const entry = this.closedTabs.pop();
    if (!entry) return { error: 'nothing to reopen' };
    const parentAlive = folder(this.state.tree, entry.parentId) != null;
    const res = this.tabCreate({ url: entry.url, folderId: parentAlive ? entry.parentId : undefined, activate: true });
    if ('error' in res) return res;
    const node = this.tabNode(res.tabId);
    if (node && entry.title) node.title = entry.title;
    if (parentAlive) moveNode(this.state.tree, res.tabId, entry.parentId, entry.index);
    this.markDirty();
    this.emitSnapshot();
    return { tabId: res.tabId };
  }

  /** @param {{ tabId: string, keepAlive: boolean }} p */
  tabSetKeepAlive(p) {
    const node = this.tabNode(p.tabId);
    if (!node) return { error: 'no such tab' };
    node.keepAlive = Boolean(p.keepAlive);
    this.markDirty();
    this.governNow();
    this.emitSnapshot();
    return { ok: true };
  }

  /** @param {{ tabId: string, memLimitMB: number|null }} p */
  tabSetMemLimit(p) {
    const node = this.tabNode(p.tabId);
    if (!node) return { error: 'no such tab' };
    if (p.memLimitMB == null) node.memLimitMB = null;
    else {
      const [min, max] = RANGES.memLimitMB;
      const v = Math.round(Number(p.memLimitMB));
      if (!Number.isFinite(v) || v < min) return { error: 'bad limit' };
      node.memLimitMB = v === 0 ? null : Math.min(max, v);
    }
    this.markDirty();
    this.governNow();
    this.emitSnapshot();
    return { ok: true };
  }

  /** Hide content, show the UI grid. */
  tabShowGrid() {
    const prevId = this.state.activeTabId;
    if (prevId) {
      const prev = this.runtime.get(prevId);
      if (prev) {
        void prev.view.captureThumb().then((/** @type {boolean} */ saved) => {
          if (saved) this.bumpThumb(prevId);
        });
        this.capturePageState(prevId);
        prev.view.setAttached(false);
      }
    }
    this.state.activeTabId = null;
    this.syncPermissionAsk(); // no page on screen -> no ask on screen
    this.emitSnapshot();
    return { ok: true };
  }

  // ------------------------------------------------------------- navigation

  /**
   * Resolve omnibox text and go there. `mode` says where:
   *  - 'here'    navigate `tabId` in place — the default whenever a tab id
   *              is given (no tab id: same as 'new').
   *  - 'new'     a new tab. With a tab showing it opens BESIDE that tab (its
   *              folder — like a page's window.open does), never in whatever
   *              folder the sidebar happens to have selected: that was the
   *              "opened in a random window" complaint. With no tab showing
   *              it lands in the folder the user is LOOKING AT (`folderId`,
   *              the grid's folder) — the default on the grid. A stale/bad
   *              folderId must never fail navigation: fall back to root.
   *  - 'switch'  some tab already shows the resolved page (sameUrl) →
   *              activate it and report `switched`; otherwise the default.
   * @param {{ input: string, tabId: string|null, folderId?: string, mode?: 'here'|'new'|'switch' }} p
   */
  navOmnibox(p) {
    const { url } = resolveOmnibox(p.input, {
      httpsFirst: this.settings.httpsFirst,
      searchEngine: this.settings.searchEngine,
    });
    const node = p.tabId != null ? this.tabNode(p.tabId) : null;
    const fallback = p.tabId != null ? 'here' : 'new';
    let mode = p.mode ?? fallback;
    if (mode === 'switch') {
      /** @type {Array<{ id: string, url: string }>} */
      const tabs = [];
      for (const id of allTabIds(this.state.tree)) {
        const t = this.tabNode(id);
        if (t) tabs.push({ id: t.id, url: t.url });
      }
      const hit = findTabByUrl(tabs, url);
      if (hit) {
        this.tabActivate({ tabId: hit.id });
        return { ok: true, switched: hit.id };
      }
      mode = fallback;
    }
    if (mode === 'new' || p.tabId == null) {
      const folderId = node && folder(this.state.tree, node.parentId)
        ? node.parentId
        : typeof p.folderId === 'string' && folder(this.state.tree, p.folderId) ? p.folderId : undefined;
      return this.tabCreate({ url, folderId, activate: true });
    }
    if (!node) return { error: 'no such tab' };
    node.url = url;
    if (this.isRunning(p.tabId)) {
      this.runtime.get(p.tabId)?.view.loadURL(url);
    } else {
      node.navJson = null;
      node.pageState = null;
      this.tabActivate({ tabId: p.tabId });
    }
    this.markDirty();
    this.emitSnapshot();
    return { ok: true };
  }

  /** @param {{ tabId: string }} p @param {'back'|'forward'|'reload'|'hardReload'|'stop'} op */
  navOp(p, op) {
    const rt = this.runtime.get(p.tabId);
    if (!rt) return { error: 'not running' };
    if (op === 'back') rt.view.back();
    else if (op === 'forward') rt.view.forward();
    else if (op === 'reload') rt.view.reload();
    else if (op === 'hardReload') rt.view.hardReload();
    else rt.view.stop();
    return { ok: true };
  }

  // ----------------------------------------------------------- app links
  //
  // A page asked to open something that is not the web (zoommtg:, msteams:,
  // mailto:…). Dead-ending with "blocked" is user-hostile — the user clicked
  // a meeting link and meant it — but handing arbitrary schemes to the OS
  // turns a browser into a launcher for local attack surface. So: refuse the
  // dangerous ones outright, open remembered ones, and ASK about the rest.
  // The OS is never touched without a yes (docs/DECISIONS/ADR-0011).

  /** @param {string} url @returns {{ ok: true }|{ asked: true }|{ error: string }} */
  externalRequest(url) {
    if (classifyExternal(url) === 'dangerous') {
      if (this.now() - this.lastExternalToastMs >= EXTERNAL_QUIET_MS) {
        this.lastExternalToastMs = this.now();
        this.toast('warn', `Blocked a link to an unsupported address (${String(url).slice(0, 40)})`);
      }
      return { error: 'unsupported scheme' };
    }
    const scheme = schemeOf(url);
    if (isRememberedScheme(scheme, this.settings.allowedExternalSchemes)
        && this.now() - this.lastExternalAutoOpenMs >= EXTERNAL_QUIET_MS) {
      this.lastExternalAutoOpenMs = this.now();
      return this.openExternalNow(url);
    }
    // Not remembered — or remembered but arriving too fast, in which case
    // the surplus request downgrades to an ask instead of silently opening.
    const id = ++this.externalAskSeq;
    this.pendingExternal = { id, url };
    this.onEvent({ type: 'askExternal', id, url, scheme, app: appLabelForScheme(scheme) });
    return { asked: true };
  }

  /**
   * The user said yes in the ask. The URL is the one the ENGINE stored, not
   * one the renderer sent back — the UI can only confirm, never choose. The
   * id must match the pending ask: if a newer request replaced it, the yes
   * was given to a URL that is no longer the one on file, and opening (or
   * remembering) anything would be a bait-and-switch.
   * @param {{ id?: number, remember?: boolean }} [p]
   */
  externalOpen(p) {
    const pending = this.pendingExternal;
    if (!pending) return { error: 'nothing pending' };
    if (p?.id !== pending.id) return { error: 'stale ask' };
    this.pendingExternal = null;
    if (p?.remember) {
      const scheme = schemeOf(pending.url);
      if (scheme) {
        const next = [...new Set([...this.settings.allowedExternalSchemes, scheme])];
        this.settingsSet({ allowedExternalSchemes: next });
      }
    }
    return this.openExternalNow(pending.url);
  }

  /** The user said no. A stale id is a harmless no-op (the ask it aimed at
   * is already gone); matching id clears the pending request.
   * @param {{ id?: number }} [p] */
  externalDismiss(p) {
    if (this.pendingExternal && p?.id === this.pendingExternal.id) this.pendingExternal = null;
    return { ok: true };
  }

  /** @param {string} url @returns {{ ok: true }|{ error: string }} */
  openExternalNow(url) {
    // Re-check at the sink: settings could have been tampered with on disk,
    // and this is the one place that reaches the OS (invariant #13's spirit).
    if (classifyExternal(url) === 'dangerous') return { error: 'unsupported scheme' };
    if (!this.shell) return { error: 'no shell port' };
    try {
      this.shell.openExternal(url);
    } catch {
      this.toast('warn', 'That app link could not be opened — is the app installed?');
      return { error: 'open failed' };
    }
    this.toast('info', `Opened ${appLabelForScheme(schemeOf(url))}`);
    return { ok: true };
  }

  // ------------------------------------------------------ site permissions
  //
  // A page asked for the camera, microphone, location, notifications or the
  // clipboard (R-103, docs/DECISIONS/ADR-0013). Same consent shape as app
  // links: nothing is granted silently, the engine holds every pending ask,
  // and the UI can only answer the id it displayed. Two more rules, because
  // these asks come from page script rather than from a click: an ask is
  // SHOWN only while its tab is the active one (a dialog about a page the
  // user cannot see is a surprise — background tabs wait their turn, one
  // ask on screen at a time), and an ask never outlives its page (close,
  // sleep, crash, or leaving the site refuse it and remember nothing).

  /**
   * The privacy adapter's permission REQUEST, awaited: the resolved boolean
   * is exactly what Electron's callback receives. A remembered decision
   * (settings, or this visit's "allow once") answers at once and silently;
   * anything undecided becomes an ask in the tab's queue.
   * @param {{ tabId?: unknown, kinds?: unknown, host?: unknown, requestingHost?: unknown, isMainFrame?: unknown }} [p]
   *   host: the TAB's page host (top-level) — the site the decision is
   *   filed under; requestingHost: the asking frame's, display only.
   * @returns {Promise<boolean>}
   */
  permissionRequest(p) {
    const tabId = typeof p?.tabId === 'string' ? p.tabId : '';
    if (!tabId || !this.runtime.has(tabId)) return Promise.resolve(false); // no renderer, nothing to grant
    const kinds = Array.isArray(p?.kinds) ? normalizeKinds(p.kinds) : [];
    const host = normalizeSiteHost(p?.host);
    if (kinds.length === 0 || !host) return Promise.resolve(false);
    const { verdict, undecided } = this.permissionVerdict(tabId, host, kinds);
    if (verdict !== 'ask') return Promise.resolve(verdict === 'allow');
    const queue = this.permissionQueues.get(tabId) ?? [];
    const key = undecided.join(',');
    const twin = queue.find((a) => a.host === host && a.kinds.join(',') === key);
    if (twin) return new Promise((resolve) => { twin.resolvers.push(resolve); }); // coalesce: one answer for both
    if (queue.length >= PERMISSION_QUEUE_CAP) return Promise.resolve(false);
    return new Promise((resolve) => {
      queue.push({
        id: ++this.permissionAskSeq,
        tabId,
        kinds: undecided,
        host,
        requestingHost: typeof p?.requestingHost === 'string' && p.requestingHost ? p.requestingHost.slice(0, 253) : null,
        isMainFrame: p?.isMainFrame !== false,
        resolvers: [resolve],
      });
      this.permissionQueues.set(tabId, queue);
      this.syncPermissionAsk();
    });
  }

  /**
   * The privacy adapter's permission CHECK (navigator.permissions.query,
   * Notification.permission, device enumeration…). True only for a
   * remembered allow or this visit's "allow once"; undecided reads as
   * denied, because Electron's check handler can say yes or no but never
   * "prompt" (ADR-0013 states this divergence from Chrome).
   * @param {{ tabId?: unknown, host?: unknown, kind?: unknown }} [p]
   * @returns {boolean}
   */
  permissionCheck(p) {
    const tabId = typeof p?.tabId === 'string' ? p.tabId : '';
    const host = normalizeSiteHost(p?.host);
    const kind = p?.kind;
    if (!tabId || !host || !isPermissionKind(kind) || !this.tabNode(tabId)) return false;
    return this.permissionVerdict(tabId, host, [kind]).verdict === 'allow';
  }

  /**
   * Persisted decisions first (any blocked kind refuses the lot), then this
   * tab's "allow once" grants for the same site cover what is left.
   * @param {string} tabId @param {string} host normalized site host
   * @param {readonly import('../../shared/permissions.js').PermissionKind[]} kinds
   * @returns {{ verdict: 'allow'|'deny'|'ask', undecided: import('../../shared/permissions.js').PermissionKind[] }}
   */
  permissionVerdict(tabId, host, kinds) {
    const r = rememberedVerdict(this.settings.sitePermissions, host, kinds);
    if (r.verdict !== 'ask') return r;
    const once = this.permissionOnce.get(tabId);
    const undecided = once && once.host === host ? r.undecided.filter((k) => !once.kinds.has(k)) : r.undecided;
    return undecided.length === 0 ? { verdict: 'allow', undecided: [] } : { verdict: 'ask', undecided };
  }

  /**
   * The user answered the ask on screen. Only the head of the ACTIVE tab's
   * queue is ever on screen, and its id must match: a stale id (the ask was
   * withdrawn, superseded, or already answered) grants and remembers
   * nothing — same rule as externalOpen.
   *   once    -> granted for this page visit, nothing persisted
   *   always  -> 'allow' persisted per kind under the site, granted
   *   never   -> 'deny' persisted per kind under the site, refused
   *   dismiss -> refused (Not now / Escape / backdrop), nothing remembered
   * A persisted answer also settles asks still queued for that site on any
   * tab, and narrows queued asks to what is still undecided.
   * @param {{ id?: unknown, decision?: unknown }} [p]
   */
  permissionAnswer(p) {
    const active = this.state.activeTabId;
    const queue = active ? this.permissionQueues.get(active) : undefined;
    const ask = queue?.[0];
    const id = typeof p?.id === 'number' ? p.id : null;
    if (id === null || !ask || !queue || ask.id !== id || this.permissionShownId !== id) return { error: 'stale ask' };
    const decision = p?.decision;
    if (decision !== 'once' && decision !== 'always' && decision !== 'never' && decision !== 'dismiss') return { error: 'bad decision' };
    queue.shift();
    if (queue.length === 0) this.permissionQueues.delete(ask.tabId);
    if (decision === 'always' || decision === 'never') {
      let map = this.settings.sitePermissions;
      for (const k of ask.kinds) map = withSitePermission(map, ask.host, k, decision === 'always' ? 'allow' : 'deny');
      this.settingsSet({ sitePermissions: map }); // validation + persistence + snapshot
    } else if (decision === 'once') {
      const once = this.permissionOnce.get(ask.tabId);
      if (once && once.host === ask.host) for (const k of ask.kinds) once.kinds.add(k);
      else this.permissionOnce.set(ask.tabId, { host: ask.host, kinds: new Set(ask.kinds) });
    }
    settleAsk(ask, decision === 'once' || decision === 'always');
    if (decision !== 'dismiss') this.reconcilePermissionQueues();
    this.syncPermissionAsk();
    return { ok: true };
  }

  /**
   * Forget remembered decisions for a site: one kind, or every kind when
   * `kind` is omitted. Nothing pending is touched — the site simply asks
   * again next time.
   * @param {{ host?: unknown, kind?: unknown }} [p]
   */
  permissionForget(p) {
    const host = normalizeSiteHost(p?.host);
    if (!host) return { error: 'bad host' };
    const kind = p?.kind;
    if (kind !== undefined && !isPermissionKind(kind)) return { error: 'bad kind' };
    this.settingsSet({ sitePermissions: withoutSitePermission(this.settings.sitePermissions, host, kind) });
    return { ok: true };
  }

  /**
   * Keep exactly one ask on screen: the head of the ACTIVE tab's queue, or
   * nothing. Emits only on change — the UI keys its modal on the id, so a
   * withdrawn ask (tab switched away, grid shown, page gone) disappears,
   * and the same ask comes back with the same id when its tab returns.
   */
  syncPermissionAsk() {
    const active = this.state.activeTabId;
    const head = (active ? this.permissionQueues.get(active)?.[0] : undefined) ?? null;
    const wantId = head ? head.id : null;
    if (wantId === this.permissionShownId) return;
    this.permissionShownId = wantId;
    this.onEvent({ type: 'askPermission', ask: head ? publicAsk(head) : null });
  }

  /**
   * Refuse a tab's pending asks (and end its "allow once" visit) — all of
   * them, or, on a navigation, those for a different site than `keepHost`:
   * a dialog must never outlive the page that raised it, and a one-time
   * grant must never follow the tab to another site.
   * @param {string} tabId @param {string|null} [keepHost] normalized site host still on screen
   */
  dropPermissionAsks(tabId, keepHost = null) {
    const once = this.permissionOnce.get(tabId);
    if (once && once.host !== keepHost) this.permissionOnce.delete(tabId);
    const queue = this.permissionQueues.get(tabId);
    if (queue) {
      const kept = queue.filter((a) => a.host === keepHost);
      for (const a of queue) if (a.host !== keepHost) settleAsk(a, false);
      if (kept.length > 0) this.permissionQueues.set(tabId, kept);
      else this.permissionQueues.delete(tabId);
    }
    this.syncPermissionAsk();
  }

  /**
   * After a decision landed: settle every queued ask the memory now
   * answers (any tab, same site), narrow the rest to what is still
   * undecided, and merge asks that became identical. Runs before
   * syncPermissionAsk, so the ask on screen is never edited underneath
   * the user.
   */
  reconcilePermissionQueues() {
    for (const [tabId, queue] of [...this.permissionQueues]) {
      /** @type {PermissionAsk[]} */ const kept = [];
      for (const ask of queue) {
        const { verdict, undecided } = this.permissionVerdict(tabId, ask.host, ask.kinds);
        if (verdict !== 'ask') { settleAsk(ask, verdict === 'allow'); continue; }
        ask.kinds = undecided;
        const twin = kept.find((a) => a.host === ask.host && a.kinds.join(',') === undecided.join(','));
        if (twin) twin.resolvers.push(...ask.resolvers);
        else kept.push(ask);
      }
      if (kept.length > 0) this.permissionQueues.set(tabId, kept);
      else this.permissionQueues.delete(tabId);
    }
  }

  /** @param {{ tabId: string, direction: 'in'|'out'|'reset' }} p */
  zoomSet(p) {
    const rt = this.runtime.get(p.tabId);
    if (!rt) return { error: 'not running' };
    rt.view.zoom(p.direction);
    return { ok: true };
  }

  /**
   * Find in page (R-101). Fire-and-return: the match count arrives later via
   * the view's onFindResult callback -> {type:'findResult'} event.
   * @param {{ tabId: string, text: string, forward?: boolean, newSession?: boolean }} p
   */
  findStart(p) {
    const rt = this.runtime.get(p.tabId);
    if (!rt) return { error: 'not running' };
    const text = String(p.text ?? '').slice(0, 200);
    if (!text) return { error: 'empty' };
    rt.view.findInPage(text, { forward: p.forward ?? true, newSession: p.newSession ?? false });
    return { ok: true };
  }

  /** @param {{ tabId: string, keepSelection?: boolean }} p */
  findStop(p) {
    const rt = this.runtime.get(p.tabId);
    if (rt) rt.view.stopFind(p.keepSelection ? 'keepSelection' : 'clearSelection');
    return { ok: true }; // stopping a find on a gone/asleep tab is fine
  }

  // ---------------------------------------------------------------- folders

  /** @param {{ name: string, parentId?: string }} p */
  folderCreate(p) {
    const node = addFolder(this.state.tree, { name: p.name, parentId: p.parentId });
    if (!node) return { error: 'bad parent' };
    this.markDirty();
    this.emitSnapshot();
    return { folderId: node.id };
  }

  /** @param {{ folderId: string, name: string }} p */
  folderRename(p) {
    const f = folder(this.state.tree, p.folderId);
    if (!f || f.id === this.state.tree.rootId) return { error: 'no such folder' };
    f.name = String(p.name || '').slice(0, 120) || f.name;
    this.markDirty();
    this.emitSnapshot();
    return { ok: true };
  }

  /** @param {{ folderId: string, collapsed: boolean }} p */
  folderToggle(p) {
    const f = folder(this.state.tree, p.folderId);
    if (!f) return { error: 'no such folder' };
    f.collapsed = Boolean(p.collapsed);
    this.markDirty();
    this.emitSnapshot();
    return { ok: true };
  }

  /** Sleep every running tab in a folder's subtree. @param {{ folderId: string }} p */
  folderSleepAll(p) {
    let slept = 0;
    for (const id of tabIdsInSubtree(this.state.tree, p.folderId)) {
      if (this.isRunning(id)) {
        this.tabSleep({ tabId: id });
        slept += 1;
      }
    }
    return { slept };
  }

  // ------------------------------------------------------------------ nodes

  /** Remove a tab, or a folder with its whole subtree. @param {{ nodeId: string }} p */
  nodeRemove(p) {
    const wasActive = this.state.activeTabId;
    // Remember what is about to go, while parents/indexes still exist.
    const target = this.state.tree.nodes[p.nodeId];
    const doomedIds = target?.type === 'tab' ? [target.id]
      : target?.type === 'folder' ? tabIdsInSubtree(this.state.tree, target.id) : [];
    const remembered = doomedIds.flatMap((id) => {
      const n = tab(this.state.tree, id);
      if (!n) return [];
      const parent = folder(this.state.tree, n.parentId ?? '');
      return [{
        url: n.url, title: n.title, parentId: n.parentId ?? this.state.tree.rootId,
        index: parent ? parent.childIds.indexOf(id) : 0,
      }];
    });
    const res = removeNode(this.state.tree, p.nodeId);
    if (!res) return { error: 'cannot remove' };
    this.closedTabs.push(...remembered);
    if (this.closedTabs.length > 20) this.closedTabs.splice(0, this.closedTabs.length - 20);
    for (const tabId of res.removedTabIds) {
      const rt = this.runtime.get(tabId);
      if (rt) {
        this.runtime.delete(tabId);
        rt.view.destroy();
      }
      this.persist.deleteThumb(tabId);
      this.thumbSeq.delete(tabId);
      this.clearRunawayFor(tabId);
      this.runawaySnoozes.delete(tabId);
      if (this.state.activeTabId === tabId) this.state.activeTabId = null;
      this.dropPermissionAsks(tabId);
    }
    this.markDirty();
    // If the active tab was closed, hand focus to the most recent RUNNING tab.
    // We deliberately do NOT wake a sleeping tab just to fill the slot.
    if (wasActive && this.state.activeTabId === null) {
      const running = [...this.runtime.keys()]
        .map((id) => this.tabNode(id))
        .filter((n) => n != null)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      if (running[0]) this.tabActivate({ tabId: running[0].id });
    }
    this.emitSnapshot();
    return { ok: true };
  }

  /** @param {{ nodeId: string, parentId: string, index?: number }} p */
  nodeMove(p) {
    const ok = moveNode(this.state.tree, p.nodeId, p.parentId, p.index);
    if (ok) { this.markDirty(); this.emitSnapshot(); }
    return ok ? { ok: true } : { error: 'illegal move' };
  }

  // --------------------------------------------------------------- settings

  settingsGet() { return this.settings; }

  /** @param {Partial<import('../../shared/defaults.js').RahaSettings>} patch */
  settingsSet(patch) {
    const merged = { ...this.settings, ...patch };
    const { value, problems } = validateSettings(merged);
    this.settings = value;
    if (patch.restorePageState === false) {
      for (const id of allTabIds(this.state.tree)) {
        const n = this.tabNode(id);
        if (n) n.pageState = null;
      }
      for (const [, rt] of this.runtime) rt.pageState = null;
      this.markDirty();
    }
    this.persist.writeJsonAtomic(SETTINGS_FILE, this.settings);
    this.governNow();
    this.emitSnapshot();
    return { settings: this.settings, problems };
  }

  // ---------------------------------------------------------------- history

  /**
   * The UI opened/closed an overlay (settings, history, organize, prompts):
   * the chrome must be raised above the page view or centered modals render
   * invisibly BEHIND the active tab. Presentation-only — no state, no
   * snapshot.
   * @param {{ active?: boolean }} [p]
   */
  overlaySet(p) {
    if (typeof this.views.setChromeOnTop === 'function') {
      this.views.setChromeOnTop(Boolean(p?.active));
    }
    return { ok: true };
  }

  /**
   * Sidebar shown/hidden in the UI — the content view must take or return
   * its space. Presentation-only, like overlaySet.
   * @param {{ visible?: boolean }} [p]
   */
  sidebarSet(p) {
    if (typeof this.views.setSidebarVisible === 'function') {
      this.views.setSidebarVisible(p?.visible !== false);
    }
    return { ok: true };
  }

  /** Detected sources of OPEN windows & tabs (running browsers + session files). */
  openTabsSources() {
    if (!this.importers || typeof this.importers.scanOpenTabSources !== 'function') return { sources: [] };
    try {
      const list = this.importers.scanOpenTabSources();
      return { sources: Array.isArray(list) ? list : [] };
    } catch {
      return { sources: [] };
    }
  }

  /**
   * Copy another browser's open windows & tabs into the tree: one new
   * top-level folder per import, a subfolder per window (when there are
   * several), every tab created ASLEEP — urls + titles only, no renderer is
   * spawned. Each URL passes the tabCreate scheme gate (invariant #13); the
   * shared sanitizer has already capped counts and dropped non-http(s).
   * @param {{ sourceId?: string }} [p]
   */
  async openTabsImport(p) {
    if (!this.importers || typeof this.importers.readOpenTabs !== 'function') {
      return { error: 'import unavailable' };
    }
    const sourceId = typeof p?.sourceId === 'string' ? p.sourceId : '';
    if (!sourceId) return { error: 'no source selected' };
    let r;
    try { r = await this.importers.readOpenTabs(sourceId); } catch (err) {
      return { error: err instanceof Error ? err.message : 'read failed' };
    }
    /** @type {string[]} */
    const problems = Array.isArray(r?.problems) ? r.problems.map(String).slice(0, 20) : [];
    const { windows, dropped, truncated } = sanitizeWindows(Array.isArray(r?.windows) ? r.windows : []);
    if (windows.length === 0) {
      return { windows: 0, tabs: 0, problems: problems.length ? problems : ['no importable tabs found'] };
    }
    if (dropped > 0) problems.push(`${dropped} internal/non-web tabs skipped`);
    if (truncated) problems.push(`import capped at ${MAX_IMPORT_TABS} tabs`);

    const browser = typeof r?.browser === 'string' && r.browser ? r.browser.slice(0, 40) : 'Browser';
    const top = this.folderCreate({ name: `${browser} import` });
    if ('error' in top) return { error: 'could not create import folder' };
    let made = 0;
    for (let i = 0; i < windows.length; i += 1) {
      let folderId = top.folderId;
      if (windows.length > 1) {
        const sub = this.folderCreate({ name: `Window ${i + 1}`, parentId: top.folderId });
        if (!('error' in sub)) folderId = sub.folderId;
      }
      for (const t of windows[i].tabs) {
        const created = this.tabCreate({ url: t.url, folderId, activate: false });
        if ('error' in created) continue;
        const node = this.tabNode(created.tabId);
        if (node && t.title) node.title = t.title.slice(0, 300);
        made += 1;
      }
    }
    this.markDirty();
    this.emitSnapshot();
    this.toast('info', `Imported ${made} tabs from ${browser} (asleep, in “${browser} import”)`);
    return { windows: windows.length, tabs: made, problems };
  }

  /** Detected browser-history sources on this machine. */
  historySources() {
    if (!this.importers) return { sources: [] };
    try {
      const list = this.importers.scanHistorySources();
      return { sources: Array.isArray(list) ? list : [] };
    } catch {
      return { sources: [] };
    }
  }

  /**
   * Import history from previously scanned sources. History only — the
   * importers port never opens password/cookie stores. Entries are untrusted:
   * each one passes normalizeHistoryEntry (http/https only, capped strings).
   * @param {{ sourceIds?: string[] }} p
   */
  historyImport(p) {
    if (!this.importers) return { error: 'import unavailable' };
    const ids = Array.isArray(p?.sourceIds)
      ? p.sourceIds.filter((s) => typeof s === 'string').slice(0, 100)
      : [];
    if (ids.length === 0) return { error: 'no sources selected' };
    /** @type {string[]} */ const problems = [];
    /** @type {import('../../shared/history.js').HistoryEntry[]} */ const incoming = [];
    for (const id of ids) {
      let r;
      try { r = this.importers.readHistory(id); } catch (err) {
        problems.push(`${id}: ${err instanceof Error ? err.message : 'read failed'}`);
        continue;
      }
      if (Array.isArray(r?.problems)) problems.push(...r.problems.map(String));
      if (!Array.isArray(r?.entries)) continue;
      for (const raw of r.entries) {
        const e = normalizeHistoryEntry(raw);
        if (e) incoming.push(e);
      }
    }
    const { entries, added, updated } = mergeHistory(this.history.entries, incoming);
    this.history.entries = entries;
    this.persist.writeJsonAtomic(HISTORY_FILE, { schemaVersion: HISTORY_SCHEMA_VERSION, entries });
    if (added > 0) this.toast('info', `Imported ${added} history entries`);
    return { added, updated, total: entries.length, problems: problems.slice(0, 20) };
  }

  /**
   * Import a history database file the user picked in a native dialog.
   * The path is supplied by the ipc adapter (which owns the dialog), never
   * by the renderer — IPC still cannot name files (see importers port note).
   * Exists mainly so Safari history can be imported without Full Disk
   * Access, from a copy of History.db the user makes in Finder.
   * @param {string} filePath
   */
  historyImportFile(filePath) {
    if (!this.importers || typeof this.importers.readHistoryFile !== 'function') {
      return { error: 'import unavailable' };
    }
    /** @type {string[]} */ const problems = [];
    /** @type {import('../../shared/history.js').HistoryEntry[]} */ const incoming = [];
    let r;
    try { r = this.importers.readHistoryFile(filePath); } catch (err) {
      return { error: err instanceof Error ? err.message : 'read failed' };
    }
    if (Array.isArray(r?.problems)) problems.push(...r.problems.map(String));
    if (Array.isArray(r?.entries)) {
      for (const raw of r.entries) {
        const e = normalizeHistoryEntry(raw);
        if (e) incoming.push(e);
      }
    }
    const { entries, added, updated } = mergeHistory(this.history.entries, incoming);
    this.history.entries = entries;
    this.persist.writeJsonAtomic(HISTORY_FILE, { schemaVersion: HISTORY_SCHEMA_VERSION, entries });
    if (added > 0) this.toast('info', `Imported ${added} history entries`);
    return { added, updated, total: entries.length, problems: problems.slice(0, 20) };
  }

  /**
   * Search the store. Pull-only on purpose: history is too large to ride
   * along in every snapshot push, so the UI asks when its panel is open.
   * @param {{ query?: string, limit?: number, offset?: number, suggest?: boolean }} [p]
   */
  historyList(p) {
    if (p?.suggest) {
      // Omnibox ranking: visit count then recency over ALL matches — the
      // panel's recency slice below would starve frequently-visited pages.
      const entries = suggestHistory(this.history.entries, p?.query ?? '', p?.limit ?? 6);
      return { entries, total: entries.length };
    }
    const r = searchHistory(this.history.entries, p?.query ?? '', p?.limit ?? 200, p?.offset ?? 0);
    return { entries: r.entries, total: r.total };
  }

  historyClear() {
    this.history.entries = [];
    this.persist.writeJsonAtomic(HISTORY_FILE, { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] });
    return { ok: true };
  }

  // -------------------------------------------------------------- organizer

  /** Plain-data view of the tree for the organizer (shared/organize.js). */
  organizeInputs() {
    /** @type {Array<{ id: string, parentId: string, url: string }>} */
    const tabs = [];
    for (const id of allTabIds(this.state.tree)) {
      const node = tab(this.state.tree, id);
      if (node) tabs.push({ id: node.id, parentId: node.parentId, url: node.url });
    }
    /** @type {Array<{ id: string, parentId: string|null, name: string }>} */
    const folders = [];
    for (const node of Object.values(this.state.tree.nodes)) {
      if (node.type === 'folder' && node.id !== this.state.tree.rootId) {
        folders.push({ id: node.id, parentId: node.parentId, name: node.name });
      }
    }
    return { tabs, folders };
  }

  /** Dry run for the UI's confirm dialog: the plan plus tab titles. */
  organizePreview() {
    const { tabs, folders } = this.organizeInputs();
    const plan = planOrganize(tabs, folders, this.state.tree.rootId);
    const groups = plan.groups.map((g) => ({
      name: g.name,
      folderId: g.folderId,
      tabs: g.tabIds.map((id) => ({ id, title: this.tabNode(id)?.title ?? '' })),
    }));
    return { groups, loose: plan.loose, leftover: plan.leftover };
  }

  /**
   * Recompute the plan and apply it. The plan is recomputed rather than
   * accepted from the UI so IPC can never inject arbitrary moves.
   */
  organizeApply() {
    const { tabs, folders } = this.organizeInputs();
    const plan = planOrganize(tabs, folders, this.state.tree.rootId);
    let moved = 0;
    let foldersCreated = 0;
    for (const g of plan.groups) {
      let folderId = g.folderId;
      if (!folderId) {
        const f = addFolder(this.state.tree, { name: g.name });
        if (!f) continue;
        folderId = f.id;
        foldersCreated += 1;
      }
      for (const tabId of g.tabIds) {
        if (moveNode(this.state.tree, tabId, folderId)) moved += 1;
      }
    }
    if (moved > 0) {
      this.markDirty();
      this.toast('info', `Organized ${moved} ${moved === 1 ? 'tab' : 'tabs'} into ${plan.groups.length} ${plan.groups.length === 1 ? 'folder' : 'folders'}`);
    }
    this.emitSnapshot();
    return { moved, foldersCreated };
  }

  // ----------------------------------------------------------- page state

  /** Fire-and-forget capture of a running tab's scroll + form state (R-104). */
  capturePageState(/** @type {string} */ tabId) {
    if (!this.settings.restorePageState) return;
    const rt = this.runtime.get(tabId);
    if (!rt || rt.loading) return;
    void rt.view.capturePageState().then((/** @type {unknown} */ raw) => {
      const cur = this.runtime.get(tabId);
      if (cur !== rt) return; // tab slept/closed while the capture was in flight
      rt.pageState = sanitizePageState(raw);
    });
  }

  // --------------------------------------------------------------- governor

  /** Run the policy against current runtime state and execute its actions. */
  governNow() {
    const tabs = this.policyView();
    const { actions, warnings } = decide(tabs, this.settings, this.now());
    for (const a of actions) this.tabSleep({ tabId: a.tabId }, a.reason);
    for (const w of warnings) {
      if (w.kind === 'active-over-limit') {
        const node = this.tabNode(w.tabId);
        this.toast('warn', `Active tab exceeds its memory limit: ${node ? node.title : w.tabId}`);
      }
    }
    return { actions, warnings };
  }

  /** Governor loop body: refresh metrics, then govern. Called every ~2.5s. */
  tick() {
    const sample = this.metrics.sample();
    /** @type {Map<number, { memMB: number, cpuPct: number }>} */
    const byPid = new Map();
    for (const m of sample) byPid.set(m.pid, { memMB: m.memMB, cpuPct: m.cpuPct });

    /** @type {Map<number, number>} */
    const pidTabCount = new Map();
    for (const [, rt] of this.runtime) {
      rt.pid = rt.view.getOSPid();
      if (rt.pid != null) pidTabCount.set(rt.pid, (pidTabCount.get(rt.pid) ?? 0) + 1);
    }
    for (const [, rt] of this.runtime) {
      const m = rt.pid != null ? byPid.get(rt.pid) : undefined;
      rt.memMB = m ? m.memMB : null;
      rt.cpuPct = m ? m.cpuPct : null;
      rt.memShared = rt.pid != null && (pidTabCount.get(rt.pid) ?? 0) > 1;
      // Runaway streaks. Tabs on a SHARED renderer pid never accrue either
      // streak: the pid's usage is double-attributed to every tab on it, so
      // there is no fair way to name one tab as the culprit — prompting
      // could tell the user to terminate an innocent neighbor.
      rt.cpuHotTicks = rt.cpuPct != null && !rt.memShared && rt.cpuPct >= RUNAWAY.cpuPct ? rt.cpuHotTicks + 1 : 0;
      rt.memHotTicks = rt.memMB != null && !rt.memShared && rt.memMB >= RUNAWAY.memMB ? rt.memHotTicks + 1 : 0;
    }
    if (this.state.activeTabId) this.capturePageState(this.state.activeTabId);
    const result = this.governNow();
    this.updateRunaway(); // after governNow: a tab the governor slept can't prompt
    this.flushPersist();
    this.flushHistory();
    this.emitSnapshot();
    return result;
  }

  /** Batched history.json write (see historyDirty in the constructor). */
  flushHistory(force = false) {
    if (!this.historyDirty) return;
    if (!force && this.now() - this.lastHistoryWriteMs < HISTORY_WRITE_MS) return;
    this.historyDirty = false;
    this.lastHistoryWriteMs = this.now();
    this.persist.writeJsonAtomic(HISTORY_FILE, { schemaVersion: HISTORY_SCHEMA_VERSION, entries: this.history.entries });
  }

  /** Keep this.runawayAlert honest: one prompt, only while the tab stays hot. */
  updateRunaway() {
    if (!this.settings.runawayGuard) { this.runawayAlert = null; return; }
    const now = this.now();
    for (const [id, until] of this.runawaySnoozes) {
      if (until <= now) this.runawaySnoozes.delete(id); // expired, keep the map tiny
    }
    const snoozed = (/** @type {string} */ tabId) => (this.runawaySnoozes.get(tabId) ?? 0) > now;
    const assess = (/** @type {Runtime} */ rt) => runawayAssess(
      { cpuHotTicks: rt.cpuHotTicks, memHotTicks: rt.memHotTicks, audible: rt.audible },
      this.settings,
    );
    if (this.runawayAlert) {
      const rt = this.runtime.get(this.runawayAlert.tabId);
      const kind = rt && !snoozed(this.runawayAlert.tabId) ? assess(rt) : null;
      if (rt && kind) { this.runawayAlert = { tabId: this.runawayAlert.tabId, kind }; return; }
      this.runawayAlert = null; // slept, closed, snoozed, or calmed down
    }
    /** @type {{ tabId: string, kind: 'cpu'|'mem', score: number }|null} */
    let worst = null;
    for (const [tabId, rt] of this.runtime) {
      if (snoozed(tabId)) continue;
      const kind = assess(rt);
      if (!kind) continue;
      const score = kind === 'mem' ? 1_000_000 + (rt.memMB ?? 0) : rt.cpuPct ?? 0;
      if (!worst || score > worst.score) worst = { tabId, kind, score };
    }
    this.runawayAlert = worst ? { tabId: worst.tabId, kind: worst.kind } : null;
  }

  /** Drop the open prompt if it names this tab — for out-of-tick exits
   * (manual sleep, crash, close), so the UI never shows a prompt for a tab
   * that is already gone. Callers emit their own snapshot right after.
   * @param {string} tabId */
  clearRunawayFor(tabId) {
    if (this.runawayAlert?.tabId === tabId) this.runawayAlert = null;
  }

  /**
   * The user answered the runaway prompt.
   * 'sleep' terminates the renderer now (Raha's sleep IS process death —
   * the page, history and tree position survive); 'snooze' quiets prompts
   * for that tab for RUNAWAY.snoozeMs (survives sleep/wake in the window).
   * Always emits a snapshot — even on error the prompt must leave the screen.
   * @param {{ tabId?: string, action?: string }} p
   */
  runawayResolve(p) {
    const tabId = typeof p?.tabId === 'string' ? p.tabId : '';
    this.clearRunawayFor(tabId);
    /** @type {{ ok: boolean }|{ error: string }} */
    let result;
    if (p?.action === 'sleep') {
      result = this.tabSleep({ tabId }, 'runaway');
    } else if (p?.action === 'snooze') {
      if (this.runtime.has(tabId)) {
        this.runawaySnoozes.set(tabId, this.now() + RUNAWAY.snoozeMs);
        result = { ok: true };
      } else {
        result = { error: 'not running' };
      }
    } else {
      result = { error: 'bad action' };
    }
    this.emitSnapshot();
    return result;
  }

  /** The governor's view of the world (input to the pure policy). */
  policyView() {
    return allTabIds(this.state.tree).map((id) => {
      const node = /** @type {import('../../shared/tree.js').TabNode} */ (this.tabNode(id));
      const rt = this.runtime.get(id);
      const eff = this.effPolicy(node);
      return {
        id,
        running: Boolean(rt),
        isActive: this.state.activeTabId === id,
        keepAlive: eff.keepAlive,
        audible: rt ? rt.audible : false,
        lastActiveAt: node.lastActiveAt,
        memMB: rt ? rt.memMB : null,
        memLimitMB: eff.memLimitMB,
      };
    });
  }

  // ------------------------------------------------------------ persistence

  flushPersist() {
    if (!this.dirty) return;
    this.dirty = false;
    this.persist.writeJsonAtomic(STATE_FILE, {
      schemaVersion: this.state.schemaVersion,
      tree: this.state.tree,
      activeTabId: this.state.activeTabId,
    });
  }

  /** Graceful quit: save nav history + page state of running tabs, persist everything. */
  shutdown() {
    for (const [tabId, rt] of this.runtime) {
      const node = this.tabNode(tabId);
      if (!node) continue;
      try {
        const nav = rt.view.getNav();
        node.navJson = nav.navJson ?? null;
      } catch { /* url restore fallback */ }
      node.pageState = rt.pageState;
    }
    this.markDirty();
    this.flushPersist();
    this.flushHistory(true); // force: quit must never drop recorded visits
  }

  // -------------------------------------------------------------- first run

  /**
   * Seed the first-run experience: the welcome tour open and active, plus a
   * "Try these" folder of asleep example tabs that demonstrate wake-on-click
   * without loading anything until clicked. Idempotent by construction: the
   * wiring layer only calls this when `firstRun` is true (no state file).
   */
  seedWelcome() {
    const now = this.now();
    const examples = this.folderCreate({ name: 'Try these' });
    if ('folderId' in examples) {
      const seed = [
        { url: 'https://en.wikipedia.org/wiki/Working_memory', title: 'Working memory — Wikipedia' },
        { url: 'https://news.ycombinator.com/', title: 'Hacker News' },
        { url: 'https://www.eff.org/', title: 'Electronic Frontier Foundation' },
      ];
      for (const s of seed) {
        const node = addTab(this.state.tree, { url: s.url, parentId: examples.folderId, now });
        if (node) node.title = s.title; // stays ASLEEP: zero network, zero RAM
      }
    }
    this.tabCreate({ url: 'raha://welcome', activate: true });
    this.markDirty();
    this.flushPersist();
    this.emitSnapshot();
  }

  // ---------------------------------------------------------------- thumbs

  /** @param {string} tabId */
  bumpThumb(tabId) {
    this.thumbSeq.set(tabId, (this.thumbSeq.get(tabId) ?? 0) + 1);
    this.emitSnapshot();
  }

  // -------------------------------------------------------------- snapshot

  /** Build the full UI snapshot. @returns {import('../../shared/ipc-contract.js').Snapshot} */
  snapshot() {
    const t = this.state.tree;
    /** @type {import('../../shared/ipc-contract.js').SnapshotTab[]} */
    const tabs = [];
    for (const id of allTabIds(t)) {
      const node = /** @type {import('../../shared/tree.js').TabNode} */ (tab(t, id));
      const rt = this.runtime.get(id);
      const eff = this.effPolicy(node);
      tabs.push({
        id,
        parentId: node.parentId,
        url: node.url,
        title: node.title,
        faviconUrl: node.faviconUrl,
        state: this.state.activeTabId === id ? 'active' : rt ? 'running' : 'asleep',
        keepAlive: node.keepAlive,
        keepAliveEffective: eff.keepAlive,
        memLimitMB: eff.memLimitMB,
        memMB: rt ? rt.memMB : null,
        cpuPct: rt ? rt.cpuPct : null,
        memShared: rt ? rt.memShared : false,
        audible: rt ? rt.audible : false,
        loading: rt ? rt.loading : false,
        canGoBack: rt ? rt.canGoBack : false,
        canGoForward: rt ? rt.canGoForward : false,
        lastActiveAt: node.lastActiveAt,
        thumbSeq: this.thumbSeq.get(id) ?? 0,
        blockedCount: rt ? rt.blockedCount : 0,
      });
    }
    /** @type {import('../../shared/ipc-contract.js').SnapshotFolder[]} */
    const folders = [];
    for (const n of Object.values(t.nodes)) {
      if (n.type === 'folder') {
        folders.push({ id: n.id, parentId: n.parentId, name: n.name, childIds: [...n.childIds], collapsed: n.collapsed });
      }
    }
    const totalMemMB = [...this.runtime.values()].reduce((s, rt) => s + (rt.memMB ?? 0), 0);
    return {
      tabs,
      folders,
      rootId: t.rootId,
      activeTabId: this.state.activeTabId,
      settings: this.settings,
      stats: {
        runningCount: this.runtime.size,
        totalMemMB: Math.round(totalMemMB),
        maxLiveTabs: this.settings.maxLiveTabs,
      },
      runaway: this.runawayAlert ? { ...this.runawayAlert } : null,
    };
  }
}

/** Answer every waiter of an ask (coalesced asks share one entry). @param {PermissionAsk} ask @param {boolean} granted */
function settleAsk(ask, granted) {
  const waiters = ask.resolvers;
  ask.resolvers = [];
  for (const resolve of waiters) resolve(granted);
}

/** The ask as the UI sees it — no resolvers, a copy of the kinds. @param {PermissionAsk} a */
function publicAsk(a) {
  return { id: a.id, tabId: a.tabId, kinds: [...a.kinds], host: a.host, requestingHost: a.requestingHost, isMainFrame: a.isMainFrame };
}

/** @param {'tab-limit'|'idle'|'cap'|'global-budget'|'runaway'} reason */
function sleepReasonText(reason) {
  switch (reason) {
    case 'tab-limit': return 'Over its memory limit';
    case 'idle': return 'Idle too long';
    case 'cap': return 'Live-tab cap reached';
    case 'global-budget': return 'Memory budget reached';
    case 'runaway': return 'Terminated at your request';
    default: return 'Slept';
  }
}
