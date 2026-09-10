# ADR-0010: Website — static files in-repo, GitHub Pages, guarded by a check script

Date: 2026-08-18 · Status: accepted

## Decision

The project website (R-123) is hand-written static HTML + CSS in `site/`,
in this repository, deployed to GitHub Pages by its own workflow
(`.github/workflows/pages.yml`). No generator, no framework, no
dependencies — ADR-0003's "what's in `src/` is what runs" extends to
"what's in `site/` is what serves." Every deploy is gated by
`scripts/check-site.mjs`, a zero-dependency Node script.

## Why in-repo

One review surface for a solo maintainer, and the release playbook can
require site + `package.json` version to move in the same commit — a
separate repo can't enforce that. `docs/` stays engineering documentation;
branch-based Pages would have published that whole tree.

## Why no generator

A static-site generator is a devDependency (each needs an ADR, invariant
#6) buying indirection this site doesn't need: it is two pages. Hand-written
HTML is also the easiest artifact for an AI agent to maintain and the
easiest for a visitor to audit ("view source — it's the whole thing").

Re-examined 2026-09-05 against Astro 6 + Starlight 0.39 (the stack a
comparable project uses on Cloudflare Pages' free tier). Still no: Starlight's
wins — search, sidebar nav, auto-generated API reference — all assume a
many-page docs corpus, and Raha has neither the pages nor a public API. The
cost is specific rather than philosophical: `pages.yml` runs
`node scripts/check-site.mjs` with no `npm ci` at all, so the job holding
`pages: write` and `id-token: write` — the job that publishes the page handing
strangers an installer — executes zero third-party code. A generator would put
several hundred transitive packages inside it. Starlight's search is also WASM,
which would force `'wasm-unsafe-eval'` into a policy that is currently
`default-src 'none'`.

## Why the check script gates deploys

"Private is a checkable property, not a marketing word" applies to the
site too. The script enforces: a link allow-list (relative-and-exists,
in-page, or the sanctioned external URLs — no shields.io, no fonts, no
third-party anything), version parity with `package.json`, byte-parity of
image copies with their sources (`docs/screenshots/`, `build/icon.png`),
a banned-phrase lint ("zero network", "100% private", …), anchor
integrity, and CSP integrity (`script-src` carries the sha256 of the one
inline script rather than `'unsafe-inline'`; a stale hash is invisible in the
browser — the page still works, the OS picker just stops — so the script
recomputes it). The workflow triggers on `package.json` and
`docs/screenshots/**` on purpose: a release bump or screenshot refresh
that forgets the site turns the deploy red instead of stranding a stale
site.

## Consequences

- Download cards link to **version-pinned asset URLs**, not `releases/latest`.
  This reverses what this ADR first recorded, and the reversal is the part
  worth keeping: pinned links are safe here only because
  `electron-builder.yml` pins the artifact names (`artifactName:
  Raha-Setup-${version}.${ext}` for nsis; the dmg / AppImage / deb defaults
  are equally deterministic), and because `scripts/check-site.mjs` section 2b
  regenerates the expected five filenames from `package.json` and fails the
  deploy when page and version disagree. A link that would rot is now a red
  build rather than a visitor's 404. `releases/latest` is still linked once,
  below the cards, as the checksums-and-everything-else route.
  What did NOT change: the page never fetches release metadata at runtime —
  a client-side GitHub-API call would put a third-party request on page load
  and break the site's own privacy line. Note the gate checks link *shape*,
  never *existence*: it passes green on a site whose downloads 404 because
  the release has not been cut yet (release playbook step 7 is what catches
  that).
- The absolute self-URL (`magronox.github.io/raha-browser`) exists only in
  the two Open Graph metas; a custom domain later = edit those two lines +
  add `site/CNAME` + DNS.
- The site is **two pages** (2026-09-05): `index.html` is a short front page —
  what you can do, the download, one link — and `details.html` carries the
  governor's precedence rules, the privacy table, the security section, the
  keyboard map and the support explanation. The front page went from 6.2
  screens to 2.6. The split is why `check-site.mjs` now runs every section
  against every `site/*.html` rather than `index.html` alone: a second page
  that quietly escaped the link allow-list, the banned-phrase lint or the CSP
  pin would be exactly the drift the script exists to catch. It also resolves
  cross-page anchors (`details.html#support`), so renaming a section there
  fails the deploy instead of stranding a link here.
- `details.html` carries no inline script at all, so its CSP is
  `script-src 'none'`. Only the front page needs the OS picker.
- `ci.yml` ignores `site/**` (the site has no tests there); if branch
  protection ever requires the verify check, site-only PRs will show it
  skipped — acceptable for a solo repo.
