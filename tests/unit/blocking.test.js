// The pure blocking pipeline (src/shared/blocking.js) on fake matchers —
// the conformance heir of the deleted blocklist.test.js, guarantee by
// guarantee. Real-engine behavior (do the bundled lists actually block
// doubleclick?) lives in blocklist-artifacts.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideBlock, isBlockableUrl, isShieldOff } from '../../src/shared/blocking.js';
import { defaultSettings } from '../../src/shared/defaults.js';

/** Matchers whose answers are fixed and whose calls are counted. */
function fakeMatchers({ ads = false, tracking = false } = {}) {
  const calls = { ads: 0, tracking: 0 };
  return {
    calls,
    matchAds: () => (calls.ads += 1, ads),
    matchTracking: () => (calls.tracking += 1, tracking),
  };
}

const req = (/** @type {string} */ url, resourceType = 'script') => ({ url, resourceType });

test('never consults engines when both toggles are off', () => {
  const s = { ...defaultSettings(), blockAds: false, blockTrackers: false };
  const m = fakeMatchers({ ads: true, tracking: true });
  assert.equal(decideBlock(req('https://ad.example/x.js'), 'news.com', s, m), false);
  assert.equal(m.calls.ads + m.calls.tracking, 0);
});

test('ignores non-blockable and garbage URLs; ws:// now reaches the engines', () => {
  const s = defaultSettings();
  const m = fakeMatchers({ ads: true });
  for (const u of ['raha://home', 'not a url', 'data:text/html,x', 'blob:https://a/b', 'file:///etc/passwd']) {
    assert.equal(decideBlock(req(u), 'news.com', s, m), false, u);
  }
  assert.equal(m.calls.ads, 0);
  // Deliberate flip of the old curated-list behavior (its test asserted
  // non-http(s) is never blocked): websockets are blockable in R-102.
  assert.equal(decideBlock(req('ws://tracker.example/socket', 'webSocket'), 'news.com', s, m), true);
  assert.equal(isBlockableUrl('wss://tracker.example/socket'), true);
});

test('never cancels mainFrame requests even when the engine matches', () => {
  const m = fakeMatchers({ ads: true, tracking: true });
  assert.equal(decideBlock(req('https://ads.example/landing', 'mainFrame'), null, defaultSettings(), m), false);
  assert.equal(m.calls.ads + m.calls.tracking, 0);
});

test('per-site shield off suppresses both engines', () => {
  const s = { ...defaultSettings(), noBlockHosts: ['example.com'] };
  const m = fakeMatchers({ ads: true, tracking: true });
  for (const top of ['example.com', 'www.example.com', 'sub.example.com']) {
    assert.equal(decideBlock(req('https://ad.doubleclick.net/x.js'), top, s, m), false, top);
  }
  assert.equal(m.calls.ads + m.calls.tracking, 0);
  // Similar-but-different hosts are NOT covered.
  assert.equal(decideBlock(req('https://ad.doubleclick.net/x.js'), 'notexample.com', s, m), true);
  assert.equal(decideBlock(req('https://ad.doubleclick.net/x.js'), 'example.org', s, m), true);
});

test('blockAds off consults only the tracking engine, and vice versa', () => {
  const adsOnly = { ...defaultSettings(), blockTrackers: false };
  let m = fakeMatchers({ ads: false, tracking: true });
  assert.equal(decideBlock(req('https://t.example/p.js'), 'news.com', adsOnly, m), false);
  assert.equal(m.calls.ads, 1);
  assert.equal(m.calls.tracking, 0);

  const trackingOnly = { ...defaultSettings(), blockAds: false };
  m = fakeMatchers({ ads: true, tracking: false });
  assert.equal(decideBlock(req('https://a.example/p.js'), 'news.com', trackingOnly, m), false);
  assert.equal(m.calls.ads, 0);
  assert.equal(m.calls.tracking, 1);
});

test('unknown top host (null) still blocks on engine match', () => {
  const m = fakeMatchers({ tracking: true });
  assert.equal(decideBlock(req('https://tracker.example/pixel'), null, defaultSettings(), m), true);
});

test('isShieldOff: www and case are transparent; empty list fast-path', () => {
  assert.equal(isShieldOff('WWW.Example.COM', ['example.com']), true);
  assert.equal(isShieldOff('example.com', []), false);
  assert.equal(isShieldOff(null, ['example.com']), false);
});
