// Tests for THE resource governor. Every rule, every precedence, every
// protection. If you change src/shared/policy.js you MUST update the matching
// case here in the same commit (docs/INVARIANTS.md #4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, nextActiveAfterClose, runawayAssess, RUNAWAY } from '../../src/shared/policy.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/**
 * @param {string} id
 * @returns {import('../../src/shared/policy.js').PolicyTab}
 */
function mkTab(id, overrides = {}) {
  return {
    id,
    running: true,
    isActive: false,
    keepAlive: false,
    audible: false,
    lastActiveAt: NOW - 10 * MIN,
    memMB: 100,
    memLimitMB: null,
    ...overrides,
  };
}

const SETTINGS = {
  maxLiveTabs: 3,
  idleSleepMinutes: 0,
  globalBudgetMB: 0,
  protectAudio: true,
};

test('no actions when under all limits', () => {
  const tabs = [mkTab('a', { isActive: true }), mkTab('b'), mkTab('c')];
  const { actions, warnings } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, []);
  assert.deepEqual(warnings, []);
});

test('cap: evicts least-recently-active background tabs first', () => {
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: NOW }),
    mkTab('newer', { lastActiveAt: NOW - 5 * MIN }),
    mkTab('older', { lastActiveAt: NOW - 50 * MIN }),
    mkTab('oldest', { lastActiveAt: NOW - 90 * MIN }),
  ];
  const { actions } = decide(tabs, SETTINGS, NOW); // cap 3, 4 running -> 1 eviction
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'oldest', reason: 'cap' }]);
});

test('cap: keepAlive tabs are never evicted by the cap', () => {
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: NOW }),
    mkTab('pinned-old', { keepAlive: true, lastActiveAt: NOW - 500 * MIN }),
    mkTab('b', { lastActiveAt: NOW - 20 * MIN }),
    mkTab('c', { lastActiveAt: NOW - 30 * MIN }),
  ];
  const { actions } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'c', reason: 'cap' }]);
});

test('cap: audible tabs are protected when protectAudio is on', () => {
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: NOW }),
    mkTab('music', { audible: true, lastActiveAt: NOW - 500 * MIN }),
    mkTab('b', { lastActiveAt: NOW - 20 * MIN }),
    mkTab('c', { lastActiveAt: NOW - 30 * MIN }),
  ];
  const { actions } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'c', reason: 'cap' }]);
});

test('cap: audible tabs are NOT protected when protectAudio is off', () => {
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: NOW }),
    mkTab('music', { audible: true, lastActiveAt: NOW - 500 * MIN }),
    mkTab('b', { lastActiveAt: NOW - 20 * MIN }),
    mkTab('c', { lastActiveAt: NOW - 30 * MIN }),
  ];
  const { actions } = decide(tabs, { ...SETTINGS, protectAudio: false }, NOW);
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'music', reason: 'cap' }]);
});

test('cap: warns when pins alone exceed the cap and sleeps nothing else', () => {
  const tabs = [
    mkTab('active', { isActive: true }),
    mkTab('p1', { keepAlive: true }),
    mkTab('p2', { keepAlive: true }),
    mkTab('p3', { keepAlive: true }),
  ];
  const { actions, warnings } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, []);
  assert.deepEqual(warnings, [{ tabId: '', kind: 'cap-unsatisfiable' }]);
});

test('asleep tabs are ignored entirely', () => {
  const tabs = [
    mkTab('active', { isActive: true }),
    mkTab('z1', { running: false }),
    mkTab('z2', { running: false }),
    mkTab('z3', { running: false }),
    mkTab('z4', { running: false }),
  ];
  const { actions, warnings } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, []);
  assert.deepEqual(warnings, []);
});

test('tab-limit: sleeps a background tab over its own limit, even keepAlive', () => {
  const tabs = [
    mkTab('active', { isActive: true }),
    mkTab('pig', { keepAlive: true, memMB: 900, memLimitMB: 500 }),
  ];
  const { actions } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'pig', reason: 'tab-limit' }]);
});

