// The Linux .deb must declare every system library the binary needs, or apt
// installs it on a desktop without them and Raha does not start (0.3.2:
// libasound.so.2 on a stock Ubuntu 24.04).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');

test('the .deb depends on ALSA (24.04 name first, versioned fallback) and keeps the default list', () => {
  const deb = yml.slice(yml.indexOf('\ndeb:'), yml.indexOf('\nwin:'));
  assert.ok(deb.length > 5, 'a deb: section exists');
  assert.match(deb, /- libasound2t64 \| libasound2 \(>= 1\.0\.17\)/);
  for (const d of ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0']) {
    assert.match(deb, new RegExp(`\\n    - ${d.replace(/[.]/g, '\\.')}\\n`), `${d} (electron-builder's default) is kept`);
  }
});
