import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPageMenuTemplate } from '../../src/shared/page-menu.js';

const CAPS = { canGoBack: false, canGoForward: false, devMode: false };

/** @param {import('../../src/shared/page-menu.js').PageMenuItem[]} items */
const ids = (items) => items.map((i) => i.id ?? i.role ?? i.type);

test('bare page: navigation items only, enabled per nav state', () => {
  const items = buildPageMenuTemplate({}, { ...CAPS, canGoBack: true });
  assert.deepEqual(ids(items), ['back', 'forward', 'reload']);
  assert.equal(items[0].enabled, true);
  assert.equal(items[1].enabled, false);
});

test('web link: open + copy; javascript: link gets copy only', () => {
  const web = buildPageMenuTemplate({ linkURL: 'https://a.com/x' }, CAPS);
  assert.deepEqual(ids(web), ['open-link', 'copy-link', 'separator', 'back', 'forward', 'reload']);
  const js = buildPageMenuTemplate({ linkURL: 'javascript:alert(1)' }, CAPS);
  assert.deepEqual(ids(js), ['copy-link', 'separator', 'back', 'forward', 'reload'], 'no dead open item for gated schemes');
});

test('image: open + copy address; file:// image is not openable', () => {
  const img = buildPageMenuTemplate({ mediaType: 'image', srcURL: 'https://a.com/x.png' }, CAPS);
  assert.deepEqual(ids(img).slice(0, 3), ['open-image', 'copy-image-url', 'separator']);
  const fileImg = buildPageMenuTemplate({ mediaType: 'image', srcURL: 'file:///etc/x.png' }, CAPS);
  assert.deepEqual(ids(fileImg).slice(0, 2), ['copy-image-url', 'separator']);
});

test('editable field: native edit roles, no search item even with a selection', () => {
  const items = buildPageMenuTemplate({ isEditable: true, selectionText: 'hello' }, CAPS);
  assert.deepEqual(ids(items), ['cut', 'copy', 'paste', 'selectAll', 'separator', 'back', 'forward', 'reload']);
});

test('text selection: copy role + search item with normalized, truncated label', () => {
  const items = buildPageMenuTemplate({ selectionText: '  resource\n governor   spec ' }, CAPS);
  assert.deepEqual(ids(items).slice(0, 2), ['copy', 'search-selection']);
  assert.equal(items[1].label, 'Search for “resource governor spec”');
  const long = buildPageMenuTemplate({ selectionText: 'x'.repeat(100) }, CAPS);
  const label = long[1].label ?? '';
  assert.ok(label.length < 50 && label.includes('…'), 'long selections are truncated in the label');
});

test('devMode appends Inspect Element; off by default', () => {
  const dev = buildPageMenuTemplate({}, { ...CAPS, devMode: true });
  assert.equal(dev[dev.length - 1].id, 'inspect');
  const prod = buildPageMenuTemplate({}, CAPS);
  assert.ok(!ids(prod).includes('inspect'));
});

test('hostile params: non-string fields are ignored, never crash', () => {
  const items = buildPageMenuTemplate(
    /** @type {any} */ ({ linkURL: 42, srcURL: {}, selectionText: null, mediaType: 'image' }),
    CAPS,
  );
  assert.deepEqual(ids(items), ['back', 'forward', 'reload']);
});

test('link + image + selection compose in a stable order', () => {
  const items = buildPageMenuTemplate({
    linkURL: 'https://a.com/', mediaType: 'image', srcURL: 'https://a.com/i.png', selectionText: 'pick me',
  }, CAPS);
  assert.deepEqual(ids(items), [
    'open-link', 'copy-link', 'separator',
    'open-image', 'copy-image-url', 'separator',
    'copy', 'search-selection', 'separator',
    'back', 'forward', 'reload',
  ]);
});

test('clear-site-data appears only when the page can meaningfully have data', () => {
  const withCap = buildPageMenuTemplate({}, { ...CAPS, canClearSiteData: true });
  assert.deepEqual(ids(withCap), ['back', 'forward', 'reload', 'separator', 'clear-site-data']);
  const without = buildPageMenuTemplate({}, CAPS); // raha:// pages etc.
  assert.deepEqual(ids(without), ['back', 'forward', 'reload']);
});
