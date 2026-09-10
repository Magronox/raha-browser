// Sec-CH-UA alignment: the header must agree with the Chrome UA string we
// present, or bot checks read the disagreement as automation.
//
// Expected values below are derived BY HAND from Chromium's tables
// (components/embedder_support/user_agent_utils.cc @ 150.0.7871.224):
//   chars    = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"]   (11)
//   versions = ["8", "99", "24"]                                         (3)
//   brand = "Not" + chars[m % 11] + "A" + chars[(m+1) % 11] + "Brand"
//   version = versions[m % 3]
//   2-brand order: slots {m%2, (m+1)%2}; 3-brand: ORDERS_3[m % 6] where
//   ORDERS_3 = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]] and the
//   unshuffled list [grease, Chromium, Google Chrome] is placed as
//   shuffled[order[i]] = list[i].
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignChromeBrands,
  BRAND_HEADERS,
  greaseBrand,
  brandList,
  serializeBrandList,
  chromeClientHints,
  hostArch,
} from '../../src/shared/client-hints.js';

const GREASE = 'Not;A=Brand';
const CHROME_VERSION = '150.0.7871.224';

// ---------------------------------------------------------------- GREASE

test('major 150 → the grease brand real Chrome 150 sends (pinned ground truth)', () => {
  // 150 % 11 = 7 → ";"; 151 % 11 = 8 → "="; 150 % 3 = 0 → "8"
  assert.deepEqual(greaseBrand(150), { brand: GREASE, version: '8' });
  assert.deepEqual(greaseBrand('150'), { brand: GREASE, version: '8' });
});

test('other majors walk the tables', () => {
  // 149 % 11 = 6 → ")"; 150 % 11 = 7 → ";"; 149 % 3 = 2 → "24"
  assert.deepEqual(greaseBrand(149), { brand: 'Not)A;Brand', version: '24' });
  // 151 % 11 = 8 → "="; 152 % 11 = 9 → "?"; 151 % 3 = 1 → "99"
  assert.deepEqual(greaseBrand(151), { brand: 'Not=A?Brand', version: '99' });
  // 152 % 11 = 9 → "?"; 153 % 11 = 10 → "_"; 152 % 3 = 2 → "24"
  assert.deepEqual(greaseBrand(152), { brand: 'Not?A_Brand', version: '24' });
  // Wrap-around: 131 % 11 = 10 → "_"; 132 % 11 = 0 → " "; 131 % 3 = 2 → "24"
  // — the widely observed Chrome 131 header carried "Not_A Brand";v="24".
  assert.deepEqual(greaseBrand(131), { brand: 'Not_A Brand', version: '24' });
});

test('rejects non-integer seeds instead of producing a made-up brand', () => {
  for (const bad of [-1, 1.5, NaN, 'abc', '', undefined]) {
    assert.throws(() => greaseBrand(/** @type {any} */ (bad)), TypeError);
  }
});

// ------------------------------------------------------------ brand lists

test('2-brand list for 150: [grease, Chromium] (pinned ground truth)', () => {
  // 150 % 2 = 0 → slots {0, 1}: grease lands at 0, Chromium at 1.
  assert.deepEqual(brandList({ major: 150 }), [
    { brand: GREASE, version: '8' },
    { brand: 'Chromium', version: '150' },
  ]);
  // Odd major flips it: 149 % 2 = 1 → slots {1, 0}.
  assert.deepEqual(brandList({ major: 149 }).map((b) => b.brand), ['Chromium', 'Not)A;Brand']);
});

test('3-brand list for 150 carries Google Chrome in Chromium\'s permuted order', () => {
  // 150 % 6 = 0 → order [0,1,2] → [grease, Chromium, Google Chrome]
  const low = brandList({ major: 150, chrome: true });
  assert.deepEqual(low, [
    { brand: GREASE, version: '8' },
    { brand: 'Chromium', version: '150' },
    { brand: 'Google Chrome', version: '150' },
  ]);
  // Full-version list: same brands and order, full versions, grease ".0.0.0".
  const full = brandList({ major: 150, fullVersion: CHROME_VERSION, chrome: true, full: true });
  assert.deepEqual(full, [
    { brand: GREASE, version: '8.0.0.0' },
    { brand: 'Chromium', version: CHROME_VERSION },
    { brand: 'Google Chrome', version: CHROME_VERSION },
  ]);
  // major may be derived from fullVersion.
  assert.deepEqual(brandList({ fullVersion: CHROME_VERSION, chrome: true, full: true }), full);
  assert.throws(() => brandList({ major: 150, chrome: true, full: true }), TypeError);
});

