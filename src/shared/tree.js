// The organization model: one tree of folders (nestable, any depth) whose
// leaves are tabs. This module is pure data manipulation — no electron, no io.
// The main-process StateStore owns one tree object and calls these functions.
//
// Conventions:
// - Functions MUTATE the passed `state` (single owner, main process) and
//   return facts about what changed. Deterministic; unit-tested.
// - Every mutation MUST keep the invariants that checkIntegrity() verifies.
//   If you add a mutation, add an integrity assertion to its unit test.

import { newId } from './ids.js';

export const ROOT_ID = 'root';

/**
 * @typedef {Object} FolderNode
 * @property {string} id
 * @property {'folder'} type
 * @property {string} name
 * @property {string|null} parentId null only for the root
 * @property {string[]} childIds ordered children (folders and tabs mixed)
 * @property {boolean} collapsed sidebar disclosure state
 */

/**
 * @typedef {Object} TabNode
 * @property {string} id
 * @property {'tab'} type
 * @property {string} parentId
 * @property {string} url
 * @property {string} title
 * @property {string|null} faviconUrl
 * @property {boolean} keepAlive   user pinned "keep running in background"
 * @property {number|null} memLimitMB per-tab override, null = none
 * @property {number} createdAt   ms epoch
 * @property {number} lastActiveAt ms epoch, 0 = never activated
 * @property {string|null} navJson serialized navigation history (entries+index) saved at sleep
 * @property {import('./page-state.js').PageState|null} pageState scroll + form state captured before sleep (R-104)
 */

/** @typedef {{ nodes: Record<string, FolderNode|TabNode>, rootId: string }} Tree */

/** @returns {Tree} */
export function createTree() {
  /** @type {FolderNode} */
  const root = { id: ROOT_ID, type: 'folder', name: 'All', parentId: null, childIds: [], collapsed: false };
  return { nodes: { [ROOT_ID]: root }, rootId: ROOT_ID };
}

/** @param {Tree} t @param {string} id @returns {FolderNode|null} */
export function folder(t, id) {
  const n = t.nodes[id];
  return n && n.type === 'folder' ? n : null;
}

/** @param {Tree} t @param {string} id @returns {TabNode|null} */
export function tab(t, id) {
  const n = t.nodes[id];
  return n && n.type === 'tab' ? n : null;
}

/**
 * @param {Tree} t
 * @param {{ name: string, parentId?: string, index?: number, id?: string }} opts
 * @returns {FolderNode|null} null if parent invalid
 */
export function addFolder(t, opts) {
  const parent = folder(t, opts.parentId ?? t.rootId);
  if (!parent) return null;
  /** @type {FolderNode} */
  const node = {
    id: opts.id ?? newId('f'),
    type: 'folder',
    name: String(opts.name || 'New folder').slice(0, 120),
    parentId: parent.id,
    childIds: [],
    collapsed: false,
  };
  t.nodes[node.id] = node;
  insertChild(parent, node.id, opts.index);
  return node;
}

/**
 * @param {Tree} t
 * @param {{ url: string, title?: string, parentId?: string, index?: number, id?: string, now?: number }} opts
 * @returns {TabNode|null} null if parent invalid
 */
export function addTab(t, opts) {
  const parent = folder(t, opts.parentId ?? t.rootId);
  if (!parent) return null;
  const now = opts.now ?? 0;
  /** @type {TabNode} */
  const node = {
    id: opts.id ?? newId('t'),
    type: 'tab',
    parentId: parent.id,
    url: String(opts.url || 'raha://home'),
    title: String(opts.title ?? '').slice(0, 300) || urlishTitle(opts.url),
    faviconUrl: null,
    keepAlive: false,
    memLimitMB: null,
    createdAt: now,
    lastActiveAt: 0,
    navJson: null,
    pageState: null,
  };
  t.nodes[node.id] = node;
  insertChild(parent, node.id, opts.index);
  return node;
}

/**
 * Remove a node (and, for folders, its whole subtree).
 * @param {Tree} t @param {string} id
 * @returns {{ removedTabIds: string[], removedFolderIds: string[] }|null} null if id is root/missing
 */
export function removeNode(t, id) {
  if (id === t.rootId) return null;
  const node = t.nodes[id];
  if (!node) return null;
  /** @type {string[]} */ const removedTabIds = [];
  /** @type {string[]} */ const removedFolderIds = [];
  const stack = [id];
  while (stack.length) {
    const cur = /** @type {string} */ (stack.pop());
    const n = t.nodes[cur];
    if (!n) continue;
    if (n.type === 'folder') {
      removedFolderIds.push(cur);
      stack.push(...n.childIds);
    } else {
      removedTabIds.push(cur);
    }
    delete t.nodes[cur];
  }
  const parent = node.parentId ? folder(t, node.parentId) : null;
  if (parent) parent.childIds = parent.childIds.filter((c) => c !== id);
  return { removedTabIds, removedFolderIds };
}

/**
 * Move a node under a new parent at an index. Refuses illegal moves.
 * @param {Tree} t @param {string} id @param {string} newParentId @param {number} [index]
 * @returns {boolean} whether the move happened
 */
