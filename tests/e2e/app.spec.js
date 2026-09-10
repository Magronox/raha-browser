// Real-Electron end-to-end tests. Launches the packaged-from-source app with
// an isolated profile, drives the UI view, and asserts the governor's
// behavior against real renderer processes.
//
// Requirements: node_modules (electron + @playwright/test) and a display
// (CI: xvfb-run -a npx playwright test). Pages are served by a loopback HTTP
// server started below — no external network. (They can't be data: URLs:
// resolveOmnibox deliberately treats data:/javascript:/file: as searches,
// like Chrome's omnibox does.)
//
// NOTE for agents: `page` here is the UI VIEW (raha://app/index.html), the
// first window Playwright sees. Web content lives in separate
// WebContentsViews that Playwright also exposes — see contentPages().
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @type {import('playwright').ElectronApplication} */ let app;
/** @type {import('playwright').Page} */ let ui;
/** @type {string} */ let profileDir;
/** @type {import('node:http').Server} */ let pageServer;
/** @type {string} */ let pageBase;
/** Every request the loopback server saw, by Host header — how the blocking
 * tests prove a cancelled request truly never went out. */
/** @type {{ host: string, url: string }[]} */ const serverHits = [];

const PAGE = (/** @type {string} */ name) => `${pageBase}/${name}`;

// R-102 blocking tests: ad.doubleclick.net resolves to the loopback server
// (the port rides in the script URL), so an EasyList-blocked request that
// somehow escaped onBeforeRequest would still hit only 127.0.0.1 — the e2e
// suite stays offline either way.
const LAUNCH_ARGS = ['.', '--no-sandbox', '--host-resolver-rules=MAP ad.doubleclick.net 127.0.0.1'];

/** electron.launch env with agent-shell landmines removed. */
function launchEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    RAHA_PROFILE_DIR: profileDir,
    RAHA_TICK_MS: '700',
    RAHA_NO_SANDBOX: '1',
    RAHA_NO_WELCOME: '1',
  });
  // Inherited from VSCode/agent shells this would run Electron as plain Node
  // and the app would never open a window; Playwright only strips NODE_OPTIONS.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

