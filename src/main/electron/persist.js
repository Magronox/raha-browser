// The persist port implementation: crash-safe JSON files + thumbnail cleanup.
// The files themselves are json-files.js: atomic writes (temp file, fsync,
// rename), and a file Raha could not read, or one from a newer Raha, is
// copied aside before it is ever written over (held if that copy fails).
import fs from 'node:fs';
import { profileDir, thumbPath } from './paths.js';
import { createJsonFiles, tightenProfile } from './json-files.js';
import { STATE_SCHEMA_VERSION, SETTINGS_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION } from '../../shared/defaults.js';
import { log } from './log.js';

/** The newest schemaVersion this build understands, per profile file. */
const KNOWN_VERSION = /** @type {Record<string, number>} */ ({
  'state.json': STATE_SCHEMA_VERSION,
  'settings.json': SETTINGS_SCHEMA_VERSION,
  'history.json': HISTORY_SCHEMA_VERSION,
});

/** @returns {{ readJson: (name: string) => unknown, writeJsonAtomic: (name: string, obj: unknown) => void, deleteThumb: (tabId: string) => void, takeSetAside: () => string[], takeRawCopies: () => string[], takeRemoved: () => string[], held: () => string[] }} */
export function createPersistPort() {
  const dir = profileDir();
  tightenProfile(dir); // files and folders an older Raha made with default modes
  const files = createJsonFiles(dir, { log: (m) => log('persist', m) });
  return {
    readJson: (name) => files.readJson(name, KNOWN_VERSION[name]),
    writeJsonAtomic: (name, obj) => { files.writeJsonAtomic(name, obj); },
    deleteThumb(tabId) {
      try {
        fs.rmSync(thumbPath(tabId), { force: true });
      } catch { /* ignore */ }
    },
    // Not part of the engine's port: index.js reads these once, for a notice.
    takeSetAside: () => files.takeSetAside(),
    takeRawCopies: () => files.takeRawCopies(),
    takeRemoved: () => files.takeRemoved(),
    held: () => files.held(),
  };
}
