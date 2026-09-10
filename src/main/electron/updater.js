// Automatic updates via electron-updater (ADR-0008) — the only file that
// imports it (invariant #1). Behavior:
//   - packaged builds only; dev/e2e/smoke runs never touch the network
//   - respects settings.autoUpdate at EVERY check, so toggling it off in
//     Settings stops all update traffic without a restart
//   - Windows/Linux: download in the background, install on quit
//   - macOS: notify-only until code signing lands (R-108) — Squirrel.Mac
//     refuses to install into unsigned apps
import { app } from 'electron';
import electronUpdater from 'electron-updater'; // CJS: named exports need the default
import { log } from './log.js';

const { autoUpdater } = electronUpdater;
const FIRST_CHECK_MS = 30_000; // let boot finish first
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * @param {{ isEnabled: () => boolean, toast: (kind: string, text: string) => void }} opts
 */
export function installAutoUpdater(opts) {
  if (!app.isPackaged) return;

  const macNotifyOnly = process.platform === 'darwin';
  autoUpdater.autoDownload = !macNotifyOnly;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (/** @type {unknown} */ m) => log('update', String(m)),
    warn: (/** @type {unknown} */ m) => log('update', String(m)),
    error: (/** @type {unknown} */ m) => log('update', String(m)),
    debug: () => {},
  };

  autoUpdater.on('update-downloaded', (info) => {
    opts.toast('update', `Raha ${info.version} downloaded — installs when you quit`);
  });
  if (macNotifyOnly) {
    autoUpdater.on('update-available', (info) => {
      opts.toast('update', `Raha ${info.version} is available — download it from GitHub Releases`);
    });
  }
  autoUpdater.on('error', (err) => {
    // Offline, rate-limited, etc. — log quietly, never toast failures.
    log('update', `check failed: ${String(err).split('\n')[0]}`);
  });

  const check = () => {
    if (!opts.isEnabled()) return;
    void autoUpdater.checkForUpdates().catch(() => { /* logged via 'error' */ });
  };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}
