// Global browsing-history store: pure merge/search/sanitize logic.
//
// Entries arrive from the importers port (other browsers' databases — see
// src/main/electron/import-history.js) and are persisted by the engine as
// history.json (versioned via migrateHistory in migrate.js). This module
// never does IO and never sees a database: it works on plain entry objects.
//
// Safety rules enforced here (the engine relies on them):
//   - only http/https URLs are ever kept (imported files can contain file:,
//     chrome:, javascript: etc. — none of those belong in a click target);
//   - strings are length-capped, counts/timestamps are coerced to sane
//     numbers, and the store is capped at HISTORY_MAX entries (most recent
//     kept), so a hostile/corrupt source file cannot balloon history.json.

/**
 * @typedef {Object} HistoryEntry
 * @property {string} url          http(s) only, <= URL_MAX chars
 * @property {string} title        may be '', <= TITLE_MAX chars
 * @property {number} lastVisitMs  ms epoch of the most recent visit, > 0
 * @property {number} visitCount   >= 1
 * @property {string} source       browser it came from, e.g. 'Chrome' ('' ok)
 */

export const HISTORY_MAX = 20000;
const URL_MAX = 2048;
const TITLE_MAX = 300;
const SOURCE_MAX = 40;

/** Only the web belongs in history: stricter than isNavigableUrl on purpose.
 * @param {unknown} url @returns {url is string} */
function isHistoryUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Coerce one raw entry (from an importer or from history.json on disk) into
 * a valid HistoryEntry, or null if it is unusable.
 * @param {unknown} raw
 * @returns {HistoryEntry|null}
 */
export function normalizeHistoryEntry(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const r = /** @type {any} */ (raw);
  if (!isHistoryUrl(r.url) || r.url.length > URL_MAX) return null;
  const lastVisitMs = Number(r.lastVisitMs);
  if (!Number.isFinite(lastVisitMs) || lastVisitMs <= 0) return null;
  const count = Number(r.visitCount);
  return {
    url: r.url,
    title: String(r.title ?? '').slice(0, TITLE_MAX),
    lastVisitMs: Math.round(lastVisitMs),
    visitCount: Number.isFinite(count) && count >= 1 ? Math.round(count) : 1,
    source: String(r.source ?? '').slice(0, SOURCE_MAX),
  };
}

/**
 * Sanitize a raw entry list (e.g. read back from disk): drop invalid rows,
 * dedupe by URL (newest wins), sort newest-first, cap at HISTORY_MAX.
 * @param {unknown} raw
 * @returns {{ entries: HistoryEntry[], dropped: number }}
 */
export function sanitizeHistoryEntries(raw) {
  if (!Array.isArray(raw)) return { entries: [], dropped: 0 };
  let dropped = 0;
  /** @type {Map<string, HistoryEntry>} */
  const byUrl = new Map();
  for (const item of raw) {
    const e = normalizeHistoryEntry(item);
    if (!e) { dropped += 1; continue; }
    const prev = byUrl.get(e.url);
    if (!prev || e.lastVisitMs > prev.lastVisitMs) byUrl.set(e.url, mergeTwo(prev, e));
    else byUrl.set(e.url, mergeTwo(e, prev));
  }
  const entries = [...byUrl.values()].sort(byRecency).slice(0, HISTORY_MAX);
  return { entries, dropped };
}

/**
 * Merge freshly imported entries into the existing store.
 * Dedupe key is the exact URL; the newer visit wins the title, visitCount is
 * the max of both sides (imports are idempotent — re-importing the same
 * browser twice must not inflate counts).
 * @param {HistoryEntry[]} existing  assumed already sanitized
 * @param {HistoryEntry[]} incoming  assumed already normalized
 * @param {number} [cap]
 * @returns {{ entries: HistoryEntry[], added: number, updated: number }}
 */
export function mergeHistory(existing, incoming, cap = HISTORY_MAX) {
  /** @type {Map<string, HistoryEntry>} */
  const byUrl = new Map(existing.map((e) => [e.url, e]));
  let added = 0;
  let updated = 0;
  for (const e of incoming) {
    const prev = byUrl.get(e.url);
    if (!prev) { byUrl.set(e.url, e); added += 1; continue; }
    const merged = e.lastVisitMs >= prev.lastVisitMs ? mergeTwo(prev, e) : mergeTwo(e, prev);
    if (merged.lastVisitMs !== prev.lastVisitMs || merged.visitCount !== prev.visitCount) updated += 1;
    byUrl.set(e.url, merged);
  }
  const entries = [...byUrl.values()].sort(byRecency).slice(0, cap);
  return { entries, added, updated };
}

