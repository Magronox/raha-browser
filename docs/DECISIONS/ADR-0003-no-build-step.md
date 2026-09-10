# ADR-0003: No build step — ESM JavaScript + JSDoc types

Date: 2026-07-19 · Status: accepted

## Decision
The app runs directly from `src/` (Electron main: ESM; UI: native ES modules;
preload: CJS as Electron requires). Types are JSDoc annotations checked by
`tsc --checkJs` in CI. No bundler, no transpiler, no emit.

## Context
This repo is designed for long-horizon maintenance by AI agents, including
weaker models. Every build-pipeline layer is a place where such an agent can
break the world without touching product code (config drift, loader
mismatch, stale artifacts). Also: the authoring environment had no package
registry access, proving the zero-toolchain path works end to end.

TypeScript-the-language was the alternative: stronger ergonomics, but it
requires emit (Electron doesn't run TS), which requires a bundler, which
reintroduces the pipeline. JSDoc+checkJs keeps ~90% of the safety with 0% of
the pipeline: what's in the repo IS what runs.

## Consequences
- `npm run typecheck` (full, strict) is a CI gate; `typecheck:pure` runs with
  zero node_modules for offline sandboxes.
- Slightly noisier annotations (`/** @type {...} */` casts) — accepted.
- Sourcemaps unnecessary; stack traces point at real files.
- If the UI ever needs a framework (it shouldn't), that's a new ADR.