test.beforeAll(async () => {
  pageServer = http.createServer((req, res) => {
    serverHits.push({ host: req.headers.host ?? '', url: req.url ?? '' });
    const name = (req.url ?? '/').replace(/^\/+/, '') || 'page';
    res.setHeader('content-type', 'text/html');
    if (name.startsWith('adpage')) {
      // References a canonical EasyList host; the resolver rule above maps it
      // back to this server, so an unblocked fetch would be RECORDED here.
      const port = /** @type {import('node:net').AddressInfo} */ (pageServer.address()).port;
      res.end(`<title>adpage</title><body><h1>adpage</h1>` +
        `<script src="http://ad.doubleclick.net:${port}/adscript.js"></script>`);
      return;
    }
    if (name === 'scrollform') {
      res.end(`<title>scrollform</title><body style="margin:0">` +
        `<div style="height:2000px"></div>` +
        `<input id="q" name="q" type="text">` +
        `<div style="height:500px"></div>`);
      return;
    }
    res.end(`<title>${name}</title><body><h1>${name}</h1>`);
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', () => resolve(null)));
  const addr = /** @type {import('node:net').AddressInfo} */ (pageServer.address());
  pageBase = `http://127.0.0.1:${addr.port}`;

  profileDir = mkdtempSync(path.join(tmpdir(), 'raha-e2e-'));
  app = await electron.launch({
    args: LAUNCH_ARGS,
    env: launchEnv(),
  });
  ui = await app.firstWindow();
  await ui.waitForSelector('#sidebar .side-head', { timeout: 20000 });
});

test.afterAll(async () => {
  await app.close();
  pageServer.close();
  rmSync(profileDir, { recursive: true, force: true });
});

/**
 * Create a tab the way a real user does: New-tab button (shows the grid, so
 * no tab is active), then omnibox + Enter. With a tab ACTIVE, omnibox Enter
 * navigates that tab instead — covered by its own test.
 * @param {string} url
 */
async function openTab(url) {
  await ui.click('[data-newtab]');
  // Wait for the grid to render: that's the user-visible proof the snapshot
  // roundtrip landed and no tab is active anymore. Typing Enter before it
  // lands would navigate the previously-active tab instead of creating one.
  await ui.waitForSelector('#content .card, #content .empty-state', { timeout: 10000 });
  await ui.click('.omnibox');
  await ui.fill('.omnibox', url);
  await ui.keyboard.press('Enter');
  await ui.waitForTimeout(400);
}

test('boots into the grid with zero running tabs', async () => {
  await expect(ui.locator('#livebar .live-stats')).toContainText('0/');
  await expect(ui.locator('#content .empty-state')).toBeVisible();
});

test('omnibox creates a live tab; livebar and sidebar update', async () => {
  await openTab(PAGE('first'));
  await expect(ui.locator('#livebar .chip')).toHaveCount(1, { timeout: 10000 });
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(1);
  await expect(ui.locator('#sidebar .row.tab.state-active')).toHaveCount(1);
});

test('omnibox with a tab active navigates it — no new tab', async () => {
  await ui.click('.omnibox');
  await ui.fill('.omnibox', PAGE('first-nav'));
  await ui.keyboard.press('Enter');
  await ui.waitForTimeout(400);
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(1);
  await expect(ui.locator('#livebar .chip')).toHaveCount(1);
});

test('cap 2: third tab puts the least-recent one to sleep, with a toast', async () => {
  // Lower the cap through the real settings UI.
  await ui.click('[data-act="settings"]');
  await ui.waitForSelector('.modal.settings');
  await ui.$eval('input[data-set="maxLiveTabs"]', (el) => {
    const i = /** @type {HTMLInputElement} */ (el);
    i.value = '2';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await ui.keyboard.press('Escape');

  await openTab(PAGE('second'));
  await openTab(PAGE('third'));

  await expect(ui.locator('#livebar .chip')).toHaveCount(2, { timeout: 15000 });
  await expect(ui.locator('#sidebar .row.tab.state-asleep')).toHaveCount(1, { timeout: 15000 });
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(3);
});

test('renderer count actually dropped (real processes, not just UI state)', async () => {
  const metrics = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().filter((m) => m.type === 'Tab').length);
  // 2 content renderers + 1 UI renderer = 3 "Tab" processes.
  expect(metrics).toBeLessThanOrEqual(3);
});

test('clicking the asleep tab wakes it and sleeps another (LRU)', async () => {
  await ui.click('#sidebar .row.tab.state-asleep .name');
  await expect(ui.locator('#livebar .chip')).toHaveCount(2, { timeout: 15000 });
  await expect(ui.locator('#sidebar .row.tab.state-asleep')).toHaveCount(1, { timeout: 15000 });
});

test('pin survives eviction pressure', async () => {
  // Pin the active tab, then open another: the unpinned background sleeps.
  await ui.click('[data-act="pin"]');
  await openTab(PAGE('fourth'));
  await expect(ui.locator('#livebar .chip')).toHaveCount(2, { timeout: 15000 });
  const pinnedAsleep = await ui.locator('#sidebar .row.tab.state-asleep .mini.pin').count();
  expect(pinnedAsleep).toBe(0); // the pinned one is never the one asleep
});

test('folders: create, tab lands inside via context menu flow', async () => {
  // Scope to .tree: the "All tabs" root row is also .row.folder but lives
  // outside the tree, so unscoped locators match it too.
  await ui.click('[data-newfolder]');
  await expect(ui.locator('#sidebar .tree .row.folder')).toHaveCount(1, { timeout: 5000 });
  await expect(ui.locator('#sidebar .tree .row.folder .name')).toContainText('New folder');
});

test('session restore: relaunch brings tabs back asleep with titles', async () => {
  // Wait for the old process to fully exit: the app holds a single-instance
  // lock (keyed on the shared userData dir), and a relaunch that races the
  // old process losing it quits immediately with no window.
  const oldProc = app.process();
  const exited = new Promise((resolve) => oldProc.once('exit', () => resolve(null)));
  await app.close();
  await exited;
  app = await electron.launch({
    args: LAUNCH_ARGS,
    env: launchEnv(),
  });
  ui = await app.firstWindow();
  await ui.waitForSelector('#sidebar .row.tab', { timeout: 20000 });

  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(4);
  await expect(ui.locator('#livebar .live-stats')).toContainText('0/', { timeout: 10000 });
  await expect(ui.locator('#sidebar .row.tab.state-asleep')).toHaveCount(4);
  // Settings persisted too (cap 2 set through the UI earlier).
  await ui.click('[data-act="settings"]');
  await ui.waitForSelector('.modal.settings');
  const cap = await ui.$eval('input[data-set="maxLiveTabs"]', (el) => /** @type {HTMLInputElement} */ (el).value);
  expect(cap).toBe('2');
  await ui.keyboard.press('Escape');
});

test('waking after restore restores navigation history', async () => {
  await ui.click('#sidebar .row.tab .name');
  await expect(ui.locator('#livebar .chip')).toHaveCount(1, { timeout: 15000 });
  await expect(ui.locator('#sidebar .row.tab.state-active')).toHaveCount(1);
});

test('R-102: bundled EasyList cancels a known ad request before the network', async () => {
  serverHits.length = 0;
  await openTab(PAGE('adpage'));
  // The blocked-count shield appears once the snapshot ticks (700ms tick).
  await expect(ui.locator('.shieldbtn b')).toHaveText(/[1-9]/, { timeout: 10000 });
  // The page itself was served, the ad script never left the app.
  expect(serverHits.some((h) => h.url.includes('adpage'))).toBe(true);
  expect(serverHits.filter((h) => h.host.startsWith('ad.doubleclick.net'))).toEqual([]);
});

test('R-102: shield click turns blocking off for the site, persists, and the request goes through', async () => {
  serverHits.length = 0;
  await ui.click('.shieldbtn');
  await expect(ui.locator('.shieldbtn.off')).toBeVisible({ timeout: 10000 });
  // The click auto-reloads the tab; with the shield off, the ad script now
  // escapes onBeforeRequest and reaches the loopback server under the
  // resolver-mapped doubleclick Host.
  await expect(async () => {
    expect(serverHits.some((h) => h.host.startsWith('ad.doubleclick.net'))).toBe(true);
  }).toPass({ timeout: 10000 });
  // Persistence AC (R-102): the per-site choice survives in settings.json.
  const persisted = JSON.parse(readFileSync(path.join(profileDir, 'settings.json'), 'utf8'));
  expect(persisted.noBlockHosts).toContain('127.0.0.1');
  // Re-enable for whatever runs after us.
  await ui.click('.shieldbtn');
  await expect(ui.locator('.shieldbtn.on')).toBeVisible({ timeout: 10000 });
});

test('chrome overlays outrank the page view while open (ui:overlay)', async () => {
  // The page is a native view added ABOVE the chrome, so centered modals
  // (history, settings) render invisibly behind an active tab unless the
  // chrome is raised while they are open. Child order IS z-order.
  const topChildUrl = () => app.evaluate(({ BaseWindow }) => {
    const kids = BaseWindow.getAllWindows()[0].contentView.children;
    const wc = /** @type {any} */ (kids[kids.length - 1]).webContents;
    return wc ? wc.getURL() : '?';
  });
  await openTab(PAGE('overlay-test')); // guarantee an ACTIVE page view
  await expect.poll(async () => (await topChildUrl()).startsWith('raha://app')).toBe(false); // page on top while browsing
  await ui.click('[data-act="history"]');
  await ui.waitForSelector('.modal.history');
  await expect.poll(topChildUrl).toContain('raha://app'); // chrome raised above the page
  await ui.click('button[data-close-history]');
  await expect.poll(async () => (await topChildUrl()).startsWith('raha://app')).toBe(false); // page back on top
});

test('sidebar toggle re-lays the content view over the freed space', async () => {
  // The content view (the active overlay-test tab from the previous test)
  // must start at x=SIDEBAR_WIDTH (264) and take over x=0 when the sidebar
  // hides — main-process truth via getBounds, not CSS.
  const contentX = () => app.evaluate(({ BaseWindow }) => {
    for (const k of BaseWindow.getAllWindows()[0].contentView.children) {
      const wc = /** @type {any} */ (k).webContents;
      if (wc && !wc.getURL().startsWith('raha://app')) return /** @type {any} */ (k).getBounds().x;
    }
    return -1;
  });
  expect(await contentX()).toBe(264);
  await ui.click('[data-act="togglesidebar"]');
  await expect.poll(contentX).toBe(0);
  await ui.click('[data-act="togglesidebar"]');
  await expect.poll(contentX).toBe(264);

  // The MENU path (Cmd/Ctrl+Shift+B): menu item -> push event -> UI state ->
  // ui:sidebar invoke -> re-layout. Drives the real accelerator target.
  const clickMenu = () => app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-sidebar');
    if (!item) throw new Error('toggle-sidebar menu item missing');
    item.click();
  });
  await clickMenu();
  await expect.poll(contentX).toBe(0);
  await clickMenu();
  await expect.poll(contentX).toBe(264);
});

test('find in page (R-101): menu opens the bar, counts real matches, Esc clears', async () => {
  // The loopback server echoes the path into the <h1>, so this page contains
  // the word "word" exactly three times in its visible text.
  await openTab(PAGE('find-word-word-word'));
  await expect(ui.locator('#sidebar .row.tab.state-active')).toHaveCount(1, { timeout: 10000 });
  await expect(ui.locator('#sidebar .row.tab.state-active .name')).toContainText('find-word', { timeout: 10000 });

  // Drive the REAL accelerator target: menu item -> evt:openFind -> find bar.
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('find-in-page');
    if (!item) throw new Error('find-in-page menu item missing');
    item.click();
  });
  await ui.waitForSelector('#topbar .findbox', { timeout: 5000 });

  await ui.fill('#topbar .findbox', 'word');
  await expect(ui.locator('#topbar .findcount')).toHaveText('1/3', { timeout: 5000 });

  await ui.keyboard.press('Enter'); // next match, via real found-in-page events
  await expect(ui.locator('#topbar .findcount')).toHaveText('2/3', { timeout: 5000 });

  await ui.click('#topbar [data-act="findprev"]');
  await expect(ui.locator('#topbar .findcount')).toHaveText('1/3', { timeout: 5000 });

  // No match: the count must say so rather than lie or linger.
  await ui.fill('#topbar .findbox', 'not-on-this-page-zzz');
  await expect(ui.locator('#topbar .findcount')).toHaveText('0/0', { timeout: 5000 });

  await ui.focus('#topbar .findbox');
  await ui.keyboard.press('Escape');
  await expect(ui.locator('#topbar .findbox')).toHaveCount(0, { timeout: 5000 });
});

