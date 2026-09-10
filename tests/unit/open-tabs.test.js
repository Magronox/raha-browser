// Pure open-tabs import logic (src/shared/open-tabs.js) + the engine's
// openTabsImport on fakes. The mozlz4 fixtures are handcrafted byte streams:
// LZ4 block format is simple enough to write by hand, which keeps the test
// independent of any compressor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMozLz4, parseFirefoxSession, parseBrowserWindows, sanitizeWindows, MAX_IMPORT_TABS,
} from '../../src/shared/open-tabs.js';
import { Engine } from '../../src/main/core/engine.js';
import { FakeWorld } from '../fakes/ports.js';

const MAGIC = [0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00];
/** @param {number} n 32-bit LE */
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];

test('decodeMozLz4: literal-only block round-trips', () => {
  const payload = new TextEncoder().encode('hello world');
  // token: 11 literals << 4, no match (last sequence).
  const bytes = new Uint8Array([...MAGIC, ...le32(payload.length), (payload.length << 4), ...payload]);
  assert.equal(new TextDecoder().decode(decodeMozLz4(bytes)), 'hello world');
});

test('decodeMozLz4: match sequences copy from the window, overlap included', () => {
  // "abc" + a 9-byte match at offset 3 = "abcabcabcabc" (12 bytes) — the
  // overlapping-copy RLE case a block copy would get wrong.
  const bytes = new Uint8Array([
    ...MAGIC, ...le32(12),
    0x35,             // token: 3 literals, matchLen 5 (+4 = 9)
    0x61, 0x62, 0x63, // "abc"
    0x03, 0x00,       // offset 3
  ]);
  assert.equal(new TextDecoder().decode(decodeMozLz4(bytes)), 'abcabcabcabc');
});

test('decodeMozLz4: length-extension bytes (>=15 literals) decode', () => {
  const payload = new TextEncoder().encode('x'.repeat(20)); // 15 + ext byte 5
  const bytes = new Uint8Array([...MAGIC, ...le32(20), 0xf0, 5, ...payload]);
  assert.equal(decodeMozLz4(bytes).length, 20);
});

test('decodeMozLz4: rejects bad magic, bad offsets, and short output', () => {
  assert.throws(() => decodeMozLz4(new Uint8Array([1, 2, 3])), /not a mozlz4/);
  // Match offset pointing before the start of the output.
  assert.throws(() => decodeMozLz4(new Uint8Array([
    ...MAGIC, ...le32(10), 0x15, 0x61, 0x09, 0x00,
  ])), /bad match offset/);
  // Declared size never produced.
  assert.throws(() => decodeMozLz4(new Uint8Array([
    ...MAGIC, ...le32(99), 0x30, 0x61, 0x62, 0x63,
  ])), /decoded 3 of 99/);
});

test('parseFirefoxSession: current entry via 1-based index, junk skipped', () => {
  const windows = parseFirefoxSession({
    windows: [
      {
        tabs: [
          { index: 2, entries: [{ url: 'https://old.example/', title: 'Old' }, { url: 'https://now.example/', title: 'Now' }] },
          { index: 99, entries: [{ url: 'https://clamped.example/', title: 'Clamped' }] }, // index clamps to entries
          { entries: [] },        // no entries -> skipped
          'garbage',              // not a tab -> skipped
        ],
      },
      { notTabs: true },          // not a window -> skipped
    ],
  });
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].tabs, [
    { url: 'https://now.example/', title: 'Now' },
    { url: 'https://clamped.example/', title: 'Clamped' },
  ]);
});

test('parseBrowserWindows: JXA JSON in, windows out; junk rejected', () => {
  const windows = parseBrowserWindows(JSON.stringify([
    { tabs: [{ url: 'https://a.example/', title: 'A' }, { url: 42 }, null] },
    { tabs: [] },
  ]));
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0].tabs, [{ url: 'https://a.example/', title: 'A' }]);
  assert.throws(() => parseBrowserWindows('not json'), /unreadable/);
});