test('tab-limit: active tab over limit only warns', () => {
  const tabs = [mkTab('active', { isActive: true, memMB: 900, memLimitMB: 500 })];
  const { actions, warnings } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, []);
  assert.deepEqual(warnings, [{ tabId: 'active', kind: 'active-over-limit' }]);
});

test('tab-limit: audible tab over its own limit still sleeps (rule 1 beats audio)', () => {
  const tabs = [
    mkTab('active', { isActive: true }),
    mkTab('loudpig', { audible: true, memMB: 900, memLimitMB: 500 }),
  ];
  const { actions } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'loudpig', reason: 'tab-limit' }]);
});

test('idle: sleeps background tabs idle beyond the threshold', () => {
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: NOW }),
    mkTab('fresh', { lastActiveAt: NOW - 10 * MIN }),
    mkTab('stale', { lastActiveAt: NOW - 40 * MIN }),
    mkTab('never', { lastActiveAt: 0 }), // never activated -> not idle-slept
  ];
  const s = { ...SETTINGS, maxLiveTabs: 10, idleSleepMinutes: 30 };
  const { actions } = decide(tabs, s, NOW);
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'stale', reason: 'idle' }]);
});

test('global-budget: evicts LRU until under budget', () => {
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: NOW, memMB: 300 }),
    mkTab('b', { lastActiveAt: NOW - 5 * MIN, memMB: 300 }),
    mkTab('c', { lastActiveAt: NOW - 20 * MIN, memMB: 300 }),
    mkTab('d', { lastActiveAt: NOW - 60 * MIN, memMB: 300 }),
  ];
  const s = { ...SETTINGS, maxLiveTabs: 10, globalBudgetMB: 700 };
  const { actions } = decide(tabs, s, NOW);
  assert.deepEqual(actions, [
    { type: 'sleep', tabId: 'd', reason: 'global-budget' },
    { type: 'sleep', tabId: 'c', reason: 'global-budget' },
  ]);
});

test('global-budget: warns when active+pinned alone exceed budget', () => {
  const tabs = [
    mkTab('active', { isActive: true, memMB: 800 }),
    mkTab('pin', { keepAlive: true, memMB: 800 }),
  ];
  const s = { ...SETTINGS, maxLiveTabs: 10, globalBudgetMB: 1000 };
  const { actions, warnings } = decide(tabs, s, NOW);
  assert.deepEqual(actions, []);
  assert.deepEqual(warnings, [{ tabId: '', kind: 'budget-unsatisfiable' }]);
});

test('rules compose: tab-limit sleep also satisfies the cap (no double sleep)', () => {
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: NOW }),
    mkTab('pig', { memMB: 900, memLimitMB: 500, lastActiveAt: NOW - 90 * MIN }),
    mkTab('b', { lastActiveAt: NOW - 5 * MIN }),
  ];
  const { actions } = decide(tabs, SETTINGS, NOW); // cap 3: pig sleeps by rule 1, now 2 running
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'pig', reason: 'tab-limit' }]);
});

test('deterministic tie-break on equal lastActiveAt', () => {
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: NOW }),
    mkTab('bbb', { lastActiveAt: NOW - 10 * MIN }),
    mkTab('aaa', { lastActiveAt: NOW - 10 * MIN }),
    mkTab('ccc', { lastActiveAt: NOW - 10 * MIN }),
  ];
  const { actions } = decide(tabs, SETTINGS, NOW);
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'aaa', reason: 'cap' }]);
});

test('nextActiveAfterClose prefers running tabs by recency', () => {
  const tabs = [
    mkTab('closing', { isActive: true, lastActiveAt: NOW }),
    mkTab('asleep-recent', { running: false, lastActiveAt: NOW - 1 * MIN }),
    mkTab('running-old', { lastActiveAt: NOW - 50 * MIN }),
  ];
  assert.equal(nextActiveAfterClose(tabs, 'closing'), 'running-old');
});

