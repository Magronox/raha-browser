// Launch Electron with a cleaned environment. Why this exists: VSCode and
// agent shells export ELECTRON_RUN_AS_NODE=1, which makes a bare `electron .`
// run as plain Node — the app silently never starts (see CLAUDE.md,
// "Running the app"). Plain node is immune to that variable, so `npm start`
// routes through this script, which strips the landmines and spawns the real
// binary. Zero dependencies, by design.
//
// Usage: node scripts/launch.mjs [electron-args...]   (e.g. --raha-smoke)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {string} path to the Electron binary */
function electronBinary() {
  try {
    // The electron package's main export is the path to its binary.
    return /** @type {string} */ (createRequire(import.meta.url)('electron'));
  } catch {
    // No node_modules (restricted sandbox) — fall back to the vendored binary
    // fetched by scripts/get-electron.mjs.
  }
  const vendored = path.join(
    repoRoot, 'vendor', 'electron',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (existsSync(vendored)) return vendored;
  throw new Error('electron not found: run `npm install`, or `node scripts/get-electron.mjs`');
}

const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // would turn Electron into plain Node
delete env.NODE_OPTIONS; // inherited inspector flags break the main process

// The in-app appendSwitch('no-sandbox') runs too late on Linux: the zygote's
// SUID-sandbox check aborts the process before the main script executes.
// Only an actual CLI flag is early enough (the e2e spec passes it the same way).
if (env.RAHA_NO_SANDBOX === '1' && !args.includes('--no-sandbox')) {
  args.push('--no-sandbox');
}

// `npm run smoke` without a profile dir would hard-fail smoke check 8
// (src/main/smoke.js requires RAHA_PROFILE_DIR): default to a throwaway dir.
if (args.includes('--raha-smoke') && !env.RAHA_PROFILE_DIR) {
  env.RAHA_PROFILE_DIR = mkdtempSync(path.join(os.tmpdir(), 'raha-smoke-'));
}

const child = spawn(electronBinary(), [repoRoot, ...args], { env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
