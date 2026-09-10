// Fetch the Electron binary WITHOUT npm, via the GitHub API (works in
// sandboxes where registry.npmjs.org is blocked but api.github.com is not).
// Result: vendor/electron/electron — then `vendor/electron/electron .` runs
// the app. Normal dev machines should just use `npm install` instead.
//
// Usage: node scripts/get-electron.mjs [version]   (default: the version
// pinned in package.json devDependencies.electron)
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = process.argv[2] || pkg.devDependencies.electron.replace(/^[^\d]*/, '');
const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const assetName = `electron-v${version}-${platform}-${arch}.zip`;
const vendorDir = path.join(repoRoot, 'vendor');
const outZip = path.join(vendorDir, assetName);
const outDir = path.join(vendorDir, 'electron');

if (existsSync(path.join(outDir, platform === 'win32' ? 'electron.exe' : 'electron'))) {
  console.log(`electron already vendored at ${outDir}`);
  process.exit(0);
}
mkdirSync(vendorDir, { recursive: true });

/** @type {Record<string, string>} */
const headers = { 'user-agent': 'raha-get-electron', accept: 'application/vnd.github+json' };
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (token) headers.authorization = `Bearer ${token}`;

console.log(`fetching release metadata for electron v${version}…`);
const relRes = await fetch(`https://api.github.com/repos/electron/electron/releases/tags/v${version}`, { headers });
if (!relRes.ok) throw new Error(`release lookup failed: ${relRes.status} ${await relRes.text()}`);
const release = await relRes.json();
const asset = release.assets.find((/** @type {any} */ a) => a.name === assetName);
if (!asset) throw new Error(`asset ${assetName} not found in release v${version}`);

console.log(`downloading ${assetName} (${Math.round(asset.size / 1e6)} MB) via api.github.com…`);
const dlRes = await fetch(`https://api.github.com/repos/electron/electron/releases/assets/${asset.id}`, {
  headers: { ...headers, accept: 'application/octet-stream' },
});
if (!dlRes.ok || !dlRes.body) throw new Error(`asset download failed: ${dlRes.status}`);

const file = createWriteStream(outZip);
const { Readable } = await import('node:stream');
const { pipeline } = await import('node:stream/promises');
await pipeline(Readable.fromWeb(/** @type {any} */ (dlRes.body)), file);

console.log('unzipping…');
mkdirSync(outDir, { recursive: true });
execSync(`unzip -oq ${JSON.stringify(outZip)} -d ${JSON.stringify(outDir)}`, { stdio: 'inherit' });
console.log(`done: ${outDir}/electron`);
console.log('run the app:   ./vendor/electron/electron .');
console.log('run smoke:     RAHA_PROFILE_DIR=/tmp/raha-smoke ./vendor/electron/electron . --raha-smoke');
