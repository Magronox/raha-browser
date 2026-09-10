// The automated twin of tests/manual/security-qa.html: every check the
// hands-on page asks a human to click is driven here against the REAL app,
// so CI enforces the 2026-07 audit fixes on every push. The page served is
// the actual manual page read from disk — the suite and humans exercise the
// same artifact. (The page's own #log verdict lines are used where the page
// can judge itself — fetch/permissions — and engine/chrome state everywhere
// it can't: popups, toasts, the back-stack walk.)
//
// Ordering note: like app.spec.js, tests here share one app instance and run
// in file order (workers=1). Denied window.open calls are cancelled in the
// MAIN process (setWindowOpenHandler deny + the engine scheme gate), so the
// opener page never sees a cancelled renderer navigation and stays healthy
// for Playwright — unlike the chrome-navigation case app.spec.js warns about.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('playwright').ElectronApplication} */ let app;
/** @type {import('playwright').Page} */ let ui;
/** @type {string} */ let profileDir;
/** @type {import('node:http').Server} */ let server;
/** @type {import('node:http').Server|null} */ let server6 = null;
/** @type {string} */ let qaUrl;
/** @type {number} */ let port;
/**
 * Every request the loopback server saw, in order, with lowercased header
 * names — what a bot check's edge would see. Node lowercases incoming
 * header names already; values are joined if repeated.
 * @type {{ url: string, headers: Record<string, string> }[]}
 */
const seen = [];
/** @param {string} url exact request path (+query) */
const lastSeen = (url) => [...seen].reverse().find((r) => r.url === url);

const QA_PAGE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'manual', 'security-qa.html'),
  'utf8',
);

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
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

