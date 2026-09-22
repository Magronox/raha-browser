# ADR-0014: Freeze is CPU suspension; sleep is process destruction

Status: accepted (2026-09-16) · Amends ADR-0006, INVARIANTS #5 and #9 ·
Roadmap R-127 (design: R-104 part B)

## Decision

Raha gains a third tab state, **frozen**: the renderer process stays alive
but Chromium's page lifecycle is set to `frozen` through the tab's existing
DevTools-protocol session (`Page.setWebLifecycleState`, reusing the `cdp()`
handle of ADR-0012 — never a second attach). JavaScript, timers, rAF and
dedicated workers stop; the working set stays resident **and stays counted**;
DOM, JS state and form inputs survive; thaw is instant. Frozen is a runtime
state only — never persisted; every tab is asleep after a restart, as before.
**Sleep** remains process destruction (ADR-0006) and remains the only state
that returns memory.

The governor's rule 5 freezes background tabs idle longer than
`settings.freezeIdleMinutes` (default 2, 0 = off). The sleep rules keep
precedence, a tab chosen to sleep is never also frozen, and frozen tabs are
ordinary running tabs to rules 1–4 (they hold RAM). Never frozen
automatically: the active tab, keepAlive tabs, audible tabs (with
`protectAudio`), loading tabs. The runaway guard offers **Freeze** first for
CPU and **Sleep** first for memory.

## Context

The owner's ask: "when a page takes too much, make it static — not killed."
Measured on Electron 43.4.0 / Chromium 150 (design spike, 2026-08-27) and
re-checked on every upgrade since (`npm run smoke` for "JS really stops" —
Playwright pins pages visible, and Chromium won't freeze a visible page, so
`tests/e2e/freeze.spec.js` checks everything but that): freezing
brings renderer CPU to ~0 and stops growth but reclaims nothing;
`capturePage` still works; destroying a frozen view is clean; thaw resumes
from frozen values but leaves `visibilityState` `hidden` until the view is
hidden and shown again (the adapter kicks it); `<audio>/<video>` pause on
freeze and never auto-resume; `executeJavaScript` queues silently while
frozen (so page state is captured *before* the freeze, never during). So
freeze is a *CPU and growth* tool, not a *memory* tool, and the governor
treats it that way.

## Alternatives rejected

- Freezing as the memory answer — it reclaims nothing; the README's "0 MB
  asleep" would become a lie.
- Auto-freezing runaway CPU without asking — the guard stays a prompt.
- Frozen-first LRU eviction — with auto-freeze on the frozen tabs *are* the
  LRU tabs; ordering them first would only punish the tab the user just set
  aside.
- Freezing pinned tabs — keepAlive means "keep running in the background";
  pinning is the escape hatch for uploads and calls, and pinning a frozen tab
  thaws it.

## Consequences

- New vocabulary (**frozen** / **thaw**), a snowflake badge in sidebar, grid
  and live bar, context-menu and toolbar actions, `Cmd/Ctrl+Shift+F`, a
  Settings select, and a one-time explainer toast the first time the
  governor freezes something.
- INVARIANTS #9 gains the frozen carve-out; #5 names freeze as the second
  user of the tab's CDP session. The live bar shows frozen memory as real
  memory (`stats.frozenCount`, `stats.frozenMemMB` are informational).
- Thaw failure degrades to sleep + wake (with R-104 restore), freeze failure
  leaves the tab running — browsing never depends on the protocol.
- `Page.setWebLifecycleState` is experimental: the upgrade playbook re-runs
  the e2e; the failure mode is "tab keeps running", never "tab lost".
- Known gaps: media never auto-resumes after a thaw; WebRTC calls and
  JS-driven uploads in background tabs stall after the threshold unless the
  tab is pinned (the default 2 min is deliberate — the setting is the dial);
  the page's `freeze` lifecycle event fires in-page, `resume` does not.
