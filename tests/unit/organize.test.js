import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planOrganize, categorize, registrableDomain, MIN_CATEGORY_TABS, MIN_DOMAIN_GROUP,
} from '../../src/shared/organize.js';

const ROOT = 'root';

/** @param {string} id @param {string} url @param {string} [parentId] */
function mkTab(id, url, parentId = ROOT) {
  return { id, parentId, url };
}

test('categorize: known hosts land in their category, subdomains included', () => {
  assert.equal(categorize('github.com'), 'Dev');
  assert.equal(categorize('gist.github.com'), 'Dev');
  assert.equal(categorize('claude.ai'), 'AI');
  assert.equal(categorize('www.purdue.edu'), 'School');
  assert.equal(categorize('unknown-site.io'), null);
});

test('categorize: more specific hosts win (music.youtube.com is Music, not Video)', () => {
  assert.equal(categorize('music.youtube.com'), 'Music');
  assert.equal(categorize('www.youtube.com'), 'Video');
});

test('categorize: no substring false-positives (notgithub.com is not Dev)', () => {
  assert.equal(categorize('notgithub.com'), null);
  assert.equal(categorize('github.com.evil.io'), null);
});

test('registrableDomain: strips subdomains, keeps two-part public suffixes', () => {
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('planOrganize: categories with >= MIN_CATEGORY_TABS tabs become groups', () => {
  const { groups, loose, leftover } = planOrganize([
    mkTab('t1', 'https://github.com/a'),
    mkTab('t2', 'https://stackoverflow.com/q'),
    mkTab('t3', 'https://www.youtube.com/watch'),
  ], [], ROOT);
  assert.equal(loose, 3);
  assert.deepEqual(groups, [{ name: 'Dev', folderId: null, tabIds: ['t1', 't2'] }]);
  assert.equal(leftover, 1, 'a lone Video tab is left in place, no 1-tab folders');
  assert.ok(MIN_CATEGORY_TABS >= 2);
});

test('planOrganize: tabs already inside folders are never touched', () => {
  const { groups, loose } = planOrganize([
    mkTab('t1', 'https://github.com/a', 'folder9'),
    mkTab('t2', 'https://gitlab.com/b', 'folder9'),
    mkTab('t3', 'https://github.com/c'),
  ], [{ id: 'folder9', parentId: ROOT, name: 'My stuff' }], ROOT);
  assert.equal(loose, 1);
  assert.deepEqual(groups, []);
});

test('planOrganize: unmatched tabs group by registrable domain at >= MIN_DOMAIN_GROUP', () => {
  const { groups } = planOrganize([
    mkTab('t1', 'https://app.some-tool.io/x'),
    mkTab('t2', 'https://docs.some-tool.io/y'),
    mkTab('t3', 'https://some-tool.io/z'),
    mkTab('t4', 'https://lonely.net/'),
  ], [], ROOT);
  assert.deepEqual(groups, [{ name: 'some-tool.io', folderId: null, tabIds: ['t1', 't2', 't3'] }]);
  assert.ok(MIN_DOMAIN_GROUP >= 3);
});

test('planOrganize: reuses an existing top-level folder case-insensitively, but never a nested one', () => {
  const folders = [
    { id: 'fDev', parentId: ROOT, name: 'dev' },
    { id: 'fNested', parentId: 'fDev', name: 'Social' },
  ];
  const { groups } = planOrganize([
    mkTab('t1', 'https://github.com/a'),
    mkTab('t2', 'https://gitlab.com/b'),
    mkTab('t3', 'https://reddit.com/r/x'),
    mkTab('t4', 'https://x.com/y'),
  ], folders, ROOT);
  const dev = groups.find((g) => g.name === 'Dev');
  const social = groups.find((g) => g.name === 'Social');
  assert.equal(dev?.folderId, 'fDev', 'existing top-level folder reused');
  assert.equal(social?.folderId, null, 'nested folder with same name NOT reused');
});

test('planOrganize: internal and unparseable urls are ignored entirely', () => {
  const { groups, loose, leftover } = planOrganize([
    mkTab('t1', 'raha://home'),
    mkTab('t2', 'not a url'),
    mkTab('t3', 'https://github.com/a'),
  ], [], ROOT);
  assert.equal(loose, 3);
  assert.deepEqual(groups, []);
  assert.equal(leftover, 3);
});

test('planOrganize is deterministic: same input, identical plan', () => {
  const tabs = [
    mkTab('t1', 'https://a.tool.io/'), mkTab('t2', 'https://b.tool.io/'),
    mkTab('t3', 'https://c.tool.io/'), mkTab('t4', 'https://github.com/x'),
    mkTab('t5', 'https://gitlab.com/y'),
  ];
  const a = planOrganize(tabs, [], ROOT);
  const b = planOrganize(tabs, [], ROOT);
  assert.deepEqual(a, b);
  // Category groups come before domain groups, categories in CATEGORIES order.
  assert.deepEqual(a.groups.map((g) => g.name), ['Dev', 'tool.io']);
});
