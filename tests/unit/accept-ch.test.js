// The header-hook half of the Chrome identity (src/shared/client-hints.js,
// layers 2 + 3): Accept-CH parsing, the per-origin cache, and the pure
// header decision privacy.js applies to every request. Electron hands the
// hook mixed-case keys ('User-Agent', 'Sec-CH-UA'), which is why every
// case here checks casing on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAcceptCh,
  acceptChFromResponse,
  AcceptChCache,
  applyClientHintHeaders,
  planClientHints,
  alignChromeBrands,
  clientHintsAllowedFor,
  hintOrigin,
  setHeader,
  chromeClientHints,
  HIGH_ENTROPY_HINTS,
} from '../../src/shared/client-hints.js';

const HINTS = chromeClientHints({ chromeVersion: '150.0.7871.224', platform: 'darwin', arch: 'x64', osVersion: '14.6.1' });
const LOW = HINTS.lowEntropyHeaders;
const HIGH = HINTS.highEntropyHeaders;
const UNBRANDED = '"Not;A=Brand";v="8", "Chromium";v="150"';
const BRANDED = '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"';

// ------------------------------------------------------------ parseAcceptCh

test('parseAcceptCh: supported names, lowercased, in order', () => {
  assert.deepEqual(
    parseAcceptCh('Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version'),
    ['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version'],
  );
});

test('parseAcceptCh: tolerant of case, spacing, empties and duplicates', () => {
  assert.deepEqual(
    parseAcceptCh('  SEC-ch-ua-ARCH ,sec-ch-ua-bitness,, Sec-CH-UA-Arch ,'),
    ['sec-ch-ua-arch', 'sec-ch-ua-bitness'],
  );
});

test('parseAcceptCh: drops unknown tokens and the hints Chrome sends regardless', () => {
  // The low-entropy three, Chrome's legacy UA-* names, and non-UA hints.
  assert.deepEqual(parseAcceptCh('Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform, UA-Platform, Viewport-Width, DPR'), []);
  // Every high-entropy UA hint Chrome 150 sends when asked is honored —
  // the deprecated Full-Version, WoW64 and Form-Factors included: real
  // Chrome sends all three against a Cloudflare-shaped Accept-CH (measured
  // side by side, 2026-08-26), so omitting them would be the tell.
  assert.deepEqual(parseAcceptCh('Sec-CH-UA-WoW64, Sec-CH-UA-Full-Version, Sec-CH-UA-Form-Factors'), [
    'sec-ch-ua-wow64', 'sec-ch-ua-full-version', 'sec-ch-ua-form-factors',
  ]);
  // Cloudflare's real header (2026) → exactly its UA-CH subset, in order.
  const cf = 'Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version, Sec-CH-UA-Mobile, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform, Sec-CH-UA, UA-Bitness, UA-Arch, UA-Full-Version, UA-Mobile, UA-Model, UA-Platform-Version, UA-Platform, UA';
  assert.deepEqual(parseAcceptCh(cf), [
    'sec-ch-ua-bitness', 'sec-ch-ua-arch', 'sec-ch-ua-full-version', 'sec-ch-ua-model', 'sec-ch-ua-platform-version', 'sec-ch-ua-full-version-list',
  ]);
});

test('parseAcceptCh: empty / missing / odd input → []', () => {
  for (const v of ['', '   ', ',,,', undefined, null, /** @type {any} */ (42), /** @type {any} */ ({})]) {
    assert.deepEqual(parseAcceptCh(v), [], `input ${String(v)}`);
  }
  // Electron gives response header values as string[]; a joined array parses.
  assert.deepEqual(parseAcceptCh(['Sec-CH-UA-Arch', 'Sec-CH-UA-Model']), ['sec-ch-ua-arch', 'sec-ch-ua-model']);
});

test('HIGH_ENTROPY_HINTS is exactly what chromeClientHints can synthesize', () => {
  assert.deepEqual([...HIGH_ENTROPY_HINTS].sort(), Object.keys(HIGH).sort());
});

test('acceptChFromResponse: Accept-CH ∪ Critical-CH, any key casing, array values', () => {
  assert.deepEqual(acceptChFromResponse({
    'Content-Type': ['text/html'],
    'Accept-CH': ['Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version'],
    'critical-ch': ['Sec-CH-UA-Platform-Version', 'Sec-CH-UA-Arch'],
  }), ['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch']);
  assert.deepEqual(acceptChFromResponse({ 'content-type': ['text/html'] }), []);
  assert.deepEqual(acceptChFromResponse(undefined), []);
  assert.deepEqual(acceptChFromResponse({ 'ACCEPT-CH': 'Sec-CH-UA-Bitness' }), ['sec-ch-ua-bitness']);
});

