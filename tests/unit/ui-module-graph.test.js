// Regression test for the raha://app module graph (src/main/electron/protocol.js).
// The UI is an ES-module page served from raha://app/ (root src/ui). Its modules
// legitimately import the pure shared layer as ../shared/*, which URL resolution
// flattens to raha://app/shared/*. One unserved import kills the entire module
// graph and the window boots as an empty shell — so this walks every import
// reachable from app.js, maps each URL with the same rule the protocol handler
// uses, and asserts the target file exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = path.join(repoRoot, 'src', 'ui');
const sharedRoot = path.join(repoRoot, 'src', 'shared');

/**
 * Map a raha://app URL to the file the protocol handler serves — keep in sync
 * with the host === 'app' branch in src/main/electron/protocol.js.
 * @param {URL} url @returns {string}
 */
function servedFile(url) {
  const rel = url.pathname.replace(/^\/+/, '') || 'index.html';
  return rel.startsWith('shared/')
    ? path.join(sharedRoot, rel.slice('shared/'.length))
    : path.join(uiRoot, rel);
}

test('every import reachable from raha://app/app.js resolves to a served file', () => {
  const seen = new Set();
  const queue = [new URL('raha://app/app.js')];
  let sharedReached = 0;
  while (queue.length) {
    const url = queue.pop();
    if (!url || seen.has(url.href)) continue;
    seen.add(url.href);
    if (url.pathname.startsWith('/shared/')) sharedReached++;
    const file = servedFile(url);
    assert.ok(fs.existsSync(file), `raha:// would 404: ${url.href} -> ${file}`);
    const src = fs.readFileSync(file, 'utf8');
    // Static imports and import('...') — the latter also picks up JSDoc
    // type-imports, which must point at real files just the same.
    for (const m of src.matchAll(/import\s[^'"()]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      if (!spec || !spec.startsWith('.')) continue; // bare specifiers don't occur in the UI
      queue.push(new URL(spec, url)); // WHATWG resolution clamps at the root like Chromium
    }
  }
  assert.ok(sharedReached >= 1, 'graph never reached a shared/ module — test went vacuous');
  assert.ok(seen.size >= 5, `suspiciously small module graph (${seen.size} modules)`);
});
