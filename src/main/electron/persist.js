// The persist port implementation: crash-safe JSON files + thumbnail cleanup.
// Atomicity: write to a temp file in the same directory, fsync, rename.
// A half-written state.json can never occur; worst case is losing the last
// few seconds of tree changes.
import fs from 'node:fs';
import path from 'node:path';
import { profileDir, thumbPath } from './paths.js';
import { log } from './log.js';

/** @returns {{ readJson: (name: string) => unknown, writeJsonAtomic: (name: string, obj: unknown) => void, deleteThumb: (tabId: string) => void }} */
export function createPersistPort() {
  const dir = profileDir();
  return {
    readJson(name) {
      const file = path.join(dir, name);
      try {
        if (!fs.existsSync(file)) return undefined;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        // Keep the corrupt file for forensics, then let migrations start fresh.
        try {
          fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
        } catch { /* ignore */ }
        log('persist', `failed to read ${name}: ${String(err)}`);
        return undefined;
      }
    },
    writeJsonAtomic(name, obj) {
      const file = path.join(dir, name);
      const tmp = `${file}.tmp`;
      try {
        const json = JSON.stringify(obj, null, 1);
        const fd = fs.openSync(tmp, 'w');
        fs.writeSync(fd, json);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.renameSync(tmp, file);
      } catch (err) {
        log('persist', `failed to write ${name}: ${String(err)}`);
      }
    },
    deleteThumb(tabId) {
      try {
        fs.rmSync(thumbPath(tabId), { force: true });
      } catch { /* ignore */ }
    },
  };
}
