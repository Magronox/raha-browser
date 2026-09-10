// Single source of truth for default settings and their allowed ranges.
// If you add a setting: update DEFAULT_SETTINGS + RANGES here, the validator
// in validate.js picks it up, then follow docs/PLAYBOOKS/add-a-setting.md.

export const SETTINGS_SCHEMA_VERSION = 3;
export const STATE_SCHEMA_VERSION = 2;
export const HISTORY_SCHEMA_VERSION = 1;

/**
 * @typedef {Object} RahaSettings
 * @property {number} schemaVersion
 * @property {number} maxLiveTabs      Hard cap on simultaneously running tabs (active tab included). 1..64.
 * @property {number} idleSleepMinutes Sleep a background tab after N idle minutes. 0 = off. 0..720.
 * @property {number} globalBudgetMB   Total memory budget for all running tabs. 0 = off. 0..65536.
 * @property {boolean} protectAudio    Never auto-sleep a tab that is playing sound.
 * @property {boolean} runawayGuard    Ask to terminate a tab whose CPU/memory use explodes (thresholds: RUNAWAY in policy.js).
 * @property {boolean} blockAds        Block ads via the bundled EasyList (network-level only, no cosmetic filtering; ADR-0009).
 * @property {boolean} blockTrackers   Block trackers via the bundled EasyPrivacy list (ADR-0009).
 * @property {string[]} noBlockHosts   Sites where the shield is off: bare lowercase host, leading "www." stripped, covers the host and its subdomains. Max 200.
 * @property {boolean} gpc             Send Global Privacy Control + DNT headers.
 * @property {boolean} httpsFirst      Default typed hosts to https://.
 * @property {boolean} autoUpdate      Check GitHub Releases for new versions and install security updates (ADR-0008). The only network request Raha makes on its own; off = fully silent.
 * @property {boolean} recordHistory   Remember pages visited in Raha (R-106) — local history.json only, powers omnibox suggestions + the History panel; never leaves the machine.
 * @property {string[]} allowedExternalSchemes   App link schemes the user chose to always open without asking (e.g. "zoommtg"). Empty = ask every time. Max 50; dangerous schemes can never be added.
 * @property {boolean} defaultBrowserPrompted  Internal: the one-time "make Raha your default browser?" OS prompt has been shown. Not in the Settings UI.
 * @property {import('./permissions.js').SitePermissions} sitePermissions  Remembered answers to per-site permission asks (R-103, ADR-0013): site host (normalized like noBlockHosts) -> kind -> 'allow'|'deny'. Undecided = ask when a page requests, "denied" to a mere check. Max 200 sites, oldest dropped. Schema v3.
 * @property {boolean} restorePageState Restore scroll position and unsaved form text when a sleeping tab wakes (R-104). Kept in the profile only — never passwords. Turning it off wipes stored state.
 * @property {'duckduckgo'|'brave'|'startpage'|'ecosia'|'google'|'bing'|'kagi'} searchEngine
 * @property {DomainRule[]} rules      Programmable per-domain policies, first match wins.
 */

/**
 * @typedef {Object} DomainRule
 * @property {string} pattern      Host pattern: exact ("news.ycombinator.com") or subdomain wildcard ("*.youtube.com").
 * @property {boolean} [keepAlive] Keep matching tabs running in the background.
 * @property {number}  [memLimitMB] Per-tab memory limit for matching tabs. 0 or absent = none.
 */

/** @returns {RahaSettings} */
export function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    maxLiveTabs: 6,
    idleSleepMinutes: 0,
    globalBudgetMB: 0,
    protectAudio: true,
    runawayGuard: true,
    blockAds: true,
    blockTrackers: true,
    noBlockHosts: [],
    gpc: true,
    httpsFirst: true,
    autoUpdate: true,
    recordHistory: true,
    allowedExternalSchemes: [],
    defaultBrowserPrompted: false,
    sitePermissions: {},
    restorePageState: true,
    searchEngine: 'duckduckgo',
    rules: [],
  };
}

/** Numeric ranges used by the validator (min, max). */
export const RANGES = {
  maxLiveTabs: [1, 64],
  idleSleepMinutes: [0, 720],
  globalBudgetMB: [0, 65536],
  memLimitMB: [0, 16384],
};

/** Search engine name -> URL template. %s is the encoded query. */
export const SEARCH_ENGINES = {
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  brave: 'https://search.brave.com/search?q=%s',
  startpage: 'https://www.startpage.com/sp/search?query=%s',
  ecosia: 'https://www.ecosia.org/search?q=%s',
  google: 'https://www.google.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
  kagi: 'https://kagi.com/search?q=%s',
};

/** Well-known internal pages. */
export const HOME_URL = 'raha://home';
