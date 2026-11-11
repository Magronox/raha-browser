// 0.3.2: a name or password in an address (https://name:secret@site/) never
// reaches the in-place error page or a log line. These sinks live in
// electron adapters that unit tests cannot load, so their source is read.
// The Downloads list shows only the host (shortUrl) and a stripped tooltip;
// thumbnails are bare PNG pixels (toPNG writes no text chunks).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = (/** @type {string} */ f) => fs.readFileSync(new URL(`../../src/main/electron/${f}`, import.meta.url), 'utf8');

test('the error page shows the failed address without a name or password', () => {
  assert.match(src('views.js'), /JSON\.stringify\(\[withoutCredentials\(String\(validatedURL\)\)/);
});

test('log lines with a page-supplied address strip a name or password first', () => {
  const w = src('window.js');
  assert.match(w, /navigation to \$\{withoutCredentials\(url\)/);
  assert.match(w, /window\.open to \$\{withoutCredentials\(url\)/);
  assert.match(src('ipc.js'), /withoutCredentials\(event\.senderFrame\.url\)/);
});
