# ADR-0006: Sleeping a tab destroys its renderer process

Date: 2026-07-19 · Status: accepted

## Decision
"Asleep" = the tab's WebContentsView/webContents are destroyed. Survivors:
URL, title, favicon URL, capped navigation history (`navJson`), thumbnail
PNG, per-tab settings, tree position. Wake = new renderer + history restore.

## Context
Alternatives considered:
- **Chromium lifecycle freezing** (`Frozen` state): keeps the process; RAM
  mostly stays committed. Fails the product promise ("0 MB asleep").
- **Chrome-style discard** (navigate to about:blank keeping the process):
  same objection, plus zombie process bookkeeping.
- **Destruction** returns memory to the OS for real — `app.getAppMetrics`
  proves it (the e2e asserts process count drops). Costs: wake is a real
  page load (mitigated by history restore + cache), scroll/form state is
  lost in v0.1 (R-104 restores scroll; forms are inherently lossy —
  mitigated by the audio/keepAlive protections and per-tab pins).

## Consequences
- The memory number in the live bar is honest; "everything asleep" after a
  restart costs ~0 tab RAM (boot restores all tabs asleep by design).
- Invariant #9 forbids introducing hidden half-asleep states casually; a
  future "frozen" middle tier (e.g. for sub-minute suspends) needs a new ADR
  and its own UI state vocabulary.
