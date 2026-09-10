// Pure blocking decision pipeline (R-102, ADR-0009). The Ghostery engines are
// injected as matcher functions by src/main/electron/blocker.js; this module
// owns everything testable without them: the settings gates, the URL guard,
// the never-cancel-mainFrame rule, and the per-site shield list.
import { normalizeSiteHost } from './validate.js';

/** @typedef {{ url: string, resourceType: string }} BlockableRequest */
/**
 * @typedef {Object} Matchers
 * @property {(req: BlockableRequest, topHost: string|null) => boolean} matchAds      EasyList
 * @property {(req: BlockableRequest, topHost: string|null) => boolean} matchTracking EasyPrivacy
 */

/**
 * Schemes the blocker may act on. raha:, blob:, data:, garbage → never
 * blocked. ws/wss ARE blockable — a deliberate change from the pre-R-102
 * curated list, which ignored non-http(s) entirely.
 * @param {string} url
 * @returns {boolean}
 */
export function isBlockableUrl(url) {
  try {
    return /^(https?|wss?):$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Is the shield off for this top-level host? Entry semantics: a bare host
 * covers itself and all subdomains; "www." is transparent (normalizeSiteHost
 * strips it on both sides).
 * @param {string|null} topHost
 * @param {string[]} noBlockHosts
 * @returns {boolean}
 */
export function isShieldOff(topHost, noBlockHosts) {
  if (!topHost || noBlockHosts.length === 0) return false;
  const h = normalizeSiteHost(topHost);
  if (!h) return false;
  return noBlockHosts.some((entry) => h === entry || h.endsWith('.' + entry));
}

/**
 * The one place that says "cancel this request" — called from the
 * onBeforeRequest hook in src/main/electron/privacy.js for every request the
 * web session makes.
 * @param {BlockableRequest} req
 * @param {string|null} topHost  top-level page host (engine-tracked), null if unknown
 * @param {import('./defaults.js').RahaSettings} s
 * @param {Matchers} matchers
 * @returns {boolean}
 */
export function decideBlock(req, topHost, s, matchers) {
  if (!s.blockAds && !s.blockTrackers) return false;
  if (!isBlockableUrl(req.url)) return false;
  if (req.resourceType === 'mainFrame') return false; // the page the user asked for always loads
  if (isShieldOff(topHost, s.noBlockHosts)) return false;
  if (s.blockAds && matchers.matchAds(req, topHost)) return true;
  if (s.blockTrackers && matchers.matchTracking(req, topHost)) return true;
  return false;
}
