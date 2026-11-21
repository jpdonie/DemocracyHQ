#!/usr/bin/env node
/**
 * Serves the built site (dist/) under a sub-path, the way GitHub Pages serves a
 * project site at https://<owner>.github.io/<repo>/. Everything outside the
 * sub-path answers 404, so a stray absolute URL ("/assets/...", "/data/...")
 * fails loudly in the browser tests instead of working by accident.
 *
 *   node scripts/serve-subpath.mjs [--port 4173] [--prefix /democracyhq-preview/] [--dir dist]
 *
 * There is deliberately no fallback to index.html: routing uses the URL hash,
 * so deep links must work on a plain static file host.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option('port', '4173'));
let prefix = option('prefix', '/democracyhq-preview/');
if (!prefix.startsWith('/')) prefix = `/${prefix}`;
if (!prefix.endsWith('/')) prefix = `${prefix}/`;

const dist = resolve(option('dir', resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')));
if (!existsSync(join(dist, 'index.html'))) {
  console.error(`${join(dist, 'index.html')} not found. Run "npm run build" first.`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.pbf': 'application/x-protobuf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  const notFound = () => {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`404 Not Found: ${pathname}\n`);
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  if (pathname === prefix.slice(0, -1)) {
    response.writeHead(301, { location: prefix }).end();
    return;
  }
  if (!pathname.startsWith(prefix)) return notFound();
  const relative = pathname.slice(prefix.length) || 'index.html';
  let file = normalize(join(dist, relative));
  if (file !== dist && !file.startsWith(dist + sep)) return notFound();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) return notFound();
  response.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${dist} at http://127.0.0.1:${port}${prefix}`);
});
