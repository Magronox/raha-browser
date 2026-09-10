// Node-side mock of the main process for the offline UI harness: the REAL
// Engine + fake ports, mapped to IPC channels exactly like
// src/main/electron/ipc.js does. If you add a channel there, add it here
// (the contract test in run.mjs fails loudly if the two drift).
import { Engine } from '../../src/main/core/engine.js';
import { FakeWorld } from '../fakes/ports.js';
import { INVOKE } from '../../src/shared/ipc-contract.js';
import { must, ok } from '../helpers.js';

/**
 * Engine events, mirroring the onEvent port contract atop
 * src/main/core/engine.js:
 *   evt: {type:'snapshot'} | {type:'toast', kind, text} | {type:'focusOmnibox'}
 *      | {type:'findResult', tabId, matches, activeMatchOrdinal}
 *      | {type:'askExternal', id, url, scheme, app}
 *      | {type:'askPermission', ask}   ask = PermissionAsk | null (withdraw)
 * @typedef {{ type: 'snapshot' }
 *         | { type: 'toast', kind: string, text: string }
 *         | { type: 'focusOmnibox' }
 *         | { type: 'findResult', tabId: string, matches: number, activeMatchOrdinal: number }
 *         | { type: 'askExternal', id: number, url: string, scheme: string|null, app: string }
 *         | { type: 'askPermission', ask: import('../../src/shared/ipc-contract.js').PermissionAsk|null }} EngineEvent
 */

export function createMockMain() {
  const world = new FakeWorld();
  /** @type {Array<{ channel: string, payload: EngineEvent }>} */
  const outbox = [];
  const engine = new Engine({
    ...world.ports(),
    onEvent: (evt) => outbox.push({ channel: 'raw', payload: evt }),
  });

  /** @type {Record<string, (p: any) => unknown>} */
  const handlers = {
    [INVOKE.stateGet]: () => engine.snapshot(),
    [INVOKE.tabCreate]: (p) => engine.tabCreate(p ?? {}),
    [INVOKE.tabClose]: (p) => engine.tabClose(p),
    [INVOKE.tabActivate]: (p) => engine.tabActivate(p),
    [INVOKE.tabSleep]: (p) => engine.tabSleep(p),
    [INVOKE.tabSetKeepAlive]: (p) => engine.tabSetKeepAlive(p),
    [INVOKE.tabSetMemLimit]: (p) => engine.tabSetMemLimit(p),
    [INVOKE.tabShowGrid]: () => engine.tabShowGrid(),
    [INVOKE.navOmnibox]: (p) => engine.navOmnibox(p),
    [INVOKE.navBack]: (p) => engine.navOp(p, 'back'),
    [INVOKE.navForward]: (p) => engine.navOp(p, 'forward'),
    [INVOKE.navReload]: (p) => engine.navOp(p, 'reload'),
    [INVOKE.navHardReload]: (p) => engine.navOp(p, 'hardReload'),
    [INVOKE.navStop]: (p) => engine.navOp(p, 'stop'),
    [INVOKE.findStart]: (p) => engine.findStart(p),
    [INVOKE.findStop]: (p) => engine.findStop(p),
    [INVOKE.externalOpen]: (p) => engine.externalOpen(p ?? {}),
    [INVOKE.externalDismiss]: (p) => engine.externalDismiss(p ?? {}),
    [INVOKE.folderCreate]: (p) => engine.folderCreate(p),
    [INVOKE.folderRename]: (p) => engine.folderRename(p),
    [INVOKE.folderToggle]: (p) => engine.folderToggle(p),
    [INVOKE.folderSleepAll]: (p) => engine.folderSleepAll(p),
    [INVOKE.nodeRemove]: (p) => engine.nodeRemove(p),
    [INVOKE.nodeMove]: (p) => engine.nodeMove(p),
    [INVOKE.settingsGet]: () => engine.settingsGet(),
    [INVOKE.settingsSet]: (p) => engine.settingsSet(p ?? {}),
    [INVOKE.zoomSet]: (p) => engine.zoomSet(p),
    [INVOKE.historySources]: () => engine.historySources(),
    [INVOKE.historyImport]: (p) => engine.historyImport(p ?? {}),
    // Real handler shows a native dialog (main owns the path); fakes cancel.
    [INVOKE.historyImportFile]: () => ({ canceled: true }),
    [INVOKE.uiOverlay]: (p) => engine.overlaySet(p ?? {}),
    [INVOKE.uiSidebar]: (p) => engine.sidebarSet(p ?? {}),
    // Real handler talks to the OS (LaunchServices); fakes report success.
    [INVOKE.defaultBrowserSet]: () => ({ ok: true, isDefault: true }),
    // Real handlers operate on the Chromium session; fakes report success.
    [INVOKE.siteDataClear]: () => ({ ok: true, cookiesRemoved: 0 }),
    [INVOKE.siteDataClearAll]: () => ({ canceled: true }),
    [INVOKE.openTabsSources]: () => engine.openTabsSources(),
    [INVOKE.openTabsImport]: (p) => engine.openTabsImport(p ?? {}),
    [INVOKE.historyList]: (p) => engine.historyList(p ?? {}),
    [INVOKE.historyClear]: () => engine.historyClear(),
    [INVOKE.organizePreview]: () => engine.organizePreview(),
    [INVOKE.organizeApply]: () => engine.organizeApply(),
    [INVOKE.runawayResolve]: (p) => engine.runawayResolve(p ?? {}),
    [INVOKE.permissionAnswer]: (p) => engine.permissionAnswer(p ?? {}),
    [INVOKE.permissionForget]: (p) => engine.permissionForget(p ?? {}),
  };

  return {
    engine,
    world,
    handlers,
    handledChannels: Object.keys(handlers),
    /** @param {string} channel @param {unknown} payload */
    invoke(channel, payload) {
      const fn = handlers[channel];
      if (!fn) throw new Error(`mock-main: unhandled channel ${channel}`);
      return fn(payload);
    },
    drainEvents() {
      const evts = outbox.splice(0);
      return evts.map((e) => e.payload);
    },
  };
}

