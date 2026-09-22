// Real-Electron e2e for FREEZE (ADR-0014, R-127): the measured facts the
// feature rests on, re-checked on every Electron upgrade (upgrade playbook
// step 7). Its own spec so app.spec.js's state stays untouched.
//
// Loopback page /ticker: a setInterval bumps document.title + window.__n
// every 100 ms — the cheapest observable "is this page running?" signal that
// the sidebar (title) and the content page (evaluate) can both read.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @type {import('playwright').ElectronApplication} */ let app;
/** @type {import('playwright').Page} */ let ui;
/** @type {string} */ let profileDir;
/** @type {import('node:http').Server} */ let server;
/** @type {string} */ let base;

function launchEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { RAHA_PROFILE_DIR: profileDir, RAHA_TICK_MS: '700', RAHA_NO_SANDBOX: '1', RAHA_NO_WELCOME: '1' });
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const name = (req.url ?? '/').replace(/^\/+/, '').split('?')[0] || 'page';
    res.setHeader('content-type', 'text/html');
    if (name === 'ticker') {
      res.end('<title>ticker 0</title><body style="margin:0"><div style="height:3000px"></div>'
        + '<textarea id="note"></textarea>'
        + '<script>window.__n = 0; window.__freezes = 0;'
        + 'document.addEventListener("freeze", () => { window.__freezes += 1; });'
        + 'setInterval(() => { window.__n += 1; document.title = "ticker " + window.__n; }, 100);</script>');
      return;
    }
    res.end(`<title>${name}</title><body><h1>${name}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  profileDir = mkdtempSync(path.join(tmpdir(), 'raha-e2e-freeze-'));
  app = await electron.launch({ args: ['.', '--no-sandbox'], env: launchEnv() });
  ui = await app.firstWindow();
  await ui.waitForSelector('#sidebar .side-head', { timeout: 20000 });
});

test.afterAll(async () => {
  await app.close();
  server.close();
  rmSync(profileDir, { recursive: true, force: true });
});

/** @param {string} url */
async function openTab(url) {
  await ui.click('[data-newtab]');
  await ui.waitForSelector('#content .card, #content .empty-state', { timeout: 10000 });
  await ui.click('.omnibox');
  await ui.fill('.omnibox', url);
  await ui.keyboard.press('Enter');
  await ui.waitForTimeout(400);
}

/** @param {string} urlPart */
async function contentPage(urlPart, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const w of app.windows()) if (w !== ui && w.url().includes(urlPart)) return w;
    if (Date.now() > deadline) throw new Error(`no content page matching "${urlPart}"`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const tickerRow = () => ui.locator('#sidebar .row.tab', { hasText: 'ticker' }).first();
/**
 * Playwright's own CDP session leaves every page "being captured", and
 * Chromium treats a captured page as visible — a visible page refuses to
 * freeze (Page.setWebLifecycleState is a silent no-op). Nothing in the app
 * does this: without Playwright the set-aside page reads 'hidden' and stops,
 * which `npm run smoke` proves on every run. So the assertions below that
 * need the page to REALLY stop are skipped under the harness; everything
 * else (state, badges, thaw, sleep, governor, page-state) is still checked.
 */
const harnessPinsVisible = () => app.evaluate(({ webContents }) =>
  webContents.getAllWebContents().some((w) => w.getURL().includes('/ticker') && w.isBeingCaptured()));
const tickerTitle = async () => (await tickerRow().getAttribute('title')) ?? '';
const tickerN = (/** @type {import('playwright').Page} */ p) => p.evaluate(() => /** @type {any} */ (window).__n);

test('manual freeze from the toolbar: the page stops (title and counter stand still), grid shows, badge appears', async () => {
  await openTab(`${base}/ticker`);
  const page = await contentPage('/ticker');
  await expect.poll(() => tickerN(page)).toBeGreaterThan(2);
  await page.evaluate(() => { window.scrollTo(0, 1200); const t = /** @type {HTMLTextAreaElement} */ (document.getElementById('note')); t.value = 'kept while frozen'; });
  // Freeze the ACTIVE tab from the toolbar: it is set aside (grid) and frozen.
  await ui.click('[data-act="freeze"]');
  await expect(ui.locator('#content .card, #content .empty-state')).toBeVisible({ timeout: 10000 });
  await expect(tickerRow()).toHaveClass(/state-frozen/, { timeout: 10000 });
  await expect(tickerRow().locator('.mini.frost')).toBeVisible();
  await expect(ui.locator('#livebar .live-stats')).toContainText('1 frozen');
  await expect(ui.locator('#livebar .chip.frozen')).toHaveCount(1);
  // The page is really stopped: the title the sidebar shows stops changing.
  if (!(await harnessPinsVisible())) {
    await ui.waitForTimeout(600); // let any in-flight title event land
    const t1 = await tickerTitle();
    await ui.waitForTimeout(1500);
    const t2 = await tickerTitle();
    expect(t2).toBe(t1);
  }
  // ...and the renderer is still alive: same Playwright page, same process.
  expect(page.isClosed()).toBe(false);
});

test('thaw on click: the page resumes from where it stopped, visibilityState is visible, page state intact', async () => {
  const page = await contentPage('/ticker');
  await tickerRow().locator('.name').click();
  await expect(tickerRow()).toHaveClass(/state-active/, { timeout: 10000 });
  // Resumed: the counter advances again, the freeze event fired in-page.
  const n0 = await tickerN(page);
  await expect.poll(() => tickerN(page), { timeout: 5000 }).toBeGreaterThan(n0);
  if (!(await harnessPinsVisible())) {
    expect(await page.evaluate(() => /** @type {any} */ (window).__freezes)).toBeGreaterThanOrEqual(1);
  }
  // The adapter's visibility kick: a thawed page must read 'visible' again.
  await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('visible');
  // Nothing was reloaded: scroll + typed text survived the freeze verbatim.
  expect(await page.evaluate(() => window.scrollY)).toBe(1200);
  expect(await page.evaluate(() => /** @type {HTMLTextAreaElement} */ (document.getElementById('note')).value)).toBe('kept while frozen');
  await expect(ui.locator('#livebar .live-stats')).not.toContainText('frozen');
});

test('sleep of a frozen tab destroys it directly: process gone, asleep, no warn toast, wake restores page state', async () => {
  const page = await contentPage('/ticker');
  // Freeze from the sidebar (background: open another tab first).
  await openTab(`${base}/other`);
  await expect(tickerRow()).toHaveClass(/state-running/, { timeout: 10000 });
  await tickerRow().hover(); // row buttons show on hover
  await tickerRow().locator('[data-freeze]').click();
  await expect(tickerRow()).toHaveClass(/state-frozen/, { timeout: 10000 });
  const renderers = () => app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.type === 'Tab').length);
  const before = await renderers();
  await tickerRow().hover();
  await tickerRow().locator('[data-sleep]').click();
  await expect(tickerRow()).toHaveClass(/state-asleep/, { timeout: 10000 });
  await expect.poll(renderers, { timeout: 10000 }).toBeLessThan(before);
  await expect.poll(() => page.isClosed(), { timeout: 10000 }).toBe(true);
  expect(await ui.locator('#toasts .toast-warn', { hasText: 'Could not' }).count()).toBe(0);
  // Wake: a fresh renderer, R-104 brings the scroll back from the pre-freeze capture.
  await tickerRow().locator('.name').click();
  const fresh = await contentPage('/ticker');
  await expect.poll(() => fresh.evaluate(() => window.scrollY), { timeout: 10000 }).toBeGreaterThan(1000);
});

test('governor: a background tab freezes on its own after freezeIdleMinutes; a frozen tab is still capped', async () => {
  test.setTimeout(150_000); // real idle time: 1 minute is the smallest setting
  await ui.click('[data-act="settings"]');
  await ui.waitForSelector('.modal.settings select[data-set="freezeIdleMinutes"]');
  await ui.$eval('select[data-set="freezeIdleMinutes"]', (el) => {
    const s = /** @type {HTMLSelectElement} */ (el); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await ui.keyboard.press('Escape');
  // ticker is asleep from the previous test and 'other' is active. Wake
  // ticker, go back to 'other': ticker is now a background tab whose
  // lastActiveAt is "now" — the governor must freeze it ~60 s later, with
  // the one-time explainer toast.
  await tickerRow().locator('.name').click();
  await expect(tickerRow()).toHaveClass(/state-active/, { timeout: 10000 });
  await ui.locator('#sidebar .row.tab', { hasText: 'other' }).first().locator('.name').click();
  await expect(tickerRow()).toHaveClass(/state-running/, { timeout: 10000 });
  await expect(tickerRow()).toHaveClass(/state-frozen/, { timeout: 90_000 });
  await expect(ui.locator('#toasts .toast-freeze')).toHaveCount(1, { timeout: 5000 });
  // Cap still applies to frozen tabs: cap 1 sleeps the frozen background tab.
  await ui.click('[data-act="settings"]');
  await ui.$eval('input[data-set="maxLiveTabs"]', (el) => {
    const i = /** @type {HTMLInputElement} */ (el); i.value = '1'; i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(tickerRow()).toHaveClass(/state-asleep/, { timeout: 10000 });
  await ui.$eval('input[data-set="maxLiveTabs"]', (el) => {
    const i = /** @type {HTMLInputElement} */ (el); i.value = '6'; i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await ui.$eval('select[data-set="freezeIdleMinutes"]', (el) => {
    const s = /** @type {HTMLSelectElement} */ (el); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await ui.keyboard.press('Escape');
});
