# Security policy

Current version: 0.3.3, released 11 November 2026.

## Reporting a vulnerability

Email **basareh@duck.com** with subject starting `[raha security]`, or use
GitHub's private vulnerability reporting ("Report a vulnerability" under the
Security tab). Please include reproduction steps. Raha is a
one-person project; reports are acknowledged as soon as possible.

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
  in Settings. A frame from another site that asks for notifications or
  the clipboard is refused, without an ask. Everything else a page requests
  (screen capture, MIDI, …) is refused. Known limit: Electron's permission *check* hook cannot answer
  "prompt", so an undecided site reads "denied" to `permissions.query`.
- Chromium's advertising APIs (Topics, Protected Audience, Shared Storage,
  Attribution Reporting, Private State Tokens, fenced frames) are switched
  off for every page (`src/main/electron/chromium-switches.js`).
- Page-controlled strings are escaped at every render sink (#11).
- Apart from the pages you open, Raha makes three kinds of request on its
  own. (1) GitHub, for the update check (#6, ADR-0008; `autoUpdate`
  setting, on by default): about 30 seconds after start and every four
  hours. One check is a few requests, with no cookies, the same all-zero
  `x-user-staging-id` for every install, and the system language
  (`Accept-Language`). 0.3.3 makes no `.updaterId` file and deletes an
  existing one. On Windows, and on Linux with the AppImage, it also downloads a new
  version in the background and installs it on quit (the .deb may not); on macOS it only announces one.
  (2) The chrome loads **favicons** straight from the sites in your tab
  list (`<img>` in the UI), possibly with those sites' cookies, even on a cold start
  with every tab asleep. (3) Only with spellcheck set to Always, on Windows
  and Linux, Chromium downloads a dictionary from Google. The ad/tracker filter lists (EasyList + EasyPrivacy) are bundled
  with the app and refreshed only via app releases — never downloaded at
  runtime (ADR-0009). Runtime dependencies: two direct (electron-updater,
  ADR-0008; @ghostery/adblocker, ADR-0009 — both pinned exact), 28 packages
  in total with transitives; supply-chain surface = Electron + those + this
  repo.
- Shipped binaries have Electron fuses burned: `ELECTRON_RUN_AS_NODE`,
  `NODE_OPTIONS`, and node-inspector are dead; cookies encrypted at rest;
  app code loads only from the integrity-checked asar. A release-workflow
  guard fails the build if the fuses stop holding.

A pre-launch audit against Electron's official security checklist, made
by the project itself — findings, fixes, and method — is in `docs/SECURITY-AUDIT-2026-07.md`.

Fixed in 0.3.3 (advisory: https://github.com/Magronox/raha-browser/security/advisories/GHSA-m68f-fgxg-6v72): 0.3.1 and earlier registered no
`select-client-certificate` handler, so when a site requested a TLS client
certificate, Electron sent the first matching certificate on the computer
without asking. 0.3.3 sends none. The same release stops the persistent
update install ID (above).

Known limits in 0.3.3, not fixed: third-party cookies are not blocked; a
typed address may count as the tab's site for permissions and the blocker's
first party before the page has loaded.

Accepted risks in 0.3.3:
- **No Safe Browsing.** Electron ships none of Chrome's malicious-site or
  dangerous-download warnings. A file Chrome would flag downloads silently
  here; treat downloads with the same care you would from a plain link.
- **Tab thumbnails are unencrypted screenshots** in your profile directory —
  whatever was on screen when a tab slept is on disk as a PNG. Wipe the
  profile directory to remove them.
- **Text typed into pages in 0.3.1 and earlier.** Those versions saved
  form text and addresses with a name and password in each tab's
  back/forward steps in `state.json`. 0.3.3 removes them from Raha's own
  files; copies in backups, or in files Raha set aside because it could not
  read them, are not. Raha copies such a file as it was, names the copy
  when it starts, and keeps the newest three, and any newer than two weeks;
  it says so when it removes one. Delete them by hand.
  Raha cannot erase the disk space the old file used.
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
