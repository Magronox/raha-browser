import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateState, migrateSettings, migrateHistory } from '../../src/shared/migrate.js';
import { STATE_SCHEMA_VERSION, SETTINGS_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION } from '../../src/shared/defaults.js';
import { createTree, addTab, checkIntegrity, allTabIds } from '../../src/shared/tree.js';
import { must } from '../helpers.js';

test('migrateState: fresh from nothing', () => {
  const { state } = migrateState(undefined);
  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(checkIntegrity(state.tree), []);
  assert.equal(state.activeTabId, null);
});

test('migrateState: corrupt json shapes never throw', () => {
  for (const bad of [null, 'str', 7, [], { tree: 'x' }, { schemaVersion: 'x' }]) {
    const { state } = migrateState(bad);
    assert.deepEqual(checkIntegrity(state.tree), []);
  }
});

test('migrateState: valid current-version state passes through intact', () => {
  const tree = createTree();
  const t1 = must(addTab(tree, { url: 'https://a.com', now: 1 }), 'tab');
  const doc = { schemaVersion: STATE_SCHEMA_VERSION, tree, activeTabId: t1.id };
  const { state, problems } = migrateState(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(problems, []);
  assert.deepEqual(allTabIds(state.tree), [t1.id]);
  assert.equal(state.activeTabId, t1.id);
});

test('migrateState: activeTabId pointing nowhere is nulled', () => {
  const tree = createTree();
  const doc = { schemaVersion: STATE_SCHEMA_VERSION, tree, activeTabId: 'ghost' };
  const { state } = migrateState(JSON.parse(JSON.stringify(doc)));
  assert.equal(state.activeTabId, null);
});

test('migrateState: future version -> fresh state + problem note', () => {
  const { state, problems } = migrateState({ schemaVersion: 999, tree: {} });
  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.ok(problems.some((p) => p.includes('newer')));
});

test('migrateState: v0 (version-less prototype) upgrades', () => {
  const tree = createTree();
  addTab(tree, { url: 'https://old.com' });
  const { state } = migrateState({ tree, activeTabId: null }); // no schemaVersion
  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(allTabIds(state.tree).length, 1);
});

/** A real v1 state.json fixture (pre-R-104). */
function v1StateFixture() {
  const tree = createTree();
  const t1 = must(addTab(tree, { url: 'https://a.com', now: 100 }), 'tab');
  const t2 = must(addTab(tree, { url: 'https://b.com', now: 200 }), 'tab');
  t1.navJson = '{"entries":[{"url":"https://a.com"}],"currentIndex":0}';
  // Manually remove pageState to simulate a v1 file that lacks it.
  delete /** @type {any} */ (t1).pageState;
  delete /** @type {any} */ (t2).pageState;
  return { schemaVersion: 1, tree, activeTabId: t1.id };
}

test('migrateState: v1 -> v2 adds pageState:null to every tab, preserves urls/navJson', () => {
  const doc = JSON.parse(JSON.stringify(v1StateFixture()));
  const { state, problems } = migrateState(doc);
  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(problems, []);
  for (const id of allTabIds(state.tree)) {
    const n = state.tree.nodes[id];
    assert.equal(n.type, 'tab');
    assert.equal(/** @type {import('../../src/shared/tree.js').TabNode} */(n).pageState, null, `tab ${id} should have pageState:null`);
  }
  const tabs = allTabIds(state.tree).map((id) => /** @type {import('../../src/shared/tree.js').TabNode} */(state.tree.nodes[id]));
  assert.ok(tabs.some((t) => t.url === 'https://a.com'));
  assert.ok(tabs.some((t) => t.navJson !== null), 'navJson preserved');
});

test('migrateState: v1 with garbage pageState is sanitized to null', () => {
  const doc = JSON.parse(JSON.stringify(v1StateFixture()));
  const tabId = Object.values(doc.tree.nodes).find((n) => n.type === 'tab').id;
  doc.tree.nodes[tabId].pageState = { v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0, fields: [{ p: '0/0', n: 'input:password:pw', k: 'text', v: 'secret' }] };
  const { state } = migrateState(doc);
  const tab = /** @type {import('../../src/shared/tree.js').TabNode} */(state.tree.nodes[tabId]);
  assert.ok(tab.pageState === null || tab.pageState.fields.length === 0, 'password field must not survive');
});

test('migrateState: v1 with oversize pageState is sanitized (fields dropped)', () => {
  const doc = JSON.parse(JSON.stringify(v1StateFixture()));
  const tabId = Object.values(doc.tree.nodes).find((n) => n.type === 'tab').id;
  const bigFields = Array.from({ length: 50 }, (_, i) => ({
    p: `0/${i}`, n: `input:text:f${i}`, k: 'text', v: 'x'.repeat(8000),
  }));
  doc.tree.nodes[tabId].pageState = { v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 500, fields: bigFields };
  const { state } = migrateState(doc);
  const tab = /** @type {import('../../src/shared/tree.js').TabNode} */(state.tree.nodes[tabId]);
  if (tab.pageState) {
    assert.deepEqual(tab.pageState.fields, [], 'oversize -> fields dropped');
    assert.equal(tab.pageState.sy, 500, 'scroll survives');
  }
});

test('migrateSettings: fresh, corrupt, future — always valid result', () => {
  for (const input of [undefined, null, 'x', { schemaVersion: 999 }, { maxLiveTabs: -1 }]) {
    const { settings } = migrateSettings(input);
    assert.equal(settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
    assert.ok(settings.maxLiveTabs >= 1);
  }
});

test('migrateSettings: preserves user values through migration', () => {
  const { settings } = migrateSettings({ maxLiveTabs: 9, gpc: false }); // version-less
  assert.equal(settings.maxLiveTabs, 9);
  assert.equal(settings.gpc, false);
});

/** A real, complete v1 settings.json shape (pre-R-102). */
function v1SettingsFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    maxLiveTabs: 6,
    idleSleepMinutes: 0,
    globalBudgetMB: 0,
    protectAudio: true,
    runawayGuard: true,
    blockTrackers: true,
    gpc: true,
    httpsFirst: true,
    autoUpdate: true,
    searchEngine: 'duckduckgo',
    rules: [],
    ...overrides,
  };
}

