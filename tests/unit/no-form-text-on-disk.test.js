// 0.3.2 (B1): typed form text never reaches the disk. The engine runs on the
// fake views but writes through the REAL json-files.js into a temp profile;
// afterwards every byte under that folder (state.json, its .tmp, any copy
// set aside, thumbnails) and every log line is searched.
//
// What the adapter keeps in memory (Chromium's page states, so Back works
// after a sleep) is shared/live-page-states.js: bounded per state
// (LIVE_STATE_MAX_CHARS), in total (LIVE_STATES_BUDGET_CHARS) and in tabs
// (LIVE_STATE_TABS), only while the setting is on, forgotten when a tab
// closes. It is not part of the engine's tree, so nothing here can write it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../src/main/core/engine.js';
import { createJsonFiles } from '../../src/main/electron/json-files.js';
import { createLivePageStates, LIVE_STATE_MAX_CHARS } from '../../src/shared/live-page-states.js';
import { FakeWorld } from '../fakes/ports.js';
import { ok, must } from '../helpers.js';

const TYPED = 'letter-to-a-quiet-friend';
const SECRET = 'river-password-123';
const CHROMIUM = 'chromium-page-state-blob';

/** Every file under dir, read as text. @param {string} dir */
function allBytes(dir) {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath ?? dir, e.name);
    if (e.isFile()) out += `\n--${p}--\n${fs.readFileSync(p, 'latin1')}`;
  }
  return out;
}

/** @param {boolean} restorePageState */
async function run(restorePageState) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raha-disk-'));
  fs.mkdirSync(path.join(dir, 'thumbs'));
  /** @type {string[]} */ const logs = [];
  const files = createJsonFiles(dir, { log: (m) => logs.push(m) });
  // A real 0.3.1 state.json (Chromium page state with typed text, user:pass@
  // in a step), cut off mid-write so it cannot be parsed: it is copied aside
  // as it was (it cannot be cleaned) and that copy is named in the notice.
  // A newer Raha's settings.json with page state in it: copied aside cleaned.
  const old031 = fs.readFileSync(new URL('../fixtures/state-0.3.1-nav.json', import.meta.url), 'utf8')
    .replace('typed-letter-to-a-friend', TYPED).replace('moonlight on water', SECRET);
  fs.writeFileSync(path.join(dir, 'state.json'), old031.slice(0, -40));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 999, pageState: { v: TYPED },
    lastUrl: 'https://name:secret@letters.example/', tree: JSON.parse(old031).tree }));
  const world = new FakeWorld();
  const ports = world.ports();
  ports.persist = { ...ports.persist, readJson: (n) => files.readJson(n, 3), writeJsonAtomic: (n, o) => { files.writeJsonAtomic(n, o); } };
  const engine = new Engine({ ...ports, onEvent: (e) => logs.push(JSON.stringify(e)) });
  engine.settingsSet({ maxLiveTabs: 10, restorePageState });
  const { tabId } = ok(engine.tabCreate({ url: 'https://letters.example/write' }));
  const v = /** @type {any} */ (must(world.viewsByTab.get(tabId), 'view'));
  v.getNav = () => ({ canGoBack: true, canGoForward: false, navJson: JSON.stringify({ entries: [
    { url: 'https://name:secret@letters.example/', title: 'Letters', pageState: `${CHROMIUM}-${TYPED}` },
    { url: 'https://letters.example/write', title: 'Write', pageState: `${CHROMIUM}-${SECRET}` },
  ], index: 1 }) });
  v.simulateScroll(40, 0);
  v.simulateFormInput([
    { p: '0/0', n: 'input:text:body', k: 'text', v: TYPED },
    { p: '0/1', n: 'input:password:pw', k: 'text', v: SECRET },
  ]);
  ok(engine.tabCreate({ url: 'https://other.example/' }));
  await Promise.resolve();
  engine.tabSleep({ tabId });
  engine.flushPersist();
  engine.shutdown();
  fs.writeFileSync(path.join(dir, 'thumbs', `${tabId}.png`), 'png'); // what views.js writes: pixels only
  const raw = files.takeRawCopies();
  assert.equal(raw.length, 1, 'the unparseable file is announced');
  assert.ok(fs.readFileSync(raw[0], 'utf8').includes(TYPED), 'it is copied as it was');
  fs.rmSync(raw[0]); // what the notice tells the person they may do; every other file is searched
  return { disk: allBytes(dir), logs: logs.join('\n') };
}

test('setting off: no typed text, no password, no Chromium page state, no user:pass@ in any file or log', async () => {
  const { disk, logs } = await run(false);
  assert.match(disk, /settings\.json\.newer-/, 'the cleaned copy is searched too');
  for (const s of [TYPED, SECRET, CHROMIUM, 'name:secret@']) {
    assert.ok(!disk.includes(s), `${s} on disk`);
    assert.ok(!logs.includes(s), `${s} in a log`);
  }
});

test('setting on: only R-104 page state (never a password, never Chromium\'s) is written', async () => {
  const { disk, logs } = await run(true);
  assert.ok(disk.includes(TYPED), 'R-104 keeps unsent text, as the setting says');
  for (const s of [SECRET, CHROMIUM, 'name:secret@']) {
    assert.ok(!disk.includes(s), `${s} on disk`);
    assert.ok(!logs.includes(s), `${s} in a log`);
  }
});

test('the in-memory store is bounded, obeys the setting, never keeps the active entry, and forgets', () => {
  let on = true;
  const store = createLivePageStates({ enabled: () => on, budgetChars: 10, maxTabs: 2 });
  const e = (/** @type {string} */ s) => [{ url: 'https://a/', pageState: s }, { url: 'https://b/', pageState: 'active' }];
  store.record('t1', e('12345'), 1);
  assert.deepEqual(store.take('t1'), { urls: ['https://a/', 'https://b/'], states: ['12345', null] }, 'the active entry\'s state is not kept');
  assert.equal(store.take('t1'), null, 'taken once');
  store.record('t1', e('123456'), 1);
  store.record('t2', e('123456'), 1);
  assert.equal(store.size(), 1, 'over the total budget the oldest tab goes');
  store.record('t3', [{ url: 'https://a/', pageState: 'x'.repeat(LIVE_STATE_MAX_CHARS + 1) }, { url: 'https://b/' }], 1);
  assert.equal(store.take('t3'), null, 'one state over the cap is not kept');
  store.forget('t2');
  assert.equal(store.size(), 0, 'a closed tab is forgotten');
  on = false;
  store.record('t4', e('1'), 1);
  assert.equal(store.size(), 0, 'nothing kept while the setting is off');
});
