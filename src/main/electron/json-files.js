// Profile JSON files (state, settings, history) that are never written over
// unless what was there is safe (0.3.2). Kept apart from persist.js so the
// unit tests can load it: it imports no 'electron'.
//
// A file Raha could not read (not JSON, the wrong shape, an I/O error) or one
// written by a newer Raha (a higher schemaVersion) is copied aside as
// <name>.corrupt-<ts> or <name>.newer-<ts> before the first write over it.
// If that copy fails, the file is held: writes to it are refused and the copy
// is tried again at every write. 0.3.1 made the copy on a best-effort basis
// (errors ignored), copied wrong-shape and newer files not at all, and then
// wrote over them.
//
// Atomicity: write to a temp file in the same directory, fsync, rename.
//
// Modes (0.3.2): profile files are this user's only (0600) and the profile's
// own folders 0700. 0.3.1 used the default modes (0644/0755 under a usual
// umask). tightenProfile() narrows what an older Raha left. No-op on Windows.
//
// Copies (0.3.2): a copy of a file Raha could parse (newer, or the wrong
// shape) is written cleaned like the live files (scrubProfileValue: no page
// state, no name or password in addresses). A file Raha could not parse is
// copied byte for byte, since it cannot be cleaned; the boot notice names it
// so the person can delete it. A copy is removed only when it is both beyond
// the newest KEEP_COPIES of its file and older than KEEP_COPY_MS (the number
// in its name is when it was made); a copy made in this run never goes. Every
// copy removed is named in the boot notice (takeRemoved). 0.3.2 before this
// removed any copy beyond three, with only a log line.
import fs from 'node:fs';
import path from 'node:path';
import { scrubProfileValue } from '../../shared/urls.js';

export const KEEP_COPIES = 3;
/** Two weeks. */
export const KEEP_COPY_MS = 14 * 24 * 60 * 60 * 1000;

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Narrow the modes of a profile folder, its files, and its subfolders' files,
 * once at start. Errors are ignored: a file we cannot chmod is not ours.
 * Symbolic links, the profile folder itself included, are never followed.
 * @param {string} dir
 * @param {{ platform?: string }} [opts]
 */
export function tightenProfile(dir, { platform = process.platform } = {}) {
  if (platform === 'win32') return;
  // A profile folder that is a symbolic link is left alone: chmod would
  // follow it and change its target, which Raha did not make. Links inside
  // are skipped too (a Dirent of a link is neither a file nor a folder).
  try { if (fs.lstatSync(dir).isSymbolicLink()) return; } catch { return; }
  /** @param {string} d */
  const walk = (d) => {
    try { fs.chmodSync(d, PRIVATE_DIR_MODE); } catch { /* ignore */ }
    /** @type {fs.Dirent[]} */ let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { fs.chmodSync(p, PRIVATE_FILE_MODE); } catch { /* ignore */ } }
    }
  };
  walk(dir);
}

/**
 * @param {string} dir the profile folder
 * @param {{ log?: (msg: string) => void, now?: () => number, copyFile?: (from: string, to: string) => void }} [opts]
 */
