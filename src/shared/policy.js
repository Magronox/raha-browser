// ============================================================================
// THE RESOURCE GOVERNOR POLICY — the heart of Raha.
// ============================================================================
// Given a snapshot of running tabs + the user's settings, decide which tabs
// must be put to sleep right now, and why. 100% pure: no electron, no io, no
// clocks (the caller passes `now`). Every behavior here is pinned by
// tests/unit/policy.test.js — change behavior and tests together, never one.
//
// Vocabulary (used across the whole codebase and the UI):
// - "running"  = the tab has a live renderer process (active OR background).
// - "active"   = the one running tab currently shown to the user.
// - "asleep"   = no renderer process. Zero RAM, zero CPU. Thumbnail + URL kept.
// - "keepAlive"= user or a domain rule pinned this tab: LRU/cap/idle never
//                touch it. Only its own per-tab memory limit can sleep it.
//
// Rule order (highest precedence first):
//   1. per-tab memory limit  — a running tab above its own limit sleeps,
//      even if keepAlive (the user asked for THIS limit on THIS tab).
//      Exception: the ACTIVE tab is never auto-slept; we warn instead.
//   2. idle timeout          — background, non-keepAlive tabs idle too long.
//   3. max live tabs cap     — evict least-recently-active background tabs
//      until the count of running tabs fits settings.maxLiveTabs.
//   4. global memory budget  — if the sum of running tabs' memory exceeds
//      settings.globalBudgetMB, evict LRU background tabs until it fits.
// Audio: tabs currently playing sound are skipped by rules 2-4 when
// settings.protectAudio is on (music keeps playing). Rule 1 still applies.
//
// Separate from the sleep rules: the RUNAWAY GUARD (runawayAssess below).
// It never sleeps anything by itself — it decides when sustained CPU/memory
// use warrants ASKING the user to terminate a tab (settings.runawayGuard).
// The engine keeps per-tab hot-streak counters across ticks and prompts on
// the answer; the user's click is what actually sleeps the tab.
// ============================================================================

/**
 * @typedef {Object} PolicyTab   One running-or-not tab as the governor sees it.
 * @property {string} id
 * @property {boolean} running   has a live renderer right now
 * @property {boolean} isActive  is THE focused tab (implies running)
 * @property {boolean} keepAlive effective keep-alive (per-tab flag OR domain rule)
 * @property {boolean} audible   currently playing sound
 * @property {number}  lastActiveAt ms epoch of last time this tab was the active tab
 * @property {number|null} memMB    latest sampled working-set, null = not sampled yet
 * @property {number|null} memLimitMB effective per-tab limit (per-tab or domain rule), null = none
 */

/**
 * @typedef {Object} SleepAction
 * @property {'sleep'} type
 * @property {string} tabId
 * @property {'tab-limit'|'idle'|'cap'|'global-budget'} reason
 */

/**
 * @typedef {Object} PolicyWarning
 * @property {string} tabId
 * @property {'active-over-limit'|'cap-unsatisfiable'|'budget-unsatisfiable'} kind
 */

/**
 * @param {PolicyTab[]} tabs snapshot of ALL tabs (running and asleep)
 * @param {{ maxLiveTabs: number, idleSleepMinutes: number, globalBudgetMB: number, protectAudio: boolean }} settings
 * @param {number} now ms epoch
 * @returns {{ actions: SleepAction[], warnings: PolicyWarning[] }}
 */
