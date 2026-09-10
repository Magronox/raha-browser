import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOmnibox, searchUrl, displayUrl, isNavigableUrl, isUiChromeUrl, sanitizeNavEntries, sameUrl, findTabByUrl } from '../../src/shared/urls.js';

const HTTPS = { httpsFirst: true, searchEngine: /** @type {const} */ ('duckduckgo') };
const HTTP = { httpsFirst: false, searchEngine: /** @type {const} */ ('duckduckgo') };

test('full URLs pass through', () => {
  assert.deepEqual(resolveOmnibox('https://example.com/a?b=1', HTTPS), { url: 'https://example.com/a?b=1', kind: 'url' });
  assert.deepEqual(resolveOmnibox('http://plain.dev', HTTPS), { url: 'http://plain.dev', kind: 'url' });
  assert.deepEqual(resolveOmnibox('raha://home', HTTPS), { url: 'raha://home', kind: 'url' });
});

test('bare hosts get https by default, http when httpsFirst off', () => {
  assert.deepEqual(resolveOmnibox('example.com', HTTPS), { url: 'https://example.com', kind: 'url' });
  assert.deepEqual(resolveOmnibox('example.com/path?q=1', HTTPS), { url: 'https://example.com/path?q=1', kind: 'url' });
  assert.deepEqual(resolveOmnibox('example.com', HTTP), { url: 'http://example.com', kind: 'url' });
  assert.deepEqual(resolveOmnibox('sub.domain.co.uk:8443/x', HTTPS), { url: 'https://sub.domain.co.uk:8443/x', kind: 'url' });
});

test('localhost and IPs get http', () => {
  assert.deepEqual(resolveOmnibox('localhost:3000/app', HTTPS), { url: 'http://localhost:3000/app', kind: 'url' });
  assert.deepEqual(resolveOmnibox('127.0.0.1:8080', HTTPS), { url: 'http://127.0.0.1:8080', kind: 'url' });
});

test('queries become searches', () => {
  assert.equal(resolveOmnibox('how tall is mount damavand', HTTPS).kind, 'search');
  assert.equal(resolveOmnibox('what is example.com', HTTPS).kind, 'search'); // has spaces
  assert.equal(resolveOmnibox('singleword', HTTPS).kind, 'search'); // no dot
  assert.ok(resolveOmnibox('c++ lambda', HTTPS).url.includes('duckduckgo.com/?q=c%2B%2B%20lambda'));
});

test('dangerous schemes are neutralized into searches', () => {
  assert.equal(resolveOmnibox('javascript:alert(1)', HTTPS).kind, 'search');
  assert.equal(resolveOmnibox('file:///etc/passwd', HTTPS).kind, 'search');
  assert.equal(resolveOmnibox('data:text/html,<b>x</b>', HTTPS).kind, 'search');
});

test('empty input goes home', () => {
  assert.deepEqual(resolveOmnibox('  ', HTTPS), { url: 'raha://home', kind: 'url' });
});

test('searchUrl uses the chosen engine and falls back to ddg', () => {
  assert.ok(searchUrl('x', 'brave').startsWith('https://search.brave.com/'));
  assert.ok(searchUrl('x', /** @type {any} */ ('bogus')).startsWith('https://duckduckgo.com/'));
});

test('displayUrl hides https but keeps http visible', () => {
  assert.equal(displayUrl('https://example.com/x'), 'example.com/x');
  assert.equal(displayUrl('http://example.com'), 'http://example.com');
  assert.equal(displayUrl('raha://home'), 'raha://home');
});

// --- isNavigableUrl: the scheme gate for every URL that reaches a tab.
// A page's window.open() bypasses Chromium's renderer-initiated navigation
// blocks (the main process loads it), so this list is the only thing standing
// between a hostile page and file:/// in a tab.

