// External-app links: zoommtg://, msteams://, mailto:, tel: …
//
// A meeting link that dead-ends in "blocked by Raha" with no way to say yes
// is a bug, not security: the user clicked a Zoom link and meant it. But
// handing any scheme to the OS is how browsers get used as launchers for
// local attack surface (ms-msdt:, search-ms:, file:), so the policy is:
//
//   web schemes        -> open as a tab (isNavigableUrl, invariant #13)
//   dangerous schemes  -> refused outright, never offered (list below)
//   everything else    -> ASK, once, showing the full URL; the user may
//                         remember the scheme (settings.allowedExternalSchemes)
//
// Raha never launches an app on its own: page script can RAISE an ask (a
// navigation or window.open needs no click), but only the user's yes in
// that ask reaches the OS. "Remember" is an explicit choice — and because
// a remembered scheme then opens on page action alone, the engine
// rate-limits those auto-opens (a looping page falls back to asking).
// Same consent-first rule the default-browser flow set.

/**
 * Schemes that must never reach the OS, no matter what the page wants.
 * These are the documented browser-as-launcher attack surface: local file
 * and script execution, Windows protocol handlers used for RCE
 * (ms-msdt/search-ms/ms-appinstaller), and internals of the browser itself.
 */
const DANGEROUS = new Set([
  'file', 'javascript', 'data', 'vbscript', 'about', 'blob',
  'chrome', 'chrome-extension', 'devtools', 'view-source', 'resource', 'res',
  'ie', 'mk', 'jar', 'shell', 'help', 'hcp', 'search-ms', 'ms-msdt',
  'ms-appinstaller', 'ms-officecmd', 'ms-search', 'ms-cxh', 'ldap', 'nntp',
  'raha', // our own pages are tabs, never an OS handoff
]);

/** Sane shape for a URL scheme (RFC 3986) plus a length sanity cap. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/;

/**
 * The scheme of a URL, lowercased, or null if it has none / is malformed.
 * Deliberately string-based: `new URL()` accepts things the shell would
 * treat differently, and we only ever want the part before the first colon.
 * @param {unknown} url
 * @returns {string|null}
 */
export function schemeOf(url) {
  if (typeof url !== 'string') return null;
  const i = url.indexOf(':');
  if (i <= 0) return null;
  const scheme = url.slice(0, i).toLowerCase();
  return SCHEME_RE.test(scheme) ? scheme : null;
}

/**
 * What should happen with a non-web URL a page asked to open.
 * @param {unknown} url
 * @returns {'dangerous'|'app'} 'app' = safe to ASK the user about
 */
export function classifyExternal(url) {
  const scheme = schemeOf(url);
  if (!scheme) return 'dangerous';
  if (DANGEROUS.has(scheme)) return 'dangerous';
  if (typeof url !== 'string' || url.length > 2048) return 'dangerous';
  // Control characters have no business in a string handed to the OS.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return 'dangerous';
  return 'app';
}

/**
 * Is this scheme on the user's remembered allow-list?
 * @param {string|null} scheme @param {string[]|undefined} allowed
 */
export function isRememberedScheme(scheme, allowed) {
  if (!scheme || !Array.isArray(allowed)) return false;
  return allowed.includes(scheme);
}

/**
 * A short, human label for the app a scheme belongs to — used in the ask.
 * Unknown schemes show the scheme itself, never a guess.
 * @param {string|null} scheme
 * @returns {string}
 */
export function appLabelForScheme(scheme) {
  if (!scheme) return 'another app';
  /** @type {Record<string, string>} */
  const known = {
    zoommtg: 'Zoom', zoomus: 'Zoom', zoomphonecall: 'Zoom',
    msteams: 'Microsoft Teams', slack: 'Slack', discord: 'Discord',
    spotify: 'Spotify', vscode: 'VS Code', 'vscode-insiders': 'VS Code',
    figma: 'Figma', notion: 'Notion', obsidian: 'Obsidian',
    tel: 'your phone app', sms: 'your messages app', facetime: 'FaceTime',
    mailto: 'your mail app', webcal: 'your calendar app', itms: 'the App Store',
    'itms-apps': 'the App Store', 'x-apple.systempreferences': 'System Settings',
  };
  return known[scheme] ?? `the “${scheme}” app`;
}
