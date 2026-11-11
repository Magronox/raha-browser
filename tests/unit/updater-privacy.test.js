// The update check sends no per-install ID and leaves no ID file (0.3.2).
// electron-updater 6.8.9 otherwise makes <userData>/.updaterId and sends it
// as x-user-staging-id on every check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardenUpdater, UPDATER_STAGING_ID, UPDATER_ID_FILE } from '../../src/main/electron/updater-privacy.js';

/** A stand-in for electron-updater's AppUpdater: the two fields hardenUpdater touches, and the merge the library does. */
function fakeUpdater(/** @type {string} */ dir) {
  let created = 0;
  return {
    /** @type {Record<string, string>|null} */ requestHeaders: { authorization: 'kept' },
    /** Like AppUpdater's Lazy(getOrCreateStagingUserId): writes the file on first read. */
    stagingUserIdPromise: { get value() {
      created += 1;
      fs.writeFileSync(path.join(dir, UPDATER_ID_FILE), '6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab');
      return Promise.resolve('6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab');
    } },
    /** What AppUpdater.getUpdateInfoAndProvider sends: computeFinalHeaders({ x-user-staging-id }) = its own, then requestHeaders over them. */
    /** @returns {Promise<Record<string, string>>} */
    async headersForCheck() {
      const id = await this.stagingUserIdPromise.value;
      return Object.assign({ 'x-user-staging-id': id }, this.requestHeaders ?? {});
    },
    created: () => created,
  };
}

test('updater: every check sends the same all-zero staging ID and no ID file is made', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raha-upd-'));
  const u = fakeUpdater(dir);
  hardenUpdater(u, dir);
  for (let i = 0; i < 3; i += 1) {
    const h = await u.headersForCheck();
    assert.equal(h['x-user-staging-id'], UPDATER_STAGING_ID);
    assert.equal(h.authorization, 'kept', 'other request headers survive');
  }
  assert.equal(await u.stagingUserIdPromise.value, UPDATER_STAGING_ID, 'the library reads the fixed ID too');
  assert.equal(u.created(), 0, 'the per-install ID is never generated');
  assert.equal(fs.existsSync(path.join(dir, UPDATER_ID_FILE)), false, 'no .updaterId is written');
  assert.match(UPDATER_STAGING_ID, /^0{8}-0{4}-4000-8000-0{12}$/);
});

test('updater: an install ID file left by Raha 0.3.1 is deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raha-upd-'));
  const file = path.join(dir, UPDATER_ID_FILE);
  fs.writeFileSync(file, '6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab');
  hardenUpdater({ requestHeaders: null }, dir);
  assert.equal(fs.existsSync(file), false);
  hardenUpdater({ requestHeaders: null }, dir); // no file there: nothing thrown
});

test('updater: the hardening runs before the first check, whether or not updates are on', () => {
  const src = fs.readFileSync(new URL('../../src/main/electron/updater.js', import.meta.url), 'utf8');
  const at = src.indexOf("hardenUpdater(autoUpdater, app.getPath('userData')");
  assert.ok(at > 0, 'updater.js hardens the real autoUpdater');
  assert.ok(at < src.indexOf('const check = () =>'), 'before any check is scheduled');
  assert.ok(at < src.indexOf('opts.isEnabled()'), 'not behind the autoUpdate setting');
});
