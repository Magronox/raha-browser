# INVARIANTS

Numbered so code comments can cite them (`docs/INVARIANTS.md #3`). Breaking
one of these is never a refactor detail — it is an architecture change and
needs an ADR in `docs/DECISIONS/` plus explicit sign-off from the maintainer.

## #1 — Layer purity
`src/shared/**` and `src/main/core/**` import neither `electron` nor any
node builtin. They receive platform capabilities through injected **ports**
(see the contract block atop `src/main/core/engine.js`).
*Why:* this is what makes the browser's brain fully testable offline in
milliseconds, and what lets weaker agents change behavior without touching
process management.
*Enforced by:* `tests/unit/boundaries.test.js`, eslint `no-restricted-imports`,
`tsconfig.pure.json` (compiles with zero node_modules).

## #2 — The UI is a plain web page
`src/ui/**` touches the outside world only through `window.raha`
(wrapped once in `src/ui/api.js`). No electron, no node, no fetch to the
network (CSP blocks it anyway).
*Why:* the whole UI runs and is tested in plain Chromium (tests/ui) without
Electron; it can never gain privileged powers by accident.

## #3 — Ports change in triplicate
A change to any port contract (views/metrics/persist) updates, in one commit:
the contract comment in `engine.js`, the fake in `tests/fakes/ports.js`, and
the real adapter in `src/main/electron/`.
*Why:* fakes that drift from adapters make green tests lie.

## #4 — Governor behavior is pinned by tests
`src/shared/policy.js` and `tests/unit/policy.test.js` change in the same
commit. Every rule, precedence, and protection listed in the policy header
comment has at least one test.
*Why:* the governor is the product. Silent behavior drift is the worst bug
class we can ship.

## #5 — Web content is bridgeless
Tab WebContentsViews: `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, **no preload**. Only the UI view gets the preload
bridge, and main validates every invoke. The main process may hold a
DevTools-protocol session on a tab (`src/main/electron/chrome-identity.js`,
which tells the renderer what browser to claim to be) — that is not a
bridge: nothing is exposed to the page, and the page cannot reach it.
*Why:* a compromised page must find nothing to escalate through.

## #6 — Raha is silent on the network, except the optional update check
No telemetry, no list downloads, no favicon *proxying* (the chrome loads them
straight from the site, so nothing is routed through us). The only server Raha
itself contacts is GitHub Releases, for the security-update check (ADR-0008) — on by default, off with the `autoUpdate`
setting, packaged builds only. Everything else on the wire is what pages
the user opened generate (plus favicons fetched by the UI `<img>` tags from
the sites themselves). The ad/tracker filter lists are bundled with the app
and refreshed only via app releases — never downloaded at runtime
(ADR-0009). Runtime dependencies require an ADR each (electron-updater
ADR-0008 and @ghostery/adblocker ADR-0009, both pinned exact, are currently
the only two); new devDependencies need an ADR too.
*Why:* "private" is a checkable property here, not a marketing word — and
an un-patchable browser is a bigger privacy hole than a version-check ping.

## #7 — One source of truth for IPC
Channel names exist only in `src/shared/ipc-contract.js`. A grep-test fails
if a literal appears elsewhere. Adding a channel touches exactly five files (contract, the engine method,
main ipc, ui api, ui-harness mock) — the playbook lists them in order.
*Why:* stringly-typed IPC is where hallucinated code silently breaks apps.

## #8 — Persisted files migrate, never mutate shape ad hoc
`state.json` / `settings.json` / `history.json` carry `schemaVersion`. Shape
changes append a migration step in `src/shared/migrate.js` (old steps are
immutable) plus a fixture test feeding a real old document through.
*Why:* users' tab trees survive every upgrade, forever.

## #9 — Sleeping is destruction, by design
"Asleep" means the renderer process is destroyed (RAM actually returns to the
OS), never merely hidden/throttled. What survives sleep: URL, title, favicon
URL, navigation history (capped), thumbnail, per-tab settings, position in
the tree. Do not introduce a half-asleep state without an ADR.
*Why:* the memory promise in the README must stay literally true.

## #10 — The active tab is sacred
No automatic action may destroy or navigate the ACTIVE tab: the governor
never sleeps it (it warns instead), crash handling flips it to asleep but
never wakes something else on top of the user.
*Why:* the user's current focus is the one thing a "calm" browser must never
yank away.

## #11 — Escape at the sink
Every page-controlled string (titles, URLs, favicon URLs) rendered into UI
HTML passes through `esc()` (`src/ui/render/util.js`). Error-page params are
displayed via `textContent` only — and where one becomes an `href` (the "Try
again" link), it is gated on `/^https?:\/\//i` first, because that page's CSP
permits inline script and therefore `javascript:` hrefs (audit P6). The XSS
canary in `tests/ui/run.mjs` stays.
*Why:* the UI renders attacker-influenced text all day long.

## #12 — Versions move in lockstep
A release tag `vX.Y.Z` equals `package.json.version` (release workflow
guards this) and gets a CHANGELOG.md entry. Electron major upgrades are a
dedicated task (`docs/PLAYBOOKS/upgrade-electron.md`), never a drive-by.

## #13 — Only the web loads in a tab; the chrome never leaves its page
Two halves of the same containment rule, both added by the pre-launch audit
(`docs/SECURITY-AUDIT-2026-07.md`):

- Every URL that reaches a tab passes `isNavigableUrl()` — `http:`, `https:`,
  `raha:`, `blob:` and nothing else. This is enforced at the *sinks*
  (`tabCreate`, `wake`, `restoreHistory`), not at the entry points, because
  URLs arrive from the omnibox, the UI, a page's `window.open()`, and
  `state.json` — and only the first is pre-sanitized. A page's `window.open()`
  is loaded by the **main** process, so Chromium's renderer-initiated
  navigation blocks do not apply to it.
- Restored history is *filtered*, never refused wholesale
  (`sanitizeNavEntries`): unsafe entries are dropped and the active index
  remaps to the nearest survivor. Refusing the whole batch would silently
  destroy the user's back/forward stack, which invariant #9 forbids — real
  sessions routinely contain `about:blank` and `blob:` entries.
- The chrome view is pinned to `raha://app/index.html`: `will-navigate`,
  `will-redirect` and `setWindowOpenHandler` refuse everything else, and IPC
  handlers additionally require the sender to be that frame, still on that URL.

*Why:* the chrome view is the only view holding the preload bridge. Any other
origin that reaches it inherits `window.raha` and with it the whole engine.
*Enforced by:* the scheme half — `tests/unit/urls.test.js` (isNavigableUrl,
isUiChromeUrl, sanitizeNavEntries) and the popup/tamper cases in
`tests/unit/engine.test.js`. The chrome-pinning half — the two "chrome view
refuses…" tests in `tests/e2e/app.spec.js`, which drive a real renderer
navigation and a real `window.open`. Protocol exposure: the "web content is served raha://home but
never the chrome or thumbnails" test in the same file. Hand-checks that no automated test can reach live in
`tests/manual/security-qa.html` (`npm run qa`).

