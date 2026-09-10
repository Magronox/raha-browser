# Changelog

All notable changes to Raha. Format: [Keep a Changelog](https://keepachangelog.com);
versions are tags `vX.Y.Z` (tag == package.json version, enforced by CI).

## v0.1.0 — unreleased (date set at tagging; release playbook step 2)

First release, on Electron 44.2.0 / Chromium 152.0.7977.76. The thesis,
working end to end:

### Changed
- **Electron 43.4.0 → 44.2.0** (Chromium 150.0.7871.224 → 152.0.7977.76,
  Node 24.18.1 → 24.20.0). 152.0.7977.76 is a build Google shipped as
  Chrome stable, so the full-version client hint matches a real Chrome.
  Consequences from upstream: **macOS 13 (Ventura) or later** is now
  required, and 32-bit Windows/ARM Linux builds are no longer possible
  (Raha never shipped them). The Chrome-identity brand tables were
  re-checked against the Chromium 152 source and are unchanged; the brand
  order rotates with the major, as in Chrome.

### Fixed
- **Typing an address no longer opens a surprise tab**: on the grid (after
  ⌘T, closing a tab, or clicking a folder) Enter silently created the tab in
  whatever folder the sidebar had selected — often an imported "Window 3".
  It now opens in the current tab, and the dropdown says what will happen
  before you press Enter: *Open here*, *Switch to open tab* when another tab
  already has that page, and *Open in new tab → folder* (⌘/Ctrl+Enter),
  which names the folder the tab will land in — beside the tab you're on,
  or the folder you're viewing on the grid.
- **"Verify you are human" checks: Raha now presents one consistent Chrome
  identity.** Cloudflare-style challenges looped forever. What was measured:
  Raha's three views of itself disagreed — exactly what such checks score —
  and the earlier header-only alignment (2026-08-22) was not enough: it
  added the "Google Chrome" brand to headers Chromium already sent, while
  navigations still carried no client hints at all, page JavaScript still
  reported Chromium-only brands, and cross-origin iframes — where the
  challenge widget itself lives — exposed the raw Electron user agent. What
  ships now agrees at three layers: a DevTools-protocol identity per tab
  (the in-page view, the page's own requests, its workers, and every
  cross-origin iframe), header synthesis for navigations (the one request
  kind Electron leaves bare and Chrome decorates), and Accept-CH emulation
  for the high-entropy hints sites ask for — delivered only where Chrome
  would deliver them (first-party; never to a cross-origin frame or a
  third-party fetch) and forgotten with the site's data (ADR-0012).
  Verified by automated header-and-JavaScript tests against the real wire,
  including a side-by-side comparison with Chrome 150 (WebSocket and worker
  requests carry no hints in either). This removes the identity mismatches
  we measured — and, verified live on 2026-08-26 from a fresh profile with
  no automation, openreview.net's Cloudflare challenge passed on its own and
  landed on the paper; the release playbook (step 1d) repeats that check
  before every tag rather than trusting this sentence. Known divergences
  from Chrome remain, listed in ADR-0012 rather than hidden: `window.chrome`
  is an empty object; an undecided permission reads "denied" to a check
  where Chrome says "prompt" (ADR-0013); no Critical-CH restart (the first visit to an origin lacks
  the high-entropy hints Chrome would re-request the page with); synthesized
  navigation hints sit after Accept-Language where Chrome puts them first;
  and the bundled Chromium patch level need not be one Chrome ever shipped.
  If a site still challenges you, see USER_GUIDE.
- **New tabs now open in the folder you're viewing**: typing an address from
  a folder's grid (or after "New tab here") used to create the tab at the
  top level, outside the folder — navigating inside folders scattered tabs
  everywhere. The omnibox now reports the viewed folder and the tab lands
  in it.
- **Drag-to-reorder tabs actually works**: reordering was implemented but
  the sidebar rebuilt itself every ~2.5s, killing any drag in progress.
  Renders are now suspended during a drag (and skipped entirely when
  nothing changed), so hold-and-move reordering behaves; drop on a row's
  upper half to insert before it, lower half to insert after.
- **Grid/sidebar shimmer ("tabs hovered one by one")**: every governor tick
  rebuilt the grid and sidebar DOM, recreating every thumbnail and favicon
  image — cards without a thumbnail (imported tabs that never woke) flashed
  their fallback in a staggered wave, and dead favicons were re-fetched
  from the network every ~2.5s. Unchanged content now keeps its DOM;
  regions only rebuild when something they show actually changed.
- **Modals opened invisibly behind the page**: the web page is a native view
  layered above the chrome, so History/Settings/Organize and the runaway and
  memory-limit prompts rendered BEHIND an active tab — clicking the clock
  "did nothing" unless you were on the grid. The chrome is now raised above
  the page while any overlay is open, and toasts moved over the sidebar so
  they are visible while browsing.
- **Sidebar/settings/history jumped to the top while scrolling**: every
  governor tick re-renders the UI, which reset scroll positions (~every
  2.5s). Scroll is now preserved across re-renders, like focus already was.
- **Back-button trap on dead history entries**: a failed page load used to
  navigate to an internal error page, pushing a history entry — so pressing
  Back onto an entry that can no longer load (e.g. a blob: page after the
  tab slept, or an offline site) bounced between it and the error page
  forever. Load failures now render their error in place, keeping the
  entry and its position, so Back walks past them like any browser.
  (Found by the automated security suite below.)

### Added
- **Sites now ask before using your camera, microphone, location,
  notifications, or clipboard** (ADR-0013). Where Raha used to refuse
  everything with a toast — so video calls in the browser simply could not
  work — it now shows its own prompt naming the site and the need
  ("meet.example wants to use your camera and microphone"), with *Allow
  once*, *Always allow*, *Never for this site*, and *Not now*. Nothing is
  granted silently, and you never see a prompt for a page you can't see: a
  background tab's request waits until you switch to it. *Always* and
  *Never* are remembered per site and listed under Settings → *Site
  permissions*, where one click makes Raha ask again; *Allow once* lasts
  until you leave the page. Screen sharing is still refused (R-103b).
  Honest limit: a site you have never decided on reads "denied" to a mere
  check (`navigator.permissions.query`, `Notification.permission`) where
  Chrome would say "prompt" — Electron offers no third answer — and is
  asked the moment it actually requests.
- **App links ask instead of dead-ending** (ADR-0011): clicking a link to
  Zoom, Teams, Slack, `mailto:`, `tel:`… now opens an in-app prompt naming
  the app and showing the full address, with Open / Cancel and an optional
  "always allow" for that kind of link (revocable in Settings). The OS is
  never touched without your yes. Dangerous schemes — `file:`,
  `javascript:`, the Windows protocol handlers with RCE history — are still
  refused outright and never offered.
- **Address-bar suggestions, strictly local**: start typing and Raha offers
  your open tabs ("switch to tab" — jumps there instead of duplicating) and
  pages you've visited, ranked by how often and how recently. Arrows to
  move, Enter to go, Tab to fill, Esc to dismiss. Unlike every mainstream
  browser, keystrokes are matched against a local file — never sent to a
  "suggest" service. Raha now remembers its own visits to power this
  (on by default; a file on this computer only; Settings toggle to stop,
  History panel clears it; raha:// pages are never recorded).
- **Find in page** (`Ctrl/⌘+F`): a find bar in the toolbar with a live match
  count ("2/9"), Enter/Shift+Enter for next/previous, Esc to clear the
  highlights. The bar closes itself when you switch tabs or navigate — the
  count never describes a page you didn't search.
- **Reopen closed tab** (`Ctrl/⌘+Shift+T`): restores the last-closed tab —
  address, title, folder, and position — up to 20 back, including tabs lost
  by deleting a folder. Plus a shortcut wave: History on `⌘Y` (`Ctrl+H`),
  `Ctrl/⌘+1…9` jumps to your Nth running tab (9 = last), `⌘W` on the grid
  returns to your last tab instead of doing nothing, `⌘[`/`⌘]` go
  back/forward on macOS, and the Window menu (`⌘M`) exists now.
- **Tabs drag out of folders, everywhere**: grid cards are draggable; drop a
  tab on a folder card or sidebar row to file it, on a breadcrumb to move it
  up, or on the grid background to move it into the folder you're viewing.
  (Dropping on the grid used to look allowed and silently do nothing.)
- **Settings → About**: shows the app version at last (bug reports, welcome),
  with GitHub / report-a-bug / support links that open as ordinary tabs.
- **A home on the web + a way to donate**: the website
  (https://magronox.github.io/raha-browser/ — static, no cookies, no
  analytics, no third-party requests, enforced by a deploy-time check) and
  quiet support links in About and the welcome tour. Donations fund exactly
  one thing: code-signing certificates, so installs stop warning.
- **Clear cookies & site data**: right-click any page → "Clear Cookies &
  Data for This Site" (cookies, subdomains, partitioned third-party jar,
  storage — then reloads), and Settings → "Clear all cookies & site data…"
  with confirmation. The un-wedge for bot-check loops, consent walls, and
  corrupted sessions.
- **Default-browser support**: on first launch Raha asks once, IN the app,
  whether to become your default browser — only a yes there registers with
  the OS (macOS then shows its own confirmation; the OS is never touched
  without consent). Also a button in Settings, and links clicked in other
  apps open as Raha tabs — through the same URL scheme gate as everything
  else.
- **Standard Chrome user agent** (partial R-114): pages now see a normal
  Chrome UA instead of one carrying `Raha/…` and `Electron/…` tokens. Those
  tokens got Raha bot-challenged by CDN edges (blank web apps), rejected by
  login gates ("this browser may not be secure"), and made Raha users
  uniquely fingerprintable. No Raha-identifying token remains in requests.
- **Hard Reload** (`Ctrl/⌘+Shift+R`, View menu): reload ignoring the HTTP
  cache — the rescue for a web app stuck on a stale cached frontend.
- **Sidebar toggle** (`Ctrl/⌘+Shift+B`, or the panel button in the toolbar): hide
  the sidebar and the page takes over its space, like Preview or other
  browsers; toggle back any time. Session-only (reopens visible).
- **Open tabs & windows import**: copy another browser's current windows
  into Raha — one folder per import, a subfolder per window, every tab
  arriving asleep (title + address only; nothing loads until clicked).
  Running browsers are asked directly over Apple events (Safari + the
  Chromium family; one-time macOS Automation prompt, never Full Disk
  Access); Firefox and Zen are read from their session file on any OS,
  running or not.
- **History import from a file**: the History panel's "From a file…" picker
  accepts a copied Safari `History.db`, Chrome `History`, or Firefox
  `places.sqlite` — the no-Full-Disk-Access route for Safari (copy the file
  in Finder, import the copy). The Safari permission error now explains
  exactly that, step by step.
- **Real filter-list blocking** (R-102, ADR-0009): EasyList (ads) +
  EasyPrivacy (trackers) via Ghostery's open-source engine, compiled and
  **bundled at build time** — Raha never downloads lists at runtime.
  Separate "Block ads" / "Block trackers" toggles in Settings (your old
  Block-trackers choice carries over to both), and the address-bar shield
  is now a button: click it to turn blocking off (or on) for just that
  site — the tab reloads so the change is immediate. Network-level only:
  no cosmetic filtering, so a blocked ad can leave an empty box; websocket
  requests are now blockable too.
- **History import**: bring browsing history over from Chrome-, Firefox- and
  Safari-family browsers (Chrome, Chromium, Edge, Brave, Vivaldi, Opera,
  Opera GX, Arc, Firefox, Zen, Safari — exact list varies by OS; Arc and
  Safari are macOS-only), every detected profile listed separately.
  History only, never passwords/cookies; the source browser's files are read
  from a temporary copy and never touched. Searchable History panel
  (toolbar clock); entries open as tabs. Zero new dependencies (`node:sqlite`).
- **Tab organizer**: the sidebar sparkle button plans folders for loose tabs
  (site categories + shared-domain grouping), previews the plan, and applies
  it without waking anything or touching folders you made.
- **Runaway-tab guard**: sustained CPU (~10s at ≥200%) or a ≥2 GB working
  set prompts to terminate the tab (sleep = the process dies now, the page
  and history survive). Snooze per tab; audible tabs exempt from the CPU
  check while audio protection is on; off-switch in Settings.
- **Right-click menus**: in pages (open/copy link, image actions, copy +
  search selection, back/forward/reload, edit roles in fields) and on chrome
  text fields (the omnibox finally pastes). Gated-scheme links are never
  offered for opening; all opens pass the same sink gate as `window.open`.
- **The resource governor**: max-live-tabs cap with LRU eviction; per-tab
  memory limits (enforced even on pinned tabs); optional global memory
  budget; optional idle sleep; audio-playing tabs protected; the active tab
  never auto-slept. Pure, unit-tested policy core.
- **Real tab sleep**: renderer process destroyed (RAM returned to the OS),
  with URL, title, navigation history (restored on wake), thumbnail, and
  per-tab settings preserved. Cold start restores the whole workspace asleep.
- **Programmable rules**: domain patterns (`site.com`, `*.site.com`) granting
  keep-alive and/or memory limits; first match wins; editable in Settings.
- **Live bar**: always-visible strip of running tabs with per-tab memory
  (MB) and CPU sampled from the OS; shared-process marker; one-click sleep.
- **Organization**: infinitely nestable folders, drag & drop, thumbnail
  grid as the new-tab page, per-folder "sleep all", breadcrumbs, inline
  rename, context menus.
- **Privacy layer**: zero telemetry; ad/tracker blocking (see the
  filter-list entry above; per-tab blocked counter); Global Privacy Control + DNT
  headers; per-site permission asks (see the entry above; everything else
  a page asks for is refused, with a toast once per tab);
  HTTPS-first with explicit insecure fallback; DuckDuckGo default search;
  fully local new-tab page.
- **Keyboard-first**: full shortcut set via native menu (see README).
- Crash-safe persistence: atomic writes, versioned schema with migrations,
  tree repair that salvages tabs from corrupt state files.
- **First-run experience**: a built-in one-minute tour (`raha://welcome`)
  opens on first launch, plus a "Try these" folder of asleep example tabs
  demonstrating wake-on-click; platform-aware shortcut labels (⌘ on macOS);
  full User Guide in `docs/USER_GUIDE.md`.
- Test suite (final v0.1.0 counts: 220 unit tests over the pure core + engine
  on fake ports, a 37-scenario UI harness in real Chromium incl. the XSS
  canary, 35 Playwright e2e tests on real Electron — including the automated
  security-QA suite that machine-enforces every check from the 2026-07 audit
  page on every push — and the in-app smoke self-test); CI + tag-driven
  release pipeline (Linux AppImage/deb, Windows nsis, macOS dmg/zip).

### Security hardening (2026-08, pre-release)
- **WebRTC can't hand pages your local IPs**: tab renderers use the
  public-interface-only IP handling policy, closing the gap where Chromium's
  own mDNS hiding quietly doesn't apply (mDNS-less networks, future
  camera/microphone grants). An e2e test gathers real ICE candidates and
  refuses raw private addresses.
