// K6 (0.3.3): a profile file Raha could not read, or one from a newer Raha,
// is never written over unless a copy was kept first. 0.3.1 copied an
// unparseable file on a best-effort basis (errors ignored), copied
// wrong-shape and newer files not at all, and then wrote over them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonFiles, tightenProfile } from '../../src/main/electron/json-files.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'raha-json-'));
const read = (/** @type {string} */ dir, /** @type {string} */ f) => fs.readFileSync(path.join(dir, f), 'utf8');
const copies = (/** @type {string} */ dir, /** @type {string} */ name) => fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.`) && !f.endsWith('.tmp'));

test('an unparseable file is copied aside before it is written over', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{"schemaVersion": 2, "tree": [half');
  const files = createJsonFiles(dir, { now: () => 111 });
  assert.equal(files.readJson('state.json', 2), undefined);
  assert.deepEqual(copies(dir, 'state.json'), ['state.json.corrupt-111']);
  assert.equal(read(dir, 'state.json.corrupt-111'), '{"schemaVersion": 2, "tree": [half');
  assert.equal(files.writeJsonAtomic('state.json', { schemaVersion: 2 }), true);
  assert.deepEqual(JSON.parse(read(dir, 'state.json')), { schemaVersion: 2 });
  assert.deepEqual(files.takeSetAside(), ['state.json.corrupt-111']);
  assert.deepEqual(files.takeSetAside(), [], 'named once');
});

test('JSON of the wrong shape (null, an array, a number) is copied aside too', () => {
  for (const body of ['null', '[1,2]', '7']) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'settings.json'), body);
    const files = createJsonFiles(dir, { now: () => 5 });
    assert.equal(files.readJson('settings.json', 3), undefined, body);
    files.writeJsonAtomic('settings.json', { schemaVersion: 3 });
    assert.equal(read(dir, 'settings.json.corrupt-5'), body);
  }
});

test('a file from a newer Raha is read as is, and kept aside before the first write', () => {
  const dir = tmp();
  const newer = JSON.stringify({ schemaVersion: 4, terminalControl: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), newer);
  const files = createJsonFiles(dir, { now: () => 9 });
  assert.deepEqual(files.readJson('settings.json', 3), { schemaVersion: 4, terminalControl: true });
  files.writeJsonAtomic('settings.json', { schemaVersion: 3 });
  assert.equal(read(dir, 'settings.json.newer-9'), newer);
  assert.deepEqual(files.takeSetAside(), ['settings.json.newer-9']);
});

test('when the copy fails the file is held: never written over, the copy retried at each write', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'history.json'), 'not json');
  let failing = true;
  /** @type {string[]} */ const logged = [];
  const files = createJsonFiles(dir, {
    now: () => 3,
    log: (m) => logged.push(m),
    copyFile: (from, to) => { if (failing) throw new Error('EACCES'); fs.copyFileSync(from, to); },
  });
  files.readJson('history.json', 1);
  assert.deepEqual(files.held(), ['history.json']);
  assert.equal(files.writeJsonAtomic('history.json', { schemaVersion: 1, entries: [] }), false);
  assert.equal(read(dir, 'history.json'), 'not json', 'the unreadable file is untouched');
  assert.ok(logged.some((m) => /not written over/.test(m)));
  failing = false;
  assert.equal(files.writeJsonAtomic('history.json', { schemaVersion: 1, entries: [] }), true);
  assert.equal(read(dir, 'history.json.corrupt-3'), 'not json');
  assert.deepEqual(files.held(), []);
});

test('a missing or ordinary file is read and written with no copy', () => {
  const dir = tmp();
  const files = createJsonFiles(dir);
  assert.equal(files.readJson('state.json', 2), undefined);
  files.writeJsonAtomic('state.json', { schemaVersion: 2 });
  assert.deepEqual(files.readJson('state.json', 2), { schemaVersion: 2 });
  files.writeJsonAtomic('state.json', { schemaVersion: 2, a: 1 });
  assert.deepEqual(copies(dir, 'state.json'), []);
  assert.deepEqual(files.takeSetAside(), []);
});

test('the persist adapter uses it for every profile file, with each file\'s known version', () => {
  const src = fs.readFileSync(new URL('../../src/main/electron/persist.js', import.meta.url), 'utf8');
  assert.match(src, /readJson: \(name\) => files\.readJson\(name, KNOWN_VERSION\[name\]\)/);
  for (const k of ["'state.json': STATE_SCHEMA_VERSION", "'settings.json': SETTINGS_SCHEMA_VERSION", "'history.json': HISTORY_SCHEMA_VERSION"]) assert.ok(src.includes(k), k);
});

const posix = process.platform !== 'win32';
/** @param {string} p */
const modeOf = (p) => fs.statSync(p).mode & 0o777;

test('profile files are written 0600, a stale temp file included', { skip: !posix }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raha-modes-'));
  fs.writeFileSync(path.join(dir, 'state.json.tmp'), 'x', { mode: 0o644 });
  const files = createJsonFiles(dir);
  assert.equal(files.writeJsonAtomic('state.json', { a: 1 }), true);
  assert.equal(modeOf(path.join(dir, 'state.json')), 0o600);
  fs.writeFileSync(path.join(dir, 'settings.json'), 'not json', { mode: 0o644 });
  files.readJson('settings.json', 1);
  const copy = fs.readdirSync(dir).find((n) => n.startsWith('settings.json.corrupt-'));
  assert.ok(copy);
  assert.equal(modeOf(path.join(dir, String(copy))), 0o600);
});

test('tightenProfile narrows folders to 0700 and files to 0600; nothing on Windows', { skip: !posix }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raha-modes-'));
  fs.chmodSync(dir, 0o755);
  fs.mkdirSync(path.join(dir, 'thumbs'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'history.json'), '{}', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'thumbs', 't_1.png'), 'x', { mode: 0o644 });
  tightenProfile(dir, { platform: 'win32' });
  assert.equal(modeOf(path.join(dir, 'history.json')), 0o644);
  tightenProfile(dir);
  assert.equal(modeOf(dir), 0o700);
  assert.equal(modeOf(path.join(dir, 'thumbs')), 0o700);
  assert.equal(modeOf(path.join(dir, 'history.json')), 0o600);
  assert.equal(modeOf(path.join(dir, 'thumbs', 't_1.png')), 0o600);
});

const FIXTURE = fs.readFileSync(new URL('../fixtures/state-0.3.1-nav.json', import.meta.url), 'utf8');

test('a parseable file set aside (newer or wrong shape) is copied cleaned: no page state, no user:pass@', () => {
  const dir = tmp();
  const newer = JSON.parse(FIXTURE);
  newer.schemaVersion = 99;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(newer));
  const files = createJsonFiles(dir, { now: () => 4 });
  files.readJson('state.json', 2);
  files.writeJsonAtomic('state.json', { schemaVersion: 2 });
  const copy = read(dir, 'state.json.newer-4');
  for (const s of ['typed-letter', 'search-box-moonlight', 'moonlight on water', 'name:secret@']) assert.ok(!copy.includes(s), s);
  assert.ok(copy.includes('mail.example/inbox') && copy.includes('Moon poems'), 'urls and titles kept');
  assert.deepEqual(files.takeRawCopies(), [], 'a cleaned copy is not announced as raw');

  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify([newer]));
  const f2 = createJsonFiles(dir2, { now: () => 5 });
  f2.readJson('state.json', 2);
  assert.ok(!read(dir2, 'state.json.corrupt-5').includes('moonlight on water'), 'wrong shape cleaned too');
});

test('an unparseable file is copied as it was and named for the notice', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), FIXTURE.slice(0, -40));
  const files = createJsonFiles(dir, { now: () => 6 });
  files.readJson('state.json', 2);
  assert.equal(read(dir, 'state.json.corrupt-6'), FIXTURE.slice(0, -40));
  assert.deepEqual(files.takeRawCopies(), [path.join(dir, 'state.json.corrupt-6')]);
});

test('a copy goes only when beyond the newest 3 AND older than two weeks; a young fourth stays; removals are named', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T = 100 * DAY;
  const dir = tmp();
  // Two old copies, one young (5 days), one newest-old: four before this run.
  for (const ts of [1, 2]) fs.writeFileSync(path.join(dir, `state.json.corrupt-${ts}`), 'old');
  fs.writeFileSync(path.join(dir, `state.json.corrupt-${T - 5 * DAY}`), 'young');
  fs.writeFileSync(path.join(dir, `state.json.newer-${T - 3 * DAY}`), 'younger');
  fs.writeFileSync(path.join(dir, 'settings.json.corrupt-1'), 'other file');
  fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
  const files = createJsonFiles(dir, { now: () => T });
  files.readJson('state.json');
  // Newest three: T, T-3d, T-5d. Beyond: 2 and 1, both old: removed.
  assert.deepEqual(copies(dir, 'state.json').sort(),
    [`state.json.corrupt-${T}`, `state.json.corrupt-${T - 5 * DAY}`, `state.json.newer-${T - 3 * DAY}`].sort());
  assert.deepEqual(files.takeRemoved().sort(), ['state.json.corrupt-1', 'state.json.corrupt-2']);
  assert.deepEqual(files.takeRemoved(), [], 'each named once');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json.corrupt-1')), 'another file\'s copies untouched');

  // One day later: four copies, the fourth (T-5d, now 6 days old) is young: it stays.
  fs.writeFileSync(path.join(dir, 'state.json'), 'not json again');
  const again = createJsonFiles(dir, { now: () => T + DAY });
  again.readJson('state.json');
  assert.equal(copies(dir, 'state.json').length, 4, 'a young fourth copy stays');
  assert.deepEqual(again.takeRemoved(), []);
});

test('an old copy within the newest 3 is never removed (count is required too)', () => {
  const dir = tmp();
  for (const ts of [1, 2]) fs.writeFileSync(path.join(dir, `state.json.corrupt-${ts}`), 'old');
  fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
  const files = createJsonFiles(dir, { now: () => 365 * 24 * 60 * 60 * 1000 });
  files.readJson('state.json');
  assert.equal(copies(dir, 'state.json').length, 3);
  assert.deepEqual(files.takeRemoved(), []);
});

test('a copy made in this run never goes, even with a clock far behind', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
  let t = 0;
  const files = createJsonFiles(dir, { now: () => t });
  files.readJson('state.json');
  for (const ts of [1, 2, 3]) fs.writeFileSync(path.join(dir, `state.json.corrupt-${ts}`), 'later');
  t = 10 ** 13;
  fs.writeFileSync(path.join(dir, 'settings.json'), 'not json');
  files.readJson('settings.json');
  fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
  files.readJson('state.json');
  assert.ok(fs.existsSync(path.join(dir, 'state.json.corrupt-0')), 'made in this run, kept');
});

test('tightenProfile never follows a symbolic link: not the profile folder, not one inside', { skip: !posix }, () => {
  const target = tmp();
  fs.chmodSync(target, 0o755);
  fs.writeFileSync(path.join(target, 'mine.txt'), 'x', { mode: 0o644 });
  const parent = tmp();
  const link = path.join(parent, 'profile');
  fs.symlinkSync(target, link);
  tightenProfile(link);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755, 'the linked folder is unchanged');
  assert.equal(fs.statSync(path.join(target, 'mine.txt')).mode & 0o777, 0o644);
  const real = tmp();
  fs.symlinkSync(path.join(target, 'mine.txt'), path.join(real, 'linked.txt'));
  tightenProfile(real);
  assert.equal(fs.statSync(path.join(target, 'mine.txt')).mode & 0o777, 0o644, 'a link inside is skipped');
});