test('isNavigableUrl allows exactly http, https, raha and blob', () => {
  for (const u of [
    'https://example.com',
    'http://example.com',
    'HTTPS://EXAMPLE.COM',
    'raha://home',
    'raha://app/index.html',
    // blob: is origin-bound and cannot name a file on disk; sites use it to
    // open generated PDFs in a new tab.
    'blob:https://example.com/1234',
  ]) assert.equal(isNavigableUrl(u), true, `${u} should be navigable`);
});

test('isNavigableUrl refuses dangerous and unknown schemes', () => {
  for (const u of [
    'file:///etc/passwd',
    'FILE:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'view-source:file:///etc/passwd',
    // about:blank may be RESTORED into history but Raha never initiates it.
    'about:blank',
    'ws://example.com',
    'mailto:a@b.c',
    '',
  ]) assert.equal(isNavigableUrl(u), false, `${u} must not be navigable`);
});

test('isNavigableUrl refuses non-strings and relative input', () => {
  for (const u of [null, undefined, 42, {}, [], '//evil.com', '/etc/passwd', 'example.com']) {
    assert.equal(isNavigableUrl(/** @type {any} */ (u)), false);
  }
});

// --- isUiChromeUrl: pins the one view that carries the preload bridge.

test('isUiChromeUrl accepts only the chrome page itself', () => {
  for (const u of ['raha://app/index.html', 'raha://app/', 'raha://app', 'raha://app/index.html#x']) {
    assert.equal(isUiChromeUrl(u), true, `${u} is the chrome`);
  }
});

test('isUiChromeUrl rejects everything a hijack would use', () => {
  for (const u of [
    'https://evil.example',
    'file:///Users/victim/notes.html',
    'raha://app/../../etc/passwd',
    'raha://apps/index.html',
    'raha://app.evil.com/index.html',
    'raha://home',
    'raha://thumb/x.png',
    'javascript:alert(1)',
    null,
  ]) assert.equal(isUiChromeUrl(/** @type {any} */ (u)), false, `${u} must not pass as chrome`);
});

// --- sanitizeNavEntries. The first cut of the scheme gate refused the WHOLE
// history if any single entry was not http/https/raha. Probing a real Electron
// session showed that ordinary browsing produces about:blank and blob: entries
// (a page navigating itself; a site opening a generated PDF), so that rule
// silently threw away the user's back/forward stack on wake — breaking the
// promise in INVARIANTS #9 that history survives sleep.

const entriesOf = (/** @type {any} */ r) => r?.entries.map((/** @type {any} */ e) => e.url);

test('sanitizeNavEntries keeps a clean history untouched', () => {
  const nav = { entries: [{ url: 'https://a.com' }, { url: 'https://b.com' }], index: 1 };
  const r = sanitizeNavEntries(nav);
  assert.deepEqual(entriesOf(r), ['https://a.com', 'https://b.com']);
  assert.equal(r?.index, 1);
});

test('sanitizeNavEntries keeps about:blank and blob: — real browsing produces them', () => {
  const nav = {
    entries: [
      { url: 'https://a.com' },
      { url: 'about:blank' },
      { url: 'blob:https://a.com/9d5afb9c' },
      { url: 'https://b.com' },
    ],
    index: 3,
  };
  const r = sanitizeNavEntries(nav);
  assert.equal(r?.entries.length, 4, 'no entry should be dropped');
  assert.equal(r?.index, 3);
});

test('sanitizeNavEntries drops only the dangerous entries and keeps the rest', () => {
  const nav = {
    entries: [
      { url: 'https://a.com' },
      { url: 'file:///Users/victim/.ssh/id_rsa' },
      { url: 'https://b.com' },
      { url: 'javascript:alert(1)' },
      { url: 'https://c.com' },
    ],
    index: 4,
  };
  const r = sanitizeNavEntries(nav);
  assert.deepEqual(entriesOf(r), ['https://a.com', 'https://b.com', 'https://c.com']);
  assert.equal(r?.index, 2, 'still pointing at the page the user was on');
});

