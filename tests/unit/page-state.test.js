// R-104: page state capture/restore — the pure half.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_STATE_LIMITS,
  sanitizePageState, pageStateFor,
  CAPTURE_SCRIPT, restoreScript,
} from '../../src/shared/page-state.js';

// ── sanitizePageState ──────────────────────────────────────────────────

test('sanitizePageState: valid minimal (scroll only, no fields)', () => {
  const raw = { v: 1, url: 'https://a.com/', at: 1000, sx: 0, sy: 300, fields: [] };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.v, 1);
  assert.equal(ps.url, 'https://a.com/');
  assert.equal(ps.sy, 300);
  assert.deepEqual(ps.fields, []);
});

test('sanitizePageState: valid with text, check, select, multi fields', () => {
  const raw = {
    v: 1, url: 'https://x.com/form', at: 2000, sx: 0, sy: 0,
    fields: [
      { p: '0/1', n: 'input:text:name', k: 'text', v: 'Alice' },
      { p: '0/2', n: 'input:checkbox:agree', k: 'check', v: true },
      { p: '0/3', n: 'select::country', k: 'select', v: 'US' },
      { p: '0/4', n: 'select::multi', k: 'multi', v: ['a', 'b'] },
    ],
  };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.fields.length, 4);
  assert.equal(ps.fields[0].v, 'Alice');
  assert.equal(ps.fields[1].v, true);
  assert.deepEqual(ps.fields[3].v, ['a', 'b']);
});

test('sanitizePageState: rejects wrong version', () => {
  assert.equal(sanitizePageState({ v: 2, url: 'https://a.com', at: 1, sx: 0, sy: 0, fields: [] }), null);
  assert.equal(sanitizePageState({ v: 0, url: 'https://a.com', at: 1, sx: 0, sy: 0, fields: [] }), null);
});

test('sanitizePageState: rejects non-objects', () => {
  assert.equal(sanitizePageState(null), null);
  assert.equal(sanitizePageState('string'), null);
  assert.equal(sanitizePageState(42), null);
  assert.equal(sanitizePageState([]), null);
  assert.equal(sanitizePageState(undefined), null);
});

test('sanitizePageState: rejects missing required fields', () => {
  assert.equal(sanitizePageState({ v: 1, at: 1, sx: 0, sy: 0, fields: [] }), null, 'missing url');
  assert.equal(sanitizePageState({ v: 1, url: '', at: 1, sx: 0, sy: 0, fields: [] }), null, 'empty url');
  assert.equal(sanitizePageState({ v: 1, url: 'https://a.com', sx: 0, sy: 0, fields: [] }), null, 'missing at');
  assert.equal(sanitizePageState({ v: 1, url: 'https://a.com', at: NaN, sx: 0, sy: 0, fields: [] }), null, 'NaN at');
});

test('sanitizePageState: drops password fields by type in signature', () => {
  const raw = {
    v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0,
    fields: [
      { p: '0/0', n: 'input:password:pw', k: 'text', v: 'secret' },
      { p: '0/1', n: 'input:text:name', k: 'text', v: 'ok' },
    ],
  };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.fields.length, 1);
  assert.equal(ps.fields[0].n, 'input:text:name');
});

test('sanitizePageState: drops hidden and file fields', () => {
  const raw = {
    v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0,
    fields: [
      { p: '0/0', n: 'input:hidden:csrf', k: 'text', v: 'token' },
      { p: '0/1', n: 'input:file:upload', k: 'text', v: 'file.txt' },
      { p: '0/2', n: 'input:text:ok', k: 'text', v: 'kept' },
    ],
  };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.fields.length, 1);
  assert.equal(ps.fields[0].v, 'kept');
});

test('sanitizePageState: drops fields with sensitive autocomplete names', () => {
  for (const ac of ['cc-number', 'cc-name', 'cc-exp', 'one-time-code', 'current-password', 'new-password']) {
    const raw = {
      v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0,
      fields: [{ p: '0/0', n: `input:text:${ac}`, k: 'text', v: 'val' }],
    };
    assert.equal(sanitizePageState(raw)?.fields.length, 0, `${ac} dropped`);
  }
});

test('sanitizePageState: caps fields at maxFields', () => {
  const fields = Array.from({ length: 300 }, (_, i) => ({
    p: `0/${i}`, n: `input:text:f${i}`, k: 'text', v: `v${i}`,
  }));
  const raw = { v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0, fields };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.fields.length, PAGE_STATE_LIMITS.maxFields);
});

test('sanitizePageState: drops all fields (keeps scroll) when over maxBytes', () => {
  const bigValue = 'x'.repeat(PAGE_STATE_LIMITS.maxValueChars);
  const fields = Array.from({ length: 10 }, (_, i) => ({
    p: `0/${i}`, n: `input:text:f${i}`, k: 'text', v: bigValue,
  }));
  const raw = { v: 1, url: 'https://a.com', at: 1, sx: 10, sy: 200, fields };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.deepEqual(ps.fields, []);
  assert.equal(ps.sy, 200);
});

test('sanitizePageState: clamps negative scroll to 0', () => {
  const raw = { v: 1, url: 'https://a.com', at: 1, sx: -5, sy: -100, fields: [] };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.sx, 0);
  assert.equal(ps.sy, 0);
});