/**
 * Record one of Raha's OWN visits (R-106). Distinct from mergeHistory on
 * purpose: imports reconcile two stores (visitCount = max), a visit is an
 * event (visitCount += 1). Returns a NEW sorted/capped array; entries with
 * non-web URLs are ignored (raha://, blob: — same rule as imports).
 * @param {HistoryEntry[]} entries  current store, newest-first
 * @param {{ url: string, title?: string, nowMs: number }} visit
 * @returns {HistoryEntry[]} updated entries (=== input array if ignored)
 */
export function recordVisit(entries, visit) {
  if (!isHistoryUrl(visit.url) || visit.url.length > URL_MAX) return entries;
  const prev = entries.find((e) => e.url === visit.url);
  /** @type {HistoryEntry} */
  const next = {
    url: visit.url,
    title: String(visit.title ?? '').slice(0, TITLE_MAX) || prev?.title || '',
    lastVisitMs: Math.max(Math.round(visit.nowMs), prev?.lastVisitMs ?? 0),
    visitCount: (prev?.visitCount ?? 0) + 1,
    source: prev?.source ?? '',
  };
  const rest = prev ? entries.filter((e) => e.url !== visit.url) : entries;
  return [next, ...rest].sort(byRecency).slice(0, HISTORY_MAX);
}

/**
 * A page's title often arrives after its navigation was recorded — update it
 * in place without counting another visit. No-op if the URL isn't stored.
 * @param {HistoryEntry[]} entries @param {string} url @param {string} title
 * @returns {boolean} whether anything changed
 */
export function touchHistoryTitle(entries, url, title) {
  const t = String(title ?? '').slice(0, TITLE_MAX);
  if (!t) return false;
  const e = entries.find((x) => x.url === url);
  if (!e || e.title === t) return false;
  e.title = t;
  return true;
}

/**
 * Rank matches for the omnibox dropdown: visit count first, recency as the
 * tiebreak, over ALL matches — searchHistory's recency-slice would starve a
 * much-visited page behind twelve one-off recent ones.
 * @param {HistoryEntry[]} entries @param {string} query @param {number} [limit]
 * @returns {HistoryEntry[]}
 */
export function suggestHistory(entries, query, limit) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const lim = clampInt(limit, 1, 50, 6);
  return entries
    .filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
    .sort((a, b) => b.visitCount - a.visitCount || b.lastVisitMs - a.lastVisitMs)
    .slice(0, lim);
}

/**
 * Case-insensitive substring search over url+title.
 * @param {HistoryEntry[]} entries  assumed sorted newest-first
 * @param {string} query
 * @param {number} [limit]
 * @param {number} [offset]
 * @returns {{ entries: HistoryEntry[], total: number }}
 */
export function searchHistory(entries, query, limit, offset = 0) {
  const q = String(query ?? '').trim().toLowerCase();
  const matched = q
    ? entries.filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
    : entries;
  const lim = clampInt(limit, 1, 500, 200);
  const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
  return { entries: matched.slice(off, off + lim), total: matched.length };
}

/** newer entry (by lastVisitMs) is `win`; keep its title unless empty.
 * @param {HistoryEntry|undefined} lose @param {HistoryEntry} win @returns {HistoryEntry} */
function mergeTwo(lose, win) {
  if (!lose) return win;
  return {
    url: win.url,
    title: win.title || lose.title,
    lastVisitMs: Math.max(win.lastVisitMs, lose.lastVisitMs),
    visitCount: Math.max(win.visitCount, lose.visitCount),
    source: win.source || lose.source,
  };
}

/** @param {HistoryEntry} a @param {HistoryEntry} b */
function byRecency(a, b) {
  return b.lastVisitMs - a.lastVisitMs || (a.url < b.url ? -1 : 1);
}

/** @param {unknown} v @param {number} min @param {number} max @param {number} dflt */
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
