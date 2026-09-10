# ADR-0002: GPL-3.0-only + reserved trademark

Date: 2026-07-19 · Status: accepted

## Decision
Code: GPL-3.0-only, copyright Amir Basareh. Name/logo: NOT licensed —
TRADEMARK.md reserves "Raha" and the bird mark; forks must rebrand.

## Context
The maintainer's requirement: maximum protection of the code and the name;
nobody may take the work closed or claim it as theirs.

- GPL-3.0 forces every distributed fork to stay open source, preserve
  copyright notices, and license derivatives identically. Permissive
  licenses (MIT/Apache) allow closed commercial forks — rejected for this
  goal. AGPL adds only network-service terms irrelevant to a desktop app.
- No code license protects a NAME; that is trademark. The Firefox/Rust
  pattern (open code, reserved marks) covers it: GPLv3 §7(e) explicitly
  permits declining to grant trademark rights.

## Consequences
- Dependencies must be GPL-3-compatible. Electron (MIT), Chromium (BSD) are.
  MPL-2.0 (e.g. Ghostery adblocker, for R-102) is compatible. Check before
  adding anything (part of the new-dependency ADR).
- Contributions are accepted under GPL-3.0-only ("inbound = outbound",
  stated in CONTRIBUTING.md); no CLA for now — this also means the license
  can't easily change later, which is a feature given the goal.
- SPDX header `GPL-3.0-only` is in package.json; per-file headers are not
  required (LICENSE at root governs).