test('sanitizeNavEntries remaps the index when the active entry is dropped', () => {
  const nav = {
    entries: [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'file:///etc/passwd' }],
    index: 2,
  };
  const r = sanitizeNavEntries(nav);
  assert.deepEqual(entriesOf(r), ['https://a.com', 'https://b.com']);
  assert.equal(r?.index, 1, 'falls back to the nearest surviving entry before it');
});

test('sanitizeNavEntries returns null when nothing survives or input is junk', () => {
  assert.equal(sanitizeNavEntries({ entries: [{ url: 'file:///etc/passwd' }], index: 0 }), null);
  assert.equal(sanitizeNavEntries({ entries: [], index: 0 }), null);
  assert.equal(sanitizeNavEntries(null), null);
  assert.equal(sanitizeNavEntries({ entries: 'nope' }), null);
});

test('isNavigableUrl allows blob: — sites open generated PDFs that way', () => {
  assert.equal(isNavigableUrl('blob:https://site.com/9d5afb9c'), true);
  // but the dangerous set is still refused
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings']) {
    assert.equal(isNavigableUrl(u), false, `${u} must stay blocked`);
  }
});

// --- sameUrl / findTabByUrl: "is this page already open?" behind the omnibox's
// "switch to open tab" offer. Typed "example.com" resolves to
// https://example.com while the open tab reports https://example.com/ — those
// must match; a different query string or scheme is a different page.

test('sameUrl ignores the hash, scheme/host case, a default port and a trailing slash', () => {
  assert.equal(sameUrl('https://example.com', 'https://example.com/'), true);
  assert.equal(sameUrl('https://example.com/docs/', 'https://example.com/docs'), true);
  assert.equal(sameUrl('https://example.com/a#top', 'https://example.com/a#bottom'), true);
  assert.equal(sameUrl('HTTPS://Example.COM/a', 'https://example.com/a'), true);
  assert.equal(sameUrl('https://example.com:443/a', 'https://example.com/a'), true);
  assert.equal(sameUrl('https://example.com/a?x=1#frag', 'https://example.com/a?x=1'), true);
  assert.equal(sameUrl('raha://home', 'raha://home'), true);
});

test('sameUrl: a different query, path, port or scheme is a different page', () => {
  assert.equal(sameUrl('https://example.com/a?x=1', 'https://example.com/a?x=2'), false);
  assert.equal(sameUrl('https://example.com/a?x=1', 'https://example.com/a'), false);
  assert.equal(sameUrl('https://example.com/a', 'https://example.com/b'), false);
  assert.equal(sameUrl('http://example.com/', 'https://example.com/'), false);
  assert.equal(sameUrl('https://example.com:8443/', 'https://example.com/'), false);
  assert.equal(sameUrl('https://example.com/A', 'https://example.com/a'), false); // paths are case-sensitive
  assert.equal(sameUrl('https://sub.example.com/', 'https://example.com/'), false);
  assert.equal(sameUrl('not a url', 'not a url'), false); // unparseable never matches, even itself
  assert.equal(sameUrl('', ''), false);
  assert.equal(sameUrl(null, undefined), false);
});

test('findTabByUrl returns the first matching tab, or null', () => {
  const tabs = [
    { id: 'a', url: 'https://one.example/' },
    { id: 'b', url: 'https://two.example/page/' },
    { id: 'c', url: 'https://two.example/page' },
  ];
  assert.equal(findTabByUrl(tabs, 'https://two.example/page')?.id, 'b');
  assert.equal(findTabByUrl(tabs, 'https://one.example')?.id, 'a');
  assert.equal(findTabByUrl(tabs, 'https://ONE.example/#x')?.id, 'a');
  assert.equal(findTabByUrl(tabs, 'https://three.example/'), null);
  assert.equal(findTabByUrl(tabs, 'https://one.example/?q=1'), null);
  assert.equal(findTabByUrl([], 'https://one.example/'), null);
  assert.equal(findTabByUrl(tabs, 'garbage'), null);
});
