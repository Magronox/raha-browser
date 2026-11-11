// Write THIRD_PARTY_NOTICES.txt: every component Raha ships that someone
// else wrote, with its licence text and where its source lives.
//
//   node scripts/third-party-notices.mjs          # rewrite the file
//   node scripts/third-party-notices.mjs --check  # exit 1 if it is out of date
//
// It ships inside every build (electron-builder `extraResources`), next to
// Electron's own LICENSE and Chromium's LICENSES.chromium.html. Run it after
// any change to the runtime dependencies; tests/unit/notices.test.js fails
// when a runtime package is missing from the committed file.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceUrl } from './repo-url.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'THIRD_PARTY_NOTICES.txt');
const RULE = '='.repeat(78);

/** Production dependency directories, as npm resolves them. */
function runtimeDirs() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter((l) => l && l !== root).sort();
}

/** @param {string} dir */
function licenceText(dir) {
  const name = fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f));
  return name ? fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim() : '';
}


const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const lists = JSON.parse(fs.readFileSync(path.join(root, 'src/main/electron/data/blocklists.json'), 'utf8'));

const parts = [`Raha: third-party notices
${RULE}

Raha itself is Copyright (c) 2026 Amir Basareh. This file lists the
components inside this build that were written by others, the terms they
come under, and where their source code is.

${RULE}
Electron and Chromium
${RULE}

Raha runs on Electron ${electronVersion} (MIT licence), which contains Chromium and Node.js
and their own third-party components. Their full licence texts ship next to
this file:

  LICENSE.electron.txt        Electron's licence
  LICENSES.chromium.html      Chromium and everything inside it

Source: https://github.com/electron/electron/tree/v${electronVersion}
        (the Chromium, Node.js and FFmpeg revisions it builds are pinned there)

${RULE}
Filter lists: EasyList and EasyPrivacy
${RULE}

The ad and tracker blocking uses EasyList and EasyPrivacy,
(c) The EasyList authors (https://easylist.to/), used under the Creative
Commons Attribution-ShareAlike 3.0 Unported licence:
https://creativecommons.org/licenses/by-sa/3.0/

The lists are bundled in a compiled form (src/main/electron/data/*.engine),
an adaptation made by scripts/build-blocklists.mjs from:
${Object.values(lists.lists ?? lists).filter((l) => l && typeof l === 'object' && l.source).map((l) => `  ${l.source}`).join('\n')}
The compiled files are offered under the same CC BY-SA 3.0 licence.

${RULE}
Mozilla Public License 2.0 components
${RULE}

The @ghostery/* packages listed below are under the MPL-2.0. Raha uses them
unmodified. Their source code is at https://github.com/ghostery/adblocker
(each entry below links the tag of the version shipped) and in each
package on https://www.npmjs.com/ at the version shown.

${RULE}
Packages
${RULE}
`];

for (const dir of runtimeDirs()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const text = licenceText(dir);
  parts.push(`${pkg.name} ${pkg.version}
Licence: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'see below')}
Source:  ${sourceUrl(pkg.repository, pkg.version) || `https://www.npmjs.com/package/${pkg.name}`}

${text || `(No licence file in the package; see the licence named above.)`}

${'-'.repeat(78)}
`);
}

const next = `${parts.join('\n').trimEnd()}\n`;
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== next) { console.error('THIRD_PARTY_NOTICES.txt is out of date: run `npm run notices`'); process.exit(1); }
  console.log('THIRD_PARTY_NOTICES.txt is current');
} else {
  fs.writeFileSync(OUT, next);
  console.log(`wrote ${path.relative(root, OUT)} (${next.split('\n').length} lines)`);
}
