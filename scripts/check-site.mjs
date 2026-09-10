// Website guard (R-123): the site must practice what the browser preaches.
// Zero dependencies on purpose — run by the Pages workflow before every
// deploy and locally via `node scripts/check-site.mjs`.
//
// Every check runs against EVERY site/*.html page, not just index.html. A
// second page that quietly escaped the link allow-list, the banned-phrase
// lint or the CSP pin would be exactly the invisible drift this script
// exists to prevent, so adding a page must never mean adding a blind spot.
//
// Checks:
//   1. link policy — every href/src is an in-page anchor, a relative path
//      that exists under site/, or an allow-listed URL. No shields.io, no
//      fonts, no third-party anything. (Open Graph metas are the one
//      sanctioned absolute self-URL spot.)
//   2. version — site data-version == package.json version (release playbook
//      step 3 updates both in one commit).
//   2b. download links — pinned to this version's real electron-builder
//      artifact names, counted across the whole site.
//   3. asset drift — site/assets images byte-identical to their sources
//      (docs/screenshots, build/icon.png).
//   4. language — banned overclaims (invariant #6 ethos) never appear.
//   5. anchors — in-page (#id) and cross-page (other.html#id) both resolve.
//   6. CSP integrity — each page's script-src pins the sha256 of that page's
//      inline scripts, so 'unsafe-inline' stays out of the policy. A stale
//      hash fails SILENTLY in the browser (the page still works, the OS
//      picker just stops), which is precisely why it is checked here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(repo, 'site');
const pageFiles = fs.readdirSync(siteDir).filter((f) => f.endsWith('.html')).sort();

/** @type {string[]} */ const problems = [];
const at = (file, msg) => problems.push(`${file}: ${msg}`);

if (!pageFiles.includes('index.html')) problems.push('site/index.html is missing');
const pages = pageFiles.map((file) => ({ file, html: fs.readFileSync(path.join(siteDir, file), 'utf8') }));

// --- 1. link policy -------------------------------------------------------
const ALLOWED_EXTERNAL = [
  'https://github.com/Magronox/raha-browser', // repo, blob/…, releases, issues, advisories
  'https://github.com/sponsors/Magronox',     // joins when Sponsors enrollment clears
  'https://venmo.com/u/magronox',  // R-124 support rail
  'mailto:basareh@duck.com',       // the maintainer's contact address (SECURITY.md, package.json)
];
const SELF_ABSOLUTE = 'https://magronox.github.io/raha-browser/'; // og: metas only

// href/src/srcset are always link-shaped (either quote style); content="…"
// only counts when it carries a scheme (og:url / og:image) — descriptions and
// CSP text are not links.
const linkUrls = (html) => [
  ...[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/(?:href|src)='([^']+)'/g)].map((m) => m[1]),
  ...[...html.matchAll(/srcset=["']([^"']+)["']/g)]
    .flatMap((m) => m[1].split(',').map((c) => c.trim().split(/\s+/)[0])),
  ...[...html.matchAll(/content=["'](https?:[^"']+)["']/g)].map((m) => m[1]),
];

const checkUrl = (file, source, u) => {
  if (u.startsWith('#')) return; // in-page; existence checked in section 5
  if (/^[a-z][a-z+.-]*:/i.test(u)) {
    if (ALLOWED_EXTERNAL.some((a) => u === a || u.startsWith(a + '/'))) return;
    if (u === SELF_ABSOLUTE || u.startsWith(SELF_ABSOLUTE)) {
      // EVERY occurrence of the absolute self-URL must sit on an og: meta line.
      const carriers = source.split('\n').filter((l) => l.includes(u));
      if (!carriers.length || !carriers.every((l) => l.includes('property="og:'))) {
        at(file, `absolute self-URL outside og: metas: ${u}`);
      }
      return;
    }
    at(file, `external URL not on the allow-list: ${u}`);
    return;
  }
  // Relative: must exist under site/.
  const clean = u.split('#')[0].split('?')[0];
  if (clean && !fs.existsSync(path.join(siteDir, clean))) at(file, `relative link to missing file: ${u}`);
};

for (const { file, html } of pages) for (const u of linkUrls(html)) checkUrl(file, html, u);
// CSS files are scanned for url(...) references too.
for (const cssFile of fs.readdirSync(siteDir).filter((f) => f.endsWith('.css'))) {
  const css = fs.readFileSync(path.join(siteDir, cssFile), 'utf8');
  for (const [, ref] of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) checkUrl(cssFile, css, ref.trim());
}

// --- 2. version -----------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
let versionsSeen = 0;
for (const { file, html } of pages) {
  for (const [, v] of html.matchAll(/data-version="([^"]+)"/g)) {
    versionsSeen++;
    if (v !== pkg.version) at(file, `site version ${v} != package.json ${pkg.version} (release playbook step 3)`);
  }
}
if (!versionsSeen) problems.push('no page carries a data-version attribute');

