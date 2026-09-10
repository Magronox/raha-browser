// The open-tabs importers port: read OPEN windows & tabs from other browsers.
//
// Two methods, chosen for the least scary permission story on each browser:
//   live     macOS only — ask the RUNNING browser itself over Apple events
//            (osascript -l JavaScript). First use pops the system prompt
//            "Raha wants to control <browser>" (Automation permission — a
//            per-browser yes/no, NOT Full Disk Access). Works for Safari
//            and every Chromium-family browser with an AppleScript
//            dictionary.
//   session  Firefox/Zen on every platform — their profile's
//            sessionstore-backups/recovery.jsonlz4 is world-readable (no
//            TCC protection) and holds the full window/tab layout, even
//            while the browser runs. Decoded by src/shared/open-tabs.js.
//
// Safety, matching import-history.js:
//   - TABS ONLY (urls + titles). No password/cookie/card store is ever named
//     here; Apple events can only ask what the browser's dictionary offers.
//   - sourceIds are opaque tokens minted by the last scan — IPC can never
//     name an app or a path.
//   - Everything returned is untrusted: the shared sanitizer caps and
//     filters, and the engine re-validates each URL at the tabCreate sink.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { decodeMozLz4, parseFirefoxSession, parseBrowserWindows } from '../../shared/open-tabs.js';
import { parseFirefoxProfilesIni } from './import-history.js';
import { log } from './log.js';

const OSA_TIMEOUT_MS = 20000;
const OSA_MAX_BUFFER = 64 * 1024 * 1024;

/** Chromium-family tab objects expose url()/title(); Safari's are url()/name(). */
const jxaScript = (/** @type {string} */ appName, /** @type {'title'|'name'} */ titleProp) => `
  const a = Application(${JSON.stringify(appName)});
  const out = a.windows().map((w) => {
    try { return { tabs: w.tabs().map((t) => ({ url: t.url(), title: t.${titleProp}() })) }; }
    catch (e) { return { tabs: [] }; }  // window kinds without tabs (e.g. downloads)
  });
  JSON.stringify(out);`;

/** @typedef {{ browser: string, appName: string, procName: string, titleProp: 'title'|'name' }} LiveBrowser */
/** @type {LiveBrowser[]} */
const LIVE_BROWSERS = [
  { browser: 'Safari', appName: 'Safari', procName: 'Safari', titleProp: 'name' },
  { browser: 'Chrome', appName: 'Google Chrome', procName: 'Google Chrome', titleProp: 'title' },
  { browser: 'Brave', appName: 'Brave Browser', procName: 'Brave Browser', titleProp: 'title' },
  { browser: 'Edge', appName: 'Microsoft Edge', procName: 'Microsoft Edge', titleProp: 'title' },
  { browser: 'Vivaldi', appName: 'Vivaldi', procName: 'Vivaldi', titleProp: 'title' },
  { browser: 'Opera', appName: 'Opera', procName: 'Opera', titleProp: 'title' },
  { browser: 'Arc', appName: 'Arc', procName: 'Arc', titleProp: 'title' },
];

/** @typedef {{ browser: string, label: string, kind: 'live'|'session', live?: LiveBrowser, sessionPath?: string }} TabSourceInfo */

/**
 * @returns {{ scanOpenTabSources: () => Array<{id: string, browser: string, label: string, kind: string}>,
 *             readOpenTabs: (sourceId: string) => Promise<{ browser: string, windows: Array<{tabs: Array<{url: string, title: string}>}>, problems: string[] }> }}
 */
export function createTabImportersPort() {
  /** @type {Map<string, TabSourceInfo>} */
  const byId = new Map();

  return {
    scanOpenTabSources() {
      byId.clear();
      const found = scanAll();
      const out = [];
      for (let i = 0; i < found.length; i += 1) {
        const id = `ts-${i}`;
        byId.set(id, found[i]);
        out.push({ id, browser: found[i].browser, label: found[i].label, kind: found[i].kind });
      }
      return out;
    },

    async readOpenTabs(sourceId) {
      const src = typeof sourceId === 'string' ? byId.get(sourceId) : undefined;
      if (!src) return { browser: '?', windows: [], problems: [`unknown source ${String(sourceId)}`] };
      try {
        const windows = src.kind === 'live' && src.live
          ? await readLive(src.live)
          : readSession(/** @type {string} */ (src.sessionPath));
        log('import', `${src.browser}: read ${windows.reduce((n, w) => n + w.tabs.length, 0)} open tabs in ${windows.length} windows`);
        return { browser: src.browser, windows, problems: [] };
      } catch (err) {
        return { browser: src.browser, windows: [], problems: [describeError(src, err)] };
      }
    },
  };
}

/** @param {TabSourceInfo} src @param {unknown} err */
function describeError(src, err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (src.kind === 'live' && /-1743/.test(msg)) {
    return `${src.browser}: macOS blocked Raha from asking ${src.browser} for its tabs. ` +
      `Allow it under System Settings → Privacy & Security → Automation → Raha → ${src.browser}, then retry.`;
  }
  if (src.kind === 'live' && /timed? ?out|ETIMEDOUT/i.test(msg)) {
    return `${src.browser}: did not answer in time (is it hung, or showing a permission prompt?). Retry after answering any prompt.`;
  }
  return `${src.browser}: ${msg}`;
}

// ------------------------------------------------------------------ scanning

/** @returns {TabSourceInfo[]} */
function scanAll() {
  /** @type {TabSourceInfo[]} */
  const out = [];

  if (process.platform === 'darwin') {
    for (const b of LIVE_BROWSERS) {
      if (isRunning(b.procName)) {
        out.push({ browser: b.browser, label: 'open windows & tabs (running)', kind: 'live', live: b });
      }
    }
  }

  const home = os.homedir();
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
  for (const b of firefoxBrowsers) {
    const ini = path.join(b.base, 'profiles.ini');
    let text;
    try { text = fs.readFileSync(ini, 'utf8'); } catch { continue; }
    const { profiles, defaultPath } = parseFirefoxProfilesIni(text);
    for (const p of profiles) {
      const dir = p.isRelative ? path.join(b.base, p.path) : p.path;
      const sessionPath = path.join(dir, 'sessionstore-backups', 'recovery.jsonlz4');
      if (!fs.existsSync(sessionPath)) continue;
      const isDefault = p.path === defaultPath;
      const label = `${p.name || path.basename(p.path)}${isDefault ? ' (default)' : ''} — window & tab layout`;
      out.push({ browser: b.browser, label, kind: 'session', sessionPath });
    }
  }

  return out;
}

/** @param {string} procName */
function isRunning(procName) {
  try {
    execFileSync('/usr/bin/pgrep', ['-xq', procName]);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- reading

/** @param {LiveBrowser} b @returns {Promise<Array<{tabs: Array<{url: string, title: string}>}>>} */
function readLive(b) {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript', ['-l', 'JavaScript', '-e', jxaScript(b.appName, b.titleProp)],
      { timeout: OSA_TIMEOUT_MS, maxBuffer: OSA_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
        try { resolve(parseBrowserWindows(stdout)); } catch (parseErr) { reject(parseErr); }
      },
    );
  });
}

/** @param {string} sessionPath */
function readSession(sessionPath) {
  const bytes = new Uint8Array(fs.readFileSync(sessionPath));
  const json = JSON.parse(new TextDecoder().decode(decodeMozLz4(bytes)));
  return parseFirefoxSession(json);
}
