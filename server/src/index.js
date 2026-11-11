import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { handler, route } from './http.js';
import { DATA_DIR, db, now } from './db.js';
import { addEdge, removeEdge } from './fanout.js';
import './auth.js';
import './standing.js';
import './wallet.js';
import './drivers.js';
import { dropPretendPasses, fillPersonHashes, runChecks } from './checks.js';
import { expireOffers, forgetOldPoints, leavePretendChain, runMoney, runOffline, runPlanned, syncState, watchPayments } from './rides.js';
import './admin.js';
import { followLink } from './links.js';
import './safety.js';
import './messages.js';
import { placeBots, runDemo } from './demo.js';
import { setOnDemoLook } from './drivers.js';
import { checkSettings } from './escrow.js';
import { requireSignedIn, takeSeen, writeSeen } from './auth.js';
import { activeBan, standingFor } from './standing.js';
import { revOf, waitForChange } from './sync.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

route('GET', '/api/health', () => ({ ok: true, at: now() }));
setOnDemoLook(placeBots);
process.on('unhandledRejection', (e) => console.error('[drivezzz] unhandled:', e));

// The app's one way to hear about changes: answers at once when something changed since `rev`, otherwise after
// `wait` seconds with a few bytes. Keeps a driver's data use low.
route('GET', '/api/sync', async (ctx) => {
  const user = requireSignedIn(ctx);
  const rev = Number(ctx.query.get('rev')) || 0;
  const wait = Math.min(55, Math.max(0, Number(ctx.query.get('wait')) || 0));
  if (wait) await waitForChange(user.id, rev, wait * 1000, ctx.req);
  const current = revOf(user.id);
  ctx.setHeader('X-Rev', String(current));
  if (current === rev) return { rev, same: true };
  const standing = standingFor(user.id, user.deviceId);
  if (activeBan(user.id, user.deviceId)) return { rev: current, banned: true, standing };
  return { rev: current, strikes: standing.strikes, ...syncState(user) };
});

if (config.dev) await import('./dev.js');
dropPretendPasses();
leavePretendChain();
fillPersonHashes();

const server = http.createServer(handler([['/admin', path.join(root, 'admin')], ['/', path.join(root, 'public'), { dutch: true }]], followLink));
server.keepAliveTimeout = 65_000;
server.requestTimeout = 120_000;
// WORKERS helper processes (edge.js) answer what only reads and pass the rest on: this process then listens to them alone.
const WORKERS = Math.max(0, Number(process.env.WORKERS) || 0);
const helpers = new Set();
const SOCKET = path.join(DATA_DIR, 'main.sock');
function startHelper(onReady) {
  const helper = fork(path.join(root, 'src', 'edge.js'), { env: { ...process.env, DRIVEZZZ_ROLE: 'edge', MAIN_SOCKET: SOCKET } });
  helpers.add(helper);
  addEdge(helper);
  helper.on('message', (m) => {
    if (m.ready) onReady?.();
    if (m.seen) takeSeen(m.seen);
  });
  helper.on('exit', () => {
    helpers.delete(helper);
    removeEdge(helper);
    if (!closing) { console.error('[drivezzz] a helper stopped: starting another'); setTimeout(startHelper, 1000); }
  });
}
if (WORKERS) fs.rmSync(SOCKET, { force: true });
server.listen(...(WORKERS ? [SOCKET] : [config.port, config.host]), () => {
  let waiting = WORKERS;
  const ready = () => console.log(`[drivezzz] Listening on http://${config.host}:${config.port}${WORKERS ? `, with ${WORKERS} helpers` : ''}${config.dev ? ' (DEV)' : ''}`);
  if (!WORKERS) { ready(); return; }
  for (let i = 0; i < WORKERS; i++) startHelper(() => { waiting -= 1; if (!waiting) ready(); });
});

const jobs = [];
const every = (ms, name, fn) => {
  let busy = false;
  jobs.push(setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(`[drivezzz] ${name}:`, e); } finally { busy = false; }
  }, ms));
};
if (config.jobs) {
  checkSettings().then((problem) => problem && console.error(`[drivezzz] escrow: ${problem}`)).catch((e) => console.error('[drivezzz] escrow:', e.message));
  every(3000, 'offers', () => expireOffers());
  every(20_000, 'online', () => runOffline());
  every(30_000, 'planned', runPlanned);
  every(5000, 'payments', watchPayments);
  every(20_000, 'money', runMoney);
  every(3000, 'demo', runDemo);
  every(3600_000, 'checks', runChecks);
  every(6 * 3600_000, 'old points', () => forgetOldPoints());
  every(6 * 3600_000, 'query plans', () => db.exec('PRAGMA optimize'));
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    jobs.forEach(clearInterval);
    for (const helper of helpers) helper.kill();
    writeSeen();
    server.close();
    server.closeAllConnections();
    db.close();
    process.exit(0);
  });
}