- **Packaged builds always keep the Chromium sandbox on**: the dev/CI
  `RAHA_NO_SANDBOX` escape hatch is logged and ignored in shipped binaries
  (R-117, from the audit's accepted-risk list).

### Security hardening (2026-07-23, pre-release)
- **Automatic security updates** (ADR-0008): checks GitHub Releases every
  4 hours and installs on quit (Windows/Linux; macOS notifies until signing
  lands, R-108). On by default; Settings → Privacy toggles it off for full
  network silence. First and only runtime dependency (electron-updater,
  pinned). Invariant #6 reworded accordingly.
- **Electron fuses burned in shipped binaries**: ELECTRON_RUN_AS_NODE,
  NODE_OPTIONS and node-inspector are dead (no more repurposing the binary
  as a Node runtime), cookies encrypted at rest, app code loads only from
  the integrity-checked asar. A release-workflow guard attacks the packaged
  binary and fails the build if the fuses stop holding.

### Engine (as shipped)
- **Chromium 150.0.7871.129** via Electron 43.2.0 (Node 24.18.0). That bump
  rolled Chromium forward two stable releases at once (from .114), carrying
  **22 CVE fixes** including criticals in Network, GPU, CameraCapture and
  several use-after-frees reachable from any page. Verified against the
  shipped binary: `process.versions.chrome`.

### Security audit (2026-07-26, pre-release)
Full pass over the trust boundary against Electron's official security
checklist, plus an adversarial review of IPC, navigation, the `raha://`
handler, downloads and privacy. Eight findings, all fixed before launch;
report with method and accepted risks in `docs/SECURITY-AUDIT-2026-07.md`.
- **Only `http:`/`https:`/`raha:`/`blob:` may load in a tab.** A page's
  `window.open()` previously reached the loader unchecked — and because the
  main process performs that load, Chromium's renderer-initiated navigation
  blocks do not apply. `file:///…`, `javascript:`, `data:`, `chrome://` and
  `view-source:` all got through, letting a hostile page display local files
  or dress a `data:` page in Raha's real chrome. Now gated at every sink,
  including URLs restored from `state.json`. Restored history is *filtered*
  rather than refused wholesale, so an `about:blank` or `blob:` entry never
  costs you your back/forward stack. (New invariant #13.)
- **The chrome view is pinned to its own page**: it may not navigate
  (`will-navigate`/`will-redirect`) or open windows, and unclaimed drops are
  swallowed — a dropped file would otherwise navigate the one view that holds
  the IPC bridge. Main additionally verifies the sender frame of every IPC
  message.
- **Web content is no longer served Raha's own chrome** (`raha://app/*`) — it
  could be rendered inside a page to fake the sidebar, omnibox and padlock.
- **Permission *checks* are now denied too**, not just permission requests;
  the check path had been falling through to Electron's more permissive
  default, contradicting what the UI told the user.
- The preload's channel allow-list, previously documented but never
  implemented, is now real (passed down from the contract via
  `additionalArguments`).
- The chrome's CSP no longer carries the `http://127.0.0.1:*` allowance that
  existed only for the test harness; the error page never puts a non-web URL
  in a link.
- Accepted-risk list published in `SECURITY.md`: no Safe Browsing, thumbnails
  are unencrypted screenshots on disk, unsigned builds.

### Fixed (pre-release hardening, 2026-07-19/20)
- Blank window on launch: the raha:// protocol did not serve the UI's
  `src/shared` ES-module imports; the whole module graph failed silently.
- CSP-blocked inline styles: sidebar tree indentation rendered flat and the
  context menu ignored its position; both now applied via CSSOM.
- Typing wiped/defocused by governor-tick re-renders in the omnibox, folder
  rename (which also half-committed early), settings rule input, and the
  memory-limit prompt; focused-field text/focus/caret now survive re-renders.
- `npm start`/`npm run smoke` survive `ELECTRON_RUN_AS_NODE=1` inherited from
  VSCode/agent shells (scripts/launch.mjs), default a smoke profile dir, and
  translate `RAHA_NO_SANDBOX=1` into the `--no-sandbox` flag early enough for
  Linux. Full typecheck/lint made green; e2e suite made real (loopback pages,
  true user paths) and green on CI; README screenshots opt-in (RAHA_SHOTS=1).
- Test suite grew steadily through hardening; final v0.1.0 counts are listed
  under Added above.

### Known limitations
- No cosmetic ad filtering (empty boxes where ads were; needs a page
  preload, invariant #5), no screen sharing yet (R-103b),
  scroll position not restored on wake (R-104), single window (R-107),
  macOS unsigned (R-108). Numbers reference docs/ROADMAP.md.
