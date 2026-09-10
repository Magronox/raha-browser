// User-Agent Client Hints: make everything Raha says about itself agree
// with the standard Chrome User-Agent string it presents (privacy.js,
// standardUserAgent).
//
// Bot checks (Cloudflare Turnstile and friends) cross-check three views of
// the browser against each other: the UA string, the Sec-CH-UA request
// headers, and the in-page navigator.userAgentData object. Electron gets
// all three wrong for a browser claiming to be Chrome, in three different
// ways (measured on Electron 43.4.0 / Chromium 150, 2026-08-26):
//   - Chromium computes the brand list from its own product name, so an
//     unbranded build reports "Not;A=Brand";v="8", "Chromium";v="150" —
//     no "Google Chrome" — in headers and in JS alike;
//   - Electron has no browser-side client-hints delegate: navigation
//     requests carry NO sec-ch-ua headers at all, and HTTP Accept-CH /
//     Critical-CH response headers are ignored, whereas real Chrome sends
//     the three low-entropy hints on every navigation and frame-initiated
//     request to a potentially-trustworthy destination (never on WebSocket
//     handshakes or worker requests — measured side by side with Chrome
//     150) and the high-entropy ones to origins that asked;
//   - cross-origin iframes run out of process and ignore the session UA
//     override entirely: inside them navigator.userAgent is the raw
//     "... Chrome/150.0.7871.224 Electron/43.4.0 ..." and that string goes
//     on the wire — exactly where a Turnstile widget lives.
//
// This module is the pure half of the fix; the platform layer applies it
// at three layers (docs/DECISIONS/ADR-0012-chrome-identity-via-cdp.md):
//   1. CDP identity (src/main/electron/chrome-identity.js): one DevTools-
//      protocol session per tab sends Emulation.setUserAgentOverride with
//      the userAgentMetadata computed here to the main frame and, via
//      Target.setAutoAttach, to every out-of-process iframe. Covers the JS
//      view, renderer-initiated subresource requests and dedicated workers
//      (which inherit it — measured in this configuration). No preload in
//      web content (docs/INVARIANTS.md #5 holds; the session lives in main).
//   2. Header synthesis (privacy.js onBeforeSendHeaders, via
//      planClientHints + applyClientHintHeaders): forces the Chrome UA on
//      every request, recomputes any brand header the renderer sent, and
//      adds the low-entropy hints to navigations — the one request kind
//      Electron leaves bare and Chrome decorates.
//   3. Accept-CH emulation (parseAcceptCh + AcceptChCache + planClientHints):
//      remembers which high-entropy hints a top-level origin asked for and
//      adds exactly those where Chrome's default `self` permissions policy
//      would deliver them — that origin's own navigations, and same-origin
//      subresources of its same-origin frames.
// Known divergences from Chrome, stated honestly (ADR-0012 "Known
// divergences" has each with its measurement): window.chrome is an empty
// object in Electron (real Chrome's has keys); an undecided permission
// reads "denied" to a check (Notification.permission) where Chrome says
// "prompt" — Electron's check hook has no third answer (R-103, ADR-0013);
// synthesized navigation hints land after Accept-Language where
// Chrome puts them first; there is no Critical-CH restart, so first contact
// with an origin lacks the high-entropy hints Chrome retries with; and the
// Chromium patch level Electron bundles need not be one Google ever shipped
// as a Chrome stable.
//
// Everything here is a pure re-implementation of Chromium's
// components/embedder_support/user_agent_utils.cc (verified against tag
// 150.0.7871.224). The grease brand is NOT random: it is seeded by the
// major version, so producing the same value as real Chrome is part of
// looking real. (ROADMAP R-114.)

/** Brand real Chrome adds and unbranded Chromium does not. */
const CHROME_BRAND = 'Google Chrome';

// --- GREASE tables (user_agent_utils.cc, GetGreasedUserAgentBrandVersion) ---
// greasey_chars = {" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"}
// greased_versions = {"8", "99", "24"}
// brand   = "Not" + chars[seed % 11] + "A" + chars[(seed + 1) % 11] + "Brand"
// version = versions[seed % 3]; full form = version + ".0.0.0"
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];

