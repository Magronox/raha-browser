// Loads the bundled filter-list engines (ADR-0009). This is the ONLY file
// importing @ghostery/adblocker. It deliberately does NOT import 'electron'
// so unit tests can load it directly (tests/unit/blocklist-artifacts.test.js);
// the engine files ship inside the asar, which Electron's fs reads
// transparently. Decision logic lives in src/shared/blocking.js — this file
// only turns Electron request details into engine verdicts.
import { readFileSync } from 'node:fs';
import { FiltersEngine, Request } from '@ghostery/adblocker';

/** Electron resourceType -> webextension request type (what the engines
 * expect for $script/$image/$websocket-style options). */
const TYPE_MAP = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

/**
 * @param {{ url: string, resourceType: string }} req
 * @param {string|null} topHost
 */
function toRequest(req, topHost) {
  return Request.fromRawDetails({
    url: req.url,
    type: /** @type {any} */ (TYPE_MAP[/** @type {keyof typeof TYPE_MAP} */ (req.resourceType)] ?? 'other'),
    // First/third-party context: our engine-tracked top-level host (the same
    // value the per-site shield matches on), not the per-frame referrer.
    sourceUrl: topHost ? `https://${topHost}/` : undefined,
  });
}

/**
 * Load both bundled engines. Throws on failure — the caller fails OPEN
 * (blocking off, browsing unaffected) and tells the user.
 * @returns {import('../../shared/blocking.js').Matchers}
 */
export function loadBlockerEngines() {
  const load = (/** @type {string} */ name) =>
    FiltersEngine.deserialize(new Uint8Array(readFileSync(new URL(`./data/${name}`, import.meta.url))));
  const ads = load('easylist.engine');
  const tracking = load('easyprivacy.engine');
  return {
    matchAds: (req, topHost) => ads.match(toRequest(req, topHost)).match,
    matchTracking: (req, topHost) => tracking.match(toRequest(req, topHost)).match,
  };
}