test.beforeAll(async () => {
  /** @type {import('node:http').RequestListener} */
  const handler = (req, res) => {
    const url = req.url ?? '/';
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    seen.push({ url, headers });
    // Probes the identity tests fetch from inside pages, frames and workers.
    if (url.startsWith('/ch-probe') || url.startsWith('/frame-probe') || url.startsWith('/worker-probe')) {
      res.setHeader('content-type', 'text/plain');
      // Accept-CH on a SUBRESOURCE response: Chrome ignores it (only a
      // top-level document may ask), so Raha's emulation must too — a
      // later first-party fetch asserts sec-ch-ua-arch never appears.
      if (url.startsWith('/ch-probe')) res.setHeader('Accept-CH', 'Sec-CH-UA-Arch');
      return res.end('ok');
    }
    // A dedicated worker: reports its own identity view and fetches.
    if (url.startsWith('/worker.js')) {
      res.setHeader('content-type', 'text/javascript');
      return res.end("fetch('/worker-probe').then((r) => self.postMessage({ status: r.status, ua: self.navigator.userAgent, brands: self.navigator.userAgentData ? self.navigator.userAgentData.brands : null }), (e) => self.postMessage({ error: String(e) }));");
    }
    res.setHeader('content-type', 'text/html');
    // The QA page (any query — buildHistory walks ?step=N on the same path).
    // Accept-CH: what a Cloudflare-fronted document asks for; the identity
    // tests assert Raha's emulation then adds those hints to later
    // same-origin requests, as Chrome would.
    if (url.startsWith('/security-qa.html')) {
      res.setHeader('Accept-CH', 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version');
      return res.end(QA_PAGE);
    }
    // A document to embed cross-origin (served under http://localhost, a
    // different origin from the 127.0.0.1 QA page — no DNS involved). Its
    // inline script captures the identity at PARSE time: what the frame's
    // very first script sees is what a Turnstile widget would score, and a
    // frame resumed before its override landed would fail only this.
    if (url.startsWith('/frame.html')) {
      return res.end('<title>frame</title><script>window.__first = { ua: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands : null };</script><body><h1>cross-origin frame</h1>');
    }
    res.end(`<title>${url}</title><body><h1>${url}</h1>`);
  };
  server = http.createServer(handler);
  // Loopback ONLY, never every interface: the QA page probes permissions and
  // the request log above would otherwise be reachable from the LAN for the
  // suite's lifetime (and macOS raises its firewall prompt). Chromium may
  // resolve `localhost` to ::1 first, so a second listener on the same port
  // covers IPv6 loopback where the machine has it.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const s6 = http.createServer(handler);
  await new Promise((resolve) => {
    s6.once('error', () => resolve(null));
    s6.listen(port, '::1', () => { server6 = s6; resolve(null); });
  });
  qaUrl = `http://127.0.0.1:${port}/security-qa.html`;

  profileDir = mkdtempSync(path.join(tmpdir(), 'raha-secqa-'));
  app = await electron.launch({
    // example.com resolves to the loopback server: the https regression check
    // asserts TAB CREATION (the gate's job), not a successful page load.
    // Fake capture devices: the P5 camera/microphone asks need a device to
    // exist (with none, Chromium answers NotFoundError before any
    // permission request is made — CI runners have no camera), and a
    // granted fake stream never touches real hardware, so no OS-level
    // device dialog can appear on a developer machine.
    args: ['.', '--no-sandbox', '--host-resolver-rules=MAP example.com 127.0.0.1', '--use-fake-device-for-media-stream'],
    env: launchEnv(),
  });
  ui = await app.firstWindow();
  await ui.waitForSelector('#sidebar .side-head', { timeout: 20000 });

  // Open the QA page as a real tab, the way a user would.
  await ui.click('[data-newtab]');
  await ui.waitForSelector('#content .card, #content .empty-state', { timeout: 10000 });
  await ui.click('.omnibox');
  await ui.fill('.omnibox', qaUrl);
  await ui.keyboard.press('Enter');
  await expect(ui.locator('#livebar .chip')).toHaveCount(1, { timeout: 15000 });
});

test.afterAll(async () => {
  await app.close();
  server.close();
  server6?.close();
  rmSync(profileDir, { recursive: true, force: true });
});

/** Find a CONTENT page by URL fragment. Never cache across sleep/wake — a
 * woken tab is a new WebContentsView and a new Playwright Page.
 * @param {string} urlPart @param {number} [timeoutMs] */
async function contentPage(urlPart, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const w of app.windows()) {
      if (w !== ui && w.url().includes(urlPart)) return w;
    }
    if (Date.now() > deadline) throw new Error(`no content page matching "${urlPart}"`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const tabRows = () => ui.locator('#sidebar .row.tab').count();

/** Re-activate the QA tab (popup-regression tests activate their new tab). */
async function activateQaTab() {
  await ui.locator('#sidebar .row.tab .name', { hasText: 'Raha security QA' }).first().click();
  await expect(ui.locator('#sidebar .row.tab.state-active .name')).toContainText('Raha security QA', { timeout: 10000 });
}

// ---------------------------------------------------------------- P1: popups

// Defense in depth, observed empirically: Chromium's renderer refuses
// file:/javascript:/chrome:/view-source: popups before Raha ever sees them
// (no toast possible — the request never reaches the main process). data:
// DOES traverse setWindowOpenHandler -> engine, so it's the scheme that
// proves OUR sink gate end to end, warn toast included. The security
// outcome asserted for every scheme is the same: no tab, no view at a
// forbidden URL.
const BLOCKED_POPUPS = [
  { url: 'file:///etc/passwd', reachesRaha: false },
  { url: 'file:///Users/', reachesRaha: false },
  { url: 'javascript:document.write(1)', reachesRaha: false },
  { url: 'data:text/html,<h1>Sign in to your bank</h1>', reachesRaha: true },
  { url: 'chrome://settings', reachesRaha: false },
  { url: 'view-source:file:///etc/passwd', reachesRaha: false },
];

for (const { url, reachesRaha } of BLOCKED_POPUPS) {
  test(`P1: window.open(${url.slice(0, 34)}) is refused`, async () => {
    const qa = await contentPage('/security-qa.html');
    const before = await tabRows();
    await qa.evaluate((u) => { window.open(u, '_blank'); }, url);
    if (reachesRaha) {
      // Toast text: engine.js — `Blocked a link to an unsupported address (…)`.
      await expect(
        ui.locator('#toasts .toast.toast-warn', { hasText: 'Blocked a link to an unsupported address' }),
      ).toBeVisible({ timeout: 5000 });
    }
    await ui.waitForTimeout(600);
    expect(await tabRows()).toBe(before); // no tab appeared
    // And no content view exists at any forbidden URL.
    const scheme = url.split(':')[0] + ':';
    for (const w of app.windows()) {
      if (w !== ui) expect(w.url().startsWith(scheme), `view at ${w.url()}`).toBe(false);
    }
  });
}

// ------------------------------------------------- regressions: these OPEN

test('regression: blob popup opens a tab showing the generated report', async () => {
  const qa = await contentPage('/security-qa.html');
  const before = await tabRows();
  await qa.evaluate(() => {
    // Browser context: window.* spellings keep node-side eslint quiet.
    const url = window.URL.createObjectURL(new window.Blob(
      ['<h1>generated report</h1><p>If you can read this in a Raha tab, blob: popups work.</p>'],
      { type: 'text/html' },
    ));
    window.open(url, '_blank');
  });
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(before + 1, { timeout: 10000 });
  const blobPage = await contentPage('blob:');
  await expect(blobPage.locator('h1')).toHaveText('generated report', { timeout: 10000 });
  // Sleep the popup tab (destroys its view) so later tests see exactly one
  // content window; the popup activates itself, so sleep acts on it.
  await ui.click('[data-act="sleep"]');
  await expect(ui.locator('#sidebar .row.tab.state-asleep')).toHaveCount(1, { timeout: 15000 });
  await activateQaTab();
});

test('regression: https popup opens a tab (no popup-block toast)', async () => {
  const qa = await contentPage('/security-qa.html');
  const before = await tabRows();
  await qa.evaluate(() => { window.open('https://example.com', '_blank'); });
  // Tab CREATION is the assertion — the load itself may error (https to a
  // TLS-less loopback via the resolver map), which is fine: the scheme gate
  // let it through, which is what this regression guards.
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(before + 1, { timeout: 10000 });
  await expect(ui.locator('#toasts .toast.toast-warn', { hasText: 'Blocked a popup' })).toHaveCount(0);
  await ui.click('[data-act="sleep"]');
  await expect(ui.locator('#sidebar .row.tab.state-asleep')).toHaveCount(2, { timeout: 15000 });
  await activateQaTab();
});

// ---------------------------------------------- P3: reaching Raha's chrome

test('P3: in-page fetch of raha://app and raha://thumb is refused', async () => {
  const qa = await contentPage('/security-qa.html');
  await qa.click('button[onclick*="raha://app"]');
  await expect(qa.locator('#log span.good', { hasText: 'fetch(raha://app/index.html)' })).toBeVisible({ timeout: 5000 });
  await qa.click('button[onclick*="raha://thumb"]');
  await expect(qa.locator('#log span.good', { hasText: 'fetch(raha://thumb/x.png)' })).toBeVisible({ timeout: 5000 });
});

test('P3: iframe raha://app never renders the chrome', async () => {
  const qa = await contentPage('/security-qa.html');
  await qa.click('button[onclick="frameIt()"]');
  await qa.waitForTimeout(1500); // give a hypothetical load every chance
  for (const frame of qa.frames()) {
    if (frame === qa.mainFrame()) continue;
    expect(await frame.locator('#sidebar').count(), `frame ${frame.url()} must not render the chrome`).toBe(0);
  }
});

// ---------------------------------------- P5: site permissions (R-103)
//
// Deny-by-default-with-a-toast (the 2026-07 audit's P5) is replaced by
// Raha's own per-site ask (ADR-0013): every sensitive request raises the
// chrome's modal — never a system dialog, never a silent grant, no toast —
// and what the user clicks there is the page's answer. The check path
// (navigator.permissions.query, Notification.permission) still reads
// "denied" for an undecided site: Electron's check handler cannot say
// "prompt", so only a remembered allow (or this visit's "allow once")
// reads as granted. Camera stays on the deny branch so that no "allow"
// for a capture device is ever persisted for the QA origin: a remembered
// media grant switches off Chromium's mDNS candidate hiding for the page,
// which the R-122 test below relies on staying deterministic.

/** The site-permission ask on screen in the chrome. */
const permAsk = () => ui.locator('.modal.mini[data-perm-id]');
/** @param {'once'|'always'|'never'} decision */
async function answerAsk(decision) {
  await ui.click(`.modal.mini [data-perm="${decision}"]`);
  await expect(permAsk()).toHaveCount(0);
}
/** Log lines the QA page wrote containing `text`. @param {import('playwright').Page} qa @param {string} text */
const logLines = (qa, text) => qa.locator('#log span', { hasText: text });

test('P5: an undecided site reads as denied to a mere check, and a check never asks', async () => {
  const qa = await contentPage('/security-qa.html');
  await qa.click(`button[onclick="permQuery('geolocation')"]`);
  await expect(logLines(qa, 'permissions.query(geolocation) -> denied')).toHaveCount(1, { timeout: 5000 });
  await qa.click(`button[onclick="permQuery('notifications')"]`);
  await expect(logLines(qa, 'permissions.query(notifications) -> denied')).toHaveCount(1, { timeout: 5000 });
  await ui.waitForTimeout(400);
  await expect(permAsk()).toHaveCount(0);
});

test('P5: notifications — the ask names the site and the need; "Always allow" grants, persists, and the next request asks nothing', async () => {
  const qa = await contentPage('/security-qa.html');
  await qa.click('button[onclick="notif()"]');
  await expect(permAsk()).toBeVisible({ timeout: 5000 });
  await expect(ui.locator('.modal.mini .perm-title')).toHaveText('127.0.0.1 wants to show notifications');
  await expect(ui.locator('#toasts .toast', { hasText: 'permission request' })).toHaveCount(0); // asked, not toasted
  await answerAsk('always');
  await expect(logLines(qa, 'Notification.requestPermission() -> granted')).toHaveCount(1, { timeout: 5000 });
  expect(await qa.evaluate(() => window.Notification.permission)).toBe('granted');
  // The check path agrees with the remembered decision.
  await qa.click(`button[onclick="permQuery('notifications')"]`);
  await expect(logLines(qa, 'permissions.query(notifications) -> granted')).toHaveCount(1, { timeout: 5000 });
  // Remembered: the second request is answered silently.
  await qa.click('button[onclick="notif()"]');
  await expect(logLines(qa, 'Notification.requestPermission() -> granted')).toHaveCount(2, { timeout: 5000 });
  await expect(permAsk()).toHaveCount(0);
});

test('P5: geolocation — "Never for this site" refuses (PERMISSION_DENIED), persists, and the next request is refused silently', async () => {
  const qa = await contentPage('/security-qa.html');
  await qa.click('button[onclick="geo()"]');
  await expect(permAsk()).toBeVisible({ timeout: 5000 });
  await expect(ui.locator('.modal.mini .perm-title')).toHaveText('127.0.0.1 wants to use your location');
  await answerAsk('never');
  await expect(logLines(qa, 'geolocation error: code 1')).toHaveCount(1, { timeout: 5000 });
  await qa.click('button[onclick="geo()"]');
  await expect(logLines(qa, 'geolocation error: code 1')).toHaveCount(2, { timeout: 5000 });
  await expect(permAsk()).toHaveCount(0);
  await expect(ui.locator('#toasts .toast', { hasText: 'permission request' })).toHaveCount(0);
  await qa.click(`button[onclick="permQuery('geolocation')"]`);
  await expect(logLines(qa, 'permissions.query(geolocation) -> denied')).toHaveCount(2, { timeout: 5000 });
});

test('P5: camera — "Never for this site" makes getUserMedia fail with NotAllowedError (the refusal reached Chromium)', async () => {
  const qa = await contentPage('/security-qa.html');
  await qa.click(`button[onclick="media('video')"]`);
  await expect(permAsk()).toBeVisible({ timeout: 5000 });
  await expect(ui.locator('.modal.mini .perm-title')).toHaveText('127.0.0.1 wants to use your camera');
  await answerAsk('never');
  await expect(logLines(qa, 'getUserMedia(video) -> NotAllowedError')).toHaveCount(1, { timeout: 10000 });
  await qa.click(`button[onclick="media('video')"]`);
  await expect(logLines(qa, 'getUserMedia(video) -> NotAllowedError')).toHaveCount(2, { timeout: 10000 });
  await expect(permAsk()).toHaveCount(0);
});

test('P5: microphone — "Not now" refuses this request only and the site asks again; "Allow once" grants for the visit, per tab, remembering nothing', async () => {
  test.setTimeout(60_000);
  const qa = await contentPage('/security-qa.html');
  await qa.click(`button[onclick="media('audio')"]`);
  await expect(permAsk()).toBeVisible({ timeout: 5000 });
  await expect(ui.locator('.modal.mini .perm-title')).toHaveText('127.0.0.1 wants to use your microphone');
  await ui.click('.modal.mini button[data-perm-dismiss]');
  await expect(permAsk()).toHaveCount(0);
  await expect(logLines(qa, 'getUserMedia(audio) -> NotAllowedError')).toHaveCount(1, { timeout: 10000 });
  // Nothing remembered: it asks again, and Escape is "Not now" too.
  await qa.click(`button[onclick="media('audio')"]`);
  await expect(permAsk()).toBeVisible({ timeout: 5000 });
  await ui.keyboard.press('Escape');
  await expect(permAsk()).toHaveCount(0);
  await expect(logLines(qa, 'getUserMedia(audio) -> NotAllowedError')).toHaveCount(2, { timeout: 10000 });

  // "Allow once" — in a SECOND tab of the same site, so the grant (which
  // lasts for that tab's visit) never lands on the QA tab the later tests
  // drive. The popup activates itself, so its ask shows at once.
  const tabsBefore = await tabRows();
  await qa.evaluate((u) => { window.open(u, '_blank'); }, `${qaUrl}?mic=1`);
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(tabsBefore + 1, { timeout: 10000 });
  const mic = await contentPage('mic=1');
  await mic.waitForSelector('#log');
  await mic.click(`button[onclick="media('audio')"]`);
  await expect(permAsk()).toBeVisible({ timeout: 5000 });
  await expect(ui.locator('.modal.mini .perm-title')).toHaveText('127.0.0.1 wants to use your microphone');
  await answerAsk('once');
  await expect(logLines(mic, 'getUserMedia(audio) -> stream')).toHaveCount(1, { timeout: 10000 });
  // The visit keeps the grant: a repeat request asks nothing, and the check
  // path says granted — in THIS tab only.
  await mic.click(`button[onclick="media('audio')"]`);
  await expect(logLines(mic, 'getUserMedia(audio) -> stream')).toHaveCount(2, { timeout: 10000 });
  await expect(permAsk()).toHaveCount(0);
  await mic.click(`button[onclick="permQuery('microphone')"]`);
  await expect(logLines(mic, 'permissions.query(microphone) -> granted')).toHaveCount(1, { timeout: 5000 });
  // Close the helper tab (its URL would also match contentPage('security-qa')).
  const helperId = await ui.locator('#sidebar .row.tab.state-active').getAttribute('data-id');
  expect(helperId).toBeTruthy();
  await ui.evaluate((id) => /** @type {any} */ (window).raha.invoke('tab:close', { tabId: id }), helperId);
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(tabsBefore, { timeout: 10000 });
  await activateQaTab();
  // Nothing persisted, and the QA tab itself holds no grant.
  await qa.click(`button[onclick="permQuery('microphone')"]`);
  await expect(logLines(qa, 'permissions.query(microphone) -> denied')).toHaveCount(1, { timeout: 5000 });
});

test('P5: Settings lists the remembered decisions per site and forgets them; a forgotten site asks again', async () => {
  await ui.click('[data-act="settings"]');
  await expect(ui.locator('.modal.settings')).toBeVisible();
  const row = ui.locator('.perm-row', { hasText: '127.0.0.1' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('notifications: allowed');
  await expect(row).toContainText('location: blocked');
  await expect(row).toContainText('camera: blocked');
  await expect(row).not.toContainText('microphone'); // "allow once" is never remembered
  await ui.click('.perm-row [data-perm-forget-host="127.0.0.1"][data-perm-forget-kind="camera"]');
  await expect(row).not.toContainText('camera: blocked');
  await expect(row).toContainText('location: blocked');
  await ui.click('.perm-row .perm-forget-site[data-perm-forget-host="127.0.0.1"]');
  await expect(ui.locator('.perm-row')).toHaveCount(0);
  await expect(ui.locator('.perm-sites')).toContainText('No decisions yet');
  await ui.keyboard.press('Escape');
  await expect(ui.locator('.modal.settings')).toHaveCount(0);
  // Forgotten = asked again.
  const qa = await contentPage('/security-qa.html');
  await qa.click('button[onclick="notif()"]');
  await expect(permAsk()).toBeVisible({ timeout: 5000 });
  await ui.keyboard.press('Escape');
  await expect(permAsk()).toHaveCount(0);
  await expect(logLines(qa, 'Notification.requestPermission() -> denied')).toHaveCount(1, { timeout: 5000 });
});

test('pages see a standard Chrome UA (no Raha/Electron tokens) and no wrong-browser banner', async () => {
  const qa = await contentPage('/security-qa.html');
  const ua = await qa.evaluate(() => window.navigator.userAgent);
  expect(ua).not.toMatch(/Raha|Electron/);
  expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0/); // reduced-UA format, real major
  // The page's not-in-Raha banner keys on Electron's EMPTY window.chrome
  // object (the UA and the client-hint brands both say Chrome by design),
  // so it must NOT appear here.
  await qa.waitForTimeout(500);
  expect(await qa.locator('div', { hasText: 'NOT viewing this in Raha' }).count()).toBe(0);
});

// ------------------------------------------ R-114: one Chrome identity
//
// Bot checks cross-check the UA string, the Sec-CH-UA headers and the
// in-page navigator.userAgentData against each other, across every frame.
// Three layers make them agree (ADR-0012): a CDP override per tab (JS
// view + renderer subresources + out-of-process iframes), header synthesis
// for requests no renderer decorates (navigations), and Accept-CH
// emulation for the high-entropy hints. Each test below pins one layer
// against the REAL wire, via the loopback server's request log.
//
// navigator.webdriver is deliberately NOT asserted: Playwright itself
// forces it to true in the pages it drives, so the value here says nothing
// about Raha (measured without Playwright: false, F5 in chrome-identity.js).

/** Serialize a brand list the way Chromium does for Sec-CH-UA. @param {{ brand: string, version: string }[]} list */
const serializeBrands = (list) => list.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', ');

/** What a page's own script reports — the reference every wire header is compared to. @param {import('playwright').Page | import('playwright').Frame} p */
const jsView = (p) => p.evaluate(() => {
  const uad = /** @type {any} */ (window.navigator).userAgentData;
  return {
    ua: window.navigator.userAgent,
    brands: /** @type {{ brand: string, version: string }[]} */ (uad.brands),
    platform: /** @type {string} */ (uad.platform),
  };
});

test('R-114: the DOCUMENT request carried Chrome client hints and UA (header synthesis)', async () => {
  // Navigations never get hints from Electron's renderer; the header hook
  // must have added them to the QA page's own document request — the SAME
  // list, byte for byte, that the page's script reports (bot scoring
  // compares requests against each other and against JS, so "contains
  // Google Chrome" is not enough: order and versions must match).
  const qa = await contentPage('/security-qa.html');
  const view = await jsView(qa);
  const doc = seen.find((r) => r.url === '/security-qa.html');
  expect(doc, 'the QA document request was logged').toBeTruthy();
  const h = /** @type {{ url: string, headers: Record<string, string> }} */ (doc).headers;
  expect(h['user-agent']).toMatch(/Chrome\/\d+\.0\.0\.0/);
  expect(h['user-agent']).not.toMatch(/Electron|Raha/);
  expect(h['user-agent']).toBe(view.ua);
  expect(h['sec-ch-ua']).toContain('"Google Chrome"');
  expect(h['sec-ch-ua']).toContain('"Chromium"');
  expect(h['sec-ch-ua']).toBe(serializeBrands(view.brands));
  expect(h['sec-ch-ua-mobile']).toBe('?0');
  expect(h['sec-ch-ua-platform']).toMatch(/^"(macOS|Windows|Linux)"$/);
  expect(h['sec-ch-ua-platform']).toBe(`"${view.platform}"`);
});

test('R-114: in-page userAgentData agrees byte-for-byte with what a fetch sends, high-entropy included', async () => {
  const qa = await contentPage('/security-qa.html');
  const view = await qa.evaluate(async () => {
    const uad = /** @type {any} */ (window.navigator).userAgentData;
    const high = await uad.getHighEntropyValues(['fullVersionList', 'platformVersion']);
    return {
      brands: /** @type {{ brand: string, version: string }[]} */ (uad.brands),
      fullVersionList: /** @type {{ brand: string, version: string }[]} */ (high.fullVersionList),
      platformVersion: /** @type {string} */ (high.platformVersion),
      platform: /** @type {string} */ (uad.platform),
    };
  });
  expect(view.brands.map((b) => b.brand)).toContain('Google Chrome');
  expect(view.fullVersionList.map((b) => b.brand)).toContain('Google Chrome');

  const before = seen.length;
  const status = await qa.evaluate(() => window.fetch('/ch-probe').then((r) => r.status));
  expect(status).toBe(200);
  await expect.poll(() => seen.slice(before).some((r) => r.url === '/ch-probe')).toBe(true);
  const probe = /** @type {{ url: string, headers: Record<string, string> }} */ (lastSeen('/ch-probe'));
  const h = probe.headers;
  expect(h['user-agent']).not.toMatch(/Electron|Raha/);
  // Layer 1: the renderer itself now sends the Chrome brand list, and it is
  // exactly the list its JS reports.
  expect(h['sec-ch-ua']).toBe(serializeBrands(view.brands));
  expect(h['sec-ch-ua-platform']).toBe(`"${view.platform}"`);
  // Layer 3: the document's Accept-CH asked for two high-entropy hints, so
  // the same-origin fetch carries those — and only those.
  expect(h['sec-ch-ua-full-version-list']).toBe(serializeBrands(view.fullVersionList));
  expect(h['sec-ch-ua-full-version-list']).toContain('"Google Chrome"');
  expect(h['sec-ch-ua-platform-version']).toBe(`"${view.platformVersion}"`);
  for (const k of ['sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-full-version', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors']) {
    expect(h[k], `${k} was not asked for`).toBeUndefined();
  }

  // That /ch-probe response carried its own Accept-CH (Sec-CH-UA-Arch).
  // Chrome only honors Accept-CH on top-level documents; a second
  // first-party fetch must still not carry the hint a subresource asked for.
  const again = seen.length;
  expect(await qa.evaluate(() => window.fetch('/ch-probe?again=1').then((r) => r.status))).toBe(200);
  await expect.poll(() => seen.slice(again).some((r) => r.url === '/ch-probe?again=1')).toBe(true);
  const h2 = /** @type {{ url: string, headers: Record<string, string> }} */ (lastSeen('/ch-probe?again=1')).headers;
  expect(h2['sec-ch-ua-full-version-list']).toBe(serializeBrands(view.fullVersionList));
  expect(h2['sec-ch-ua-arch'], 'Accept-CH on a subresource response is ignored, as in Chrome').toBeUndefined();
});

test('R-114: a dedicated worker inherits the Chrome identity, and its requests go out bare — as Chrome\'s do', async () => {
  const qa = await contentPage('/security-qa.html');
  const page = await jsView(qa);
  const before = seen.length;
  // The worker is auto-attached as a paused child target and only RESUMED
  // (no override of its own): this pins that it inherits its frame's.
  const inWorker = await qa.evaluate(() => new Promise((resolve, reject) => {
    const w = new window.Worker('/worker.js');
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.onerror = (e) => reject(new Error(`worker: ${e.message}`));
    setTimeout(() => reject(new Error('worker timeout')), 10000);
  }));
  expect(inWorker.error).toBeUndefined();
  expect(inWorker.status).toBe(200);
  expect(inWorker.ua).toBe(page.ua);
  expect(inWorker.brands).toEqual(page.brands);
  await expect.poll(() => seen.slice(before).some((r) => r.url === '/worker-probe')).toBe(true);
  // Measured side by side with Chrome 150: neither the worker script
  // request nor a fetch from inside the worker carries ANY client hint
  // (nor does a WebSocket handshake). Synthesizing them there would itself
  // be the inconsistency; only the UA is forced.
  for (const path of ['/worker.js', '/worker-probe']) {
    const h = /** @type {{ url: string, headers: Record<string, string> }} */ (lastSeen(path)).headers;
    expect(h['user-agent'], path).toBe(page.ua);
    expect(Object.keys(h).filter((k) => k.startsWith('sec-ch-')), `${path} carries no client hints, like Chrome`).toEqual([]);
  }
});

test('R-114: a cross-origin iframe reports and sends the Chrome identity (the Turnstile-shaped case)', async () => {
  test.setTimeout(90_000);
  const qa = await contentPage('/security-qa.html');
  // http://localhost is a different origin from the page's 127.0.0.1, so
  // Chromium puts this frame out of process — where, before this fix, the
  // raw Electron UA leaked in JS and on the wire.
  const frameUrl = `http://localhost:${port}/frame.html`;
  await qa.evaluate((src) => new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.src = src;
    f.width = '300';
    f.height = '80';
    f.addEventListener('load', () => resolve(null));
    document.body.appendChild(f);
  }), frameUrl);

  const top = await jsView(qa);

  // Precondition for what this test pins: the frame really IS out of
  // process. Were it in-process, the root override alone would satisfy
  // every assertion below and the child-session branding path would go
  // unexercised while the test stayed green.
  const oop = await app.evaluate(({ webContents }, url) => {
    for (const w of webContents.getAllWebContents()) {
      const f = w.mainFrame.framesInSubtree.find((x) => x.url.startsWith(url));
      if (f) return f.processId !== w.mainFrame.processId;
    }
    return null;
  }, frameUrl);
  expect(oop, 'the localhost frame lives in a different renderer than its 127.0.0.1 parent').toBe(true);

  // The frame's own DOCUMENT request (layer 2 covers the wire either way):
  // the same list, byte for byte, as the top document's script reports.
  await expect.poll(() => seen.some((r) => r.url === '/frame.html')).toBe(true);
  const doc = /** @type {{ url: string, headers: Record<string, string> }} */ (lastSeen('/frame.html')).headers;
  expect(doc['user-agent']).toMatch(/Chrome\/\d+\.0\.0\.0/);
  expect(doc['user-agent']).not.toMatch(/Electron|Raha/);
  expect(doc['user-agent']).toBe(top.ua);
  expect(doc['sec-ch-ua']).toContain('"Google Chrome"');
  expect(doc['sec-ch-ua']).toBe(serializeBrands(top.brands));
  expect(doc['sec-ch-ua-platform']).toBe(`"${top.platform}"`);

  // Inside the frame: the JS view is the CDP override's doing (layer 1) —
  // no header hook can reach navigator.userAgent. Checked twice: what the
  // frame's FIRST script saw at parse time (before any late override could
  // have applied — F1 applies live, so only this observes "branded before
  // its first script runs"), and what it sees now.
  await expect.poll(() => qa.frames().some((f) => f.url().startsWith(frameUrl)), { timeout: 15000 }).toBe(true);
  const frame = /** @type {import('playwright').Frame} */ (qa.frames().find((f) => f.url().startsWith(frameUrl)));
  expect(frame).not.toBe(qa.mainFrame());
  const first = await frame.evaluate(() => /** @type {any} */ (window).__first);
  expect(first, 'the parse-time capture ran').toBeTruthy();
  expect(first.ua).toBe(top.ua);
  expect(first.brands).toEqual(top.brands);
  const inside = await jsView(frame);
  expect(inside.ua).not.toMatch(/Electron|Raha/);
  expect(inside.ua).toBe(top.ua);
  expect(inside.brands).toEqual(top.brands);

  // And a fetch from inside the frame goes out as Chrome too — the same
  // brand list as every other request of this tab.
  const before = seen.length;
  const status = await frame.evaluate(() => window.fetch('/frame-probe').then((r) => r.status));
  expect(status).toBe(200);
  await expect.poll(() => seen.slice(before).some((r) => r.url === '/frame-probe')).toBe(true);
  const probe = /** @type {{ url: string, headers: Record<string, string> }} */ (lastSeen('/frame-probe')).headers;
  expect(probe['user-agent']).toBe(top.ua);
  expect(probe['sec-ch-ua']).toContain('"Google Chrome"');
  expect(probe['sec-ch-ua']).toBe(serializeBrands(inside.brands));
  expect(probe['sec-ch-ua']).toBe(doc['sec-ch-ua']);
  expect(probe['sec-ch-ua-platform']).toBe(doc['sec-ch-ua-platform']);
});

test('R-114: high-entropy hints stay first-party (Chrome\'s default `self` policy) and Accept-CH memory clears with site data', async () => {
  test.setTimeout(90_000);
  const qa = await contentPage('/security-qa.html');
  const view = await qa.evaluate(async () => {
    const uad = /** @type {any} */ (window.navigator).userAgentData;
    const high = await uad.getHighEntropyValues(['fullVersionList', 'platformVersion']);
    return {
      brands: /** @type {{ brand: string, version: string }[]} */ (uad.brands),
      fullVersionList: /** @type {{ brand: string, version: string }[]} */ (high.fullVersionList),
      platformVersion: /** @type {string} */ (high.platformVersion),
    };
  });
  const HIGH = ['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-full-version', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors'];
  /** @param {Record<string, string>} h @param {string} what */
  const expectNoHigh = (h, what) => { for (const k of HIGH) expect(h[k], `${what}: ${k}`).toBeUndefined(); };
  /** @param {Record<string, string>} h @param {string} what */
  const expectLow = (h, what) => {
    expect(h['sec-ch-ua'], what).toBe(serializeBrands(view.brands));
    expect(h['sec-ch-ua-mobile'], what).toBe('?0');
    expect(h['user-agent'], what).not.toMatch(/Electron|Raha/);
  };
  const hdr = (/** @type {string} */ url) => /** @type {{ url: string, headers: Record<string, string> }} */ (lastSeen(url)).headers;
  const navigateActiveTab = async (/** @type {string} */ url) => {
    await ui.click('.omnibox');
    await ui.fill('.omnibox', url);
    await ui.keyboard.press('Enter');
  };
  const localhostBase = `http://localhost:${port}`;

  // 1. A TOP-LEVEL visit to http://localhost (another origin) in its own
  //    tab: first contact carries the low-entropy three and no high-entropy
  //    hint (Raha does no Critical-CH restart — a documented divergence),
  //    and the response's Accept-CH is now remembered for that origin.
  const tabsBefore = await tabRows();
  await qa.evaluate((u) => { window.open(u, '_blank'); }, `${localhostBase}/security-qa.html?top=1`);
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(tabsBefore + 1, { timeout: 10000 });
  await expect.poll(() => seen.some((r) => r.url === '/security-qa.html?top=1'), { timeout: 10000 }).toBe(true);
  const first = hdr('/security-qa.html?top=1');
  expect(first.host).toBe(`localhost:${port}`);
  expectLow(first, 'first contact');
  expectNoHigh(first, 'first contact');

  // 2. The next navigation to that origin carries exactly what it asked for
  //    (layer 3 on navigations) — and nothing it did not.
  await navigateActiveTab(`${localhostBase}/security-qa.html?top=2`);
  await expect.poll(() => seen.some((r) => r.url === '/security-qa.html?top=2'), { timeout: 10000 }).toBe(true);
  const second = hdr('/security-qa.html?top=2');
  expectLow(second, 'second visit');
  expect(second['sec-ch-ua-full-version-list']).toBe(serializeBrands(view.fullVersionList));
  expect(second['sec-ch-ua-platform-version']).toBe(`"${view.platformVersion}"`);
  for (const k of HIGH.slice(2)) expect(second[k], `second visit: ${k} was not asked for`).toBeUndefined();

  // 3. "Clear Cookies & Data for This Site" forgets the Accept-CH memory
  //    too (Chrome clears it with cookies): the visit after it is first
  //    contact again — a user un-wedging a site really is a fresh visitor.
  const cleared = await ui.evaluate(() => /** @type {any} */ (window).raha.invoke('siteData:clear', { host: 'localhost' }));
  expect(cleared.ok).toBe(true);
  await navigateActiveTab(`${localhostBase}/security-qa.html?top=3`);
  await expect.poll(() => seen.some((r) => r.url === '/security-qa.html?top=3'), { timeout: 10000 }).toBe(true);
  const third = hdr('/security-qa.html?top=3');
  expectLow(third, 'after clearing site data');
  expectNoHigh(third, 'after clearing site data');
  // (that response re-asked, so localhost is remembered again for 4–6.)

  // Close the helper tab: its URL would also match contentPage('security-qa').
  const helperId = await ui.locator('#sidebar .row.tab.state-active').getAttribute('data-id');
  expect(helperId).toBeTruthy();
  await ui.evaluate((id) => /** @type {any} */ (window).raha.invoke('tab:close', { tabId: id }), helperId);
  await expect(ui.locator('#sidebar .row.tab')).toHaveCount(tabsBefore, { timeout: 10000 });
  await activateQaTab();

  // 4. localhost asked — but embedded CROSS-ORIGIN under 127.0.0.1 its
  //    document gets only the low-entropy three, as under Chrome's
  //    default `self` policy. This is the accounts.google.com /
  //    challenges.cloudflare.com shape: visited top-level once, then
  //    framed by everyone.
  const frameUrl = `${localhostBase}/frame.html?tp=1`;
  await qa.evaluate((src) => new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.src = src;
    f.addEventListener('load', () => resolve(null));
    document.body.appendChild(f);
  }), frameUrl);
  await expect.poll(() => seen.some((r) => r.url === '/frame.html?tp=1'), { timeout: 10000 }).toBe(true);
  const frameDoc = hdr('/frame.html?tp=1');
  expectLow(frameDoc, 'cross-origin frame document');
  expectNoHigh(frameDoc, 'cross-origin frame document');

  // 5. Nor do that frame's own fetches (same-origin to the frame, cross-
  //    origin to the top document).
  await expect.poll(() => qa.frames().some((f) => f.url() === frameUrl), { timeout: 15000 }).toBe(true);
  const frame = /** @type {import('playwright').Frame} */ (qa.frames().find((f) => f.url() === frameUrl));
  const b5 = seen.length;
  expect(await frame.evaluate(() => window.fetch('/frame-probe?tp=1').then((r) => r.status))).toBe(200);
  await expect.poll(() => seen.slice(b5).some((r) => r.url === '/frame-probe?tp=1')).toBe(true);
  const frameProbe = hdr('/frame-probe?tp=1');
  expectLow(frameProbe, 'fetch from a cross-origin frame');
  expectNoHigh(frameProbe, 'fetch from a cross-origin frame');

  // 6. And a THIRD-PARTY fetch from the top page to that origin gets none
  //    either (no-cors: the request still goes out; the reply is opaque).
  const b6 = seen.length;
  await qa.evaluate((u) => window.fetch(u, { mode: 'no-cors' }).then(() => null, () => null), `${localhostBase}/ch-probe?tp=1`);
  await expect.poll(() => seen.slice(b6).some((r) => r.url === '/ch-probe?tp=1')).toBe(true);
  const thirdParty = hdr('/ch-probe?tp=1');
  expectLow(thirdParty, 'third-party fetch');
  expectNoHigh(thirdParty, 'third-party fetch');
});

