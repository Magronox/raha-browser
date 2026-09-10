# Playbook: change persisted state (state.json / settings.json)

Invariant #8: shapes change only through migrations. Users' tab trees are
sacred; a botched schema change is the one bug we can never fully undo.

Adding a field WITH a default that old files can omit? That is NOT a schema
change — validation fills the default (see add-a-setting.md step 4). This
playbook is for renames, removals, type changes, or structural moves.

Example threaded through: renaming `keepAlive` → `pinned` on tab nodes
(don't actually do this — it's illustrative).

1. **Bump the version** — `src/shared/defaults.js`:
   `STATE_SCHEMA_VERSION` (or `SETTINGS_SCHEMA_VERSION`) `1 → 2`.

2. **Append one step** — `src/shared/migrate.js`, keyed by the OLD version:
   ```js
   const STATE_STEPS = {
     0: ...existing...,
     1: (doc) => {
       for (const n of Object.values(doc.tree?.nodes ?? {})) {
         if (n.type === 'tab') { n.pinned = Boolean(n.keepAlive); delete n.keepAlive; }
       }
       return { ...doc, schemaVersion: 2 };
     },
   };
   ```
   Rules for steps: pure, defensive (input may be half-corrupt), NEVER edit
   or delete an existing step, exactly +1 version per step.

3. **Fixture test** — `tests/unit/migrate.test.js`: paste a REAL v1 document
   (copy one from a run: `cat "$RAHA_PROFILE_DIR/state.json"`), assert the
   v2 shape AND that `checkIntegrity` returns `[]`, AND that meaningful data
   (urls, flags) survived.

4. **Chase the field through the code**: typedef in `tree.js`/`defaults.js`,
   every read/write (grep the old name — the repo is small), snapshot
   building, UI rendering. tsc (`npm run typecheck`) is your safety net —
   the JSDoc types will scream at leftovers.

5. **Round-trip proof**: the existing test "persistence round-trip" in
   `tests/unit/engine.test.js` must still pass untouched (it writes with the
   NEW code — also add one boot-from-OLD-fixture engine test if the change is
   structural).

6. `npm run verify`.

Never:
- Reuse a version number.
- Write a "migration" that drops data because parsing was annoying —
  `repairTree` exists for corruption; migrations are for evolution.
