// The importers port implementation: read OTHER browsers' history databases.
//
// Three on-disk formats cover every supported browser:
//   chromium  <profile>/History            (Chrome, Chromium, Edge, Brave,
//                                           Vivaldi, Arc, Opera, Opera GX)
//   firefox   <profile>/places.sqlite      (Firefox, Zen)
//   safari    ~/Library/Safari/History.db
//
// Safety, by construction:
//   - HISTORY ONLY. Nothing here knows how to open a password/cookie/card
//     store; the only filenames this module touches are the three above.
//   - READ-ONLY on the source. A live browser holds its DB locked (WAL), so
//     the DB and its -wal/-shm sidecars are copied to a throwaway temp dir
//     and the COPY is opened; the original is never written, never locked.
//   - The engine treats returned rows as untrusted and re-validates each one
//     (normalizeHistoryEntry: http/https only, capped strings).
//   - readHistory() only accepts ids minted by the last scan — a sourceId is
//     an opaque token, never a path, so IPC can't be used to read arbitrary
//     SQLite files.
//
// SQLite comes from node:sqlite (Node >= 22.13, RC in Electron's Node 24) —
// no new runtime dependency (invariant #6).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from './log.js';

/** Most-recent rows read per profile; the engine caps the merged store too. */
const PER_SOURCE_CAP = 10000;

/** µs between 1601-01-01 (Chromium's epoch) and 1970-01-01, /1000 for ms. */
const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000;
/** Seconds between 1970-01-01 and 2001-01-01 (Safari's Core Data epoch). */
const SAFARI_EPOCH_OFFSET_S = 978307200;

const CHROMIUM_SQL = `
  SELECT url, title, visit_count, last_visit_time FROM urls
  WHERE last_visit_time > 0 AND hidden = 0
  ORDER BY last_visit_time DESC LIMIT ?`;

const FIREFOX_SQL = `
  SELECT url, title, visit_count, last_visit_date FROM moz_places
  WHERE last_visit_date IS NOT NULL AND hidden = 0
  ORDER BY last_visit_date DESC LIMIT ?`;

// url + visit_count live in history_items; title + visit_time in history_visits.
const SAFARI_SQL = `
  SELECT hi.url AS url, hv.title AS title, hi.visit_count AS visit_count,
         MAX(hv.visit_time) AS last_visit_time
  FROM history_items hi JOIN history_visits hv ON hv.history_item = hi.id
  GROUP BY hi.id ORDER BY last_visit_time DESC LIMIT ?`;

/** @typedef {{ browser: string, label: string, kind: 'chromium'|'firefox'|'safari', dbPath: string }} SourceInfo */

/**
 * @returns {{ scanHistorySources: () => Array<{id: string, browser: string, label: string, kind: string}>,
 *             readHistory: (sourceId: string) => { entries: any[], problems: string[] },
 *             readHistoryFile: (filePath: string) => { entries: any[], problems: string[] } }}
 */
