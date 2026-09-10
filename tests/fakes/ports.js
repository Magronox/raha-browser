// Fake ports for testing the Engine without Electron. The fakes emulate the
// contracts documented at the top of src/main/core/engine.js. If you change
// a port contract there, update these fakes AND the electron adapters in the
// same commit (docs/INVARIANTS.md #3).
import { sanitizeNavEntries } from '../../src/shared/urls.js';

/** One fake renderer view. */
export class FakeView {
  /** @param {string} tabId @param {any} cb @param {FakeWorld} world */
  constructor(tabId, cb, world) {
    this.tabId = tabId;
    this.cb = cb;
    this.world = world;
    this.pid = world.nextPid++;
    this.url = null;
    this.attached = false;
    this.destroyed = false;
    this.history = /** @type {string[]} */ ([]);
    this.historyIndex = -1;
    this.zoomLevel = 0;
    this.thumbCaptures = 0;
    /** @type {number|null} active find ordinal; null = no session */
    this.findOrdinal = null;
  }
  /** @param {string} url */
  loadURL(url) {
    this.url = url;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    this.cb.onLoading(true);
    this.cb.onUrl(url, this.historyIndex > 0, false);
    // Simulate synchronous "load finished" — tests stay deterministic.
    this.cb.onTitle(`Title of ${url}`);
    this.cb.onLoading(false);
  }
  /** @param {string} navJson */
  restoreHistory(navJson) {
    try {
      const parsed = JSON.parse(navJson);
      // Mirrors the real adapter's entry filter (docs/INVARIANTS.md #3).
      const safe = sanitizeNavEntries(parsed);
      if (!safe) return false;
      this.history = safe.entries.map((/** @type {any} */ e) => e.url);
      this.historyIndex = Math.min(safe.index, this.history.length - 1);
      const url = this.history[this.historyIndex];
      this.cb.onUrl(url, this.historyIndex > 0, this.historyIndex < this.history.length - 1);
      return true;
    } catch {
      return false;
    }
  }
  getNav() {
    return {
      canGoBack: this.historyIndex > 0,
      canGoForward: this.historyIndex < this.history.length - 1,
      navJson: JSON.stringify({ entries: this.history.map((u) => ({ url: u, title: '' })), index: this.historyIndex }),
    };
  }
  destroy() {
    this.destroyed = true;
    this.world.destroyedPids.push(this.pid);
    this.cb.onDestroyed();
  }
  focus() { this.world.focusLog.push(this.tabId); }
  back() { if (this.historyIndex > 0) { this.historyIndex--; this.cb.onUrl(this.history[this.historyIndex], this.historyIndex > 0, true); } }
  forward() { if (this.historyIndex < this.history.length - 1) { this.historyIndex++; this.cb.onUrl(this.history[this.historyIndex], true, this.historyIndex < this.history.length - 1); } }
  reload() { if (this.url) this.loadURL(this.url); }
  hardReload() { this.world.ops.push(`hardReload:${this.tabId}`); if (this.url) this.loadURL(this.url); }
  stop() { this.cb.onLoading(false); }
  /**
   * Find in page: deterministic fake. Every non-empty needle "matches"
   * world.findMatches times; a new session lands on 1, next/prev cycle.
   * Mirrors the real adapter contract: newSession=true begins a session
   * (Electron's confusingly-named findNext flag), and results arrive via
   * cb.onFindResult like the real found-in-page event.
   * @param {string} text @param {{forward?: boolean, newSession?: boolean}} [opts]
   */
  findInPage(text, opts) {
    const total = this.world.findMatches;
    if (opts?.newSession || this.findOrdinal == null) this.findOrdinal = total > 0 ? 1 : 0;
    else if (total > 0) {
      const dir = (opts?.forward ?? true) ? 1 : -1;
      this.findOrdinal = ((this.findOrdinal - 1 + dir + total) % total) + 1;
    }
    this.world.ops.push(`find:${this.tabId}:${text}:${opts?.newSession ? 'new' : (opts?.forward ?? true) ? 'next' : 'prev'}`);
    this.cb.onFindResult(total, this.findOrdinal);
  }
  /** @param {'clearSelection'|'keepSelection'} action */
  stopFind(action) {
    this.findOrdinal = null;
    this.world.ops.push(`stopFind:${this.tabId}:${action}`);
  }
  getOSPid() { return this.destroyed ? null : this.pid; }
  /** @param {boolean} b */
  setAttached(b) { this.attached = b; }
  captureThumb() { this.thumbCaptures += 1; return Promise.resolve(true); }
  /** @param {'in'|'out'|'reset'} dir */
  zoom(dir) { this.zoomLevel = dir === 'reset' ? 0 : this.zoomLevel + (dir === 'in' ? 1 : -1); }

  capturePageState() {
    if (this.destroyed) return Promise.resolve(null);
    const sy = this.scrollY ?? 0;
    const sx = this.scrollX ?? 0;
    const fields = this.fields ?? [];
    if (sx === 0 && sy === 0 && fields.length === 0) return Promise.resolve(null);
    return Promise.resolve({ v: 1, url: this.url, at: this.world.clock, sx, sy, fields });
  }
  /** @param {any} state */
  restorePageState(state) {
    this.restoredPageState = state;
    this.world.ops.push(`restorePageState:${this.tabId}`);
  }

