# ADR-0005: Ports & adapters — the engine never imports Electron

Date: 2026-07-19 · Status: accepted

## Decision
All browser logic lives in `src/main/core/engine.js` (+ `src/shared/`),
which receives platform capabilities as injected ports (views, metrics,
persist, clock, events). `src/main/electron/` implements those ports; it is
the only code importing `electron` (with `src/main/index.js` as the wiring).

## Context
Two forces:
1. **Agent maintainability.** Most future changes are behavior (governor,
   organization, settings). In this shape they are pure-JS edits, testable in
   milliseconds with fakes, and CANNOT introduce Electron API hallucinations
   because that vocabulary isn't importable there (a test enforces it).
2. **Authoring reality.** This repo was built where Electron couldn't even be
   downloaded; the engine was still fully developed and tested against fake
   ports — proof the seam is real, not aspirational.

## Consequences
- Port contracts are documented at the top of `engine.js`; fakes
  (`tests/fakes/ports.js`) and adapters change with them in the same commit
  (invariant #3).
- The Electron-exposed surface is small (~600 lines when this was written; ~1000 at v0.1.0) — the entire audit scope
  for Electron major upgrades (see upgrade-electron playbook).
- Cost: one indirection layer, and adapter bugs need ring-3/4 tests (e2e,
  smoke) to catch. Accepted: the e2e suite exists precisely for that layer.
