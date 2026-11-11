// A site that asks for a client certificate gets none, and the person is
// told which site asked (0.3.3). Without the handler Electron sends the
// first matching certificate from the system store with no ask.
// Electron passes the requester as host:port, not a URL
// (electron_api_app.cc), so the tests do too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refuseClientCertificates, clientCertificateRefusedText, certificateRequestHost } from '../../src/main/electron/client-certificate.js';

/** A stand-in for Electron's app: keeps the listener so the test can fire the event. */
function fakeApp() {
  /** @type {Function[]} */ const listeners = [];
  return {
    on: (/** @type {string} */ name, /** @type {Function} */ fn) => { assert.equal(name, 'select-client-certificate'); listeners.push(fn); },
    /** Fire one request the way Electron does; report what the app did with it. */
    ask(/** @type {string} */ hostPort) {
      /** @type {{ prevented: boolean, calls: unknown[][] }} */
      const r = { prevented: false, calls: [] };
      const event = { preventDefault: () => { r.prevented = true; } };
      const certs = [{ subjectName: 'Amir Basareh', issuerName: 'Example CA' }];
      for (const fn of listeners) fn(event, null, hostPort, certs, (/** @type {unknown[]} */ ...args) => { r.calls.push(args); });
      return r;
    },
    count: () => listeners.length,
  };
}

const text = (/** @type {string} */ host) => `${host} asked for a certificate. Raha didn't share one: Raha is a privacy browser and never sends a certificate.`;

test('client certificate: the request is refused and no certificate is sent', () => {
  const app = fakeApp();
  refuseClientCertificates(app, { notify: () => {} });
  assert.equal(app.count(), 1);
  for (const hp of ['bank.example:443', '10.0.0.5:443', '[::1]:8443']) {
    const r = app.ask(hp);
    assert.equal(r.prevented, true, 'preventDefault stops Electron picking the first certificate');
    assert.deepEqual(r.calls, [[]], 'callback is called once, with no certificate');
  }
});

test('client certificate: Electron\'s host:port is read as a host', () => {
  assert.equal(certificateRequestHost('bank.example:443'), 'bank.example');
  assert.equal(certificateRequestHost('Bank.Example:443'), 'bank.example');
  assert.equal(certificateRequestHost('10.0.0.5:443'), '10.0.0.5');
  assert.equal(certificateRequestHost('[::1]:8443'), '[::1]');
  assert.equal(certificateRequestHost('https://bank.example/login'), 'bank.example');
  assert.equal(certificateRequestHost(''), '');
  assert.equal(certificateRequestHost(undefined), '');
});

test('client certificate: the person is told which site asked, once a minute per site', () => {
  const app = fakeApp();
  /** @type {string[]} */ const told = [];
  /** @type {string[]} */ const logged = [];
  let t = 1_000_000;
  refuseClientCertificates(app, { notify: (m) => told.push(m), log: (m) => logged.push(m), now: () => t });
  app.ask('bank.example:443');
  t += 10_000;
  app.ask('bank.example:443');
  t += 20_000;
  app.ask('bank.example:443');
  assert.deepEqual(told, [text('bank.example')]);
  assert.deepEqual(logged, ['refused a client certificate request'], 'the log names no host');
  t += 10_000;
  app.ask('10.0.0.5:443');
  t += 10_000;
  app.ask('[::1]:8443');
  assert.deepEqual(told.slice(1), [text('10.0.0.5'), text('[::1]')], 'other sites are told about on their own');
  t += 60_000;
  assert.equal(app.ask('bank.example:443').calls.length, 1);
  assert.equal(told.length, 4, 'a minute later the same site is told about again');
  assert.equal(clientCertificateRefusedText('a.example'), text('a.example'));
});

test('client certificate: at most one notice every few seconds overall', () => {
  const app = fakeApp();
  /** @type {string[]} */ const told = [];
  let t = 1_000_000;
  refuseClientCertificates(app, { notify: (m) => told.push(m), now: () => t });
  app.ask('a.example:443');
  t += 1_000;
  app.ask('b.example:443');
  t += 1_000;
  app.ask('c.example:443');
  assert.deepEqual(told, [text('a.example')]);
  t += 5_000;
  const r = app.ask('b.example:443');
  assert.deepEqual(r.calls, [[]], 'every request is still refused');
  assert.deepEqual(told, [text('a.example'), text('b.example')], 'a site held back is told about later');
});

test('client certificate: the per-site memory is bounded', () => {
  const app = fakeApp();
  /** @type {string[]} */ const told = [];
  let t = 0;
  refuseClientCertificates(app, { notify: (m) => told.push(m), now: () => t, limits: { anyMs: 0, perHostMs: 1e12, maxHosts: 3 } });
  for (const h of ['a', 'b', 'c']) { app.ask(`${h}.example:443`); t += 1; }
  app.ask('a.example:443');
  assert.equal(told.length, 3, 'remembered: no second notice');
  app.ask('d.example:443'); t += 1; // full: the memory is cleared, then d is remembered
  app.ask('a.example:443');
  assert.equal(told.length, 5, 'after the clear, a is told about again');
  assert.equal(told[4], text('a.example'));
});

test('client certificate: a request with no host is still refused, without a notice', () => {
  const app = fakeApp();
  /** @type {string[]} */ const told = [];
  refuseClientCertificates(app, { notify: (m) => told.push(m) });
  const r = app.ask('');
  assert.equal(r.prevented, true);
  assert.deepEqual(r.calls, [[]]);
  assert.deepEqual(told, []);
});

test('client certificate: the app wires the refusal before it is ready', () => {
  const index = readFileSync(new URL('../../src/main/index.js', import.meta.url), 'utf8');
  const at = index.indexOf('refuseClientCertificates(app, {');
  assert.ok(at > 0, 'index.js installs the refusal');
  assert.ok(at < index.indexOf('app.whenReady()'), 'installed at load, before any tab exists');
  assert.match(index, /certNotice = \(text\) => push\.pushToast\(\{ kind: 'warn', text \}\);/, 'the notice is an ordinary toast');
});