export function moveNode(t, id, newParentId, index) {
  if (id === t.rootId) return false;
  const node = t.nodes[id];
  const newParent = folder(t, newParentId);
  if (!node || !newParent) return false;
  if (id === newParentId || isAncestor(t, id, newParentId)) return false; // no cycles
  const oldParent = node.parentId ? folder(t, node.parentId) : null;
  if (!oldParent) return false;

  const oldIdx = oldParent.childIds.indexOf(id);
  if (oldIdx === -1) return false;
  oldParent.childIds.splice(oldIdx, 1);

  node.parentId = newParent.id;
  insertChild(newParent, id, adjustIndex(oldParent, newParent, oldIdx, index));
  return true;
}

/**
 * Is `maybeAncestor` an ancestor of `nodeId` (or the node itself)?
 * @param {Tree} t @param {string} maybeAncestor @param {string} nodeId
 * @returns {boolean}
 */
export function isAncestor(t, maybeAncestor, nodeId) {
  /** @type {FolderNode|TabNode|undefined} */
  let cur = t.nodes[nodeId];
  let hops = 0;
  while (cur && hops < 1000) {
    if (cur.id === maybeAncestor) return true;
    cur = cur.parentId ? t.nodes[cur.parentId] : undefined;
    hops += 1;
  }
  return false;
}

/** All tab ids in the tree (unordered). @param {Tree} t @returns {string[]} */
export function allTabIds(t) {
  return Object.values(t.nodes).filter((n) => n.type === 'tab').map((n) => n.id);
}

/**
 * Tab ids inside one folder's subtree, in visual (depth-first) order.
 * @param {Tree} t @param {string} folderId @returns {string[]}
 */
export function tabIdsInSubtree(t, folderId) {
  const f = folder(t, folderId);
  if (!f) return [];
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ id) => {
    const n = t.nodes[id];
    if (!n) return;
    if (n.type === 'tab') out.push(id);
    else for (const c of n.childIds) walk(c);
  };
  for (const c of f.childIds) walk(c);
  return out;
}

/**
 * Verify structural invariants. Returns [] when healthy.
 * @param {Tree} t @returns {string[]} problems
 */
export function checkIntegrity(t) {
  /** @type {string[]} */ const problems = [];
  const root = t.nodes[t.rootId];
  if (!root || root.type !== 'folder' || root.parentId !== null) {
    problems.push('root missing or malformed');
    return problems;
  }
  const seen = new Set();
  const walk = (/** @type {string} */ id) => {
    if (seen.has(id)) { problems.push(`node ${id} reachable twice (cycle or double-parent)`); return; }
    seen.add(id);
    const n = t.nodes[id];
    if (!n) { problems.push(`dangling childId ${id}`); return; }
    if (n.type === 'folder') {
      for (const c of n.childIds) {
        const child = t.nodes[c];
        if (!child) { problems.push(`folder ${id} lists missing child ${c}`); continue; }
        if (child.parentId !== id) problems.push(`child ${c} parentId=${child.parentId} but listed under ${id}`);
        walk(c);
      }
    }
  };
  walk(t.rootId);
  for (const id of Object.keys(t.nodes)) {
    if (!seen.has(id)) problems.push(`orphan node ${id} not reachable from root`);
  }
  return problems;
}

/**
 * Best-effort repair used at load time: keeps every valid tab even if the
 * tree around it is corrupt (tabs are the user's data; folders are cheap).
 * @param {Tree} t @returns {{ repaired: boolean, problems: string[] }}
 */
export function repairTree(t) {
  const problems = checkIntegrity(t);
  if (problems.length === 0) return { repaired: false, problems };
  const fresh = createTree();
  const seenUrls = new Set();
  for (const n of Object.values(t.nodes)) {
    if (n.type === 'tab' && typeof n.url === 'string') {
      const key = n.id;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      addTab(fresh, { id: n.id, url: n.url, title: n.title, now: n.createdAt || 0 });
      const added = tab(fresh, n.id);
      if (added) {
        added.keepAlive = Boolean(n.keepAlive);
        added.memLimitMB = typeof n.memLimitMB === 'number' ? n.memLimitMB : null;
        added.lastActiveAt = typeof n.lastActiveAt === 'number' ? n.lastActiveAt : 0;
        added.faviconUrl = typeof n.faviconUrl === 'string' ? n.faviconUrl : null;
      }
    }
  }
  t.nodes = fresh.nodes;
  t.rootId = fresh.rootId;
  return { repaired: true, problems };
}

// ---------- internals ----------

/** @param {FolderNode} parent @param {string} id @param {number} [index] */
function insertChild(parent, id, index) {
  const i = index == null ? parent.childIds.length : Math.max(0, Math.min(parent.childIds.length, index));
  parent.childIds.splice(i, 0, id);
}

/**
 * When moving within the same parent to a later position, the caller's index
 * was computed before removal; keep the intuitive "drop before this item".
 * @param {FolderNode} oldParent @param {FolderNode} newParent @param {number} oldIdx @param {number|undefined} index
 * @returns {number|undefined}
 */
function adjustIndex(oldParent, newParent, oldIdx, index) {
  if (index == null) return undefined;
  if (oldParent.id === newParent.id && index > oldIdx) return index - 1;
  return index;
}

/** @param {string|undefined} url @returns {string} */
function urlishTitle(url) {
  if (!url) return 'New tab';
  try {
    const u = new URL(url);
    if (u.protocol === 'raha:') return 'New tab';
    return u.hostname || url;
  } catch {
    return url.slice(0, 80);
  }
}
