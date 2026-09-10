// electron-builder `beforePack` hook: render build/entitlements.mac.plist
// from build/entitlements.mac.plist.in (R-108, docs/PLAYBOOKS/release.md).
//
// Why a render step at all: the plist has to carry the LITERAL Team ID prefix
// on `keychain-access-groups` — electron-builder does not expand Xcode's
// $(AppIdentifierPrefix) — and the Team ID is not public, so it cannot be
// committed. It arrives as $APPLE_TEAM_ID (a GitHub repo variable in CI).
//
// The cert-less path is the normal one for contributors: with APPLE_TEAM_ID
// unset the keychain group is dropped and the build carries on, producing the
// ad-hoc-signed app that `npm run dist` has always produced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(repoRoot, 'build', 'entitlements.mac.plist.in');
const RENDERED = path.join(repoRoot, 'build', 'entitlements.mac.plist');
const PLACEHOLDER = '__KEYCHAIN_ACCESS_GROUPS__';

// The WebAuthn keychain group Electron's Touch ID authenticator stores
// device-bound passkeys in. Must match app.configureWebAuthn() at runtime.
const WEBAUTHN_GROUP_SUFFIX = 'io.github.rahabrowser.raha.webauthn';

// Apple Team IDs are 10 alphanumeric characters. Validated rather than
// trusted: the value is interpolated into a plist that gets SIGNED, so a
// malformed one must fail the build loudly, never emit a broken entitlement.
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;

/**
 * Write build/entitlements.mac.plist. Exported for the unit test; the default
 * export is the electron-builder hook.
 * @param {string|undefined} teamId raw $APPLE_TEAM_ID
 * @returns {{ path: string, signedWithKeychainGroup: boolean }}
 */
export function renderEntitlements(teamId) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`${TEMPLATE} no longer contains ${PLACEHOLDER} — the render step would sign the template verbatim.`);
  }
  const trimmed = (teamId ?? '').trim();
  if (trimmed && !TEAM_ID_RE.test(trimmed)) {
    throw new Error(`APPLE_TEAM_ID must be 10 alphanumeric characters (got ${JSON.stringify(trimmed)}).`);
  }
  const block = trimmed
    ? [
      '  <key>keychain-access-groups</key>',
      '  <array>',
      `    <string>${trimmed}.${WEBAUTHN_GROUP_SUFFIX}</string>`,
      '  </array>',
    ].join('\n')
    : '  <!-- keychain-access-groups omitted: APPLE_TEAM_ID was not set -->';
  fs.writeFileSync(RENDERED, template.replace(PLACEHOLDER, block));
  return { path: RENDERED, signedWithKeychainGroup: Boolean(trimmed) };
}

/** @param {{ electronPlatformName: string }} context */
export default async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return; // Linux/Windows have no entitlements
  const { signedWithKeychainGroup } = renderEntitlements(process.env.APPLE_TEAM_ID);
  console.log(signedWithKeychainGroup
    ? '  • entitlements rendered  keychain-access-groups=on (APPLE_TEAM_ID set)'
    : '  • entitlements rendered  keychain-access-groups=OFF — APPLE_TEAM_ID unset, so passkeys created in this build cannot reach the keychain group. Expected for local/unsigned builds.');
}
