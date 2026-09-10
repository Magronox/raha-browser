# ADR-0011: App links (zoommtg:, msteams:, mailto:…) open via the OS, after an explicit ask

Date: 2026-08-22 · Status: accepted

## Decision

Raha gains a deliberately narrow `shell.openExternal` path. A URL whose
scheme is not web (so it can never be a tab, invariant #13) is triaged by
`src/shared/external.js`:

- **dangerous schemes** — refused outright, never offered to the user. The
  deny-list is the documented browser-as-launcher attack surface: local file
  and script execution (`file:`, `javascript:`, `data:`, `vbscript:`), the
  Windows protocol handlers with RCE history (`ms-msdt:`, `search-ms:`,
  `ms-appinstaller:`, …), browser internals (`chrome:`, `view-source:`), and
  `raha:` itself. Also refused: URLs over 2048 chars, control characters,
  malformed schemes.
- **everything else** — an in-app ask naming the app
  (`appLabelForScheme`: Zoom, Microsoft Teams, …) and showing the **full
  URL**. Open / Cancel, plus an optional per-scheme "always allow"
  (`settings.allowedExternalSchemes`, revocable in Settings). The OS is
  touched only after a yes — never on page action alone.

The engine holds the pending URL (`pendingExternal`); the UI's answer is
confirm/dismiss only and can never name a URL, so a compromised chrome
renderer cannot launch anything of its choosing. Each ask carries a nonce
the answer must echo: a newer request replaces the pending one AND its id,
so a stale modal (one whose ask was superseded mid-click) can neither open
nor remember anything — the bait-and-switch where the user approves URL A
while the engine holds URL B is structurally impossible, and the modal
re-renders to always display the URL the engine would actually open. The
one function that reaches the OS (`openExternalNow`) re-runs
`classifyExternal` at the sink, so a hand-edited settings.json cannot
smuggle a dangerous scheme onto the allow-list and a stale allow-list
entry cannot bypass the deny-list. Remembered-scheme auto-opens and
refusal toasts are rate-limited (one per quiet window; surplus requests
downgrade to an ask), so a looping page cannot turn one "always allow"
into a launch hose or a toast storm.

Both entry points route through the same sink: `setWindowOpenHandler`
(page `window.open`) and a new `will-navigate` handler in views.js — a
clicked meeting link *navigates* rather than pops up, and Chromium refuses
unknown schemes silently, which was exactly the "Zoom link does nothing /
says blocked" dead end this fixes.

`shell.openExternal` itself enters through a new optional **shell port**
(`src/main/index.js` is the only importer, per the ports-and-adapters rule,
ADR-0005). `allowedExternalSchemes` defaults to `[]`, is validated
(RFC 3986 scheme shape, dangerous schemes dropped, cap 50) and needs no
migration step — absent keys fill from defaults.

## Context

The 2026-07 security audit recorded, as a strength: "`shell.openExternal`
does not appear in the codebase. The single most common source of Electron
RCE is absent by construction." This ADR reverses that on purpose, and the
audit note is amended rather than quietly invalidated (SECURITY.md points
here). What made `openExternal` an RCE source in audited Electron apps is
calling it with page-controlled URLs *without* triage or consent — the
mitigations above (deny-list, engine-held URL + nonce, sink re-check,
mandatory in-app consent, rate-limited auto-opens) are each aimed at a
specific published failure mode. Note the honest limit: page script can
*raise* an ask without any user gesture (a navigation needs no click), and
a remembered scheme opens on page action alone — consent lives in the ask
and in the revocable "always allow", not in a gesture requirement.

Alternatives considered:

- **Keep blocking everything** (status quo). Safe but user-hostile: a Zoom
  link dead-ending in a toast is a bug to the person who clicked it, and
  "use another browser for meetings" undermines the daily-driver goal.
- **Ship a fixed allow-list of known-good apps, no ask.** The universe of
  legitimate schemes is unknowable (every conferencing/chat/dev tool
  registers one); a curated list is forever incomplete and silently opens
  apps the user never consented to. The ask-plus-remember flow covers the
  long tail and keeps consent explicit — same shape as the default-browser
  flow, which set the consent-first precedent.
- **Ask on every open, no remembering.** Strictly safer, but nags exactly
  the people who use Zoom daily; "always allow" is scoped to a scheme the
  user has already said yes to once, and is revocable in Settings.

## Consequences

- The audit's "absent by construction" line no longer holds; the guarantee
  is now "present, gated, single sink" and SECURITY.md says so. The next
  audit must probe this path (spoofed `external:open` IPC, allow-list
  tampering, deny-list gaps).
- New IPC channels `external:open` / `external:dismiss` + `evt:askExternal`
  (contract, engine, ipc, api, mock-bridge — the five files the one-source-
  of-truth IPC rule requires, INVARIANTS #7).
- `mailto:` and `tel:` now work (previously dead), at the cost of one ask.
- The deny-list is a judgment call frozen in code; a scheme later found
  dangerous moves onto it in a patch release, and validation drops it from
  existing allow-lists on load (the sink re-check covers the window in
  between).
- Harness pins the consent math: cancel ⇒ 0 OS calls, accept ⇒ 1,
  remembered ⇒ 1 with no modal (tests/ui/run.mjs), mirroring the
  default-browser tests.
