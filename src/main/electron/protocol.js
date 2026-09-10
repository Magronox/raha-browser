// The raha:// scheme.
//   raha://app/...        UI chrome files (src/ui), served to the UI SESSION
//                         ONLY (allowChrome) — web content must never be able
//                         to render Raha's own chrome inside a page;
//                         raha://app/shared/* serves src/shared (the UI's ES
//                         modules import the pure shared layer as ../shared/*,
//                         which URL resolution flattens to raha://app/shared/*)
//   raha://home           new-tab page shown INSIDE content tabs (src/ui/pages)
//   raha://error?...      load-failure page shown inside content tabs
//   raha://thumb/<id>.png tab thumbnails from the profile dir (UI session only)
//
// registerRahaScheme() must run before app 'ready'; installRahaProtocol()
// after 'ready', once per session that needs it.
import { protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { thumbPath } from './paths.js';

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = path.join(srcRoot, 'ui');
const sharedRoot = path.join(srcRoot, 'shared');

export function registerRahaScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'raha', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * Both sessions need this scheme, but for very different reasons: the UI
 * session serves the chrome itself, while the web session only needs the
 * pages shown INSIDE tabs (home/welcome/error). Web content therefore gets
 * neither `app` (Raha's own source) nor `thumb` (screenshots of every tab) —
 * see the allowChrome/allowThumbs split below.
 * @param {Electron.Session} ses
 * @param {{ allowThumbs: boolean, allowChrome: boolean }} opts
 */
export function installRahaProtocol(ses, opts) {
  ses.protocol.handle('raha', (request) => {
    const url = new URL(request.url);
    const host = url.hostname; // 'app' | 'home' | 'welcome' | 'error' | 'thumb'

    if (host === 'thumb' && opts.allowThumbs) {
      const id = path.basename(url.pathname).replace(/\.png$/, '');
      const file = thumbPath(id);
      if (fs.existsSync(file)) return net.fetch(pathToFileURL(file).toString());
      return new Response('', { status: 404 });
    }

    if (host === 'app' && opts.allowChrome) {
      const rel = url.pathname.replace(/^\/+/, '') || 'index.html';
      // shared/* comes from src/shared — and ONLY src/shared; src/main is
      // never served. (A future src/ui/shared/ dir would be shadowed by this
      // mapping — don't create one. Kept in sync with
      // tests/unit/ui-module-graph.test.js.)
      const file = rel.startsWith('shared/')
        ? safeJoin(sharedRoot, rel.slice('shared/'.length))
        : safeJoin(uiRoot, rel);
      if (file) return net.fetch(pathToFileURL(file).toString());
      return new Response('not found', { status: 404 });
    }

    if (host === 'home') {
      const file = path.join(uiRoot, 'pages', 'home.html');
      return net.fetch(pathToFileURL(file).toString());
    }

    if (host === 'welcome') {
      const file = path.join(uiRoot, 'pages', 'welcome.html');
      return net.fetch(pathToFileURL(file).toString());
    }

    if (host === 'error') {
      const file = path.join(uiRoot, 'pages', 'error.html');
      return net.fetch(pathToFileURL(file).toString());
    }

    return new Response('forbidden', { status: 403 });
  });
}

/**
 * Resolve rel inside root, refusing path traversal.
 * @param {string} root @param {string} rel @returns {string|null}
 */
function safeJoin(root, rel) {
  const abs = path.normalize(path.join(root, rel));
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}