  // test state for page-state capture (R-104)
  /** @type {number} */ scrollY = 0;
  /** @type {number} */ scrollX = 0;
  /** @type {any[]} */ fields = [];
  /** @type {any} */ restoredPageState = null;

  simulateScroll(/** @type {number} */ y, x = 0) { this.scrollY = y; this.scrollX = x; }
  simulateFormInput(/** @type {any[]} */ f) { this.fields = f; }

  // test helpers
  simulateAudio(/** @type {boolean} */ audible) { this.cb.onAudible(audible); }
  /** Main-frame load failure: mirrors the real adapter's did-fail-load —
   * onLoadFailed first, then the error page's synthetic title. */
  simulateLoadFailure() { this.cb.onLoadFailed(); this.cb.onTitle('Failed to load'); }
  simulateCrash() { this.destroyed = true; this.cb.onDestroyed(); }
  simulatePopup(/** @type {string} */ url) { this.cb.onOpenUrl(url); }
  simulateSearchSelection(/** @type {string} */ text) { this.cb.onSearchSelection(text); }
}

/** Shared world so tests can inspect and control everything. */
export class FakeWorld {
  constructor() {
    this.nextPid = 1000;
    /** @type {Map<string, FakeView>} */
    this.viewsByTab = new Map();
    /** @type {number[]} */
    this.destroyedPids = [];
    /** @type {string[]} */
    this.focusLog = [];
    /** @type {Map<number, { memMB: number, cpuPct: number }>} */
    this.pidMetrics = new Map();
    /** @type {Map<string, any>} */
    this.files = new Map();
    /** @type {string[]} */
    this.deletedThumbs = [];
    /** @type {any[]} */
    this.events = [];
    this.clock = 1_800_000_000_000;
    this.chromeOnTop = false;
    this.sidebarVisible = true;
    /** @type {string[]} recorded view ops (e.g. 'hardReload:<tabId>') */
    this.ops = [];
    /** @type {string[]} urls handed to the OS via the shell port */
    this.openedExternally = [];
    /** Set to make the shell port throw (app not installed). */
    this.shellThrows = false;
    /** Matches every FakeView reports for any non-empty find needle. */
    this.findMatches = 3;
    /** @type {Array<{ id: string, browser: string, label: string, kind: string }>} */
    this.historySources = [];
    /** @type {Array<{ id: string, browser: string, label: string, kind: string }>} */
    this.openTabSources = [];
    /** @type {Map<string, { browser: string, windows: Array<{tabs: Array<{url: string, title: string}>}>, problems: string[] }>} */
    this.openTabsBySource = new Map();
    /** @type {Map<string, { entries: any[], problems: string[] }>} */
    this.historyBySource = new Map();
  }

  ports() {
    const world = this;
    return {
      views: {
        /** @param {string} tabId @param {any} cb */
        create(tabId, cb) {
          const v = new FakeView(tabId, cb, world);
          world.viewsByTab.set(tabId, v);
          return v;
        },
        /** @param {boolean} on */
        setChromeOnTop(on) { world.chromeOnTop = Boolean(on); },
        /** @param {boolean} visible */
        setSidebarVisible(visible) { world.sidebarVisible = Boolean(visible); },
      },
      shell: {
        /** @param {string} url */
        openExternal(url) {
          if (world.shellThrows) throw new Error('no handler');
          world.openedExternally.push(url);
        },
      },
      metrics: {
        sample() {
          const out = [];
          for (const [pid, m] of world.pidMetrics) out.push({ pid, memMB: m.memMB, cpuPct: m.cpuPct });
          return out;
        },
      },
      persist: {
        /** @param {string} name */
        readJson(name) { return world.files.get(name); },
        /** @param {string} name @param {any} obj */
        writeJsonAtomic(name, obj) { world.files.set(name, JSON.parse(JSON.stringify(obj))); },
        /** @param {string} tabId */
        deleteThumb(tabId) { world.deletedThumbs.push(tabId); },
      },
      importers: {
        scanHistorySources() { return world.historySources.map((s) => ({ ...s })); },
        /** @param {string} sourceId */
        readHistory(sourceId) {
          return world.historyBySource.get(sourceId) ?? { entries: [], problems: [`unknown source ${sourceId}`] };
        },
        scanOpenTabSources() { return world.openTabSources.map((s) => ({ ...s })); },
        /** @param {string} sourceId */
        readOpenTabs(sourceId) {
          return Promise.resolve(
            world.openTabsBySource.get(sourceId)
              ?? { browser: '?', windows: [], problems: [`unknown source ${sourceId}`] },
          );
        },
      },
      now: () => world.clock,
      onEvent: (/** @type {any} */ evt) => world.events.push(evt),
    };
  }

  /** Set metrics for the CURRENT pid of a tab. @param {string} tabId */
  setTabMetrics(tabId, /** @type {number} */ memMB, cpuPct = 1) {
    const v = this.viewsByTab.get(tabId);
    if (!v) throw new Error(`no view for ${tabId}`);
    this.pidMetrics.set(v.pid, { memMB, cpuPct });
  }

  advanceMinutes(/** @type {number} */ min) { this.clock += min * 60_000; }
  toasts() { return this.events.filter((e) => e.type === 'toast'); }
}
