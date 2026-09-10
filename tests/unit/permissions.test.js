// Per-site permission asks (R-103): the pure half — Electron-name mapping,
// remembered-decision verdicts, the settings-shape helpers and their cap,
// and the words a user reads in the ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSION_KINDS, SITE_PERMISSIONS_CAP, isPermissionKind, isPermissionDecision,
  permissionKindsForRequest, permissionKindForCheck, normalizeKinds,
  rememberedVerdict, withSitePermission, withoutSitePermission, capSitePermissions,
  permissionKindLabel, permissionPhrase, permissionAskTitle,
} from '../../src/shared/permissions.js';

test('Electron request names map to Raha kinds; a media request is one ask covering both devices', () => {
  assert.deepEqual(permissionKindsForRequest('media', ['video']), ['camera']);
  assert.deepEqual(permissionKindsForRequest('media', ['audio']), ['microphone']);
  assert.deepEqual(permissionKindsForRequest('media', ['audio', 'video']), ['camera', 'microphone'], 'canonical order whatever Electron sends');
  assert.deepEqual(permissionKindsForRequest('media', []), [], 'a media request naming no device is not askable');
  assert.deepEqual(permissionKindsForRequest('media'), [], 'nor one without details');
  assert.deepEqual(permissionKindsForRequest('geolocation'), ['geolocation']);
  assert.deepEqual(permissionKindsForRequest('notifications'), ['notifications']);
  assert.deepEqual(permissionKindsForRequest('clipboard-read'), ['clipboard']);
  for (const other of ['display-capture', 'midi', 'midiSysex', 'idle-detection', 'openExternal', 'storage-access', 'unknown', 'fullscreen', 'pointerLock', 'clipboard-sanitized-write']) {
    assert.deepEqual(permissionKindsForRequest(other, ['video']), [], `${other} keeps deny-by-default`);
  }
});

test('Electron permission CHECKS map to one kind, or null', () => {
  assert.equal(permissionKindForCheck('media', 'video'), 'camera');
  assert.equal(permissionKindForCheck('media', 'audio'), 'microphone');
  assert.equal(permissionKindForCheck('media', 'unknown'), null);
  assert.equal(permissionKindForCheck('media'), null);
  assert.equal(permissionKindForCheck('geolocation'), 'geolocation');
  assert.equal(permissionKindForCheck('notifications'), 'notifications');
  assert.equal(permissionKindForCheck('clipboard-read'), 'clipboard');
  assert.equal(permissionKindForCheck('display-capture'), null);
  assert.equal(permissionKindForCheck('midi'), null);
});

