# Playbook: debug tab lifecycle issues

"A tab slept when it shouldn't", "wake lost history", "memory badge frozen",
"eviction picked the wrong tab" — all lifecycle bugs. Work the rings from
cheapest to most real; the bug is almost always reproducible in ring 1.

## Ring 1 — pure policy (seconds)

Is the DECISION wrong? Reproduce in `tests/unit/policy.test.js`:
build the exact `PolicyTab[]` snapshot (states, lastActiveAt, keepAlive,
audible, memMB/limits) and assert what `decide` returns. If the decision is
wrong here → fix `policy.js` (with the test) and you're done.

If `decide` is right, the INPUT was wrong → ring 2.

## Ring 2 — engine on fakes (seconds)

Is the engine feeding the policy bad facts, or executing actions wrong?
`tests/unit/engine.test.js` + `tests/fakes/ports.js` can simulate everything:
metrics per pid (`world.setTabMetrics`), audio (`view.simulateAudio`),
crashes (`view.simulateCrash`), clock (`world.advanceMinutes`), shared pids
(assign the same pid to two views). Assert on `engine.snapshot()` and
`world` effects (destroyed views, focus log, files).

Typical culprits: `lastActiveAt` not updated on some path; runtime entry not
cleaned on close/crash; effective policy (rules) not applied because the URL
host changed after wake.

## Ring 3 — real Electron (minutes)

Only if fakes can't reproduce (timing, real process behavior, capture):

```
RAHA_TICK_MS=800 RAHA_PROFILE_DIR=/tmp/raha-dbg RAHA_DEV=1 npm start
```
- stderr shows `[raha:*]` lines (governor sleeps, crashes, persist errors).
- UI devtools opens detached (RAHA_DEV=1) — inspect the pushed snapshots:
  in the console, snapshots arrive ~2.5s; check the tab's memMB/audible.
- `npm run smoke` (xvfb ok) exercises create/evict/wake/pin/metrics/persist
  against real renderers and prints TAP.
- e2e: `xvfb-run -a npx playwright test --trace on` then open the trace.

## Known sharp edges (check before "fixing")

- Same-site tabs may SHARE a renderer pid → both show the full process
  memory with a `*`; the governor may sleep one and free nothing. Documented
  tradeoff (ARCHITECTURE.md), not a bug.
- `cpu.percentCPUUsage` is percent-of-one-core since last sample; >100 is real
  on multicore pages.
- A tab that never was active has `lastActiveAt = 0` → idle rule skips it,
  LRU evicts it FIRST. Both intentional (tests pin it).
- Thumbnails capture on switch-away; a tab slept without ever being seen has
  none → grid shows the letter fallback. Fine.
- `activeTabId` is null after boot BY DESIGN (everything asleep, grid shown).
