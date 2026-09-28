// Dependency-free static server for a built app directory.
// Sets COOP/COEP so SharedArrayBuffer works, and falls back to index.html
// for extensionless paths (SPA routing) — mounted apps under dist/<name>/
// fall back to their own index.html, everything else to the root's.
//
//   node scripts/serve-static.mjs <dir> <port>
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const [dir, portArg] = process.argv.slice(2);
const root = resolve(dir);
const port = Number(portArg);

if (!dir || !port || !existsSync(root)) {
  console.error(`serve-static: '${dir}' not found — build the app first`);
  process.exit(1);
}

// Origins allowed to embed these apps in an iframe: same origin (unified
// mounts) plus any localhost port (dev servers / docs).
const FRAME_ANCESTORS =
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*";

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // credentialless for the worker-islands demo: its map island hot-loads
    // no-cors OSM tile <img>s, which require-corp would block. Still grants
    // crossOriginIsolated (Chromium) so the SAB doorbell works.
    res.setHeader(
      'Cross-Origin-Embedder-Policy',
      // Segment match, not prefix — the docs mounts live at /sdk/<name>/ and
      // /consumer/<name>/ inside iframes, so the path arrives nested.
      pathname.split('/').includes('react-dom-worker') ? 'credentialless' : 'require-corp',
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Content-Security-Policy', FRAME_ANCESTORS);
    res.setHeader('Cache-Control', 'no-store');

    let file = normalize(join(root, pathname));
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const appDir = join(root, pathname.split('/').filter(Boolean)[0] ?? '');
      file = existsSync(join(appDir, 'index.html'))
        ? join(appDir, 'index.html')
        : join(root, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  })
  .on('error', (error) => {
    console.error(`serve-static: ${error.message} (${dir}:${port})`);
    process.exit(1);
  })
  .listen(port, () => {
    console.log(`serving ${dir} at http://localhost:${port}`);
  });
