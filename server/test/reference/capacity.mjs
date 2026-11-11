// What the server can take, on the machine it runs on: what each kind of request costs in CPU, what a phone waiting for news costs in
// memory, and how a real mix holds up. Not a test to pass but numbers to read. It starts its own server on a fresh database.
//   node --disable-warning=ExperimentalWarning test/reference/capacity.mjs [drivers 3000] [riders 5000] [waiting phones 20000] [mix users 0]
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers.js';

const [DRIVERS = 3000, RIDERS = 5000, WAITING = 20000, MIX = 0] = process.argv.slice(2).map(Number);
const HISTORY = 20;
const AT = { lat: 52.11, lng: 4.355 };
// CAPACITY_SERVE=seconds: only seed and serve on the network, for a load generator on another machine, and report how busy it is.
const SERVE = Number(process.env.CAPACITY_SERVE) || 0;
const srv = await startServer({ SHARED_LOOK_MS: process.env.SHARED_LOOK_MS ?? '15000', DRIVERS_SNAPSHOT_MS: process.env.DRIVERS_SNAPSHOT_MS ?? '2500', ...(SERVE ? { HOST: '0.0.0.0', PORT: '8095' } : {}), ...(SERVE || process.env.NO_ROADS ? { OSRM_URL: '' } : {}) });
const url = new URL(srv.base);
const spot = (range = 0.25) => { const a = Math.random() * range, b = Math.random() * 2 * Math.PI; return { lat: AT.lat + a * Math.sin(b), lng: AT.lng + a * 1.6 * Math.cos(b) }; };

// ---------- people ----------
const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'), { enableForeignKeyConstraints: false });
const t0 = Date.now();
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const user = db.prepare('INSERT INTO users (id, name, is_driver, lat, lng, loc_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const session = db.prepare('INSERT INTO sessions (token_hash, user_id, device_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)');
const drv = db.prepare(`INSERT INTO drivers (user_id, per_km_cents, per_min_cents, pickup_per_km_cents, active_car_id, online_since, heartbeat_at, last_online_at, lat, lng, loc_at, created_at)
                        VALUES (?, ?, 20, 50, ?, ?, ?, ?, ?, ?, ?, ?)`);
const car = db.prepare(`INSERT INTO cars (id, user_id, plate, make, model, seats, per_km_cents, per_min_cents, pickup_per_km_cents, created_at) VALUES (?, ?, ?, 'Toyota', 'Prius', 4, ?, 20, 50, ?)`);
const photo = db.prepare('INSERT INTO car_photos (id, car_id, kind, file, created_at) VALUES (?, ?, ?, ?, ?)');
const wallet = db.prepare('INSERT INTO wallets (user_id, coin, address, updated_at) VALUES (?, ?, ?, ?)');
const review = db.prepare('INSERT INTO reviews (ride_id, rider_id, driver_id, stars, created_at) VALUES (?, ?, ?, ?, ?)');
const ride = db.prepare(`INSERT INTO rides (id, rider_id, driver_id, status, mode, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_m, duration_s, max_cents, coin, coin_units, eur_per_coin, arrived_at, pickup_deadline_at, created_at)
                         VALUES (?, 'nobody', ?, ?, 'driver', 0, 0, 0, 0, 1, 1, 1, 'sol', 1, 1, ?, ?, ?)`);
const people = { rider: [], driver: [] };
db.exec('BEGIN');
for (let i = 0; i < DRIVERS; i++) {
  const id = `dz-d${i}`, carId = `car-${i}`, p = spot(), perKm = 50 + Math.floor(Math.random() * 150);
  user.run(id, `Driver ${i}`, 1, p.lat, p.lng, t0, t0, t0);
  session.run(hash(`tok-${id}`), id, `device-${id}`, t0, t0);
  drv.run(id, perKm, carId, t0, t0, t0, p.lat, p.lng, t0, t0);
  car.run(carId, id, `DZ${i}`, perKm, t0);
  for (const kind of ['front', 'back', 'inside']) photo.run(`${carId}-${kind}`, carId, kind, 'none.jpg', t0);
  wallet.run(id, 'sol', `wallet${i}`, t0);
  for (let n = 0; n < HISTORY; n++) {
    ride.run(`r-${i}-${n}`, id, 'completed', t0, t0 + (Math.random() < 0.9 ? 1000 : -1000), t0);
    if (n % 2) review.run(`r-${i}-${n}`, 'nobody', id, 1 + Math.floor(Math.random() * 5), t0);
  }
  people.driver.push({ id, token: `tok-${id}`, device: `device-${id}`, ...p });
}
for (let i = 0; i < RIDERS; i++) {
  const id = `dz-r${i}`, p = spot();
  user.run(id, `Rider ${i}`, 0, p.lat, p.lng, t0, t0, t0);
  session.run(hash(`tok-${id}`), id, `device-${id}`, t0, t0);
  people.rider.push({ id, token: `tok-${id}`, device: `device-${id}`, ...p });
}
// Some of them on a ride together.
const onRide = db.prepare(`INSERT INTO rides (id, rider_id, driver_id, car_id, status, mode, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_m, duration_s, max_cents, coin, coin_units, eur_per_coin, checked_in_at, created_at)
                           VALUES (?, ?, ?, ?, 'riding', 'driver', ?, ?, ?, ?, 5000, 600, 500, 'sol', 1, 1, ?, ?)`);
people.onRide = [];
for (let i = 0; i < Math.min(DRIVERS, RIDERS) * 0.2; i++) {
  const d = people.driver[i], r = people.rider[i];
  onRide.run(`ride-${i}`, r.id, d.id, `car-${i}`, d.lat, d.lng, d.lat + 0.04, d.lng + 0.02, t0, t0);
  people.onRide.push(d, r);
}
const free = { rider: people.rider.slice(people.onRide.length / 2), driver: people.driver.slice(people.onRide.length / 2) };
people.rider = free.rider;
people.driver = free.driver;
db.exec('COMMIT');
db.close();
console.log(`${DRIVERS} drivers online within about 30 km, ${RIDERS} riders, seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s. ${navigatorCores()} cores here.`);
function navigatorCores() { return fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^processor/gm).length; }