test('3-brand order follows ORDERS_3[major % 6] with inverse placement', () => {
  /** @param {number} m */
  const order = (m) => brandList({ major: m, chrome: true }).map((b) => b.brand);
  // 149 % 6 = 5 → [2,1,0]: grease→2, Chromium→1, Chrome→0
  assert.deepEqual(order(149), ['Google Chrome', 'Chromium', 'Not)A;Brand']);
  // 151 % 6 = 1 → [0,2,1]: grease→0, Chromium→2, Chrome→1
  assert.deepEqual(order(151), ['Not=A?Brand', 'Google Chrome', 'Chromium']);
  // 152 % 6 = 2 → [1,0,2]: grease→1, Chromium→0, Chrome→2
  assert.deepEqual(order(152), ['Chromium', 'Not?A_Brand', 'Google Chrome']);
  // 131 % 6 = 5 → [2,1,0] — matches the real-world Chrome 131 header
  // "Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24".
  assert.deepEqual(order(131), ['Google Chrome', 'Chromium', 'Not_A Brand']);
  // 120 % 6 = 0 — the real-world Chrome 120 header started with the grease.
  assert.deepEqual(order(120), ['Not_A Brand', 'Chromium', 'Google Chrome']);
});

// ---------------------------------------------------------- serialization

test('serializes in Sec-CH-UA syntax and round-trips through alignChromeBrands', () => {
  const low = serializeBrandList(brandList({ major: 150, chrome: true }));
  assert.equal(low, '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"');
  const full = serializeBrandList(brandList({ fullVersion: CHROME_VERSION, chrome: true, full: true }));
  assert.equal(full, '"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.224", "Google Chrome";v="150.0.7871.224"');
  // Already branded → the header hook must leave it alone.
  assert.equal(alignChromeBrands(low), low);
  assert.equal(alignChromeBrands(full), full);
  // And the unbranded form, once aligned, equals the recomputed one for
  // this major (order 150 % 6 = 0 keeps Chrome last, so append == permute).
  assert.equal(alignChromeBrands(serializeBrandList(brandList({ major: 150 }))), low);
});

test('serialization escapes like RFC 8941 and omits v= for an empty version', () => {
  assert.equal(serializeBrandList([{ brand: 'A"B\\C', version: '1' }]), '"A\\"B\\\\C";v="1"');
  assert.equal(serializeBrandList([{ brand: 'Bare' }]), '"Bare"');
  assert.equal(serializeBrandList([]), '');
});

// -------------------------------------------------------- chromeClientHints

test('darwin/x64 → what Chrome on an Intel Mac reports', () => {
  const h = chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'darwin', arch: 'x64', osVersion: '14.6.1' });
  assert.deepEqual(h.userAgentMetadata, {
    brands: brandList({ major: 150, chrome: true }),
    fullVersionList: brandList({ fullVersion: CHROME_VERSION, chrome: true, full: true }),
    fullVersion: CHROME_VERSION,
    platform: 'macOS',
    platformVersion: '14.6.1',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  });
  assert.deepEqual(h.lowEntropyHeaders, {
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  });
  // Every high-entropy UA hint real Chrome 150 sends when asked (measured
  // against a Cloudflare-shaped Accept-CH): Full-Version is deprecated but
  // still sent, WoW64 is a structured-header boolean, Form-Factors a list.
  assert.deepEqual(h.highEntropyHeaders, {
    'sec-ch-ua-full-version-list': '"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.224", "Google Chrome";v="150.0.7871.224"',
    'sec-ch-ua-full-version': '"150.0.7871.224"',
    'sec-ch-ua-platform-version': '"14.6.1"',
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-wow64': '?0',
    'sec-ch-ua-form-factors': '"Desktop"',
  });
  // Every header name is lowercase and the brand ones are the hook's set.
  for (const k of Object.keys({ ...h.lowEntropyHeaders, ...h.highEntropyHeaders })) {
    assert.equal(k, k.toLowerCase());
  }
  assert.ok(BRAND_HEADERS.has('sec-ch-ua') && BRAND_HEADERS.has('sec-ch-ua-full-version-list'));
});

test('hostArch: ARM64 translation (Rosetta 2 / Windows-on-ARM) wins over process.arch — Chrome says "arm" there', () => {
  // user_agent_utils.cc GetCpuArchitecture: kTranslatedIntel (Mac) and
  // IsWowAMD64OnARM64 (Windows) both report "arm"; process.arch of an x64
  // build under translation still says x64, so the flag has to win.
  assert.equal(hostArch('x64', false), 'x64');
  assert.equal(hostArch('x64', true), 'arm64');
  assert.equal(hostArch('arm64', false), 'arm64');
  assert.equal(hostArch('ia32', true), 'arm64');
  const translated = chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'darwin', arch: hostArch('x64', true), osVersion: '15.1' });
  assert.equal(translated.userAgentMetadata.architecture, 'arm');
  assert.equal(translated.highEntropyHeaders['sec-ch-ua-arch'], '"arm"');
});

test('darwin/arm64 → architecture "arm" (Chrome on Apple Silicon), still 64-bit', () => {
  const h = chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'darwin', arch: 'arm64', osVersion: '15.1' });
  assert.equal(h.userAgentMetadata.architecture, 'arm');
  assert.equal(h.userAgentMetadata.bitness, '64');
  assert.equal(h.highEntropyHeaders['sec-ch-ua-arch'], '"arm"');
  // "%d.%d.%d" — a two-component OS version is padded like Chromium prints it.
  assert.equal(h.userAgentMetadata.platformVersion, '15.1.0');
  assert.equal(h.highEntropyHeaders['sec-ch-ua-platform-version'], '"15.1.0"');
});

