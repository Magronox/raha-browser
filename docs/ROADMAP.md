# ROADMAP

Numbered items (R-1xx) so issues/commits can reference them. Each has
acceptance criteria — an item is done when the criteria hold AND
`npm run verify` is green. Ordered roughly by value/effort; re-prioritize
freely, but keep this file the single source of "what's next". Issues
reference these numbers (`R-101: …` in the title); this file stays the
source of what's next, issues track execution (R-125).

## Launch — shipping v0.1.0 to the world

- **R-123 Project website.** A home for Raha off GitHub: what it is, download
  links, the privacy promise in plain words. Static HTML/CSS in `site/`,
  deployed to GitHub Pages by its own workflow (ADR-0010) — no generator, no
  dependencies, extending ADR-0003's "what's in src/ is what runs" to "what's
  in `site/` is what serves". The site must practice what the browser
  preaches: no analytics, no cookies, no third-party requests — enforced by
  `scripts/check-site.mjs` (link allow-list, banned-phrase lint, version and
  asset drift checks) which gates every deploy. AC: live over HTTPS at
  <https://magronox.github.io/raha-browser/>; download links resolve to the
  latest GitHub release assets for all three OSes; a fresh page load makes
  zero third-party requests; README and package.json `homepage` point at it.
- **R-124 Support (donations).** One tasteful channel, charity-framed ("Support" since 2026-08-27, was "Donate"; never
  "sponsor" — maintainer's call).
  Rail: a Venmo link (free, immediate); GitHub Sponsors is optional and only
  joins if the maintainer ever wants it. There is no product, subscription,
  or anything to pay for — donations only. Repo half: `.github/FUNDING.yml`
  custom link (the repo-page button label is GitHub's own), `funding` field
  in package.json, a short "Support" README section. In-app half: a
  one-line link in `raha://welcome`'s footer and a Settings **About** section
  (app version + GitHub / report-a-bug / donate links opened via
  `tab:create`, the history-panel pattern — invariant #13 holds). Consent-
  first is a hard constraint: no toasts, no prompts, nothing periodic; the
  links sit still and wait to be found. AC: the repo-page funding button
  resolves to the donate link; README links resolve; About shows the real
  version; each About link opens a new tab (ui-harness scenario); the app
  makes zero new self-initiated requests.
- **R-125 Tracker ops (decided: no Jira).** GitHub Issues stays the tracker —
  CONTRIBUTING already promises it, users and agents are already there, and a
  second tracker is a second place to go stale. Convention: this file owns
  WHAT's next (R-items, priority = order); issues own execution and reference
  R-numbers in their titles; an item is delivered only when its AC holds and
  the `*Delivered*` note lands here. Setup: `ISSUE_TEMPLATE/config.yml`
  routing security to private advisories and questions to Discussions
  (enabled — closes first-push step 6), `v0.1.0-launch` milestone, `launch`
  label, seed issues for the launch items and top v0.2 items, CONTRIBUTING
  updated with the convention and its stale "exactly ONE runtime dependency"
  line fixed (two since ADR-0009). AC: the security contact link routes to
  private reporting; the convention is written in CONTRIBUTING.md and this
  file's intro; milestone and seed issues exist.

## v0.2 — daily-driver polish

- **R-101 Find in page.** Ctrl+F bar in the UI driving
  `webContents.findInPage` via new IPC channels. AC: search, next/prev,
  match count, Esc clears; e2e test.
  *Delivered 2026-08-19.* Find bar lives in the topbar (never overlays the
  page); results flow back as `evt:findResult`; the bar closes and clears
  highlights on tab switch. Port note: Electron's `findNext` flag means
  "begin a NEW session" — the views port names it `newSession` so nobody
  trips over it again. Covered at all three layers (engine-on-fakes,
  ui-harness, real-Electron e2e incl. the 0/0 no-match case).
- **R-102 Real filter-list blocking.** *Delivered 2026-08-06* (ADR-0009).
  EasyList backs a new `blockAds` toggle, EasyPrivacy backs the kept
  `blockTrackers` toggle, and the topbar shield is a per-site off button
  (persists in `noBlockHosts`, auto-reloads the tab). Shipped STRICTER than
  this item's original text: the dependency is `@ghostery/adblocker` (core
  only, not the `-electron` wrapper — it wants its own webRequest listener
  and a page preload), and lists are compiled at release time and BUNDLED
  in the app (`scripts/build-blocklists.mjs`, refresh step in release.md) —
  never fetched at runtime, so invariant #6's "no list downloads" held
  verbatim instead of gaining a cache carve-out. Blocked counter still
  per-tab. No cosmetic filtering (needs a page preload, invariant #5);
  empty ad boxes are the accepted cost.
- **R-103 Per-site permission prompts.** *Delivered 2026-08-27* (ADR-0013).
  Camera, microphone, location, notifications and clipboard-read now raise
  Raha's own ask (allow once / always allow / never for this site / not
  now) instead of a deny toast; always/never persist per site in
  `settings.sitePermissions` (schema v3, keyed like `noBlockHosts`, cap
  200), a *Site permissions* section in Settings forgets them per chip or
  per site. Consent-first like app links (ADR-0011): the engine holds every
  ask and only the id on screen can be answered; an ask shows only while
  its tab is the active one (background tabs wait their turn, one ask at a
  time) and never outlives its page. "Allow once" lasts for the page visit,
  per tab. Honest limit: Electron's permission *check* handler cannot say
  "prompt", so an undecided site reads "denied" to `permissions.query` /
  `Notification.permission` and is asked on its first real request. AC met:
  geolocation, notifications, microphone and camera each pinned at all
  three layers (unit mapping + engine, ui-harness modal, e2e against real
  Electron with fake capture devices). Carve-out → R-103b.
- **R-103b Screen sharing (display-capture).** Still refused: `getDisplayMedia`
  needs `setDisplayMediaRequestHandler` and a picker of Raha's own (which
  screen/window, with a preview) — a different UI from the yes/no ask, so it
  stays out of R-103. AC: the picker, an e2e that grants a fake display
  stream, and an entry under Site permissions.
- **R-104 Scroll + form state on wake.** Save scroll position at sleep
  (executeJavaScript) and restore after wake. AC: e2e scrolls, sleeps,
  wakes, asserts position within 50px.
- **R-105 Wake-preview hover.** Hovering an asleep tab shows its thumbnail
  large without waking. AC: ui-harness test.
- **R-106 History & downloads pages.** raha://history from a local (opt-in)
  history store; raha://downloads listing session downloads. AC: history off
  by default (privacy), searchable when on.
  *Partially delivered 2026-07-29:* the store (`history.json`), the History
  panel (search + click-to-open) and cross-browser IMPORT shipped.
  *2026-08-21:* recording Raha's OWN visits shipped — **on by default by the
  maintainer's explicit call** (it powers the omnibox suggestions, R-113;
  the original off-by-default text above is superseded). Local file only,
  Settings toggle, History panel clears it; reloads don't double-count;
  raha:// pages never recorded; writes batched (30s). Still open: the
  downloads page.
