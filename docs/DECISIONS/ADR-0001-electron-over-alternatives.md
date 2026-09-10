# ADR-0001: Electron over Tauri / Chromium fork / extension

Date: 2026-07-19 · Status: accepted

## Decision
Build Raha as an Electron app orchestrating Chromium `WebContentsView`s.

## Context
The flagship feature is per-tab resource governance: real per-tab memory/CPU
attribution, true suspension that returns RAM to the OS, thumbnails,
process-level control. Candidates:

- **Tauri / system webviews:** ~10MB binaries, but per-tab process metering
  and forced suspension are not reliably possible across WebKitGTK/WebView2,
  and Rust raises the bar for agent-driven maintenance. The flagship feature
  dies or degrades per-platform.
- **Chromium fork (Brave/Vivaldi path):** total control, but ~100GB
  toolchain, hours-long builds, perpetual security rebases. Not viable for
  one maintainer + agents.
- **Browser extension:** MV3 can't own windows/process budgets; not a browser.
- **Electron:** Chromium with a supported API exactly at our needed layer:
  `getOSProcessId`, `app.getAppMetrics`, `capturePage`,
  `navigationHistory.restore`, per-session webRequest/permissions. Proven by
  Min and others. Cost: ~100MB installers and Electron-major upkeep.

## Consequences
- "Light" is delivered at RUNTIME (tab discipline), not in installer size;
  README says this honestly.
- The Electron surface is quarantined in `src/main/electron/` (ADR-0005) so
  the upgrade treadmill touches one small layer.
- Revisit only if system webviews gain real process-control APIs.