export function createImportersPort() {
  /** @type {Map<string, SourceInfo>} */
  const byId = new Map();

  return {
    scanHistorySources() {
      byId.clear();
      const found = scanAll();
      const out = [];
      for (let i = 0; i < found.length; i += 1) {
        const id = `hs-${i}`;
        byId.set(id, found[i]);
        out.push({ id, browser: found[i].browser, label: found[i].label, kind: found[i].kind });
      }
      return out;
    },

    readHistory(sourceId) {
      const src = typeof sourceId === 'string' ? byId.get(sourceId) : undefined;
      if (!src) return { entries: [], problems: [`unknown source ${String(sourceId)}`] };
      try {
        const entries = readHistoryDb(src.kind, src.dbPath)
          .map((e) => ({ ...e, source: src.browser }));
        log('import', `${src.browser}/${src.label}: read ${entries.length} history rows`);
        return { entries, problems: [] };
      } catch (err) {
        return { entries: [], problems: [describeReadError(src, err)] };
      }
    },

    // A file the USER picked in a native dialog (the ipc adapter owns the
    // dialog — this path never comes from the renderer, so sourceIds stay
    // opaque and IPC still cannot name files). Exists mainly so Safari
    // history can come in WITHOUT Full Disk Access: a copy the user makes in
    // Finder is not TCC-protected even though the original is.
    /** @param {string} filePath */
    readHistoryFile(filePath) {
      if (typeof filePath !== 'string' || !filePath) return { entries: [], problems: ['no file chosen'] };
      try {
        const { kind, rows } = readHistoryFileDb(filePath);
        const browser = kind === 'safari' ? 'Safari' : kind === 'firefox' ? 'Firefox' : 'Chrome';
        const entries = rows.map((e) => ({ ...e, source: `${browser} (file)` }));
        log('import', `file ${path.basename(filePath)}: ${kind} schema, read ${entries.length} rows`);
        return { entries, problems: [] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { entries: [], problems: [`Could not read that file: ${msg}`] };
      }
    },
  };
}

/** @param {SourceInfo} src @param {unknown} err */
function describeReadError(src, err) {
  const msg = err instanceof Error ? err.message : String(err);
  const denied = /EPERM|EACCES|operation not permitted|unable to open database/i.test(msg);
  if (src.kind === 'safari' && denied) {
    return `${src.browser}: macOS blocked access to Safari's history (it is Full-Disk-Access protected). ` +
      'Easiest fix, no permissions needed: in Finder press Shift-Cmd-G, go to ~/Library/Safari, ' +
      'copy History.db to your Desktop, then use "From a file…" here and pick the copy. ' +
      '(Or grant Raha Full Disk Access in System Settings → Privacy & Security and retry.)';
  }
  return `${src.browser} (${src.label}): ${msg}`;
}

// ------------------------------------------------------------------ scanning

/** @returns {SourceInfo[]} */
function scanAll() {
  const home = os.homedir();
  /** @type {SourceInfo[]} */
  const out = [];

  /** @type {Array<{ browser: string, base: string }>} */
  const chromiumBrowsers = process.platform === 'darwin' ? [
    { browser: 'Chrome', base: path.join(home, 'Library/Application Support/Google/Chrome') },
    { browser: 'Chromium', base: path.join(home, 'Library/Application Support/Chromium') },
    { browser: 'Edge', base: path.join(home, 'Library/Application Support/Microsoft Edge') },
    { browser: 'Brave', base: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser') },
    { browser: 'Vivaldi', base: path.join(home, 'Library/Application Support/Vivaldi') },
    { browser: 'Arc', base: path.join(home, 'Library/Application Support/Arc/User Data') },
    { browser: 'Opera', base: path.join(home, 'Library/Application Support/com.operasoftware.Opera') },
    { browser: 'Opera GX', base: path.join(home, 'Library/Application Support/com.operasoftware.OperaGX') },
  ] : process.platform === 'win32' ? [
    { browser: 'Chrome', base: path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/User Data') },
    { browser: 'Chromium', base: path.join(process.env.LOCALAPPDATA ?? '', 'Chromium/User Data') },
    { browser: 'Edge', base: path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/User Data') },
    { browser: 'Brave', base: path.join(process.env.LOCALAPPDATA ?? '', 'BraveSoftware/Brave-Browser/User Data') },
    { browser: 'Vivaldi', base: path.join(process.env.LOCALAPPDATA ?? '', 'Vivaldi/User Data') },
    { browser: 'Opera', base: path.join(process.env.APPDATA ?? '', 'Opera Software/Opera Stable') },
    { browser: 'Opera GX', base: path.join(process.env.APPDATA ?? '', 'Opera Software/Opera GX Stable') },
  ] : [
    { browser: 'Chrome', base: path.join(home, '.config/google-chrome') },
    { browser: 'Chromium', base: path.join(home, '.config/chromium') },
    { browser: 'Edge', base: path.join(home, '.config/microsoft-edge') },
    { browser: 'Brave', base: path.join(home, '.config/BraveSoftware/Brave-Browser') },
    { browser: 'Vivaldi', base: path.join(home, '.config/vivaldi') },
    { browser: 'Opera', base: path.join(home, '.config/opera') },
  ];
  for (const b of chromiumBrowsers) out.push(...scanChromium(b.browser, b.base));

  /** @type {Array<{ browser: string, base: string }>} */
  const firefoxBrowsers = process.platform === 'darwin' ? [
    { browser: 'Firefox', base: path.join(home, 'Library/Application Support/Firefox') },
    { browser: 'Zen', base: path.join(home, 'Library/Application Support/zen') },
  ] : process.platform === 'win32' ? [
    { browser: 'Firefox', base: path.join(process.env.APPDATA ?? '', 'Mozilla/Firefox') },
    { browser: 'Zen', base: path.join(process.env.APPDATA ?? '', 'zen') },
  ] : [
    { browser: 'Firefox', base: path.join(home, '.mozilla/firefox') },
    { browser: 'Zen', base: path.join(home, '.zen') },
  ];
  for (const b of firefoxBrowsers) out.push(...scanFirefox(b.browser, b.base));

  if (process.platform === 'darwin') {
    const safariDb = path.join(home, 'Library/Safari/History.db');
    if (exists(safariDb)) out.push({ browser: 'Safari', label: 'History', kind: 'safari', dbPath: safariDb });
  }

  return out;
}

/**
 * Chromium layout: <base>/Default/History, <base>/Profile N/History. Older
 * Opera builds put History directly in <base>, so the root is checked too.
 * @param {string} browser @param {string} base
 * @returns {SourceInfo[]}
 */
function scanChromium(browser, base) {
  /** @type {SourceInfo[]} */
  const out = [];
  if (!exists(base)) return out;
  const rootDb = path.join(base, 'History');
  if (exists(rootDb)) out.push({ browser, label: 'Default', kind: 'chromium', dbPath: rootDb });
  const names = chromiumProfileNames(base);
  /** @type {string[]} */ let dirs;
  try {
    dirs = fs.readdirSync(base).filter((d) => d === 'Default' || /^Profile \d+$/.test(d));
  } catch { return out; }
  for (const dir of dirs) {
    const db = path.join(base, dir, 'History');
    if (exists(db)) out.push({ browser, label: names.get(dir) ?? dir, kind: 'chromium', dbPath: db });
  }
  return out;
}

/** Human profile names from <base>/Local State (best effort). @param {string} base */
function chromiumProfileNames(base) {
  /** @type {Map<string, string>} */
  const names = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(base, 'Local State'), 'utf8'));
    const cache = raw?.profile?.info_cache;
    if (cache && typeof cache === 'object') {
      for (const [dir, info] of Object.entries(cache)) {
        const name = /** @type {any} */ (info)?.name;
        if (typeof name === 'string' && name) names.set(dir, name.slice(0, 60));
      }
    }
  } catch { /* no Local State — fall back to directory names */ }
  return names;
}

/**
 * Firefox layout: <base>/profiles.ini names the profiles; history is
 * <profile>/places.sqlite. Lists every profile; the default (per the
 * [Install*] section, falling back to Default=1) is labeled as such.
 * @param {string} browser @param {string} base
 * @returns {SourceInfo[]}
 */
function scanFirefox(browser, base) {
  /** @type {SourceInfo[]} */
  const out = [];
  const ini = path.join(base, 'profiles.ini');
  if (!exists(ini)) return out;
  let text;
  try { text = fs.readFileSync(ini, 'utf8'); } catch { return out; }
  const { profiles, defaultPath } = parseFirefoxProfilesIni(text);
  for (const p of profiles) {
    const dir = p.isRelative ? path.join(base, p.path) : p.path;
    const db = path.join(dir, 'places.sqlite');
    if (!exists(db)) continue;
    const isDefault = p.path === defaultPath;
    const label = (p.name || path.basename(p.path)) + (isDefault ? ' (default)' : '');
    out.push({ browser, label, kind: 'firefox', dbPath: db });
  }
  return out;
}

/**
 * Parse profiles.ini. Exported for tests.
 * The [Install*] section's Default= path overrides any [ProfileN] Default=1
 * (Firefox 67+ dedicated-profiles rule).
 * @param {string} text
 * @returns {{ profiles: Array<{name: string, path: string, isRelative: boolean, isDefaultFlag: boolean}>, defaultPath: string|null }}
 */
export function parseFirefoxProfilesIni(text) {
  /** @type {Array<{name: string, path: string, isRelative: boolean, isDefaultFlag: boolean}>} */
  const profiles = [];
  /** @type {string|null} */
  let installDefault = null;
  /** @type {Record<string, string>} */
  let section = {};
  let sectionName = '';
  const flush = () => {
    if (/^Profile\d+$/i.test(sectionName) && typeof section.Path === 'string') {
      profiles.push({
        name: section.Name ?? '',
        path: section.Path,
        isRelative: section.IsRelative !== '0',
        isDefaultFlag: section.Default === '1',
      });
    } else if (/^Install/i.test(sectionName) && typeof section.Default === 'string' && !installDefault) {
      installDefault = section.Default;
    }
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { flush(); sectionName = header[1]; section = {}; continue; }
    const eq = line.indexOf('=');
    if (eq > 0) section[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  flush();
  const defaultPath = installDefault ?? profiles.find((p) => p.isDefaultFlag)?.path ?? profiles[0]?.path ?? null;
  return { profiles, defaultPath };
}

// ------------------------------------------------------------------- reading

/**
 * Copy the DB (+ WAL sidecars) to a temp dir, open the copy, run fn, clean up.
 * @template T
 * @param {string} dbPath @param {(db: DatabaseSync) => T} fn
 * @returns {T}
 */
function withDbCopy(dbPath, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raha-import-'));
  try {
    const copy = path.join(tmp, 'history.sqlite');
    fs.copyFileSync(dbPath, copy);
    for (const ext of ['-wal', '-shm', '-journal']) {
      // The live browser may checkpoint and delete a sidecar between the
      // exists() check and the copy. A vanished sidecar is fine — the main
      // file alone is a consistent database — so tolerate the race, and
      // never leave a half-copied sidecar behind to poison the read.
      try {
        if (exists(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
      } catch {
        fs.rmSync(copy + ext, { force: true });
      }
    }
    // Read-write on the throwaway copy on purpose: a read-only connection to
    // a WAL database can fail to map the -shm; the copy may be freely mutated
    // by WAL recovery and is deleted in the finally below.
    const db = new DatabaseSync(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** @param {DatabaseSync} db @param {'chromium'|'firefox'|'safari'} kind */
function queryKind(db, kind) {
  if (kind === 'chromium') {
    return queryAll(db, CHROMIUM_SQL).map((r) => row(r, chromiumToMs(num(r.last_visit_time))));
  }
  if (kind === 'firefox') {
    return queryAll(db, FIREFOX_SQL).map((r) => row(r, firefoxToMs(num(r.last_visit_date))));
  }
  return queryAll(db, SAFARI_SQL).map((r) => row(r, safariToMs(num(r.last_visit_time))));
}

/**
 * Copy the DB (+ WAL sidecars) to a temp dir, open the copy, query, clean up.
 * Exported for tests (which build synthetic DBs in all three schemas).
 * @param {'chromium'|'firefox'|'safari'} kind @param {string} dbPath
 * @returns {Array<{url: string, title: string, lastVisitMs: number, visitCount: number}>}
 */
export function readHistoryDb(kind, dbPath) {
  return withDbCopy(dbPath, (db) => queryKind(db, kind));
}

/**
 * A user-picked history database of unknown provenance: sniff the schema by
 * table names, then read with the matching query. Exported for tests.
 * @param {string} dbPath
 * @returns {{ kind: 'chromium'|'firefox'|'safari', rows: Array<{url: string, title: string, lastVisitMs: number, visitCount: number}> }}
 */
export function readHistoryFileDb(dbPath) {
  return withDbCopy(dbPath, (db) => {
    /** @type {Set<string>} */
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)),
    );
    const kind = tables.has('history_items') && tables.has('history_visits') ? 'safari'
      : tables.has('moz_places') ? 'firefox'
        : tables.has('urls') && tables.has('visits') ? 'chromium' : null;
    if (!kind) {
      throw new Error('not a browser history database (expected Safari History.db, Chrome/Chromium History, or Firefox places.sqlite)');
    }
    return { kind, rows: queryKind(db, kind) };
  });
}

/** Chromium: µs since 1601-01-01 UTC. Exported for tests. @param {number} v */
export function chromiumToMs(v) { return Math.round(v / 1000 - CHROMIUM_EPOCH_OFFSET_MS); }
/** Firefox (PRTime): µs since 1970-01-01 UTC. Exported for tests. @param {number} v */
export function firefoxToMs(v) { return Math.round(v / 1000); }
/** Safari (CFAbsoluteTime): seconds since 2001-01-01 UTC. Exported for tests. @param {number} v */
export function safariToMs(v) { return Math.round((v + SAFARI_EPOCH_OFFSET_S) * 1000); }

/**
 * Prepare + run with bigint reads on: Chromium timestamps (µs since 1601)
 * exceed 2^53 and throw as plain numbers; num() folds bigints back down.
 * setReadBigInts is the portable spelling across Node 22 (dev/CI) and 24.
 * @param {DatabaseSync} db @param {string} sql
 */
function queryAll(db, sql) {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt.all(PER_SOURCE_CAP);
}

/** @param {any} r @param {number} lastVisitMs */
function row(r, lastVisitMs) {
  return {
    url: typeof r.url === 'string' ? r.url : '',
    title: typeof r.title === 'string' ? r.title : '',
    lastVisitMs,
    visitCount: Math.max(1, num(r.visit_count)),
  };
}

/** @param {unknown} v */
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : 0; }

/** @param {string} p */
function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}
