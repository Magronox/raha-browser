# Security audit — v0.1.0 pre-launch (2026-07-26)

> Commit hashes in this document are from the audit-time working tree and
> predate the published history; each fix is also identified by file and
> test, which is how to locate it.

Scope: the whole trust boundary of Raha at commit `3a29c08`, audited against
[Electron's official security checklist][checklist] plus an adversarial pass
over IPC, navigation, the `raha://` protocol handler, downloads, and privacy
behavior. Every finding below was fixed before launch; each fix names the
commit that carries it.

This document exists so the next audit starts from what was already looked at,
and so the accepted risks at the bottom are a deliberate list rather than an
oversight.

[checklist]: https://www.electronjs.org/docs/latest/tutorial/security

## What passed

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` on
  **both** the chrome view and every content view.
- No `<webview>` tag anywhere; `webSecurity` never disabled; no experimental
  features; no `enableBlinkFeatures`.
- CSP present on all four local pages.
- Path traversal correctly refused in both `safeJoin()` (protocol) and
  `thumbPath()` (thumbnails).
- Settings validation clamps every number, drops malformed rules, and never
  throws.
- The blocklist is scheme-aware and first-party-aware.
- Electron fuses burned in shipped binaries, with a release-workflow guard
  that attacks the packaged artifact.
- **`shell.openExternal` does not appear in the codebase.** The single most
  common source of Electron RCE is absent by construction.
  *Amended 2026-08-22: no longer true. App links (`zoommtg:`, `mailto:`…)
  now reach `shell.openExternal` through a single consent-gated sink —
  deny-listed schemes refused, engine-held URL bound to the ask by a nonce,
  explicit in-app consent required (per-scheme "always allow" is revocable
  and rate-limited) — see `docs/DECISIONS/ADR-0011-app-links.md`. The next
  audit must probe this path.*
- No `certificate-error` override, so Electron's secure default (reject
  invalid certificates) applies.

## Findings

Severity is about this app's actual threat model — a browser whose content
views hold no bridge — not a generic CVSS score.

### P1 — `window.open` handed any scheme to `loadURL` · fixed in `a097fe3`

Tab URLs arrive from three places and only one was sanitized. The omnibox
routes `file:`/`javascript:`/`data:` to a web search, but a page calling
`window.open()` reached `setWindowOpenHandler` → engine → `view.loadURL()`
with no check at all. That path is not subject to Chromium's
renderer-initiated navigation blocks, because the **main** process performs
the load.

Verified against the real engine on fake ports: `file:///etc/passwd`,
`javascript:…`, `data:text/html,…`, `chrome://settings` and `view-source:`
all reached `loadURL()`.

Impact: local-file display and convincing phishing — a `data:` page renders
inside Raha's real chrome — rather than direct exfiltration, since the popup
is denied a window handle and file→file reads are blocked by default.

Fix: `isNavigableUrl()` (http/https/raha/blob) gated at every sink —
`tabCreate` (covers both `window.open` and the UI's own `tab:create`), `wake`
(node URLs come back from `state.json`, a plain file on disk), and
`restoreHistory` (so does `navJson`).

**Correction (same day).** The first cut of this fix was too narrow and broke
two real things — see "Regressions this audit introduced" below. `blob:` is in
the allow-list because it is origin-bound, cannot name a file on disk, and is
how sites open a generated PDF in a new tab.

### P2 — no navigation guard on the chrome view · fixed in `b28acfb`

Checklist items 13 and 14. The chrome view is the only view carrying the
preload bridge, and nothing stopped it navigating off `raha://app/index.html`;
it had no window-open handler either. Any origin it reached would inherit
`window.raha` and with it every IPC channel.

The plausible trigger is mundane: Chromium's default for an unhandled file
drop is to navigate the frame to that file, and `src/ui/dnd.js` only calls
`preventDefault` for internal row drags. *(The guard's absence was verified;
the drop path itself was not reproduced — synthetic drop events are untrusted
and cannot trigger it. It needs a real drag onto a running app.)*

Fix: `will-navigate` + `will-redirect` cancel anything that is not the chrome
page, `setWindowOpenHandler` denies, and the UI swallows unclaimed drops.

### P3 — the chrome was served to web content · fixed in `225d523`

The `raha://` handler is installed on the web-content session so tabs can show
`raha://home`, `raha://welcome` and `raha://error` — but it was one function
serving every host, so `persist:main` was also served `raha://app/*`: the
entire UI plus `src/shared`.

No escalation (content views have no preload, and the source is public), but
it let a page render Raha's real chrome inside itself: fake sidebar, fake
omnibox, fake padlock.

Fix: `allowChrome` alongside `allowThumbs`; the web session gets neither.

### P4 — IPC handlers did not validate the sender · fixed in `0b0d7a1`

Checklist item 17. Every `ipcMain.handle` callback ignored its `event`. Safe
*today* only because the chrome view is the sole view with a preload — an
argument about the rest of the codebase rather than a check. This is the
mitigation that contains P2 if the navigation guards ever fail.

Fix: handlers require `event.senderFrame` to be the chrome view's main frame
**and** that frame to still be on the chrome URL, so a frame that navigated
away loses access even if object identity survives.

### P5 — permission *check* handler missing · fixed in `7992601`

Checklist item 4. Electron's own docs for `setPermissionRequestHandler` say
it: *"you must also implement `setPermissionCheckHandler` to get complete
permission handling. Most web APIs do a permission check and then make a
permission request if the check is denied."*

Raha had only the request half, so the synchronous check path
(`navigator.permissions.query`, media device enumeration) fell through to
Electron's default — more permissive than the policy shown to the user.

### P6 — untrusted URL in the error page's href · fixed in `5b33e7c`

`raha://error` put the failed URL into the retry link's `href` unchecked, and
that page's CSP allows inline script, which also permits `javascript:` hrefs.
No case was found where Electron reports such a URL in `did-fail-load`, so
this is defense in depth — and one `if`.

### P7 — the preload allow-list was fiction · fixed in `e8b9762`

`ipc-contract.js` described `ALL_INVOKE_CHANNELS` as "the flat allow-list used
by the preload bridge to reject unknown channels". The preload never imported
it and forwarded any string. A comment describing a control that does not
exist is worse than no comment: it is what a reviewer would rely on.

Fix: main passes both lists via `additionalArguments`; the bridge refuses
anything else and fails closed if the lists are missing.

### P8 — the test harness's CSP hole shipped to users · fixed in `3b80a39`

The chrome's `img-src` carried `http://127.0.0.1:*` so the offline UI harness
could load placeholder thumbnails. In the packaged app that let a
page-supplied favicon URL make the chrome origin issue GETs to local
services — a port-probe primitive, for a test-only reason. `'self'` covers
both cases correctly.

## Regressions this audit introduced (and how they were caught)

Worth recording, because the lesson generalizes: **a security gate written as
an allow-list will break legitimate behavior that nobody wrote a test for.**
The audit's own tests all passed while two real features were broken.

- **Waking a tab destroyed its history.** `restoreHistory` refused the *entire*
  saved history if any single entry failed the scheme check. Probing a real
  Electron session showed ordinary browsing produces `about:blank` entries (a
  page navigating itself) and `blob:` entries (a site opening a generated PDF),
  so tabs came back with an empty back-stack — silently, and in direct conflict
  with invariant #9. Now `sanitizeNavEntries()` drops only the unsafe entries
  and remaps the active index to the nearest survivor.
- **`window.open(blobUrl)` was blocked**, with a "Blocked a popup" toast. That
  is the standard way sites open a generated PDF or report in a new tab.
  `blob:` is now in the allow-list.

Neither was caught by the audit's own tests: the e2e history test passed
because its history was trivially clean, and no test covered blob popups at
all. Both are now pinned by 8 unit tests that were confirmed to fail against
the original fix before being kept.

**Known cosmetic cost, deliberately not "fixed":** the window-level
`dragover` preventDefault that stops file-drop navigation also makes the drag
cursor read as "droppable" over areas that accept nothing. The tidy fix
(`dropEffect = 'none'` when no widget claims the drag) was rejected because
whether a `none` effect still suppresses Chromium's navigate-to-file default
cannot be verified in this environment — a real OS file drag can't be
simulated — and a wrong guess silently reopens P2. Cursor polish is not worth
trading a verified security property for an unverified one.

## Accepted risks (v0.1)

These are known and deliberate. They are listed in `SECURITY.md` too, so users
see them rather than only auditors.

- **No Safe Browsing.** Electron ships no malicious-site or dangerous-download
  warnings; Chromium's reputation checks are Chrome-only. A download that
  Chrome would flag arrives in Raha silently (macOS Gatekeeper quarantine
  still applies).
- **Tab thumbnails are unencrypted screenshots** in the profile directory.
  Anything visible in a tab when it slept is on disk as a PNG. Chrome does the
  same, but a browser that says "privacy" should say this out loud.
- **macOS/Windows builds are unsigned** until R-108. Users must bypass
  Gatekeeper by hand, which is exactly the habit attackers rely on.
- **`RAHA_NO_SANDBOX=1` is honored in packaged builds.** Setting it disables
  Chromium's process sandbox. Anyone who can set your environment already has
  code execution, so this is not a privilege boundary — but gating it on
  `!app.isPackaged` is free — tracked as R-117 in docs/ROADMAP.md.
- **The built-in blocklist is a static host list**, not a filter engine
  (ADR-0007); R-102 replaces it.

## Method / what was not done

Reviewed by hand: every file under `src/main/`, `src/preload/`, the protocol
and privacy adapters, the IPC contract and both of its ends, all four local
HTML pages, and the persistence and validation layers.

No static-analysis tool was run. `@doyensec/electronegativity` checks the same
checklist items covered above and would have meant pulling an unvetted
dependency tree onto a maintainer's machine for a likely-empty cross-check. If
it earns a place in CI as a regression guard, that is a devDependency and an
ADR (INVARIANTS #6).

Not covered by this audit: the Chromium and Electron code itself (trusted, and
the reason the update channel in ADR-0008 exists), the GitHub Actions supply
chain beyond pinned actions and a read-only CI token, and physical/local
attackers with filesystem access to the profile directory.
