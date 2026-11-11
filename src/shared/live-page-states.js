// Each sleeping tab's Chromium page states, by back/forward entry, held IN
// MEMORY ONLY by the views adapter (src/main/electron/views.js).
//
// Copied from 1.0 for 0.3.2. Why: state.json keeps each entry's url and
// title only (cleanNavJson), but a restored entry without its page state
// makes a failed Back commit its error page over the entry the user came
// from, so a dead entry (a blob:) trapped Back after a sleep
// (shared/urls.js withLivePageStates). Never serialised: nothing here is
// in the engine's tree, and getNav's navJson is cleaned before it leaves
// the adapter. A page state can
// hold form text, so this store is bounded and obeys the user:
//   - only while restorePageState is on (the adapter records nothing when
//     it is off, and clears the store when it is turned off);
//   - never the active entry's (what the page on screen shows on waking is
//     R-104's job, under the same setting);
//   - taken by the tab's next view, forgotten when the tab closes, gone at quit;
//   - a single state over LIVE_STATE_MAX_CHARS is not kept, and past
//     LIVE_STATES_BUDGET_CHARS in all (or LIVE_STATE_TABS tabs) the tabs
//     that slept longest ago are dropped first.
// Pure: no electron, no node (docs/INVARIANTS.md #1).

/** One page state larger than this (base64 text: chars = bytes) is not kept. */
export const LIVE_STATE_MAX_CHARS = 256 * 1024;
/** All tabs' page states together stay under this. */
export const LIVE_STATES_BUDGET_CHARS = 16 * 1024 * 1024;
/** At most this many sleeping tabs. */
export const LIVE_STATE_TABS = 200;

/** @typedef {{ urls: string[], states: (string|null)[] }} LiveStates */

/**
 * @param {{ enabled?: () => boolean, maxChars?: number, budgetChars?: number, maxTabs?: number }} [limits]
 *   enabled: the restorePageState setting, read at each record and take (off = nothing kept, nothing given)
 */
export function createLivePageStates(limits = {}) {
  const enabled = () => { try { return limits.enabled ? limits.enabled() === true : true; } catch { return false; } };
  const maxChars = limits.maxChars ?? LIVE_STATE_MAX_CHARS;
  const budget = limits.budgetChars ?? LIVE_STATES_BUDGET_CHARS;
  const maxTabs = limits.maxTabs ?? LIVE_STATE_TABS;
  /** Insertion order = the order tabs slept in. @type {Map<string, LiveStates & { chars: number }>} */
  const byTab = new Map();
  let total = 0;

  /** @param {string} tabId */
  const drop = (tabId) => {
    const had = byTab.get(tabId);
    if (!had) return;
    total -= had.chars;
    byTab.delete(tabId);
  };

  return {
    /**
     * A tab is going to sleep: keep the page states of the entries Back and
     * Forward lead to (never the active one's), replacing what it had.
     * @param {string} tabId
     * @param {unknown[]} entries navigationHistory.getAllEntries(), already capped
     * @param {number} index the active entry
     */
    record(tabId, entries, index) {
      drop(tabId);
      if (!enabled()) return;
      /** @type {string[]} */ const urls = [];
      /** @type {(string|null)[]} */ const states = [];
      let chars = 0;
      for (const [i, e] of entries.entries()) {
        const any = /** @type {any} */ (e);
        const st = any?.pageState;
        const keep = i !== index && typeof st === 'string' && st.length > 0 && st.length <= maxChars;
        urls.push(String(any?.url ?? ''));
        states.push(keep ? st : null);
        if (keep) chars += st.length;
      }
      if (chars === 0) return;
      byTab.set(tabId, { urls, states, chars });
      total += chars;
      for (const k of byTab.keys()) {
        if (byTab.size <= maxTabs && total <= budget) break;
        if (k === tabId) break; // the newest alone never goes
        drop(k);
      }
    },
    /** The tab's next view takes them, once. @param {string} tabId @returns {LiveStates|null} */
    take(tabId) {
      const had = byTab.get(tabId);
      drop(tabId);
      return had && enabled() ? { urls: had.urls, states: had.states } : null;
    },
    /** The tab closed. @param {string} tabId */
    forget(tabId) { drop(tabId); },
    /** restorePageState turned off: everything goes. */
    clear() { byTab.clear(); total = 0; },
    size() { return byTab.size; },
    chars() { return total; },
  };
}
