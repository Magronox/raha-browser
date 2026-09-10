// Pure logic for importing OPEN tabs & windows from other browsers:
//   - decodeMozLz4: Firefox's sessionstore compression (mozLz40 magic +
//     one raw LZ4 block), hand-rolled — ~60 lines beats a dependency
//     (ADR-0004 bar; the format is frozen and fully specified).
//   - parseFirefoxSession: sessionstore JSON -> windows/tabs.
//   - parseBrowserWindows: the JXA (osascript) JSON emitted by
//     src/main/electron/import-tabs.js -> windows/tabs.
//   - sanitizeWindows: shared gate — http/https only, string caps, window
//     and tab limits. Every import path funnels through it; the engine
//     re-validates each URL again at the tabCreate sink (invariant #13).

/** @typedef {{ url: string, title: string }} OpenTab */
/** @typedef {{ tabs: OpenTab[] }} OpenWindow */

export const MAX_IMPORT_TABS = 500;
export const MAX_IMPORT_WINDOWS = 40;
const MAX_TITLE = 300;
const MAX_URL = 4096;

const MOZLZ4_MAGIC = [0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00]; // "mozLz40\0"

/**
 * Decompress Firefox's mozlz4 container: 8-byte magic, LE uint32 decompressed
 * size, then a single raw LZ4 block. Throws on malformed input — callers
 * treat that as "not a session file".
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function decodeMozLz4(bytes) {
  if (bytes.length < 12 || MOZLZ4_MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a mozlz4 file');
  }
  const outLen = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | ((bytes[11] << 24) >>> 0);
  if (outLen > 512 * 1024 * 1024) throw new Error('mozlz4: implausible size');
  const out = new Uint8Array(outLen);
  let ip = 12;
  let op = 0;
  while (ip < bytes.length) {
    const token = bytes[ip++];
    // Literals.
    let litLen = token >> 4;
    if (litLen === 15) {
      let b;
      do { b = bytes[ip++]; litLen += b; } while (b === 255 && ip < bytes.length);
    }
    if (ip + litLen > bytes.length || op + litLen > outLen) throw new Error('mozlz4: truncated literals');
    out.set(bytes.subarray(ip, ip + litLen), op);
    ip += litLen;
    op += litLen;
    if (ip >= bytes.length) break; // last sequence carries no match
    // Match.
    const offset = bytes[ip] | (bytes[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('mozlz4: bad match offset');
    let matchLen = (token & 15);
    if (matchLen === 15) {
      let b;
      do { b = bytes[ip++]; matchLen += b; } while (b === 255 && ip < bytes.length);
    }
    matchLen += 4;
    if (op + matchLen > outLen) throw new Error('mozlz4: match overruns output');
    // Byte-by-byte on purpose: offsets shorter than the match length overlap
    // (LZ4's RLE trick) and a block copy would read bytes not yet written.
    for (let i = 0; i < matchLen; i += 1) {
      out[op] = out[op - offset];
      op += 1;
    }
  }
  if (op !== outLen) throw new Error(`mozlz4: decoded ${op} of ${outLen} bytes`);
  return out;
}

/**
 * Firefox/Zen sessionstore JSON -> open windows. The current URL of a tab is
 * entries[tab.index - 1] (index is 1-based); fall back to the last entry.
 * @param {unknown} session
 * @returns {OpenWindow[]}
 */
export function parseFirefoxSession(session) {
  const s = /** @type {any} */ (session);
  if (!s || !Array.isArray(s.windows)) return [];
  /** @type {OpenWindow[]} */
  const out = [];
  for (const w of s.windows) {
    if (!w || !Array.isArray(w.tabs)) continue;
    /** @type {OpenTab[]} */
    const tabs = [];
    for (const t of w.tabs) {
      if (!t || !Array.isArray(t.entries) || t.entries.length === 0) continue;
      const idx = typeof t.index === 'number' ? Math.min(Math.max(1, Math.round(t.index)), t.entries.length) : t.entries.length;
      const entry = t.entries[idx - 1];
      if (!entry || typeof entry.url !== 'string') continue;
      tabs.push({ url: entry.url, title: typeof entry.title === 'string' ? entry.title : '' });
    }
    out.push({ tabs });
  }
  return out;
}

/**
 * Parse the JSON the JXA probe prints: [{tabs: [{url, title}]}].
 * @param {string} raw
 * @returns {OpenWindow[]}
 */
export function parseBrowserWindows(raw) {
  /** @type {unknown} */
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('unreadable tab listing'); }
  if (!Array.isArray(parsed)) return [];
  /** @type {OpenWindow[]} */
  const out = [];
  for (const w of parsed) {
    const tabs = Array.isArray(/** @type {any} */ (w)?.tabs) ? /** @type {any} */ (w).tabs : [];
    out.push({
      tabs: tabs
        .filter((/** @type {any} */ t) => t && typeof t.url === 'string')
        .map((/** @type {any} */ t) => ({ url: t.url, title: typeof t.title === 'string' ? t.title : '' })),
    });
  }
  return out;
}

/**
 * The shared gate every import path funnels through: keep only http(s) tabs,
 * cap string lengths, window count, and total tabs. Reports what it dropped.
 * @param {OpenWindow[]} windows
 * @returns {{ windows: OpenWindow[], dropped: number, truncated: boolean }}
 */
export function sanitizeWindows(windows) {
  let dropped = 0;
  let truncated = false;
  let total = 0;
  /** @type {OpenWindow[]} */
  const out = [];
  for (const w of windows) {
    if (out.length >= MAX_IMPORT_WINDOWS) { truncated = true; break; }
    /** @type {OpenTab[]} */
    const tabs = [];
    for (const t of w.tabs) {
      if (!isHttpUrl(t.url)) { dropped += 1; continue; }
      if (total >= MAX_IMPORT_TABS) { truncated = true; break; }
      tabs.push({ url: t.url.slice(0, MAX_URL), title: t.title.slice(0, MAX_TITLE) });
      total += 1;
    }
    if (tabs.length > 0) out.push({ tabs });
  }
  return { windows: out, dropped, truncated };
}

/** @param {string} url */
function isHttpUrl(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}
