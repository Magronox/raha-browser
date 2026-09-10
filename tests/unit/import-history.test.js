// The importer adapter against synthetic databases in all three real-world
// schemas (Chromium, Firefox, Safari). No Electron needed: import-history.js
// only uses node builtins, and node:sqlite builds the fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  readHistoryDb, readHistoryFileDb, parseFirefoxProfilesIni, chromiumToMs, firefoxToMs, safariToMs,
} from '../../src/main/electron/import-history.js';

/** @type {string[]} */
const tmpDirs = [];
/** @param {string} name */
function tmpDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raha-import-test-'));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// 2020-07-23T20:26:40Z expressed in each browser's native epoch.
const UNIX_MS = 1595536000000;
const CHROMIUM_US = BigInt(UNIX_MS) * 1000n + 11644473600000000n;
const FIREFOX_US = BigInt(UNIX_MS) * 1000n;
const SAFARI_S = UNIX_MS / 1000 - 978307200;

test('epoch conversions agree on a known instant', () => {
  assert.equal(chromiumToMs(Number(CHROMIUM_US)), UNIX_MS);
  assert.equal(firefoxToMs(Number(FIREFOX_US)), UNIX_MS);
  assert.equal(safariToMs(SAFARI_S), UNIX_MS);
});

test('readHistoryDb: chromium schema — filters hidden/unvisited, converts epoch', () => {
  const db = tmpDb('History');
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT,
          visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)`);
  const ins = d.prepare('INSERT INTO urls(url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?,?,?,?,?,?)');
  ins.run('https://kept.com/', 'Kept', 4, 0, CHROMIUM_US, 0);
  ins.run('https://older.com/', 'Older', 2, 0, CHROMIUM_US - 1_000_000n, 0);
  ins.run('https://hidden.com/', 'Hidden', 9, 0, CHROMIUM_US, 1);
  ins.run('https://never.com/', 'Never', 0, 0, 0, 0);
  d.close();

  const rows = readHistoryDb('chromium', db);
  assert.deepEqual(rows.map((r) => r.url), ['https://kept.com/', 'https://older.com/']);
  assert.deepEqual(rows[0], { url: 'https://kept.com/', title: 'Kept', lastVisitMs: UNIX_MS, visitCount: 4 });
});

test('readHistoryDb: firefox schema — NULL last_visit_date and hidden filtered', () => {
  const db = tmpDb('places.sqlite');
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT,
          visit_count INTEGER, hidden INTEGER, last_visit_date INTEGER)`);
  const ins = d.prepare('INSERT INTO moz_places(url, title, visit_count, hidden, last_visit_date) VALUES (?,?,?,?,?)');
  ins.run('https://fox.com/', 'Fox', 7, 0, FIREFOX_US);
  ins.run('https://bookmark-only.com/', 'Nope', 0, 0, null);
  ins.run('https://hidden.com/', 'Hidden', 1, 1, FIREFOX_US);
  d.close();

  const rows = readHistoryDb('firefox', db);
  assert.deepEqual(rows, [{ url: 'https://fox.com/', title: 'Fox', lastVisitMs: UNIX_MS, visitCount: 7 }]);
});

test('readHistoryDb: safari schema — join, MAX(visit_time), Core Data epoch', () => {
  const db = tmpDb('History.db');
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE history_items(id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER);
          CREATE TABLE history_visits(id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)`);
  d.prepare('INSERT INTO history_items(id, url, visit_count) VALUES (?,?,?)').run(1, 'https://apple.example/', 3);
  const ins = d.prepare('INSERT INTO history_visits(history_item, visit_time, title) VALUES (?,?,?)');
  ins.run(1, SAFARI_S - 100, 'Old title');
  ins.run(1, SAFARI_S, 'New title');
  d.close();

  const rows = readHistoryDb('safari', db);
  assert.deepEqual(rows, [{ url: 'https://apple.example/', title: 'New title', lastVisitMs: UNIX_MS, visitCount: 3 }]);
});

test('readHistoryDb: reads a live WAL database via the sidecar copy', () => {
  const db = tmpDb('History');
  const live = new DatabaseSync(db);
  live.exec('PRAGMA journal_mode=WAL');
  live.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT,
             visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)`);
  live.prepare('INSERT INTO urls(url, title, visit_count, last_visit_time, hidden) VALUES (?,?,?,?,?)')
    .run('https://wal.com/', 'In the WAL', 1, CHROMIUM_US, 0);
  // Do NOT close: simulate the browser still running and holding the DB.
  try {
    assert.ok(fs.existsSync(db + '-wal'), 'fixture really is in WAL mode');
    const rows = readHistoryDb('chromium', db);
    assert.deepEqual(rows.map((r) => r.url), ['https://wal.com/']);
  } finally {
    live.close();
  }
});

