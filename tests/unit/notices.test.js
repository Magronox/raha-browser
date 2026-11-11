// THIRD_PARTY_NOTICES.txt ships in every build. It must name every runtime
// package at the version the lockfile pins, the Electron version, and the
// credits whose licences require one. Reads only committed files, so it runs
// without node_modules (regenerate with `npm run notices`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceUrl } from '../../scripts/repo-url.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

test('every runtime package in the lockfile is in the notices, at its version', () => {
  /** @type {string[]} */ const missing = [];
  for (const [key, meta] of Object.entries(/** @type {Record<string, any>} */ (lock.packages))) {
    if (!key.startsWith('node_modules/') || meta.dev || meta.devOptional || meta.optional) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!notices.includes(`\n${name} ${meta.version}\n`)) missing.push(`${name} ${meta.version}`);
  }
  assert.deepEqual(missing, [], 'run `npm run notices` after changing runtime dependencies');
});

test('the notices name the Electron version in the lockfile', () => {
  const v = lock.packages['node_modules/electron'].version;
  assert.ok(notices.includes(`Electron ${v} `), `expected "Electron ${v}"`);
});

test('the credits the licences require are present', () => {
  assert.match(notices, /The EasyList authors \(https:\/\/easylist\.to\/\)/);
  assert.match(notices, /creativecommons\.org\/licenses\/by-sa\/3\.0\//);
  assert.match(notices, /https:\/\/github\.com\/ghostery\/adblocker/);
  assert.match(notices, /LICENSES\.chromium\.html/);
});

test('the build ships the notices and Electron\'s own licence files', () => {
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  for (const f of ['THIRD_PARTY_NOTICES.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) assert.ok(yml.includes(`to: ${f}`), `${f} in extraResources`);
});

test('SSH repository URLs become https links to the tagged source (MPL-2.0 §3.2(a))', () => {
  assert.equal(sourceUrl({ type: 'git', url: 'ssh://git@github.com/ghostery/adblocker' }, '2.20.1'), 'https://github.com/ghostery/adblocker/tree/v2.20.1');
  assert.equal(sourceUrl('git+ssh://git@github.com/remusao/tldts.git', '7.4.10'), 'https://github.com/remusao/tldts/tree/v7.4.10');
  assert.equal(sourceUrl('git@github.com:jprichardson/node-jsonfile.git', '6.2.1'), 'https://github.com/jprichardson/node-jsonfile/tree/6.2.1', 'bare tags where the project uses them');
  assert.equal(sourceUrl({ url: 'git+https://github.com/npm/node-semver.git' }, '7.0.0'), 'https://github.com/npm/node-semver', 'https URLs are kept');
  assert.equal(sourceUrl(undefined, '1.0.0'), '');
  assert.doesNotMatch(notices, /^Source: +(?:ssh:\/\/|git@)/m, 'no SSH-only source pointer in the committed notices');
  assert.match(notices, /\n@ghostery\/adblocker 2\.\d+\.\d+\nLicence: MPL-2\.0\nSource: +https:\/\/github\.com\/ghostery\/adblocker\/tree\/v2\./);
});

// 0.3.2: Electron 44 fetches node_modules/electron/dist on first use, so a
// build must fetch it first or electron-builder skips the licence files with
// only a warning.
test('every build fetches Electron\'s licence files before packing', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.dist, /^node scripts\/electron-licences\.mjs && electron-builder /);
  const wf = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const guard = wf.indexOf('run: node scripts/electron-licences.mjs');
  assert.ok(guard > 0, 'release.yml runs the guard');
  assert.ok(guard < wf.indexOf('npx electron-builder'), 'before any build step');
});