// ------------------------------------------------------------ AcceptChCache

test('AcceptChCache: remembers per origin; unknown origins get nothing', () => {
  const c = new AcceptChCache();
  c.remember('https://a.example', ['sec-ch-ua-arch']);
  assert.deepEqual(c.hintsFor('https://a.example'), ['sec-ch-ua-arch']);
  assert.deepEqual(c.hintsFor('https://b.example'), []);
  assert.deepEqual(c.hintsFor('https://a.example:8443'), [], 'port is part of the origin');
  assert.deepEqual(c.hintsFor(null), []);
  assert.deepEqual(c.hintsFor(undefined), []);
  assert.equal(c.size, 1);
});

test('AcceptChCache: a second Accept-CH merges; empty/invalid input is a no-op', () => {
  const c = new AcceptChCache();
  c.remember('https://a.example', ['sec-ch-ua-arch']);
  c.remember('https://a.example', ['sec-ch-ua-bitness', 'sec-ch-ua-arch']);
  assert.deepEqual(c.hintsFor('https://a.example').sort(), ['sec-ch-ua-arch', 'sec-ch-ua-bitness']);
  c.remember('https://a.example', []);
  c.remember(null, ['sec-ch-ua-model']);
  c.remember('https://a.example', /** @type {any} */ ('sec-ch-ua-model'));
  assert.deepEqual(c.hintsFor('https://a.example').sort(), ['sec-ch-ua-arch', 'sec-ch-ua-bitness']);
  assert.equal(c.size, 1);
  // The returned array is a copy: mutating it must not touch the cache.
  c.hintsFor('https://a.example').push('sec-ch-ua-model');
  assert.deepEqual(c.hintsFor('https://a.example').sort(), ['sec-ch-ua-arch', 'sec-ch-ua-bitness']);
});

test('AcceptChCache: bounded LRU — the least recently used origin goes first', () => {
  const c = new AcceptChCache(3);
  c.remember('https://1.example', ['sec-ch-ua-arch']);
  c.remember('https://2.example', ['sec-ch-ua-arch']);
  c.remember('https://3.example', ['sec-ch-ua-arch']);
  c.hintsFor('https://1.example'); // touch: 1 is now the most recent
  c.remember('https://4.example', ['sec-ch-ua-arch']); // evicts 2
  assert.equal(c.size, 3);
  assert.deepEqual(c.hintsFor('https://2.example'), []);
  assert.deepEqual(c.hintsFor('https://1.example'), ['sec-ch-ua-arch']);
  assert.deepEqual(c.hintsFor('https://4.example'), ['sec-ch-ua-arch']);
  // Re-remembering an existing origin touches it too.
  c.remember('https://3.example', ['sec-ch-ua-model']);
  c.remember('https://5.example', ['sec-ch-ua-arch']); // evicts 1 (oldest untouched)
  assert.deepEqual(c.hintsFor('https://1.example'), []);
  assert.deepEqual(c.hintsFor('https://3.example').sort(), ['sec-ch-ua-arch', 'sec-ch-ua-model']);
  assert.equal(new AcceptChCache().max, 500, 'default cap is 500 origins');
  assert.equal(new AcceptChCache(0).max, 1, 'cap never drops below one');
});

test('AcceptChCache.forget: the site, its subdomains and parent domains — clearSiteData\'s reach; clear() empties it', () => {
  const c = new AcceptChCache();
  c.remember('https://a.example', ['sec-ch-ua-arch']);
  c.remember('https://www.a.example:8443', ['sec-ch-ua-arch']);
  c.remember('https://login.a.example', ['sec-ch-ua-model']);
  c.remember('https://b.example', ['sec-ch-ua-arch']);
  c.remember('https://nota.example', ['sec-ch-ua-arch']);
  // "Clear Cookies & Data for This Site" from www.a.example.
  assert.equal(c.forget('www.a.example'), 2);
  assert.deepEqual(c.hintsFor('https://a.example'), [], 'the parent domain goes too (cookies live there)');
  assert.deepEqual(c.hintsFor('https://www.a.example:8443'), []);
  assert.deepEqual(c.hintsFor('https://login.a.example'), ['sec-ch-ua-model'], 'a sibling subdomain is not the site');
  assert.deepEqual(c.hintsFor('https://nota.example'), ['sec-ch-ua-arch'], 'suffix match is on a label boundary');
  assert.equal(c.forget('a.example'), 1, 'from the parent: every subdomain');
  assert.equal(c.forget(''), 0);
  assert.equal(c.size, 2);
  assert.equal(c.clear(), 2);
  assert.equal(c.size, 0);
  assert.deepEqual(c.hintsFor('https://b.example'), []);
});