test('win32 → "Windows" and the UniversalApiContract platformVersion, not the build', () => {
  /** @param {string} osVersion @param {string} [arch] */
  const pv = (osVersion, arch = 'x64') =>
    chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'win32', arch, osVersion }).userAgentMetadata.platformVersion;
  const h = chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'win32', arch: 'x64', osVersion: '10.0.19045' });
  assert.equal(h.userAgentMetadata.platform, 'Windows');
  assert.equal(h.lowEntropyHeaders['sec-ch-ua-platform'], '"Windows"');
  assert.equal(pv('10.0.19045'), '10.0.0'); // Windows 10 22H2
  assert.equal(pv('10.0.19041'), '10.0.0'); // Windows 10 2004
  assert.equal(pv('10.0.18363'), '8.0.0'); // Windows 10 1909
  assert.equal(pv('10.0.17763'), '7.0.0'); // Windows 10 1809
  assert.equal(pv('10.0.10240'), '1.0.0'); // Windows 10 1507
  assert.equal(pv('10.0.22000'), '13.0.0'); // Windows 11 21H2
  assert.equal(pv('10.0.22631'), '15.0.0'); // Windows 11 23H2
  assert.equal(pv('10.0.26100'), '19.0.0'); // Windows 11 24H2
  assert.equal(pv('10.0.99999'), '19.0.0'); // unknown future build → Chromium's fallback
  assert.equal(pv('bogus'), '19.0.0');
  assert.equal(pv('6.3.9600'), '0.0.0'); // Windows 8.1 → "0" per Microsoft's table
  // ia32 build: x86 but 32-bit; arm64 Windows: arm.
  const w32 = chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'win32', arch: 'ia32', osVersion: '10.0.19045' });
  assert.equal(w32.userAgentMetadata.architecture, 'x86');
  assert.equal(w32.userAgentMetadata.bitness, '32');
  assert.equal(chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'win32', arch: 'arm64', osVersion: '10.0.26100' }).userAgentMetadata.architecture, 'arm');
});

test('linux → "Linux" and an empty platformVersion, as Chromium reports', () => {
  const h = chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'linux', arch: 'x64', osVersion: '6.8.0-45-generic' });
  assert.equal(h.userAgentMetadata.platform, 'Linux');
  assert.equal(h.userAgentMetadata.platformVersion, '');
  assert.equal(h.highEntropyHeaders['sec-ch-ua-platform-version'], '""');
  assert.equal(h.userAgentMetadata.architecture, 'x86');
  assert.equal(h.userAgentMetadata.bitness, '64');
  // Anything Raha does not ship for follows standardUserAgent's Linux fallback.
  assert.equal(chromeClientHints({ chromeVersion: CHROME_VERSION, platform: 'freebsd', arch: 'x64' }).userAgentMetadata.platform, 'Linux');
});

test('chromeClientHints uses the grease of the given major, not a fixed one', () => {
  const h = chromeClientHints({ chromeVersion: '151.0.8000.1', platform: 'darwin', arch: 'arm64', osVersion: '15.0.0' });
  assert.equal(h.lowEntropyHeaders['sec-ch-ua'], '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"');
  assert.equal(h.highEntropyHeaders['sec-ch-ua-full-version-list'], '"Not=A?Brand";v="99.0.0.0", "Google Chrome";v="151.0.8000.1", "Chromium";v="151.0.8000.1"');
});

// --------------------------------------------- header-hook fallback (kept)

test('adds the Google Chrome brand, preserving grease and version format', () => {
  assert.equal(
    alignChromeBrands('"Not;A=Brand";v="8", "Chromium";v="150"'),
    '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  );
  // Full-version-list: the same code must carry the long version across.
  assert.equal(
    alignChromeBrands('"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.224"'),
    '"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.224", "Google Chrome";v="150.0.7871.224"',
  );
});

test('never double-brands an already-branded header', () => {
  const already = '"Chromium";v="150", "Google Chrome";v="150", "Not;A=Brand";v="8"';
  assert.equal(alignChromeBrands(already), already);
});

test('leaves anything it cannot understand untouched', () => {
  for (const v of ['', 'garbage', '"OnlyGrease";v="8"', '?1']) {
    assert.equal(alignChromeBrands(v), v, `must not mangle ${JSON.stringify(v)}`);
  }
  assert.equal(alignChromeBrands(/** @type {any} */ (undefined)), undefined);
  assert.equal(alignChromeBrands(/** @type {any} */ (null)), null);
});

test('tolerates whitespace variants Chromium may emit', () => {
  assert.equal(
    alignChromeBrands('"Chromium" ; v = "150"'),
    '"Chromium" ; v = "150", "Google Chrome";v="150"',
  );
});

test('BRAND_HEADERS covers both hint headers, lowercased for comparison', () => {
  assert.ok(BRAND_HEADERS.has('sec-ch-ua'));
  assert.ok(BRAND_HEADERS.has('sec-ch-ua-full-version-list'));
  assert.ok(!BRAND_HEADERS.has('sec-ch-ua-platform'), 'platform hint is already honest');
});