- **R-107 Multi-window.** Engine already single-window-agnostic in its tree;
  windows own active-tab + attached views. AC: two windows share one tree,
  governor counts across both.
- **R-118 Spellcheck without the network.** v0.1 ships `spellcheck: false`
  on tab views (`src/main/electron/views.js`) because Electron's default is
  `true` and Chromium then downloads Hunspell dictionaries from Google on
  Windows/Linux — app-initiated traffic that invariant #6 forbids. Options:
  bundle a dictionary, use the OS checker where it is free (macOS), or make it
  an opt-in setting that states the download plainly. AC: text fields spellcheck
  again with no request Raha did not disclose.
- **R-117 Gate `RAHA_NO_SANDBOX` on `!app.isPackaged`.** *Delivered
  2026-08-17.* Packaged builds log and ignore the env var; dev/CI (never
  packaged) unaffected. Not a privilege boundary — anyone who can set your
  environment already has code execution — but a shipped binary has no
  reason to honor it. Raised by the 2026-07 security audit's accepted-risk
  list.
- **R-108 Code signing** (auto-update itself: DONE). electron-updater fed by
  GitHub Releases shipped on 2026-07-23 (ADR-0008) with the check ON by
  default and a Settings toggle for full silence — note that is the opposite
  of this item's original "OFF by default" plan; the reasoning is in ADR-0008
  (an un-patchable browser is the bigger privacy hole). What remains is the
  part that needs a wallet: macOS notarization + Windows signing (certs are a
  human task), which also unlocks macOS auto-INSTALL — today macOS is
  notify-only because Squirrel.Mac refuses to install into an unsigned app.
  **macOS BUILD SIDE DONE (2026-09-01):** `hardenedRuntime` + entitlements
  (rendered from `build/entitlements.mac.plist.in` by
  `scripts/mac-entitlements.mjs`, electron-builder's `beforePack` hook) +
  `notarize` + a split mac/Windows build step + a codesign/stapler/spctl guard
  in `release.yml`. It is deliberately **inert without secrets**: a cert-less
  `npm run dist` still produces the same ad-hoc-signed, runnable app (verified
  on an Intel build). What is left is human: enrolment, the certificate, and
  the six secrets/variables listed in `docs/PLAYBOOKS/release.md`. Windows
  signing is still untouched.
- **R-119 Password manager: save prompts + autofill.** Offer to save
  credentials after a login-form submission (Save / Never for this site /
  Not now) and fill them on the next visit; a "Saved passwords" section in
  Settings to view/delete. Vault: per-origin entries in the profile dir,
  encrypted at rest with Electron `safeStorage` (macOS Keychain-backed —
  the existing "Raha Safe Storage" item); no sync (see rejected list: E2E
  or nothing). **Blocked on an ADR first**: autofill/capture needs a path
  into web pages, which invariant #5 (web content is bridgeless) forbids
  today. The ADR must choose between (a) a dedicated sandboxed
  isolated-world preload for tab views exposing NO bridge — only a narrow,
  main-validated credential channel — or (b) `webContents.executeJavaScript`
  fill-only (no capture). Fill rules: exact-origin match, `https:`
  (+ localhost) only, top frame only — never third-party iframes; plaintext
  never persisted unencrypted, never logged. Disambiguate the "passwords …
  are never read" import copy (`src/ui/render/history.js`,
  USER_GUIDE §"History import") when this lands. Future extension (out of
  scope for v1): import passwords from other browsers via the importers
  port. AC: ADR merged relaxing #5 (or choosing fill-only); save / never /
  fill each covered by a test; the vault file is unreadable without the OS
  keychain; Settings list + delete works; USER_GUIDE §5/§6 document where
  the vault lives and how it is encrypted.