test('readHistoryFileDb: sniffs all three schemas from a user-picked copy', () => {
  // Safari copy (the Full-Disk-Access workaround this feature exists for).
  const safariDb = tmpDb('History.db');
  let d = new DatabaseSync(safariDb);
  d.exec(`CREATE TABLE history_items(id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER);
          CREATE TABLE history_visits(id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)`);
  d.prepare('INSERT INTO history_items(id, url, visit_count) VALUES (?,?,?)').run(1, 'https://apple.example/', 2);
  d.prepare('INSERT INTO history_visits(history_item, visit_time, title) VALUES (?,?,?)').run(1, SAFARI_S, 'Safari copy');
  d.close();
  const safari = readHistoryFileDb(safariDb);
  assert.equal(safari.kind, 'safari');
  assert.deepEqual(safari.rows.map((r) => r.url), ['https://apple.example/']);

  // Chromium copy: sniffing requires BOTH urls and visits tables — the real
  // schema has both, and requiring both avoids false positives.
  const chromeDb = tmpDb('History');
  d = new DatabaseSync(chromeDb);
  d.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT,
          visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
          CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)`);
  d.prepare('INSERT INTO urls(url, title, visit_count, last_visit_time, hidden) VALUES (?,?,?,?,?)')
    .run('https://chrome.example/', 'Chrome copy', 3, CHROMIUM_US, 0);
  d.close();
  const chrome = readHistoryFileDb(chromeDb);
  assert.equal(chrome.kind, 'chromium');
  assert.deepEqual(chrome.rows.map((r) => r.url), ['https://chrome.example/']);

  // Firefox copy.
  const foxDb = tmpDb('places.sqlite');
  d = new DatabaseSync(foxDb);
  d.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT,
          visit_count INTEGER, hidden INTEGER, last_visit_date INTEGER)`);
  d.prepare('INSERT INTO moz_places(url, title, visit_count, hidden, last_visit_date) VALUES (?,?,?,?,?)')
    .run('https://fox.example/', 'Fox copy', 1, 0, FIREFOX_US);
  d.close();
  const fox = readHistoryFileDb(foxDb);
  assert.equal(fox.kind, 'firefox');
  assert.deepEqual(fox.rows.map((r) => r.url), ['https://fox.example/']);
});

test('readHistoryFileDb: refuses a SQLite file that is no browser history', () => {
  const db = tmpDb('random.sqlite');
  const d = new DatabaseSync(db);
  d.exec('CREATE TABLE stuff(id INTEGER PRIMARY KEY, blob TEXT)');
  d.close();
  assert.throws(() => readHistoryFileDb(db), /not a browser history database/);
});

test('readHistoryDb: never touches the original file', () => {
  const db = tmpDb('History');
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT,
          visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)`);
  d.close();
  const before = fs.statSync(db).mtimeMs;
  readHistoryDb('chromium', db);
  assert.equal(fs.statSync(db).mtimeMs, before);
});

test('parseFirefoxProfilesIni: [Install] Default overrides Profile Default=1', () => {
  const { profiles, defaultPath } = parseFirefoxProfilesIni(`
[Install4F96D1932A9F858E]
Default=Profiles/xyz.dev-edition
Locked=1

[Profile1]
Name=default
IsRelative=1
Path=Profiles/abc.default
Default=1

[Profile0]
Name=dev
IsRelative=1
Path=Profiles/xyz.dev-edition
`);
  assert.equal(profiles.length, 2);
  assert.equal(defaultPath, 'Profiles/xyz.dev-edition');
});

test('parseFirefoxProfilesIni: falls back to Default=1, honors IsRelative=0', () => {
  const { profiles, defaultPath } = parseFirefoxProfilesIni(`
[Profile0]
Name=main
IsRelative=0
Path=/abs/path/main
Default=1
`);
  assert.deepEqual(profiles, [{ name: 'main', path: '/abs/path/main', isRelative: false, isDefaultFlag: true }]);
  assert.equal(defaultPath, '/abs/path/main');
});

test('parseFirefoxProfilesIni: garbage in, empty out', () => {
  assert.deepEqual(parseFirefoxProfilesIni(''), { profiles: [], defaultPath: null });
  assert.deepEqual(parseFirefoxProfilesIni('not an ini at all').profiles, []);
});
