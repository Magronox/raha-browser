// Command palette (R-111): what it lists and how a query ranks it. Pure —
// the UI hands in the snapshot and its local context and gets back items;
// tests drive it without a DOM.
//
// Ranking is a small subsequence scorer, not a library: every query char
// must appear in order (case-insensitive) in the title, the subtitle or the
// keywords; consecutive matches and matches at word starts score higher,
// an exact prefix on the title highest. Ties keep the input order, which is
// tabs (as the sidebar shows them), then folders, then actions — so with an
// empty query the palette reads like the tree plus a short menu.

/**
 * @typedef {Object} PaletteItem
 * @property {'tab'|'folder'|'action'} kind
 * @property {string} id         tab id, folder id, or action name
 * @property {string} title
 * @property {string} subtitle   host for tabs, "N tabs" for folders, a hint for actions
 * @property {string} [state]    tab state (for the badge)
 * @property {string} [keywords] extra words a query may hit (actions)
 */

const LIMIT = 12;

/**
 * Actions the palette offers, in order. `when` gates on context: some need
 * a tab on screen. Labels are what the user types against.
 * @type {{ id: string, title: string, subtitle: string, keywords: string, when?: 'tab' }[]}
 */
const ACTIONS = [
  { id: 'new-tab', title: 'New tab', subtitle: 'Grid + address bar', keywords: 'create open' },
  { id: 'grid', title: 'Show grid', subtitle: 'Home — set the current tab aside', keywords: 'home overview' },
  { id: 'sleep-tab', title: 'Sleep this tab', subtitle: 'Frees its memory; reloads when you return', keywords: 'suspend unload', when: 'tab' },
  { id: 'freeze-tab', title: 'Freeze this tab', subtitle: 'Stops it cold, keeps it exactly', keywords: 'pause static', when: 'tab' },
  { id: 'pin-tab', title: 'Keep this tab alive', subtitle: 'Pin: never slept automatically', keywords: 'pin keepalive', when: 'tab' },
  { id: 'sleep-all', title: 'Sleep all tabs', subtitle: 'Everything goes to sleep', keywords: 'suspend all' },
  { id: 'new-folder', title: 'New folder', subtitle: 'In the sidebar', keywords: 'create group' },
  { id: 'organize', title: 'Organize tabs', subtitle: 'Group by site into folders', keywords: 'tidy sort auto' },
  { id: 'history', title: 'History', subtitle: 'Browse, search, import', keywords: 'visited import' },
  { id: 'downloads', title: 'Downloads', subtitle: 'This session', keywords: 'files' },
  { id: 'settings', title: 'Settings', subtitle: 'Governor, privacy, rules', keywords: 'preferences options' },
  { id: 'toggle-sidebar', title: 'Toggle sidebar', subtitle: 'Show or hide the tree', keywords: 'hide show panel' },
  { id: 'find', title: 'Find in page', subtitle: 'Search the current page', keywords: 'search text', when: 'tab' },
];

/**
 * @param {{ tabs: { id: string, title: string, url: string, state: string }[],
 *           folders: { id: string, name: string, parentId: string|null }[],
 *           rootId: string, activeTabId: string|null }} snap
 * @param {(url: string) => string} hostOf  display host for a URL
 * @param {(folderId: string) => number} tabsIn  subtree tab count
 * @returns {PaletteItem[]}
 */
export function buildPaletteItems(snap, hostOf, tabsIn) {
  /** @type {PaletteItem[]} */
  const items = [];
  for (const t of snap.tabs) {
    if (t.id === snap.activeTabId) continue; // already on screen
    items.push({ kind: 'tab', id: t.id, title: t.title || t.url, subtitle: hostOf(t.url), state: t.state });
  }
  for (const f of snap.folders) {
    if (f.id === snap.rootId) continue;
    const n = tabsIn(f.id);
    items.push({ kind: 'folder', id: f.id, title: f.name, subtitle: `${n} tab${n === 1 ? '' : 's'}` });
  }
  const hasTab = Boolean(snap.activeTabId);
  for (const a of ACTIONS) {
    if (a.when === 'tab' && !hasTab) continue;
    items.push({ kind: 'action', id: a.id, title: a.title, subtitle: a.subtitle, keywords: a.keywords });
  }
  return items;
}

/**
 * Subsequence score of `q` (lowercased, non-empty) in `s`; null = no match.
 * @param {string} q @param {string} s
 */
function score(q, s) {
  const t = s.toLowerCase();
  let qi = 0;
  let total = 0;
  let prevHit = -2;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] !== q[qi]) continue;
    let gain = 1;
    if (i === prevHit + 1) gain += 2; // consecutive
    if (i === 0 || /[\s\-_./:]/.test(t[i - 1])) gain += 3; // word start
    total += gain;
    prevHit = i;
    qi += 1;
  }
  if (qi < q.length) return null;
  if (t.startsWith(q)) total += 10;
  return total - Math.min(t.length, 60) / 60; // shorter fields win ties
}

/**
 * @param {PaletteItem[]} items
 * @param {string} query
 * @param {number} [limit]
 * @returns {PaletteItem[]}
 */
export function rankPalette(items, query, limit = LIMIT) {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  /** @type {{ item: PaletteItem, s: number, i: number }[]} */
  const hits = [];
  items.forEach((item, i) => {
    const best = Math.max(
      score(q, item.title) ?? -Infinity,
      (score(q, item.subtitle) ?? -Infinity) - 1,
      (item.keywords ? score(q, item.keywords) : null) ?? -Infinity,
    );
    if (best > -Infinity) hits.push({ item, s: best, i });
  });
  hits.sort((a, b) => b.s - a.s || a.i - b.i);
  return hits.slice(0, limit).map((h) => h.item);
}

export const PALETTE_ACTION_IDS = ACTIONS.map((a) => a.id);
