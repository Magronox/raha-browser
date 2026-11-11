// Omnibox input -> URL resolution. Pure; unit-tested in tests/unit/urls.test.js.

import { SEARCH_ENGINES } from './defaults.js';

/** Schemes we recognize as real schemes even without "//" after the colon. */
const KNOWN_SCHEMES = new Set([
  'http', 'https', 'raha', 'javascript', 'file', 'data', 'about', 'blob',
  'chrome', 'view-source', 'mailto', 'ftp', 'ws', 'wss', 'vbscript',
]);

/**
 * Decide what the omnibox input means.
 * Rules, in order:
 *  1. Already has a scheme we allow (http/https/raha) -> use as-is.
 *  2. "localhost[:port]/..." or an IPv4 address        -> http://
 *  3. Contains no spaces AND (has a dot or a port)     -> treat as host; https:// when httpsFirst else http://
 *  4. Otherwise                                        -> web search with the configured engine.
 * @param {string} input raw omnibox text
 * @param {{ httpsFirst: boolean, searchEngine: keyof typeof SEARCH_ENGINES }} opts
 * @returns {{ url: string, kind: 'url'|'search' }}
 */
export function resolveOmnibox(input, opts) {
  const raw = String(input ?? '').trim();
  if (!raw) return { url: 'raha://home', kind: 'url' };

  // Scheme detection. Careful: "localhost:3000" and "host.tld:8443" look like
  // schemes to a naive regex. We only treat it as a scheme when the colon is
  // followed by "//" or when it's a scheme we explicitly know about.
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    const rest = schemeMatch[2];
    const isKnown = KNOWN_SCHEMES.has(scheme);
    if (isKnown || rest.startsWith('//')) {
      if (scheme === 'http' || scheme === 'https' || scheme === 'raha') {
        return { url: raw, kind: 'url' };
      }
      // Unknown/dangerous schemes (javascript:, file:, data:...) become searches.
      return { url: searchUrl(raw, opts.searchEngine), kind: 'search' };
    }
    // else: fall through — likely host:port.
  }

  if (!/\s/.test(raw)) {
    const hostPart = raw.split(/[/?#]/)[0];
    const isLocalhost = /^localhost(:\d+)?$/i.test(hostPart);
    const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart);
    const looksLikeHost = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/i.test(hostPart);
    if (isLocalhost || isIPv4) return { url: `http://${raw}`, kind: 'url' };
    if (looksLikeHost) {
      const scheme = opts.httpsFirst ? 'https' : 'http';
      return { url: `${scheme}://${raw}`, kind: 'url' };
    }
  }

  return { url: searchUrl(raw, opts.searchEngine), kind: 'search' };
}

/**
 * @param {string} query
 * @param {keyof typeof SEARCH_ENGINES} engine
 * @returns {string}
 */
export function searchUrl(query, engine) {
  const template = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo;
  return template.replace('%s', encodeURIComponent(query));
}

/**
 * May Raha load this URL into a tab? The allow-list is the whole security
 * control: every other scheme (file:, javascript:, data:, chrome:,
 * view-source:, blob:, …) is refused.
 *
 * This matters because tab URLs do not all come from the omnibox — a web page
 * calling window.open() feeds one straight to the main process, which is NOT
 * subject to Chromium's renderer-initiated navigation blocks. Without this
 * check a hostile page can make Raha display file:///… or a data: page dressed
 * up as a login form, inside our real chrome.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isNavigableUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  const scheme = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1]?.toLowerCase();
  // blob: belongs here: it is how real sites open a generated PDF or report in
  // a new tab. A blob URL is bound to the origin that created it and cannot
  // name a file on disk, so it carries none of the risk that file:/javascript:
  // /data: do. Leaving it out silently broke that pattern.
  return scheme === 'http' || scheme === 'https' || scheme === 'raha' || scheme === 'blob';
}

/**
 * May this URL appear in a tab's RESTORED navigation history? Wider than
 * isNavigableUrl, because history is a record of where the user actually went,
 * not a load we are initiating: `about:blank` shows up whenever a page
 * navigates itself there, and it is inert.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isRestorableHistoryUrl(url) {
  return url === 'about:blank' || isNavigableUrl(url);
}

/**
 * Filter a saved navigation history down to entries that are safe to restore,
 * keeping the user's place.
 *
 * Entries come from `state.json`, so a `file:///…` entry could otherwise be
 * reached with the Back button. But refusing the WHOLE history because of one
 * odd entry throws away the user's back/forward stack — and invariant #9
 * promises history survives sleep — so drop the offenders and remap the active
 * index to the nearest surviving entry at or before it.
 *
 * @param {unknown} parsed the JSON.parse'd navJson
 * @returns {{ entries: any[], index: number }|null} null when nothing survives
 */
