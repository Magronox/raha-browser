// R-118: the spellcheck setting must never enable the checker where enabling
// it downloads a dictionary (Windows/Linux) unless the user chose 'on'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySpellcheck } from '../../src/main/electron/privacy.js';

/** A session double recording setSpellCheckerEnabled calls. */
function fakeSession() {
  /** @type {boolean[]} */ const calls = [];
  return { calls, setSpellCheckerEnabled: (/** @type {boolean} */ v) => { calls.push(v); } };
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
