import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, normalizeHostPattern, normalizeSiteHost } from '../../src/shared/validate.js';
import { defaultSettings } from '../../src/shared/defaults.js';

test('validateSettings: garbage in, defaults out, never throws', () => {
  for (const garbage of [undefined, null, 42, 'x', [], { maxLiveTabs: 'many' }, { rules: 'nope' }]) {
    const { value } = validateSettings(garbage);
    assert.equal(typeof value.maxLiveTabs, 'number');
    assert.equal(value.schemaVersion, defaultSettings().schemaVersion);
  }
});

test('validateSettings: clamps out-of-range numbers', () => {
  const { value, problems } = validateSettings({ maxLiveTabs: 0, idleSleepMinutes: 99999, globalBudgetMB: -5 });
  assert.equal(value.maxLiveTabs, 1);
  assert.equal(value.idleSleepMinutes, 720);
  assert.equal(value.globalBudgetMB, 0);
  assert.ok(problems.length >= 3);
});

test('validateSettings: keeps valid values untouched', () => {
  const input = { ...defaultSettings(), maxLiveTabs: 12, searchEngine: 'brave', gpc: false };
  const { value, problems } = validateSettings(input);
  assert.equal(value.maxLiveTabs, 12);
  assert.equal(value.searchEngine, 'brave');
  assert.equal(value.gpc, false);
  assert.deepEqual(problems, []);
});

test('validateSettings: unknown search engine falls back', () => {
  const { value } = validateSettings({ searchEngine: 'nonexistent' });
  assert.equal(value.searchEngine, 'duckduckgo');
});

test('validateSettings: recordHistory — garbage falls back to default (true), valid preserved', () => {
  assert.equal(validateSettings({ recordHistory: 'yes' }).value.recordHistory, defaultSettings().recordHistory);
  assert.equal(defaultSettings().recordHistory, true);
  assert.equal(validateSettings({ recordHistory: false }).value.recordHistory, false);
});

test('validateSettings: autoUpdate — garbage falls back to default, valid preserved', () => {
  assert.equal(validateSettings({ autoUpdate: 'yes' }).value.autoUpdate, defaultSettings().autoUpdate);
  assert.equal(validateSettings({ autoUpdate: false }).value.autoUpdate, false);
});

test('rules: bad entries dropped, good ones normalized', () => {
  const { value, problems } = validateSettings({
    rules: [
      { pattern: 'HTTPS://*.YouTube.com/watch', keepAlive: true },
      { pattern: 'no spaces allowed.com x', keepAlive: true },
      { pattern: '*.ok.org', memLimitMB: 250.7 },
      'not-an-object',
      { pattern: 'localhost' },
    ],
  });
  assert.deepEqual(value.rules, [
    { pattern: '*.youtube.com', keepAlive: true },
    { pattern: '*.ok.org', memLimitMB: 251 },
    { pattern: 'localhost' },
  ]);
  assert.ok(problems.length >= 2);
});

test('normalizeHostPattern', () => {
  assert.equal(normalizeHostPattern('Example.COM'), 'example.com');
  assert.equal(normalizeHostPattern('https://example.com:8080/path'), 'example.com');
  assert.equal(normalizeHostPattern('*.example.com'), '*.example.com');
  assert.equal(normalizeHostPattern('bad host'), null);
  assert.equal(normalizeHostPattern('nodots'), null);
  assert.equal(normalizeHostPattern('localhost'), 'localhost');
  assert.equal(normalizeHostPattern(123), null);
});

test('validateSettings: runawayGuard — garbage falls back to default, valid preserved', () => {
  assert.equal(validateSettings({ runawayGuard: 'on' }).value.runawayGuard, defaultSettings().runawayGuard);
  assert.equal(validateSettings({ runawayGuard: false }).value.runawayGuard, false);
});

test('validateSettings: defaultBrowserPrompted — garbage falls back, valid preserved', () => {
  assert.equal(validateSettings({ defaultBrowserPrompted: 'yes' }).value.defaultBrowserPrompted, false);
  assert.equal(validateSettings({ defaultBrowserPrompted: true }).value.defaultBrowserPrompted, true);
});

