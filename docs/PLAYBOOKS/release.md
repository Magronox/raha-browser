# Playbook: cut a release

Releases are built by `.github/workflows/release.yml` on tag push: Linux
(AppImage, deb), Windows (nsis), macOS (dmg+zip — signed and notarized once
the secrets below exist, unsigned but working until then).

## macOS signing and notarization (R-108)

The build side is wired and inert: with no secrets set, the macOS job prints a
warning, builds the same ad-hoc-signed app it always did, and the signature
guard step skips itself. Nothing here has to be undone to ship unsigned.

**The owner sets these once, in the repo's Settings → Secrets and variables →
Actions.** They come from an Apple Developer Program membership (individual
is fine; enrolment takes 1–5 days).

| Kind | Name | Value |
|---|---|---|
| Secret | `CSC_LINK` | Developer ID Application cert exported from Keychain Access as `.p12`, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| Secret | `CSC_KEY_PASSWORD` | the password used for that `.p12` export |
| Secret | `APPLE_API_KEY_P8` | the *contents* of the App Store Connect `.p8` key (CI writes it to a file; `APPLE_API_KEY` then points at that path) |
| Secret | `APPLE_API_KEY_ID` | that key's Key ID |
| Secret | `APPLE_API_ISSUER` | that key's Issuer ID (a UUID) |
| Variable | `APPLE_TEAM_ID` | the 10-character Team ID from Membership details |

Create the App Store Connect API key with the **Developer** role, at
<https://appstoreconnect.apple.com/access/integrations/api> — the `.p8`
downloads exactly once.

Two things worth knowing before trusting a green build:

- **electron-builder only *warns* when notarization credentials are missing**
  — it does not fail. That is why the workflow has an explicit
  `codesign --verify` / `stapler validate` / `spctl --assess` guard step. A
  release is only notarized if that step ran and passed.
- The macOS build step is **separate from Linux/Windows on purpose**: the
  Windows signer falls back from `WIN_CSC_LINK` to `CSC_LINK`, so a mac
  certificate visible to the Windows job would make it try to sign with it.

`APPLE_TEAM_ID` also reaches two places that need it: the entitlements plist
(`build/entitlements.mac.plist`, rendered at build time from the committed
`.in` template by `scripts/mac-entitlements.mjs`, because electron-builder does
not expand Xcode's `$(AppIdentifierPrefix)`), and the packaged `package.json`
via `-c.extraMetadata.teamId`, which is how the app will read its own
keychain-access-group for Touch ID passkeys.

0. **First release only — clear the stale v0.1.0.** *Done 2026-08: the
   pre-audit tag and draft were deleted on both sides and the README note
   removed; no tag or release exists. Kept for the record — if a stale
   tag/draft ever reappears:*
   ```
   gh release delete v0.1.0 --yes
   git push --delete origin v0.1.0
   git tag -d v0.1.0
   ```

1. **Green main.** CI on `main` must be green. No exceptions. Green CI now
   INCLUDES the automated security gate (`tests/e2e/security-qa.spec.js` —
   the machine twin of the hands-on page): every audit check runs on every
   push. The manual page (`npm run qa`) remains for exploratory/visual
   passes — Keychain prompts, GPU feel, things a bot can't judge — but is
   no longer the release gate.

1b. **Refresh blocklists** (ADR-0009 — the shipped EasyList/EasyPrivacy
   engines are frozen at build time, so a release is when they update):
   ```
   npm run blocklists
   git diff --stat assets/blocklists src/main/electron/data
   git add assets/blocklists src/main/electron/data
   git commit -m "Refresh EasyList/EasyPrivacy artifacts"
   ```
   Eyeball the diff stat (a list shrinking to near-zero means a broken
   download — the script's self-check should catch it, but look anyway).
   After a `@ghostery/adblocker` version bump, regenerate WITHOUT network:
   `npm run blocklists -- --from-local`.

1c. **Site screenshots.** If screenshots were regenerated this cycle
   (`RAHA_SHOTS=1 npm run test:ui`), re-copy them so the website doesn't
   drift (the Pages workflow's check fails on byte mismatch):
   ```
   cp docs/screenshots/grid.png docs/screenshots/settings.png site/assets/
   git add site/assets && git commit -m "Site: refresh screenshots"
   ```

1d. **Live bot-check pass.** Run from source with a throwaway profile
   (`RAHA_PROFILE_DIR=$(mktemp -d) npm start`) against a real
   Cloudflare-challenged URL (an openreview.net forum link that bounces
   through `/challenge?redirect=…` is a known one) and confirm the redirect
   lands on the real page. The automated suite proves headers and the
   in-page view agree on the wire; only a live challenge proves the
   outcome — never claim a challenge fix without this.

2. **Changelog.** Add a section to `CHANGELOG.md`:
   ```
   ## v0.2.0 — 2026-08-…
   ### Added / Changed / Fixed
   - …user-visible sentences, not commit messages…
   ```

3. **Version bump** (keep tag == package.json, the workflow enforces it).
   Also update the `data-version` attribute in `site/index.html` in the same
   commit — `scripts/check-site.mjs` (run by the Pages workflow) fails the
   deploy when the site version ≠ package.json:
   ```
   npm version 0.2.0 --no-git-tag-version
   git add package.json CHANGELOG.md site/index.html
   git commit -m "Release v0.2.0"
   git push
   ```

4. **Tag:**
   ```
   git tag v0.2.0
   git push origin v0.2.0
   ```

5. **Watch** the Release workflow (three OS jobs, ~10-20 min). electron-builder
   uploads artifacts to a DRAFT GitHub release for this tag.

6. **Publish**: open the draft release on GitHub, paste the changelog section
   as the body, publish.

7. **Post-flight**: download the AppImage/exe from the release page onto a
   real machine and do the 2-minute manual pass:
   open 5 tabs with cap 3 → oldest sleeps with toast → wake by click →
   pin survives pressure → relaunch restores everything asleep.
   On the live site: the three download cards land on the new release, the
   version string matches the tag, and the per-OS unsigned-install
   instructions still match reality — the day R-108 signing ships, DELETE
   the right-click→Open and SmartScreen lines from the site.

8. **Post-publish.**
   - Auto-update: launch the PREVIOUS version somewhere and confirm it sees
     the new release (macOS is notify-only until R-108).
   - Website: confirm download links resolve to the new assets.
   - Announce checklist (launch releases only): website live, support link
     live, then post. Never announce before the download story works
     end-to-end.

Versioning: 0.x while pre-1.0; bump minor for features, patch for fixes.
If a release workflow fails on ONE OS only, fix forward (new patch tag) —
never re-tag the same version.