test('R-122: WebRTC candidates never expose local/private IPs to a page', async () => {
  const qa = await contentPage('/security-qa.html');
  const candidates = await qa.evaluate(async () => {
    const pc = new window.RTCPeerConnection();
    /** @type {string[]} */ const out = [];
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) out.push(e.candidate.candidate); };
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(null); };
      setTimeout(resolve, 5000); // offline gathering can hang; the cap is fine
    });
    pc.close();
    return out;
  });
  // Measured on Electron 43: Chromium's mDNS anonymization already hides
  // host-candidate IPs (.local UUIDs) even WITHOUT our policy — but mDNS
  // quietly turns itself off where it can't register (some CI/container
  // networks) and whenever the page holds a getUserMedia grant (R-103:
  // the P5 tests above deliberately leave the QA tab without one). The
  // policy holds in those cases too; this asserts the outcome that must
  // never regress: no raw private address reaches a page, whatever
  // mechanism is doing the hiding.
  const leaky = candidates.filter((c) =>
    /(?:^|\s)(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|fe80:)/i.test(c));
  expect(leaky).toEqual([]);
});

// ------------------------------------- history: the af76be8 regression guard

test('history: blob entry survives sleep/wake, Back walks all steps', async () => {
  test.setTimeout(120_000);
  const qa = await contentPage('/security-qa.html');
  await qa.click('button[onclick="buildHistory()"]');
  // The page chains ?step=1 → blob (own driver script) → ?step=4, ~700ms/hop.
  await expect
    .poll(async () => (await contentPage('security-qa', 15000)).url(), { timeout: 20000 })
    .toContain('step=4');

  // Sleep the (active) QA tab, then wake it by clicking its sidebar row.
  await expect(ui.locator('#sidebar .row.tab.state-active')).toHaveCount(1);
  await ui.click('[data-act="sleep"]');
  // The two popup-regression tabs are already asleep; the QA tab makes 3.
  await expect(ui.locator('#sidebar .row.tab.state-asleep')).toHaveCount(3, { timeout: 15000 });
  await ui.locator('#sidebar .row.tab.state-asleep .name', { hasText: 'Raha security QA' }).click();
  await expect(ui.locator('#sidebar .row.tab.state-asleep')).toHaveCount(2, { timeout: 15000 });
  await expect.poll(async () => (await contentPage('security-qa', 15000)).url(), { timeout: 15000 }).toContain('step=4');

  // Walk back. Expected stack under the woken renderer:
  //   ?step=4 → blob:… → ?step=1 → the original QA page.
  // The blob's data died with the old renderer, so its entry shows the
  // in-place error UI — but the URL stays blob: and the entry keeps its
  // index (views.js did-fail-load), so Back continues PAST it. That is the
  // whole regression: entries surviving restore AND remaining traversable.
  const back = async () => { await ui.click('[data-act="back"]'); await ui.waitForTimeout(700); };
  const anyContentUrl = async () => {
    for (const w of app.windows()) {
      if (w !== ui) return w.url();
    }
    return '';
  };

  await back();
  // The dead entry's DOCUMENT is Chromium's error doc (chrome-error://…,
  // with our in-place error UI rendered into it); the ENTRY itself still
  // holds the blob URL and its index — proven by the next two steps
  // walking PAST it instead of bouncing.
  await expect.poll(anyContentUrl, { timeout: 10000 }).toMatch(/blob:|chrome-error:/);
  await back();
  await expect.poll(anyContentUrl, { timeout: 10000 }).toContain('step=1');
  await back();
  await expect.poll(anyContentUrl, { timeout: 10000 }).toMatch(/security-qa\.html$/);
});