// ------------------------------------------------------- planClientHints
//
// Chrome's rules for WHICH hints go on WHICH request, pinned without
// Electron. Fixture: https://top.example asked for two hints when visited
// top-level; https://third.example asked for one on its own top-level
// visit and is now a third party to top.example.

const TOP = 'https://top.example';
const THIRD = 'https://third.example';
const TWO = ['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version'];
const DECORATED = { 'Sec-CH-UA': BRANDED, 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"macOS"' };
const BARE = { Accept: '*/*' };
function cacheFixture() {
  const c = new AcceptChCache();
  c.remember(TOP, TWO);
  c.remember(THIRD, ['sec-ch-ua-arch']);
  return c;
}
/** A first-party xhr from the top document, with overrides. @param {object} [over] */
const plan = (over = {}) => planClientHints({
  url: `${TOP}/x`, resourceType: 'xhr', requestHeaders: DECORATED, frameOrigin: TOP, topOrigin: TOP, cache: cacheFixture(), ...over,
});

test('planClientHints: navigations get the low-entropy three; a top-level one gets what its origin asked for', () => {
  assert.deepEqual(plan({ resourceType: 'mainFrame', requestHeaders: BARE, frameOrigin: null, topOrigin: null }), { addLow: true, wanted: TWO });
  assert.deepEqual(plan({ url: 'https://fresh.example/', resourceType: 'mainFrame', requestHeaders: BARE, frameOrigin: null, topOrigin: null }),
    { addLow: true, wanted: [] }, 'first contact: nothing remembered yet (no Critical-CH restart — documented)');
});

test('planClientHints: an iframe navigation gets high-entropy hints only same-origin with the top document (Chrome\'s default `self` policy)', () => {
  assert.deepEqual(plan({ resourceType: 'subFrame', requestHeaders: BARE, frameOrigin: null }), { addLow: true, wanted: TWO });
  // third.example asked — on its own top-level visit — but embedded under
  // top.example it gets the low-entropy three and nothing else.
  assert.deepEqual(plan({ url: `${THIRD}/widget`, resourceType: 'subFrame', requestHeaders: BARE, frameOrigin: null }), { addLow: true, wanted: [] });
  assert.deepEqual(plan({ resourceType: 'subFrame', requestHeaders: BARE, frameOrigin: null, topOrigin: null }), { addLow: true, wanted: [] }, 'unknown top = cross-origin');
});

test('planClientHints: subresources carry high-entropy hints only first-party from a first-party frame, and never synthesized low ones', () => {
  assert.deepEqual(plan(), { addLow: false, wanted: TWO }, 'the top document fetching its own origin');
  assert.deepEqual(plan({ url: `${THIRD}/api` }), { addLow: false, wanted: [] }, 'a third-party fetch to an origin that asked');
  assert.deepEqual(plan({ frameOrigin: THIRD }), { addLow: false, wanted: [] }, 'a cross-origin iframe fetching the top origin');
  assert.deepEqual(plan({ url: `${THIRD}/api`, frameOrigin: THIRD }), { addLow: false, wanted: [] }, 'a cross-origin iframe fetching its own origin');
  assert.deepEqual(plan({ frameOrigin: null, topOrigin: null }), { addLow: false, wanted: [] }, 'frame unknown = cross-origin, the safe side');
  for (const type of ['script', 'image', 'font', 'stylesheet', 'media', 'ping', 'other']) {
    assert.deepEqual(plan({ resourceType: type }), { addLow: false, wanted: TWO }, type);
  }
});

test('planClientHints: requests the renderer left bare (workers) and WebSocket handshakes get nothing — Chrome sends none there', () => {
  assert.deepEqual(plan({ requestHeaders: BARE }), { addLow: false, wanted: [] }, 'a fetch from inside a worker');
  assert.deepEqual(plan({ resourceType: 'script', requestHeaders: BARE }), { addLow: false, wanted: [] }, 'a worker script request');
  assert.deepEqual(plan({ url: 'wss://top.example/ws', resourceType: 'webSocket', requestHeaders: DECORATED }), { addLow: false, wanted: [] });
  assert.deepEqual(plan({ url: 'wss://top.example/ws', resourceType: 'webSocket', requestHeaders: BARE }), { addLow: false, wanted: [] });
});

test('planClientHints: nothing to an untrustworthy destination, whatever the request', () => {
  for (const type of ['mainFrame', 'subFrame', 'xhr']) {
    assert.deepEqual(plan({ url: 'http://top.example/x', resourceType: type, frameOrigin: 'http://top.example', topOrigin: 'http://top.example' }),
      { addLow: false, wanted: [] }, type);
  }
  assert.deepEqual(plan({ url: 'data:text/html,x', resourceType: 'mainFrame' }), { addLow: false, wanted: [] });
});

// ------------------------------------------------- applyClientHintHeaders

test('adds the three low-entropy hints when absent (a navigation-shaped request)', () => {
  const input = { 'User-Agent': 'Mozilla/5.0 x', Accept: 'text/html' };
  const out = applyClientHintHeaders(input, { lowEntropy: LOW, highEntropy: HIGH, wanted: [] });
  assert.deepEqual(out, {
    'User-Agent': 'Mozilla/5.0 x',
    Accept: 'text/html',
    'sec-ch-ua': BRANDED,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  });
  assert.deepEqual(input, { 'User-Agent': 'Mozilla/5.0 x', Accept: 'text/html' }, 'pure: input untouched');
  // No high-entropy hint sneaks in unasked.
  for (const k of Object.keys(out)) assert.ok(!HIGH_ENTROPY_HINTS.has(k.toLowerCase()), k);
});

test('aligns the brand headers the renderer sent, keeping their key casing, and adds nothing twice', () => {
  const out = applyClientHintHeaders(
    { 'Sec-CH-UA': UNBRANDED, 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"macOS"' },
    { lowEntropy: LOW, highEntropy: HIGH, wanted: [] },
  );
  assert.deepEqual(out, { 'Sec-CH-UA': BRANDED, 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"macOS"' });
  assert.ok(!('sec-ch-ua' in out), 'no lowercase duplicate of a present mixed-case key');
});

test('adds only the wanted high-entropy hints, and only known ones', () => {
  const out = applyClientHintHeaders(
    { 'Sec-CH-UA': BRANDED, 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"macOS"' },
    { lowEntropy: LOW, highEntropy: HIGH, wanted: ['sec-ch-ua-full-version-list', 'Sec-CH-UA-Platform-Version', 'sec-ch-viewport-width', 'x-bogus'] },
  );
  assert.equal(out['sec-ch-ua-full-version-list'], HIGH['sec-ch-ua-full-version-list']);
  assert.equal(out['sec-ch-ua-platform-version'], '"14.6.1"');
  for (const k of ['sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-full-version', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors']) {
    assert.ok(!(k in out), `unrequested hint stays out: ${k}`);
  }
  assert.ok(!('sec-ch-viewport-width' in out) && !('x-bogus' in out), 'unknown names ignored');
  assert.equal(Object.keys(out).length, 5);
});

test('recomputes a renderer-sent brand header from the identity — for 151 Chromium\'s order is not "append Chrome"', () => {
  // A renderer without the CDP override (the chrome's own; a request
  // racing the override) emits Chromium's unbranded list: [Chromium,
  // grease] for an odd major. Real Chrome 151 sends [grease, Google
  // Chrome, Chromium]; appending would put Chrome last — a tell the
  // upgrade playbook could not see at 150, where both coincide.
  const h151 = chromeClientHints({ chromeVersion: '151.0.8000.1', platform: 'darwin', arch: 'arm64', osVersion: '15.0.0' });
  const unbranded = '"Chromium";v="151", "Not=A?Brand";v="99"';
  const out = applyClientHintHeaders(
    { 'Sec-CH-UA': unbranded, 'Sec-CH-UA-Full-Version-List': '"Chromium";v="151.0.8000.1", "Not=A?Brand";v="99.0.0.0"', 'Sec-CH-UA-Mobile': '?0' },
    { lowEntropy: h151.lowEntropyHeaders, highEntropy: h151.highEntropyHeaders, wanted: [], addLow: false },
  );
  assert.equal(out['Sec-CH-UA'], '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"');
  assert.equal(out['Sec-CH-UA-Full-Version-List'], '"Not=A?Brand";v="99.0.0.0", "Google Chrome";v="151.0.8000.1", "Chromium";v="151.0.8000.1"');
  assert.notEqual(out['Sec-CH-UA'], alignChromeBrands(unbranded), 'the append fallback would have put Chrome last');
  assert.equal(out['Sec-CH-UA-Mobile'], '?0', 'the other hints are untouched');
  assert.deepEqual(Object.keys(out).sort(), ['Sec-CH-UA', 'Sec-CH-UA-Full-Version-List', 'Sec-CH-UA-Mobile'], 'addLow:false synthesizes nothing');
});

test('addLow:false leaves a bare request bare — a worker script request or a fetch from inside a worker', () => {
  assert.deepEqual(applyClientHintHeaders({ Accept: '*/*' }, { lowEntropy: LOW, highEntropy: HIGH, wanted: [], addLow: false }), { Accept: '*/*' });
});

test('never overwrites a value the renderer sent — but does align a renderer-sent full-version list', () => {
  const sentFull = '"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.224"';
  const out = applyClientHintHeaders(
    {
      'Sec-CH-UA': BRANDED,
      'Sec-CH-UA-Mobile': '?1',
      'Sec-CH-UA-Platform': '"Android"',
      'Sec-CH-UA-Platform-Version': '"99.0.0"',
      'Sec-CH-UA-Full-Version-List': sentFull,
    },
    { lowEntropy: LOW, highEntropy: HIGH, wanted: ['sec-ch-ua-platform-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-arch'] },
  );
  assert.equal(out['Sec-CH-UA-Mobile'], '?1');
  assert.equal(out['Sec-CH-UA-Platform'], '"Android"');
  assert.equal(out['Sec-CH-UA-Platform-Version'], '"99.0.0"');
  assert.equal(out['Sec-CH-UA-Full-Version-List'], `${sentFull}, "Google Chrome";v="150.0.7871.224"`);
  assert.equal(out['sec-ch-ua-arch'], '"x86"', 'the one wanted hint that was absent is added');
  assert.ok(!('sec-ch-ua-platform-version' in out) && !('sec-ch-ua-full-version-list' in out), 'no lowercase duplicates');
});

test('header keys match case-insensitively (SEC-CH-UA, sec-ch-ua, Sec-Ch-Ua all count as present)', () => {
  for (const key of ['SEC-CH-UA', 'sec-ch-ua', 'Sec-Ch-Ua']) {
    const out = applyClientHintHeaders({ [key]: BRANDED }, { lowEntropy: LOW, highEntropy: HIGH, wanted: [] });
    assert.equal(Object.keys(out).filter((k) => k.toLowerCase() === 'sec-ch-ua').length, 1, key);
    assert.equal(out[key], BRANDED);
    assert.equal(out['sec-ch-ua-mobile'], '?0', 'the other two are still added');
  }
});

test('empty lowEntropy/wanted (the UI session) only aligns', () => {
  const out = applyClientHintHeaders({ 'Sec-CH-UA': UNBRANDED, Accept: '*/*' }, { lowEntropy: {}, highEntropy: {}, wanted: [] });
  assert.deepEqual(out, { 'Sec-CH-UA': BRANDED, Accept: '*/*' });
});

// --------------------------------------------------------------- helpers

test('setHeader replaces case-insensitively, adds when absent', () => {
  assert.deepEqual(setHeader({ 'user-agent': 'old', Accept: '*/*' }, 'User-Agent', 'new'), { 'user-agent': 'new', Accept: '*/*' });
  assert.deepEqual(setHeader({ Accept: '*/*' }, 'User-Agent', 'new'), { Accept: '*/*', 'User-Agent': 'new' });
});

test('clientHintsAllowedFor: secure origins and loopback only, like Chrome', () => {
  for (const ok of ['https://example.com/x', 'wss://example.com/', 'http://localhost/', 'http://LOCALHOST:8080/x', 'http://app.localhost/', 'http://127.0.0.1:1234/qa', 'http://127.1.2.3/', 'http://[::1]:9/']) {
    assert.equal(clientHintsAllowedFor(ok), true, ok);
  }
  for (const no of ['http://example.com/', 'http://10.0.0.1/', 'http://localhost.evil.com/', 'ftp://localhost/', 'raha://app/index.html', 'about:blank', 'data:text/html,x', 'not a url', '']) {
    assert.equal(clientHintsAllowedFor(no), false, no);
  }
});

test('hintOrigin: scheme+host+port, null for opaque origins', () => {
  assert.equal(hintOrigin('https://a.example:8443/x?y#z'), 'https://a.example:8443');
  assert.equal(hintOrigin('http://127.0.0.1:5000/security-qa.html'), 'http://127.0.0.1:5000');
  for (const v of ['data:text/html,x', 'about:blank', 'garbage', '']) assert.equal(hintOrigin(v), null, v);
});
