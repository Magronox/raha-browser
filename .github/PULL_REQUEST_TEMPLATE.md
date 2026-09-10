## What & why

<!-- one paragraph; link the issue -->

## Checklist (required — see CLAUDE.md)

- [ ] `npm run verify` is green (typecheck, lint, unit, ui-harness, e2e)
- [ ] Behavior changes have tests in the SAME commit
- [ ] No new dependencies (or an ADR in docs/DECISIONS justifies one)
- [ ] Invariants in docs/INVARIANTS.md still hold (esp. layer purity + IPC contract)
- [ ] Persistence schema untouched, OR migration + fixture test added
- [ ] Docs updated (README / playbooks / ADR) if behavior or process changed
