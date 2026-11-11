// R-118: the spellcheck setting must never enable the checker where enabling
// it downloads a dictionary (Windows/Linux) unless the user chose 'on'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySpellcheck, silenceSpellcheck, NO_DICTIONARY_URL, GOOGLE_DICTIONARY_URL } from '../../src/main/electron/privacy.js';

/** A session double recording setSpellCheckerEnabled and download-address calls. */
function fakeSession() {
  /** @type {boolean[]} */ const calls = [];
  /** @type {string[]} */ const urls = [];
  return {
    calls, urls,
    setSpellCheckerEnabled: (/** @type {boolean} */ v) => { calls.push(v); },
    setSpellCheckerDictionaryDownloadURL: (/** @type {string} */ u) => { urls.push(u); },
  };
}

test('system: on for macOS (OS checker, no download), off elsewhere', () => {
  for (const [platform, want] of /** @type {const} */ ([['darwin', true], ['win32', false], ['linux', false]])) {
    const ses = fakeSession();
    assert.equal(applySpellcheck(/** @type {any} */ (ses), 'system', platform), want, platform);
    assert.deepEqual(ses.calls, [want]);
  }
});

test('on / off are explicit on every platform', () => {
  for (const platform of /** @type {const} */ (['darwin', 'win32', 'linux'])) {
    assert.equal(applySpellcheck(/** @type {any} */ (fakeSession()), 'on', platform), true);
    assert.equal(applySpellcheck(/** @type {any} */ (fakeSession()), 'off', platform), false);
  }
});

test('idempotent per session: the checker is touched only when the answer changes', () => {
  const ses = fakeSession();
  applySpellcheck(/** @type {any} */ (ses), 'system', 'linux');
  applySpellcheck(/** @type {any} */ (ses), 'system', 'linux');
  applySpellcheck(/** @type {any} */ (ses), 'off', 'linux');
  applySpellcheck(/** @type {any} */ (ses), 'on', 'linux');
  applySpellcheck(/** @type {any} */ (ses), 'on', 'linux');
  assert.deepEqual(ses.calls, [false, true]);
});

// 0.3.3: the chrome's own session never had the checker turned off, so on
// Windows/Linux Chromium could fetch a dictionary at first launch with the
// setting at its default. window.js imports electron, so this reads the source.
test('the chrome view never spellchecks, so it never fetches a dictionary', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/main/electron/window.js', import.meta.url), 'utf8');
  assert.match(src, /uiSession\.setSpellCheckerEnabled\(false\);/);
  const prefs = src.slice(src.indexOf('const uiView = new WebContentsView({'), src.indexOf('win.contentView.addChildView(uiView)'));
  assert.match(prefs, /spellcheck: false,/);
  assert.ok(src.indexOf('uiSession.setSpellCheckerEnabled(false)') < src.indexOf('const uiView = new WebContentsView({'), 'off before the chrome view exists');
});

// 0.3.3: every session (the default one, the chrome's, the tabs') started a
// dictionary download from Google within seconds of being created, even
// with its checker switched off (measured in Docker on Linux). Each session
// now gets an address that cannot be fetched as it is created; only 'on'
// gives Google's address back.
test('a new session gets the no-download address and its checker off', () => {
  const ses = fakeSession();
  silenceSpellcheck(/** @type {any} */ (ses));
  assert.deepEqual(ses.urls, [NO_DICTIONARY_URL]);
  assert.deepEqual(ses.calls, [false]);
  assert.equal(NO_DICTIONARY_URL, 'http://0.0.0.0:0/', 'an IP literal (no DNS query) on port 0: refused before any connect, and no process can listen there');
});

test('only an explicit "on" restores the dictionary address; off/system take it away again', () => {
  const ses = fakeSession();
  silenceSpellcheck(/** @type {any} */ (ses));
  applySpellcheck(/** @type {any} */ (ses), 'system', 'linux');
  assert.deepEqual(ses.urls, [NO_DICTIONARY_URL], "'system' on Linux changes nothing");
  applySpellcheck(/** @type {any} */ (ses), 'on', 'linux');
  assert.deepEqual(ses.urls.at(-1), GOOGLE_DICTIONARY_URL);
  assert.deepEqual(ses.calls.at(-1), true);
  applySpellcheck(/** @type {any} */ (ses), 'off', 'linux');
  assert.deepEqual(ses.urls.at(-1), NO_DICTIONARY_URL);
  assert.deepEqual(ses.calls.at(-1), false);
  assert.equal(GOOGLE_DICTIONARY_URL, 'https://redirector.gvt1.com/edgedl/chrome/dict/');
});

test('every session is silenced as it is created, the default one included', async () => {
  const { readFileSync } = await import('node:fs');
  const index = readFileSync(new URL('../../src/main/index.js', import.meta.url), 'utf8');
  const at = index.indexOf("app.on('session-created', (ses) => silenceSpellcheck(ses));");
  assert.ok(at > 0, 'index.js silences every session on session-created');
  assert.ok(at < index.indexOf('app.whenReady()'), 'registered at load, before any session exists');
});
