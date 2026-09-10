# ADR-0008: Automatic updates via electron-updater

Date: 2026-07-23 · Status: accepted · Amended by [ADR-0009](ADR-0009-ghostery-adblocker-bundled-lists.md) (2026-08-06): `@ghostery/adblocker` joined as the second runtime dependency; "FIRST runtime dependency" below is historical.

## Decision

Raha ships with `electron-updater` — the project's FIRST runtime dependency
(amending ADR-0004) — checking GitHub Releases every 4 hours and installing
updates on quit. Controlled by the `autoUpdate` setting (default **on**,
disableable in Settings). Packaged builds only; dev/test runs never check.

## Context

A browser's dominant security property is patch latency: Chromium CVEs are
public within days, and Chrome users are patched silently. Without an update
channel, every shipped Raha binary keeps its Chromium bugs until users
manually notice, download, and reinstall — in practice, forever. That makes
"no update pings" (invariant #6's original wording) actively harmful to
users the moment v0.1.0 is public.

Why a dependency instead of hand-rolling (the ADR-0004 bar): a safe updater
must verify artifact hashes against the release metadata, handle
differential downloads, staged installs, and per-OS install mechanics
(NSIS, Squirrel.Mac, AppImage swap). This is exactly the "crypto-adjacent,
demonstrably should not write it ourselves" category. electron-updater is
MIT (compatible per ADR-0002), maintained by the electron-builder project we
already build with, and pinned exact in package.json.

Privacy accounting (the #6 trade): when enabled, the ONLY added traffic is
a metadata fetch + artifact download from GitHub Releases — carrying, like
any HTTP request, the user's IP and a version-implying URL. No unique IDs,
no telemetry, nothing else. The check respects `autoUpdate` at every tick;
turning it off stops all update traffic. Settings copy states this plainly.

macOS caveat: Squirrel.Mac refuses to install into unsigned apps, so until
signing lands (R-108) macOS gets **notify-only** toasts ("new version
available — download from GitHub") while Windows/Linux auto-install on quit.

## Consequences

- Invariant #6 is reworded: "silent on the network **except the optional
  update check**" — settings UI, SECURITY.md, USER_GUIDE, and CLAUDE.md say
  the same thing in the same words. The zero-telemetry promise is unchanged.
- The supply chain is no longer empty: electron-updater + its transitive
  deps ship in the asar. Mitigations: exact version pin, lockfile + `npm ci`
  builds, Dependabot PRs for updates (each reviewed like any code change).
- `src/main/electron/updater.js` is the only file importing it (layer
  purity, invariant #1 unchanged).