// ---------- measuring ----------
const clockTick = 100;
// The server and its helpers, if any.
const family = () => [srv.pid, ...fs.readFileSync(`/proc/${srv.pid}/task/${srv.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)];
const cpuOf = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return ((Number(f[11]) + Number(f[12])) * 1000) / clockTick; } catch { return 0; } };
function cpuMs() { return family().reduce((sum, pid) => sum + cpuOf(pid), 0); }
const rssMb = () => family().reduce((sum, pid) => sum + Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024, 0);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

function call(agent, who, method, target, body, localAddress) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const from = performance.now();
    const req = http.request({ host: url.hostname, port: url.port, method, path: target, agent, localAddress, headers: {
      authorization: `Bearer ${who.token}`, 'x-device-id': who.device, 'accept-encoding': 'gzip',
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, bytes, ms: performance.now() - from }));
    });
    req.on('error', (e) => resolve({ ok: false, status: e.code, bytes: 0, ms: performance.now() - from }));
    if (data) req.write(data);
    req.end();
  });
}
const random = (list) => list[Math.floor(Math.random() * list.length)];
const nearby = (p, extra = '') => `/api/drivers/nearby?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}&radiusKm=10${extra}`;
const quote = () => { const p = spot(0.2); return { pickup: { ...p, label: 'Here' }, dropoff: { lat: p.lat + 0.03, lng: p.lng + 0.01, label: 'There' }, passengers: 1, pets: false, coin: 'sol' }; };

const kinds = {
  'news, nothing new': () => ['GET', '/api/sync?rev=1', null, random(people.rider)],
  'look at the map': () => { const w = random(people.rider); return ['GET', nearby(w), null, w]; },
  'look, best rated': () => { const w = random(people.rider); return ['GET', nearby(w, '&sort=stars'), null, w]; },
  'position, rider moved': () => { const w = random(people.rider); w.lat += 0.0005; return ['POST', '/api/location', { lat: w.lat, lng: w.lng }, w]; },
  'position, rider still': () => { const w = random(people.rider); return ['POST', '/api/location', { lat: w.lat, lng: w.lng }, w]; },
  'position, driver moved': () => { const w = random(people.driver); w.lat += 0.0005; return ['POST', '/api/location', { lat: w.lat, lng: w.lng, driving: true, speed: 8 }, w]; },
  'position, driver still': () => { const w = random(people.driver); return ['POST', '/api/location', { lat: w.lat, lng: w.lng, driving: true, speed: 0 }, w]; },
  'driver: orders': () => { const w = random(people.driver); return ['GET', `/api/driver/market?lat=${w.lat}&lng=${w.lng}&radiusKm=10`, null, w]; },
  'driver: home': () => ['GET', '/api/driver/home?tzMinutes=60', null, random(people.driver)],
  'a quote': () => ['POST', '/api/quote', quote(), random(people.rider)],
  'position, on a ride': () => { const w = random(people.onRide); w.lat += 0.0005; return ['POST', '/api/location', { lat: w.lat, lng: w.lng, speed: 8 }, w]; },
  'news, something new': () => ['GET', '/api/sync?rev=0', null, random(people.onRide)],
};

async function single(name, seconds = 6, parallel = 8) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: parallel });
  const until = Date.now() + seconds * 1000;
  const took = [];
  let bytes = 0, bad = 0;
  const cpuFrom = cpuMs(), from = Date.now();
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (Date.now() < until) {
      const [method, target, body, who] = kinds[name]();
      const r = await call(agent, who, method, target, body);
      took.push(r.ms);
      bytes += r.bytes;
      if (!r.ok) bad++;
    }
  }));
  const used = cpuMs() - cpuFrom, spent = (Date.now() - from) / 1000;
  agent.destroy();
  took.sort((a, b) => a - b);
  console.log(`${name.padEnd(24)} ${String(Math.round(took.length / spent)).padStart(6)} /s   ${(used / took.length).toFixed(2).padStart(6)} ms CPU each   middle ${pct(took, 0.5).toFixed(1).padStart(6)} ms   95% ${pct(took, 0.95).toFixed(1).padStart(6)} ms   ${(bytes / took.length / 1024).toFixed(1).padStart(5)} KB each${bad ? `   ${bad} FAILED` : ''}`);
  return { name, cpu: used / took.length, kb: bytes / took.length / 1024, perSecond: took.length / spent };
}

if (SERVE) {
  console.log('ready');
  let before = new Map(family().map((pid) => [pid, cpuOf(pid)])), at = Date.now();
  setInterval(() => {
    const t = Date.now();
    const each = family().map((pid) => { const c = cpuOf(pid), used = ((c - (before.get(pid) ?? c)) / (t - at)) * 100; before.set(pid, c); return used; });
    at = t;
    console.log(`${new Date().toISOString().slice(11, 19)}  busy ${each.reduce((a, b) => a + b, 0).toFixed(0).padStart(4)}% of one core   ${each.map((u) => `${u.toFixed(0)}%`).join(' + ').padEnd(20)}  memory ${rssMb().toFixed(0)} MB   sockets ${fs.readFileSync('/proc/net/sockstat', 'utf8').match(/TCP: inuse (\d+)/)[1]}`);
  }, 5000);
  await new Promise((r) => setTimeout(r, SERVE * 1000));
  srv.stop();
  process.exit(0);
}

console.log('\nOne kind at a time, as fast as it goes:');
const results = {};
for (const name of Object.keys(kinds)) { if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) continue; const r = await single(name, name === 'a quote' ? 4 : 6); results[name] = r; }

// ---------- phones waiting for news ----------
const addresses = (i) => `127.0.${1 + Math.floor(i / 20000)}.${1 + (i % 250)}`;
let holding = [];
if (WAITING) {
  console.log(`\nPhones waiting for news: ${WAITING}`);
  const rssFrom = rssMb(), cpuFrom = cpuMs(), from = Date.now();
  const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
  let failed = 0, open = 0;
  const everyone = [...people.rider, ...people.driver];
  const hold = (i) => call(agent, everyone[i % everyone.length], 'GET', '/api/sync?rev=1&wait=55', null, addresses(i)).then((r) => { if (!r.ok) failed++; open--; });
  const memoryLeft = () => Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1]) / 1024;
  let opened = 0;
  for (let i = 0; i < WAITING; i++) {
    // The live service runs on this machine too: stop well before it gets tight.
    if (i % 1000 === 0 && memoryLeft() < 1200) { console.log(`stopped at ${i} phones: ${memoryLeft().toFixed(0)} MB of memory left`); break; }
    opened++;
    open++;
    holding.push(hold(i));
    if (i % 200 === 199) await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 3000));
  const rss = rssMb();
  console.log(`${opened} opened in ${((Date.now() - from) / 1000).toFixed(0)} s, ${failed} failed. Server memory ${rssFrom.toFixed(0)} -> ${rss.toFixed(0)} MB: ${(((rss - rssFrom) * 1024) / opened).toFixed(1)} KB a phone, ${(((cpuMs() - cpuFrom) / opened)).toFixed(2)} ms CPU to open each`);
  const check = await single('news, nothing new', 4);
  console.log(`with them all waiting, other requests still answer: ${Math.round(check.perSecond)} a second`);
}

// ---------- a real mix ----------
async function mix(users, seconds = 30) {
  // A guess at what they do. A twentieth is on a ride, sending a position every 15 s, which gets the rider new news. Half of all look at the
  // map, every 30 s. A tenth drives: a position every minute, orders every 30 s, their earnings every 2 minutes. The rest send one every 5
  // minutes, and everyone asks for news every 50 s and for a quote every 10 minutes.
  const rate = {
    'news, nothing new': users / 50, 'news, something new': (users * 0.025) / 15, 'look at the map': (users * 0.5) / 30,
    'position, on a ride': (users * 0.05) / 15, 'position, rider still': (users * 0.85) / 300, 'position, driver still': (users * 0.1) / 60,
    'driver: orders': (users * 0.1) / 30, 'driver: home': (users * 0.1) / 120, 'a quote': users / 600,
  };
  const planned = Object.values(rate).reduce((a, b) => a + b, 0);
  console.log(`\nA mix like ${users} phones: ${Math.round(planned)} requests a second, for ${seconds} s`);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 500 });
  const took = {}, bad = {};
  const cpuFrom = cpuMs(), from = Date.now();
  const jobs = [];
  for (const [name, perSecond] of Object.entries(rate)) {
    took[name] = [];
    bad[name] = 0;
    let due = 0;
    const timer = setInterval(() => {
      due += perSecond / 100;
      while (due >= 1) {
        due--;
        const [method, target, body, who] = kinds[name]();
        jobs.push(call(agent, who, method, target, body).then((r) => { took[name].push(r.ms); if (!r.ok) bad[name]++; }));
      }
    }, 10);
    setTimeout(() => clearInterval(timer), seconds * 1000);
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await Promise.all(jobs);
  const busy = ((cpuMs() - cpuFrom) / (Date.now() - from)) * 100;
  for (const name of Object.keys(rate)) {
    const list = took[name].sort((a, b) => a - b);
    console.log(`${name.padEnd(24)} ${String(list.length).padStart(7)} sent   middle ${pct(list, 0.5).toFixed(1).padStart(7)} ms   95% ${pct(list, 0.95).toFixed(1).padStart(7)} ms   99% ${pct(list, 0.99).toFixed(1).padStart(7)} ms${bad[name] ? `   ${bad[name]} FAILED` : ''}`);
  }
  const each = family().map((pid) => `${(cpuOf(pid) / 1000).toFixed(0)}s`).join(' + ');
  console.log(`server busy ${busy.toFixed(0)}% of one core in all (CPU so far: ${each}), memory ${rssMb().toFixed(0)} MB`);
  agent.destroy();
}
if (MIX) await mix(MIX);

srv.stop();
process.exit(0);
