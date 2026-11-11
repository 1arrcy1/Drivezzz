// Starts a real server process on a fresh database, with pretend road and price servers and a pretend chain for the
// escrow (ESCROW_FAKE): a payment counts at the next look. The contract itself is tested on devnet (contract/test).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function fakeRoads() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const pts = decodeURIComponent(url.pathname.split('/').pop()).split(';').map((p) => p.split(',').map(Number));
    const dist = (a, b) => Math.hypot((a[0] - b[0]) * 67000, (a[1] - b[1]) * 111000);
    let out = { code: 'Ok' };
    if (url.pathname.startsWith('/nearest')) {
      // The road runs along latitude 52.37 unless asked further than 2 km from it.
      const [lng, lat] = pts[0];
      const onRoad = Math.abs(lat - 52.37) < 0.02 ? [lng, 52.37] : [lng, lat];
      out.waypoints = [{ location: onRoad, name: 'Teststraat' }];
    } else if (url.pathname.startsWith('/route')) {
      const d = dist(pts[0], pts[1]);
      out.routes = [{ distance: d, duration: d / 10, geometry: encode([[pts[0][1], pts[0][0]], [pts[1][1], pts[1][0]]]) }];
    } else if (url.pathname.startsWith('/table')) {
      const to = pts.at(-1);
      out.distances = pts.slice(0, -1).map((p) => [dist(p, to)]);
      out.durations = pts.slice(0, -1).map((p) => [dist(p, to) / 10]);
    } else out = { code: 'Nope' };
    res.end(JSON.stringify(out));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
function encode(points) {
  let out = '', pLat = 0, pLng = 0;
  const put = (v) => { let n = v < 0 ? ~(v << 1) : v << 1; while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; } out += String.fromCharCode(n + 63); };
  for (const [lat, lng] of points) { const a = Math.round(lat * 1e5), b = Math.round(lng * 1e5); put(a - pLat); put(b - pLng); pLat = a; pLng = b; }
  return out;
}

// Kraken's ticker with fixed prices.
export function fakePrices() {
  const server = http.createServer((req, res) => {
    const t = (v) => ({ c: [String(v)] });
    res.end(JSON.stringify({ result: { SOLEUR: t(100), USDCEUR: t(1) } }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

export async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-test-'));
  const roads = await fakeRoads();
  const prices = await fakePrices();
  const port = 20000 + crypto.randomInt(20000);
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), PORT: String(port), HOST: '127.0.0.1', DEV: '1', JOBS: '0', OSRM_URL: roads.url, RDW_URL: '', CRYPTO_PRICE_URL: prices.url, ESCROW_FAKE: '1', NL_CHECKS: '0', ONLY_NETHERLANDS: '0', ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin', ...extraEnv };
  const makeAdmin = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/make-admin.js'], { cwd: root, env, stdio: 'ignore' });
  await new Promise((r) => makeAdmin.on('exit', r));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('Listening')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base, dir, pid: child.pid,
    stop() { child.kill(); roads.server.close(); prices.server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export function client(base, deviceId = `device-${crypto.randomBytes(6).toString('hex')}`) {
  let token = null, cookie = null;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { text }; }
    return { status: r.status, ...json };
  };
  return {
    deviceId, call,
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p, b = {}) => call('DELETE', p, b),
    setToken: (t) => { token = t; },
    async upload(p, bytes, headers = {}) {
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Device-Id': deviceId, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: bytes });
      return { status: r.status, ...(await r.json().catch(() => ({}))) };
    },
    async start() { const r = await call('POST', '/api/auth/continue', { deviceId }); token = r.token; this.id = r.user.id; return r; },
  };
}
