# CLAUDE.md — the agent guide for Raha

You are working on **Raha**, an open-source privacy browser whose defining
feature is a **resource governor**: the user decides how many tabs may run,
which tabs are kept alive, and how much memory each may spend. Everything
else exists to serve that promise.

This file is the canonical entry point for AI agents (and new humans).
Read it fully before writing code. When this file and your instincts
disagree, this file wins.

## The one-command truth

```
npm install          # once (needs network)
npm run verify       # typecheck + lint + unit + ui-harness + e2e — MUST be green before "done"
```

No display / no node_modules (restricted sandbox)? Use:

```
npm run verify:offline   # typecheck:pure + unit + ui-harness (Chromium)
```

and say explicitly in your report that e2e/smoke still need a CI run.
CI (.github/workflows/ci.yml) runs the full suite on every push to `main` and on PRs — treat a red
CI as "the task is not finished", never as "flaky infra".

> **Current state (2026-09-10).** The repository's history begins at a
> single snapshot commit of the audited tree (`docs/PLAYBOOKS/first-push.md`).
> Running Electron 43.4.0 / Chromium 150.0.7871.224. Suite: **366 unit / 47
> ui-harness / 48 e2e**. The 2026-07 security audit
> (`docs/SECURITY-AUDIT-2026-07.md`) is in; its commit references predate
> the public history and do not resolve here. There is deliberately **no
> tag and no GitHub release yet** — v0.1.0 gets cut from green `main` by
> `docs/PLAYBOOKS/release.md`, only on the owner's go.
>
> Latest feature work: **R-104 scroll + form state** (state schema 1→2,
> `src/shared/page-state.js`, engine capture/persist/restore lifecycle,
> adapter ports in triplicate, `restorePageState` setting). Its part B
> (freezing a background tab over CDP instead of sleeping it) is a
> post-launch item on the roadmap, not built.
>
> Dependabot will propose **Electron 44.x, a MAJOR**. Do not merge it
> casually: it needs `docs/PLAYBOOKS/upgrade-electron.md` and the owner's
> decision. v0.1.0 ships on 43.4.0.
>
> Installed builds on a dev machine may lag `main`; run from source
> (`npm start`) to test current features, and verify any claim about which
> build is installed before repeating it.

## Map of the codebase (what lives where)

