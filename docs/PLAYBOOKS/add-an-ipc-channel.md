# Playbook: add an IPC channel

Exactly five files change. Never write the channel string anywhere else —
`tests/unit/boundaries.test.js` greps for stray literals and will fail you.

Example: `tab:duplicate` — UI asks main to duplicate a tab.

1. **Contract** — `src/shared/ipc-contract.js`
   ```js
   tabDuplicate: 'tab:duplicate',   // ({tabId}) -> {tabId}  (in INVOKE)
   ```
   Document payload/response in the trailing comment, like the others.
   (main → UI pushes go in `EVENT` instead.)

2. **Engine method** — `src/main/core/engine.js`
   Add `tabDuplicate({ tabId })` doing the actual work (pure orchestration,
   ports only). Return a plain serializable object; `{ error: '...' }` for
   failures — never throw across IPC.

3. **Main handler** — `src/main/electron/ipc.js`
   ```js
   [INVOKE.tabDuplicate]: (p) => engine.tabDuplicate(p),
   ```

4. **UI wrapper** — `src/ui/api.js`
   ```js
   tabDuplicate: (tabId) => bridge().invoke(INVOKE.tabDuplicate, { tabId }),
   ```

5. **Harness mock** — `tests/ui/mock-bridge.mjs`
   Same one-liner as step 3. The harness test "IPC contract coverage" fails
   until you do — that's the point.

6. **Tests**
   - Engine behavior: `tests/unit/engine.test.js`.
   - If the UI grows a button for it: a ui-harness interaction test.

7. `npm run verify`.

Notes:
- You still never touch the preload (`src/preload/ui.cjs`) for a new channel —
  but not because it forwards anything. It forwards only channels on the
  allow-list, and that list is `Object.values(INVOKE)`/`EVENT` handed down
  from the contract at window creation, so step 1 already added yours. If a
  channel silently rejects with "not an IPC contract channel", you added it
  somewhere other than `src/shared/ipc-contract.js`.
- Payloads are untrusted-ish: validate ids/numbers inside the engine method
  (look at `tabSetMemLimit` for the pattern).
