// Offline UI harness: real Engine (fake ports) in Node + the real UI in
// Chromium, bridged over Playwright's exposeFunction — the same split as
// main-process vs UI view in the real app. Verifies rendering, interactions,
// escaping, and produces the README screenshots. Run: npm run test:ui
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { createMockMain, seedDemo } from './mock-bridge.mjs';
import { EVENT } from '../../src/shared/ipc-contract.js';
import { INVOKE } from '../../src/shared/ipc-contract.js';
import { must, ok } from '../helpers.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shotsDir = path.join(repoRoot, 'docs', 'screenshots');

/** Resolve playwright from local node_modules or well-known global installs. */
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    'playwright',
    '/home/claude/.npm-global/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('playwright not found — npm i -D playwright (or @playwright/test)');
}

let failures = 0;
let n = 0;
/** @param {string} name @param {() => Promise<void>|void} fn */
async function t(name, fn) {
  n += 1;
  try {
    await fn();
    console.log(`ok ${n} - ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`not ok ${n} - ${name}\n  ${String(err).split('\n')[0]}`);
  }
}
/** @param {unknown} cond @param {string} msg */
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const pw = /** @type {typeof import('playwright')} */ (loadPlaywright());
const { chromium } = pw;
const server = await startServer();
const mock = createMockMain();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

// --- bridge: window.raha over exposeFunction, events via __rahaEmit
await page.exposeFunction('__rahaInvoke', (/** @type {string} */ channel, /** @type {unknown} */ payload) =>
  mock.invoke(channel, payload));
await page.addInitScript(() => {
  /** @type {Map<string, Set<(p: unknown) => void>>} */
  const listeners = new Map();
  /** @type {any} */ (window).raha = {
    version: '0.1.0-harness',
    invoke: (/** @type {string} */ c, /** @type {unknown} */ p) => /** @type {any} */ (window).__rahaInvoke(c, p),
    on: (/** @type {string} */ c, /** @type {(p: unknown) => void} */ h) => {
      if (!listeners.has(c)) listeners.set(c, new Set());
      listeners.get(c)?.add(h);
      return () => listeners.get(c)?.delete(h);
    },
  };
  /** @type {any} */ (window).__rahaEmit = (/** @type {string} */ c, /** @type {unknown} */ p) => {
    for (const h of listeners.get(c) ?? []) h(p);
  };
});

// Engine events -> page (snapshot pushes + toasts), mirroring ipc.js.
let pageReady = false;
const pump = async () => {
  if (!pageReady) return;
  const evts = mock.drainEvents();
  if (evts.length === 0) return;
  const hasSnapshot = evts.some((e) => e.type === 'snapshot');
  for (const e of evts) {
    if (e.type === 'toast') await page.evaluate(([c, p]) => /** @type {any} */ (window).__rahaEmit(c, p), [EVENT.toast, e]);
    if (e.type === 'findResult') await page.evaluate(([c, p]) => /** @type {any} */ (window).__rahaEmit(c, p), [EVENT.findResult, e]);
    if (e.type === 'askExternal') await page.evaluate(([c, p]) => /** @type {any} */ (window).__rahaEmit(c, p), [EVENT.askExternal, e]);
    if (e.type === 'askPermission') await page.evaluate(([c, p]) => /** @type {any} */ (window).__rahaEmit(c, p), [EVENT.askPermission, e.ask]);
  }
  if (hasSnapshot) {
    await page.evaluate(([c, p]) => /** @type {any} */ (window).__rahaEmit(c, p), [EVENT.snapshot, mock.engine.snapshot()]);
  }
};

// --- seed and load
const seeded = seedDemo(mock);
// XSS canary: a hostile page title must render inert.
const evil = ok(mock.engine.tabCreate({ url: 'https://evil.example.com', activate: false }));
must(mock.engine.tabNode(evil.tabId), 'evil tab node').title = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
mock.drainEvents();

await page.goto(`${server.url}/src/ui/index.html`);
await page.waitForSelector('#sidebar .row', { timeout: 15000 });
pageReady = true;

await t('boot: sidebar shows folders and tabs from the engine', async () => {
  const names = await page.$$eval('#sidebar .row.folder .name', (els) => els.map((e) => e.textContent));
  assert(names.includes('Work') && names.includes('Research') && names.includes('Media'), `folders missing: ${names}`);
  const tabRows = await page.$$('#sidebar .row.tab');
  assert(tabRows.length === 10, `expected 10 tab rows, got ${tabRows.length}`);
  // Depth must be applied via CSSOM: the page CSP blocks style="" attributes,
  // which silently flattened the tree before (caught only here and in e2e).
  const depths = await page.$$eval('#sidebar .row[data-depth="1"]', (els) =>
    els.map((e) => getComputedStyle(e).getPropertyValue('--depth').trim()));
  assert(depths.length > 0 && depths.every((d) => d === '1'), `indentation lost (CSP?): ${depths}`);
});

await t('livebar shows exactly the running tabs with memory badges', async () => {
  const chips = await page.$$('#livebar .chip');
  assert(chips.length === 3, `expected 3 chips, got ${chips.length}`);
  const stats = await page.$eval('#livebar .live-stats', (el) => el.textContent);
  assert(stats?.includes('3/5 live'), `stats wrong: ${stats}`);
  const badges = await page.$$eval('#livebar .membadge', (els) => els.map((e) => e.textContent));
  assert(badges.some((b) => b?.includes('MB')), `no MB badge: ${badges}`);
});

await t('hostile tab title renders as text (no XSS)', async () => {
  const xss = await page.evaluate(() => /** @type {any} */ (window).__xss);
  assert(xss === undefined, `XSS fired: ${xss}`);
  const row = await page.$(`#sidebar .row[data-id="${evil.tabId}"] .name`);
  const text = await row?.textContent();
  assert(text?.includes('<img'), 'title should show the raw text, escaped');
});

await t('grid: shows cards for root; folder card drill-down works', async () => {
  // A tab is active after seeding — the grid only renders when no tab is
  // shown (in the real app the content view covers it). Go to grid first.
  mock.engine.tabShowGrid();
  await pump();
  await page.waitForSelector('#content .card', { timeout: 5000 });
  const cards = await page.$$('#content .card');
  assert(cards.length >= 4, `expected cards, got ${cards.length}`);
  await page.click('#content .foldercard');
  await pump();
  const crumbs = await page.$eval('#content .crumbs', (el) => el.textContent);
  assert(crumbs?.includes('All tabs'), `crumbs missing: ${crumbs}`);
});

await t('clicking an asleep card wakes the tab (engine + livebar agree)', async () => {
  // Go to Research folder, wake Hacker News.
  const research = mock.engine.snapshot().folders.find((f) => f.name === 'Research');
  assert(research, 'research folder');
  await page.evaluate(() => /** @type {any} */ (window).__rahaEmit('noop', null)); // flush microtasks
  // Navigate the UI to root then research via crumbs/cards is fiddly; use store event path: click sidebar folder name.
  const rows = await page.$$('#sidebar .row.folder');
  for (const r of rows) {
    const name = await r.$eval('.name', (el) => el.textContent);
    if (name === 'Research') { await r.$eval('.name', (el) => /** @type {HTMLElement} */ (el).click()); break; }
  }
  await pump();
  const before = mock.engine.snapshot().stats.runningCount;
  await page.click(`#content .card[data-opentab="${seeded.hn}"]`);
  await pump();
  const snap = mock.engine.snapshot();
  assert(snap.activeTabId === seeded.hn, 'hn should be active');
  assert(snap.stats.runningCount === before + 1, 'one more renderer');
  const chips = await page.$$('#livebar .chip');
  assert(chips.length === before + 1, 'livebar reflects wake');
});

await t('sleep button on a live chip sleeps the tab', async () => {
  const before = mock.engine.snapshot().stats.runningCount;
  await page.hover(`#livebar .chip[data-chip="${seeded.music}"]`);
  await page.click(`#livebar .chip [data-chipsleep="${seeded.music}"]`);
  await pump();
  assert(mock.engine.snapshot().stats.runningCount === before - 1, 'music slept');
  const state = mock.engine.snapshot().tabs.find((x) => x.id === seeded.music)?.state;
  assert(state === 'asleep', `state=${state}`);
});

await t('omnibox Enter navigates the active tab through the engine', async () => {
  await page.click('.omnibox');
  await page.fill('.omnibox', 'example.com/path');
  await page.keyboard.press('Enter');
  await pump();
  const active = mock.engine.snapshot().activeTabId;
  const url = mock.engine.tabNode(/** @type {string} */(active))?.url;
  assert(url === 'https://example.com/path', `url=${url}`);
});

await t('omnibox keeps focus and text across snapshot re-renders', async () => {
  await page.click('.omnibox');
  await page.keyboard.type('hacker');
  // A governor tick pushes a fresh snapshot -> full topbar re-render while
  // the user is mid-word. Focus, text, and caret must all survive it.
  mock.engine.tick();
  await pump();
  await page.keyboard.type(' news');
  const state = await page.$eval('.omnibox', (el) => {
    const i = /** @type {HTMLInputElement} */ (el);
    const a = document.activeElement;
    return { value: i.value, focused: a === i, caret: i.selectionStart,
      activeEl: a ? `${a.tagName}.${a.className}` : 'none' };
  });
  assert(state.value === 'hacker news', `typed text lost across re-render: "${state.value}" (focus on ${state.activeEl})`);
  assert(state.focused, 'omnibox lost focus after re-render');
  assert(state.caret === 'hacker news'.length, `caret jumped to ${state.caret}`);
  await page.keyboard.press('Escape'); // restore the URL display for later scenarios
});

await t('settings modal: cap slider + rule add flow write through', async () => {
  await page.click('[data-act="settings"]');
  await pump();
  await page.waitForSelector('.modal.settings');
  await page.$eval('input[data-set="maxLiveTabs"]', (el) => {
    const i = /** @type {HTMLInputElement} */ (el);
    i.value = '3';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await pump();
  assert(mock.engine.settings.maxLiveTabs === 3, 'cap not applied');
  // NOTE: the cap STAYS at 3 for every scenario below this one. With the two
  // seeded protected tabs (keepAlive + audible) that leaves a single free
  // slot, so a later scenario that needs a tab running in the BACKGROUND must
  // raise the cap itself and put it back (see the site-permission queue one).
  await page.fill('[data-rule-pattern]', '*.slack.com');
  await page.check('[data-rule-keepalive]');
  await page.fill('[data-rule-mem]', '800');
  await page.click('[data-rule-addbtn]');
  await pump();
  const rules = mock.engine.settings.rules;
  assert(rules.some((r) => r.pattern === '*.slack.com' && r.keepAlive && r.memLimitMB === 800), `rules=${JSON.stringify(rules)}`);
  await page.keyboard.press('Escape');
  await pump();
});

await t('settings: blockAds/blockTrackers checkboxes write through (data-set-bool wiring)', async () => {
  // First scenario ever driving the generic checkbox wiring — R-102 toggles.
  await page.click('[data-act="settings"]');
  await pump();
  await page.waitForSelector('.modal.settings');
  assert(mock.engine.settings.blockAds === true, 'blockAds should default on');
  await page.uncheck('input[data-set-bool="blockAds"]');
  await pump();
  assert(mock.engine.settings.blockAds === false, 'unchecking blockAds did not write through');
  assert(mock.engine.settings.blockTrackers === true, 'blockTrackers must be untouched by the blockAds toggle');
  assert(mock.engine.settings.schemaVersion === 3, 'settings should be at schema v3');
  await page.check('input[data-set-bool="blockAds"]');
  await pump();
  assert(mock.engine.settings.blockAds === true, 'rechecking blockAds did not write through');
  await page.uncheck('input[data-set-bool="blockTrackers"]');
  await pump();
  assert(mock.engine.settings.blockTrackers === false, 'unchecking blockTrackers did not write through');
  await page.check('input[data-set-bool="blockTrackers"]');
  await pump();
  assert(mock.engine.settings.blockTrackers === true, 'rechecking blockTrackers did not write through');
  await page.keyboard.press('Escape');
  await pump();
});

await t('shield button: per-site off writes noBlockHosts and restyles; global-off dims and opens Settings', async () => {
  // A fresh tab with a known host: earlier scenarios navigate the seeded
  // tabs, so their URLs are not stable by the time this one runs.
  const fresh = ok(mock.engine.tabCreate({ url: 'https://sub.shieldtest.example/page' }));
  await pump();
  const omni = await page.$eval('.omnibox', (el) => /** @type {HTMLInputElement} */ (el).value);
  assert(omni.includes('shieldtest'), `fresh tab not active in the UI: omnibox="${omni}"`);
  await page.waitForSelector('.shieldbtn.on');
  await page.click('.shieldbtn');
  await page.waitForTimeout(80); // settingsSet + navReload round-trip
  await pump();
  assert(mock.engine.settings.noBlockHosts.includes('sub.shieldtest.example'),
    `noBlockHosts=${JSON.stringify(mock.engine.settings.noBlockHosts)}`);
  await page.waitForSelector('.shieldbtn.off');
  const tip = await page.$eval('.shieldbtn', (el) => el.getAttribute('title'));
  assert(tip?.includes('sub.shieldtest.example'), `tooltip should name the site: ${tip}`);
  await page.click('.shieldbtn'); // second click re-enables
  await page.waitForTimeout(80);
  await pump();
  assert(mock.engine.settings.noBlockHosts.length === 0, 'entry not removed on second click');
  await page.waitForSelector('.shieldbtn.on');
  // Blocking globally off -> shield dims, and clicking it opens Settings.
  mock.engine.settingsSet({ blockAds: false, blockTrackers: false });
  await pump();
  await page.waitForSelector('.shieldbtn.dim');
  await page.click('.shieldbtn');
  await pump();
  await page.waitForSelector('.modal.settings');
  await page.keyboard.press('Escape');
  mock.engine.settingsSet({ blockAds: true, blockTrackers: true });
  // Leave the world as found for the scenarios after us (tab counts matter).
  mock.engine.tabClose({ tabId: fresh.tabId });
  await pump();
});

await t('context menu appears on right-click with tab actions', async () => {
  await page.click(`#sidebar .row[data-id="${seeded.gh}"] .name`, { button: 'right' });
  await pump();
  const items = await page.$$eval('.ctx-item', (els) => els.map((e) => e.textContent));
  assert(items.some((i) => i?.includes('Sleep') || i?.includes('Wake')), `items=${items}`);
  assert(items.some((i) => i?.includes('Memory limit') || i?.includes('memory limit')), 'limit item missing');
  assert(items.some((i) => i?.includes('Clear cookies')), 'clear-site-data item missing');
  // Menu position must be set via CSSOM (page CSP blocks style="" attributes).
  const pos = await page.$eval('.ctxmenu', (el) => {
    const h = /** @type {HTMLElement} */ (el);
    return { left: h.style.left, top: h.style.top };
  });
  assert(/^\d+px$/.test(pos.left) && /^\d+px$/.test(pos.top), `menu not positioned: ${JSON.stringify(pos)}`);
  await page.keyboard.press('Escape');
  await pump();
});

await t('folder rename keeps typed text across re-renders; commits on Enter', async () => {
  await page.click('#sidebar .tree .row.folder .name', { button: 'right' });
  await pump();
  await page.click('[data-ctx="rename"]');
  await pump();
  await page.keyboard.type('Deep'); // replaces the select-all'd old name
  mock.engine.tick(); // governor tick mid-rename: must not wipe or commit
  await pump();
  const mid = await page.$eval('[data-rename]', (el) =>
    /** @type {HTMLInputElement} */ (el).value).catch(() => null);
  assert(mid === 'Deep', `rename lost mid-typing (committed early?): ${mid}`);
  await page.keyboard.type(' Work');
  await page.keyboard.press('Enter');
  await pump();
  const names = await page.$$eval('#sidebar .tree .row.folder .name', (els) => els.map((e) => e.textContent));
  assert(names.includes('Deep Work'), `rename not committed: ${names}`);
});

await t('livebar chips get the same tab context menu (incl. clear-site-data)', async () => {
  await page.waitForSelector('#livebar .chip');
  await page.click('#livebar .chip', { button: 'right' });
  await pump();
  const items = await page.$$eval('.ctx-item', (els) => els.map((e) => e.textContent));
  assert(items.some((i) => i?.includes('Sleep') || i?.includes('Wake')), `items=${items}`);
  assert(items.some((i) => i?.includes('Clear cookies')), 'clear-site-data item missing on livebar');
  await page.keyboard.press('Escape');
  await pump();
});

await t('folder rename commits on click-away, surviving a mid-rename tick', async () => {
  // The click-away (blur) commit path — the one that silently lost renames
  // on pre-memo builds when the blur raced a governor-tick rebuild ("my
  // folders always keep the predefined name"). Start a rename, type, let a
  // tick land, then click empty space: the typed name must commit.
  const origName = await page.$eval('#sidebar .tree .row.folder .name', (el) => el.textContent ?? '');
  await page.click('#sidebar .tree .row.folder .name', { button: 'right' });
  await pump();
  await page.click('[data-ctx="rename"]');
  await pump();
  await page.keyboard.type('Renamed By Blur');
  mock.engine.tick(); // rebuild pressure mid-rename
  await pump();
  await page.click('#sidebar .side-drop'); // empty area: pure blur, no handler
  await pump();
  const names = await page.$$eval('#sidebar .tree .row.folder .name', (els) => els.map((e) => e.textContent));
  assert(names.includes('Renamed By Blur'), `blur commit lost: ${names}`);
  // Put the original name back for later scenarios.
  const f = must(mock.engine.snapshot().folders.find((x) => x.name === 'Renamed By Blur'), 'renamed folder');
  mock.engine.folderRename({ folderId: f.id, name: origName });
  await pump();
});

await t('settings rule input keeps typed text across re-renders', async () => {
  await page.click('[data-act="settings"]');
  await pump();
  await page.waitForSelector('.modal.settings');
  await page.click('[data-rule-pattern]');
  await page.keyboard.type('*.you');
  mock.engine.tick(); // re-render mid-word
  await pump();
  await page.keyboard.type('tube.com');
  const v = await page.$eval('[data-rule-pattern]', (el) => /** @type {HTMLInputElement} */ (el).value);
  assert(v === '*.youtube.com', `settings input lost text: "${v}"`);
  await page.keyboard.press('Escape');
  await pump();
});

await t('settings About: shows the app version; links open as tabs, never navigate the chrome', async () => {
  await page.click('[data-act="settings"]');
  await pump();
  await page.waitForSelector('.modal.settings');
  const about = await page.$eval('.about-line', (el) => el.textContent);
  assert(about?.includes('0.1.0-harness'), `About must show the bridge version, got: ${about}`);
  const before = mock.engine.snapshot().tabs.length;
  await page.click('[data-about-link="https://venmo.com/u/magronox"]');
  await pump();
  assert((await page.$('.modal.settings')) === null, 'settings must close when an About link opens');
  const snap = mock.engine.snapshot();
  assert(snap.tabs.length === before + 1, 'About link must create a tab');
  const made = snap.tabs.find((t2) => t2.url.startsWith('https://venmo.com/'));
  assert(made, `new tab must carry the support URL: ${snap.tabs.map((t2) => t2.url)}`);
  assert(page.url().includes('/src/ui/index.html'), 'chrome page must never navigate (invariant #13)');
  mock.engine.nodeRemove({ nodeId: /** @type {string} */ (made?.id) });
  mock.engine.tabShowGrid();
  await pump();
});

await t('find in page: bar opens on the active tab, counts, cycles, Esc clears', async () => {
  mock.engine.tabActivate({ tabId: seeded.docs });
  await pump();
  await page.evaluate(([c]) => /** @type {any} */ (window).__rahaEmit(c, {}), [EVENT.openFind]);
  await page.waitForSelector('#topbar .findbox');
  await page.type('#topbar .findbox', 'memory');
  await pump(); // findResult flows back through the real engine + fake view
  let count = await page.$eval('#topbar .findcount', (el) => el.textContent);
  assert(count === '1/3', `expected 1/3, got "${count}"`);
  await page.keyboard.press('Enter'); // next match
  await pump();
  count = await page.$eval('#topbar .findcount', (el) => el.textContent);
  assert(count === '2/3', `expected 2/3 after Enter, got "${count}"`);
  await page.click('#topbar [data-act="findprev"]');
  await pump();
  count = await page.$eval('#topbar .findcount', (el) => el.textContent);
  assert(count === '1/3', `expected 1/3 after prev, got "${count}"`);
  // A governor tick mid-session must not wipe the input or close the bar.
  mock.engine.tick();
  await pump();
  const v = await page.$eval('#topbar .findbox', (el) => /** @type {HTMLInputElement} */ (el).value);
  assert(v === 'memory', `find text lost across a tick: "${v}"`);
  // Clearing the needle stops the session and blanks the count.
  const stops = () => mock.world.ops.filter((o) => o.startsWith(`stopFind:${seeded.docs}:`)).length;
  const stopsBefore = stops();
  await page.fill('#topbar .findbox', '');
  await pump();
  count = await page.$eval('#topbar .findcount', (el) => el.textContent);
  assert(count === '', `count must blank when the needle is cleared, got "${count}"`);
  assert(stops() === stopsBefore + 1, 'clearing the needle must stopFind');
  await page.focus('#topbar .findbox');
  await page.keyboard.press('Escape');
  await pump();
  assert((await page.$('#topbar .findbox')) === null, 'Esc must close the find bar');
  assert(stops() === stopsBefore + 2, 'Esc must clear highlights in the page');
  mock.engine.tabShowGrid();
  await pump();
});

await t('find bar closes when the active tab changes (highlights cleared)', async () => {
  mock.engine.tabActivate({ tabId: seeded.docs });
  await pump();
  await page.evaluate(([c]) => /** @type {any} */ (window).__rahaEmit(c, {}), [EVENT.openFind]);
  await page.waitForSelector('#topbar .findbox');
  await page.type('#topbar .findbox', 'raha');
  await pump();
  const opsBefore = mock.world.ops.length;
  mock.engine.tabActivate({ tabId: seeded.gh });
  await pump();
  assert((await page.$('#topbar .findbox')) === null, 'find bar must close on tab switch');
  assert(mock.world.ops.slice(opsBefore).some((o) => o.startsWith(`stopFind:${seeded.docs}:`)),
    'the old tab must get stopFind on switch');
  mock.engine.tabShowGrid();
  await pump();
});

await t('omnibox suggestions: visited urls resurface, keyboard nav, chrome raised while open', async () => {
  // Visit a page then close its tab — only local history remembers it.
  const made = ok(mock.engine.tabCreate({ url: 'https://zzz-unique.example/dish', activate: true }));
  await pump();
  assert(mock.engine.history.entries.some((e) => e.url === 'https://zzz-unique.example/dish'),
    'own visit must be recorded');
  mock.engine.tabClose({ tabId: made.tabId });
  mock.engine.tabShowGrid();
  await pump();
  await page.click('.omnibox');
  await page.type('.omnibox', 'zzz-unique');
  await page.waitForSelector('.omnisuggest.open .sug');
  const texts = await page.$$eval('.omnisuggest .sug', (els) => els.map((e) => e.textContent));
  assert(texts.some((x) => x?.includes('zzz-unique.example')), `history suggestion missing: ${texts}`);
  assert(mock.world.chromeOnTop === true, 'dropdown hangs over the page area — chrome must be raised');
  // A governor tick mid-typing re-renders the topbar; the swap fires a blur
  // on the focused omnibox — the dropdown must survive it (isConnected guard).
  mock.engine.tick();
  await pump();
  assert((await page.$('.omnisuggest.open .sug')) !== null, 'dropdown must survive a tick re-render');
  assert(mock.world.chromeOnTop === true, 'chrome stays raised across the tick');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await pump();
  let snap = mock.engine.snapshot();
  const opened = must(snap.tabs.find((t2) => t2.url === 'https://zzz-unique.example/dish'), 'opened from suggestion');
  assert(snap.activeTabId === opened.id, 'Enter on a suggestion must open the url');
  assert(mock.world.chromeOnTop === false, 'chrome lowered after accepting');

  // Same query again: the page is now an OPEN tab — suggested as switch-to-tab,
  // deduped against its own history entry, and Enter activates instead of duplicating.
  mock.engine.tabShowGrid();
  await pump();
  await page.click('.omnibox');
  await page.type('.omnibox', 'zzz-unique');
  await page.waitForSelector('.omnisuggest.open .sug-tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await pump();
  snap = mock.engine.snapshot();
  assert(snap.activeTabId === opened.id, 'switch-to-tab suggestion must activate the tab');
  assert(snap.tabs.filter((t2) => t2.url === 'https://zzz-unique.example/dish').length === 1,
    'no duplicate tab from a switch-to-tab suggestion');

  // Esc closes just the dropdown (focus stays for a second Esc to blur).
  mock.engine.tabShowGrid();
  await pump();
  await page.click('.omnibox');
  await page.type('.omnibox', 'zzz-unique');
  await page.waitForSelector('.omnisuggest.open');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.omnisuggest.open', { state: 'detached' });
  assert(mock.world.chromeOnTop === false, 'Esc must lower the chrome again');
  mock.engine.tabClose({ tabId: opened.id });
  mock.engine.tabShowGrid();
  await pump();
});

// --- omnibox actions block. The complaint: typing an address "always opens a
// new tab, sometimes in a random window". With a tab showing, Enter must go
// THERE; the dropdown must say what Enter will do and name the folder a new
// tab would land in; a page already open elsewhere is an OFFER to switch.

/** Action rows as rendered: mode, highlighted?, text. */
const actionRowsOnPage = () => page.$$eval('.omnisuggest .sug.action', (els) => els.map((e) => ({
  mode: /** @type {HTMLElement} */ (e).dataset.mode,
  sel: e.classList.contains('sel'),
  text: e.textContent ?? '',
})));

await t('omnibox actions: with a tab showing, "Open here" is the default — Enter navigates it, no new tab', async () => {
  // A root-level tab, showing: the new-tab row must name root as "All tabs".
  const made = ok(mock.engine.tabCreate({ url: 'https://act-start.example/', activate: true }));
  await pump();
  const before = mock.engine.snapshot().tabs.length;
  await page.click('.omnibox');
  await page.fill('.omnibox', 'act-here.example/page');
  await page.waitForSelector('.omnisuggest.open .sug.action');
  let rows = await actionRowsOnPage();
  assert(rows[0]?.mode === 'here' && rows[0].sel, `"Open here" must be the highlighted default: ${JSON.stringify(rows)}`);
  assert(rows[0].text.includes('Open here') && rows[0].text.includes('act-here.example/page'),
    `the row must show the resolved address: ${rows[0].text}`);
  assert(rows.some((r) => r.mode === 'new' && r.text.includes('Open in new tab → All tabs')),
    `the new-tab row must name the folder: ${JSON.stringify(rows)}`);
  assert(!rows.some((r) => r.mode === 'switch'), 'no open tab has that page — nothing to switch to');
  // A governor tick mid-typing rebuilds the topbar: the block must survive.
  mock.engine.tick();
  await pump();
  rows = await actionRowsOnPage();
  assert(rows[0]?.mode === 'here' && rows[0].sel, 'actions block must survive a tick re-render');
  await page.keyboard.press('Enter');
  await pump();
  const snap = mock.engine.snapshot();
  assert(snap.tabs.length === before, `Enter must not open a tab: ${before} -> ${snap.tabs.length}`);
  assert(snap.activeTabId === made.tabId, 'the same tab stays showing');
  assert(must(mock.engine.tabNode(made.tabId), 'node').url === 'https://act-here.example/page', 'the tab itself navigated');
  assert((await page.$('.omnisuggest.open')) === null, 'dropdown closes on accept');
  mock.engine.tabClose({ tabId: made.tabId });
  mock.engine.tabShowGrid();
  await pump();
});

await t('omnibox actions: Ctrl/⌘+Enter opens a NEW tab beside the showing tab — its folder, not the sidebar\'s', async () => {
  const proj = must(mock.engine.snapshot().folders.find((f) => f.name === 'Project Raha'), 'seeded folder');
  const research = must(mock.engine.snapshot().folders.find((f) => f.name === 'Research'), 'seeded folder');
  // The sidebar selection says Research; the showing tab (gh) lives in Project Raha.
  await page.click(`#sidebar .row[data-id="${research.id}"] .name`);
  await pump();
  mock.engine.tabActivate({ tabId: seeded.gh });
  await pump();
  const ghUrl = must(mock.engine.tabNode(seeded.gh), 'gh').url;
  const before = mock.engine.snapshot().tabs.length;
  await page.click('.omnibox');
  await page.fill('.omnibox', 'https://act-new.example/');
  await page.waitForSelector('.omnisuggest.open .sug.action[data-mode="new"]');
  const rows = await actionRowsOnPage();
  const newRow = must(rows.find((r) => r.mode === 'new'), 'new row');
  assert(newRow.text.includes('Open in new tab → Project Raha'), `row must name the SHOWING tab's folder: ${newRow.text}`);
  assert(!newRow.sel, 'with a tab showing, new-tab is an alternative, not the default');
  await page.keyboard.press('Control+Enter');
  await pump();
  const snap = mock.engine.snapshot();
  assert(snap.tabs.length === before + 1, `exactly one new tab: ${before} -> ${snap.tabs.length}`);
  const madeTab = must(snap.tabs.find((t2) => t2.url === 'https://act-new.example/'), 'new tab');
  assert(madeTab.parentId === proj.id, 'new tab must sit beside the showing tab (Project Raha), not in the viewed folder');
  assert(snap.activeTabId === madeTab.id, 'the new tab is shown');
  assert(must(mock.engine.tabNode(seeded.gh), 'gh').url === ghUrl, 'the showing tab was left alone');
  mock.engine.tabClose({ tabId: madeTab.id });
  mock.engine.tabShowGrid();
  await pump();
});

await t('omnibox actions: a page open in another tab offers "Switch to open tab"; accepting activates it', async () => {
  // An asleep tab elsewhere already has the page (trailing slash and all).
  const twin = ok(mock.engine.tabCreate({ url: 'https://act-twin.example/page/', activate: false }));
  must(mock.engine.tabNode(twin.tabId), 'twin').title = 'The twin page';
  mock.engine.tabActivate({ tabId: seeded.gh });
  await pump();
  const before = mock.engine.snapshot().tabs.length;
  await page.click('.omnibox');
  await page.fill('.omnibox', 'act-twin.example/page'); // no scheme, no trailing slash: sameUrl bridges both
  await page.waitForSelector('.omnisuggest.open .sug.action[data-mode="switch"]');
  const rows = await actionRowsOnPage();
  assert(rows[0]?.mode === 'here' && rows[0].sel, 'switching is an OFFER — "Open here" stays the default');
  const sw = must(rows.find((r) => r.mode === 'switch'), 'switch row');
  assert(sw.text.includes('Switch to open tab') && sw.text.includes('The twin page'), `switch row must name the tab: ${sw.text}`);
  await page.keyboard.press('ArrowDown'); // here -> switch
  await page.keyboard.press('Enter');
  await pump();
  const snap = mock.engine.snapshot();
  assert(snap.activeTabId === twin.tabId, 'must jump to the tab that already has the page');
  assert(snap.tabs.length === before, 'no duplicate tab');
  mock.engine.tabClose({ tabId: twin.tabId });
  mock.engine.tabShowGrid();
  await pump();
});

await t('omnibox actions: on a folder\'s grid the default row names that folder, and Enter lands the tab there', async () => {
  const proj = must(mock.engine.snapshot().folders.find((f) => f.name === 'Project Raha'), 'seeded folder');
  await page.click(`#sidebar .row[data-id="${proj.id}"] .name`); // grid shows the folder; no tab showing
  await pump();
  const before = new Set(mock.engine.snapshot().tabs.map((t2) => t2.id));
  try {
    await page.click('.omnibox');
    await page.fill('.omnibox', 'https://act-grid.example/');
    await page.waitForSelector('.omnisuggest.open .sug.action');
    const rows = await actionRowsOnPage();
    assert(!rows.some((r) => r.mode === 'here'), 'no tab showing — nothing to open "here"');
    const def = must(rows.find((r) => r.sel), 'a default row is highlighted');
    assert(def.mode === 'new' && def.text.includes('Open in new tab → Project Raha'), `default must name the folder: ${def.text}`);
    await page.keyboard.press('Enter');
    await pump();
    // Compare by id, not by count: a tab closed asynchronously by the previous
    // scenario must not make this one miscount (issue #6).
    const added = mock.engine.snapshot().tabs.filter((t2) => !before.has(t2.id));
    assert(added.length === 1, `one new tab, got ${added.length}: ${added.map((t2) => t2.url).join(', ')}`);
    assert(added[0].url === 'https://act-grid.example/', `created tab url: ${added[0].url}`);
    assert(added[0].parentId === proj.id, 'tab must land in the folder the row named');
  } finally {
    // Whatever happened, leave no stray tab in the seeded folder — the drag
    // scenarios later assert its exact child order.
    for (const t2 of mock.engine.snapshot().tabs) {
      if (!before.has(t2.id)) mock.engine.nodeRemove({ nodeId: t2.id });
    }
    await pump();
    await page.click('#sidebar .rootrow .name'); // restore root selection for later scenarios
    await pump();
  }
});

await t('app-link ask: a zoom link prompts, cancel opens nothing, remember stops asking', async () => {
  const made = ok(mock.engine.tabCreate({ url: 'https://meet.example/', activate: true }));
  await pump();
  const view = must(mock.world.viewsByTab.get(made.tabId), 'view');
  // A page asks to open Zoom -> the engine emits askExternal -> modal.
  view.cb.onOpenUrl('zoommtg://zoom.us/join?confno=999');
  await pump();
  await page.waitForSelector('[data-ext-open]');
  const body = await page.$eval('.modal.mini', (el) => el.textContent ?? '');
  assert(body.includes('Zoom'), `ask must name the app: ${body}`);
  assert(body.includes('confno=999'), 'ask must show the full url being approved');
  assert(mock.world.openedExternally.length === 0, 'nothing opened before the user answers');

  // Cancel: the OS is never touched.
  // the .modal-backdrop also carries data-ext-cancel and matches first, but
  // the modal covers its centre — click the button itself.
  await page.click('.modal.mini [data-ext-cancel]');
  await page.waitForSelector('[data-ext-open]', { state: 'detached' });
  await pump();
  assert(mock.world.openedExternally.length === 0, 'cancel must open nothing');

  // Ask again, tick "always", accept -> opens AND remembers the scheme.
  view.cb.onOpenUrl('zoommtg://zoom.us/join?confno=1000');
  await pump();
  await page.waitForSelector('[data-ext-open]');
  await page.check('[data-ext-remember]');
  await page.click('.modal.mini [data-ext-open]');
  await page.waitForSelector('[data-ext-open]', { state: 'detached' });
  await pump();
  assert(mock.world.openedExternally.includes('zoommtg://zoom.us/join?confno=1000'), 'accept must reach the OS');
  assert(mock.engine.settings.allowedExternalSchemes.includes('zoommtg'), 'scheme remembered');

  // Remembered: the next zoom link opens with no modal at all.
  view.cb.onOpenUrl('zoommtg://zoom.us/join?confno=1001');
  await pump();
  assert((await page.$('[data-ext-open]')) === null, 'a remembered scheme must not ask again');
  assert(mock.world.openedExternally.includes('zoommtg://zoom.us/join?confno=1001'), 'a remembered scheme opens without asking');

  // Settings shows it and can revoke it (self-service, no config file editing).
  await page.click('[data-act="settings"]');
  await pump();
  await page.waitForSelector('.modal.settings');
  await page.click('[data-forget-scheme="zoommtg"]');
  await pump();
  assert(!mock.engine.settings.allowedExternalSchemes.includes('zoommtg'), 'revoked from Settings');
  await page.keyboard.press('Escape');
  await pump();
  mock.engine.tabClose({ tabId: made.tabId });
  mock.engine.tabShowGrid();
  await pump();
});

await t('app-link ask: a newer ask replaces the modal — and Escape declines it', async () => {
  const made = ok(mock.engine.tabCreate({ url: 'https://evil.example/', activate: true }));
  await pump();
  const view = must(mock.world.viewsByTab.get(made.tabId), 'view');
  const openedBefore = mock.world.openedExternally.length;

  // Bait-and-switch regression: the page swaps the pending URL while the
  // modal is up. The modal must follow (show what the engine would open) —
  // an Open click must never launch a URL the user wasn't looking at.
  view.cb.onOpenUrl('zoommtg://zoom.us/join?confno=REAL');
  await pump();
  await page.waitForSelector('[data-ext-open]');
  view.cb.onOpenUrl('smb://attacker.example/share');
  await pump();
  const body = await page.$eval('.modal.mini', (el) => el.textContent ?? '');
  assert(body.includes('smb://attacker.example/share'), `modal must show the URL the engine would open: ${body}`);
  assert(!body.includes('confno=REAL'), 'the superseded URL must be gone from the modal');
  await page.click('.modal.mini [data-ext-open]');
  await page.waitForSelector('[data-ext-open]', { state: 'detached' });
  await pump();
  const opened = mock.world.openedExternally.slice(openedBefore);
  assert(opened.length === 1 && opened[0] === 'smb://attacker.example/share',
    `exactly the displayed url opens: ${JSON.stringify(opened)}`);

  // Escape = decline: modal closes, engine-side pending state clears, the
  // OS is untouched (and no runaway alert gets snoozed as a side effect).
  view.cb.onOpenUrl('zoommtg://zoom.us/join?confno=555');
  await pump();
  await page.waitForSelector('[data-ext-open]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-ext-open]', { state: 'detached' });
  await pump();
  assert(mock.world.openedExternally.length === openedBefore + 1, 'Escape must open nothing');
  const r = mock.engine.externalOpen({ id: 999999 });
  assert('error' in r && r.error === 'nothing pending', `engine pending cleared: ${JSON.stringify(r)}`);
  mock.engine.tabClose({ tabId: made.tabId });
  mock.engine.tabShowGrid();
  await pump();
});

await t('site-permission ask: right words for the active tab; once/always/never/Not now/Escape each answer the engine', async () => {
  const made = ok(mock.engine.tabCreate({ url: 'https://meet.example/room', activate: true }));
  await pump();
  /** A page on the tab asks — what index.js hands the engine from the privacy adapter.
   * @param {string[]} kinds @param {{ requestingHost?: string, isMainFrame?: boolean }} [o] */
  const req = (kinds, o = {}) => mock.engine.permissionRequest({
    tabId: made.tabId, kinds, host: 'meet.example', requestingHost: o.requestingHost ?? 'meet.example', isMainFrame: o.isMainFrame ?? true,
  });
  const title = () => page.$eval('.modal.mini .perm-title', (el) => el.textContent ?? '');

  // Allow once: granted, nothing remembered.
  const p1 = req(['microphone', 'camera']);
  await pump();
  await page.waitForSelector('[data-perm="once"]');
  assert((await title()) === 'meet.example wants to use your camera and microphone', `title: ${await title()}`);
  assert((await page.$('.perm-frame')) === null, 'a main-frame ask has no embedded-frame line');
  await page.click('.modal.mini [data-perm="once"]');
  await page.waitForSelector('[data-perm="once"]', { state: 'detached' });
  await pump();
  assert((await p1) === true, 'Allow once grants');
  assert(Object.keys(mock.engine.settings.sitePermissions).length === 0, 'once remembers nothing');

  // Always allow: granted AND remembered — the next identical request shows no modal.
  const p2 = req(['notifications']);
  await pump();
  await page.waitForSelector('[data-perm="always"]');
  assert((await title()) === 'meet.example wants to show notifications', `title: ${await title()}`);
  await page.click('.modal.mini [data-perm="always"]');
  await page.waitForSelector('[data-perm="always"]', { state: 'detached' });
  await pump();
  assert((await p2) === true, 'Always allow grants');
  assert(mock.engine.settings.sitePermissions['meet.example']?.notifications === 'allow', 'always persisted');
  assert((await req(['notifications'])) === true, 'a remembered allow answers silently');
  await pump();
  assert((await page.$('[data-perm="once"]')) === null, 'no modal for a remembered decision');

  // Never: refused AND remembered.
  const p3 = req(['geolocation']);
  await pump();
  await page.waitForSelector('[data-perm="never"]');
  assert((await title()) === 'meet.example wants to use your location', `title: ${await title()}`);
  await page.click('.modal.mini [data-perm="never"]');
  await page.waitForSelector('[data-perm="never"]', { state: 'detached' });
  await pump();
  assert((await p3) === false, 'Never refuses');
  assert(mock.engine.settings.sitePermissions['meet.example']?.geolocation === 'deny', 'never persisted');
  assert((await req(['geolocation'])) === false, 'a remembered deny answers silently');
  await pump();
  assert((await page.$('[data-perm="once"]')) === null, 'no modal for a remembered deny');

  // Not now: refused, nothing remembered. An embedded frame's ask says so —
  // and that frame's host is page-controlled, so it must render inert.
  const p4 = req(['clipboard'], { requestingHost: '<img src=x onerror="window.__xssPerm=1">', isMainFrame: false });
  await pump();
  await page.waitForSelector('[data-perm-dismiss]');
  const frame = await page.$eval('.perm-frame', (el) => el.textContent ?? '');
  assert(frame.includes('Asked by an embedded frame from <img src=x'), `frame line: ${frame}`);
  assert((await page.evaluate(() => /** @type {any} */ (window).__xssPerm)) === undefined, 'hostile frame host executed');
  await page.click('.modal.mini button[data-perm-dismiss]');
  await page.waitForSelector('[data-perm="once"]', { state: 'detached' });
  await pump();
  assert((await p4) === false, 'Not now refuses');
  assert(mock.engine.settings.sitePermissions['meet.example']?.clipboard === undefined, 'Not now remembers nothing');

  // …so the site asks again; Escape is Not now too.
  const p5 = req(['clipboard']);
  await pump();
  await page.waitForSelector('[data-perm="once"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-perm="once"]', { state: 'detached' });
  await pump();
  assert((await p5) === false, 'Escape = Not now');
  const r = mock.engine.permissionAnswer({ id: 999999, decision: 'once' });
  assert('error' in r && r.error === 'stale ask', `engine pending cleared: ${JSON.stringify(r)}`);
  mock.engine.tabClose({ tabId: made.tabId });
  mock.engine.tabShowGrid();
  await pump();
});

await t('site-permission ask: only for the page on screen — withdrawn when its tab leaves, back (same ask) when it returns; queued asks follow in order', async () => {
  // This scenario needs a BACKGROUND tab that keeps its renderer: an ask from
  // a tab with no renderer is refused on the spot and never queued. The
  // settings scenario above left the cap at 3, and with the two seeded
  // protected tabs (keepAlive + audible) there is only one free slot — so the
  // governor slept `a` the moment `b` was created and the queued ask never
  // existed. Give the governor headroom for the scenario and put it back.
  const capBefore = mock.engine.settings.maxLiveTabs;
  mock.engine.settingsSet({ maxLiveTabs: 8 });
  const a = ok(mock.engine.tabCreate({ url: 'https://a.example/', activate: true }));
  const b = ok(mock.engine.tabCreate({ url: 'https://b.example/', activate: true })); // active; a keeps running
  assert(mock.engine.runtime.has(a.tabId), 'a must still be running, or its ask is refused before it is queued');
  await pump();
  const pA = mock.engine.permissionRequest({ tabId: a.tabId, kinds: ['camera'], host: 'a.example', requestingHost: 'a.example', isMainFrame: true });
  await pump();
  assert((await page.$('[data-perm-id]')) === null, 'never a dialog for a page the user cannot see');
  const pB = mock.engine.permissionRequest({ tabId: b.tabId, kinds: ['geolocation'], host: 'b.example', requestingHost: 'b.example', isMainFrame: true });
  const pB2 = mock.engine.permissionRequest({ tabId: b.tabId, kinds: ['clipboard'], host: 'b.example', requestingHost: 'b.example', isMainFrame: true });
  await pump();
  await page.waitForSelector('[data-perm-id]');
  const shownId = await page.$eval('[data-perm-id]', (el) => /** @type {HTMLElement} */ (el).dataset.permId);
  assert((await page.$eval('.perm-title', (el) => el.textContent)) === 'b.example wants to use your location', 'the active tab\'s ask, first in line');

  // Grid: no page on screen -> no ask on screen (the request stays pending).
  mock.engine.tabShowGrid();
  await pump();
  await page.waitForSelector('[data-perm-id]', { state: 'detached' });
  mock.engine.tabActivate({ tabId: b.tabId });
  await pump();
  await page.waitForSelector('[data-perm-id]');
  assert((await page.$eval('[data-perm-id]', (el) => /** @type {HTMLElement} */ (el).dataset.permId)) === shownId, 'the SAME ask returns');
  await page.click('.modal.mini [data-perm="once"]');
  await pump();
  assert((await pB) === true, 'Allow once grants the first queued ask');
  await page.waitForSelector('[data-perm-id]');
  assert((await page.$eval('.perm-title', (el) => el.textContent)) === 'b.example wants to read your clipboard', 'the queue advances');
  await page.click('.modal.mini button[data-perm-dismiss]');
  await pump();
  assert((await pB2) === false, 'Not now refuses the second');
  await page.waitForSelector('[data-perm-id]', { state: 'detached' });

  // Switch to the background tab: its waiting ask shows now.
  mock.engine.tabActivate({ tabId: a.tabId });
  await pump();
  await page.waitForSelector('[data-perm-id]');
  assert((await page.$eval('.perm-title', (el) => el.textContent)) === 'a.example wants to use your camera', 'the background tab\'s ask shows once it is on screen');
  // Closing the tab refuses it and takes the dialog with it.
  mock.engine.tabClose({ tabId: a.tabId });
  await pump();
  assert((await pA) === false, 'a closed tab\'s ask is refused');
  await page.waitForSelector('[data-perm-id]', { state: 'detached' });
  mock.engine.tabClose({ tabId: b.tabId });
  mock.engine.tabShowGrid();
  mock.engine.settingsSet({ maxLiveTabs: capBefore });
  await pump();
});

await t('settings: Site permissions lists remembered decisions; a chip\'s × forgets one kind, "Forget site" the rest', async () => {
  mock.engine.settingsSet({ sitePermissions: {
    'meet.example': { camera: 'allow', microphone: 'deny', geolocation: 'deny' },
    'news.example': { notifications: 'allow' },
  } });
  await pump();
  await page.click('[data-act="settings"]');
  await pump();
  await page.waitForSelector('.modal.settings .perm-row');
  const rows = await page.$$eval('.perm-row', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
  assert(rows.length === 2, `expected 2 site rows, got ${rows.length}`);
  assert(rows[0].includes('meet.example') && rows[0].includes('camera: allowed') && rows[0].includes('microphone: blocked') && rows[0].includes('location: blocked'), `row: ${rows[0]}`);
  assert(rows[1].includes('news.example') && rows[1].includes('notifications: allowed'), `row: ${rows[1]}`);

  await page.click('[data-perm-forget-host="meet.example"][data-perm-forget-kind="microphone"]');
  await pump();
  await page.waitForSelector('[data-perm-forget-host="meet.example"][data-perm-forget-kind="microphone"]', { state: 'detached' });
  const meet = mock.engine.settings.sitePermissions['meet.example'];
  assert(meet && meet.microphone === undefined && meet.camera === 'allow' && meet.geolocation === 'deny', `× forgets exactly one kind: ${JSON.stringify(meet)}`);

  await page.click('.perm-forget-site[data-perm-forget-host="meet.example"]');
  await pump();
  await page.waitForSelector('.perm-forget-site[data-perm-forget-host="meet.example"]', { state: 'detached' });
  assert(!('meet.example' in mock.engine.settings.sitePermissions), 'Forget site drops the whole site');
  assert(mock.engine.settings.sitePermissions['news.example']?.notifications === 'allow', 'other sites untouched');

  await page.click('.perm-forget-site[data-perm-forget-host="news.example"]');
  await pump();
  await page.waitForSelector('.perm-row', { state: 'detached' });
  const empty = await page.$eval('.perm-sites', (el) => el.textContent ?? '');
  assert(empty.includes('No decisions yet — sites ask when they need something.'), `empty state: ${empty}`);
  assert(Object.keys(mock.engine.settings.sitePermissions).length === 0, 'nothing left');
  await page.keyboard.press('Escape');
  await pump();
});

await t('CSP allows tab thumbnails and blocks page-supplied http images', async () => {
  // The chrome's img-src is deliberately narrow. Two ways to get this wrong:
  // too tight breaks thumbnails silently (a broken img just hides itself),
  // too loose lets a page's favicon URL point the chrome at arbitrary hosts —
  // it used to allow http://127.0.0.1:* purely so this harness worked.
  /** @type {string[]} */ const violations = [];
  const onMsg = (/** @type {import('playwright').ConsoleMessage} */ m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  };
  page.on('console', onMsg);

  // Drill into a folder so tab cards (which carry thumbnails) render.
  const folderRows = await page.$$('#sidebar .row.folder');
  for (const r of folderRows) {
    const name = await r.$eval('.name', (el) => el.textContent);
    if (name === 'Research') { await r.$eval('.name', (el) => /** @type {HTMLElement} */ (el).click()); break; }
  }
  await pump();
  await page.waitForSelector('#content .card', { timeout: 5000 });
  await page.waitForTimeout(300);

  const thumbs = await page.$$eval('img.thumb', (els) =>
    els.map((e) => ({ src: e.getAttribute('src') ?? '', ok: /** @type {HTMLImageElement} */ (e).naturalWidth > 0 })));
  assert(thumbs.length > 0, 'expected thumbnail images to render');
  const blocked = thumbs.filter((t2) => !t2.ok);
  assert(blocked.length === 0, `CSP blocked ${blocked.length}/${thumbs.length} thumbnails: ${blocked[0]?.src}`);

  // A hostile page can set any favicon URL; the chrome must not fetch one
  // over plain http (that would let a page probe local services).
  const httpImgLoaded = await page.evaluate(() => new Promise((resolve) => {
    const img = document.createElement('img');
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = 'http://127.0.0.1:9/should-be-blocked.png';
    setTimeout(() => resolve(false), 1500);
  }));
  assert(httpImgLoaded === false, 'chrome CSP allowed a plain-http image');

  page.off('console', onMsg);
  assert(violations.length > 0, 'expected a CSP violation for the blocked http image');
});

await t('history panel: import from a fake browser, search, open an entry', async () => {
  // Raha records its OWN visits now (R-106) — earlier scenarios navigated
  // tabs, so start this import test from a clean store to keep its exact
  // entry-count assertions meaningful.
  mock.engine.historyClear();
  // Seed a detectable source on the fake world (the importers port).
  mock.world.historySources = [{ id: 'hs-test', browser: 'Chrome', label: 'Default', kind: 'chromium' }];
  mock.world.historyBySource.set('hs-test', {
    entries: [
      { url: 'https://example.com/alpha', title: 'Alpha page', lastVisitMs: 1_750_000_000_000, visitCount: 3 },
      { url: 'https://example.com/beta', title: '<img src=x onerror="window.__xssHist=1">', lastVisitMs: 1_750_000_100_000, visitCount: 1 },
      { url: 'file:///etc/passwd', title: 'never shown', lastVisitMs: 1_750_000_000_000, visitCount: 1 },
    ],
    problems: [],
  });

  await page.click('[data-act="history"]');
  await page.waitForSelector('.modal.history');
  await page.waitForSelector('.hist-src input');
  await page.click('[data-import]');
  await page.waitForSelector('.hist-row');
  await pump(); // the engine toasts the import result

  const titles = await page.$$eval('.hist-row .hist-title', (els) => els.map((e) => e.textContent));
  assert(titles.length === 2, `expected 2 entries (file:// dropped), got ${titles.length}`);
  assert(titles.includes('Alpha page'), 'imported entry listed');
  // Hostile imported title must render as text (esc()), never as markup.
  const xss = await page.evaluate(() => /** @type {any} */ (window).__xssHist);
  assert(xss === undefined, 'hostile history title executed');

  // Search narrows the list and keeps focus + text across a governor tick.
  await page.click('[data-hist-search]');
  await page.keyboard.type('alp');
  mock.engine.tick();
  await pump();
  await page.keyboard.type('ha');
  await page.waitForFunction(() => document.querySelectorAll('.hist-row').length === 1);
  const sv = await page.$eval('[data-hist-search]', (el) => ({
    v: /** @type {HTMLInputElement} */ (el).value, f: document.activeElement === el,
  }));
  assert(sv.v === 'alpha', `search lost text: "${sv.v}"`);
  assert(sv.f, 'search input lost focus across re-render');

  // Clicking an entry opens it as a real tab and closes the panel.
  await page.click('.hist-row');
  await pump();
  const urls = mock.engine.snapshot().tabs.map((t2) => t2.url);
  assert(urls.includes('https://example.com/alpha'), 'history entry opened as a tab');
  assert((await page.$('.modal.history')) === null, 'panel closed after opening an entry');

  // Leave the world as the next scenario expects it.
  const created = mock.engine.snapshot().tabs.find((t2) => t2.url === 'https://example.com/alpha');
  if (created) mock.engine.nodeRemove({ nodeId: created.id });
  mock.engine.historyClear();
  await pump();
});

await t('history panel: "Show more" pages past the first 200 to the end of the store', async () => {
  mock.engine.historyClear();
  // 450 entries: more than two pages, so the button must survive a click and
  // then disappear exactly when the last one is on screen.
  mock.world.historySources = [{ id: 'hs-many', browser: 'Chrome', label: 'Big', kind: 'chromium' }];
  mock.world.historyBySource.set('hs-many', {
    entries: Array.from({ length: 450 }, (_, i) => ({
      url: `https://many.example/p${i}`, title: `Page ${i}`,
      lastVisitMs: 1_750_000_000_000 - i * 1000, visitCount: 1,
    })),
    problems: [],
  });
  await page.click('[data-act="history"]');
  await page.waitForSelector('.modal.history');
  await page.waitForSelector('.hist-src input');
  await page.click('[data-import]');
  await page.waitForSelector('.hist-row');
  await pump();

  const rows = () => page.$$eval('.hist-row', (els) => els.length);
  assert(await rows() === 200, `first page must be 200 rows, got ${await rows()}`);
  assert((await page.$eval('.hist-more .mini-sub', (el) => el.textContent)) === 'Showing 200 of 450.', 'count line names the total');

  await page.click('[data-hist-more]');
  await page.waitForFunction(() => document.querySelectorAll('.hist-row').length === 400);
  // Appended, not replaced: the first page is still above the new rows.
  const first = await page.$eval('.hist-row .hist-title', (el) => el.textContent);
  assert(first === 'Page 0', `paging must append, not restart: first row is "${first}"`);

  await page.click('[data-hist-more]');
  await page.waitForFunction(() => document.querySelectorAll('.hist-row').length === 450);
  assert((await page.$('[data-hist-more]')) === null, 'the button goes away once everything is shown');
  assert((await page.$eval('.hist-more .mini-sub', (el) => el.textContent)) === 'Showing 450 of 450.', 'final count');

  // A search resets to a single page of matches (never appends onto the old list).
  await page.click('[data-hist-search]');
  await page.keyboard.type('p1');
  await page.waitForFunction(() => {
    const n = document.querySelectorAll('.hist-row').length;
    return n > 0 && n <= 200;
  });
  const searched = await page.$$eval('.hist-row .hist-title', (els) => els.map((e) => e.textContent ?? ''));
  assert(searched.every((s) => s.includes('1')), 'search must filter, not append');

  await page.click('.modal-head [data-close-history]'); // the button, not the backdrop
  await page.waitForSelector('.modal.history', { state: 'detached' });
  mock.engine.historyClear();
  await pump();
});

await t('open-tabs import: source listed, import builds asleep folders, report shown', async () => {
  mock.world.openTabSources = [{ id: 'ts-ui', browser: 'Firefox', label: 'default — window & tab layout', kind: 'session' }];
  mock.world.openTabsBySource.set('ts-ui', {
    browser: 'Firefox',
    windows: [
      { tabs: [{ url: 'https://imported-one.example/', title: 'Imported one' }] },
      { tabs: [{ url: 'https://imported-two.example/', title: 'Imported two' }] },
    ],
    problems: [],
  });

  await page.click('[data-act="history"]');
  await page.waitForSelector('.modal.history');
  await page.waitForSelector('[data-opentabs="ts-ui"]');
  await page.click('[data-opentabs="ts-ui"]');
  await page.waitForSelector('.hist-report');
  await pump(); // import toast + snapshot with the new folders

  const report = await page.$eval('.hist-report', (el) => el.textContent);
  assert(report?.includes('2 tabs across 2 windows'), `report: ${report}`);
  const snap = mock.engine.snapshot();
  const top = snap.folders.find((f) => f.name === 'Firefox import');
  assert(top, 'import folder created');
  const tabs = snap.tabs.filter((t2) => t2.url.startsWith('https://imported-'));
  assert(tabs.length === 2 && tabs.every((t2) => t2.state === 'asleep'), 'imported tabs exist and are asleep');
  await page.keyboard.press('Escape');
  // Clean up: drop the imported folder so later scenarios see the world they expect.
  if (top) mock.engine.nodeRemove({ nodeId: top.id });
  mock.world.openTabSources = [];
  await pump();
});

await t('organize: preview shows groups for loose tabs, apply files them', async () => {
  // Two loose Dev tabs under root (asleep — organizing must not wake anything).
  const g1 = mock.engine.tabCreate({ url: 'https://github.com/raha', activate: false });
  const g2 = mock.engine.tabCreate({ url: 'https://gitlab.com/raha', activate: false });
  assert('tabId' in g1 && 'tabId' in g2, 'seed tabs created');
  await pump();

  await page.click('[data-organize]');
  await page.waitForSelector('.modal.organize');
  await page.waitForSelector('.org-group');
  const head = await page.$eval('.org-group .org-head b', (el) => el.textContent);
  assert(head === 'Dev', `expected a Dev group, got "${head}"`);
  const planTabs = await page.$$eval('.org-group .org-tab', (els) => els.length);
  assert(planTabs === 2, `expected 2 tabs in the preview, got ${planTabs}`);

  await page.click('[data-organize-apply]');
  await pump();
  const snap = mock.engine.snapshot();
  const dev = snap.folders.find((f) => f.name === 'Dev');
  if (!dev) throw new Error('Dev folder was not created');
  const moved = snap.tabs.filter((t2) => t2.parentId === dev.id).map((t2) => t2.url);
  assert(moved.includes('https://github.com/raha') && moved.includes('https://gitlab.com/raha'), 'both tabs filed');
  assert((await page.$('.modal.organize')) === null, 'dialog closed after apply');
  const stillRunning = snap.tabs.filter((t2) => t2.parentId === dev.id && t2.state !== 'asleep');
  assert(stillRunning.length === 0, 'organizing never wakes tabs');

  // Leave the tree as the next scenario expects it.
  mock.engine.nodeRemove({ nodeId: dev.id });
  await pump();
});

await t('runaway prompt: appears on sustained CPU, Terminate sleeps the tab', async () => {
  const created = mock.engine.tabCreate({ url: 'https://hog.example/', activate: true });
  if (!('tabId' in created)) throw new Error('hog tab not created');
  const hogId = created.tabId;
  const hogNode = mock.engine.tabNode(hogId);
  if (!hogNode) throw new Error('hog node missing');
  hogNode.title = 'CPU hog';
  for (let i = 0; i < 4; i += 1) {
    mock.world.setTabMetrics(hogId, 120, 380);
    mock.engine.tick();
  }
  await pump();
  await page.waitForSelector('.modal.runaway');
  const head = await page.$eval('.modal.runaway h3', (el) => el.textContent ?? '');
  assert(head.includes('CPU hog'), `prompt names the tab: "${head}"`);

  // "Not now" snoozes: prompt closes and stays closed while still hot.
  // (This click is also the regression guard for the .modal.mini collapse bug:
  // if the modal squeezes to a strip again, the button lands outside it and
  // this click times out against the backdrop.)
  await page.click('[data-runaway-snooze]:not(.modal-backdrop)');
  await pump();
  assert((await page.$('.modal.runaway')) === null, 'snooze closed the prompt');
  mock.world.setTabMetrics(hogId, 120, 380);
  mock.engine.tick();
  await pump();
  assert((await page.$('.modal.runaway')) === null, 'snoozed tab stays quiet');

  // After the snooze window it comes back; Terminate actually sleeps it.
  mock.world.advanceMinutes(6);
  mock.world.setTabMetrics(hogId, 120, 380);
  mock.engine.tick();
  await pump();
  await page.waitForSelector('.modal.runaway');
  await page.click('[data-runaway-kill]');
  await pump();
  assert((await page.$('.modal.runaway')) === null, 'prompt gone after terminate');
  const hog = mock.engine.snapshot().tabs.find((t2) => t2.id === hogId);
  assert(hog && hog.state === 'asleep', 'tab was terminated (asleep)');

  mock.engine.nodeRemove({ nodeId: hogId });
  await pump();
});

await t('typing a URL while viewing a folder creates the tab IN that folder', async () => {
  const proj = must(mock.engine.snapshot().folders.find((f) => f.name === 'Project Raha'), 'seeded folder');
  mock.engine.tabShowGrid();
  await pump();
  await page.click(`#sidebar .row[data-id="${proj.id}"] .name`); // select the folder (grid shows it)
  await pump();
  await page.click('.omnibox');
  await page.fill('.omnibox', 'https://in-folder.example/');
  await page.keyboard.press('Enter');
  await pump();
  const made = must(mock.engine.snapshot().tabs.find((t2) => t2.url === 'https://in-folder.example/'), 'created tab');
  assert(must(mock.engine.tabNode(made.id), 'node').parentId === proj.id,
    'tab must land in the viewed folder, not at root');
  mock.engine.nodeRemove({ nodeId: made.id });
  await pump();
  await page.click('#sidebar .rootrow .name'); // restore root selection for later scenarios
  await pump();
});

await t('default-browser ask: consent modal first, OS call only on yes', async () => {
  // Main routes evt:askDefaultBrowser once on first packaged launch; the OS
  // API must fire only after the user says yes IN RAHA.
  let invoked = 0;
  const orig = mock.handlers[INVOKE.defaultBrowserSet];
  mock.handlers[INVOKE.defaultBrowserSet] = () => { invoked += 1; return { ok: true, isDefault: true }; };
  await page.evaluate(([c]) => /** @type {any} */ (window).__rahaEmit(c, {}), [EVENT.askDefaultBrowser]);
  await page.waitForSelector('[data-db-yes]');
  // "Not now" closes without touching the OS.
  await page.click('button[data-db-no]');
  await page.waitForSelector('[data-db-yes]', { state: 'detached' });
  assert(invoked === 0, 'OS API called without consent');
  // Ask again; "Make default" consents -> OS call happens.
  await page.evaluate(([c]) => /** @type {any} */ (window).__rahaEmit(c, {}), [EVENT.askDefaultBrowser]);
  await page.waitForSelector('[data-db-yes]');
  await page.click('[data-db-yes]');
  await page.waitForSelector('[data-db-yes]', { state: 'detached' });
  await page.waitForTimeout(80);
  assert(invoked === 1, `OS API should fire exactly once after consent, got ${invoked}`);
  mock.handlers[INVOKE.defaultBrowserSet] = orig;
});

await t('sidebar toggle: button hides/shows the sidebar and tells main', async () => {
  assert(mock.world.sidebarVisible === true, 'starts visible');
  await page.click('[data-act="togglesidebar"]');
  await pump();
  assert(await page.$eval('body', (b) => b.classList.contains('sidebar-hidden')), 'body class set');
  assert(await page.$eval('#sidebar', (el) => getComputedStyle(el).display === 'none'), 'sidebar hidden');
  assert(mock.world.sidebarVisible === false, 'main told to reclaim the space');
  await page.click('[data-act="togglesidebar"]');
  await pump();
  assert(mock.world.sidebarVisible === true, 'main told to restore');
  assert(await page.$eval('#sidebar', (el) => getComputedStyle(el).display !== 'none'), 'sidebar back');
});

await t('drag reorders a tab within its folder (upper-half drop = before)', async () => {
  // Order inside "Project Raha": gh, docs, ci. Drag ci onto the TOP edge of
  // gh -> insert BEFORE it -> ci, gh, docs.
  const proj = must(mock.engine.snapshot().folders.find((f) => f.name === 'Project Raha'), 'seeded folder');
  assert(proj.childIds.join() === [seeded.gh, seeded.docs, seeded.ci].join(),
    `unexpected start order: ${proj.childIds}`);
  await page.dragAndDrop(
    `#sidebar .row[data-id="${seeded.ci}"]`,
    `#sidebar .row[data-id="${seeded.gh}"]`,
    { targetPosition: { x: 30, y: 2 } }, // top edge -> 'before' zone
  );
  await pump();
  const after = must(mock.engine.snapshot().folders.find((f) => f.name === 'Project Raha'), 'folder after drag');
  assert(after.childIds.join() === [seeded.ci, seeded.gh, seeded.docs].join(),
    `reorder failed: ${after.childIds}`);
  // Put it back for later scenarios.
  mock.engine.nodeMove({ nodeId: seeded.ci, parentId: after.id, index: 2 });
  await pump();
});

await t('sidebar never rebuilds mid-drag; the deferred change lands on dragend', async () => {
  // The isDragging() guard: a drag must freeze the sidebar DOM (a rebuild
  // destroys the dragged row and aborts the drag), and whatever changed
  // meanwhile must render as soon as the drag ends.
  const snap0 = mock.engine.snapshot();
  const work = must(snap0.folders.find((f) => f.id !== snap0.rootId && f.name !== 'Project Raha'), 'a renamable folder');
  const before = work.name;
  await page.dispatchEvent(`#sidebar .row[data-id="${seeded.gh}"]`, 'dragstart');
  const rr = mock.engine.folderRename({ folderId: work.id, name: 'Changed Mid Drag' });
  assert(!('error' in rr), `rename refused: ${JSON.stringify(rr)}`);
  mock.engine.tick();
  await pump();
  let names = await page.$$eval('#sidebar .row.folder .name', (els) => els.map((e) => e.textContent));
  assert(!names.includes('Changed Mid Drag'), 'sidebar rebuilt during an active drag');
  await page.dispatchEvent(`#sidebar .row[data-id="${seeded.gh}"]`, 'dragend');
  await pump();
  names = await page.$$eval('#sidebar .row.folder .name', (els) => els.map((e) => e.textContent));
  assert(names.includes('Changed Mid Drag'), 'deferred change did not render on dragend');
  mock.engine.folderRename({ folderId: work.id, name: before });
  await pump();
});

await t('a tab drags OUT of its folder: sidebar row dropped on the grid card area', async () => {
  // Viewing "All tabs", dropping a folder's tab onto the grid moves it to
  // root — the gesture that used to be a silent no-op (cursor said
  // "droppable", nothing happened).
  mock.engine.tabShowGrid();
  await pump();
  await page.click('#sidebar .rootrow .name');
  await pump();
  await page.waitForSelector('#content .cards');
  const proj = must(mock.engine.snapshot().folders.find((f) => f.name === 'Project Raha'), 'seeded folder');
  assert(proj.childIds.includes(seeded.gh), 'gh starts inside Project Raha');
  await page.dragAndDrop(`#sidebar .row[data-id="${seeded.gh}"]`, '#content .cards');
  await pump();
  const snap = mock.engine.snapshot();
  const rootFolder = must(snap.folders.find((f) => f.id === snap.rootId), 'root folder');
  assert(rootFolder.childIds.includes(seeded.gh), 'gh moved out of the folder to root');
  mock.engine.nodeMove({ nodeId: seeded.gh, parentId: proj.id, index: 0 });
  await pump();
});

await t('grid card drags into a sidebar folder; breadcrumb drop moves it out', async () => {
  const snap0 = mock.engine.snapshot();
  const research = must(snap0.folders.find((f) => f.name === 'Research'), 'research folder');
  const media = must(snap0.folders.find((f) => f.name === 'Media'), 'media folder');
  await page.click(`#sidebar .row[data-id="${research.id}"] .name`); // grid shows Research
  await pump();
  await page.waitForSelector(`#content .card[data-opentab="${seeded.hn}"]`);
  // Card -> sidebar folder row.
  await page.dragAndDrop(`#content .card[data-opentab="${seeded.hn}"]`, `#sidebar .row[data-id="${media.id}"]`);
  await pump();
  assert(must(mock.engine.tabNode(seeded.hn), 'hn').parentId === media.id, 'card dropped into sidebar folder');
  mock.engine.nodeMove({ nodeId: seeded.hn, parentId: research.id, index: 2 });
  await pump();
  // Card -> breadcrumb ("All tabs") = out of this folder.
  await page.waitForSelector(`#content .card[data-opentab="${seeded.hn}"]`);
  await page.dragAndDrop(`#content .card[data-opentab="${seeded.hn}"]`, '#content .crumbs a[data-crumb]');
  await pump();
  const snap = mock.engine.snapshot();
  assert(must(snap.folders.find((f) => f.id === snap.rootId), 'root').childIds.includes(seeded.hn),
    'breadcrumb drop moved the tab out of the folder');
  mock.engine.nodeMove({ nodeId: seeded.hn, parentId: research.id, index: 2 });
  await pump();
  await page.click('#sidebar .rootrow .name'); // restore root view for later scenarios
  await pump();
});

await t('grid never rebuilds mid-drag; the deferred change lands on dragend', async () => {
  const snap0 = mock.engine.snapshot();
  const rootFolder = must(snap0.folders.find((f) => f.id === snap0.rootId), 'root');
  const work = must(snap0.folders.find((f) => f.id !== snap0.rootId && rootFolder.childIds.includes(f.id)),
    'a renamable top-level folder');
  const before = work.name;
  await page.waitForSelector(`#content .card[data-openfolder="${work.id}"]`);
  await page.dispatchEvent(`#content .card[data-openfolder="${work.id}"]`, 'dragstart');
  mock.engine.folderRename({ folderId: work.id, name: 'Grid Mid Drag' });
  mock.engine.tick();
  await pump();
  let names = await page.$$eval('#content .foldername', (els) => els.map((e) => e.textContent));
  assert(!names.includes('Grid Mid Drag'), 'grid rebuilt during an active drag');
  await page.dispatchEvent(`#content .card[data-openfolder="${work.id}"]`, 'dragend');
  await pump();
  names = await page.$$eval('#content .foldername', (els) => els.map((e) => e.textContent));
  assert(names.includes('Grid Mid Drag'), 'deferred change did not render on dragend');
  mock.engine.folderRename({ folderId: work.id, name: before });
  await pump();
});

await t('evt:openHistory (menu shortcut) opens the history panel', async () => {
  await page.evaluate(([c]) => /** @type {any} */ (window).__rahaEmit(c, {}), [EVENT.openHistory]);
  await page.waitForSelector('.modal.history');
  // Click the backdrop's corner — its center is covered by the modal itself.
  await page.click('[data-close-history]', { position: { x: 5, y: 5 } });
  await page.waitForSelector('.modal.history', { state: 'detached' });
});

await t('idle governor ticks keep the existing DOM (no image-churn shimmer)', async () => {
  // Every tick used to innerHTML-rebuild grid + sidebar, recreating every
  // thumbnail/favicon <img>; cards with missing thumbnails then flashed
  // their fallback one by one — a hover-like wave over the grid. Unchanged
  // content must now keep the very same DOM nodes.
  mock.engine.tabShowGrid();
  await pump();
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__gridNode = document.querySelector('#content .card');
    w.__sideNode = document.querySelector('#sidebar .row.tab');
  });
  mock.engine.tick(); // idle tick: nothing user-visible changed
  await pump();
  const kept = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return {
      grid: w.__gridNode === document.querySelector('#content .card'),
      side: w.__sideNode === document.querySelector('#sidebar .row.tab'),
    };
  });
  assert(kept.grid, 'grid card was rebuilt on an idle tick');
  assert(kept.side, 'sidebar row was rebuilt on an idle tick');
  // A REAL change must still re-render.
  const first = mock.engine.snapshot().tabs[0];
  must(mock.engine.tabNode(first.id), 'first tab node').title = 'Retitled by test';
  mock.engine.tick();
  await pump();
  const names = await page.$$eval('#sidebar .row.tab .name', (els) => els.map((e) => e.textContent));
  assert(names.includes('Retitled by test'), `change did not re-render: ${names.slice(0, 3)}`);
});

await t('sidebar scroll position survives governor-tick re-renders', async () => {
  // The Safari open-tabs import made sidebars long enough to scroll — and
  // every governor tick re-renders via innerHTML, which used to reset the
  // tree to the top mid-scroll (captureScrollTop/restoreScrollTop in
  // render/util.js are the fix, applied to sidebar, grid, and all modals).
  const made = [];
  for (let i = 0; i < 40; i += 1) {
    made.push(ok(mock.engine.tabCreate({ url: `https://scrolltest-${i}.example/`, activate: false })).tabId);
  }
  await pump();
  const scrolled = await page.$eval('#sidebar .tree', (el) => {
    el.scrollTop = 400;
    return el.scrollTop; // browser clamps if the tree is too short to scroll
  });
  assert(scrolled > 100, `tree not scrollable enough to exercise the bug (scrollTop=${scrolled})`);
  mock.engine.tick(); // -> snapshot -> full innerHTML re-render
  await pump();
  const after = await page.$eval('#sidebar .tree', (el) => el.scrollTop);
  assert(after === scrolled, `sidebar scroll jumped after re-render: ${scrolled} -> ${after}`);
  for (const id of made) mock.engine.nodeRemove({ nodeId: id });
  await pump();
});

await t('IPC contract coverage: every INVOKE channel has a mock handler', () => {
  const missing = Object.values(INVOKE).filter((c) => !mock.handledChannels.includes(c));
  assert(missing.length === 0, `unhandled channels: ${missing}`);
});

// ---------- screenshots for the README ----------
// Opt-in (RAHA_SHOTS=1): grid.png/settings.png are git-tracked and embedded in
// the README, so refreshing them on every run dirties the working tree.
// Refresh deliberately with: RAHA_SHOTS=1 npm run test:ui
if (process.env.RAHA_SHOTS === '1') {
  fs.mkdirSync(shotsDir, { recursive: true });
  await t('screenshots captured', async () => {
    // Stage a photogenic, truthful scene: cap back to 5, tidy titles, close the
    // XSS canary, and view the Research folder (tab cards with thumbnails).
    mock.engine.settingsSet({ maxLiveTabs: 5 });
    mock.engine.nodeRemove({ nodeId: evil.tabId });
    const docsNode = mock.engine.tabNode(seeded.docs);
    if (docsNode) { docsNode.title = 'WebContentsView | Electron'; docsNode.url = 'https://www.electronjs.org/docs/latest'; }
    const hnNode = mock.engine.tabNode(seeded.hn);
    if (hnNode) { hnNode.title = 'Hacker News'; hnNode.url = 'https://news.ycombinator.com/'; }
    mock.engine.tabActivate({ tabId: seeded.hn });
    mock.engine.tabShowGrid();
    mock.drainEvents();

    // 1. Research folder grid with mixed running/asleep cards.
    const rows2 = await page.$$('#sidebar .row.folder');
    for (const r of rows2) {
      const name = await r.$eval('.name', (el) => el.textContent);
      if (name === 'Research') { await r.$eval('.name', (el) => /** @type {HTMLElement} */ (el).click()); break; }
    }
    await pump();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shotsDir, 'grid.png') });

    // 2. Settings open.
    await page.click('[data-act="settings"]');
    await pump();
    await page.waitForSelector('.modal.settings');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shotsDir, 'settings.png') });
    await page.keyboard.press('Escape');
    await pump();
  });
}

await browser.close();
server.close();
console.log(`# ui-harness: ${n - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