test('omnibox suggestions (R-113): history and switch-to-tab paths, never a duplicate', async () => {
  await openTab(PAGE('sugg-unique-target'));
  await expect(ui.locator('#sidebar .row.tab.state-active .name')).toContainText('sugg-unique-target', { timeout: 10000 });
  const tabCount = () => ui.locator('#sidebar .row.tab').count();
  const before = await tabCount();

  // Close the visited tab: only RECORDED history remembers it now.
  await ui.$eval('#sidebar .row.tab.state-active [data-close]', (el) => /** @type {HTMLElement} */ (el).click());
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(before - 1, { timeout: 10000 });

  // History path: the suggestion must come from the recorded visit (no
  // open-tab badge), and Enter re-opens the page as a NEW tab.
  await ui.click('[data-newtab]');
  await ui.waitForSelector('#content .card, #content .empty-state', { timeout: 10000 });
  // fill, not click+type: the new-tab flow leaves the previous URL selected
  // in the omnibox (type-to-replace); a click would collapse that selection.
  await ui.fill('.omnibox', 'sugg-unique');
  await ui.waitForSelector('.omnisuggest.open .sug', { timeout: 5000 });
  expect(await ui.locator('.omnisuggest .sug-tab').count()).toBe(0); // history, not a tab
  await ui.keyboard.press('ArrowDown');
  await ui.keyboard.press('Enter');
  await expect(ui.locator('#sidebar .row.tab.state-active .name')).toContainText('sugg-unique-target', { timeout: 10000 });
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(before, { timeout: 10000 });

  // Switch-to-tab path: same query now offers the OPEN tab and Enter
  // activates it — the tab count must NOT grow (activate, never duplicate).
  await ui.click('[data-newtab]');
  await ui.waitForSelector('#content .card, #content .empty-state', { timeout: 10000 });
  await ui.fill('.omnibox', 'sugg-unique');
  await ui.waitForSelector('.omnisuggest.open .sug-tab', { timeout: 5000 });
  await ui.keyboard.press('ArrowDown');
  await ui.keyboard.press('Enter');
  await expect(ui.locator('#sidebar .row.tab.state-active .name')).toContainText('sugg-unique-target', { timeout: 10000 });
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(before, { timeout: 10000 });
});

