# ADR-0004: Zero runtime dependencies

Date: 2026-07-19 · Status: **amended by [ADR-0008](ADR-0008-auto-updates.md)
(2026-07-23) and [ADR-0009](ADR-0009-ghostery-adblocker-bundled-lists.md)
(2026-08-06)** — the "zero" is now "a short, pinned, per-ADR list (currently
exactly two)".

> **Read this first.** The reasoning below still governs: every runtime
> dependency must earn its place with its own ADR. But the literal claims are
> no longer true at HEAD. `package.json` has a `dependencies` block containing
> `electron-updater` (ADR-0008) and `@ghostery/adblocker` (ADR-0009) — 28
> unique packages in the shipped asar including transitives
> (`npm ls --omit=dev --all`). ADR-0008 explains why an un-patchable browser
> was judged a bigger risk than an empty dependency tree; ADR-0009 explains
> why a filter-list engine should not be hand-rolled.

## Decision
`package.json` has no `dependencies` — only devDependencies (electron,
test/lint/build tooling). Validation, migrations, blocking, ids: hand-rolled
in `src/shared/`, fully unit-tested.

## Context
A privacy browser's supply chain is part of its threat model. Every runtime
dep is: a supply-chain attack surface, an update treadmill, a thing a future
agent can misuse or hallucinate about, and a license-compatibility question
(ADR-0002). The needs at hand (schema validation of two small files, host
matching, id generation) total a few hundred lines — trivially cheaper to
own than to depend on. zod alone would be ~57KB to validate two JSON files.

## Consequences
- ~~The app tree ships exactly our code + Electron.~~ Superseded by ADR-0008: it also ships electron-updater + 15 transitive packages.
- ~~First planned exception:~~ The first exception actually taken was `electron-updater` (ADR-0008). The SECOND is `@ghostery/adblocker` for R-102 ([ADR-0009](ADR-0009-ghostery-adblocker-bundled-lists.md), 2026-08-06) — core package only, lists bundled at build time so no runtime fetches at all (stricter than the "cache in profile" originally sketched here). MPL-2.0 per ADR-0002, pinned exact.
- The bar for any dep: does it implement something we demonstrably should
  not write (crypto, filter-list engines, codecs)? Convenience is not a reason.
