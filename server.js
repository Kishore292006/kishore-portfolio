'use strict';
/**
 * Zero-dependency static server for the portfolio page.
 *  - explicit allowlist (index.html, the resume PDF, optional assets/ and public/)
 *  - gzip/brotli, ETag/304, security headers
 *  - persisted resume download counter (data/stats.json)
 * Node >= 18.17, built-in modules only.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');

// ---------------------------------------------------------------- config
const ROOT = __dirname;
const PORT = Number.parseInt(process.env.PORT, 10) || 4200;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const PDF_NAME = 'Mattapalli_Kishore_Resume.pdf';
const PDF_ROUTE = '/' + PDF_NAME;
const ASSET_DIRS = ['assets', 'public']; // served under /assets/* and /public/* if they exist
const MAX_CACHED_BYTES = 2 * 1024 * 1024; // compress-and-cache ceiling for text files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt']);

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// ---------------------------------------------------------------- logging
const clean = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const logErr = (...a) => console.error(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- download counter
const stats = (() => {
  let state = { resumeDownloads: 0, since: new Date().toISOString() };
  let dirty = false;
  let writing = null;

  // Load synchronously at startup; tolerate missing / corrupted / odd shapes.
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    const n = parsed && parsed.resumeDownloads;
    if (Number.isSafeInteger(n) && n >= 0) state.resumeDownloads = n;
    else throw new Error('invalid resumeDownloads');
    if (typeof parsed.since === 'string' && !Number.isNaN(Date.parse(parsed.since))) state.since = parsed.since;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logErr('stats: could not read stats.json, starting fresh (' + clean(err.message) + ')');
      try { fs.copyFileSync(STATS_FILE, STATS_FILE + '.corrupt'); } catch { /* best effort */ }
    }
  }

  async function drain() {
    try {
      while (dirty) {
        dirty = false;
        const payload = JSON.stringify(state) + '\n';
        await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
        const tmp = `${STATS_FILE}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, payload, { mode: 0o600 });
        await fsp.rename(tmp, STATS_FILE); // atomic replace
      }
    } catch (err) {
      dirty = true; // retry on the next increment / flush
      logErr('stats: write failed (' + clean(err.message) + ')');
    } finally {
      writing = null;
    }
  }

  function flush() {
    if (dirty && !writing) writing = drain();
    return writing || Promise.resolve();
  }

  return {
    get snapshot() { return { resumeDownloads: state.resumeDownloads, since: state.since }; },
    increment() { state.resumeDownloads += 1; dirty = true; return flush(); }, // in-memory bump is synchronous => no lost counts
    flush,
  };
})();

// ---------------------------------------------------------------- response helpers
function sendBuffer(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { ...headers, 'Content-Length': buf.length });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendJson(req, res, status, obj, extra = {}) {
  sendBuffer(req, res, status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...extra }, JSON.stringify(obj));
}

function page(title, heading, message, linkText = 'Back to the homepage') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>
html,body{height:100%;margin:0}
body{background:#000;color:#cfd8e3;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;text-align:center;padding:24px}
h1{margin:0;font-size:clamp(72px,18vw,160px);line-height:1;color:#2f81ff;letter-spacing:-.04em}
h2{margin:.2em 0 .3em;font-weight:600;color:#fff;font-size:22px}
p{margin:0 0 1.6em;color:#8b98a9}
a{display:inline-block;color:#fff;background:#2f81ff;padding:.65em 1.4em;border-radius:999px;text-decoration:none;font-weight:600}
a:hover,a:focus-visible{background:#5a9bff;outline:none}
</style></head><body><main>
<h1>${heading}</h1><h2>${title}</h2><p>${message}</p><a href="/">${linkText}</a>
</main></body></html>`;
}

const NO_STORE_HTML = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' };
const notFound = (req, res) => sendBuffer(req, res, 404, NO_STORE_HTML, page('Page not found', '404', 'That page does not exist or has moved.'));
const badRequest = (req, res) => sendBuffer(req, res, 400, NO_STORE_HTML, page('Bad request', '400', 'The request could not be understood.'));
const serverError = (req, res) => sendBuffer(req, res, 500, NO_STORE_HTML, page('Something went wrong', '500', 'An unexpected error occurred. Please try again shortly.'));
const methodNotAllowed = (req, res) =>
  sendBuffer(req, res, 405, { ...NO_STORE_HTML, Allow: 'GET, HEAD' }, page('Method not allowed', '405', 'Only GET and HEAD are supported.'));

// ---------------------------------------------------------------- path resolution (allowlist)
class BadPath extends Error {}

/** Decode + validate a raw request path. Returns decoded path or throws BadPath. */
function decodePath(raw) {
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw new BadPath('malformed escape'); }
  if (/[\x00-\x1f\x7f\\]/.test(decoded)) throw new BadPath('control char or backslash'); // also catches %00
  const segs = decoded.split('/');
  for (const s of segs.slice(1)) {
    if (s === '.' || s === '..') throw new BadPath('traversal');
  }
  return decoded;
}

/** Map a decoded path to { file, kind } or null (=> 404). Never returns anything outside the allowlist. */
async function resolveTarget(decoded) {
  if (decoded === '/' || decoded === '/index.html') return { file: path.join(ROOT, 'index.html'), kind: 'html' };
  if (decoded === PDF_ROUTE) return { file: path.join(ROOT, PDF_NAME), kind: 'pdf' };

  const segs = decoded.split('/').slice(1);
  if (segs.length < 2 || !ASSET_DIRS.includes(segs[0])) return null;
  if (segs.some((s) => s === '' || s.startsWith('.'))) return null; // no dotfiles, no empty segments
  if (!MIME[path.extname(segs[segs.length - 1]).toLowerCase()]) return null; // known types only

  const dirReal = await fsp.realpath(path.join(ROOT, segs[0])).catch(() => null);
  if (!dirReal) return null;
  const abs = path.join(dirReal, ...segs.slice(1));
  if (!abs.startsWith(dirReal + path.sep)) return null;
  const real = await fsp.realpath(abs).catch(() => null); // resolves symlinks; must stay inside the folder
  if (!real || !real.startsWith(dirReal + path.sep)) return null;
  return { file: real, kind: 'asset' };
}

// ---------------------------------------------------------------- compression cache + conditional requests
const cache = new Map(); // file -> { mtimeMs, size, raw, hash, gzip, br }

async function loadEntry(file, st) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = await fsp.readFile(file);
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    raw,
    hash: crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 27),
    gzip: zlib.gzipSync(raw, { level: 9 }),
    br: zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    }),
  };
  cache.set(file, entry);
  return entry;
}

