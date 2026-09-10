// Versioned migrations for persisted files (state.json, settings.json,
// history.json).
//
// HOW TO ADD A SCHEMA CHANGE (also in docs/PLAYBOOKS/change-persistence.md):
//   1. Bump STATE_SCHEMA_VERSION or SETTINGS_SCHEMA_VERSION in defaults.js.
//   2. Append ONE migration step here keyed by the OLD version number.
//      A step receives the document at version N and must return version N+1.
//   3. Add a fixture test in tests/unit/migrate.test.js that feeds a real
//      old-format document through migrate*() and asserts the new shape.
//   Never edit or delete an existing step — history must stay replayable.

import { STATE_SCHEMA_VERSION, SETTINGS_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION } from './defaults.js';
import { validateSettings } from './validate.js';
import { createTree, repairTree } from './tree.js';
import { sanitizeHistoryEntries } from './history.js';
import { sanitizePageState } from './page-state.js';

/** @type {Record<number, (doc: any) => any>} */
const STATE_STEPS = {
  // 0 -> 1: version-less prototype files get wrapped into v1 shape.
  0: (doc) => ({
    schemaVersion: 1,
    tree: doc && typeof doc === 'object' && doc.tree ? doc.tree : createTree(),
    activeTabId: doc && typeof doc === 'object' && typeof doc.activeTabId === 'string' ? doc.activeTabId : null,
  }),
  // 1 -> 2 (R-104): add pageState to every tab node (null = nothing captured yet).
  1: (doc) => {
    if (doc?.tree?.nodes) {
      for (const n of Object.values(doc.tree.nodes)) {
        if (n && n.type === 'tab') n.pageState = n.pageState ?? null;
      }
    }
    return { ...doc, schemaVersion: 2 };
  },
};

/** @type {Record<number, (doc: any) => any>} */
const SETTINGS_STEPS = {
  // 0 -> 1: version-less prototype settings.
  0: (doc) => ({ ...(doc && typeof doc === 'object' ? doc : {}), schemaVersion: 1 }),
  // 1 -> 2 (R-102, ADR-0009): blocking split into blockAds (EasyList) and
  // blockTrackers (EasyPrivacy). A user who had the single old toggle off
  // stays fully off; noBlockHosts is the new per-site shield-off list.
  1: (doc) => ({
    ...doc,
    schemaVersion: 2,
    blockAds: typeof doc.blockTrackers === 'boolean' ? doc.blockTrackers : true,
    noBlockHosts: [],
  }),
  // 2 -> 3 (R-103, ADR-0013): per-site permission decisions. A v2 profile
  // never answered an ask (it was denied everything), so it starts with no
  // decisions — every site asks the first time it needs something.
  2: (doc) => ({
    ...doc,
    schemaVersion: 3,
    sitePermissions: {},
  }),
};

/** @type {Record<number, (doc: any) => any>} */
const HISTORY_STEPS = {
  // 0 -> 1: wrap a bare/unknown document into the v1 shape.
  0: (doc) => ({
    schemaVersion: 1,
    entries: doc && typeof doc === 'object' && Array.isArray(doc.entries) ? doc.entries : [],
  }),
};

/**
 * @typedef {{ schemaVersion: number, tree: import('./tree.js').Tree, activeTabId: string|null }} PersistedState
 */

/**
 * Bring a raw parsed state.json to the current version, repairing if needed.
 * NEVER throws: worst case returns a fresh empty state.
 * @param {unknown} raw
 * @returns {{ state: PersistedState, problems: string[] }}
 */