// --- permutation table (user_agent_utils.cc, GetRandomOrder) ---
// size 2: {seed % 2, (seed + 1) % 2}
// size 3: orders[seed % 6] from the table below.
// ShuffleBrandList applies it as `shuffled[order[i]] = list[i]`, i.e. the
// table says where each unshuffled entry LANDS, not which entry comes next.
// (Chromium also has a 24-row table for 4 brands — only reached with an
// additional_brand_version, which Raha never supplies.)
const ORDERS_3 = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/**
 * @param {number | string} major Chromium major version (the GREASE seed)
 * @returns {number}
 */
function toSeed(major) {
  // Number('') is 0 — an empty string must not quietly become seed 0.
  const n = typeof major === 'string' ? (/^\d+$/.test(major.trim()) ? Number(major.trim()) : NaN) : major;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`Chromium major version must be a non-negative integer, got ${String(major)}`);
  }
  return n;
}

/**
 * Chromium's GREASE brand for a given major version (the low-entropy,
 * major-only form; the full-version list uses `${version}.0.0.0`).
 * e.g. 150 -> { brand: 'Not;A=Brand', version: '8' }.
 * @param {number | string} major
 * @returns {{ brand: string, version: string }}
 */
export function greaseBrand(major) {
  const seed = toSeed(major);
  const brand = `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`;
  return { brand, version: GREASE_VERSIONS[seed % GREASE_VERSIONS.length] };
}

/**
 * Chromium's ShuffleBrandList: a stable, version-seeded permutation.
 * @template T
 * @param {T[]} list unshuffled: [grease, Chromium, brand?]
 * @param {number} seed
 * @returns {T[]}
 */
function shuffleBrandList(list, seed) {
  const order = list.length === 2 ? [seed % 2, (seed + 1) % 2] : ORDERS_3[seed % ORDERS_3.length];
  /** @type {T[]} */
  const out = new Array(list.length);
  order.forEach((slot, i) => { out[slot] = list[i]; });
  return out;
}

/**
 * The brand list Chromium builds (GenerateBrandVersionList): grease +
 * "Chromium" for an unbranded build, plus "Google Chrome" for real Chrome,
 * in the permuted order for that major version.
 *
 * @param {object} opts
 * @param {number | string} [opts.major] Chromium major; derived from
 *   `fullVersion` when omitted
 * @param {string} [opts.fullVersion] e.g. '150.0.7871.224' (required with `full`)
 * @param {boolean} [opts.chrome=false] include the "Google Chrome" brand
 * @param {boolean} [opts.full=false] full-version list (Sec-CH-UA-Full-Version-List)
 *   instead of the major-only list (Sec-CH-UA)
 * @returns {{ brand: string, version: string }[]}
 */
export function brandList({ major, fullVersion, chrome = false, full = false }) {
  if (full && (typeof fullVersion !== 'string' || fullVersion === '')) {
    throw new TypeError('brandList: full-version list needs fullVersion');
  }
  const seed = toSeed(major ?? String(fullVersion).split('.')[0]);
  const grease = greaseBrand(seed);
  const version = full ? /** @type {string} */ (fullVersion) : String(seed);
  const list = [
    { brand: grease.brand, version: full ? `${grease.version}.0.0.0` : grease.version },
    { brand: 'Chromium', version },
  ];
  if (chrome) list.push({ brand: CHROME_BRAND, version });
  return shuffleBrandList(list, seed);
}

/**
 * RFC 8941 String serialization, as net::structured_headers does it.
 * @param {string} s
 */
