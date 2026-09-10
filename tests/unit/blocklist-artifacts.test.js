// Provenance + conformance for the bundled filter-list artifacts (ADR-0009).
//
// These tests need @ghostery/adblocker from node_modules. Unit tests must
// still "run anywhere, no deps" (CLAUDE.md), so without node_modules the
// whole file degrades to one skipped test — CI is the enforcing environment.
//
// What red means here:
//   - "deserialize" failing after a Dependabot bump = the serialized engine
//     format moved; regenerate with `npm run blocklists -- --from-local`.
//   - "byte-for-byte" failing = someone edited an artifact or the raw lists
//     without going through scripts/build-blocklists.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const adblocker = await import('@ghostery/adblocker').catch(() => null);

if (!adblocker) {
  test('blocklist artifacts (skipped)', (t) => {
    t.skip('@ghostery/adblocker not installed — provenance is checked in CI');
  });
} else {
  const { FiltersEngine, Request } = adblocker;
  // Must match ENGINE_CONFIG in scripts/build-blocklists.mjs.
  const ENGINE_CONFIG = { loadCosmeticFilters: false, loadGenericCosmeticsFilter: false, enableCompression: true };
  const dataUrl = (/** @type {string} */ f) => new URL(`../../src/main/electron/data/${f}`, import.meta.url);
  const rawUrl = (/** @type {string} */ f) => new URL(`../../assets/blocklists/${f}`, import.meta.url);
  const manifest = JSON.parse(readFileSync(dataUrl('blocklists.json'), 'utf8'));

  test('engine artifacts deserialize at the pinned adblocker version', () => {
    for (const name of ['easylist', 'easyprivacy']) {
      const engine = FiltersEngine.deserialize(new Uint8Array(readFileSync(dataUrl(`${name}.engine`))));
      assert.ok(engine instanceof FiltersEngine, `${name}.engine deserializes`);
    }
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(manifest.adblockerVersion, pkg.dependencies['@ghostery/adblocker'],
      'manifest was built at the pinned adblocker version');
  });

  test('artifacts are exactly parse(checked-in raw lists)', () => {
    for (const name of ['easylist', 'easyprivacy']) {
      const rebuilt = FiltersEngine.parse(readFileSync(rawUrl(`${name}.txt`), 'utf8'), ENGINE_CONFIG).serialize();
      const shipped = new Uint8Array(readFileSync(dataUrl(`${name}.engine`)));
      assert.ok(Buffer.from(rebuilt).equals(Buffer.from(shipped)), `${name}.engine matches its raw list byte-for-byte`);
    }
  });

  test('manifest sha256 matches the raw list files', () => {
    for (const name of ['easylist', 'easyprivacy']) {
      const digest = createHash('sha256').update(readFileSync(rawUrl(`${name}.txt`), 'utf8')).digest('hex');
      assert.equal(manifest.lists[name].sha256, digest, `${name} raw list hash`);
    }
  });

  test('canonical offenders block, benign third parties pass (real engines)', () => {
    const engines = {
      ads: FiltersEngine.deserialize(new Uint8Array(readFileSync(dataUrl('easylist.engine')))),
      tracking: FiltersEngine.deserialize(new Uint8Array(readFileSync(dataUrl('easyprivacy.engine')))),
    };
    const match = (/** @type {string} */ url, sourceUrl = 'https://news.example.com/') =>
      engines.ads.match(Request.fromRawDetails({ url, type: 'script', sourceUrl })).match ||
      engines.tracking.match(Request.fromRawDetails({ url, type: 'script', sourceUrl })).match;
    assert.ok(match('https://ad.doubleclick.net/adj/x.js'), 'doubleclick blocked');
    assert.ok(match('https://www.google-analytics.com/analytics.js'), 'google-analytics blocked');
    assert.ok(match('https://connect.facebook.net/en_US/fbevents.js'), 'facebook pixel blocked');
    assert.ok(!match('https://cdn.jsdelivr.net/npm/lib.min.js'), 'jsdelivr passes');
    assert.ok(!match('https://api.github.com/repos'), 'github api passes');
  });

  test('full stack: loadBlockerEngines + decideBlock behave under defaultSettings', async () => {
    const { loadBlockerEngines } = await import('../../src/main/electron/blocker.js');
    const { decideBlock } = await import('../../src/shared/blocking.js');
    const { defaultSettings } = await import('../../src/shared/defaults.js');
    const matchers = loadBlockerEngines();
    const s = defaultSettings();
    const req = (/** @type {string} */ url, resourceType = 'script') => ({ url, resourceType });

    assert.equal(decideBlock(req('https://ad.doubleclick.net/adj/x.js'), 'news.example.com', s, matchers), true);
    assert.equal(decideBlock(req('https://cdn.jsdelivr.net/npm/lib.min.js'), 'news.example.com', s, matchers), false);
    // First-party document loads are never cancelled — even on a tracker's own site.
    assert.equal(decideBlock(req('https://criteo.com/about', 'mainFrame'), 'criteo.com', s, matchers), false);
    // Per-site shield beats the engines.
    assert.equal(
      decideBlock(req('https://ad.doubleclick.net/adj/x.js'), 'news.example.com',
        { ...s, noBlockHosts: ['news.example.com'] }, matchers),
      false,
    );
    // blockTrackers alone (EasyPrivacy) still catches analytics.
    assert.equal(
      decideBlock(req('https://www.google-analytics.com/analytics.js'), 'shop.example.org',
        { ...s, blockAds: false }, matchers),
      true,
    );
  });
}
