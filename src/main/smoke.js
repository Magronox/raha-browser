// Self-test harness: `npm run smoke` (electron . --raha-smoke).
// Exercises the REAL Electron adapters (WebContentsViews) against the engine,
// printing TAP-style lines and exiting non-zero on failure. This is the
// fastest "did I break the runtime glue?" check on a machine with a display
// (CI runs it under xvfb).
//
// Pages come from a loopback server started here — still no external network,
// but real http:// URLs. They used to be data: URLs, which the scheme gate
// (docs/INVARIANTS.md #13) now refuses, exactly as it would for a hostile
// page. Testing through an exemption would have meant shipping one.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

/** Loopback page server. @returns {Promise<{ url: (name: string) => string, close: () => void }>} */
async function startPageServer() {
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '/').replace(/^\/+/, '') || 'page';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${name}</title><body style="background:#222;color:#eee"><h1>${name}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: (name) => `http://127.0.0.1:${addr.port}/${name}`,
    close: () => server.close(),
  };
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until cond() is true or timeout. @param {() => boolean} cond
 */
async function until(cond, timeoutMs = 8000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await wait(120);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * @param {import('./core/engine.js').Engine} engine
 * @returns {Promise<number>} exit code
 */
export async function runSmokeTest(engine) {
  let passed = 0;
  let failed = 0;
  /** @param {string} name @param {() => (void|Promise<void>)} fn */
  const t = async (name, fn) => {
    try {
      await fn();
      passed += 1;
      console.log(`ok ${passed + failed} - ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`not ok ${passed + failed} - ${name}: ${String(err)}`);
    }
  };

  const server = await startPageServer();
  const page = server.url;

  const snap = () => engine.snapshot();
  const stateOf = (/** @type {string} */ id) => snap().tabs.find((x) => x.id === id)?.state;

  engine.settingsSet({ maxLiveTabs: 3, blockAds: false, blockTrackers: false });

  /** @type {string[]} */
  const ids = [];
  await t('create 5 real tabs (cap 3) -> only 3 renderers stay', async () => {
    for (let i = 0; i < 5; i++) {
      const r = engine.tabCreate({ url: page(`smoke-${i}`) });
      if ('error' in r) throw new Error(r.error);
      ids.push(r.tabId);
      await wait(250); // distinct lastActiveAt ordering
    }
    await until(() => snap().stats.runningCount === 3, 8000, 'cap enforcement');
    if (stateOf(ids[0]) !== 'asleep' || stateOf(ids[1]) !== 'asleep') {
      throw new Error(`oldest two should sleep, got ${ids.map(stateOf).join(',')}`);
    }
  });

  await t('real page titles arrive from renderers', async () => {
    await until(() => snap().tabs.some((x) => x.title.includes('smoke-4')), 8000, 'title');
  });

  await t('waking an asleep tab creates a fresh renderer', async () => {
    engine.tabActivate({ tabId: ids[0] });
    await until(() => stateOf(ids[0]) === 'active', 8000, 'wake');
    await until(() => snap().stats.runningCount === 3, 8000, 'cap after wake');
  });

  await t('keepAlive pin survives new tabs; LRU sleeps instead', async () => {
    engine.tabSetKeepAlive({ tabId: ids[0], keepAlive: true });
    engine.tabCreate({ url: page('smoke-new') });
    await wait(600);
    if (stateOf(ids[0]) === 'asleep') throw new Error('pinned tab was evicted');
    if (snap().stats.runningCount > 3) throw new Error('cap exceeded');
  });

  await t('metrics tick attributes real memory to real pids', async () => {
    engine.tick();
    await wait(300);
    engine.tick();
    const running = snap().tabs.filter((x) => x.state !== 'asleep');
    if (!running.some((x) => (x.memMB ?? 0) > 0)) throw new Error('no tab got memMB from getAppMetrics');
  });

  await t('folders: create/nest/move/sleepAll', async () => {
    const f = engine.folderCreate({ name: 'Smoke Folder' });
    if ('error' in f) throw new Error(f.error);
    const sub = engine.folderCreate({ name: 'Nested', parentId: f.folderId });
    if ('error' in sub) throw new Error(sub.error);
    engine.nodeMove({ nodeId: ids[0], parentId: sub.folderId, index: 0 });
    const { slept } = engine.folderSleepAll({ folderId: f.folderId });
    if (slept < 1) throw new Error('sleepAll slept nothing');
    if (stateOf(ids[0]) !== 'asleep') throw new Error('moved tab not asleep');
  });

  await t('sleep saved navigation history for restore', async () => {
    const node = engine.tabNode(ids[0]);
    if (!node) throw new Error('node missing');
    if (!node.url.startsWith('http://127.0.0.1:')) throw new Error(`url not preserved: ${node.url}`);
  });

  await t('state persists to disk atomically', async () => {
    engine.flushPersist();
    const dir = process.env.RAHA_PROFILE_DIR;
    if (!dir) throw new Error('smoke requires RAHA_PROFILE_DIR');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    if (raw.schemaVersion !== 2) throw new Error('bad schemaVersion');
    const tabCount = Object.values(raw.tree.nodes).filter((/** @type {any} */ n) => n.type === 'tab').length;
    if (tabCount !== 6) throw new Error(`expected 6 persisted tabs, got ${tabCount}`);
  });

  server.close();
  console.log(`# smoke: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}
