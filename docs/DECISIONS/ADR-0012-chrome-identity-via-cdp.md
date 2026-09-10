# ADR-0012: One Chrome identity per tab, via the DevTools protocol

Date: 2026-08-26 · Status: accepted

## Decision

Every tab presents one consistent Google Chrome identity — UA string,
`Sec-CH-UA` request headers, and the in-page `navigator.userAgentData`
view — in every frame, including cross-origin iframes. Three layers, one
source of truth (`chromeIdentity()` in `src/main/electron/privacy.js`, the
hints computed by `src/shared/client-hints.js`):

1. **CDP identity** (`src/main/electron/chrome-identity.js`). views.js
   attaches Electron's `webContents.debugger` to each tab view the moment
   it is constructed and sends `Emulation.setUserAgentOverride` with
   Chrome's `userAgentMetadata`; `Target.setAutoAttach` (flatten,
   wait-for-debugger) delivers every out-of-process iframe as a paused
   child session, which gets the same override and is then resumed. This
   is what fixes the JS view, the renderer's own subresource headers, and
   dedicated workers (auto-attached and only resumed; measured to inherit
   the frame's override in this configuration). The session stays
   attached for the tab's lifetime (detaching reverts everything).
   `Runtime.enable` is never sent — anti-bot scripts detect its side
   effects — and a paused child target is resumed no matter what else
   fails.
2. **Header synthesis** (`privacy.js`, the web session's one
   `onBeforeSendHeaders`). The Chrome UA is forced on every request; any
   brand header the renderer did send is recomputed from the same source
   as layer 1 (so Chromium's brand order, which differs from Chrome's for
   most majors, never leaks from a renderer without the override); and the
   three low-entropy hints (`Sec-CH-UA`, `-Mobile`, `-Platform`) are added
   to navigations, which Electron never decorates and Chrome always does.
   Sent only where Chrome would: secure origins and loopback — and never
   on WebSocket handshakes or worker requests, which real Chrome 150
   leaves bare (measured side by side).
3. **Accept-CH emulation** (`privacy.js` `onHeadersReceived` +
   `AcceptChCache` + `planClientHints`). Electron ignores
   `Accept-CH`/`Critical-CH`; Raha remembers, per origin, which
   high-entropy hints a top-level document asked for and adds exactly
   those where Chrome's default `self` permissions policy would deliver
   them: that origin's own navigations, and same-origin subresources of
   its same-origin frames — never to a cross-origin iframe, never on a
   third-party fetch (decided from the requesting frame, not the tab).
   The memory is cleared with the site's data (`forgetAcceptCh`).

## Context

"Verify you are human" challenges (Cloudflare Turnstile and its kin) never
passed in Raha. They cross-check three views of the browser against each
other, across frames. Measured on Electron 43.4.0 / Chromium 150, each
view was wrong in its own way: the brand list said Chromium-only while the
UA said Chrome; navigation requests carried no client hints at all where
Chrome sends three on every navigation and frame request to a secure or
loopback destination; and cross-origin iframes — exactly
where the Turnstile widget renders — ignored the session UA entirely,
reporting and sending the raw `… Electron/43.4.0 …` string. An earlier
change (2026-08-22) only appended the "Google Chrome" brand to headers
that already existed, which left the other two gaps open; this ADR
replaces that partial fix.

Alternatives rejected:

- **A preload script in web content** to patch `navigator`. Invariant #5
  (web content is bridgeless) exists so that a compromised page finds
  nothing to escalate through; a preload — even a tiny one — is a foothold,
  and JS-level patches are themselves a fingerprint. The CDP override
  achieves the same end from the main process with nothing exposed.
- **Upstream Electron branding** (an API to set the brand list, or a
  browser-side client-hints delegate). Not available at this Electron
  version; if it lands, layers 1 and 3 shrink to a call each.
- **Leaving it.** A browser that cannot pass a routine bot check is not a
  daily driver, and the "use another browser for this site" workaround is
  the opposite of the project's goal.

## Consequences

- **One CDP client per tab.** Electron's `webContents.debugger` is a single
  session per WebContents, and it is now taken. Anything else needing the
  protocol on a tab — the planned tab freeze, for one — must reuse the
  handle views.js exposes as `cdp()`, never attach again.
- **Residual tells remain, documented not hidden:** `window.chrome` is an
  empty object in Electron (real Chrome's has keys), and a permission the
  user has not decided on reads "denied" to a mere check
  (`Notification.permission`, `navigator.permissions.query`) where Chrome
  says "prompt" — Electron's check handler has no third answer (R-103,
  ADR-0013); the site is asked on its first real request. `navigator.webdriver`
  stays false — Electron's debugger sets no automation flag.
- **Playwright coexists.** The e2e suite drives Electron through its own
  CDP connection; both clients auto-attach to child targets and each
  resumes the ones it paused. Playwright forces `navigator.webdriver` to
  true in pages it drives, so that value is not asserted in tests.
- **Failure is graceful.** Attach failure degrades to a no-op handle;
  layer 2 still keeps the wire clean. Child-session commands have a
  deadline (a paused frame must never wait on us); the root session's do
  not, because their reply legitimately waits for the first navigation to
  commit. Errors log once per tab per failure class. A renderer crash
  closes the WebContents at once (views.js), which ends the session
  deterministically. Browsing never depends on the protocol.
- **Chrome fidelity is now a maintenance duty.** The brand tables,
  platform-version mapping and the set of high-entropy hints in
  `client-hints.js` are pinned to Chromium 150, and the request kinds that
  carry hints were measured against Chrome 150; an Electron upgrade must
  re-verify them (upgrade playbook step 6).
- **The release playbook gains a live bot-check pass** before tagging: no
  claim that challenges pass is made without one. As of this ADR that
  pass was run on 2026-08-26 (from source, fresh profile, no automation):
  openreview.net's Cloudflare challenge passed unattended and landed on the
  paper. That is one site on one day — the automated suite proves agreement
  on the wire; release playbook step 1d repeats the live check before every
  tag.

### Known divergences from Chrome, and what is not verified

Each was measured or read from the code on 2026-08-26; none is hidden
behind "every tell we can measure":

1. **No Critical-CH restart.** Chrome re-issues a navigation once when the
   response declares critical hints the request lacked, so the document it
   renders was requested with them (measured: two `/page1` requests). Raha
   only remembers (`privacy.js` `onHeadersReceived`), so first contact with
   such an origin — the challenge page itself, on a fresh profile — is
   served from a request without the high-entropy hints; the next
   navigation carries them. Pinned by the e2e "first contact" assertion.
2. **Header order.** Electron's `webRequest` appends the synthesized hints,
   so a navigation's `sec-ch-ua*` land after `Accept-Language`; Chrome puts
   them before `Upgrade-Insecure-Requests`. Only an upstream client-hints
   delegate can fix this; header order is a known bot-management signal.
3. **Chromium patch level.** Electron's bundled Chromium
   (`process.versions.chrome`, `150.0.7871.224` at this tag) need not be a
   version Google shipped as a Chrome stable (the installed Chrome was
   `.187`); it goes out verbatim in `Sec-CH-UA-Full-Version(-List)` and
   `uaFullVersion`. Not fixable by honesty; checked at each upgrade.
4. **Accept-CH memory.** Unions where Chrome replaces; gone on quit where
   Chrome persists it (`AcceptChCache` states both). Cleared with site
   data like Chrome's.
5. **Permissions-policy approximation.** Chrome delegates high-entropy
   hints per feature through `Permissions-Policy`; Raha approximates the
   default `self` allowlist by origin equality with the top document
   (`planClientHints`). A page that explicitly delegates
   `ch-ua-*` to a third party gets less than Chrome would send; a
   same-origin frame nested in a cross-origin one gets more.
6. **An early detach is permanent for the tab.** Any `detach` reason other
   than `target closed` reverts the JS view and nothing re-attaches until
   the tab sleeps and wakes (a fresh view attaches afresh); the wire stays
   Chrome-branded through layer 2. Logged once.
7. **Unmeasured surfaces.** Service and shared workers are auto-attached
   and only resumed; their JS-side UA/brands were not measured (dedicated
   workers were, and are pinned by e2e). `window.chrome` is an empty object
   and an undecided permission reads "denied" where Chrome reads "prompt"
   (`Notification.permission`; R-103 / ADR-0013 explain why), both
   measurable from any page.