// --- 2b. download links ---------------------------------------------------
// Every per-asset link must point at THIS version's release and at a file
// name electron-builder actually produces (electron-builder.yml: mac dmgs
// for x64/arm64, pinned nsis artifactName, AppImage + deb defaults). A version
// bump that forgets the links, or a renamed artifact, fails the deploy here
// instead of 404ing for visitors. Counted site-wide: the cards may live on
// any page, but all five must exist somewhere and the picker needs all five ids.
const EXPECTED_ASSETS = new Set([
  `Raha-${pkg.version}-arm64.dmg`,
  `Raha-${pkg.version}.dmg`,
  `Raha-Setup-${pkg.version}.exe`,
  `Raha-${pkg.version}.AppImage`,
  `raha-browser_${pkg.version}_amd64.deb`,
]);
const seenAssets = new Set();
const dataAssets = new Set();
for (const { file, html } of pages) {
  for (const [, ver, name] of html.matchAll(/href="https:\/\/github\.com\/Magronox\/raha-browser\/releases\/download\/v([^/"]+)\/([^"]+)"/g)) {
    if (ver !== pkg.version) at(file, `download link for v${ver} but package.json is ${pkg.version}: ${name}`);
    if (!EXPECTED_ASSETS.has(name)) at(file, `download link names an asset the build does not produce: ${name}`);
    seenAssets.add(name);
  }
  for (const [, id] of html.matchAll(/data-asset="([^"]+)"/g)) dataAssets.add(id);
}
for (const a of EXPECTED_ASSETS) if (!seenAssets.has(a)) problems.push(`no download link for ${a}`);
for (const id of ['mac-arm64', 'mac-x64', 'win-x64', 'linux-appimage', 'linux-deb']) {
  if (!dataAssets.has(id)) problems.push(`download card missing data-asset="${id}" (the OS picker script targets it)`);
}

// --- 3. asset drift -------------------------------------------------------
const PAIRS = [
  ['site/assets/grid.png', 'docs/screenshots/grid.png'],
  ['site/assets/settings.png', 'docs/screenshots/settings.png'],
  ['site/assets/icon.png', 'build/icon.png'],
];
for (const [copy, source] of PAIRS) {
  const a = path.join(repo, copy);
  const b = path.join(repo, source);
  if (!fs.existsSync(a)) { problems.push(`missing ${copy}`); continue; }
  if (!fs.existsSync(b)) { problems.push(`missing source ${source}`); continue; }
  if (!fs.readFileSync(a).equals(fs.readFileSync(b))) {
    problems.push(`${copy} differs from ${source} — re-copy (release playbook step 1c)`);
  }
}

// --- 4. banned phrases ----------------------------------------------------
const BANNED = [
  /zero network/i, /no network requests/i, /completely secure/i,
  /100% private/i, /unhackable/i, /military[- ]grade/i, /\banonymous\b/i,
];
for (const { file, html } of pages) {
  for (const re of BANNED) {
    const hit = html.match(re);
    if (hit) at(file, `banned phrase (invariant #6 ethos): "${hit[0]}"`);
  }
}

// --- 5. anchors -----------------------------------------------------------
// In-page (#id) and cross-page (other.html#id) both resolve. A cross-page
// anchor is how the landing page points into the details page, so a renamed
// section there must not silently strand a link here.
const idsByPage = new Map(pages.map(({ file, html }) =>
  [file, new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]))]));
for (const { file, html } of pages) {
  for (const [, href] of html.matchAll(/href="([^"]*#[^"]*)"/g)) {
    const hash = href.indexOf('#');
    const target = href.slice(0, hash);
    const anchor = href.slice(hash + 1);
    if (!anchor) continue;
    if (/^[a-z][a-z+.-]*:/i.test(target)) continue; // external URL fragment — not ours to verify
    const page = target === '' ? file : target.split('?')[0];
    const ids = idsByPage.get(page);
    if (!ids) continue; // missing file already reported by section 1
    if (!ids.has(anchor)) at(file, `anchor #${anchor}${target ? ` in ${page}` : ''} has no matching id`);
  }
}

// --- 6. CSP integrity -----------------------------------------------------
// Each page's script-src carries the sha256 of its own inline blocks instead
// of 'unsafe-inline'. Chromium enforces this: edit a script without
// recomputing the hash and the browser refuses to run it — the download cards
// still work (it is progressive enhancement) but the OS picker quietly dies.
// Recompute here so that drift is a red deploy, not a silent regression.
for (const { file, html } of pages) {
  const cspMeta = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/);
  if (!cspMeta) { at(file, 'no Content-Security-Policy meta'); continue; }
  const csp = cspMeta[1];
  const declared = [...csp.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((x) => x[1]);
  const actual = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((x) => crypto.createHash('sha256').update(x[1], 'utf8').digest('base64'));
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) {
    at(file, "CSP script-src allows 'unsafe-inline' — pin each inline script by sha256 instead");
  }
  for (const a of actual) {
    if (!declared.includes(a)) at(file, `inline <script> not covered by the CSP — add 'sha256-${a}' to script-src`);
  }
  for (const d of declared) {
    if (!actual.includes(d)) at(file, `CSP declares 'sha256-${d}' but no inline <script> hashes to it`);
  }
}

// --- report ---------------------------------------------------------------
if (problems.length) {
  console.error(`check-site: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-site: ok — ${pages.length} page(s) [${pageFiles.join(', ')}] (links, version, download links, assets, language, anchors, csp)`);
