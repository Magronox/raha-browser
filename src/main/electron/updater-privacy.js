// The update check carries no install ID. Kept apart from updater.js so the
// unit tests can load it: it imports neither 'electron' nor 'electron-updater'.
//
// electron-updater, left alone, makes a random UUID per install, saves it as
// <userData>/.updaterId and sends it on every check as `x-user-staging-id`
// (it uses it for staged rollouts). That is a permanent install ID handed to
// GitHub on every check. Raha uses no staged rollouts, so every install sends
// the same all-zero ID, the file is never made, and an old one is deleted.
//
// electron-updater 6.8.9, out/AppUpdater.js: stagingUserIdPromise (line 189),
// getOrCreateStagingUserId (501-524), computeFinalHeaders (333-338).
import fs from 'node:fs';
import path from 'node:path';

/** The one staging ID every Raha install sends: the same for all, so it names nobody. */
export const UPDATER_STAGING_ID = '00000000-0000-4000-8000-000000000000';
/** The file electron-updater keeps its per-install ID in. */
export const UPDATER_ID_FILE = '.updaterId';

/**
 * Make every check carry the fixed ID. Mutates `updater` (electron-updater's
 * autoUpdater, or a test double with the same fields).
 *  - requestHeaders: the library merges these over its own on every request
 *    (computeFinalHeaders), so the fixed ID replaces the per-install one.
 *  - stagingUserIdPromise: the library reads the ID through this lazy value,
 *    which creates the file when first read; a fixed value means the file is
 *    never written. It is a protected field in the typings, so it is replaced
 *    only when it is there.
 *  - the old file, if Raha 0.3.1 or earlier made one, is deleted.
 * @param {{ requestHeaders: Record<string, unknown>|null }} updater
 * @param {string} userDataPath app.getPath('userData')
 * @param {(msg: string) => void} [log]
 */
export function hardenUpdater(updater, userDataPath, log = () => {}) {
  updater.requestHeaders = { ...(updater.requestHeaders ?? {}), 'x-user-staging-id': UPDATER_STAGING_ID };
  if ('stagingUserIdPromise' in updater) {
    const fixed = Promise.resolve(UPDATER_STAGING_ID);
    Object.defineProperty(updater, 'stagingUserIdPromise', { value: { get value() { return fixed; } }, writable: true, configurable: true });
  }
  try {
    fs.rmSync(path.join(userDataPath, UPDATER_ID_FILE), { force: true });
  } catch (err) {
    log(`could not delete the old update ID file (${String(err).split('\n')[0]})`);
  }
}
