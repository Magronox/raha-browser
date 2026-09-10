# AGENTS.md

The canonical agent guide for this repository is **[CLAUDE.md](CLAUDE.md)** —
read that file. It is tool-agnostic despite the name (kept as `CLAUDE.md`
because several agent runtimes auto-load that path; this pointer exists for
runtimes that auto-load `AGENTS.md`).

Quick facts if you only read one screen:

- `npm run verify` must be green before any change is "done"
  (`npm run verify:offline` in sandboxes without display/deps — then say so).
- Layer purity: `src/shared/` + `src/main/core/` never import electron/node;
  only `src/main/electron/` + `src/main/index.js` may import `electron`.
- IPC channel names live ONLY in `src/shared/ipc-contract.js`.
- Governor behavior (`src/shared/policy.js`) changes together with
  `tests/unit/policy.test.js`, same commit.
- Persisted-file changes require a migration + fixture test.
- Exactly ONE direct runtime dep (electron-updater, pinned, ADR-0008; it pulls
  15 transitive packages into the asar); another needs its own ADR. Zero
  telemetry apart from that opt-out update check. Escape page-controlled strings.
- `npm run qa` serves `tests/manual/security-qa.html` for the hands-on security
  checks no automated test can reach.
- `main` is pushed and CI-green on Electron 43.2.0; there is deliberately no
  tag and no release yet (the pre-audit v0.1.0 tag + draft were deleted). But
  /Applications/Raha.app and the loose Desktop dmgs are still the pre-audit
  2026-07-23 build — verify fixes from source or from
  ~/Desktop/Raha-FIXED-build-2026-07-29/, never against those.
- Only `http:`/`https:`/`raha:`/`blob:` may load in a tab, and the chrome view
  never navigates away from its own page (invariant #13) — both are security
  boundaries, not style. Restored history is filtered, never refused wholesale.