export function sanitizeNavEntries(parsed) {
  const raw = /** @type {any} */ (parsed);
  if (!raw || !Array.isArray(raw.entries) || raw.entries.length === 0) return null;

  const wanted = Number.isInteger(raw.index) ? raw.index : raw.entries.length - 1;
  /** @type {any[]} */ const entries = [];
  let index = 0;
  for (const [i, entry] of raw.entries.entries()) {
    if (!isRestorableHistoryUrl(entry?.url)) continue;
    entries.push(entry);
    if (i <= wanted) index = entries.length - 1; // last survivor at or before the active entry
  }
  if (entries.length === 0) return null;
  return { entries, index: Math.min(index, entries.length - 1) };
}

/**
 * A tab's back/forward steps as they may be written to disk (0.3.2): each
 * entry's address (without a name or password before the host) and title,
 * nothing else. Chromium's own `pageState` blob is never kept: it carries
 * the text of every form field in every frame, passwords included, and
 * cannot be filtered. Unsafe entries are dropped (sanitizeNavEntries).
 * Null when nothing is left or the input is not a nav list.
 * @param {unknown} navJson
 * @returns {string|null}
 */
export function cleanNavJson(navJson) {
  if (typeof navJson !== 'string' || !navJson) return null;
  /** @type {unknown} */ let parsed;
  try { parsed = JSON.parse(navJson); } catch { return null; }
  const safe = sanitizeNavEntries(parsed);
  if (!safe) return null;
  const entries = safe.entries.map((e) => ({
    url: withoutCredentials(e.url),
    title: typeof e?.title === 'string' ? e.title.slice(0, 1000) : '',
  }));
  return JSON.stringify({ entries, index: safe.index });
}

/**
 * The entries a woken tab hands Chromium (views.js restoreHistory). Saved
 * entries carry only url and title (A2), but Chromium needs an entry's own
 * `pageState` to treat a failed Back as that entry: without it, the error
 * page commits OVER the entry the user came from, so Back to a dead entry
 * (a blob: whose data died with the old renderer) bounces on it forever.
 * So the adapter keeps each sleeping tab's pageStates in memory, never on
 * disk (`live`), and this gives them back to the entries they came from,
 * in order, by URL (all but the active entry). A blob: entry that has none (after a restart, or
 * past the in-memory cap) is dropped unless it is the active one: it cannot
 * load again, and keeping it would trap Back.
 * @param {{ entries: { url: string, title: string }[], index: number }} safe sanitizeNavEntries' answer
 * @param {{ urls: string[], states: (string|null)[] }|null|undefined} live
 * @returns {{ entries: { url: string, title: string, pageState?: string }[], index: number }}
 */
export function withLivePageStates(safe, live) {
  /** @type {{ url: string, title: string, pageState?: string }[]} */ const entries = [];
  let index = 0;
  let j = 0;
  for (const [i, e] of safe.entries.entries()) {
    /** @type {string|null} */ let state = null;
    // The entry on screen never gets one: what the page shows on waking is
    // R-104's job, under the restorePageState setting. Only the entries
    // Back and Forward lead to need theirs.
    // The active entry still uses up its own slot in the live copy, or a
    // later entry with the same URL would take the active one's state.
    if (live) {
      let k = j;
      while (k < live.urls.length && live.urls[k] !== e.url) k += 1;
      if (k < live.urls.length) {
        j = k + 1;
        if (i !== safe.index) { const st = live.states[k]; state = typeof st === 'string' && st ? st : null; }
      }
    }
    if (state === null && i !== safe.index && /^blob:/i.test(e.url)) continue;
    entries.push(state === null ? { url: e.url, title: e.title } : { url: e.url, title: e.title, pageState: state });
    if (i <= safe.index) index = entries.length - 1;
  }
  return { entries, index };
}

