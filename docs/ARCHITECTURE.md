# ARCHITECTURE

Raha is Chromium (via Electron) orchestrated by a small, pure, fully-tested
engine. The product is not the rendering — it is the **resource governor**
plus calm organization on top.

## Process model

```
┌────────────────────────────── Electron main process ──────────────────────────────┐
│                                                                                    │
│   src/main/index.js (wiring)                                                       │
│        │                                                                           │
│   ┌────▼─────────────── src/main/core/engine.js ─────────────────┐                 │
│   │  tree (folders/tabs)   settings    runtime table   governor  │   PURE          │
│   │  persistence dirtiness   snapshot builder   tick()           │   (no electron) │
│   └────┬──────────────┬───────────────┬──────────────┬───────────┘                 │
│        │ views port   │ metrics port  │ persist port │ events                      │
│   ┌────▼────┐    ┌────▼────┐    ┌─────▼───┐    ┌─────▼─────┐                       │
│   │views.js │    │metrics  │    │persist  │    │ ipc.js    │  src/main/electron/   │
│   │(WebCont │    │(getApp  │    │(atomic  │    │ (handle + │  ADAPTERS             │
│   │entsView)│    │Metrics) │    │ json)   │    │  push)    │  (thin, docs-checked) │
│   └────┬────┘    └─────────┘    └─────────┘    └─────┬─────┘                       │
└────────┼─────────────────────────────────────────────┼────────────────────────────┘
         │ one WebContentsView per RUNNING tab         │ contextBridge (preload ui.cjs)
   ┌─────▼─────┐  ┌───────────┐                  ┌─────▼─────────────────────────┐
   │ tab       │  │ tab       │   ...            │ UI view (raha://app)          │
   │ renderer  │  │ renderer  │                  │ src/ui: sidebar, grid,        │
   │ (sandbox, │  │ (sandbox, │                  │ topbar, livebar, settings     │
   │ no bridge)│  │ no bridge)│                  │ plain JS + DOM                │
   └───────────┘  └───────────┘                  └───────────────────────────────┘
```

- **BaseWindow + WebContentsView** (not BrowserWindow/BrowserView): the UI
  view fills the window; the ACTIVE tab's view is positioned over the content
  rectangle (`src/shared/layout.js`). Background running tabs stay detached
  (renderer alive, nothing composited). Asleep tabs have no renderer at all.
- **Sessions:** web content lives in `persist:main`; the UI chrome in an
  isolated in-memory `raha-ui` partition. The `raha://` protocol serves UI
  files + thumbnails (UI session) and home/error pages (web session).

## The tab lifecycle

```
              tabCreate / activate(asleep)                 governor or user
   (no state) ────────────► RUNNING (active) ──────────────► ASLEEP
                              ▲   │ switch away               │  renderer destroyed;
                              │   ▼                           │  keeps: url, title,
                              │ RUNNING (background) ─────────┘  navJson, thumb, tree pos
                              │   │
                              └───┘ activate (attach + focus)
```

Sleep saves navigation history (`navigationHistory.getAllEntries`, capped to
25 entries) into the tab node (`navJson`); wake restores it
(`navigationHistory.restore`) so back/forward survive. On boot, EVERY tab is
asleep (cold start costs ~0 tab memory) — the user wakes what they need.

## The governor

Pure function `decide(tabs, settings, now)` in `src/shared/policy.js`,
executed by `engine.tick()` every `RAHA_TICK_MS` (2.5s default) and after
every relevant mutation (`governNow`). Rule order and protections are
documented in the policy header — that comment is normative.

Metrics: `app.getAppMetrics()` per process, matched to tabs via
`webContents.getOSProcessId()`. Same-site tabs can share a renderer process —
those tabs each display the full process figure with a `*` (shared) marker,
and `stats.totalMemMB` double-counts in that case (documented tradeoff,
tests pin it).

## Data & persistence

One profile dir (`RAHA_PROFILE_DIR` or `<userData>/profile`):

```
profile/
  state.json      { schemaVersion, tree: {nodes, rootId}, activeTabId }
  settings.json   { schemaVersion, maxLiveTabs, rules, ... }
  thumbs/<tabId>.png
```

Writes are atomic (tmp + fsync + rename), debounced by a dirty flag, flushed
every tick and at shutdown. Corrupt files are backed up (`*.corrupt-<ts>`) and
rebuilt; `repairTree` salvages every valid tab from a broken tree. Schema
changes go through `src/shared/migrate.js` (invariant #8).

## The UI

Plain DOM, one full re-render per snapshot push (30ms debounce in main). The
snapshot (`src/shared/ipc-contract.js` → `Snapshot`) is the complete UI
truth — the UI holds no derived browser state beyond local view prefs
(selected folder, open modals). At a few hundred tabs this is comfortably
fast; virtualizing the tree is ROADMAP R-110.

## Testing strategy (four rings)

1. `tests/unit` — pure logic + Engine on fake ports (node:test, no deps, ms-fast).
2. `tests/ui` — REAL UI in Chromium + REAL engine on fakes over a mock bridge
   (`exposeFunction`), mirroring the process split. Also renders README
   screenshots. Offline-capable.
3. `tests/e2e` — real Electron, real renderers, real suspension (Playwright).
4. `npm run smoke` — scripted in-app self-test of the adapters (CI + any dev box).

Ring 1–2 run anywhere (they are the sandbox-safe `verify:offline`); rings 3–4
need node_modules + a display and always run in CI.
