// Serves tests/manual/ over loopback for hands-on QA: `npm run qa`.
// It has to be a real http:// origin — Raha refuses file:// URLs by design
// (docs/INVARIANTS.md #13), which is itself the first thing security-qa.html
// checks. Zero dependencies, nothing leaves the machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.QA_PORT || 8777);

/** @type {Record<string, string>} */
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer((req, res) => {
  const rel = (req.url ?? '/').split('?')[0].replace(/^\/+/, '') || 'security-qa.html';
  const file = path.normalize(path.join(here, rel));
  if (!file.startsWith(here) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

/**
 * Listen, stepping to the next free port if this one is taken. A stale server
 * from an earlier session is the normal cause, and crashing with a raw
 * EADDRINUSE stack trace is a rotten way to greet someone who just wants to
 * test the browser.
 * @param {number} port @param {number} attemptsLeft
 */
function listen(port, attemptsLeft = 10) {
  server.once('error', (/** @type {NodeJS.ErrnoException} */ err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (attemptsLeft <= 0) {
      console.error(`\n  Ports ${PORT}-${port} are all in use. Pick one yourself:\n\n    QA_PORT=9001 npm run qa\n`);
      process.exit(1);
    }
    console.log(`  port ${port} is busy (an old QA server?) — trying ${port + 1}`);
    listen(port + 1, attemptsLeft - 1);
  });
  // No callback here on purpose: a callback passed to listen() stays
  // registered as a 'listening' listener even when that attempt fails, so
  // retrying would print one banner per attempt — the first showing a port
  // that is not the one we ended up on. Announce once, from the bound address.
  server.listen(port, '127.0.0.1');
}

server.once('listening', () => {
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  console.log(`
  Manual QA server up.

  1. Start Raha FROM SOURCE in another terminal. A packaged app in
     /Applications is only as new as the day it was built, so it will NOT
     have your latest changes:

       RAHA_PROFILE_DIR=/tmp/raha-qa npm start

  2. In Raha's address bar, type:

       127.0.0.1:${addr.port}

  3. Work down the page. Ctrl+C here when you're done.
`);
});

listen(PORT);