function sfString(s) {
  return `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * Serialize a brand list exactly as blink::UserAgentMetadata does
 * (SerializeBrandVersionList → structured-headers List):
 *   "Brand";v="ver", "Brand2";v="ver2"
 * @param {{ brand: string, version?: string }[]} list
 * @returns {string}
 */
export function serializeBrandList(list) {
  return list
    .map(({ brand, version }) => (version ? `${sfString(brand)};v=${sfString(version)}` : sfString(brand)))
    .join(', ');
}

// --- Windows Sec-CH-UA-Platform-Version ---
// Chrome reports the Windows.Foundation.UniversalApiContract version
// (user_agent_utils.cc, GetUniversalApiContractVersion: a registry read,
// "<major>.<minor>.0"), NOT the OS build. Node only has the build, so map
// it. Windows 10 rows: Microsoft's table (learn.microsoft.com,
// "how-to-detect-win11") + Chromium's pre-RS5 table in the same source
// file. Windows 11 rows (13/14/15/19) are the known contract versions of
// those builds — the doc only says "13+"; verify on a real machine if it
// ever matters. Unknown/newer builds fall back to Chromium's own fallback,
// kHighestKnownUniversalApiContractVersion = 19 at this tag.
/** @type {[minBuild: number, contractMajor: number][]} */
const WINDOWS_CONTRACT_BY_BUILD = [
  [26100, 19], // Windows 11 24H2 / 25H2
  [22631, 15], // Windows 11 23H2
  [22621, 14], // Windows 11 22H2
  [22000, 13], // Windows 11 21H2
  [19041, 10], // Windows 10 2004, 20H2, 21H1, 21H2, 22H2
  [18362, 8], // Windows 10 1903, 1909
  [17763, 7], // Windows 10 1809
  [17134, 6], // Windows 10 1803
  [16299, 5], // Windows 10 1709
  [15063, 4], // Windows 10 1703
  [14393, 3], // Windows 10 1607
  [10586, 2], // Windows 10 1511
  [10240, 1], // Windows 10 1507
];
const HIGHEST_KNOWN_CONTRACT = 19;

/**
 * What Chrome reports as platformVersion on this OS.
 * @param {string} platform process.platform
 * @param {string | undefined} osVersion e.g. '14.6.1' (macOS), '10.0.22631' (Windows)
 * @returns {string}
 */
function platformVersionFor(platform, osVersion) {
  const parts = String(osVersion ?? '').split('.').map((p) => parseInt(p, 10));
  if (platform === 'win32') {
    const build = parts[2];
    if (!Number.isInteger(build)) return `${HIGHEST_KNOWN_CONTRACT}.0.0`;
    const row = WINDOWS_CONTRACT_BY_BUILD.find(([min]) => build >= min);
    return `${row ? row[1] : 0}.0.0`;
  }
  if (platform === 'darwin') {
    // base::SysInfo::OperatingSystemVersionNumbers → "%d.%d.%d"
    const [major = 0, minor = 0, bugfix = 0] = parts.map((p) => (Number.isInteger(p) ? p : 0));
    return `${major}.${minor}.${bugfix}`;
  }
  return ''; // Linux: GetPlatformVersion() returns the empty string
}

/**
 * Everything Chrome of version `chromeVersion` would report through
 * User-Agent Client Hints on this machine: the CDP
 * Emulation.setUserAgentOverride `userAgentMetadata` object and the
 * ready-to-send request headers (structured-header quoted).
 *
 * @param {object} opts
 * @param {string} opts.chromeVersion e.g. process.versions.chrome, '150.0.7871.224'
 * @param {string} opts.platform process.platform
 * @param {string} opts.arch process.arch, or hostArch() when the build may
 *   be running under ARM64 translation
 * @param {string} [opts.osVersion] e.g. process.getSystemVersion()
 * @returns {{
 *   userAgentMetadata: {
 *     brands: { brand: string, version: string }[],
 *     fullVersionList: { brand: string, version: string }[],
 *     fullVersion: string,
 *     platform: string, platformVersion: string, architecture: string,
 *     model: string, mobile: boolean, bitness: string, wow64: boolean,
 *   },
 *   lowEntropyHeaders: Record<string, string>,
 *   highEntropyHeaders: Record<string, string>,
 * }}
 */
export function chromeClientHints({ chromeVersion, platform, arch, osVersion }) {
  const major = String(chromeVersion).split('.')[0];
  const brands = brandList({ major, chrome: true });
  const fullVersionList = brandList({ major, fullVersion: chromeVersion, chrome: true, full: true });
  // GetPlatformForUAMetadata; anything else follows standardUserAgent's
  // Linux fallback so the hint agrees with the UA string.
  const platformName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  // GetCpuArchitecture: Chrome says "arm" on Apple Silicon and "x86" for
  // both x64 and ia32; unknown → "".
  const architecture = /^(x64|ia32)$/.test(arch) ? 'x86' : /^arm/.test(arch) ? 'arm' : '';
  // GetCpuBitness: Apple always "64"; elsewhere by the CPU name.
  const bitness = platform === 'darwin' || /64/.test(arch) ? '64' : '32';
  const platformVersion = platformVersionFor(platform, osVersion);

  const userAgentMetadata = {
    brands,
    fullVersionList,
    fullVersion: String(chromeVersion),
    platform: platformName,
    platformVersion,
    architecture,
    model: '',
    mobile: false,
    bitness,
    wow64: false,
  };
  return {
    userAgentMetadata,
    lowEntropyHeaders: {
      'sec-ch-ua': serializeBrandList(brands),
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': sfString(platformName),
    },
    // Every high-entropy hint Chrome 150 sends when asked (measured with a
    // Cloudflare-shaped Accept-CH): the deprecated Sec-CH-UA-Full-Version
    // is still honored, WoW64 is a structured-header boolean, and
    // Form-Factors is a list — "Desktop" for anything Raha ships on
    // (GetFormFactorsClientHint: mobile → "Mobile", plus "XR" only there).
    highEntropyHeaders: {
      'sec-ch-ua-full-version-list': serializeBrandList(fullVersionList),
      'sec-ch-ua-full-version': sfString(String(chromeVersion)),
      'sec-ch-ua-platform-version': sfString(platformVersion),
      'sec-ch-ua-arch': sfString(architecture),
      'sec-ch-ua-bitness': sfString(bitness),
      'sec-ch-ua-model': '""',
      'sec-ch-ua-wow64': '?0',
      'sec-ch-ua-form-factors': sfString('Desktop'),
    },
  };
}

/**
 * The CPU architecture to feed chromeClientHints: an x64 build running
 * under Rosetta 2 or Windows ARM64 emulation is reported by Chrome as "arm"
 * (user_agent_utils.cc GetCpuArchitecture: kTranslatedIntel on Mac,
 * IsWowAMD64OnARM64 on Windows), and process.arch alone cannot tell —
 * Electron's app.runningUnderARM64Translation can.
 * @param {string} processArch process.arch
 * @param {boolean} arm64Translation app.runningUnderARM64Translation
 * @returns {string}
 */
export function hostArch(processArch, arm64Translation) {
  return arm64Translation ? 'arm64' : String(processArch);
}

/**
 * Parse a Sec-CH-UA-style header into entries. Tolerant by design: an
 * unparseable header is left alone by the caller rather than mangled.
 * @param {string} value
 * @returns {{ brand: string, version: string }[]}
 */
function parseBrandList(value) {
  /** @type {{ brand: string, version: string }[]} */
  const out = [];
  for (const [, brand, version] of String(value).matchAll(/"([^"]*)"\s*;\s*v\s*=\s*"([^"]*)"/g)) {
    out.push({ brand, version });
  }
  return out;
}

/**
 * Add the "Google Chrome" brand to a Sec-CH-UA / Sec-CH-UA-Full-Version-List
 * header so client hints agree with the Chrome UA string we present.
 * This is the header-hook fallback: it patches whatever Chromium emitted
 * rather than recomputing it (chromeClientHints does that).
 *
 * The version is copied verbatim from the existing "Chromium" entry, which
 * makes this work unchanged for both the low-entropy header (major only,
 * "150") and the full version list ("150.0.7871.224").
 *
 * @param {string} value the header Chromium produced
 * @returns {string} the aligned header, or `value` untouched when there is
 *   nothing to do (no Chromium entry, already branded, unparseable)
 */
export function alignChromeBrands(value) {
  if (typeof value !== 'string' || value === '') return value;
  const entries = parseBrandList(value);
  if (entries.length === 0) return value;
  if (entries.some((e) => e.brand === CHROME_BRAND)) return value;
  const chromium = entries.find((e) => e.brand === 'Chromium');
  if (!chromium) return value;
  return `${value}, "${CHROME_BRAND}";v="${chromium.version}"`;
}

/** Headers whose brand list must be aligned (lowercased for comparison). */
export const BRAND_HEADERS = new Set(['sec-ch-ua', 'sec-ch-ua-full-version-list']);

// ------------------------------------------------------------ header hook
//
// Pure helpers behind privacy.js's onBeforeSendHeaders / onHeadersReceived
// (layers 2 and 3 above). Electron hands the hook mixed-case keys
// ('User-Agent', 'Sec-CH-UA'), so every lookup here is case-insensitive.

/**
 * Set a header, replacing an existing one whose name differs only in
 * case — adding a second spelling would put both on the wire.
 * @param {Record<string, string>} headers mutated and returned
 * @param {string} name
 * @param {string} value
 * @returns {Record<string, string>}
 */
export function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      headers[key] = value;
      return headers;
    }
  }
  headers[name] = value;
  return headers;
}

/**
 * Chrome sends client hints only to potentially trustworthy destinations:
 * https/wss, or http/ws to loopback (localhost, *.localhost, 127/8, ::1).
 * Synthesizing them for plain http to a remote host would itself be a
 * deviation from Chrome, so the hook asks this first.
 * @param {string} url
 * @returns {boolean}
 */
export function clientHintsAllowedFor(url) {
  /** @type {URL} */
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return false;
  const h = u.hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '[::1]';
}

/**
 * The origin a request's Accept-CH state is keyed by; null for opaque
 * origins (data:, about:, garbage), which never get hints.
 * @param {string} url
 * @returns {string|null}
 */
export function hintOrigin(url) {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * High-entropy UA hint headers Raha can synthesize (lowercase) — exactly
 * the keys of chromeClientHints().highEntropyHeaders (a unit test pins
 * that), which is every UA-CH high-entropy hint Chrome 150 sends when
 * asked. Non-UA hints (Viewport-Width, DPR, ...) are not emulated.
 */
export const HIGH_ENTROPY_HINTS = new Set([
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-full-version',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-wow64',
  'sec-ch-ua-form-factors',
]);

/**
 * Parse an Accept-CH / Critical-CH header value into the supported
 * high-entropy header names it asks for, lowercased, in order, de-duped.
 * Tolerant by design: unknown tokens (Chrome's legacy UA-* names,
 * Viewport-Width, the low-entropy hints — Chrome sends those regardless),
 * empty items and odd spacing are dropped, never thrown on.
 * @param {string | string[] | null | undefined} value
 * @returns {string[]}
 */
export function parseAcceptCh(value) {
  const text = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  /** @type {string[]} */
  const out = [];
  for (const raw of text.split(',')) {
    const name = raw.trim().toLowerCase();
    if (HIGH_ENTROPY_HINTS.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Which supported high-entropy hints a response asks for: Accept-CH ∪
 * Critical-CH, any key casing, multi-valued keys joined.
 * @param {Record<string, string | string[]> | null | undefined} responseHeaders
 * @returns {string[]}
 */
export function acceptChFromResponse(responseHeaders) {
  /** @type {string[]} */
  const names = [];
  for (const [key, value] of Object.entries(responseHeaders ?? {})) {
    const k = key.toLowerCase();
    if (k !== 'accept-ch' && k !== 'critical-ch') continue;
    for (const n of parseAcceptCh(value)) {
      if (!names.includes(n)) names.push(n);
    }
  }
  return names;
}

/**
 * Chrome's Accept-CH cache in miniature: per origin, which high-entropy
 * hints it asked for, so later requests to it carry exactly those. In
 * memory and bounded (LRU by origin). Differences from Chrome, stated
 * plainly: Chrome persists this state with the profile — Raha's is gone on
 * quit (persisting it would add one more per-site file to clear and to
 * leak from disk, for no measured gain); Chrome REPLACES an origin's set
 * on each Accept-CH — this unions, so an origin narrowing its list later
 * still receives the old hints, which nothing scores; and Raha does no
 * Critical-CH restart (privacy.js). Like Chrome's, it is cleared with the
 * site's data: site-data.js calls forget()/clear() on both clearing paths.
 */
export class AcceptChCache {
  /** @param {number} [max=500] origins kept before the least recently used is dropped */
  constructor(max = 500) {
    this.max = Math.max(1, max);
    /** @type {Map<string, Set<string>>} insertion order == recency */
    this.map = new Map();
  }

  get size() { return this.map.size; }

  /**
   * @param {string | null | undefined} origin from hintOrigin()
   * @param {string[]} names from parseAcceptCh()/acceptChFromResponse()
   */
  remember(origin, names) {
    if (!origin || !Array.isArray(names) || names.length === 0) return;
    const merged = new Set(this.map.get(origin) ?? []);
    for (const n of names) merged.add(n);
    this.map.delete(origin); // re-insert last = most recently used
    this.map.set(origin, merged);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /**
   * @param {string | null | undefined} origin
   * @returns {string[]} a copy; empty when the origin never asked
   */
  hintsFor(origin) {
    if (!origin) return [];
    const set = this.map.get(origin);
    if (!set) return [];
    this.map.delete(origin); // touch
    this.map.set(origin, set);
    return [...set];
  }

  /**
   * Drop every origin on `host`, a subdomain of it, or a parent domain of
   * it — the same reach as site-data.js clearSiteData's cookie sweep, so
   * "Clear Cookies & Data for This Site" leaves no Accept-CH memory behind
   * and the next visit is first contact again, as it would be in Chrome.
   * @param {string} host bare lowercase hostname
   * @returns {number} origins forgotten
   */
  forget(host) {
    const h = String(host || '').toLowerCase();
    if (!h) return 0;
    let n = 0;
    for (const origin of [...this.map.keys()]) {
      let o = '';
      try { o = new URL(origin).hostname.toLowerCase(); } catch { /* not an origin: dropped below */ }
      if (o === '' || o === h || o.endsWith(`.${h}`) || h.endsWith(`.${o}`)) {
        this.map.delete(origin);
        n += 1;
      }
    }
    return n;
  }

  /** Forget every origin (the "clear all site data" path). @returns {number} */
  clear() {
    const n = this.map.size;
    this.map.clear();
    return n;
  }
}

/**
 * Which hints the header hook should add to one request — Chrome's rules,
 * pure so they can be pinned without Electron:
 *  - hints only to potentially-trustworthy destinations;
 *  - the low-entropy three are synthesized on navigations only
 *    (mainFrame/subFrame): the renderer decorates frame-initiated
 *    subresources itself (recomputed by applyClientHintHeaders), and Chrome
 *    sends none on WebSocket handshakes or worker requests — measured — so
 *    neither does this;
 *  - high-entropy hints are what the TOP-LEVEL origin asked for (the
 *    Accept-CH cache), sent only where Chrome's default `self` permissions
 *    policy for every ch-ua-* feature lets them through: the top-level
 *    navigation itself, an iframe navigation to that same origin, and a
 *    same-origin subresource issued by a frame of that same origin — never
 *    to a cross-origin frame, never on a third-party fetch, and never on a
 *    request the renderer left bare (workers, WebSockets).
 * `frameOrigin`/`topOrigin` describe the requesting frame and its top-level
 * document (null = unknown, treated as cross-origin: the safe side for a
 * per-machine fingerprint). Chrome's inherited policy is approximated by
 * origin equality with the top document; a same-origin frame nested in a
 * cross-origin one is the (rare) case where Chrome would withhold and this
 * would not.
 *
 * @param {{
 *   url: string,
 *   resourceType: string,
 *   requestHeaders: Record<string, string>,
 *   frameOrigin: string | null,
 *   topOrigin: string | null,
 *   cache: AcceptChCache,
 * }} req
 * @returns {{ addLow: boolean, wanted: string[] }}
 */
export function planClientHints({ url, resourceType, requestHeaders, frameOrigin, topOrigin, cache }) {
  /** @type {{ addLow: boolean, wanted: string[] }} */
  const none = { addLow: false, wanted: [] };
  if (resourceType === 'webSocket' || !clientHintsAllowedFor(url)) return none;
  const origin = hintOrigin(url);
  if (!origin) return none;
  if (resourceType === 'mainFrame') return { addLow: true, wanted: cache.hintsFor(origin) };
  if (resourceType === 'subFrame') return { addLow: true, wanted: origin === topOrigin ? cache.hintsFor(origin) : [] };
  const decorated = Object.keys(requestHeaders ?? {}).some((k) => k.toLowerCase() === 'sec-ch-ua');
  if (!decorated) return none;
  const firstParty = origin === topOrigin && origin === frameOrigin;
  return { addLow: false, wanted: firstParty ? cache.hintsFor(origin) : [] };
}

/**
 * The header edit, pure. Returns a NEW header object where
 *  - a brand header the renderer sent (Sec-CH-UA, ...-Full-Version-List)
 *    is replaced by the recomputed Chrome list for that header — the same
 *    source as the CDP identity, so a renderer without the override (the
 *    chrome's own; a request racing the override) cannot leak Chromium's
 *    brand ORDER, which differs from Chrome's for most majors (appending
 *    "Google Chrome" only matches when major % 6 == 0). With no recomputed
 *    list supplied, the brand is appended instead (alignChromeBrands);
 *  - with `addLow`, each low-entropy hint is added where absent (a
 *    navigation: Electron sends none there, Chrome sends all three);
 *  - each `wanted` high-entropy hint is added where absent, and no other.
 * Nothing else the renderer sent is touched. Keys match case-insensitively;
 * added keys are lowercase, as Chromium emits them.
 *
 * @param {Record<string, string>} requestHeaders as Electron handed them
 * @param {{
 *   lowEntropy: Record<string, string>,
 *   highEntropy: Record<string, string>,
 *   wanted: string[],
 *   addLow?: boolean,
 * }} opts `lowEntropy`/`highEntropy` from chromeClientHints(); `wanted` and
 *   `addLow` from planClientHints() (empty / false = add nothing)
 * @returns {Record<string, string>}
 */
export function applyClientHintHeaders(requestHeaders, { lowEntropy, highEntropy, wanted, addLow = true }) {
  /** @type {Record<string, string>} */
  const out = { ...requestHeaders };
  const present = new Map(Object.keys(out).map((k) => [k.toLowerCase(), k]));
  /** @type {Record<string, string | undefined>} */
  const recomputed = {
    'sec-ch-ua': lowEntropy['sec-ch-ua'],
    'sec-ch-ua-full-version-list': highEntropy['sec-ch-ua-full-version-list'],
  };
  for (const [lower, key] of present) {
    if (!BRAND_HEADERS.has(lower)) continue;
    const fresh = recomputed[lower];
    out[key] = typeof fresh === 'string' && fresh !== '' ? fresh : alignChromeBrands(String(out[key]));
  }
  for (const [name, value] of Object.entries(addLow ? lowEntropy : {})) {
    const lower = name.toLowerCase();
    if (!present.has(lower)) out[lower] = value;
  }
  for (const name of wanted ?? []) {
    const lower = String(name).toLowerCase();
    const value = highEntropy[lower];
    if (value !== undefined && !present.has(lower)) out[lower] = value;
  }
  return out;
}