test('sanitizeWindows: http(s) only, empty windows dropped, total capped', () => {
  const { windows, dropped } = sanitizeWindows([
    { tabs: [{ url: 'https://keep.example/', title: 'K' }, { url: 'about:blank', title: '' }, { url: 'chrome://newtab', title: '' }] },
    { tabs: [{ url: 'file:///etc/passwd', title: 'nope' }] },
  ]);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].tabs.map((t) => t.url), ['https://keep.example/']);
  assert.equal(dropped, 3);

  const big = [{ tabs: Array.from({ length: MAX_IMPORT_TABS + 50 }, (_, i) => ({ url: `https://t${i}.example/`, title: '' })) }];
  const capped = sanitizeWindows(big);
  assert.equal(capped.windows[0].tabs.length, MAX_IMPORT_TABS);
  assert.equal(capped.truncated, true);
});

test('engine.openTabsImport: folders per window, tabs asleep with titles', async () => {
  const world = new FakeWorld();
  world.openTabSources = [{ id: 'ts-0', browser: 'Firefox', label: 'default — window & tab layout', kind: 'session' }];
  world.openTabsBySource.set('ts-0', {
    browser: 'Firefox',
    windows: [
      { tabs: [{ url: 'https://one.example/', title: 'One' }, { url: 'https://two.example/', title: 'Two' }] },
      { tabs: [{ url: 'https://three.example/', title: 'Three' }, { url: 'about:config', title: 'skipped' }] },
    ],
    problems: [],
  });
  const engine = new Engine(world.ports());

  assert.deepEqual(engine.openTabsSources().sources.map((s) => s.id), ['ts-0']);
  const r = await engine.openTabsImport({ sourceId: 'ts-0' });
  assert.equal(r.windows, 2);
  assert.equal(r.tabs, 3);
  assert.ok(r.problems.some((p) => p.includes('1 internal')), `problems=${JSON.stringify(r.problems)}`);

  const snap = engine.snapshot();
  const top = snap.folders.find((f) => f.name === 'Firefox import');
  assert.ok(top, 'top-level import folder exists');
  const subs = snap.folders.filter((f) => f.parentId === top.id);
  assert.deepEqual(subs.map((f) => f.name), ['Window 1', 'Window 2']);
  const imported = snap.tabs.filter((t) => t.url.includes('.example/'));
  assert.equal(imported.length, 3);
  assert.ok(imported.every((t) => t.state === 'asleep'), 'imported tabs must not spawn renderers');
  assert.deepEqual(imported.map((t) => t.title).sort(), ['One', 'Three', 'Two']);
});

test('engine.openTabsImport: single window imports flat (no Window subfolder)', async () => {
  const world = new FakeWorld();
  world.openTabSources = [{ id: 'ts-0', browser: 'Safari', label: 'open windows & tabs (running)', kind: 'live' }];
  world.openTabsBySource.set('ts-0', {
    browser: 'Safari',
    windows: [{ tabs: [{ url: 'https://solo.example/', title: 'Solo' }] }],
    problems: [],
  });
  const engine = new Engine(world.ports());
  const r = await engine.openTabsImport({ sourceId: 'ts-0' });
  assert.equal(r.tabs, 1);
  const snap = engine.snapshot();
  const top = snap.folders.find((f) => f.name === 'Safari import');
  assert.ok(top, 'import folder exists');
  assert.equal(snap.folders.filter((f) => f.parentId === top.id).length, 0, 'no Window subfolder for a single window');
});

test('engine.openTabsImport: unknown source and empty results surface as problems', async () => {
  const world = new FakeWorld();
  const engine = new Engine(world.ports());
  const r = await engine.openTabsImport({ sourceId: 'nope' });
  assert.equal(r.tabs, 0);
  assert.ok(r.problems.length > 0);
  const r2 = await engine.openTabsImport({});
  assert.ok('error' in r2);
});
