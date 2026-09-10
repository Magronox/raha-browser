# Playbook: first push — DONE (kept as a record)

**This playbook is complete. Do not follow it.** For an actual release, use
**[release.md](release.md)**.

## What happened

The repository `github.com/Magronox/raha-browser` was created on 2026-09-10
from a single snapshot commit of the audited, CI-green tree, so its history
begins at v0.1.0's pre-release state. Nothing depends on anything earlier:
every playbook, ADR and test refers to files, not to commits.

| Step | Status |
|---|---|
| Create the repo, push `main` | **Done** — `main` tracks `origin/main`; `homepage` and `repository.url` in package.json point at it |
| Actions permissions | **Done** — workflow token is read-only repo-wide; `release.yml` carries its own scoped `contents: write`, `pages.yml` its `pages: write` + `id-token: write` |
| Lockfile + `npm ci` in workflows | **Done** — both workflows use `npm ci --no-fund --no-audit` with `cache: npm` |
| CI green on the snapshot | Verify on the Actions tab before tagging (release.md step 1) |
| Labels, milestone, launch issues | **Done** — `launch`, `agent-ready`; milestone `v0.1.0-launch` |
| Ship v0.1.0 | Follow [release.md](release.md) steps 1d → 8 |
| Branch protection, topics, discussions | The maintainer's call; none required for a solo repo |