test('validateSettings: blockAds — garbage falls back to default, valid preserved', () => {
  assert.equal(validateSettings({ blockAds: 'yes' }).value.blockAds, defaultSettings().blockAds);
  assert.equal(validateSettings({ blockAds: false }).value.blockAds, false);
});

test('noBlockHosts: normalized, deduped, wildcards and www collapse, junk dropped', () => {
  const { value, problems } = validateSettings({
    noBlockHosts: ['HTTPS://WWW.Example.com/x', '*.youtube.com', 'www.example.com', 'bad host', 'nodots', 123],
  });
  assert.deepEqual(value.noBlockHosts, ['example.com', 'youtube.com']);
  assert.ok(problems.length >= 3);
  assert.deepEqual(validateSettings({ noBlockHosts: 'nope' }).value.noBlockHosts, []);
});

test('noBlockHosts: capped at 200', () => {
  const many = Array.from({ length: 250 }, (_, i) => `site${i}.example`);
  const { value, problems } = validateSettings({ noBlockHosts: many });
  assert.equal(value.noBlockHosts.length, 200);
  assert.ok(problems.some((p) => p.includes('truncated at 200')));
});

test('sitePermissions: hosts normalized and merged, unknown kinds/values/hosts dropped, non-objects dropped', () => {
  const { value, problems } = validateSettings({
    sitePermissions: {
      'WWW.Meet.Example': { camera: 'allow', microphone: 'deny', screen: 'allow', geolocation: 'prompt' },
      'meet.example': { notifications: 'allow' },
      'bad host': { camera: 'allow' },
      'x.org': 'allow',
      'nothing.example': { bogus: 'allow', clipboard: true },
      '__proto__': { camera: 'allow' },
    },
  });
  assert.deepEqual(value.sitePermissions, { 'meet.example': { camera: 'allow', microphone: 'deny', notifications: 'allow' } });
  assert.ok(problems.length >= 6, `problems: ${problems.join(' | ')}`);
  assert.deepEqual(validateSettings({ sitePermissions: ['meet.example'] }).value.sitePermissions, {});
  assert.deepEqual(validateSettings({ sitePermissions: 'meet.example' }).value.sitePermissions, {});
  assert.deepEqual(validateSettings({}).value.sitePermissions, {});
  assert.deepEqual(defaultSettings().sitePermissions, {});
  // Valid input is preserved exactly, in order.
  const good = { 'a.example': { geolocation: 'deny' }, 'b.example': { camera: 'allow', clipboard: 'allow' } };
  const r = validateSettings({ ...defaultSettings(), sitePermissions: good });
  assert.deepEqual(r.value.sitePermissions, good);
  assert.deepEqual(r.problems, []);
});

test('sitePermissions: capped at 200 sites, oldest dropped', () => {
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`site${i}.example`, { camera: 'allow' }]));
  const { value, problems } = validateSettings({ sitePermissions: many });
  const hosts = Object.keys(value.sitePermissions);
  assert.equal(hosts.length, 200);
  assert.equal(hosts[0], 'site50.example');
  assert.equal(hosts[199], 'site249.example');
  assert.ok(problems.some((p) => p.includes('truncated to the newest 200')));
});

test('normalizeSiteHost', () => {
  assert.equal(normalizeSiteHost('WWW.Example.COM'), 'example.com');
  assert.equal(normalizeSiteHost('*.x.org'), 'x.org');
  assert.equal(normalizeSiteHost('https://www.news.example.co.uk:443/a?b'), 'news.example.co.uk');
  assert.equal(normalizeSiteHost('www.com'), 'www.com'); // never stripped to a bare TLD
  assert.equal(normalizeSiteHost('localhost'), 'localhost');
  assert.equal(normalizeSiteHost('bad host'), null);
  assert.equal(normalizeSiteHost(123), null);
});