test('nextActiveAfterClose falls back to asleep tabs, then null', () => {
  const tabs = [
    mkTab('closing', { isActive: true }),
    mkTab('z', { running: false, lastActiveAt: NOW - 3 * MIN }),
  ];
  assert.equal(nextActiveAfterClose(tabs, 'closing'), 'z');
  assert.equal(nextActiveAfterClose([mkTab('only')], 'only'), null);
});

// ---------------------------------------------------------- runaway guard

test('runawayAssess: below either streak threshold -> null', () => {
  assert.equal(runawayAssess({ cpuHotTicks: RUNAWAY.cpuTicks - 1, memHotTicks: 0, audible: false }, SETTINGS), null);
  assert.equal(runawayAssess({ cpuHotTicks: 0, memHotTicks: RUNAWAY.memTicks - 1, audible: false }, SETTINGS), null);
});

test('runawayAssess: sustained CPU fires; a single-tick spike never does', () => {
  assert.equal(runawayAssess({ cpuHotTicks: RUNAWAY.cpuTicks, memHotTicks: 0, audible: false }, SETTINGS), 'cpu');
  assert.equal(runawayAssess({ cpuHotTicks: 1, memHotTicks: 0, audible: false }, SETTINGS), null);
});

test('runawayAssess: protectAudio exempts audible tabs from the CPU prompt only', () => {
  const hotCpu = { cpuHotTicks: RUNAWAY.cpuTicks, memHotTicks: 0, audible: true };
  assert.equal(runawayAssess(hotCpu, { ...SETTINGS, protectAudio: true }), null);
  assert.equal(runawayAssess(hotCpu, { ...SETTINGS, protectAudio: false }), 'cpu');
  // memory blowups prompt even while audible
  const hotMem = { cpuHotTicks: 0, memHotTicks: RUNAWAY.memTicks, audible: true };
  assert.equal(runawayAssess(hotMem, { ...SETTINGS, protectAudio: true }), 'mem');
});

test('runawayAssess: memory wins when both streaks are hot', () => {
  const both = { cpuHotTicks: RUNAWAY.cpuTicks + 5, memHotTicks: RUNAWAY.memTicks, audible: false };
  assert.equal(runawayAssess(both, SETTINGS), 'mem');
});

// ---------------------------------------------------------------- Rule 5: idle freeze (ADR-0014)

const FREEZE = { ...SETTINGS, maxLiveTabs: 10, freezeIdleMinutes: 2 };

test('freeze: a background tab idle past freezeIdleMinutes is frozen, not slept', () => {
  const tabs = [mkTab('a', { isActive: true }), mkTab('b', { lastActiveAt: NOW - 3 * MIN }), mkTab('c', { lastActiveAt: NOW - 1 * MIN })];
  const { actions } = decide(tabs, FREEZE, NOW);
  assert.deepEqual(actions, [{ type: 'freeze', tabId: 'b', reason: 'idle-freeze' }]);
});

test('freeze: never the active, keepAlive, audible (protectAudio), loading, or already-frozen tab', () => {
  const old = NOW - 30 * MIN;
  const tabs = [
    mkTab('active', { isActive: true, lastActiveAt: old }),
    mkTab('pinned', { keepAlive: true, lastActiveAt: old }),
    mkTab('music', { audible: true, lastActiveAt: old }),
    mkTab('loading', { loading: true, lastActiveAt: old }),
    mkTab('frozen', { frozen: true, lastActiveAt: old }),
    mkTab('never', { lastActiveAt: 0 }),
    mkTab('asleep', { running: false, lastActiveAt: old }),
    mkTab('plain', { lastActiveAt: old }),
  ];
  const { actions } = decide(tabs, FREEZE, NOW);
  assert.deepEqual(actions, [{ type: 'freeze', tabId: 'plain', reason: 'idle-freeze' }]);
});