test('sanitizePageState: rounds scroll', () => {
  const raw = { v: 1, url: 'https://a.com', at: 1, sx: 1.7, sy: 99.3, fields: [] };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.sx, 2);
  assert.equal(ps.sy, 99);
});

test('sanitizePageState: drops fields with bad path or sig length', () => {
  const longPath = Array.from({ length: 200 }, (_, i) => i).join('/');
  const raw = {
    v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0,
    fields: [
      { p: longPath, n: 'input:text:x', k: 'text', v: 'v' },
      { p: '0/1', n: 'x'.repeat(200), k: 'text', v: 'v' },
      { p: '0/2', n: 'input:text:ok', k: 'text', v: 'kept' },
    ],
  };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.fields.length, 1);
  assert.equal(ps.fields[0].v, 'kept');
});

test('sanitizePageState: truncates long text values', () => {
  const raw = {
    v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0,
    fields: [{ p: '0/0', n: 'textarea::notes', k: 'text', v: 'a'.repeat(10000) }],
  };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(/** @type {string} */(ps.fields[0].v).length, PAGE_STATE_LIMITS.maxValueChars);
});

test('sanitizePageState: rejects invalid field kinds', () => {
  const raw = {
    v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0,
    fields: [{ p: '0/0', n: 'input:text:x', k: 'unknown', v: 'v' }],
  };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.fields.length, 0);
});

test('sanitizePageState: rejects check field with non-boolean value', () => {
  const raw = {
    v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0,
    fields: [{ p: '0/0', n: 'input:checkbox:x', k: 'check', v: 'true' }],
  };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.fields.length, 0);
});

test('sanitizePageState: rejects multi field with non-array value', () => {
  const raw = {
    v: 1, url: 'https://a.com', at: 1, sx: 0, sy: 0,
    fields: [{ p: '0/0', n: 'select::x', k: 'multi', v: 'single' }],
  };
  const ps = sanitizePageState(raw);
  assert.ok(ps);
  assert.equal(ps.fields.length, 0);
});

// ── pageStateFor ───────────────────────────────────────────────────────

test('pageStateFor: exact URL match returns scroll + fields', () => {
  const state = { v: /** @type {1} */ (1), url: 'https://a.com/p#frag', at: 1000, sx: 5, sy: 100, fields: [{ p: '0/0', n: 'input:text:x', k: /** @type {'text'} */ ('text'), v: 'hi' }] };
  const result = pageStateFor(state, 'https://a.com/p#frag', 2000);
  assert.deepEqual(result.scroll, { x: 5, y: 100 });
  assert.equal(result.fields.length, 1);
});

test('pageStateFor: different fragment = no restore', () => {
  const state = { v: /** @type {1} */ (1), url: 'https://a.com/p#a', at: 1000, sx: 0, sy: 50, fields: [] };
  const result = pageStateFor(state, 'https://a.com/p#b', 2000);
  assert.equal(result.scroll, null);
});

test('pageStateFor: different URL = no restore', () => {
  const state = { v: /** @type {1} */ (1), url: 'https://a.com/p', at: 1000, sx: 0, sy: 50, fields: [] };
  const result = pageStateFor(state, 'https://a.com/q', 2000);
  assert.equal(result.scroll, null);
  assert.deepEqual(result.fields, []);
});

test('pageStateFor: fields expire after TTL, scroll does not', () => {
  const state = {
    v: /** @type {1} */ (1), url: 'https://a.com/', at: 1000, sx: 0, sy: 200,
    fields: [{ p: '0/0', n: 'input:text:x', k: /** @type {'text'} */ ('text'), v: 'hi' }],
  };
  const withinTtl = 1000 + PAGE_STATE_LIMITS.formTtlMs;
  assert.equal(pageStateFor(state, 'https://a.com/', withinTtl).fields.length, 1, 'within TTL');
  const afterTtl = 1000 + PAGE_STATE_LIMITS.formTtlMs + 1;
  assert.equal(pageStateFor(state, 'https://a.com/', afterTtl).fields.length, 0, 'after TTL');
  assert.deepEqual(pageStateFor(state, 'https://a.com/', afterTtl).scroll, { x: 0, y: 200 }, 'scroll survives TTL');
});

// ── scripts compile ────────────────────────────────────────────────────

test('CAPTURE_SCRIPT is syntactically valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(CAPTURE_SCRIPT));
});

test('restoreScript produces valid JavaScript', () => {
  const plan = {
    scroll: { x: 0, y: 100 },
    fields: [{ p: '0/0', n: 'input:text:x', k: /** @type {'text'} */ ('text'), v: 'hi' }],
  };
  const script = restoreScript(plan);
  assert.doesNotThrow(() => new Function(script));
});

test('restoreScript with no scroll and empty fields', () => {
  const plan = { scroll: null, fields: [] };
  const script = restoreScript(plan);
  assert.doesNotThrow(() => new Function(script));
});

test('restoreScript safely handles special characters in values', () => {
  const plan = {
    scroll: null,
    fields: [{ p: '0/0', n: 'textarea::x', k: /** @type {'text'} */ ('text'), v: '</script><img onerror=alert(1)>' }],
  };
  const script = restoreScript(plan);
  assert.doesNotThrow(() => new Function(script));
  assert.ok(script.includes('</script>') || script.includes('\\u003c'),
    'value is safely contained inside JSON.stringify (no HTML context in executeJavaScript)');
});