test('migrateSettings: v1 -> v2 seeds blockAds from blockTrackers (off stays off)', () => {
  const { settings } = migrateSettings(v1SettingsFixture({ blockTrackers: false }));
  assert.equal(settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(settings.blockAds, false);
  assert.equal(settings.blockTrackers, false);
  assert.deepEqual(settings.noBlockHosts, []);
});

test('migrateSettings: v1 -> v2 with blocking on -> both toggles on', () => {
  const { settings } = migrateSettings(v1SettingsFixture());
  assert.equal(settings.blockAds, true);
  assert.equal(settings.blockTrackers, true);
});

test('migrateSettings: version-less doc chains 0 -> 1 -> 2 -> 3 with blockAds defaulting true', () => {
  const { settings } = migrateSettings({ maxLiveTabs: 4 }); // no schemaVersion, no blockTrackers
  assert.equal(settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(settings.blockAds, true);
  assert.equal(settings.maxLiveTabs, 4);
  assert.deepEqual(settings.sitePermissions, {});
});

/** A real, complete v2 settings.json as the 2026-08-22 build wrote it (pre-R-103). */
function v2SettingsFixture(overrides = {}) {
  return {
    schemaVersion: 2,
    maxLiveTabs: 5,
    idleSleepMinutes: 15,
    globalBudgetMB: 2048,
    protectAudio: true,
    runawayGuard: true,
    blockAds: true,
    blockTrackers: false,
    noBlockHosts: ['example.com'],
    gpc: true,
    httpsFirst: true,
    autoUpdate: false,
    recordHistory: true,
    allowedExternalSchemes: ['zoommtg'],
    defaultBrowserPrompted: true,
    searchEngine: 'brave',
    rules: [{ pattern: '*.music.youtube.com', keepAlive: true }, { pattern: 'slack.com', memLimitMB: 800 }],
    ...overrides,
  };
}

test('migrateSettings: v2 -> v3 adds an empty sitePermissions map and keeps every user value', () => {
  const { settings, problems } = migrateSettings(v2SettingsFixture());
  assert.deepEqual(problems, []);
  assert.equal(settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(settings.sitePermissions, {});
  assert.equal(settings.maxLiveTabs, 5);
  assert.equal(settings.idleSleepMinutes, 15);
  assert.equal(settings.globalBudgetMB, 2048);
  assert.equal(settings.blockTrackers, false);
  assert.deepEqual(settings.noBlockHosts, ['example.com']);
  assert.equal(settings.autoUpdate, false);
  assert.deepEqual(settings.allowedExternalSchemes, ['zoommtg']);
  assert.equal(settings.defaultBrowserPrompted, true);
  assert.equal(settings.searchEngine, 'brave');
  assert.deepEqual(settings.rules, [{ pattern: '*.music.youtube.com', keepAlive: true }, { pattern: 'slack.com', memLimitMB: 800 }]);
});

test('migrateSettings: v1 chains through v2 to v3', () => {
  const { settings } = migrateSettings(v1SettingsFixture({ blockTrackers: false }));
  assert.equal(settings.schemaVersion, 3);
  assert.equal(settings.blockAds, false);
  assert.deepEqual(settings.sitePermissions, {});
});

test('migrateSettings: a current v3 document with decisions passes through intact', () => {
  const doc = { ...v2SettingsFixture(), schemaVersion: 3, sitePermissions: { 'meet.example': { camera: 'allow', microphone: 'deny' } } };
  const { settings, problems } = migrateSettings(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(problems, []);
  assert.deepEqual(settings.sitePermissions, { 'meet.example': { camera: 'allow', microphone: 'deny' } });
});

test('migrateHistory: fresh from nothing, no problems', () => {
  const { history, problems } = migrateHistory(undefined);
  assert.deepEqual(history, { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] });
  assert.deepEqual(problems, []);
});

test('migrateHistory: corrupt shapes never throw', () => {
  for (const bad of [null, 'str', 7, [], { entries: 'x' }, { schemaVersion: 'x', entries: {} }]) {
    const { history } = migrateHistory(bad);
    assert.equal(history.schemaVersion, HISTORY_SCHEMA_VERSION);
    assert.deepEqual(history.entries, []);
  }
});

test('migrateHistory: valid current-version doc passes through intact', () => {
  const entry = { url: 'https://a.com/x', title: 'A', lastVisitMs: 1_700_000_000_000, visitCount: 3, source: 'Chrome' };
  const doc = { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [entry] };
  const { history, problems } = migrateHistory(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(problems, []);
  assert.deepEqual(history.entries, [entry]);
});

test('migrateHistory: invalid entries are dropped with a problem note', () => {
  const doc = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    entries: [
      { url: 'https://ok.com', title: '', lastVisitMs: 5, visitCount: 1, source: '' },
      { url: 'file:///etc/passwd', title: 'nope', lastVisitMs: 5, visitCount: 1, source: '' },
      'garbage',
    ],
  };
  const { history, problems } = migrateHistory(doc);
  assert.deepEqual(history.entries.map((e) => e.url), ['https://ok.com']);
  assert.ok(problems.some((p) => p.includes('dropped 2')));
});

test('migrateHistory: future version -> empty store + problem note', () => {
  const { history, problems } = migrateHistory({ schemaVersion: 999, entries: [{ url: 'https://a.com', lastVisitMs: 1, visitCount: 1 }] });
  assert.deepEqual(history.entries, []);
  assert.ok(problems.some((p) => p.includes('newer')));
});

test('migrateHistory: v0 (version-less) doc upgrades with entries preserved', () => {
  const { history } = migrateHistory({ entries: [{ url: 'https://old.com', title: 'Old', lastVisitMs: 9, visitCount: 2, source: 'Firefox' }] });
  assert.equal(history.schemaVersion, HISTORY_SCHEMA_VERSION);
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].url, 'https://old.com');
});