export function decide(tabs, settings, now) {
  /** @type {SleepAction[]} */ const actions = [];
  /** @type {PolicyWarning[]} */ const warnings = [];
  const sleeping = new Set(); // tabIds already chosen to sleep this round

  const running = tabs.filter((t) => t.running);

  // ---- Rule 1: per-tab memory limit (beats keepAlive; never the active tab)
  for (const t of running) {
    if (t.memLimitMB != null && t.memMB != null && t.memMB > t.memLimitMB) {
      if (t.isActive) {
        warnings.push({ tabId: t.id, kind: 'active-over-limit' });
      } else {
        actions.push({ type: 'sleep', tabId: t.id, reason: 'tab-limit' });
        sleeping.add(t.id);
      }
    }
  }

  const protectedByAudio = (/** @type {PolicyTab} */ t) => settings.protectAudio && t.audible;
  const evictable = (/** @type {PolicyTab} */ t) =>
    !t.isActive && !t.keepAlive && !protectedByAudio(t) && !sleeping.has(t.id);

  // ---- Rule 2: idle timeout
  if (settings.idleSleepMinutes > 0) {
    const cutoff = now - settings.idleSleepMinutes * 60_000;
    for (const t of running) {
      if (evictable(t) && t.lastActiveAt > 0 && t.lastActiveAt < cutoff) {
        actions.push({ type: 'sleep', tabId: t.id, reason: 'idle' });
        sleeping.add(t.id);
      }
    }
  }

  // Helper: LRU-ordered list of currently evictable running tabs.
  const lru = () =>
    running
      .filter(evictable)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt || (a.id < b.id ? -1 : 1));

  // ---- Rule 3: max live tabs cap
  const stillRunning = () => running.filter((t) => !sleeping.has(t.id));
  let excess = stillRunning().length - settings.maxLiveTabs;
  if (excess > 0) {
    for (const victim of lru()) {
      if (excess <= 0) break;
      actions.push({ type: 'sleep', tabId: victim.id, reason: 'cap' });
      sleeping.add(victim.id);
      excess -= 1;
    }
    if (stillRunning().length > settings.maxLiveTabs) {
      // Cap can't be met because active/keepAlive/audible tabs alone exceed it.
      warnings.push({ tabId: '', kind: 'cap-unsatisfiable' });
    }
  }

  // ---- Rule 4: global memory budget
  if (settings.globalBudgetMB > 0) {
    const usedMB = () =>
      stillRunning().reduce((sum, t) => sum + (t.memMB ?? 0), 0);
    if (usedMB() > settings.globalBudgetMB) {
      for (const victim of lru()) {
        if (usedMB() <= settings.globalBudgetMB) break;
        actions.push({ type: 'sleep', tabId: victim.id, reason: 'global-budget' });
        sleeping.add(victim.id);
      }
      if (usedMB() > settings.globalBudgetMB) {
        warnings.push({ tabId: '', kind: 'budget-unsatisfiable' });
      }
    }
  }

  return { actions, warnings };
}

// ---------------------------------------------------------- runaway guard

/**
 * Thresholds for the runaway-tab guard. Streaks are counted in governor
 * ticks (default ~2.5s each, RAHA_TICK_MS), so cpuTicks: 4 means roughly
 * ten sustained seconds — a spike from page load must not trigger a prompt.
 */
export const RUNAWAY = {
  cpuPct: 200,   // % of one core (can exceed 100 on multicore work)
  cpuTicks: 4,
  memMB: 2048,   // absolute working set, regardless of any per-tab limit
  memTicks: 2,
  snoozeMs: 5 * 60_000, // "Not now" quiets that tab for this long
};

/**
 * Should we ask the user about this tab right now?
 * Memory wins over CPU and fires even for audible tabs (a 2 GB tab is a
 * problem even while it plays sound); CPU respects protectAudio because
 * calls and videos legitimately burn CPU while audible.
 * @param {{ cpuHotTicks: number, memHotTicks: number, audible: boolean }} tab
 * @param {{ protectAudio: boolean }} settings
 * @returns {'cpu'|'mem'|null}
 */
export function runawayAssess(tab, settings) {
  if (tab.memHotTicks >= RUNAWAY.memTicks) return 'mem';
  if (tab.cpuHotTicks >= RUNAWAY.cpuTicks && !(settings.protectAudio && tab.audible)) return 'cpu';
  return null;
}

/**
 * Which tab should we wake/activate when the user closes the active tab?
 * Most recently active running tab first, then most recently active overall.
 * @param {PolicyTab[]} tabs
 * @param {string} closingId
 * @returns {string|null}
 */
export function nextActiveAfterClose(tabs, closingId) {
  const candidates = tabs.filter((t) => t.id !== closingId);
  if (candidates.length === 0) return null;
  const byRecency = (/** @type {PolicyTab} */ a, /** @type {PolicyTab} */ b) =>
    b.lastActiveAt - a.lastActiveAt;
  const runningFirst = [...candidates].sort(
    (a, b) => Number(b.running) - Number(a.running) || byRecency(a, b),
  );
  return runningFirst[0]?.id ?? null;
}
