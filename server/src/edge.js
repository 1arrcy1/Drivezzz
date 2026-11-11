// A helper process, one for each core there is to spare (WORKERS, see index.js). Node runs one process on one core, and most of what thousands of
// phones ask only reads: is there news, who's on the map, what orders are around. A helper answers those from its own read-only connection to
// the database, and passes everything else on to the main process, untouched. So all that changes something still happens in one place, one at a
// time, which is what keeps a ride from being claimed or paid twice.
import http from 'node:http';
import { config } from './config.js';
import { now, setClock } from './db.js';
import { currentUser, flushSeenTo } from './auth.js';
import { handler } from './http.js';
import { forgetDriverStats, forgetLooksOf } from './drivers.js';
import './rides.js';
import { learnRev, revOf, waitForChange } from './sync.js';

const SOCKET = process.env.MAIN_SOCKET;
const upstream = new http.Agent({ keepAlive: true, maxSockets: 256 });

function passOn(req, res, path = req.url, onHeaders) {
  const headers = { ...req.headers };
  if (!headers['cf-connecting-ip'] && !headers['x-forwarded-for']) headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  let done = false;
  const up = http.request({ socketPath: SOCKET, path, method: req.method, headers, agent: upstream }, (answer) => {
    onHeaders?.(answer.headers);
    res.writeHead(answer.statusCode, answer.headers);
    answer.on('end', () => { done = true; });
    answer.pipe(res);
  });
  up.on('error', () => {
    done = true;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Something went wrong. Try again.', code: 'server_error' }));
  });
  // A phone that went away: no need for the main process to go on waiting for it.
  res.on('close', () => { if (!done) up.destroy(); });
  req.pipe(up);
}

// Is there news? The usual answer is no, after a wait. Only when there is does the main process get to put it together.
async function news(req, res, url) {
  const user = currentUser(req);
  if (!user) return passOn(req, res);
  const learn = (headers) => { const rev = Number(headers['x-rev']); if (rev) learnRev(user.id, rev); };
  const rev = Number(url.searchParams.get('rev')) || 0;
  if (rev !== revOf(user.id)) return passOn(req, res, req.url, learn);
  const wait = Math.min(55, Math.max(0, Number(url.searchParams.get('wait')) || 0));
  if (wait) await waitForChange(user.id, rev, wait * 1000, req);
  if (res.destroyed || res.writableEnded) return undefined;
  if (revOf(user.id) !== rev) return passOn(req, res, `/api/sync?rev=${rev}`, learn);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Now': String(now()) });
  res.end(JSON.stringify({ rev, same: true }));
  return undefined;
}

// What only reads, for anyone but the demo world, where looking moves its pretend drivers about.
const readOnly = new Set(['GET /api/drivers/nearby', 'GET /api/driver/market', 'GET /api/driver/home', 'POST /api/quote']);
const answerHere = handler([]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/sync') {
    news(req, res, url).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    return;
  }
  if (readOnly.has(`${req.method} ${url.pathname}`)) {
    const user = currentUser(req);
    if (user && !user.is_demo) { answerHere(req, res); return; }
  }
  passOn(req, res);
});
server.keepAliveTimeout = 65_000;
server.requestTimeout = 120_000;

process.on('message', (batch) => {
  for (const [kind, a, b] of batch) {
    if (kind === 'rev') learnRev(a, b);
    else if (kind === 'forget') forgetDriverStats(a);
    else if (kind === 'looks') forgetLooksOf(a, { tell: false });
    else if (kind === 'clock') setClock(a);
  }
});
// When someone was last seen is for the main process to write.
setInterval(() => { const seen = flushSeenTo(); if (seen) process.send({ seen }); }, 5000).unref();
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

server.listen({ port: config.port, host: config.host, reusePort: true }, () => process.send({ ready: true }));