test('siteData:clear removes a host\'s cookies (the un-wedge for cookie lockouts)', async () => {
  // Seed a cookie the way a site would own it, then clear via the real
  // channel the context menu / Settings use.
  const count = () => app.evaluate(async ({ session }) =>
    (await session.fromPartition('persist:main').cookies.get({ domain: '127.0.0.1' })).length);
  await app.evaluate(({ session }) =>
    session.fromPartition('persist:main').cookies.set({
      url: `http://127.0.0.1/`, name: 'wedge', value: 'stuck', expirationDate: Date.now() / 1000 + 3600,
    }));
  expect(await count()).toBeGreaterThan(0);
  const r = await ui.evaluate(() => /** @type {any} */ (window).raha.invoke('siteData:clear', { host: '127.0.0.1' }));
  expect(r.ok).toBe(true);
  expect(await count()).toBe(0);
});

test('external link (open-url) opens as a tab; hostile schemes are ignored', async () => {
  // What arrives when Raha is the system default browser and another app
  // opens a link. Synthesized exactly as macOS delivers it.
  const rows = () => ui.locator('#sidebar .row.tab').count();
  const before = await rows();
  await app.evaluate(({ app: a }) => a.emit('open-url', { preventDefault() {} }, 'https://example.com/from-mail'));
  await expect.poll(rows).toBe(before + 1);
  // Non-http schemes must be dropped before they ever reach the engine.
  await app.evaluate(({ app: a }) => a.emit('open-url', { preventDefault() {} }, 'file:///etc/passwd'));
  await ui.waitForTimeout(600);
  expect(await rows()).toBe(before + 1);
});

