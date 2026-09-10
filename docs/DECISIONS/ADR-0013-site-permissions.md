# ADR-0013: Site permissions are asked per site, in Raha's own prompt, and the engine is the only grantor

Date: 2026-08-27 · Status: accepted · Roadmap: R-103 (R-103b carve-out)

## Decision

Five Electron permissions become **askable**: `media` (split into the
kinds `camera` and `microphone` by `details.mediaTypes` — one getUserMedia
for both is ONE ask covering both), `geolocation`, `notifications`, and
`clipboard-read` (kind `clipboard`). Everything else keeps v0.1's
deny-by-default (`display-capture`, `midi`, `idle-detection`,
`storage-access`, …), now with the refusal toast rate-limited to one per
tab per permission. The three silently-allowed ones (`fullscreen`,
`pointerLock`, `clipboard-sanitized-write`) are unchanged.

The shape copies the app-link ask (ADR-0011), because the same threat
model applies — page script raises the request, not a click:

- **The engine holds every pending ask** (`permissionQueues`, per tab) and
  is the only place that grants. The adapter (`privacy.js`) awaits
  `engine.permissionRequest(...)`; the resolved boolean *is* Electron's
  callback argument. The UI answers an **id** (`permission:answer`), never
  a site or a kind; a stale id — withdrawn, superseded, already answered —
  is an error that grants and remembers nothing. The modal re-renders keyed
  on the id, so a click can never land on text that described a different
  request.
- **An ask is shown only for the page on screen.** Only the head of the
  ACTIVE tab's queue is ever on screen; a background tab's request waits
  until the user switches to it; switching away withdraws the modal (the
  request stays pending) and the same ask, same id, returns with the tab.
  One ask at a time; identical asks coalesce; the per-tab queue is capped
  (surplus refused) so a looping page cannot build a dialog backlog.
- **An ask never outlives its page.** Close, sleep, crash, or navigating to
  another site refuses pending asks (nothing remembered); same-site
  navigation keeps them.
- **Four answers.** *Allow once* grants for the page visit — per tab, ended
  by the same events that drop asks — and persists nothing. *Always allow*
  / *Never for this site* persist `'allow'`/`'deny'` per kind under the
  site host in `settings.sitePermissions` (schema v2→v3; keyed by
  `normalizeSiteHost` of the **tab's** page, like `noBlockHosts` — an
  embedded frame asks on behalf of the site the user is looking at, and the
  modal says so; cap 200 sites, oldest dropped; validated on load so a
  hand-edited settings.json cannot inject kinds, states, or non-hosts).
  *Not now* / Escape / backdrop refuse this request only. A persisted
  answer also settles asks still queued for that site on any tab and
  narrows the rest to what is undecided.
- **Remembered answers are silent** — no ask, no toast. That is what
  remembering means. Any blocked kind refuses a multi-kind request
  outright; the user already said no.
- **Settings → Site permissions** lists every remembered decision (a chip
  per kind, × to forget it, *Forget site* for the row) so no one edits a
  JSON file to change their mind.

## Context

v0.1 denied every permission and toasted. That is quiet and safe, and it
also means no video call, map, or notification could ever work in Raha — a
"use another browser for meetings" gap the daily-driver goal cannot carry —
and a fresh profile answered "denied" to every `permissions.query`, which
bot-detection scores against (Chrome answers "prompt"). The owner's UX rule
for anything sensitive is consent-first: nothing granted silently, and the
user is never surprised by a dialog about something they cannot see. The
default-browser flow and app links (ADR-0011) set that precedent; this
follows it.

**The honest limit — undecided reads as denied to a check.** Electron's
`setPermissionCheckHandler` returns a boolean; there is no way to answer
"prompt" the way Chrome does for a site the user has not decided on. So
`navigator.permissions.query`, `Notification.permission` and device
enumeration read "denied" for an undecided site, and the site is asked on
its first real *request* (Chromium requests after a failed check for every
API that matters here). The consequence is a residual fingerprint tell
(ADR-0012's list is updated) and a mild web-compat cost: a site that only
probes and never requests believes it is blocked. The alternative —
answering checks "granted" for undecided sites so the request path prompts
— would lie to pages (and to the user's Settings) and let device
enumeration through without consent; rejected.

Alternatives considered:

- **Keep deny-all** (status quo): safe, user-hostile, and a detectable tell.
- **Native Electron/OS dialogs**: platform-inconsistent, uncopyable words,
  and on macOS a second system dialog can still follow for capture devices
  — Raha's own prompt is the consent; the OS one, where it exists, is the
  OS's business.
- **A topbar permission icon (Chrome's) in v1**: deferred; the Settings
  list covers changing one's mind, and an icon is a later polish item.
- **Ask for screen sharing too**: `display-capture` needs
  `setDisplayMediaRequestHandler` and a picker (which screen/window, with a
  preview) — a different UI from a yes/no ask. Carved out as R-103b; it
  stays refused.

## Consequences

- New IPC: `permission:answer`, `permission:forget`, `evt:askPermission`
  (contract → engine → ipc → api → mock-bridge, INVARIANTS #7).
- Settings schema **v3** (`sitePermissions`, migration 2→3 adds `{}`;
  fixture test). `src/shared/permissions.js` holds the vocabulary,
  Electron-name mapping, verdicts, cap, and the ask's wording — pure and
  unit-tested.
- Adapter surface: `hardenWebSession` gains `askPermission` /
  `checkPermission` hooks (wired in `index.js` to `engine.permissionRequest`
  / `permissionCheck`, mapping the WebContents to its tab and the tab's
  page host); the engine contract comment lists both as INBOUND.
- Pinned at three layers: engine-on-fakes (lifecycle, queueing, coalescing,
  stale ids, persistence, once-grants), ui-harness (modal words, every
  button, Escape, withdraw/return, Settings chips), and e2e against real
  Electron with `--use-fake-device-for-media-stream` (geolocation,
  notifications, camera, microphone; the check path; Settings). The e2e
  suite deliberately never persists a capture-device *allow* for the QA
  origin: a remembered media grant switches off Chromium's mDNS candidate
  hiding for that page, which the R-122 WebRTC test relies on.
- The 2026-07 audit's P5 hand-check ("denied + toast") is superseded; the
  manual page and its automated twin now describe the ask flow.
- A remembered *allow* is a standing grant for that site until forgotten —
  the same trade the app-link "always allow" makes, and the reason it is
  visible and one click away in Settings.
