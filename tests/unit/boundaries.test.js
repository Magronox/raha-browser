// Architecture boundary enforcement that runs OFFLINE (eslint also enforces
// this in CI, but this test works with zero dependencies installed).
// See docs/INVARIANTS.md #1 and #2. If this test fails you are importing
// platform modules from a pure layer — inject an adapter instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  /** @type {string[]} */ const out = [];
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(rel));
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const FORBIDDEN_EVERYWHERE_PURE = [
  /from\s+['"]electron['"]/,
  /require\(\s*['"]electron['"]\s*\)/,
  /from\s+['"]node:/,
  /require\(\s*['"]node:/,
  /from\s+['"](fs|path|os|child_process|http|https|net|crypto)['"]/,
];

test('src/shared and src/main/core never import electron or node builtins', () => {
  const files = [...jsFiles('src/shared'), ...jsFiles('src/main/core')];
  assert.ok(files.length >= 8, `expected pure-layer files, found ${files.length}`);
  for (const f of files) {
    const text = readFileSync(join(repoRoot, f), 'utf8');
    for (const re of FORBIDDEN_EVERYWHERE_PURE) {
      assert.ok(!re.test(text), `${f} violates purity: matches ${re}`);
    }
  }
});

test('src/ui only talks to window.raha (no electron/node imports)', () => {
  const files = jsFiles('src/ui').filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const text = readFileSync(join(repoRoot, f), 'utf8');
    for (const re of FORBIDDEN_EVERYWHERE_PURE) {
      assert.ok(!re.test(text), `${f} violates UI purity: matches ${re}`);
    }
  }
});

test("only src/main/electron and src/main/index.js import 'electron'", () => {
  const allowed = /^src\/main\/(electron\/|index\.js$)/;
  const files = jsFiles('src/main');
  for (const f of files) {
    const posix = f.split('\\').join('/');
    const text = readFileSync(join(repoRoot, f), 'utf8');
    const importsElectron = /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(text);
    if (importsElectron) {
      assert.ok(allowed.test(posix), `${posix} imports electron but is not in src/main/electron/`);
    }
  }
});

test('IPC channel names are used via the contract, not string literals', () => {
  // Main + preload + UI must reference INVOKE/EVENT from ipc-contract.js.
  // Cheap heuristic: no file other than the contract may contain the literal
  // channel prefix "evt:" or a "tab:"/"nav:"/"folder:" channel string.
  const files = [...jsFiles('src/main'), ...jsFiles('src/ui'), ...jsFiles('src/preload')];
  const channelLiteral = /['"](evt:|tab:|nav:|folder:|find:|state:get|settings:(get|set)|node:(remove|move)|zoom:set|history:|organize:|runaway:|ui:(overlay|sidebar)|siteData:|defaultBrowser:|openTabs:|permission:)/;
  for (const f of files) {
    if (f.split('\\').join('/').endsWith('src/shared/ipc-contract.js')) continue;
    const text = readFileSync(join(repoRoot, f), 'utf8');
    assert.ok(!channelLiteral.test(text), `${f} hardcodes an IPC channel string — import from src/shared/ipc-contract.js`);
  }
});