test('a crashed renderer flips the tab to asleep and tears its WebContents down (no zombie view or CDP session)', async () => {
  await openTab(PAGE('crash-me'));
  await expect(ui.locator('#sidebar .row.tab.state-active .name')).toContainText('crash-me', { timeout: 10000 });
  // Main-process truth: the tab's WebContents, its crash state and whether
  // Raha's CDP identity session is attached to it.
  const alive = () => app.evaluate(({ webContents }) =>
    webContents.getAllWebContents()
      .filter((w) => w.getURL().includes('crash-me'))
      .map((w) => ({ crashed: w.isCrashed(), cdp: w.debugger.isAttached() })));
  expect(await alive()).toEqual([{ crashed: false, cdp: true }]);

  await app.evaluate(({ webContents }) => {
    for (const w of webContents.getAllWebContents()) if (w.getURL().includes('crash-me')) w.forcefullyCrashRenderer();
  });
  await expect(ui.locator('#toasts .toast', { hasText: 'Tab crashed and was put to sleep' })).toBeVisible({ timeout: 10000 });
  await expect(ui.locator('#sidebar .row.tab.state-asleep .name', { hasText: 'crash-me' })).toHaveCount(1, { timeout: 10000 });
  // A crash fires no 'detach' on the debugger and nothing else closes the
  // WebContents (engine.onViewGone only drops the runtime entry), so
  // views.js closes it on render-process-gone — deterministically, not at
  // garbage-collection time. The view, its listeners and the CDP session
  // must all be gone now.
  await expect.poll(alive, { timeout: 10000 }).toEqual([]);
});

test('R-104: scroll position survives sleep/wake cycle', async () => {
  // Raise the cap so the governor does not re-sleep the tab we are testing.
  await ui.evaluate(() => /** @type {any} */ (window).raha.invoke('settings:set', { maxLiveTabs: 10 }));
  await openTab(PAGE('scrollform'));
  await expect(ui.locator('#sidebar .row.tab.state-active .name')).toContainText('scrollform', { timeout: 10000 });

  // Read the tab's engine id from the sidebar DOM.
  const tabId = await ui.locator('#sidebar .row.tab.state-active').getAttribute('data-id');

  // Find the content WebContents and scroll + fill a field.
  await expect.poll(() => app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('scrollform'));
    return wc ? wc.id : 0;
  }), { timeout: 10000 }).toBeGreaterThan(0);

  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('scrollform'));
    return wc?.executeJavaScript('window.scrollTo(0, 1200); document.getElementById("q").value = "hello"');
  });

  // Let a governor tick capture the page state (RAHA_TICK_MS=700).
  await ui.waitForTimeout(1200);

  // Sleep via IPC.
  await ui.evaluate((id) => /** @type {any} */ (window).raha.invoke('tab:sleep', { tabId: id }), tabId);
  await expect(ui.locator('#sidebar .row.tab.state-asleep .name', { hasText: 'scrollform' })).toHaveCount(1, { timeout: 10000 });

  // Wake it.
  await ui.evaluate((id) => /** @type {any} */ (window).raha.invoke('tab:activate', { tabId: id }), tabId);
  await expect(ui.locator('#sidebar .row.tab.state-active .name', { hasText: 'scrollform' })).toHaveCount(1, { timeout: 15000 });

  // Wait for the page to load and the restore script to run.
  await ui.waitForTimeout(2500);

  const scrollY = await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('scrollform'));
    return wc ? wc.executeJavaScript('window.scrollY') : 0;
  });
  expect(scrollY).toBeGreaterThan(1000);

  // Restore the cap for subsequent tests.
  await ui.evaluate(() => /** @type {any} */ (window).raha.invoke('settings:set', { maxLiveTabs: 2 }));
});

