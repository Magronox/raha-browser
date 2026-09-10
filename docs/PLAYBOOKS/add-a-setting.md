# Playbook: add a user setting

Example threaded through: adding `newTabInActiveFolder: boolean` (default
false). Replace with yours. Total: 6 files, ~30 minutes.

1. **Define it** — `src/shared/defaults.js`
   - Add the field + JSDoc line to the `RahaSettings` typedef.
   - Add the default to `defaultSettings()`.
   - Numeric? Add its `[min, max]` to `RANGES`.

2. **Validate it** — `src/shared/validate.js`
   - Booleans: add the key to the `bool(...)` call list in `validateSettings`.
   - Numbers: add to the `num(...)` union type + call.
   - Enums: follow the `searchEngine` pattern.

3. **Test the validation** — `tests/unit/validate.test.js`
   - Garbage in → default out; valid in → preserved. One assert each.

4. **No schema bump needed** for ADDING a field with a default (old files
   validate fine — missing key → default). REMOVING/RENAMING a field is a
   schema change → use `docs/PLAYBOOKS/change-persistence.md` instead.

5. **Consume it** where behavior lives:
   - Governor input? Thread it via `engine.policyView()`/`decide()` settings
     param — and pin behavior in `tests/unit/policy.test.js` (invariant #4).
   - Engine behavior? Use `this.settings.<key>` in `engine.js` + engine test.
   - Adapter behavior (headers, session)? Read via the `getSettings` hook in
     the adapter.

6. **Expose it** — `src/ui/render/settings.js`
   - Toggle: copy a `.setting.toggle` block, set `data-set-bool="<key>"` —
     wiring is generic, no extra JS.
   - Number/select: `data-set="<key>"`. String enum: `data-set-str="<key>"`.

7. **Verify** — `npm run verify` (or `verify:offline` + say so). If the
   setting changes governor behavior, also eyeball it live: `npm start`.

Done means: defaults + validation + a consuming code path + a test + a
control in Settings, all in one PR.
