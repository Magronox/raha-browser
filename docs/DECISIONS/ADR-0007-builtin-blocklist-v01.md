# ADR-0007: v0.1 ships a built-in tracker blocklist, not a filter-list engine

Date: 2026-07-19 · Status: **superseded by [ADR-0009](ADR-0009-ghostery-adblocker-bundled-lists.md) (2026-08-06)** — R-102 landed: bundled EasyList/EasyPrivacy via @ghostery/adblocker, same seam, `blockTrackers` name kept.

## Decision
v0.1 blocks third-party requests to ~80 household-name tracker/ad hosts
(`src/shared/blocklist.js`), suffix-matched, first-party always allowed.
A real filter-list engine (Ghostery/EasyList) is roadmap R-102.

## Context
The authoring environment could not fetch EasyList or npm packages, and
shipping v0.1 without ANY blocking would betray the privacy positioning.
A conservative host list catches the highest-volume trackers (analytics,
pixels, ad exchanges) with near-zero breakage risk because:
- third-party-only (a site's own domains never match),
- suffix match on curated hosts, no regex/cosmetic rules to get wrong.

## Consequences
- README describes it as "built-in tracker blocking (basic list)" — no
  EasyList claims until R-102. Honesty over marketing.
- The blocked-count shield in the topbar undercounts vs uBlock — expected.
- shouldBlock() is pure and unit-tested; R-102 swaps the engine behind the
  same webRequest seam (`src/main/electron/privacy.js`) and keeps the
  `blockTrackers` setting name.