/** The one page the UI chrome view is ever allowed to be on. */
export const UI_CHROME_URL = 'raha://app/index.html';

/**
 * Is this URL the UI chrome itself? The chrome view is the ONLY view carrying
 * the preload bridge, so any other origin it manages to reach would inherit
 * window.raha and with it every IPC channel. Used to pin that view in place
 * (src/main/electron/window.js).
 * @param {unknown} url
 * @returns {boolean}
 */
export function isUiChromeUrl(url) {
  if (typeof url !== 'string') return false;
  const [bare] = url.split('#');
  return bare === UI_CHROME_URL || bare === 'raha://app/' || bare === 'raha://app';
}

/**
 * Pretty display form for the omnibox (hide https://, keep http:// visible
 * as a subtle "not secure" signal; raha pages show as-is).
 * @param {string} url
 * @returns {string}
 */
export function displayUrl(url) {
  if (!url) return '';
  const bare = withoutCredentials(url);
  if (bare.startsWith('https://')) return bare.slice('https://'.length);
  return bare;
}

/**
 * The address without a name or password before the host
 * (`https://name:secret@site/` -> `https://site/`), nothing else changed.
 * For everything shown or saved (0.3.2); the live tab keeps its address.
 * A backslash ends the authority too (WHATWG reads it as / in http(s)), so
 * `https://evil.example\@good.example` is never cut down to good.example.
 * @param {unknown} url
 * @returns {string}
 */
export function withoutCredentials(url) {
  return String(url ?? '').replace(/^(https?:\/\/)[^/?#\\]*@/i, '$1');
}

/**
 * Canonical key for "is this the same page?": scheme + host (+ port) + path
 * (+ query). The fragment is dropped (it never leaves the page), scheme and
 * host case fold (the URL parser does that), and a lone trailing slash on the
 * path is ignored — "example.com" typed in the omnibox resolves to
 * https://example.com while the open tab reports https://example.com/.
 * Null for anything that is not a parseable URL.
 * @param {unknown} url
 * @returns {string|null}
 */
function pageKey(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : '';
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/**
 * Do two URLs name the same page (see pageKey)? Unparseable input never
 * matches anything, not even itself.
 * @param {unknown} a @param {unknown} b
 * @returns {boolean}
 */
export function sameUrl(a, b) {
  const ka = pageKey(a);
  return ka != null && ka === pageKey(b);
}

/**
 * The first tab already showing `url` (per sameUrl), or null. Drives the
 * omnibox's "switch to the tab that already has it" offer in the UI and the
 * engine's 'switch' navigation mode.
 * @template {{ id: string, url: string }} T
 * @param {Iterable<T>} tabs
 * @param {unknown} url
 * @returns {T|null}
 */
export function findTabByUrl(tabs, url) {
  const key = pageKey(url);
  if (key == null) return null;
  for (const t of tabs) if (pageKey(t.url) === key) return t;
  return null;
}

/**
 * A copy of a profile file Raha could parse but will not use (one from a
 * newer Raha, or of the wrong shape), cleaned the way the live files are
 * (0.3.2): no page state of any kind, back/forward steps as url and title
 * only, and no name or password in any address. Works on any shape, since a
 * newer Raha's file is not ours to know.
 * @param {unknown} value parsed JSON
 * @returns {unknown}
 */
export function scrubProfileValue(value) {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? withoutCredentials(value) : value;
  if (Array.isArray(value)) return value.map(scrubProfileValue);
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */ const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/^pageStates?$/i.test(k)) { out[k] = null; continue; }
    if (k === 'navJson') { out[k] = cleanNavJson(v); continue; }
    out[k] = scrubProfileValue(v);
  }
  return out;
}
