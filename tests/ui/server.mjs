// Tiny static server for the UI harness: serves the repo (so ES module
// imports work — chromium refuses file:// modules) plus generated
// placeholder thumbnails under /__thumbs/.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/** Deterministic pastel-ish gradient thumbnail per tab id. @param {string} id */
function thumbSvg(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const h2 = (h + 40) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${h},32%,22%)"/><stop offset="1" stop-color="hsl(${h2},38%,14%)"/>
  </linearGradient></defs>
  <rect width="480" height="300" fill="url(#g)"/>
  <rect x="0" y="0" width="480" height="34" fill="rgba(255,255,255,0.06)"/>
  <circle cx="17" cy="17" r="5" fill="rgba(255,255,255,0.18)"/>
  <rect x="34" y="11" width="200" height="12" rx="6" fill="rgba(255,255,255,0.12)"/>
  <rect x="24" y="64" width="300" height="16" rx="8" fill="rgba(255,255,255,0.16)"/>
  <rect x="24" y="96" width="420" height="9" rx="4" fill="rgba(255,255,255,0.10)"/>
  <rect x="24" y="114" width="380" height="9" rx="4" fill="rgba(255,255,255,0.10)"/>
  <rect x="24" y="132" width="404" height="9" rx="4" fill="rgba(255,255,255,0.08)"/>
  <rect x="24" y="168" width="188" height="100" rx="8" fill="rgba(255,255,255,0.07)"/>
  <rect x="228" y="168" width="188" height="100" rx="8" fill="rgba(255,255,255,0.05)"/>
</svg>`;
}

/** @returns {Promise<{ url: string, close: () => void }>} */
export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/__thumbs/')) {
        const id = decodeURIComponent(path.basename(url.pathname)).replace(/\.png$/, '');
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end(thumbSvg(id));
        return;
      }
      const rel = url.pathname.replace(/^\/+/, '');
      const file = path.normalize(path.join(repoRoot, rel));
      if (!file.startsWith(repoRoot)) throw new Error('traversal');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}
