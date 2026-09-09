/**
 * A tiny static file server for dist/.
 *
 * Node rather than `python3 -m http.server` so the same command works on macOS,
 * where python3 is only present if the Xcode command line tools are installed.
 *
 *   node scripts/serve.mjs [--port 8899]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist');
const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(portArg !== -1 ? argv[portArg + 1] : process.env.PORT || 8899);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = url === '/' ? '/harness.html' : url;
  const file = path.join(root, path.normalize(rel));

  // Refuse anything that escapes dist/.
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use — a server is probably already running.\n`
      + `Just open http://localhost:${PORT}/harness.html`,
    );
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`\n  harness   http://localhost:${PORT}/harness.html`);
  console.log(`  demo      http://localhost:${PORT}/demo.html\n`);
});
