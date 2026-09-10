# ADR-0009: Filter-list blocking via @ghostery/adblocker, lists bundled at build time

Date: 2026-08-06 · Status: accepted · Supersedes ADR-0007 · Amends ADR-0004 and ADR-0008

## Decision

`@ghostery/adblocker` (the core package only, pinned exact) becomes the
project's SECOND runtime dependency. EasyList backs the new `blockAds`
setting; EasyPrivacy backs the kept `blockTrackers` setting (name preserved
per ADR-0007). Lists are compiled to serialized engines at release time
(`scripts/build-blocklists.mjs`), checked into the repo alongside the raw
list text, shipped inside the asar, and NEVER fetched at runtime —
invariant #6's "no list downloads" holds verbatim.

Network-level blocking only: cancel-only (redirect-to-surrogate filters are
treated as plain blocks), main-frame requests are never cancelled (the page
the user asked for always loads), and NO cosmetic filtering. The webRequest
seam stays `src/main/electron/privacy.js` — we deliberately do NOT use
`@ghostery/adblocker-electron`: its `enableBlockingInSession()` wants its own
`onBeforeRequest` listener (Electron allows exactly one per session) plus a
preload in web pages for cosmetics, which invariant #5 forbids.

## Context

Why a dependency instead of hand-rolling (the ADR-0004 bar): the Adblock Plus
filter format is ~100k rules of exceptions (`@@`), `$options` (`third-party`,
`domain=`, resource types), eTLD+1 partitioning, and µs-per-request matching
expectations. ADR-0004 itself lists "filter-list engines" as the canonical
should-not-write-ourselves category. License: MPL-2.0, GPL-3-compatible,
pre-cleared by ADR-0002. Maintained by Ghostery; pinned exact.

The serialized engine format is version-locked: `FiltersEngine.deserialize`
refuses artifacts built by a different package version. Every version bump
must therefore regenerate the artifacts (`npm run blocklists -- --from-local`
— no network needed, it re-parses the checked-in raw lists). Enforced by
`tests/unit/blocklist-artifacts.test.js`, which also proves byte-for-byte
that the shipped binary engines are exactly `parse(checked-in raw text)` —
the blobs stay auditable.

Privacy accounting (the #6 trade): ZERO added runtime traffic — lists ship in
the binary and refresh only via app releases, an already-accounted channel.
List staleness therefore equals release cadence; chosen deliberately over
runtime fetches, which would put a Raha-initiated request on the wire and
soften the "fully silent" promise. Resource accounting: ~3.2 MB added to the
app (both engines), engine deserialize at boot is tens of milliseconds,
matching is synchronous and sub-millisecond per request. If the engines fail
to load, blocking fails OPEN with a warning toast — a broken blocker must
never break browsing or boot.

## Consequences

- README badge → `runtime deps-2`; supply-chain row re-counted (28 unique
  runtime packages: electron-updater's 16 + this family's 12). Mitigations
  unchanged: exact pins, lockfile + `npm ci` builds, Dependabot review.
- ADR-0004's "exactly one" note is amended again; ADR-0007 is superseded and
  `src/shared/blocklist.js` (the curated list) is deleted. Its behavioral
  guarantees live on in `tests/unit/blocking.test.js` and the artifact
  conformance suite.
- First-party ad/tracker requests CAN now be blocked where the lists say so —
  ADR-0007's "a site's own assets never break" guarantee is retired; the
  per-site shield toggle is the escape hatch.
- No cosmetic filtering: collapsed ad slots may show as empty boxes (stated
  in USER_GUIDE). Cancel-only means surrogate scripts are not served — a
  known, accepted breakage source; revisit if reports accumulate.
- `src/main/electron/blocker.js` is the only file importing the dependency
  (layer purity, invariant #1 unchanged).
- `docs/PLAYBOOKS/release.md` gains a "refresh blocklists" step.
