// Chromium features Raha switches off for every page (0.3.2; 1.0's audit
// 2026-11 B3, list and comment copied from 1.0).
// No 'electron' import, so the unit tests can read the lists.
//
// The ad APIs Chrome calls the Privacy Sandbox: interest groups and
// auctions (Protected Audience, formerly FLEDGE), Shared Storage,
// Attribution Reporting, Topics, Private State Tokens (formerly Trust
// Tokens) and fenced frames (the frame those auctions render into). They
// exist to let advertisers measure and target people across sites; a
// privacy browser has no use for any of them, and a profile showed sites
// calling them. 0.3.2 (Electron 44.3.0, Chromium 152.0.7977.78): every name
// below is present in that build's Electron Framework binary, and
// "PrivateAggregationApi" is not (checked with `strings`, 2026-11-10).
// Fledge and SharedStorageAPI are also base features of the same names
// (blink::features), so they are in both lists. Not in that binary, so not
// listed (a name Chromium does not know switches nothing off):
// InterestGroupStorage, PrivacySandboxAdsAPIs, AttributionReportingCrossAppWeb
// (re-checked 2026-11-10 with `strings` on Electron 44.3.0's framework).
// tests/e2e/security-qa.spec.js checks that pages see none of: Topics,
// joinAdInterestGroup, runAdAuction, sharedStorage, fenced frames,
// attributionSrc, hasPrivateToken.
// 1.0 checked the names against Chromium 156.0.8078.80 source:
//   blink runtime features: third_party/blink/renderer/platform/runtime_enabled_features.json5
//   base features: services/network/public/cpp/features.cc (BrowsingTopics,
//                  line 408 at 156: BASE_FEATURE(kBrowsingTopics, ...)),
//                  third_party/blink/common/features.cc (FencedFrames)
// Private Aggregation: nothing left to switch off at 156. Its base feature
// kPrivateAggregationApi ("PrivateAggregationApi") was in
// third_party/blink/common/features.cc (line 1954 at 130.0.6723.0) and is
// gone from it at 156.0.8078.80, as is the whole
// content/browser/private_aggregation directory (re-checked 2026-11-07);
// no runtime feature of that name exists either, so adding the name would
// switch nothing off. Its API lived inside Shared Storage and Protected
// Audience worklets, both off here. Chromium ignores a name it
// does not know, so a name retired by a later Chromium only stops working:
// re-check this list on every Electron upgrade (upgrade-electron playbook).
//
// app.commandLine.appendSwitch: https://www.electronjs.org/docs/latest/api/command-line
// A switch given twice keeps only its last value, so every name for one
// switch lives in one list here.

/**
 * --disable-blink-features. WebAuth: passkeys, off until Raha can serve a
 * request (see the note in src/main/index.js).
 */
export const DISABLED_BLINK_FEATURES = Object.freeze([
  'WebAuth',
  'AdInterestGroupAPI',
  'Fledge',
  'InterestGroupsInSharedStorageWorklet',
  'SharedStorageAPI',
  'AttributionReporting',
  'TopicsAPI',
  'PrivateStateTokens',
  'FencedFrames',
]);

/** --disable-features (base features). */
export const DISABLED_FEATURES = Object.freeze([
  'BrowsingTopics',
  'FencedFrames',
  'Fledge',
  'SharedStorageAPI',
]);
