// Make sure Electron's own licence files are on disk before electron-builder
// packs (0.3.3). electron-builder.yml copies node_modules/electron/dist/LICENSE
// and LICENSES.chromium.html into every package, but Electron 44 downloads
// its dist/ folder on first use, not at `npm ci`, and electron-builder only
// warns ("file source doesn't exist") when a source is missing, so a build
// could ship without them. This fetches Electron for this machine (the
// licence files are the same on every OS) and fails if they are still absent.
//
//   node scripts/electron-licences.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'node_modules', 'electron', 'dist');
const wanted = ['LICENSE', 'LICENSES.chromium.html'];
const missing = () => wanted.filter((f) => !fs.existsSync(path.join(dist, f)));

if (missing().length) {
  const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('electron-licences: installing Electron failed'); process.exit(1); }
}
const still = missing();
if (still.length) {
  console.error(`electron-licences: missing ${still.map((f) => path.join(dist, f)).join(', ')}`);
  process.exit(1);
}
console.log('electron-licences: LICENSE and LICENSES.chromium.html are in node_modules/electron/dist');