// ------------------------------------------------------------ app-link asks
//
// LAST ON PURPOSE. The refused navigation leaves the renderer in the state
// app.spec.js warns about (a cancelled main-frame navigation poisons later
// Playwright interaction with that page), so this must not run before tests
// that still drive the QA page.
test('a clicked app link (navigation, not popup) raises the consent ask; cancel opens nothing', async () => {
  // location.href with a non-web scheme takes the will-navigate route in
  // views.js — the path a real clicked zoommtg:/mailto: link uses — which
  // no other layer exercises against real Electron. NEVER click Open here:
  // a yes would hand the URL to the actual OS.
  const qa = await contentPage('security-qa');
  const before = await tabRows();
  await qa.evaluate(() => { window.location.href = 'zoommtg://qa.invalid/join?x=1'; });
  await expect(ui.locator('.modal.mini [data-ext-open]')).toBeVisible({ timeout: 5000 });
  await expect(ui.locator('.modal.mini .ext-url')).toContainText('zoommtg://qa.invalid/join?x=1');
  await ui.click('.modal.mini [data-ext-cancel]');
  await expect(ui.locator('[data-ext-open]')).toHaveCount(0);
  await ui.waitForTimeout(300);
  expect(await tabRows()).toBe(before); // no tab appeared, nothing navigated
});