export function migrateState(raw) {
  /** @type {string[]} */ const problems = [];
  let doc = /** @type {any} */ (raw);
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    if (raw !== undefined) problems.push('state: unreadable, starting fresh');
    doc = { schemaVersion: 0 };
  }
  let v = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0;
  if (v > STATE_SCHEMA_VERSION) {
    // Downgrade attempt (newer app wrote this). Keep the file untouched on
    // disk (StateStore handles backup) and start fresh in memory.
    problems.push(`state: schemaVersion ${v} is newer than this app understands (${STATE_SCHEMA_VERSION})`);
    return { state: { schemaVersion: STATE_SCHEMA_VERSION, tree: createTree(), activeTabId: null }, problems };
  }
  let guard = 0;
  while (v < STATE_SCHEMA_VERSION && guard < 100) {
    const step = STATE_STEPS[v];
    if (!step) { problems.push(`state: missing migration step from v${v}`); break; }
    doc = step(doc);
    v = doc.schemaVersion;
    guard += 1;
  }

  // Shape + integrity repair.
  const tree = doc.tree && typeof doc.tree === 'object' && doc.tree.nodes ? doc.tree : createTree();
  if (typeof tree.rootId !== 'string') tree.rootId = 'root';
  const { repaired, problems: treeProblems } = repairTree(tree);
  if (repaired) problems.push('state: tree repaired', ...treeProblems.slice(0, 10));

  // Sanitize pageState on every tab (bounds a tampered state.json).
  for (const n of Object.values(tree.nodes)) {
    if (n.type === 'tab') n.pageState = sanitizePageState(n.pageState);
  }

  const activeTabId = typeof doc.activeTabId === 'string' && tree.nodes[doc.activeTabId] ? doc.activeTabId : null;
  return { state: { schemaVersion: STATE_SCHEMA_VERSION, tree, activeTabId }, problems };
}

/**
 * Bring raw parsed settings.json to current version + validate.
 * NEVER throws.
 * @param {unknown} raw
 * @returns {{ settings: import('./defaults.js').RahaSettings, problems: string[] }}
 */
export function migrateSettings(raw) {
  /** @type {string[]} */ const problems = [];
  let doc = /** @type {any} */ (raw);
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    if (raw !== undefined) problems.push('settings: unreadable, using defaults');
    doc = { schemaVersion: 0 };
  }
  let v = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0;
  if (v > SETTINGS_SCHEMA_VERSION) {
    problems.push(`settings: schemaVersion ${v} newer than app (${SETTINGS_SCHEMA_VERSION}), using defaults`);
    doc = { schemaVersion: SETTINGS_SCHEMA_VERSION };
    v = SETTINGS_SCHEMA_VERSION;
  }
  let guard = 0;
  while (v < SETTINGS_SCHEMA_VERSION && guard < 100) {
    const step = SETTINGS_STEPS[v];
    if (!step) { problems.push(`settings: missing migration step from v${v}`); break; }
    doc = step(doc);
    v = doc.schemaVersion;
    guard += 1;
  }
  const { value, problems: vProblems } = validateSettings(doc);
  problems.push(...vProblems);
  return { settings: value, problems };
}

/**
 * @typedef {{ schemaVersion: number, entries: import('./history.js').HistoryEntry[] }} PersistedHistory
 */

/**
 * Bring a raw parsed history.json to the current version + sanitize entries.
 * NEVER throws: worst case returns an empty store.
 * @param {unknown} raw
 * @returns {{ history: PersistedHistory, problems: string[] }}
 */
export function migrateHistory(raw) {
  /** @type {string[]} */ const problems = [];
  let doc = /** @type {any} */ (raw);
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    if (raw !== undefined) problems.push('history: unreadable, starting empty');
    doc = { schemaVersion: 0 };
  }
  let v = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0;
  if (v > HISTORY_SCHEMA_VERSION) {
    problems.push(`history: schemaVersion ${v} is newer than this app understands (${HISTORY_SCHEMA_VERSION})`);
    return { history: { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] }, problems };
  }
  let guard = 0;
  while (v < HISTORY_SCHEMA_VERSION && guard < 100) {
    const step = HISTORY_STEPS[v];
    if (!step) { problems.push(`history: missing migration step from v${v}`); break; }
    doc = step(doc);
    v = doc.schemaVersion;
    guard += 1;
  }
  const { entries, dropped } = sanitizeHistoryEntries(doc.entries);
  if (dropped > 0) problems.push(`history: dropped ${dropped} invalid entries`);
  return { history: { schemaVersion: HISTORY_SCHEMA_VERSION, entries }, problems };
}
