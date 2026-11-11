// How a rider's look at the map holds up with many drivers online, on a fresh database. Not a test to pass but a number to read:
//   node --disable-warning=ExperimentalWarning test/reference/many-drivers.mjs [drivers, default 3000] [rides each, default 20]
// All the drivers sit within 30 km of one spot, with reviews, a history of rides and a tenth of them on a drive.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { client, startServer } from '../helpers.js';

const DRIVERS = Number(process.argv[2] ?? 3000);
const HISTORY = Number(process.argv[3] ?? 20);
const AT = { lat: 52.11, lng: 4.355 };
// SHARED_LOOK_MS=0 to measure without riders in one area sharing an answer.
const srv = await startServer({ SHARED_LOOK_MS: process.env.SHARED_LOOK_MS ?? '10000' });

const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'), { enableForeignKeyConstraints: false });
const t = Date.now();
const user = db.prepare('INSERT INTO users (id, name, is_driver, last_seen_at, created_at) VALUES (?, ?, 1, ?, ?)');
const drv = db.prepare(`INSERT INTO drivers (user_id, per_km_cents, per_min_cents, pickup_per_km_cents, active_car_id, online_since, heartbeat_at, last_online_at, lat, lng, loc_at, created_at)
                        VALUES (?, ?, 20, 50, ?, ?, ?, ?, ?, ?, ?, ?)`);
const car = db.prepare(`INSERT INTO cars (id, user_id, plate, make, model, seats, per_km_cents, per_min_cents, pickup_per_km_cents, created_at) VALUES (?, ?, ?, 'Toyota', 'Prius', 4, ?, 20, 50, ?)`);
const photo = db.prepare('INSERT INTO car_photos (id, car_id, kind, file, created_at) VALUES (?, ?, ?, ?, ?)');
const wallet = db.prepare('INSERT INTO wallets (user_id, coin, address, updated_at) VALUES (?, ?, ?, ?)');
const review = db.prepare('INSERT INTO reviews (ride_id, rider_id, driver_id, stars, created_at) VALUES (?, ?, ?, ?, ?)');
const ride = db.prepare(`INSERT INTO rides (id, rider_id, driver_id, status, mode, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_m, duration_s, max_cents, coin, coin_units, eur_per_coin, arrived_at, pickup_deadline_at, created_at)
                         VALUES (?, 'nobody', ?, ?, 'driver', 0, 0, 0, 0, 1, 1, 1, 'sol', 1, 1, ?, ?, ?)`);
db.exec('BEGIN');
for (let i = 0; i < DRIVERS; i++) {
  const id = `dz-${i}`, carId = `car-${i}`;
  const away = Math.random() * 0.25, turn = Math.random() * 2 * Math.PI;
  const perKm = 50 + Math.floor(Math.random() * 150);
  user.run(id, `Driver ${i}`, t, t);
  drv.run(id, perKm, carId, t, t, t, AT.lat + away * Math.sin(turn), AT.lng + away * 1.6 * Math.cos(turn), t, t);
  car.run(carId, id, `DZ${i}`, perKm, t);
  for (const kind of ['front', 'back', 'inside']) photo.run(`${carId}-${kind}`, carId, kind, 'none.jpg', t);
  wallet.run(id, 'sol', `wallet${i}`, t);
  for (let n = 0; n < HISTORY; n++) {
    ride.run(`r-${i}-${n}`, id, 'completed', t, t + (Math.random() < 0.9 ? 1000 : -1000), t);
    if (n % 2) review.run(`r-${i}-${n}`, 'nobody', id, 1 + Math.floor(Math.random() * 5), t);
  }
  if (i % 10 === 0) ride.run(`now-${i}`, id, 'accepted', null, null, t);
}
db.exec('COMMIT');
db.close();
console.log(`${DRIVERS} drivers online, each with ${HISTORY} rides behind them, seeded in ${Date.now() - t} ms`);

const rider = client(srv.base);
const bearer = (await rider.start()).token;
await rider.post('/api/location', AT);
const nearby = (extra = '') => `/api/drivers/nearby?lat=${AT.lat}&lng=${AT.lng}&radiusKm=30${extra}`;
const middle = (list) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];

async function measure(name, call, times = 100) {
  const took = [];
  let last;
  for (let i = 0; i < times; i++) {
    const from = performance.now();
    last = await call();
    took.push(performance.now() - from);
  }
  took.sort((a, b) => a - b);
  console.log(`${name.padEnd(30)} middle ${middle(took).toFixed(1).padStart(7)} ms   worst ${took.at(-1).toFixed(1).padStart(7)} ms   ${JSON.stringify(last).length >> 10} KB`, last.drivers ? `(${last.drivers.length} of ${last.total ?? '?'})` : `(${last.offers?.length ?? '?'} offers)`);
}

await measure('nearby, cheapest', () => rider.get(nearby()));
await measure('nearby, best rated', () => rider.get(nearby('&sort=stars')));
await measure('nearby, on time', () => rider.get(nearby('&sort=onTime')));
await measure('nearby, closest', () => rider.get(nearby('&sort=fastest')));
await measure('nearby, 200 of them', () => rider.get(nearby('&limit=200')));
const quote = { pickup: { ...AT, label: 'Here' }, dropoff: { lat: AT.lat + 0.05, lng: AT.lng, label: 'There' }, passengers: 1, pets: false, coin: 'sol' };
await measure('a quote', () => rider.post('/api/quote', quote), 30);

// What a look weighs on the line, the way Cloudflare asks for it.
const onTheLine = await new Promise((resolve, reject) => {
  http.get(new URL(srv.base + nearby()), { headers: { authorization: `Bearer ${bearer}`, 'accept-encoding': 'gzip' } }, (res) => {
    let bytes = 0;
    res.on('data', (c) => { bytes += c.length; });
    res.on('end', () => resolve({ bytes, encoding: res.headers['content-encoding'] }));
  }).on('error', reject);
});
console.log(`a look on the line: ${(onTheLine.bytes / 1024).toFixed(1)} KB, ${onTheLine.encoding ?? 'not compressed'}`);

// A thousand riders looking every 30 seconds is 33 looks a second, on a few connections.
const riders = await Promise.all(Array.from({ length: 20 }, async () => { const c = client(srv.base, `device-${crypto.randomBytes(6).toString('hex')}`); await c.start(); return c; }));
const until = Date.now() + 10_000;
let looks = 0;
await Promise.all(riders.map(async (c) => { while (Date.now() < until) { await c.get(nearby()); looks++; } }));
console.log(`flat out, 20 at a time: ${(looks / 10).toFixed(0)} looks a second (a thousand riders need 33)`);
srv.stop();
process.exit(0);
