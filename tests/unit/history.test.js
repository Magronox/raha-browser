import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_MAX, normalizeHistoryEntry, sanitizeHistoryEntries, mergeHistory, searchHistory,
  recordVisit, touchHistoryTitle,
  suggestHistory,
} from '../../src/shared/history.js';

const T = 1_800_000_000_000;

/** @param {string} url @param {object} [over] */
function mkEntry(url, over = {}) {
  return { url, title: 'a title', lastVisitMs: T, visitCount: 1, source: 'Chrome', ...over };
}

test('normalizeHistoryEntry accepts a clean http entry', () => {
  const e = normalizeHistoryEntry(mkEntry('https://example.com/x'));
  assert.deepEqual(e, { url: 'https://example.com/x', title: 'a title', lastVisitMs: T, visitCount: 1, source: 'Chrome' });
});

test('normalizeHistoryEntry refuses non-web schemes', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'raha://home', 'about:blank', 'data:text/html,x', 'ftp://x.com', '', 42, null]) {
    assert.equal(normalizeHistoryEntry(mkEntry(/** @type {any} */ (url))), null, String(url));
  }
  assert.equal(normalizeHistoryEntry(null), null);
  assert.equal(normalizeHistoryEntry('str'), null);
});

test('normalizeHistoryEntry coerces bad fields instead of refusing', () => {
  const e = normalizeHistoryEntry({ url: 'http://a.com', title: null, lastVisitMs: T + 0.6, visitCount: -3, source: undefined });
  assert.deepEqual(e, { url: 'http://a.com', title: '', lastVisitMs: T + 1, visitCount: 1, source: '' });
});

test('normalizeHistoryEntry refuses missing/zero/NaN timestamps and huge urls', () => {
  assert.equal(normalizeHistoryEntry({ url: 'https://a.com', lastVisitMs: 0 }), null);
  assert.equal(normalizeHistoryEntry({ url: 'https://a.com', lastVisitMs: 'soon' }), null);
  assert.equal(normalizeHistoryEntry({ url: 'https://a.com/' + 'x'.repeat(3000), lastVisitMs: T }), null);
});

test('normalizeHistoryEntry clamps title and source length', () => {
  const e = normalizeHistoryEntry(mkEntry('https://a.com', { title: 'x'.repeat(999), source: 's'.repeat(99) }));
  assert.ok(e);
  assert.equal(e.title.length, 300);
  assert.equal(e.source.length, 40);
});

test('sanitizeHistoryEntries drops junk, dedupes by url, sorts newest-first', () => {
  const { entries, dropped } = sanitizeHistoryEntries([
    mkEntry('https://a.com', { lastVisitMs: T - 100 }),
    mkEntry('https://b.com', { lastVisitMs: T }),
    mkEntry('https://a.com', { lastVisitMs: T - 50, visitCount: 7 }),
    { url: 'file:///x' },
    'garbage',
  ]);
  assert.equal(dropped, 2);
  assert.deepEqual(entries.map((e) => e.url), ['https://b.com', 'https://a.com']);
  assert.equal(entries[1].lastVisitMs, T - 50);
  assert.equal(entries[1].visitCount, 7);
});

test('sanitizeHistoryEntries handles non-array input', () => {
  assert.deepEqual(sanitizeHistoryEntries(undefined), { entries: [], dropped: 0 });
  assert.deepEqual(sanitizeHistoryEntries({ length: 2 }), { entries: [], dropped: 0 });
});

test('mergeHistory adds new urls and keeps the newer visit on collision', () => {
  const existing = [mkEntry('https://a.com', { lastVisitMs: T - 100, visitCount: 5, title: 'old A' })];
  const { entries, added, updated } = mergeHistory(existing, [
    mkEntry('https://a.com', { lastVisitMs: T, visitCount: 2, title: 'new A' }),
    mkEntry('https://b.com', { lastVisitMs: T - 10 }),
  ]);
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.deepEqual(entries.map((e) => e.url), ['https://a.com', 'https://b.com']);
  assert.equal(entries[0].title, 'new A');
  assert.equal(entries[0].visitCount, 5); // max, not sum — re-imports stay idempotent
});

test('mergeHistory is idempotent: importing the same entries twice changes nothing', () => {
  const incoming = [mkEntry('https://a.com'), mkEntry('https://b.com', { lastVisitMs: T - 1 })];
  const first = mergeHistory([], incoming);
  const second = mergeHistory(first.entries, incoming);
  assert.deepEqual(second.entries, first.entries);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
});

