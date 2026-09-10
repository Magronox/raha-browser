// The macOS entitlements render step (R-108, scripts/mac-entitlements.mjs).
//
// This plist gets SIGNED, so the two things worth pinning are: a cert-less
// build still produces a valid one (that is the path every contributor and
// every local `npm run dist` takes), and a malformed APPLE_TEAM_ID fails the
// build instead of quietly emitting a broken entitlement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { renderEntitlements } from '../../scripts/mac-entitlements.mjs';

const GROUP = 'io.github.rahabrowser.raha.webauthn';

/** @param {string|undefined} teamId */
function render(teamId) {
  const { path, signedWithKeychainGroup } = renderEntitlements(teamId);
  return { xml: readFileSync(path, 'utf8'), path, signedWithKeychainGroup };
}

test.after(() => {
  // Gitignored build output — do not leave it behind for `npm run dist`.
  try { rmSync(new URL('../../build/entitlements.mac.plist', import.meta.url), { force: true }); } catch { /* fine */ }
});

test('a Team ID becomes a literal keychain-access-group (no $(AppIdentifierPrefix))', () => {
  const { xml, signedWithKeychainGroup } = render('AB12CD34EF');
  assert.equal(signedWithKeychainGroup, true);
  assert.match(xml, /<key>keychain-access-groups<\/key>/);
  assert.match(xml, new RegExp(`<string>AB12CD34EF\\.${GROUP.replace(/\./g, '\\.')}</string>`));
  // The prefix must be literal in the VALUE — electron-builder does not expand
  // Xcode variables. (The template's comment may still name one; only the
  // emitted <string> entries matter.)
  const values = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.ok(values.length > 0 && values.every((v) => !v.includes('$(')),
    `Xcode variable left in an entitlement value: ${values.join(', ')}`);
  assert.ok(!xml.includes('__KEYCHAIN_ACCESS_GROUPS__'), 'placeholder must be consumed');
});

test('no Team ID still renders a usable plist — the cert-less local build', () => {
  const { xml, signedWithKeychainGroup } = render(undefined);
  assert.equal(signedWithKeychainGroup, false);
  assert.ok(!xml.includes('<key>keychain-access-groups</key>'), 'the group must be dropped, not left empty');
  assert.ok(!xml.includes('__KEYCHAIN_ACCESS_GROUPS__'), 'placeholder must be consumed');
  // The hardened-runtime keys Electron cannot start without survive either way.
  for (const key of ['com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation']) {
    assert.ok(xml.includes(`<key>${key}</key>`), `missing ${key}`);
  }
  // …as do the ones the R-103 asks and the tab importer actually need.
  for (const key of ['com.apple.security.device.camera',
    'com.apple.security.device.audio-input',
    'com.apple.security.personal-information.location',
    'com.apple.security.automation.apple-events']) {
    assert.ok(xml.includes(`<key>${key}</key>`), `missing ${key}`);
  }
});

test('a blank Team ID is treated as unset, not as an empty prefix', () => {
  const { xml, signedWithKeychainGroup } = render('   ');
  assert.equal(signedWithKeychainGroup, false);
  assert.ok(!xml.includes(`<string>.${GROUP}</string>`), 'must never emit a group with an empty prefix');
});

test('a malformed Team ID fails the build instead of being interpolated', () => {
  for (const bad of ['X"><evil', 'AB12CD34E', 'AB12CD34EFG', 'ab12cd34ef!', '../../etc']) {
    assert.throws(() => renderEntitlements(bad), /APPLE_TEAM_ID/, `accepted ${JSON.stringify(bad)}`);
  }
});