- **R-120 Spatial tab canvas.** A freeform board view of a folder (or the
  whole tree): every tab is a draggable card — thumbnail + title — on a
  pannable, zoomable canvas, arranged the way you arrange panels in a wandb
  report or stickies on a whiteboard. Drag to position, lasso-select to move
  groups, drop cards onto each other to form a folder, double-click to
  open/wake. Positions persist (per-node `{x,y}` in state.json → schema bump
  + migration per change-persistence.md). Builds on the existing thumbnails
  and grid; lives entirely in the chrome (no page code — invariant #5
  untouched); sleeping tabs stay asleep while being arranged, so a 200-tab
  board costs nothing. Page CLIPS (R-121) render on the same canvas as
  first-class cards. AC: cards drag and their positions survive restart;
  lasso-move of N cards works; drop-to-group creates a real folder;
  double-click opens; ui-harness scenarios for drag/persist/group; smooth
  with 200 asleep tabs.
- **R-121 Page clips (static).** Clip a REGION of a page and keep it as a
  card: a chart from one site next to a table from another, composed on the
  R-120 canvas like panels in a wandb report. Deliberately STATIC v1 — a
  clip is a cropped screenshot (`webContents.capturePage(rect)`) plus
  `{sourceUrl, rect, capturedAt}`; the page itself stays asleep, so a board
  of 20 clips costs zero renderers (live/cropped-renderer clips are
  explicitly out of scope — they would recreate the tab-hoarding cost the
  governor exists to kill; revisit only post-R-120, and iframing pages into
  the chrome is rejected outright, invariant #5). Capture flow: page
  context menu → "Clip region…" → a chrome-owned transparent overlay view
  above the content view for rubber-band selection (overlay carries NO
  bridge and no page code runs; design the overlay view carefully — it is
  new window-layout surface). Clip PNGs live next to thumbnails in the
  profile (same unencrypted-screenshot accepted risk — extend SECURITY.md's
  known-risks note when this ships); metadata in state.json (schema bump +
  migration). Click a clip → open/wake its source tab (scroll-to-region
  later, once R-104's executeJavaScript machinery exists). Per-clip manual
  "Refresh": wake source (or reuse a running renderer), recapture same
  rect, update the PNG. A clip whose source tab was closed keeps working as
  a picture, marked "source closed", with the URL still openable. AC:
  clip via right-click + drag-select on a live page; card renders on the
  canvas and in its folder; click opens the source; refresh recaptures;
  clips + positions survive restart; closing the source tab degrades the
  clip gracefully; ui-harness scenarios for create/click/refresh/degrade.

- **R-122 Third-party privacy & data-security validation.** Priority order
  set by the maintainer: user DATA security, session/cookie security, and
  (once R-119 exists) password security come first; ad-block scoring is a
  side metric. All tools below are free.
  1. *Fix first, then measure:* set Electron's WebRTC IP-handling policy
     (`setWebRTCIPHandlingPolicy`) — today pages can likely enumerate local
     IPs; found while scoping this item. Small change + e2e.
     *Delivered 2026-08-17:* `default_public_interface_only` on every tab
     view + an e2e that gathers real ICE candidates and refuses raw private
     addresses. Honest measurement: Electron 43's Chromium already mDNS-hides
     host IPs by default, so the policy is belt-and-braces for the cases
     where mDNS quietly isn't (container networks; a page holding a
     getUserMedia grant, possible since R-103).
  2. *Data-at-rest audit (scripted, ours):* verify on-disk cookies are
     encrypted (Keychain/DPAPI/libsecret-backed), no plaintext secrets
     anywhere in the profile, and restate the documented thumbnail-
     screenshot risk. A repeatable script beats a one-off claim.
  3. *Session/TLS behavior:* badssl.com pass — every certificate failure
     must fail CLOSED with our in-place error, never load. Note what
     Chrome's Safe Browsing would additionally warn on
     (testsafebrowsing.appspot.com) — documented accepted gap.
  4. *Privacy suites:* EFF Cover Your Tracks, privacytests.org checklist,
     BrowserLeaks (WebRTC/DNS/canvas). Expect: strong tracking protection,
     weak fingerprinting until R-114 completes — report it honestly.
  5. Publish `docs/PRIVACY-SCORECARD.md`: dated results, what we pass,
     what we don't yet, linked to the R-items that close each gap. Never
     overclaim (invariant-#6 ethos). Re-run each release.
  When R-119's password vault lands, it gets its own validation section
  (vault unreadable without OS keychain, no plaintext ever on disk).
  AC: WebRTC policy set + tested; scorecard committed with reproducible
  steps; every "we don't do X yet" links a roadmap item.

- **R-126 App links (external protocol handoff).** *Delivered 2026-08-22*
  (ADR-0011). A clicked `zoommtg:`/`msteams:`/`mailto:`/`tel:` link used to
  dead-end in "blocked" with no way to say yes. Now: dangerous
  launcher-abuse schemes (`file:`, `ms-msdt:`, `search-ms:`…) are refused
  outright and never offered; everything else asks in-app with the full URL
  shown, Open / Cancel, and a per-scheme "always allow"
  (`allowedExternalSchemes`, revocable in Settings). The engine holds the
  pending URL — the UI can only confirm, never name one — and the single
  OS sink re-checks the deny-list. Both `window.open` and clicked-link
  navigation route through the same gate.

## v0.3 — power and polish

- **R-109 Rules UI v2.** Per-rule priority drag, test-a-URL box, import/export
  rules as JSON.
- **R-110 Virtualized sidebar/grid** for 1000+ tabs.
- **R-111 Command palette** (Ctrl+K): fuzzy jump to tab/folder, actions.
- **R-112 Session snapshots.** Named saves of the whole tree ("Monday
  research"), restorable; export/import JSON.
- **R-113 Tab search across titles/urls** in the omnibox dropdown (local only).
  *Delivered 2026-08-21* as part of omnibox suggestions: typing surfaces
  matching OPEN tabs ("switch to tab" — activates, never duplicates) plus
  visited URLs from the local store, ranked by visit count then recency.
  Strictly local — no suggest API, no network, ever. Dropdown hangs over the
  page via the chrome-raise mechanism; match counts patch the DOM in place
  (the find-bar IME lesson).
- **R-114 Fingerprinting reduction.** Survey what Electron exposes; document
  honestly what we can/can't do; implement UA reduction + canvas prompt if
  feasible. Must not overclaim. *Partially delivered 2026-08-15:* both
  sessions present a standard reduced Chrome UA (no Raha/Electron tokens —
  `standardUserAgent()` in privacy.js) after Cloudflare bot-challenged the
  Electron UA into blank web apps. *2026-08-22:* UA-CH brand headers gained the
  "Google Chrome" brand — a partial fix, superseded. *2026-08-26
  (ADR-0012):* one consistent Chrome identity at three layers — a
  DevTools-protocol override per tab (`src/main/electron/chrome-identity.js`:
  the in-page `navigator.userAgentData` view, renderer subresource headers,
  and cross-origin iframes, which had exposed the raw Electron UA in JS and
  on the wire), header synthesis for the navigations Electron never
  decorates (worker and WebSocket requests stay bare, as Chrome's are), and
  Accept-CH emulation for the high-entropy hints, delivered first-party
  only (`src/shared/client-hints.js`, privacy.js). Pinned by e2e tests
  against the real wire; the live challenge pass (openreview.net, Cloudflare)
  succeeded unattended on 2026-08-26 and is repeated per release (playbook 1d). Known divergences, documented not hidden
  (ADR-0012 lists each): `window.chrome` is an empty object (real Chrome's
  has keys); an undecided permission reads "denied" to a check where Chrome
  says "prompt" (R-103's honest limit, ADR-0013); no Critical-CH restart;
  synthesized header order; the bundled Chromium patch level. Still open:
  the survey, canvas/audio surfaces.
- **R-115 Reader mode** (local Readability build, no network).
- **R-116 Import from Chrome/Firefox** (bookmarks HTML → folders).
  *History* import shipped 2026-07-29 (src/main/electron/import-history.js);
  this item now covers bookmarks only.

## Explicitly rejected (see ADRs)

- Building/forking a rendering engine (ADR-0001).
- Chrome extension support — enormous surface; revisit only post-1.0 with a
  dedicated ADR (`electron-chrome-extensions` exists but drags in a huge
  maintenance area).
- Any cloud sync in plaintext. Sync, if ever, is E2E-encrypted or nothing.
- Telemetry of any kind, including "anonymous usage stats" (invariant #6).