test('freeze: an audible tab IS frozen when protectAudio is off', () => {
  const tabs = [mkTab('a', { isActive: true }), mkTab('music', { audible: true, lastActiveAt: NOW - 30 * MIN })];
  const { actions } = decide(tabs, { ...FREEZE, protectAudio: false }, NOW);
  assert.deepEqual(actions, [{ type: 'freeze', tabId: 'music', reason: 'idle-freeze' }]);
});

test('freeze: sleep rules win — a tab chosen to sleep this round is never also frozen', () => {
  // idle sleep at 2 min beats freeze at 2 min for the same tab
  const tabs = [mkTab('a', { isActive: true }), mkTab('b', { lastActiveAt: NOW - 5 * MIN })];
  const { actions } = decide(tabs, { ...FREEZE, idleSleepMinutes: 2 }, NOW);
  assert.deepEqual(actions, [{ type: 'sleep', tabId: 'b', reason: 'idle' }]);
  // cap eviction picks b; c (also idle) is frozen — one action each, never both on one tab
  const tabs2 = [mkTab('a', { isActive: true }), mkTab('b', { lastActiveAt: NOW - 20 * MIN }), mkTab('c', { lastActiveAt: NOW - 10 * MIN })];
  const r = decide(tabs2, { ...FREEZE, maxLiveTabs: 2 }, NOW);
  assert.deepEqual(r.actions, [
    { type: 'sleep', tabId: 'b', reason: 'cap' },
    { type: 'freeze', tabId: 'c', reason: 'idle-freeze' },
  ]);
});

test('freeze: frozen tabs are ordinary running tabs to the sleep rules (they hold RAM)', () => {
  // idle sleep: a frozen tab past idleSleepMinutes sleeps
  const tabs = [mkTab('a', { isActive: true }), mkTab('f', { frozen: true, lastActiveAt: NOW - 30 * MIN })];
  assert.deepEqual(decide(tabs, { ...FREEZE, idleSleepMinutes: 10 }, NOW).actions, [{ type: 'sleep', tabId: 'f', reason: 'idle' }]);
  // per-tab limit: a frozen tab over its limit sleeps
  const tabs2 = [mkTab('a', { isActive: true }), mkTab('f', { frozen: true, memMB: 900, memLimitMB: 500 })];
  assert.deepEqual(decide(tabs2, FREEZE, NOW).actions, [{ type: 'sleep', tabId: 'f', reason: 'tab-limit' }]);
  // LRU order ignores frozenness: the least-recently-active tab goes first, frozen or not
  const tabs3 = [
    mkTab('a', { isActive: true }),
    mkTab('warm', { lastActiveAt: NOW - 5 * MIN }),
    mkTab('frozenNewer', { frozen: true, lastActiveAt: NOW - 3 * MIN }),
  ];
  const r = decide(tabs3, { ...FREEZE, maxLiveTabs: 2, freezeIdleMinutes: 0 }, NOW);
  assert.deepEqual(r.actions, [{ type: 'sleep', tabId: 'warm', reason: 'cap' }]);
});

test('freeze: freezeIdleMinutes = 0 (or absent) disables rule 5; output is deterministic', () => {
  const tabs = [mkTab('a', { isActive: true }), mkTab('b', { lastActiveAt: NOW - 60 * MIN })];
  assert.deepEqual(decide(tabs, { ...FREEZE, freezeIdleMinutes: 0 }, NOW).actions, []);
  assert.deepEqual(decide(tabs, SETTINGS, NOW).actions, []);
  const many = ['z', 'y', 'x'].map((id) => mkTab(id, { lastActiveAt: NOW - 60 * MIN }));
  const a1 = decide([mkTab('a', { isActive: true }), ...many], FREEZE, NOW).actions;
  const a2 = decide([mkTab('a', { isActive: true }), ...many], FREEZE, NOW).actions;
  assert.deepEqual(a1, a2);
  assert.equal(a1.length, 3);
});
