// Compile EasyList + EasyPrivacy into the serialized engines Raha ships
// (ADR-0009). DEV-TIME ONLY: this script fetches from easylist.to; the app
// itself NEVER downloads lists (docs/INVARIANTS.md #6) — it deserializes the
// artifacts this script checks in. Run it per release (docs/PLAYBOOKS/
// release.md) and after any @ghostery/adblocker version bump (the serialized
// format is version-locked: a bumped package refuses old artifacts, which is
// exactly what tests/unit/blocklist-artifacts.test.js turns red on).
//
// Usage:
//   npm run blocklists                 fetch fresh lists, rebuild everything
//   npm run blocklists -- --from-local rebuild engines from the checked-in
//                                      .txt files, no network (use this on
//                                      Dependabot bumps of the adblocker)
//
// Outputs:
//   assets/blocklists/{easylist,easyprivacy}.txt        raw lists (auditable, NOT shipped)
//   src/main/electron/data/{easylist,easyprivacy}.engine serialized engines (shipped in the asar)
//   src/main/electron/data/blocklists.json               provenance manifest (shipped)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FiltersEngine, Request } from '@ghostery/adblocker';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = path.join(repoRoot, 'assets', 'blocklists');
const dataDir = path.join(repoRoot, 'src', 'main', 'electron', 'data');
const fromLocal = process.argv.includes('--from-local');

// Config MUST stay in sync with the re-parse in
// tests/unit/blocklist-artifacts.test.js — the byte-for-byte provenance test
// fails loudly if the two drift. (Not exported: importing this module runs
// the build, so the test keeps its own copy.)
const ENGINE_CONFIG = { loadCosmeticFilters: false, loadGenericCosmeticsFilter: false, enableCompression: true };
const LISTS = [
  { name: 'easylist', url: 'https://easylist.to/easylist/easylist.txt' },
  { name: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
];

const sha256 = (/** @type {string|Uint8Array} */ data) => createHash('sha256').update(data).digest('hex');

mkdirSync(rawDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

/** @type {Record<string, { source: string, sha256: string, rawBytes: number, engineBytes: number }>} */
const manifestLists = {};
/** @type {Record<string, InstanceType<typeof FiltersEngine>>} */
const engines = {};

for (const { name, url } of LISTS) {
  const rawPath = path.join(rawDir, `${name}.txt`);
  let text;
  if (fromLocal) {
    text = readFileSync(rawPath, 'utf8');
    console.log(`${name}: using checked-in ${path.relative(repoRoot, rawPath)} (${text.length} bytes)`);
  } else {
    console.log(`${name}: fetching ${url} …`);
    const res = await fetch(url, { headers: { 'user-agent': 'raha-build-blocklists' } });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`);
    text = await res.text();
    if (text.length < 100_000) throw new Error(`${name}: suspiciously small (${text.length} bytes), refusing`);
    writeFileSync(rawPath, text);
  }
  const engine = FiltersEngine.parse(text, ENGINE_CONFIG);
  const bytes = engine.serialize();
  writeFileSync(path.join(dataDir, `${name}.engine`), bytes);
  engines[name] = engine;
  manifestLists[name] = { source: url, sha256: sha256(text), rawBytes: text.length, engineBytes: bytes.length };
  console.log(`${name}: engine ${(bytes.length / 1024 / 1024).toFixed(2)} MB from ${(text.length / 1024 / 1024).toFixed(2)} MB of rules`);
}

// Self-check: a freshly built pair of engines must block the canonical
// offenders and leave benign third parties alone, or the download was junk.
const req = (/** @type {string} */ u) => Request.fromRawDetails({ url: u, type: 'script', sourceUrl: 'https://news.example.com/' });
const mustBlock = ['https://ad.doubleclick.net/adj/x.js', 'https://www.googletagmanager.com/gtm.js'];
const mustPass = ['https://cdn.jsdelivr.net/npm/lib.min.js', 'https://api.github.com/repos'];
for (const u of mustBlock) {
  if (!engines.easylist.match(req(u)).match && !engines.easyprivacy.match(req(u)).match) {
    throw new Error(`self-check failed: neither engine blocks ${u}`);
  }
}
for (const u of mustPass) {
  if (engines.easylist.match(req(u)).match || engines.easyprivacy.match(req(u)).match) {
    throw new Error(`self-check failed: an engine blocks benign ${u}`);
  }
}
console.log('self-check: canonical block/pass URLs behave');

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
writeFileSync(
  path.join(dataDir, 'blocklists.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), adblockerVersion: pkg.dependencies['@ghostery/adblocker'], lists: manifestLists }, null, 2) + '\n',
);
console.log(`manifest written; adblocker ${pkg.dependencies['@ghostery/adblocker']}`);
