// Profile directory resolution. Every persisted byte of Raha lives under ONE
// directory (settings, state, thumbnails) so users can back up or wipe a
// profile trivially, and tests get isolation via RAHA_PROFILE_DIR.
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/** @returns {string} absolute profile dir, created if missing */
export function profileDir() {
  const dir = process.env.RAHA_PROFILE_DIR
    ? path.resolve(process.env.RAHA_PROFILE_DIR)
    : path.join(app.getPath('userData'), 'profile');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @returns {string} */
export function thumbsDir() {
  const dir = path.join(profileDir(), 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} tabId @returns {string} */
export function thumbPath(tabId) {
  // tabId comes from ids.js (alnum + underscore); sanitize defensively anyway.
  const safe = String(tabId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(thumbsDir(), `${safe}.png`);
}