/** Seed a believable workspace for tests + screenshots. @param {ReturnType<typeof createMockMain>} m */
export function seedDemo(m) {
  const { engine, world } = m;
  engine.settingsSet({
    maxLiveTabs: 5,
    rules: [{ pattern: '*.music.youtube.com', keepAlive: true }],
  });

  const work = engine.folderCreate({ name: 'Work' });
  const proj = engine.folderCreate({ name: 'Project Raha', parentId: work.folderId });
  const research = engine.folderCreate({ name: 'Research' });
  const media = engine.folderCreate({ name: 'Media' });

  /** @type {(url: string, title: string, folderId?: string) => string} */
  const mk = (url, title, folderId) => {
    const { tabId } = ok(engine.tabCreate({ url, folderId, activate: false }));
    const node = must(engine.tabNode(tabId), `tab node for ${url}`);
    node.title = title;
    return tabId;
  };

  const t = {
    gh: mk('https://github.com/raha-browser/raha', 'raha-browser/raha: a calm browser', proj.folderId),
    docs: mk('https://www.electronjs.org/docs/latest/api/web-contents-view', 'WebContentsView | Electron', proj.folderId),
    ci: mk('https://github.com/raha-browser/raha/actions', 'CI runs · GitHub Actions', proj.folderId),
    mail: mk('https://mail.example.com/inbox', 'Inbox (3) — Mail', work.folderId),
    paper: mk('https://arxiv.org/abs/2401.00001', '[2401.00001] Attention care limits', research.folderId),
    wiki: mk('https://en.wikipedia.org/wiki/Working_memory', 'Working memory - Wikipedia', research.folderId),
    hn: mk('https://news.ycombinator.com/', 'Hacker News', research.folderId),
    music: mk('https://music.youtube.com/watch?v=x', 'Deep Focus — YouTube Music', media.folderId),
    recipe: mk('https://cooking.example.org/tahdig', 'Perfect tahdig, every time', media.folderId),
  };

  // Wake a few: docs active, gh + music running in background.
  engine.tabActivate({ tabId: t.gh });
  engine.tabActivate({ tabId: t.music });
  world.viewsByTab.get(t.music)?.simulateAudio(true);
  engine.tabActivate({ tabId: t.docs });
  engine.tabSetKeepAlive({ tabId: t.gh, keepAlive: true });
  engine.tabSetMemLimit({ tabId: t.docs, memLimitMB: 900 });

  // Titles got overwritten by FakeView loads — restore the pretty ones.
  must(engine.tabNode(t.gh), 'gh tab node').title = 'raha-browser/raha: a calm browser';
  must(engine.tabNode(t.music), 'music tab node').title = 'Deep Focus — YouTube Music';
  must(engine.tabNode(t.docs), 'docs tab node').title = 'WebContentsView | Electron';

  world.setTabMetrics(t.gh, 214, 0.4);
  world.setTabMetrics(t.music, 189, 2.1);
  world.setTabMetrics(t.docs, 331, 1.2);
  engine.tick();
  return t;
}