test('mergeHistory keeps the newest entries when over the cap', () => {
  const existing = [mkEntry('https://old.com', { lastVisitMs: 1000 })];
  const incoming = [];
  for (let i = 0; i < 5; i += 1) incoming.push(mkEntry(`https://n${i}.com`, { lastVisitMs: T + i }));
  const { entries } = mergeHistory(existing, incoming, 3);
  assert.deepEqual(entries.map((e) => e.url), ['https://n4.com', 'https://n3.com', 'https://n2.com']);
});

test('searchHistory matches url and title case-insensitively and reports total', () => {
  const entries = [
    mkEntry('https://news.ycombinator.com/item', { title: 'Hacker News', lastVisitMs: T }),
    mkEntry('https://example.com', { title: 'Plain page', lastVisitMs: T - 1 }),
    mkEntry('https://blog.example.com/hack', { title: 'Post', lastVisitMs: T - 2 }),
  ];
  const r = searchHistory(entries, 'HACK', 10, 0);
  assert.equal(r.total, 2);
  assert.deepEqual(r.entries.map((e) => e.url), ['https://news.ycombinator.com/item', 'https://blog.example.com/hack']);
});

test('searchHistory clamps limit/offset and empty query returns everything', () => {
  const entries = [mkEntry('https://a.com'), mkEntry('https://b.com', { lastVisitMs: T - 1 })];
  const all = searchHistory(entries, '', undefined, undefined);
  assert.equal(all.total, 2);
  const page = searchHistory(entries, '', 1, 1);
  assert.deepEqual(page.entries.map((e) => e.url), ['https://b.com']);
  assert.equal(page.total, 2);
});

test('HISTORY_MAX is the sanitize cap', () => {
  const raw = [];
  for (let i = 0; i < HISTORY_MAX + 5; i += 1) raw.push(mkEntry(`https://x${i}.com`, { lastVisitMs: T + i }));
  const { entries } = sanitizeHistoryEntries(raw);
  assert.equal(entries.length, HISTORY_MAX);
  assert.equal(entries[0].url, `https://x${HISTORY_MAX + 4}.com`);
});

test('recordVisit: first visit adds count 1; repeats INCREMENT (unlike mergeHistory max)', () => {
  let entries = recordVisit([], { url: 'https://a.com/', title: 'A', nowMs: T });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].visitCount, 1);
  entries = recordVisit(entries, { url: 'https://a.com/', nowMs: T + 1000 });
  assert.equal(entries[0].visitCount, 2, 'a visit is an event: += 1, not max');
  assert.equal(entries[0].lastVisitMs, T + 1000);
  assert.equal(entries[0].title, 'A', 'empty title on revisit keeps the old one');
  entries = recordVisit(entries, { url: 'https://b.com/', nowMs: T + 2000 });
  assert.deepEqual(entries.map((e) => e.url), ['https://b.com/', 'https://a.com/'], 'newest first');
});

test('recordVisit refuses non-web urls untouched', () => {
  const before = [mkEntry('https://a.com/')];
  for (const url of ['raha://home', 'blob:https://x/y', 'file:///etc/passwd', 'about:blank']) {
    assert.equal(recordVisit(before, { url, nowMs: T }), before, `${url} must be ignored`);
  }
});

test('touchHistoryTitle updates title in place without counting a visit', () => {
  const entries = [mkEntry('https://a.com/', { title: '', visitCount: 3 })];
  assert.equal(touchHistoryTitle(entries, 'https://a.com/', 'Landed'), true);
  assert.equal(entries[0].title, 'Landed');
  assert.equal(entries[0].visitCount, 3);
  assert.equal(touchHistoryTitle(entries, 'https://a.com/', 'Landed'), false, 'same title = no change');
  assert.equal(touchHistoryTitle(entries, 'https://gone.com/', 'X'), false, 'unknown url = no-op');
  assert.equal(touchHistoryTitle(entries, 'https://a.com/', ''), false, 'empty title never wipes');
});

test('suggestHistory ranks by visit count over ALL matches — no recency starvation', () => {
  const entries = [];
  for (let i = 0; i < 12; i += 1) {
    entries.push(mkEntry(`https://news-${i}.example/`, { lastVisitMs: T + i, visitCount: 1 }));
  }
  entries.push(mkEntry('https://news-hub.example/', { lastVisitMs: T - 999_999, visitCount: 300 }));
  entries.sort((a, b) => b.lastVisitMs - a.lastVisitMs); // store order: newest first
  const r = suggestHistory(entries, 'news', 6);
  assert.equal(r[0].url, 'https://news-hub.example/', 'most-visited page must win despite being oldest');
  assert.equal(r.length, 6);
  assert.deepEqual(suggestHistory(entries, '', 6), [], 'empty query suggests nothing');
});
