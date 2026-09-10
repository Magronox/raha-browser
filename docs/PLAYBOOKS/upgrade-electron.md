# Playbook: upgrade Electron

> **Triage notes from the 43.1.1 → 43.2.0 bump (2026-07-28).** Two mistakes
> are easy to make when judging a Dependabot Electron PR:
> 1. **A patch bump can span several Chrome stable releases.** 43.2.0 rolled
>    Chromium .114 → .129, i.e. *two* Chrome stable updates and 22 CVEs — a
>    bigger exposure window than "one patch" suggests. Diff the Chromium
>    version (`process.versions.chrome`), not just the Electron version.
> 2. **Linux-only fixes are in scope.** electron-builder ships AppImage + deb,
>    release.yml builds all three OSes, and ci.yml runs Linux *exclusively* —
>    so Linux is both a shipped target and the only platform CI covers. Judge
>    such commits on whether Raha calls the API, never on "we're a Mac shop".
>
> Also: Dependabot's green CI may have run against an **older base**. Check
> `gh pr view N --json baseRefOid` and `gh pr update-branch N` before trusting
> it — see the note in `release.md` about what CI actually validated.

Electron is pinned exactly in package.json. Patch/minor bumps are routine;
MAJOR bumps are a dedicated task — Chromium changes underneath and the
adapter layer is our only exposure.

## Patch/minor (e.g. 43.1.1 → 43.2.0)

1. Edit the pin in package.json, `npm install`, `npm run verify`, done.

## Major (e.g. 43 → 44)

1. **Read the release notes** for EVERY major you cross:
   https://www.electronjs.org/docs/latest/breaking-changes
   List anything touching: BaseWindow, WebContentsView, webContents,
   navigationHistory, session/webRequest/permissions, protocol.handle,
   app.getAppMetrics, contextBridge/preload sandboxing.

2. **Audit our exposure** — the complete list of Electron API touchpoints is
   `src/main/electron/*.js` + `src/main/index.js` + `src/preload/ui.cjs`
   (~600 lines total; grep for each API from your breaking list).

3. Bump the pin, `npm install`.

4. `npm run verify` — then ALSO the smoke test on a real display if you have
   one (`npm run smoke`), because e2e under xvfb can mask GPU/compositing
   issues.

5. **Renderer-behavior checks** (manual, 5 min): thumbnails still capture on
   switch-away; audio badge appears on a YouTube tab; sleep actually removes
   the process (`app.getAppMetrics` count drops — the e2e asserts this too).

6. **Chrome-identity fidelity** (ADR-0012): `src/shared/client-hints.js`
   re-implements Chromium's brand tables (GREASE, brand order,
   platform-version mapping, the set of high-entropy hints) and is verified
   against a specific Chromium tag — re-check them against the new tag's
   `components/embedder_support/user_agent_utils.cc`, and confirm the
   R-114 e2e tests still pass against the real wire. Then:
   - confirm the bundled Chromium version (`process.versions.chrome`) is
     one Google shipped as a Chrome stable (chromiumdash.appspot.com →
     Releases); an unshipped patch level goes out verbatim in
     `Sec-CH-UA-Full-Version-List` (ADR-0012, divergence 3) — note it in
     the changelog if it is not;
   - if the Chromium major changed, the brand ORDER changed (it is
     `major % 6`): the recomputed headers follow automatically, but
     re-run the side-by-side spike against an installed Chrome of the same
     major to confirm which request kinds carry hints (at 150: never
     WebSocket handshakes or worker requests) and which high-entropy
     hints it sends when asked.

7. Update the version in this repo's docs if referenced, note the bump in
   CHANGELOG.md under Changed.

8. One PR, subject `Upgrade Electron 43 → 44`, body = your breaking-changes
   audit list with each item checked off. Never mix an Electron major with
   feature work.
