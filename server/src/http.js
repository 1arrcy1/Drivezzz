// A small router on node:http, without packages. Handlers get (req, res-free context) and return JSON.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { now } from './db.js';

export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Exact paths in a table, so the busiest calls don't try every pattern first.
const exactRoutes = new Map();
const routes = [];
export function route(method, pattern, handler) {
  if (!pattern.includes(':')) { exactRoutes.set(`${method} ${pattern}`, { names: [], handler }); return; }
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
  routes.push({ method, regex, names, handler });
}
function findRoute(method, pathname) {
  const exact = exactRoutes.get(`${method} ${pathname}`);
  if (exact) return { route: exact, match: [] };
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = pathname.match(r.regex);
    if (match) return { route: r, match };
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

export function serveFile(res, file, { cache = 'no-cache', headers = {} } = {}) {
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', ...headers });
  fs.createReadStream(file).pipe(res);
}

// The website is English, and Dutch for visitors from the Netherlands (Cloudflare's CF-IPCountry), with no switch: Pieter, 10 November
// 2026. ?lang=nl or ?lang=en shows the other one, for a link or a look.
export function siteLanguage(req, query) {
  const asked = query.get('lang');
  if (asked === 'nl' || asked === 'en') return asked;
  return req.headers['cf-ipcountry'] === 'NL' ? 'nl' : 'en';
}

const isFile = (file) => fs.existsSync(file) && fs.statSync(file).isFile();

// Static folders: [urlPrefix, folder, { dutch }]. Never leaves its folder. With `dutch`, a page that has a Dutch twin in the folder's
// nl/ is served in Dutch to who gets the site in Dutch, at the same address; one without a twin stays English.
function tryStatic(req, res, pathname, query, folders) {
  for (const [prefix, folder, { dutch = false } = {}] of folders) {
    if (pathname !== prefix && !pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) continue;
    let rel = pathname.slice(prefix.length).replace(/^\/+/, '') || 'index.html';
    if (!path.extname(rel)) rel = rel.endsWith('/') ? `${rel}index.html` : `${rel}.html`;
    const file = path.resolve(folder, rel);
    if (!file.startsWith(path.resolve(folder) + path.sep)) continue;
    if (!isFile(file)) continue;
    if (!dutch || path.extname(file) !== '.html' || rel.startsWith('nl/')) { serveFile(res, file); return true; }
    const lang = siteLanguage(req, query);
    const twin = path.resolve(folder, 'nl', rel);
    const nl = lang === 'nl' && isFile(twin);
    serveFile(res, nl ? twin : file, { headers: { 'Content-Language': nl ? 'nl' : 'en', Vary: 'CF-IPCountry' } });
    return true;
  }
  return false;
}

const MAX_JSON = 256 * 1024;
const MAX_UPLOAD = 8 * 1024 * 1024;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ApiError(413, 'too_large', 'That is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

// Attempts per key in a window. Returns false when over.
const buckets = new Map();
export function limit(key, max, windowMs) {
  if (config.dev) return true;
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || t - b.start > windowMs) { buckets.set(key, { start: t, n: 1 }); return true; }
  b.n++;
  return b.n <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.start > 3600_000) buckets.delete(k); }, 600_000).unref();

// lastResort(req, res, pathname): for a GET or HEAD that no route or file had, true when it answered (links.js).
export function handler(staticFolders, lastResort) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      // Per account, as a whole mobile network can share one address: per address only well above what a phone does.
      if (pathname.startsWith('/api/')) {
        const signedIn = req.headers.authorization;
        if (!limit(`ip:${clientIp(req)}`, signedIn ? 30_000 : 600, 60_000) || (signedIn && !limit(`who:${signedIn}`, 600, 60_000))) throw new ApiError(429, 'too_many', 'Too many requests. Wait a moment.');
      }
      const found = findRoute(req.method, pathname);
      if (found) {
        const { route: r, match: m } = found;
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const ctx = { req, res, params, query: url.searchParams, body: {}, raw: null, setHeader: (k, v) => res.setHeader(k, v) };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const type = req.headers['content-type'] ?? '';
          if (type.startsWith('image/')) {
            ctx.raw = await readBody(req, MAX_UPLOAD);
          } else {
            const buf = await readBody(req, MAX_JSON);
            if (buf.length) {
              try { ctx.body = JSON.parse(buf.toString('utf8')); } catch { throw new ApiError(400, 'bad_json', 'That request could not be read.'); }
              if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new ApiError(400, 'bad_json', 'That request could not be read.');
            }
          }
        }
        const out = await r.handler(ctx);
        if (res.writableEnded || res.headersSent) return;
        const json = JSON.stringify(out ?? { ok: true });
        // The server's time, so the app counts down right on a phone whose clock is a little off.
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Now': String(now()) });
        res.end(json);
        return;
      }
      if (pathname.startsWith('/api/')) throw new ApiError(404, 'not_found', 'Not found.');
      if ((req.method === 'GET' || req.method === 'HEAD') && (tryStatic(req, res, pathname, url.searchParams, staticFolders) || lastResort?.(req, res, pathname))) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const status = e instanceof ApiError ? e.status : 500;
      if (status === 500) console.error(`[drivezzz] ${req.method} ${pathname}:`, e);
      const body = { error: status === 500 ? 'Something went wrong. Try again.' : e.message, code: e.code ?? 'server_error', ...(e.extra ?? {}) };
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    }
  };
}

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const text = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
export { MAX_UPLOAD };
