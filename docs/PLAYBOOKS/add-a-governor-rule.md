# Playbook: add or change a governor rule

The governor is `src/shared/policy.js` — a pure function. This is the most
sensitive file in the repo (invariant #4): behavior and tests move together.

Example threaded through: "never auto-sleep a tab with an unsubmitted form"
(hypothetically fed by a `hasFormInput` flag).

1. **Extend the input type** if the rule needs a new fact:
   - `PolicyTab` typedef in `policy.js` (e.g. `hasFormInput: boolean`).
   - Producer: `engine.policyView()` maps runtime → PolicyTab; add the field.
   - Source of the fact: a port callback (views adapter event → runtime flag)
     — remember invariant #3: contract comment + fake + adapter in one commit.

2. **Place it in the precedence order deliberately.** Current order (see the
   policy header comment, which is normative):
   1. per-tab memory limit  2. idle  3. cap (LRU)  4. global budget —
   with audio/keepAlive/active protections. Decide explicitly: is your rule a
   new *protection* (add to `evictable`) or a new *eviction reason* (new
   loop + `SleepAction.reason` union member)?

3. **Update the header comment** — it is the human-readable spec.

4. **Write the tests FIRST** in `tests/unit/policy.test.js`:
   - the rule fires in isolation,
   - the rule composes with the cap (no double-sleep, correct LRU order),
   - the protection/priority interaction you decided in step 2,
   - determinism (same input → same output).

5. **New reason string?** Thread it through:
   - `sleepReasonText()` in `engine.js` (toast copy),
   - nothing else — reasons are otherwise opaque.

6. **If the rule needs a setting**, run `add-a-setting.md` first, then pass it
   via the `settings` param (add to the JSDoc of `decide`).

7. `npm run verify`. Then sanity-check live with a tiny cap:
   `RAHA_TICK_MS=800 npm start`, open 4-5 tabs, watch the live bar + toasts.

Anti-patterns (reject in review):
- Reading clocks, random, or globals inside `decide` (pass facts in).
- Sleeping the active tab (invariant #10) — warn instead.
- "Fixing" a failing expectation by loosening the assert.
