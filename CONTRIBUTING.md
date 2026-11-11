# Contributing to Raha

Read these three before opening a pull request.

1. **[CLAUDE.md](CLAUDE.md)** — the codebase guide, written for AI agents and as
   useful to people: layer map, commands, protocol.
2. **[docs/INVARIANTS.md](docs/INVARIANTS.md)** — the rules that are never
   broken casually. A PR that breaks one without an ADR is declined.
3. **[docs/PLAYBOOKS/](docs/PLAYBOOKS/)** — step-by-step recipes for the
   common changes (settings, IPC, governor rules, persistence, releases).

## The loop

```bash
npm install
npm run verify        # typecheck + lint + unit + UI harness + e2e
```

- Green `verify` is the definition of done; CI runs the same.
- Behavior changes ship WITH their tests, same PR.
- Small PRs, one concern each. No drive-by reformatting.
- No new dependencies without an ADR. Raha has two direct runtime
  dependencies — the updater ([ADR-0008](docs/DECISIONS/ADR-0008-auto-updates.md),
  amending [ADR-0004](docs/DECISIONS/ADR-0004-zero-runtime-deps.md)) and the
  filter-list engine ([ADR-0009](docs/DECISIONS/ADR-0009-ghostery-adblocker-bundled-lists.md));
  a third needs its own ADR arguing why.
- Work items live as GitHub issues; the **agent-task** issue template
  produces specs that both humans and AI agents can execute directly.
  Issues reference roadmap numbers in their titles (`R-101: Find in page —
  Ctrl+F bar`); [docs/ROADMAP.md](docs/ROADMAP.md) stays the source of
  what's next, issues track execution, and an R-item counts as delivered
  only when its acceptance criteria hold and the *Delivered* note lands in
  the roadmap.

## Licensing of contributions

Inbound = outbound: by submitting a contribution you license it under
**GPL-3.0-only**, and you confirm you have the right to do so.
Contributions to this repository go into Raha's published GPL-3.0 code. If an AI agent
wrote part of your patch, keep its `Co-authored-by` line. The Raha name/logo remain reserved (TRADEMARK.md).

## Reporting security issues

Please do NOT open a public issue for exploitable bugs — see
[SECURITY.md](SECURITY.md).