export function createJsonFiles(dir, { log = () => {}, now = Date.now, copyFile = fs.copyFileSync } = {}) {
  /** name -> why its file must be copied aside before it is written over. @type {Map<string, 'corrupt'|'newer'>} */
  const unsafe = new Map();
  /** name -> the parsed value, when the file parsed: its copy is written cleaned. @type {Map<string, unknown>} */
  const parsed = new Map();
  /** Files set aside, for the one notice at boot. @type {string[]} */
  const setAside = [];
  /** Full paths of copies made byte for byte (unparseable). @type {string[]} */
  const rawCopies = [];
  /** Copies made in this run: never pruned. @type {Set<string>} */
  const madeNow = new Set();
  /** Copies removed, for the boot notice. @type {string[]} */
  const removed = [];

  /** Remove copies of one file beyond the newest KEEP_COPIES that are also older than KEEP_COPY_MS. @param {string} name */
  const prune = (name) => {
    /** @type {string[]} */ let all;
    try { all = fs.readdirSync(dir); } catch { return; }
    const re = new RegExp(`^${name.replace(/[.]/g, '\\.')}\\.(corrupt|newer)-(\\d+)$`);
    const copies = all.map((f) => ({ f, m: re.exec(f) })).filter((x) => x.m)
      .sort((a, b) => Number(/** @type {RegExpExecArray} */ (b.m)[2]) - Number(/** @type {RegExpExecArray} */ (a.m)[2]));
    const cutoff = now() - KEEP_COPY_MS;
    for (const { f, m } of copies.slice(KEEP_COPIES)) {
      if (madeNow.has(f)) continue;
      if (!(Number(/** @type {RegExpExecArray} */ (m)[2]) < cutoff)) continue;
      try { fs.rmSync(path.join(dir, f)); removed.push(f); log(`removed an old copy, ${f}`); } catch { /* ignore */ }
    }
  };

  /** @param {string} name @returns {boolean} true when the file may be written over */
  const makeSafe = (name) => {
    const why = unsafe.get(name);
    if (!why) return true;
    const file = path.join(dir, name);
    const copy = `${file}.${why}-${now()}`;
    const isParsed = parsed.has(name);
    let made = false;
    try {
      if (isParsed) {
        fs.writeFileSync(copy, JSON.stringify(scrubProfileValue(parsed.get(name))), { mode: PRIVATE_FILE_MODE });
        made = true;
      } else if (fs.existsSync(file)) {
        copyFile(file, copy);
        made = true;
      }
      if (made && process.platform !== 'win32') { try { fs.chmodSync(copy, PRIVATE_FILE_MODE); } catch { /* ignore */ } }
    } catch (err) {
      log(`could not copy ${name} aside, so it is not written over: ${String(err).split('\n')[0]}`);
      return false;
    }
    unsafe.delete(name);
    parsed.delete(name);
    if (!made) return true;
    madeNow.add(path.basename(copy));
    setAside.push(path.basename(copy));
    if (!isParsed) rawCopies.push(copy);
    log(`kept a copy of ${name} as ${path.basename(copy)}${isParsed ? ' (cleaned)' : ''}`);
    prune(name);
    return true;
  };

  return {
    /**
     * The parsed file, or undefined when it is missing or unreadable.
     * @param {string} name
     * @param {number} [knownVersion] the newest schemaVersion this build understands
     */
    readJson(name, knownVersion) {
      const file = path.join(dir, name);
      /** @type {unknown} */ let value;
      try {
        if (!fs.existsSync(file)) return undefined;
        value = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        log(`failed to read ${name}: ${String(err).split('\n')[0]}`);
        unsafe.set(name, 'corrupt');
        makeSafe(name);
        return undefined;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        log(`${name} is not a Raha file (wrong shape)`);
        unsafe.set(name, 'corrupt');
        parsed.set(name, value);
        makeSafe(name);
        return undefined;
      }
      const v = /** @type {{ schemaVersion?: unknown }} */ (value).schemaVersion;
      if (typeof knownVersion === 'number' && typeof v === 'number' && v > knownVersion) {
        unsafe.set(name, 'newer');
        parsed.set(name, value);
        makeSafe(name);
      }
      return value;
    },
    /** @param {string} name @param {unknown} obj @returns {boolean} whether it was written */
    writeJsonAtomic(name, obj) {
      if (!makeSafe(name)) return false;
      const file = path.join(dir, name);
      const tmp = `${file}.tmp`;
      try {
        const json = JSON.stringify(obj, null, 1);
        const fd = fs.openSync(tmp, 'w', PRIVATE_FILE_MODE);
        // A temp file left by a crash keeps its old mode: narrow it too.
        if (process.platform !== 'win32') fs.fchmodSync(fd, PRIVATE_FILE_MODE);
        fs.writeSync(fd, json);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.renameSync(tmp, file);
        return true;
      } catch (err) {
        log(`failed to write ${name}: ${String(err)}`);
        return false;
      }
    },
    /** Copies set aside since the last call (each named once). */
    takeSetAside() { return setAside.splice(0); },
    /** Full paths of copies made byte for byte since the last call: they may hold what the old file held. */
    takeRawCopies() { return rawCopies.splice(0); },
    /** Old copies removed since the last call (each named once). */
    takeRemoved() { return removed.splice(0); },
    /** Files held because their copy failed. */
    held() { return [...unsafe.keys()]; },
  };
}
