import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTree, addFolder, addTab, removeNode, moveNode, isAncestor,
  checkIntegrity, repairTree, tabIdsInSubtree, allTabIds, folder, tab, ROOT_ID,
} from '../../src/shared/tree.js';
import { must } from '../helpers.js';

/** @param {import('../../src/shared/tree.js').Tree} t */
function assertHealthy(t) {
  assert.deepEqual(checkIntegrity(t), []);
}

test('createTree starts with a healthy root', () => {
  const t = createTree();
  assertHealthy(t);
  assert.equal(t.rootId, ROOT_ID);
});

test('addFolder / addTab nest arbitrarily deep and stay healthy', () => {
  const t = createTree();
  const work = must(addFolder(t, { name: 'Work' }), 'folder Work');
  const proj = must(addFolder(t, { name: 'Project X', parentId: work.id }), 'folder Project X');
  const deep = must(addFolder(t, { name: 'Deep', parentId: proj.id }), 'folder Deep');
  const tb = addTab(t, { url: 'https://example.com', parentId: deep.id, now: 5 });
  assert.ok(tb);
  assertHealthy(t);
  assert.deepEqual(tabIdsInSubtree(t, work.id), [tb.id]);
  assert.equal(tab(t, tb.id)?.parentId, deep.id);
});

test('addTab derives a sane title from the URL', () => {
  const t = createTree();
  const a = must(addTab(t, { url: 'https://news.ycombinator.com/item?id=1' }), 'tab a');
  assert.equal(a.title, 'news.ycombinator.com');
  const b = must(addTab(t, { url: 'raha://home' }), 'tab b');
  assert.equal(b.title, 'New tab');
});

test('insert at index keeps sibling order', () => {
  const t = createTree();
  const a = must(addTab(t, { url: 'https://a.com' }), 'tab a');
  const c = must(addTab(t, { url: 'https://c.com' }), 'tab c');
  const b = must(addTab(t, { url: 'https://b.com', index: 1 }), 'tab b');
  assert.deepEqual(must(folder(t, ROOT_ID), 'root folder').childIds, [a.id, b.id, c.id]);
});

test('removeNode removes a whole subtree and reports removed tabs', () => {
  const t = createTree();
  const f = must(addFolder(t, { name: 'F' }), 'folder F');
  const t1 = must(addTab(t, { url: 'https://1.com', parentId: f.id }), 'tab t1');
  const sub = must(addFolder(t, { name: 'Sub', parentId: f.id }), 'folder Sub');
  const t2 = must(addTab(t, { url: 'https://2.com', parentId: sub.id }), 'tab t2');
  const keep = must(addTab(t, { url: 'https://keep.com' }), 'tab keep');

  const res = must(removeNode(t, f.id), 'removeNode result');
  assert.deepEqual(new Set(res.removedTabIds), new Set([t1.id, t2.id]));
  assert.deepEqual(new Set(res.removedFolderIds), new Set([f.id, sub.id]));
  assertHealthy(t);
  assert.deepEqual(allTabIds(t), [keep.id]);
});

test('removeNode refuses the root', () => {
  const t = createTree();
  assert.equal(removeNode(t, ROOT_ID), null);
  assertHealthy(t);
});

test('moveNode reparents and preserves order semantics', () => {
  const t = createTree();
  const f1 = must(addFolder(t, { name: 'F1' }), 'folder F1');
  const f2 = must(addFolder(t, { name: 'F2' }), 'folder F2');
  const a = must(addTab(t, { url: 'https://a.com', parentId: f1.id }), 'tab a');
  assert.equal(moveNode(t, a.id, f2.id, 0), true);
  assert.equal(must(tab(t, a.id), 'tab a after move').parentId, f2.id);
  assert.deepEqual(must(folder(t, f1.id), 'folder F1').childIds, []);
  assertHealthy(t);
});

test('moveNode within same parent to a later index lands intuitively', () => {
  const t = createTree();
  const a = must(addTab(t, { url: 'https://a.com' }), 'tab a');
  const b = must(addTab(t, { url: 'https://b.com' }), 'tab b');
  const c = must(addTab(t, { url: 'https://c.com' }), 'tab c');
  // drag a to before c's next slot (visual index 3 computed pre-removal)
  assert.equal(moveNode(t, a.id, ROOT_ID, 3), true);
  assert.deepEqual(must(folder(t, ROOT_ID), 'root folder').childIds, [b.id, c.id, a.id]);
  assertHealthy(t);
});

test('moveNode refuses moving a folder into its own subtree', () => {
  const t = createTree();
  const outer = must(addFolder(t, { name: 'Outer' }), 'folder Outer');
  const inner = must(addFolder(t, { name: 'Inner', parentId: outer.id }), 'folder Inner');
  assert.equal(moveNode(t, outer.id, inner.id), false);
  assert.equal(moveNode(t, outer.id, outer.id), false);
  assertHealthy(t);
});

test('moveNode refuses root and missing nodes', () => {
  const t = createTree();
  const f = must(addFolder(t, { name: 'F' }), 'folder F');
  assert.equal(moveNode(t, ROOT_ID, f.id), false);
  assert.equal(moveNode(t, 'nope', f.id), false);
  assert.equal(moveNode(t, f.id, 'nope'), false);
});

test('isAncestor', () => {
  const t = createTree();
  const a = must(addFolder(t, { name: 'A' }), 'folder A');
  const b = must(addFolder(t, { name: 'B', parentId: a.id }), 'folder B');
  const x = must(addTab(t, { url: 'https://x.com', parentId: b.id }), 'tab x');
  assert.equal(isAncestor(t, a.id, x.id), true);
  assert.equal(isAncestor(t, b.id, x.id), true);
  assert.equal(isAncestor(t, x.id, a.id), false);
});

test('checkIntegrity catches corruption; repairTree salvages tabs', () => {
  const t = createTree();
  const f = must(addFolder(t, { name: 'F' }), 'folder F');
  const kept = must(addTab(t, { url: 'https://keep.com', parentId: f.id }), 'tab kept');
  kept.keepAlive = true;
  kept.memLimitMB = 400;
  // Corrupt: folder points at a missing child + orphan tab.
  must(folder(t, f.id), 'folder F').childIds.push('ghost');
  t.nodes['orphan'] = { id: 'orphan', type: 'tab', parentId: 'nowhere', url: 'https://orphan.com', title: 'o', faviconUrl: null, keepAlive: false, memLimitMB: null, createdAt: 0, lastActiveAt: 0, navJson: null, pageState: null };

  assert.ok(checkIntegrity(t).length > 0);
  const { repaired } = repairTree(t);
  assert.equal(repaired, true);
  assertHealthy(t);
  const ids = new Set(allTabIds(t));
  assert.ok(ids.has(kept.id), 'healthy tab survived repair');
  assert.ok(ids.has('orphan'), 'orphan tab was salvaged');
  assert.equal(must(tab(t, kept.id), 'tab kept after repair').keepAlive, true, 'tab settings survive repair');
  assert.equal(must(tab(t, kept.id), 'tab kept after repair').memLimitMB, 400);
});
