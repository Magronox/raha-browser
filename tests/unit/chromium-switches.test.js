// 0.3.3: the Privacy Sandbox ad APIs are off (backport of 1.0's audit B3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISABLED_BLINK_FEATURES, DISABLED_FEATURES } from '../../src/main/electron/chromium-switches.js';

const read = (/** @type {string} */ f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

test('the Privacy Sandbox ad APIs are switched off, in one list per switch, before the app is ready', () => {
  for (const name of ['AdInterestGroupAPI', 'Fledge', 'InterestGroupsInSharedStorageWorklet', 'SharedStorageAPI', 'AttributionReporting', 'TopicsAPI', 'PrivateStateTokens', 'FencedFrames', 'WebAuth']) {
    assert.ok(DISABLED_BLINK_FEATURES.includes(name), name);
  }
  assert.deepEqual([...DISABLED_FEATURES], ['BrowsingTopics', 'FencedFrames', 'Fledge', 'SharedStorageAPI']);
  const index = read('src/main/index.js');
  assert.equal((index.match(/appendSwitch\('disable-blink-features'/g) ?? []).length, 1, 'one disable-blink-features switch (a second would replace the first)');
  assert.equal((index.match(/appendSwitch\('disable-features'/g) ?? []).length, 1);
  assert.match(index, /appendSwitch\('disable-blink-features', DISABLED_BLINK_FEATURES\.join\(','\)\)/);
  assert.match(index, /appendSwitch\('disable-features', DISABLED_FEATURES\.join\(','\)\)/);
  assert.ok(index.indexOf("appendSwitch('disable-features'") < index.indexOf('app.whenReady()'));
});
