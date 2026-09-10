---
name: Agent task
about: A work item written so an AI coding agent can execute it safely
title: "[task] "
labels: agent-ready
---

<!-- Fill every section. Agents: read CLAUDE.md first, then this issue. -->

## Goal (one sentence)

## Context — which files/docs are involved
<!-- e.g. src/shared/policy.js + tests/unit/policy.test.js, docs/PLAYBOOKS/add-a-governor-rule.md -->

## Definition of done
- [ ] `npm run verify` passes locally / in CI
- [ ] New behavior covered by a test in the right layer (unit / ui-harness / e2e)
- [ ] Docs updated if behavior or invariants changed (README, docs/*)
- [ ]

## Out of scope
<!-- What the agent must NOT touch. e.g. "no changes to persistence schema" -->

## Hints / references
<!-- Exact API docs, prior PRs, related ADRs -->
