import test from 'node:test';
import assert from 'node:assert/strict';
import { hostMatches, findRule, effectivePolicy, hostOf } from '../../src/shared/rules.js';

test('hostMatches exact and wildcard', () => {
  assert.equal(hostMatches('youtube.com', 'youtube.com'), true);
  assert.equal(hostMatches('m.youtube.com', 'youtube.com'), false);
  assert.equal(hostMatches('youtube.com', '*.youtube.com'), true);
  assert.equal(hostMatches('music.youtube.com', '*.youtube.com'), true);
  assert.equal(hostMatches('notyoutube.com', '*.youtube.com'), false);
  assert.equal(hostMatches('', '*.youtube.com'), false);
});

test('findRule: first match wins', () => {
  const rules = [
    { pattern: '*.example.com', keepAlive: true },
    { pattern: 'app.example.com', memLimitMB: 100 },
  ];
  assert.equal(findRule('app.example.com', rules)?.pattern, '*.example.com');
  assert.equal(findRule('other.org', rules), null);
});

test('effectivePolicy merges tab overrides with rules (tab wins for limits)', () => {
  const rules = [{ pattern: '*.slack.com', keepAlive: true, memLimitMB: 800 }];
  const base = { keepAlive: false, memLimitMB: null, host: 'app.slack.com' };

  const fromRule = effectivePolicy(base, rules);
  assert.deepEqual(fromRule, { keepAlive: true, memLimitMB: 800, fromRule: '*.slack.com' });

  const tabOverride = effectivePolicy({ ...base, memLimitMB: 300 }, rules);
  assert.equal(tabOverride.memLimitMB, 300, 'explicit per-tab limit beats rule limit');
  assert.equal(tabOverride.keepAlive, true, 'keepAlive is OR-ed');

  const noMatch = effectivePolicy({ keepAlive: false, memLimitMB: null, host: 'x.org' }, rules);
  assert.deepEqual(noMatch, { keepAlive: false, memLimitMB: null, fromRule: null });
});

test('hostOf', () => {
  assert.equal(hostOf('https://Sub.Example.COM/p'), 'sub.example.com');
  assert.equal(hostOf('raha://home'), null);
  assert.equal(hostOf('not a url'), null);
});