/** Pick br / gzip / identity from Accept-Encoding, honouring q=0. */
function negotiate(header) {
  if (!header) return null;
  const q = {};
  for (const part of String(header).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    let v = 1;
    for (const p of params) { const m = /^\s*q\s*=\s*([\d.]+)/.exec(p); if (m) v = Number(m[1]); }
    q[name.trim()] = v;
  }
  const ok = (e) => (e in q ? q[e] > 0 : q['*'] > 0);
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === strip(etag));
}

// ---------------------------------------------------------------- file serving
async function serveFile(req, res, { file, kind }, query) {
  let st;
  try { st = await fsp.stat(file); } catch { return notFound(req, res); }
  if (!st.isFile()) return notFound(req, res);

  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': kind === 'html' ? 'no-cache' : 'public, max-age=86400',
  };

  if (kind === 'pdf') {
    const disposition = query.get('download') === '1' ? 'attachment' : 'inline';
    headers['Content-Disposition'] = `${disposition}; filename="${PDF_NAME}"`;
  }

  // Small text files: in-memory cache, pre-compressed variants.
  if (COMPRESSIBLE.has(ext) && st.size <= MAX_CACHED_BYTES) {
    const entry = await loadEntry(file, st);
    const enc = negotiate(req.headers['accept-encoding']);
    const etag = `"${entry.hash}${enc ? '-' + enc : ''}"`;
    const body = enc ? entry[enc] : entry.raw;
    headers.ETag = etag;
    headers.Vary = 'Accept-Encoding';
    if (enc) headers['Content-Encoding'] = enc;
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'], Vary: 'Accept-Encoding' });
      return res.end();
    }
    return sendBuffer(req, res, 200, headers, body);
  }

  // Binary / large files: stream from disk.
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  headers.ETag = etag;
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] });
    return res.end();
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  // Count only completed GET downloads of the resume (never HEAD, never 304).
  if (kind === 'pdf') res.once('finish', () => { stats.increment(); });

  pipeline(fs.createReadStream(file), res, (err) => {
    if (err && !res.destroyed) res.destroy();
  });
}

// ---------------------------------------------------------------- router
async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res);
  if (typeof req.url !== 'string' || req.url[0] !== '/') return badRequest(req, res);

  const qIndex = req.url.indexOf('?');
  const rawPath = qIndex === -1 ? req.url : req.url.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? '' : req.url.slice(qIndex + 1));

  let decoded;
  try { decoded = decodePath(rawPath); } catch { return badRequest(req, res); }

  if (decoded === '/api/health') return sendJson(req, res, 200, { status: 'ok', uptime: Math.round(process.uptime()) });
  if (decoded === '/api/stats') return sendJson(req, res, 200, stats.snapshot);

  const target = await resolveTarget(decoded);
  if (!target) return notFound(req, res);
  return serveFile(req, res, target, query);
}

const server = http.createServer((req, res) => {
  const start = process.hrtime.bigint();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  res.once('close', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const p = clean((req.url || '').split('?')[0]); // path only: no query, no IP, no user agent
    log(`${clean(req.method)} ${p} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });

  handle(req, res).catch((err) => {
    logErr('handler error:', err && err.stack ? err.stack : err); // server-side only
    if (res.headersSent) return res.destroy();
    for (const h of ['Content-Encoding', 'Content-Disposition', 'ETag', 'Vary']) res.removeHeader(h);
    serverError(req, res);
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  else socket.destroy();
});
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

// ---------------------------------------------------------------- lifecycle
let shuttingDown = false;
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down`);
  const force = setTimeout(() => { logErr('forced exit after timeout'); process.exit(1); }, 10_000);
  force.unref();
  server.close(); // stop accepting; in-flight requests finish
  server.closeIdleConnections?.();
  await new Promise((r) => (server.listening ? server.once('close', r) : r()));
  await stats.flush(); // finish in-flight counter writes
  process.exit(code);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logErr('unhandledRejection:', reason && reason.message ? reason.message : reason));
process.on('uncaughtException', (err) => {
  logErr('uncaughtException:', err && err.stack ? err.stack : err);
  shutdown('uncaughtException', 1);
});

server.on('error', (err) => { logErr('server error:', err.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  log(`portfolio server listening on http://${HOST}:${PORT}`);
});