test('kind vocabulary: guards and normalization', () => {
  assert.deepEqual([...PERMISSION_KINDS], ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard']);
  for (const k of PERMISSION_KINDS) assert.ok(isPermissionKind(k));
  for (const bad of ['screen', 'media', '', 42, null, undefined, {}]) assert.ok(!isPermissionKind(bad), `${String(bad)} is not a kind`);
  assert.ok(isPermissionDecision('allow') && isPermissionDecision('deny'));
  for (const bad of ['prompt', 'once', true, 1, null]) assert.ok(!isPermissionDecision(bad));
  assert.deepEqual(normalizeKinds(['microphone', 'camera', 'camera', 'bogus']), ['camera', 'microphone']);
});

test('rememberedVerdict: any blocked kind denies silently, all allowed grants, else ask about the undecided only', () => {
  /** @type {import('../../src/shared/permissions.js').SitePermissions} */
  const map = { 'meet.example': { camera: 'allow', microphone: 'deny' }, 'news.example': { notifications: 'allow' } };
  assert.deepEqual(rememberedVerdict(map, 'meet.example', ['camera']), { verdict: 'allow', undecided: [] });
  assert.deepEqual(rememberedVerdict(map, 'meet.example', ['camera', 'microphone']), { verdict: 'deny', undecided: [] });
  assert.deepEqual(rememberedVerdict(map, 'meet.example', ['microphone']), { verdict: 'deny', undecided: [] });
  assert.deepEqual(rememberedVerdict(map, 'meet.example', ['camera', 'geolocation']), { verdict: 'ask', undecided: ['geolocation'] });
  assert.deepEqual(rememberedVerdict(map, 'other.example', ['camera', 'microphone']), { verdict: 'ask', undecided: ['camera', 'microphone'] });
  assert.deepEqual(rememberedVerdict({}, 'x.example', ['clipboard']), { verdict: 'ask', undecided: ['clipboard'] });
  // Prototype keys are not sites.
  assert.deepEqual(rememberedVerdict({}, 'constructor', ['camera']), { verdict: 'ask', undecided: ['camera'] });
});

test('withSitePermission / withoutSitePermission never mutate and keep the newest site last', () => {
  /** @type {import('../../src/shared/permissions.js').SitePermissions} */
  const a = { 'a.example': { camera: 'allow' }, 'b.example': { geolocation: 'deny' } };
  const frozen = JSON.stringify(a);
  const b = withSitePermission(a, 'a.example', 'microphone', 'deny');
  assert.equal(JSON.stringify(a), frozen, 'input untouched');
  assert.deepEqual(b, { 'b.example': { geolocation: 'deny' }, 'a.example': { camera: 'allow', microphone: 'deny' } });
  assert.deepEqual(Object.keys(b), ['b.example', 'a.example'], 'the site just decided moves to the end');
  const c = withSitePermission(b, 'c.example', 'notifications', 'allow');
  assert.deepEqual(Object.keys(c), ['b.example', 'a.example', 'c.example']);
  assert.deepEqual(withoutSitePermission(c, 'a.example', 'camera')['a.example'], { microphone: 'deny' });
  assert.deepEqual(withoutSitePermission(c, 'b.example', 'geolocation')['b.example'], undefined, 'an emptied site disappears');
  assert.deepEqual(Object.keys(withoutSitePermission(c, 'a.example')), ['b.example', 'c.example'], 'no kind = the whole site');
  assert.deepEqual(withoutSitePermission(c, 'nope.example'), c, 'forgetting a stranger changes nothing');
  assert.equal(JSON.stringify(c), JSON.stringify(withSitePermission(b, 'c.example', 'notifications', 'allow')), 'still untouched');
});

test('the site cap drops the OLDEST sites', () => {
  /** @type {import('../../src/shared/permissions.js').SitePermissions} */
  let map = {};
  for (let i = 0; i < SITE_PERMISSIONS_CAP + 5; i += 1) map = withSitePermission(map, `site${i}.example`, 'camera', 'allow');
  const hosts = Object.keys(map);
  assert.equal(hosts.length, SITE_PERMISSIONS_CAP);
  assert.equal(hosts[0], 'site5.example', 'first five (oldest) gone');
  assert.equal(hosts[hosts.length - 1], `site${SITE_PERMISSIONS_CAP + 4}.example`);
  // Re-deciding an old site refreshes it instead of adding a duplicate.
  map = withSitePermission(map, 'site5.example', 'microphone', 'deny');
  assert.equal(Object.keys(map).length, SITE_PERMISSIONS_CAP);
  assert.equal(Object.keys(map).at(-1), 'site5.example');
  const over = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`h${i}.example`, { camera: /** @type {const} */ ('allow') }]));
  assert.equal(Object.keys(capSitePermissions(over)).length, 200);
  assert.equal(Object.keys(over)[0], 'h10.example');
});

test('wording: kinds join naturally; labels are what a person calls them', () => {
  assert.equal(permissionAskTitle('meet.example', ['camera']), 'meet.example wants to use your camera');
  assert.equal(permissionAskTitle('meet.example', ['microphone']), 'meet.example wants to use your microphone');
  assert.equal(permissionAskTitle('meet.example', ['microphone', 'camera']), 'meet.example wants to use your camera and microphone');
  assert.equal(permissionAskTitle('maps.example', ['geolocation']), 'maps.example wants to use your location');
  assert.equal(permissionAskTitle('news.example', ['notifications']), 'news.example wants to show notifications');
  assert.equal(permissionAskTitle('paste.example', ['clipboard']), 'paste.example wants to read your clipboard');
  assert.equal(permissionPhrase(['camera', 'geolocation', 'notifications']), 'use your camera, use your location and show notifications');
  assert.equal(permissionPhrase([]), 'use something');
  assert.equal(permissionKindLabel('geolocation'), 'location');
  assert.equal(permissionKindLabel('camera'), 'camera');
});
