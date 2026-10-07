// Local development server (npm run dev). NOT used on Vercel.
// Do not rename this to server.js, app.js or index.js: Vercel auto-detects
// those names as a Node server entrypoint and routes every request to it.
// Serves /public, maps the access-link routes to the two viewpoints,
// and runs the same /api handlers Vercel runs in production.
//   npm run dev   →   http://localhost:3000
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from './lib/env.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
loadEnv(ROOT);

const PUBLIC_DIR = resolve(ROOT, 'public');
const MAX_BODY = 4.5 * 1024 * 1024; // match Vercel's request body limit
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};
const SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

const ROUTES = [
  { pattern: /^\/api\/access\/?$/, file: 'api/access.js' },
  { pattern: /^\/api\/project\/?$/, file: 'api/project.js' },
  { pattern: /^\/api\/pointers\/?$/, file: 'api/pointers/index.js' },
  { pattern: /^\/api\/pointers\/([^/]+)\/?$/, file: 'api/pointers/[id].js', param: 'id' }
];
const handlers = new Map();
async function loadHandler(file) {
  if (!handlers.has(file)) handlers.set(file, (await import(pathToFileURL(join(ROOT, file)).href)).default);
  return handlers.get(file);
}

function readRequestBody(req) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

// Give handlers the same shape Vercel's Node runtime provides.
function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
  return res;
}

async function serveFile(res, file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('Not found');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    // API
    for (const route of ROUTES) {
      const m = path.match(route.pattern);
      if (!m) continue;
      decorate(res);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      req.query = Object.fromEntries(url.searchParams);
      if (route.param) req.query[route.param] = m[1];
      try {
        const raw = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readRequestBody(req) : '';
        if (raw && String(req.headers['content-type'] || '').includes('application/json')) {
          try { req.body = JSON.parse(raw); } catch { req.body = raw; }
        } else {
          req.body = raw || undefined;
        }
      } catch (e) {
        res.statusCode = e.status || 400;
        res.json({ success: false, error: { code: e.status === 413 ? 'TOO_LARGE' : 'BAD_REQUEST', message: e.status === 413 ? 'Request is too large.' : 'Could not read the request.' } });
        return;
      }
      return (await loadHandler(route.file))(req, res);
    }

    // Access-link routes → the two viewpoints (query string, and its token, is never logged).
    if (/^\/project\/[^/]+\/dev\/?$/.test(path)) return serveFile(res, join(PUBLIC_DIR, 'developer', 'index.html'));
    if (/^\/project\/[^/]+\/qa\/?$/.test(path)) return serveFile(res, join(PUBLIC_DIR, 'client', 'index.html'));

    // Static files, guarded against path traversal.
    let file = normalize(join(PUBLIC_DIR, path));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (path.endsWith('/')) file = join(file, 'index.html');
    return serveFile(res, file);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    const driver = process.env.DATA_DRIVER || (process.env.SUPABASE_URL ? 'supabase' : 'file');
    console.log(`Snippet Auditor running at http://localhost:${port}  (data: ${driver})`);
  });
}