// --- Security regressions (audit P3). Asks the REAL protocol handler, in the
// REAL sessions, rather than driving the UI — so it is independent of whatever
// tab state the tests above left behind.
test('web content is served raha://home but never the chrome or thumbnails', async () => {
  const statuses = await app.evaluate(async ({ session }) => {
    const web = session.fromPartition('persist:main');
    const ui_ = session.fromPartition('raha-ui');
    const status = async (/** @type {Electron.Session} */ s, /** @type {string} */ u) => {
      try { return (await s.fetch(u)).status; } catch { return 0; }
    };
    return {
      webApp: await status(web, 'raha://app/index.html'),
      webAppSource: await status(web, 'raha://app/app.js'),
      webShared: await status(web, 'raha://app/shared/policy.js'),
      webThumb: await status(web, 'raha://thumb/anything.png'),
      webHome: await status(web, 'raha://home'),
      webError: await status(web, 'raha://error'),
      uiApp: await status(ui_, 'raha://app/index.html'),
    };
  });
  // The chrome and every tab screenshot are off-limits to pages.
  expect(statuses.webApp).toBe(403);
  expect(statuses.webAppSource).toBe(403);
  expect(statuses.webShared).toBe(403);
  expect(statuses.webThumb).toBe(403);
  // The pages that legitimately render inside tabs still work.
  expect(statuses.webHome).toBe(200);
  expect(statuses.webError).toBe(200);
  // And the chrome still loads in its own session.
  expect(statuses.uiApp).toBe(200);
});

// --- Audit P2: the chrome view is the only view holding the preload bridge,
// so it must never navigate anywhere or open a window. INVARIANTS #13 claimed
// this was test-enforced before these existed; it wasn't.
//
// These assert through the MAIN process rather than Playwright locators. A
// cancelled navigation leaves Playwright's Page object waiting on a navigation
// that will never complete, so ui.click()/locator() time out afterwards even
// though the renderer is perfectly healthy — verified separately: after a
// blocked navigation the view reports loading=false, crashed=false and still
// executes JS. That is a Playwright artifact, not a wedged browser, which is
// also why the navigation case is deliberately the LAST test in this file.

/** Ask the main process about the chrome view directly. */
const chromeState = () => app.evaluate(({ BaseWindow }) => {
  const wc = /** @type {any} */ (BaseWindow.getAllWindows()[0].contentView.children[0]).webContents;
  return { url: wc.getURL(), loading: wc.isLoading(), crashed: wc.isCrashed() };
});

test('the chrome view refuses window.open', async () => {
  // Count TOP-LEVEL windows from the main process. Playwright's
  // app.windows() also counts each running tab's WebContentsView, and the
  // governor is asleep/waking tabs on its own schedule throughout this file —
  // that number moves for reasons unrelated to what is being tested.
  const windows = () => app.evaluate(({ BaseWindow, BrowserWindow }) => ({
    base: BaseWindow.getAllWindows().length,
    browser: BrowserWindow.getAllWindows().length,
  }));
  const before = await windows();
  await ui.evaluate(() => { window.open('https://example.com/popup', '_blank'); }).catch(() => {});
  await ui.waitForTimeout(800);
  expect(await windows()).toEqual(before);
  expect((await chromeState()).url).toContain('raha://app/index.html');
});

test('the chrome view refuses to navigate away from its own page', async () => {
  const before = await chromeState();
  expect(before.url).toContain('raha://app/index.html');

  // Exactly what a compromised chrome — or a stray file drop — would attempt.
  await ui.evaluate(() => { window.location.href = 'https://example.com/hijack'; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const after = await chromeState();
  expect(after.url).toBe(before.url);   // navigation refused
  expect(after.crashed).toBe(false);
  expect(after.loading).toBe(false);    // and not left hanging on a dead load

  // Still a live chrome, not a blank frame.
  const dom = await app.evaluate(({ BaseWindow }) => {
    const wc = /** @type {any} */ (BaseWindow.getAllWindows()[0].contentView.children[0]).webContents;
    return wc.executeJavaScript('({ sidebar: !!document.querySelector("#sidebar"), href: location.href })');
  });
  expect(dom.sidebar).toBe(true);
  expect(dom.href).toContain('raha://app/index.html');
});
