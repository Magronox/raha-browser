import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaletteItems, rankPalette, PALETTE_ACTION_IDS } from '../../src/shared/palette.js';

const snap = {
  rootId: 'root',
  activeTabId: 'hn',
  tabs: [
    { id: 'gh', title: 'raha-browser/raha: a calm browser', url: 'https://github.com/raha-browser/raha', state: 'running' },
    { id: 'hn', title: 'Hacker News', url: 'https://news.ycombinator.com/', state: 'active' },
    { id: 'wm', title: 'Working memory - Wikipedia', url: 'https://en.wikipedia.org/wiki/Working_memory', state: 'asleep' },
    { id: 'mail', title: '', url: 'https://mail.example.com/inbox', state: 'asleep' },
  ],
  folders: [
    { id: 'root', name: '', parentId: null },
    { id: 'proj', name: 'Project Raha', parentId: 'root' },
    { id: 'res', name: 'Research', parentId: 'root' },
  ],
};
const hostOf = (/** @type {string} */ u) => new URL(u).hostname;
const tabsIn = (/** @type {string} */ id) => (id === 'proj' ? 1 : 2);
const items = () => buildPaletteItems(snap, hostOf, tabsIn);

test('items: tabs (minus the active one) then folders (minus root) then actions; untitled tabs show their URL', () => {
  const it = items();
  assert.deepEqual(it.filter((i) => i.kind === 'tab').map((i) => i.id), ['gh', 'wm', 'mail']);
  assert.equal(it.find((i) => i.id === 'mail')?.title, 'https://mail.example.com/inbox');
  assert.deepEqual(it.filter((i) => i.kind === 'folder').map((i) => i.title), ['Project Raha', 'Research']);
  assert.equal(it.find((i) => i.id === 'res')?.subtitle, '2 tabs');
  assert.equal(it.find((i) => i.id === 'proj')?.subtitle, '1 tab');
  const actions = it.filter((i) => i.kind === 'action').map((i) => i.id);
  assert.deepEqual(actions, PALETTE_ACTION_IDS, 'with a tab active every action is offered');
  const kinds = it.map((i) => i.kind);
  assert.equal(kinds.lastIndexOf('tab') < kinds.indexOf('folder') && kinds.lastIndexOf('folder') < kinds.indexOf('action'), true);
});

test('items: tab-only actions vanish when the grid is showing', () => {
  const it = buildPaletteItems({ ...snap, activeTabId: null }, hostOf, tabsIn);
  const actions = it.filter((i) => i.kind === 'action').map((i) => i.id);
  assert.ok(!actions.includes('sleep-tab') && !actions.includes('freeze-tab') && !actions.includes('find'));
  assert.ok(actions.includes('new-tab') && actions.includes('settings'));
  assert.equal(it.filter((i) => i.kind === 'tab').length, 4, 'no active tab = every tab listed');
});

test('rank: empty query keeps tree order and honors the limit', () => {
  assert.deepEqual(rankPalette(items(), '   ', 3).map((i) => i.id), ['gh', 'wm', 'mail']);
});

test('rank: subsequence matching, word starts and prefixes win, host and keywords count', () => {
  const it = items();
  assert.equal(rankPalette(it, 'wiki')[0].id, 'wm', 'host match');
  assert.equal(rankPalette(it, 'working')[0].id, 'wm', 'title prefix');
  assert.equal(rankPalette(it, 'wm')[0].id, 'wm', 'initials (word starts)');
  assert.equal(rankPalette(it, 'set')[0].id, 'settings');
  assert.equal(rankPalette(it, 'prefs')[0].id, 'settings', 'keyword: preferences');
  assert.equal(rankPalette(it, 'pin')[0].id, 'pin-tab');
  assert.equal(rankPalette(it, 'research')[0].kind, 'folder');
  assert.deepEqual(rankPalette(it, 'zzzqqq'), [], 'no match = nothing');
  assert.equal(rankPalette(it, 'HACKER').length, 0, 'the active tab is not listed');
});

test('rank: "sleep" puts the tab action before sleep-all only because it is the shorter, earlier item; both appear', () => {
  const ids = rankPalette(items(), 'sleep').map((i) => i.id);
  assert.ok(ids.includes('sleep-tab') && ids.includes('sleep-all'));
  assert.ok(ids.indexOf('sleep-tab') < ids.indexOf('sleep-all'));
});