| Path | What it is | May import |
|---|---|---|
| `src/shared/` | Pure logic: policy (governor + runaway guard), tree, urls, rules, validation, defaults, migrations, blocking pipeline, history store, open-tabs import (mozlz4 + session parsing), tab organizer, page-menu template, permissions (R-103 per-site decisions), external (ADR-0011 app links), client-hints (Chrome brand/GREASE, ADR-0012), page-state (R-104 scroll + form capture/restore), layout, ids, IPC contract | nothing platform-y |
| `src/main/core/engine.js` | The brain: owns state, runtime table, governor loop; talks to platform via injected **ports** | shared only |
| `src/main/electron/` | Where the adapters live; with `src/main/index.js` (wiring) and `src/preload/ui.cjs` (bridge) these are the only files importing `electron`: window, views, metrics, persist, privacy, blocker (bundled filter-list engines — the one file importing `@ghostery/adblocker`; note it deliberately does NOT import `electron` so unit tests can load it), protocol, ipc, menu, context-menu, import-history (other browsers' history DBs via `node:sqlite`), import-tabs (open windows/tabs via osascript JXA + Firefox session files), chrome-identity (CDP UA-metadata override + OOPIF auto-attach, ADR-0012), site-data (per-site cookie/storage clearing, incl. the partitioned 3p jar), updater, log, paths | electron + node + shared |
| `src/main/index.js` | Wires engine ⇄ adapters; entrypoint | electron + everything |
| `src/preload/ui.cjs` | contextBridge for the UI view only; forwards just the contract channels (main hands it the lists via `additionalArguments`). CommonJS, keep it dumb | electron |
| `src/ui/` | The chrome: a plain web page. Talks ONLY to `window.raha` via `src/ui/api.js` | shared + DOM |
| `tests/unit/` | node:test — pure logic + engine-on-fakes. Runs anywhere, no deps | — |
| `tests/fakes/ports.js` | Fake ports emulating the adapter contracts | — |
| `tests/ui/` | Real UI in Chromium + real engine on fakes, over a mock bridge. Refresh README screenshots with `RAHA_SHOTS=1 npm run test:ui` | — |
| `tests/e2e/` | Real Electron via Playwright (needs display + node_modules) | — |
| `tests/manual/` | Hands-on security QA page served over loopback (`npm run qa`) — the checks no automated test can reach | — |
| `docs/` | ARCHITECTURE, INVARIANTS, ROADMAP, USER_GUIDE, SECURITY-AUDIT-2026-07, PLAYBOOKS, DECISIONS (ADRs) | — |

## Non-negotiable invariants

The full list with rationale is `docs/INVARIANTS.md`. The ones you will meet
daily:

1. **Layer purity.** `src/shared/` and `src/main/core/` never import
   `electron` or `node:*`. Enforced by `tests/unit/boundaries.test.js` and
   eslint. If the engine needs a new platform capability, extend a **port**:
   update the contract comment atop `engine.js`, the fake in
   `tests/fakes/ports.js`, and the adapter in `src/main/electron/` — all in
   the same commit.
2. **IPC channels exist in exactly one file:** `src/shared/ipc-contract.js`.
   Never write a channel string literal anywhere else (a test greps for this).
   Adding a channel touches exactly: contract → `src/main/core/engine.js`
   (the method behind it) → `src/main/electron/ipc.js` → `src/ui/api.js` →
   `tests/ui/mock-bridge.mjs`. Playbook:
   `docs/PLAYBOOKS/add-an-ipc-channel.md`.
3. **Web pages get no bridge.** Content WebContentsViews have no preload,
   sandbox on, contextIsolation on. Never attach a preload to a tab view.
4. **Governor changes ship with their tests.** `src/shared/policy.js` and
   `tests/unit/policy.test.js` change in the same commit, always.
5. **Persistence changes require a migration.** Never change what
   `state.json`/`settings.json` look like without a migration step in
   `src/shared/migrate.js` + a fixture test. Playbook:
   `docs/PLAYBOOKS/change-persistence.md`.
6. **Minimal dependencies, zero telemetry.** Every runtime dependency needs
   its own ADR (currently exactly two: `electron-updater`, ADR-0008, and
   `@ghostery/adblocker`, ADR-0009 — both pinned exact). Raha contacts
   exactly one server of its own accord: GitHub Releases for the optional
   security-update check (`autoUpdate` setting). The ad/tracker filter lists
   are bundled with the app and update only with releases — never downloaded
   at runtime (ADR-0009). Everything else on the wire is either a page the
   user opened or a favicon the chrome loads from that site — see INVARIANTS
   #6, which spells the favicon carve-out out; never write "zero network
   requests" anywhere. A new devDependency needs an ADR in
   `docs/DECISIONS/` too.
7. **Escape everything.** Any page-controlled string (title, URL) rendered
   into UI HTML goes through `esc()` from `src/ui/render/util.js`. The XSS
   canary test in `tests/ui/run.mjs` must stay.
8. **Only the web loads in a tab; the chrome never leaves its page**
   (INVARIANTS #13). Every tab URL passes `isNavigableUrl()` at the *sink*
   (`tabCreate`/`wake`/`restoreHistory`) — a page's `window.open()` is loaded
   by the main process, so Chromium's own navigation blocks do not cover it.
   Restored history is *filtered* (`sanitizeNavEntries`), never refused
   wholesale, or users lose their back-stack. If you tighten this gate, go
   find what legitimate behavior you just broke: the first version blocked
   `blob:` PDFs and wiped history containing `about:blank`.

## How to work (agent protocol)

1. **Locate the layer.** Behavior of sleeping/eviction → `src/shared/policy.js`.
   Orchestration/lifecycle → `src/main/core/engine.js`. Electron API usage →
   `src/main/electron/*`. Anything visual → `src/ui/`.
2. **Write the test first in the cheapest layer that can catch the bug.**
   Prefer unit > ui-harness > e2e. A governor bug must be reproducible in
   `tests/unit/policy.test.js` without Electron.
3. **Small diffs.** One concern per commit. Do not reformat unrelated code.
4. **Do not invent Electron APIs.** If you need an API not already used in
   `src/main/electron/`, verify its exact signature on
   https://www.electronjs.org/docs/latest/ first and note the doc URL in the
   commit message. Electron is pinned in package.json — do not bump majors
   casually (that is a dedicated task with the checklist in
   `docs/PLAYBOOKS/upgrade-electron.md`).
5. **Never weaken a test to make it pass.** If a test seems wrong, explain why
   in the commit message and update test + code together.
6. **Finish the loop:** `npm run verify` (or `verify:offline` + say so), update
   docs touched by your change, then summarize what changed and why.

## Common tasks → playbooks

| Task | Playbook |
|---|---|
| Add a user setting | `docs/PLAYBOOKS/add-a-setting.md` |
| Add an IPC channel | `docs/PLAYBOOKS/add-an-ipc-channel.md` |
| Add/change a governor rule | `docs/PLAYBOOKS/add-a-governor-rule.md` |
| Change persisted state | `docs/PLAYBOOKS/change-persistence.md` |
| Cut a release | `docs/PLAYBOOKS/release.md` (step 0 is historical — the stale tag/draft are long gone; read the macOS signing section) |
| Check the security fixes | CI-enforced by `tests/e2e/security-qa.spec.js` (automated twin); hands-on page: `npm run qa` (in Raha only — it banners in other browsers) |
| Debug tab lifecycle issues | `docs/PLAYBOOKS/debug-tab-lifecycle.md` |
| Upgrade Electron | `docs/PLAYBOOKS/upgrade-electron.md` |

## Running the app

```
npm start                      # normal run (dev machine)
RAHA_DEV=1 npm start           # + UI devtools
npm run smoke                  # scripted self-test against real Electron
npm run qa                     # serve tests/manual/security-qa.html for hand-checks
xvfb-run -a npm start          # headless container (add RAHA_NO_SANDBOX=1)
```

Env knobs: `RAHA_PROFILE_DIR` (isolated profile), `RAHA_TICK_MS` (governor
period, default 2500), `RAHA_NO_SANDBOX=1` (Chromium sandbox off — dev/CI
containers only, never ship).

Troubleshooting: `npm run dist` can flake with `zip process failed 18` and a
wall of "zip warning: No such file or directory" — electron-builder builds
the dmg and zip targets in parallel from the same staged app and the zip
walk occasionally races the dmg staging. The dmgs are usually fine (verify
with `hdiutil verify`); delete the truncated zip, or `rm -rf release` and
re-run. Tag-driven CI releases build each OS/arch in isolated jobs and never
hit this.

Troubleshooting: after a **Playwright version bump** (Dependabot does these),
`npm run test:ui` and `test:e2e` die with "Executable doesn't exist … Looks
like Playwright was just installed or updated" — the browser build is pinned
to the Playwright version. Fix: `npx playwright install chromium`. CI does
this as its own step, so **CI stays green while your local verify fails**;
that mismatch is expected, not a broken merge.

VSCode and agent shells export `ELECTRON_RUN_AS_NODE=1`,
which makes a bare `electron .` run as plain Node — the app silently never
starts. `npm start`/`npm run smoke` are immune (they route through
`scripts/launch.mjs`, which strips it), and the e2e spec strips it too; if you
invoke the electron binary by hand, `unset ELECTRON_RUN_AS_NODE` first.
`npm run smoke` defaults `RAHA_PROFILE_DIR` to a throwaway temp dir.

## Vocabulary (use these exact words in code, UI, and docs)

- **running** — tab has a live renderer process (active or background)
- **active** — the one running tab currently shown
- **asleep** — renderer destroyed; zero RAM/CPU; URL + history + thumbnail kept
- **keepAlive / pinned** — excluded from automatic sleeping (except its own memory limit)
- **rule** — a domain pattern granting keepAlive and/or a memory limit
- **governor** — the policy engine deciding who sleeps and why
