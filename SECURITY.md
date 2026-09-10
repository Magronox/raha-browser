# Security policy

## Reporting a vulnerability

Email **basareh@duck.com** with subject starting `[raha security]`, or use
GitHub's private vulnerability reporting ("Report a vulnerability" under the
Security tab) if enabled. Please include reproduction steps. You'll get an
acknowledgment as soon as humanly possible; this is a volunteer project.

Please do not open public issues for exploitable problems before a fix ships.

## Scope & model

Raha's security posture rests on Chromium's sandbox plus deliberate
architecture (enforced by tests — see docs/INVARIANTS.md):

- Web pages run sandboxed, context-isolated, with **no preload bridge** (#5),
  and are served neither Raha's own chrome nor tab thumbnails.
- The UI chrome is a local page under strict CSP, pinned to its own URL (it
  may not navigate or open windows), reachable only over contract IPC
  channels, and main verifies the sender frame of every message.
- Only `http:`, `https:`, `raha:` and `blob:` URLs may ever load in a tab —
  including URLs arriving from `window.open()` or from a restored session file.
  (`blob:` is origin-bound and cannot name a file on disk; it is how sites open
  a generated PDF. `file:`, `javascript:`, `data:`, `chrome:` and
  `view-source:` are refused.)
- Non-web app links (`zoommtg:`, `mailto:`, `tel:`…) never load in a tab.
  They can reach the OS, but only through one gated sink (ADR-0011): a
  deny-list of launcher-abuse schemes (`file:`, `javascript:`, `ms-msdt:`,
  `search-ms:`, `ms-appinstaller:`, …) is refused outright and never shown
  to you; anything else opens an in-app ask displaying the full URL, and the
  OS is touched only after a yes. Per-scheme "always allow" is revocable in
  Settings. Note for audit readers: the 2026-07 audit recorded
  `shell.openExternal` as absent from the codebase; since 2026-08-22 it
  appears in exactly one place, behind this consent gate.
- Permission requests (camera, microphone, location, notifications,
  clipboard-read) are never granted silently: each raises Raha's own ask,
  the engine holds the pending request and only the id it displayed can be
  answered, and an ask is shown only for the tab on screen (ADR-0013).
  Remembered answers live in `settings.sitePermissions`, validated on load
  (unknown kinds, values and non-hostnames are dropped), and are revocable
  in Settings. Everything else a page requests (screen capture, MIDI, …) is
  refused. Known limit: Electron's permission *check* hook cannot answer
  "prompt", so an undecided site reads "denied" to `permissions.query`.
- Page-controlled strings are escaped at every render sink (#11).
- The only server Raha itself contacts is GitHub Releases, for the optional
  security-update check (#6, ADR-0008; `autoUpdate` setting, on by default).
  One further class of request is not app-initiated telemetry but is worth
  stating: the chrome loads **favicons** straight from the sites in your tab
  list (`<img>` in the UI), which happens even on a cold start with every tab
  asleep. The ad/tracker filter lists (EasyList + EasyPrivacy) are bundled
  with the app and refreshed only via app releases — never downloaded at
  runtime (ADR-0009). Runtime dependencies: two direct (electron-updater,
  ADR-0008; @ghostery/adblocker, ADR-0009 — both pinned exact), 28 packages
  in total with transitives; supply-chain surface = Electron + those + this
  repo.
- Shipped binaries have Electron fuses burned: `ELECTRON_RUN_AS_NODE`,
  `NODE_OPTIONS`, and node-inspector are dead; cookies encrypted at rest;
  app code loads only from the integrity-checked asar. A release-workflow
  guard fails the build if the fuses stop holding.

A full pre-launch audit against Electron's official security checklist —
findings, fixes, and method — is in `docs/SECURITY-AUDIT-2026-07.md`.

Known accepted risks in v0.1 (fixes tracked in docs/ROADMAP.md):
- **No Safe Browsing.** Electron ships none of Chrome's malicious-site or
  dangerous-download warnings. A file Chrome would flag downloads silently
  here; treat downloads with the same care you would from a plain link.
- **Tab thumbnails are unencrypted screenshots** in your profile directory —
  whatever was on screen when a tab slept is on disk as a PNG. Wipe the
  profile directory to remove them.
- macOS and Windows builds are unsigned (R-108), so you must bypass Gatekeeper
  or SmartScreen by hand to install.
- `RAHA_NO_SANDBOX=1` exists for CI/containers only — never run it as your
  daily browser. Note a **packaged** build still honors it and will disable
  Chromium's process sandbox; refusing it in shipped binaries is R-117.
- Blocking is network-level only — no cosmetic filtering (that would need a
  preload in web pages, which invariant #5 forbids), and cancel-only (no
  surrogate scripts), so some sites show empty ad slots or object to a
  missing tracker script. The per-site shield toggle is the escape hatch
  (ADR-0009).
