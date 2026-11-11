// Drivers: rates, cars with their plates and pictures, going online, and what riders see of them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { all, get, now, PHOTO_DIR, run, tx, uid } from './db.js';
import { config, DRIVER_DEFAULTS, RATE_LIMITS, rules } from './config.js';
import { ApiError, num, route, serveFile, text } from './http.js';
import { requireUser } from './auth.js';
import { metres, squareAround, validPoint } from './geo.js';
import { cleanPlate, lookupPlate, prettyPlate, seatsOn, VEHICLES } from './rdw.js';
import { bump } from './sync.js';
import { tellEdges } from './fanout.js';
import { CASH, checkUsdcEnabled, enabledCoins, enabledCoinsOf, PAY_IDS, walletCoins } from './wallet.js';
import { blockedBetween, blockedIds } from './safety.js';
import { findBlocked } from './filter.js';
import { backPhotoRead, carChanged, carHold, checksError, checksNeeded, checksSummary, requireNetherlands, showsToRiders } from './checks.js';

export const ACTIVE_STATUSES = ['accepted', 'arrived', 'riding'];
const ACTIVE_SQL = `('accepted', 'arrived', 'riding')`;

export const driverRow = (id) => get('SELECT * FROM drivers WHERE user_id = ?', id);
export const isOnline = (d, t = now()) => Boolean(d?.online_since && d.heartbeat_at && t - d.heartbeat_at < rules.onlineTimeout);
// A driver waiting for a ride-now to be paid is driving already: no other rides, no going offline.
export const isDriving = (userId) => Boolean(get(`SELECT 1 AS x FROM rides WHERE driver_id = ? AND status IN ('accepted', 'arrived', 'riding', 'awaiting_payment') AND (status != 'awaiting_payment' OR scheduled_at IS NULL)`, userId));
// An order waiting for a driver counts; a ride planned for later doesn't until it starts.
export const isOnRide = (userId) => Boolean(get(`SELECT 1 AS x FROM rides WHERE rider_id = ? AND status IN ('accepted', 'arrived', 'riding', 'searching', 'awaiting_payment', 'offered', 'open') AND (status IN ${ACTIVE_SQL} OR scheduled_at IS NULL)`, userId));
// Someone is a driver or a rider until the drive or ride is over, never both.
export const isBusy = (userId) => isDriving(userId) || isOnRide(userId);

function requireDriver(ctx) {
  const user = requireUser(ctx);
  const driver = driverRow(user.id);
  if (!driver) throw new ApiError(403, 'not_driver', 'Turn on driving in Profile first.');
  return { user, driver };
}
export { requireDriver };

export function publicCar(car, knownPhotos) {
  if (!car) return null;
  // Not just `??`: this is also used as a callback for map(), which passes its position in the list as the second argument.
  const photos = Array.isArray(knownPhotos) ? knownPhotos : all('SELECT id, kind FROM car_photos WHERE car_id = ? ORDER BY created_at', car.id);
  return {
    id: car.id,
    vehicle: car.vehicle || 'car',
    plate: car.plate,
    platePretty: prettyPlate(car.plate),
    make: car.make,
    model: car.model,
    colorName: car.color_name,
    colorHex: car.color_hex,
    body: car.body || 'hatchback',
    seats: car.seats,
    year: car.year,
    verified: Boolean(car.verified),
    perKmCents: car.per_km_cents,
    perMinCents: car.per_min_cents,
    pickupPerKmCents: car.pickup_per_km_cents,
    petsAllowed: Boolean(car.pets_allowed),
    photos: photos.map((p) => ({ id: p.id, kind: p.kind, url: `/api/car-photos/${p.id}` })),
    photosMissing: photosMissing(car, photos),
  };
}

const ratingOf = (r) => ({ rating: r?.n ? Math.round(r.avg * 10) / 10 : null, ratingCount: r?.n ?? 0 });
export function reviewStats(driverId) {
  return ratingOf(get('SELECT COUNT(*) AS n, AVG(stars) AS avg FROM reviews WHERE driver_id = ?', driverId));
}

// How often a driver is on time: at the pickup within their time to get there (rides.pickup_deadline_at). A ride cancelled
// because they were past it counts too. Rides from before that time was kept count by the promised time plus a little.
const ARRIVAL_SUMS = `COUNT(*) AS n, SUM(arrived_at IS NOT NULL AND arrived_at <= COALESCE(pickup_deadline_at, pickup_eta_at + ?)) AS onTime, AVG(MAX(COALESCE(arrival_late_s, 0), 0)) AS late`;
const ARRIVED = `(arrived_at IS NOT NULL OR (status = 'cancelled' AND pickup_deadline_at IS NOT NULL AND cancelled_at > pickup_deadline_at))`;
const arrivalOf = (r) => (r?.n
  ? { arrivalScore: Math.round((r.onTime / r.n) * 100), arrivals: r.n, averageLateS: Math.round(r.late) }
  : { arrivalScore: null, arrivals: 0, averageLateS: null });
export function arrivalScore(driverId) {
  return arrivalOf(get(`SELECT ${ARRIVAL_SUMS} FROM rides WHERE driver_id = ? AND ${ARRIVED}`, rules.arrivalGrace, driverId));
}

// How often a driver finishes what they took. A rider cancelling, or not showing up, doesn't count against them.
const THEIR_DOING = `(cancelled_by = 'driver' AND COALESCE(cancel_reason, '') != 'Rider not there') OR cancel_reason IN ('Your driver didn’t show up', 'Your driver can’t make it')`;
const COMPLETED_SUMS = `COUNT(*) AS n, COALESCE(SUM(status = 'completed'), 0) AS done`;
// The plus keeps the database from going through every finished ride there is, rather than only those of these drivers.
const COUNTS_AS_RIDE = `(+status = 'completed' OR (+status = 'cancelled' AND (${THEIR_DOING})))`;
const completedOf = (r) => ({ completedPercent: r?.n ? Math.round((r.done / r.n) * 100) : null, ridesDone: r?.done ?? 0 });
export function completedScore(driverId) {
  return completedOf(get(`SELECT ${COMPLETED_SUMS} FROM rides WHERE driver_id = ? AND ${COUNTS_AS_RIDE}`, driverId));
}

// A list of ids as one parameter: the statement stays one statement, whatever the number of drivers, and is prepared once.
const IN_LIST = '(SELECT value FROM json_each(?))';

// The stars and scores of many drivers at once, for the map, which every rider looks at every 30 seconds. They go through each
// driver's whole history, so they're kept for a few minutes, and forgotten as soon as something changes them (forgetDriverStats).
const STATS_KEPT = 5 * 60_000;
const keptStats = new Map();
export function forgetDriverStats(driverId) {
  keptStats.delete(driverId);
  tellEdges('forget', driverId);
}
export function driverStats(ids) {
  const t = Date.now();
  const out = new Map();
  const missing = [];
  for (const id of ids) {
    const kept = keptStats.get(id);
    if (kept && t - kept.at < STATS_KEPT) out.set(id, kept.stats); else missing.push(id);
  }
  if (!missing.length) return out;
  const list = JSON.stringify(missing);
  const byDriver = (rows) => new Map(rows.map((r) => [r.id, r]));
  const ratings = byDriver(all(`SELECT driver_id AS id, COUNT(*) AS n, AVG(stars) AS avg FROM reviews WHERE driver_id IN ${IN_LIST} GROUP BY driver_id`, list));
  const arrivals = byDriver(all(`SELECT driver_id AS id, ${ARRIVAL_SUMS} FROM rides WHERE driver_id IN ${IN_LIST} AND ${ARRIVED} GROUP BY driver_id`, rules.arrivalGrace, list));
  const finished = byDriver(all(`SELECT driver_id AS id, ${COMPLETED_SUMS} FROM rides WHERE driver_id IN ${IN_LIST} AND ${COUNTS_AS_RIDE} GROUP BY driver_id`, list));
  for (const id of missing) {
    const stats = { ...ratingOf(ratings.get(id)), ...arrivalOf(arrivals.get(id)), ...completedOf(finished.get(id)) };
    keptStats.set(id, { at: t, stats });
    out.set(id, stats);
  }
  return out;
}

export const activeCarReady = (d, user) => {
  const car = d?.active_car_id && get('SELECT * FROM cars WHERE id = ? AND deleted_at IS NULL', d.active_car_id);
  return Boolean(car) && (Boolean(user.is_demo) || !photosMissing(car).length);
};
// What every vehicle needs before it can drive: its front and back; a car also the inside. Riders know what to look for.
export function photosMissing(car, photos = all('SELECT kind FROM car_photos WHERE car_id = ?', car.id)) {
  const have = new Set(photos.map((p) => p.kind));
  return ((car.vehicle || 'car') === 'car' ? ['front', 'back', 'inside'] : ['front', 'back']).filter((k) => !have.has(k));
}

// `known`: what was already looked up for many drivers at once (driverCards).
export function driverCard(d, user, car, from, known) {
  return {
    id: d.user_id,
    name: user.name,
    lat: d.lat,
    lng: d.lng,
    heading: d.heading,
    online: isOnline(d),
    busy: known?.busy ?? isBusy(d.user_id),
    distanceM: from && d.lat != null ? Math.round(metres(from.lat, from.lng, d.lat, d.lng)) : null,
    perKmCents: car?.per_km_cents ?? d.per_km_cents,
    perMinCents: car?.per_min_cents ?? d.per_min_cents,
    pickupPerKmCents: car?.pickup_per_km_cents ?? d.pickup_per_km_cents,
    petsAllowed: Boolean(car?.pets_allowed),
    allowsPlanning: Boolean(d.allows_planning),
    // Their ID, face, chauffeurskaart and permit checked out, and none has run out (checks.js).
    verified: Boolean(d.verified_at),
    car: publicCar(car, known?.photos),
    coins: known?.coins ?? enabledCoins(d.user_id),
    ...(known?.stats ?? { ...reviewStats(d.user_id), ...arrivalScore(d.user_id), ...completedScore(d.user_id) }),
  };
}

// The cards for what fillDrivers found: nobody there is busy, and the rest was looked up already. Only how far away they are differs per look.
export function driverCards(found, from) {
  const stats = driverStats(found.map((x) => x.d.user_id));
  return found.map((x) => {
    x.card ??= driverCard(x.d, x.user, x.car, null, { busy: false, stats: stats.get(x.d.user_id), photos: x.photos, coins: x.coins });
    const at = x.spot ?? x.d;
    return { ...x.card, lat: at.lat, lng: at.lng, heading: at.heading ?? x.card.heading, distanceM: Math.round(metres(from.lat, from.lng, at.lat, at.lng)) };
  });
}

// Who's taken right now, from what's going on rather than from each driver's history: a driver on a drive or with a ride to pay for,
// someone with a ride or an order of their own, and a driver making up their mind about an offer, for up to 5 minutes.
function takenNow(t) {
  const taken = new Set();
  for (const r of all(`SELECT driver_id, rider_id, status, scheduled_at, offered_to, offered_until FROM rides WHERE status IN ${ACTIVE_SQL} OR status IN ('awaiting_payment', 'searching', 'offered', 'open')`)) {
    const active = ACTIVE_STATUSES.includes(r.status);
    if (r.driver_id && (active || (r.status === 'awaiting_payment' && r.scheduled_at == null))) taken.add(r.driver_id);
    if (active || r.scheduled_at == null) taken.add(r.rider_id);
    if (r.status === 'offered' && r.offered_to && r.offered_until > t) taken.add(r.offered_to);
  }
  return taken;
}

// Everyone online who could take a ride, kept in memory for a moment and sorted by latitude. With thousands online, every look and every quote
// going through them in the database is what would stop the server first. It's as little as it takes to put them in order: only the first
// few get looked at any further (fillDrivers). Their rates are named as on a car, for fareCents. A booking asks for the latest (`fresh`).
const SNAPSHOT_MS = Number(process.env.DRIVERS_SNAPSHOT_MS ?? (config.dev ? 0 : 2500));
let snapshot = null;
function onlineNow(fresh) {
  const at = Date.now();
  if (!fresh && snapshot && at - snapshot.at < SNAPSHOT_MS) return snapshot;
  const t = now();
  const taken = takenNow(t);
  const rows = all(`SELECT d.user_id, d.lat, d.lng, d.heading, d.active_car_id, COALESCE(c.per_km_cents, d.per_km_cents) AS per_km_cents, COALESCE(c.per_min_cents, d.per_min_cents) AS per_min_cents,
                           COALESCE(c.pickup_per_km_cents, d.pickup_per_km_cents) AS pickup_per_km_cents, c.seats, c.pets_allowed, c.vehicle, d.verified_at, u.is_demo
                    FROM drivers d
                    JOIN users u ON u.id = d.user_id
                    JOIN cars c ON c.id = d.active_car_id AND c.deleted_at IS NULL
                    WHERE d.online_since IS NOT NULL AND d.heartbeat_at > ? AND d.lat IS NOT NULL AND u.deleted_at IS NULL
                    ORDER BY d.lat`, t - rules.onlineTimeout).filter((d) => !taken.has(d.user_id) && showsToRiders(d));
  const coins = new Map();
  for (const w of all(`SELECT w.user_id, w.coin FROM wallets w JOIN drivers d ON d.user_id = w.user_id WHERE d.online_since IS NOT NULL AND w.enabled = 1`)) {
    if (!coins.has(w.user_id)) coins.set(w.user_id, new Set());
    coins.get(w.user_id).add(w.coin);
  }
  for (const d of all('SELECT user_id FROM drivers WHERE online_since IS NOT NULL AND takes_cash = 1')) {
    if (!coins.has(d.user_id)) coins.set(d.user_id, new Set());
    coins.get(d.user_id).add(CASH);
  }
  snapshot = { at, rows, coins };
  return snapshot;
}

// Online drivers with a car, around a point. Those on a drive are left out.
export function driversAround({ lat, lng, radiusM, seats = 1, pets = false, coin = null, vehicle = null, viewerId = null, fresh = false }) {
  const demo = isDemoUser(viewerId) ? 1 : 0;
  const hidden = viewerId ? blockedIds(viewerId) : null;
  const { rows, coins } = onlineNow(fresh);
  const [south, north, west, east] = squareAround(lat, lng, radiusM);
  const acrossDateLine = Math.abs(lng) + (east - lng) > 180;
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].lat < south) low = middle + 1; else high = middle;
  }
  const out = [];
  for (let i = low; i < rows.length && rows[i].lat <= north; i++) {
    const d = rows[i];
    if (!acrossDateLine && (d.lng < west || d.lng > east)) continue;
    if (d.is_demo !== demo || d.seats < seats || d.user_id === viewerId) continue;
    if (pets && !d.pets_allowed) continue;
    if (vehicle && d.vehicle !== vehicle) continue;
    if (coin && !demo && !coins.get(d.user_id)?.has(coin)) continue;
    if (hidden?.has(d.user_id)) continue;
    if (metres(lat, lng, d.lat, d.lng) <= radiusM) out.push(d);
  }
  return out;
}

// What other drivers around here ask, for a driver's own screen. It only changes slowly, so it's kept per neighbourhood for half a minute.
const areas = new Map();
const middleOf = (values) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
export function areaAround(lat, lng) {
  const key = SNAPSHOT_MS ? `${Math.round(lat * 20)},${Math.round(lng * 20)}` : null;
  const t = Date.now();
  const kept = key && areas.get(key);
  if (kept && t - kept.at < 30_000) return kept.area;
  const others = driversAround({ lat, lng, radiusM: rules.defaultRadiusKm * 1000, seats: 0 });
  const km = others.map((o) => o.per_km_cents), min = others.map((o) => o.per_min_cents);
  const area = { driversOnline: others.length, cheapestPerKmCents: km.length ? Math.min(...km) : null, middlePerKmCents: middleOf(km), cheapestPerMinCents: min.length ? Math.min(...min) : null, middlePerMinCents: middleOf(min) };
  if (key) {
    if (areas.size > 20_000) areas.clear();
    areas.set(key, { at: t, area });
  }
  return area;
}

// All there is to know of the first few, for their cards, kept for a moment: the same drivers come up for every look and quote around here.
// A driver who lost a photo since going online is left out here.
const KEPT_MS = SNAPSHOT_MS * 4;
const kept = new Map();
export function fillDrivers(list, howMany, viewerId = null) {
  const first = list.slice(0, howMany + 10);
  if (!first.length) return [];
  const t = Date.now();
  const known = (x) => { const k = KEPT_MS && kept.get(x.user_id); return k && t - k.at < KEPT_MS ? k : null; };
  const missing = first.filter((x) => !known(x));
  if (missing.length) {
    const demo = isDemoUser(viewerId);
    const rows = new Map(all(`SELECT d.*, u.name AS user_name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id IN ${IN_LIST}`, JSON.stringify(missing.map((x) => x.user_id))).map((d) => [d.user_id, d]));
    const carIds = JSON.stringify(missing.map((x) => x.active_car_id));
    const cars = new Map(all(`SELECT * FROM cars WHERE id IN ${IN_LIST}`, carIds).map((c) => [c.id, c]));
    const photos = new Map();
    for (const p of all(`SELECT id, car_id, kind FROM car_photos WHERE car_id IN ${IN_LIST} ORDER BY created_at`, carIds)) {
      if (!photos.has(p.car_id)) photos.set(p.car_id, []);
      photos.get(p.car_id).push(p);
    }
    const wallets = demo ? null : enabledCoinsOf(missing.map((x) => x.user_id));
    if (kept.size > 200_000) kept.clear();
    for (const x of missing) {
      const d = rows.get(x.user_id), car = cars.get(x.active_car_id), carPhotos = photos.get(x.active_car_id) ?? [];
      kept.set(x.user_id, { at: t, gone: !d || !car || (!demo && photosMissing(car, carPhotos).length > 0), d, car, user: { name: d?.user_name }, photos: carPhotos, coins: demo ? PAY_IDS : wallets.get(x.user_id) });
    }
  }
  const out = [];
  for (const x of first) {
    const k = kept.get(x.user_id);
    // The car can have changed since: then it goes by the latest.
    if (k.gone || k.car.id !== x.active_car_id) continue;
    // Where they are now, from the snapshot: what's kept is up to 10 seconds old, and a moving car should move on the map.
    k.spot = { lat: x.lat, lng: x.lng, heading: x.heading ?? null };
    out.push(k);
    if (out.length === howMany) break;
  }
  if (!KEPT_MS) kept.clear();
  return out;
}

// What a rider can ask to see first.
export const SORTS = ['cheapest', 'stars', 'fastest', 'onTime'];
// Many reviews count for more than a few: one 5-star review shouldn't beat 400 of 4.9. Nothing to go on comes last.
const trusted = (score, count, usual) => (count ? (score * count + usual * 3) / (count + 3) : -1);

// The first few, in order, without putting everyone in order. `cost`: what each one asks, for the cheapest and for whoever else is level.
// Only the sort that needs them looks up stars for everyone.
export function rankDrivers(found, at, sort, cost, howMany = 60) {
  const stats = sort === 'stars' || sort === 'onTime' ? driverStats(found.map((x) => x.user_id)) : null;
  const first = (x) => {
    if (sort === 'fastest') return metres(at.lat, at.lng, x.lat, x.lng);
    if (sort === 'stars') { const s = stats.get(x.user_id); return -trusted(s.rating, s.ratingCount, 4); }
    if (sort === 'onTime') { const s = stats.get(x.user_id); return -trusted(s.arrivalScore, s.arrivals, 80); }
    return cost(x);
  };
  const best = [];
  for (const x of found) {
    const entry = { x, first: first(x), then: sort === 'cheapest' ? 0 : cost(x) };
    const worst = best[best.length - 1];
    if (best.length === howMany && (entry.first > worst.first || (entry.first === worst.first && entry.then >= worst.then))) continue;
    let i = best.length;
    while (i > 0 && (best[i - 1].first > entry.first || (best[i - 1].first === entry.first && best[i - 1].then > entry.then))) i--;
    best.splice(i, 0, entry);
    if (best.length > howMany) best.pop();
  }
  return best.map((e) => e.x);
}

const point = (q) => {
  const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
  if (!validPoint(lat, lng)) throw new ApiError(400, 'bad_location', 'Your location is needed for this.');
  return { lat, lng };
};

// What a driver asks for a 10 km ride of 20 minutes, with their way to the spot: "cheapest" before there's a destination.
// The same ride My page shows a driver their price with.
const askingCents = (x, at) => (metres(at.lat, at.lng, x.lat, x.lng) / 1000) * x.pickup_per_km_cents + 10 * x.per_km_cents + 20 * x.per_min_cents;

// The demo world's simulated drivers come to whoever looks (demo.js).
let onDemoLook = () => {};
export const setOnDemoLook = (fn) => { onDemoLook = fn; };
export const isDemoUser = (id) => Boolean(id && get('SELECT is_demo FROM users WHERE id = ?', id)?.is_demo);

// Everyone in the same few square kilometres, asking the same, gets the same answer for a few seconds, ready and compressed: with
// thousands of riders looking at once this is what saves both the server and the line. Who's on it is checked again when someone books.
// 5 seconds (was 15 until 8 November 2026): Pieter wants drivers to move on the map, and one who's booked or gone offline to go quickly.
const SHARED_LOOK_MS = Number(process.env.SHARED_LOOK_MS ?? (config.dev ? 0 : 5_000));
const sharedLooks = new Map();
const CELL_LAT = 0.04, CELL_LNG = 0.06;
// Which shared looks each driver is in, so one who's booked or goes offline leaves them at once (forgetLooksOf), not when they run out.
const looksOf = new Map();
function rememberLook(key, drivers) {
  if (looksOf.size > 50_000) looksOf.clear();
  for (const d of drivers) {
    if (!looksOf.has(d.id)) looksOf.set(d.id, new Set());
    looksOf.get(d.id).add(key);
  }
}
// A driver was booked, offered a ride, went offline, came free or changed their price or car: the next look asks again, here and in
// the helpers, and their card is looked up again (`kept`), so a new price shows at the next look (Pieter, 8 November 2026).
export function forgetLooksOf(driverId, { tell = true } = {}) {
  if (!driverId) return;
  snapshot = null;
  kept.delete(driverId);
  const keys = looksOf.get(driverId);
  if (keys) {
    for (const key of keys) sharedLooks.delete(key);
    looksOf.delete(driverId);
  }
  if (tell) tellEdges('looks', driverId);
}

route('GET', '/api/drivers/nearby', (ctx) => {
  const viewer = requireUser(ctx);
  const at = point(ctx.query);
  if (viewer.is_demo) onDemoLook({ ...viewer, ...at });
  const radiusKm = Math.min(rules.maxRadiusKm, Math.max(0.5, Number(ctx.query.get('radiusKm')) || rules.defaultRadiusKm));
  const seats = Number(ctx.query.get('seats')) || 1;
  const pets = ctx.query.get('pets') === '1';
  const vehicle = VEHICLES.includes(ctx.query.get('vehicle')) ? ctx.query.get('vehicle') : null;
  // Only the first few, the cheapest unless the rider asks otherwise: a busy city would fill the map. An app that doesn't ask gets the default.
  const limit = Math.min(rules.maxDriversShown, Math.max(1, Math.round(Number(ctx.query.get('limit'))) || rules.driversShown));
  const sort = SORTS.includes(ctx.query.get('sort')) ? ctx.query.get('sort') : 'cheapest';
  const lookFrom = (spot, viewerId) => {
    const found = driversAround({ ...spot, radiusM: radiusKm * 1000, seats, pets, vehicle, viewerId });
    return { drivers: driverCards(fillDrivers(rankDrivers(found, spot, sort, (x) => askingCents(x, spot), limit + 10), limit, viewerId), spot), total: found.length };
  };
  // Someone who could be on the list themselves, or has blocked someone, gets their own.
  if (!SHARED_LOOK_MS || viewer.is_demo || viewer.is_driver || blockedIds(viewer.id).size) return lookFrom(at, viewer.id);
  const cell = { lat: (Math.floor(at.lat / CELL_LAT) + 0.5) * CELL_LAT, lng: (Math.floor(at.lng / CELL_LNG) + 0.5) * CELL_LNG };
  const key = `${cell.lat.toFixed(3)},${cell.lng.toFixed(3)},${radiusKm},${seats},${pets},${vehicle},${limit},${sort}`;
  const t = Date.now();
  let look = sharedLooks.get(key);
  if (!look || t - look.at > SHARED_LOOK_MS) {
    const answer = lookFrom(cell, null);
    const json = Buffer.from(JSON.stringify(answer));
    look = { at: t, json, gzip: zlib.gzipSync(json, { level: 3 }) };
    if (sharedLooks.size > 20_000) for (const [k, v] of sharedLooks) if (t - v.at > SHARED_LOOK_MS) sharedLooks.delete(k);
    sharedLooks.set(key, look);
    rememberLook(key, answer.drivers);
  }
  const gzip = /\bgzip\b/.test(ctx.req.headers['accept-encoding'] ?? '');
  ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Now': String(now()), Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  ctx.res.end(gzip ? look.gzip : look.json);
});

// The hours of the day this driver is usually online, over the last two weeks: 24 shares, UTC.
function usualHours(driverId) {
  const t = now();
  const since = t - 14 * 86_400_000;
  const hours = new Array(24).fill(0);
  for (const s of all('SELECT started_at, ended_at FROM online_log WHERE user_id = ? AND (ended_at IS NULL OR ended_at > ?)', driverId, since)) {
    let from = Math.max(s.started_at, since);
    const to = s.ended_at ?? t;
    while (from < to) {
      hours[new Date(from).getUTCHours()] += Math.min(to - from, 3600_000 - (from % 3600_000)) / 3600_000;
      from += 3600_000 - (from % 3600_000);
    }
  }
  return hours.map((h) => Math.min(1, Math.round((h / 14) * 100) / 100));
}

// What a rider can see of when this driver is free.
export function availability(driverId) {
  const t = now();
  const busy = all(`SELECT scheduled_at, duration_s, pickup_m FROM rides WHERE driver_id = ? AND status = 'scheduled' AND scheduled_at > ? ORDER BY scheduled_at LIMIT 30`, driverId, t)
    .map((r) => ({ from: r.scheduled_at, to: r.scheduled_at + r.duration_s * 1000 }));
  const d = driverRow(driverId);
  const allows = Boolean(d?.allows_planning);
  return {
    lastOnlineAt: d?.last_online_at ?? null,
    bookable: allows && Boolean(d?.last_online_at && t - d.last_online_at < rules.bookableWindow),
    allowsPlanning: allows,
    planDays: allows ? d.plan_days : null,
    busy,
    usualHoursUtc: usualHours(driverId),
  };
}

route('GET', '/api/drivers/:id', (ctx) => {
  const viewer = requireUser(ctx);
  const d = driverRow(ctx.params.id);
  const user = d && get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', d.user_id);
  if (!user || blockedBetween(viewer.id, d.user_id)) throw new ApiError(404, 'not_found', 'This driver is no longer here.');
  const cars = all('SELECT * FROM cars WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at', d.user_id);
  const active = cars.find((c) => c.id === d.active_car_id) ?? null;
  const reviews = all(`SELECT stars, text, created_at FROM reviews WHERE driver_id = ? ORDER BY created_at DESC LIMIT 30`, d.user_id)
    .map((r) => ({ stars: r.stars, text: r.text, at: r.created_at }));
  return {
    driver: { ...driverCard(d, user, active), lat: isOnline(d) ? d.lat : null, lng: isOnline(d) ? d.lng : null, bio: d.bio ?? null },
    reviews,
    availability: availability(d.user_id),
  };
});

// ---------- the driver's own side ----------

export function ownDriver(user) {
  const d = driverRow(user.id);
  if (!d) return null;
  const cars = all('SELECT * FROM cars WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at', user.id);
  const active = cars.find((c) => c.id === d.active_car_id);
  return {
    allowsPlanning: Boolean(d.allows_planning),
    planDays: d.plan_days,
    maxPlanDays: rules.maxPlanDays,
    // What riders are quoted right now: the active car's prices.
    perKmCents: active?.per_km_cents ?? d.per_km_cents,
    perMinCents: active?.per_min_cents ?? d.per_min_cents,
    pickupPerKmCents: active?.pickup_per_km_cents ?? d.pickup_per_km_cents,
    petsAllowed: Boolean(active?.pets_allowed),
    bio: d.bio ?? null,
    rulesSeenAt: d.rules_seen_at ?? null,
    verified: Boolean(d.verified_at),
    // Driving in the Netherlands, in short: status, how many points are open, what a person asked for again (checks.js).
    checks: checksSummary(user.id),
    activeCarId: d.active_car_id,
    online: isOnline(d),
    onlineSince: isOnline(d) ? d.online_since : null,
    putOffline: Boolean(d.inactive_at),
    // Each with what still stops it in the Netherlands, if anything: for its page, and to say so when going online (checks.js).
    cars: cars.map((c) => ({ ...publicCar(c), hold: carHold(user, c) })),
    ...reviewStats(user.id),
    ...arrivalScore(user.id),
    ...completedScore(user.id),
  };
}

route('POST', '/api/driver/enable', (ctx) => {
  const user = requireUser(ctx);
  tx(() => {
    if (!driverRow(user.id)) {
      run('INSERT INTO drivers (user_id, per_km_cents, per_min_cents, pickup_per_km_cents, created_at) VALUES (?, ?, ?, ?, ?)',
        user.id, DRIVER_DEFAULTS.perKmCents, DRIVER_DEFAULTS.perMinCents, DRIVER_DEFAULTS.pickupPerKmCents, now());
    }
    run('UPDATE users SET is_driver = 1 WHERE id = ?', user.id);
  });
  return { driver: ownDriver(user) };
});

route('GET', '/api/driver', (ctx) => {
  const { user } = requireDriver(ctx);
  return { driver: ownDriver(user) };
});

route('PATCH', '/api/driver', (ctx) => {
  const { user, driver } = requireDriver(ctx);
  let days = driver.plan_days;
  if (ctx.body.planDays !== undefined) {
    days = num(ctx.body.planDays);
    if (!Number.isInteger(days) || days < 1 || days > rules.maxPlanDays) throw new ApiError(400, 'bad_days', `Plan between 1 and ${rules.maxPlanDays} days ahead.`);
  }
  if (findBlocked(ctx.body.bio)) throw new ApiError(400, 'not_allowed', 'That text isn’t allowed.');
  run('UPDATE drivers SET bio = ?, allows_planning = ?, plan_days = ? WHERE user_id = ?',
    ctx.body.bio === undefined ? driver.bio : text(ctx.body.bio, 500) || null,
    ctx.body.allowsPlanning === undefined ? driver.allows_planning : ctx.body.allowsPlanning ? 1 : 0,
    days, user.id);
  return { driver: ownDriver(user) };
});

// Drivezzz checks no licences: before going online the first time, the app tells a driver that what the law asks where they drive
// (a licence, permits, insurance, or nothing) is up to them. This keeps when.
route('POST', '/api/driver/rules-seen', (ctx) => {
  const { user } = requireDriver(ctx);
  run('UPDATE drivers SET rules_seen_at = ? WHERE user_id = ?', now(), user.id);
  return { driver: ownDriver(user) };
});

// Going online: on the Driving tab, tapping Drive. It stays on while the phone sends its position.
export function setOnline(userId, lat, lng) {
  const t = now();
  const d = driverRow(userId);
  if (!isOnline(d)) {
    if (d.online_since) closeOnlineLog(userId, d.heartbeat_at ?? t);
    run('INSERT INTO online_log (id, user_id, started_at) VALUES (?, ?, ?)', uid('on_'), userId, t);
    run('UPDATE drivers SET online_since = ? WHERE user_id = ?', t, userId);
  }
  run('UPDATE drivers SET heartbeat_at = ?, last_online_at = ?, lat = COALESCE(?, lat), lng = COALESCE(?, lng), loc_at = ? WHERE user_id = ?', t, t, lat, lng, t, userId);
  if (!isOnline(d)) forgetLooksOf(userId);
  bump(userId);
}
export function closeOnlineLog(userId, at) {
  run('UPDATE online_log SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL', at, userId);
}
export function setOffline(userId, at = now()) {
  closeOnlineLog(userId, at);
  run('UPDATE drivers SET online_since = NULL, last_online_at = ? WHERE user_id = ?', at, userId);
  forgetLooksOf(userId);
  bump(userId);
}

route('POST', '/api/driver/online', async (ctx) => {
  const { user, driver } = requireDriver(ctx);
  const { lat, lng } = ctx.body;
  if (!validPoint(lat, lng)) throw new ApiError(400, 'bad_location', 'We need your location to use this app.');
  const car = driver.active_car_id && get('SELECT 1 AS x FROM cars WHERE id = ? AND deleted_at IS NULL', driver.active_car_id);
  if (!car) throw new ApiError(409, 'need_car', 'Add a vehicle on My page first.');
  const missing = user.is_demo ? [] : photosMissing(get('SELECT * FROM cars WHERE id = ?', driver.active_car_id));
  if (missing.length) throw new ApiError(409, 'need_photos', `Add photos of your vehicle first: ${missing.join(', ')}. On My page, open it and tap Edit.`, { missing });
  requireNetherlands(user, lat, lng, 'drive');
  // A car in the Netherlands: the driver's checks and the car's taxi registration (checks.js). The app opens its wizard for this.
  const need = await checksNeeded(user, get('SELECT * FROM cars WHERE id = ?', driver.active_car_id), { lat, lng });
  if (need) throw checksError(need);
  await checkUsdcEnabled(user);
  if (!walletCoins(user.id).length) throw new ApiError(409, 'need_wallet', 'Connect a wallet in Profile first, so you can be paid.');
  if (isOnRide(user.id)) throw new ApiError(409, 'on_a_ride', 'Finish your ride first.');
  run('UPDATE drivers SET inactive_at = NULL WHERE user_id = ?', user.id);
  setOnline(user.id, lat, lng);
  return { driver: ownDriver(user) };
});

route('POST', '/api/driver/offline', (ctx) => {
  const { user } = requireDriver(ctx);
  if (isDriving(user.id)) throw new ApiError(409, 'on_a_drive', 'You have a rider. Finish the drive, or cancel it, before you go offline.');
  if (driverRow(user.id).online_since) setOffline(user.id);
  return { driver: ownDriver(user) };
});

// ---------- cars ----------

route('GET', '/api/plates/:plate', async (ctx) => {
  requireDriver(ctx);
  const found = await lookupPlate(ctx.params.plate);
  return { found: Boolean(found), car: found };
});

const LABELS = { perKmCents: 'Price per km', perMinCents: 'Price per minute', pickupPerKmCents: 'Pickup price per km' };
function rate(body, field, current) {
  if (body[field] === undefined) return current;
  const v = num(body[field]);
  if (v == null || v < 0 || v > RATE_LIMITS[field] || !Number.isInteger(v)) throw new ApiError(400, 'bad_rate', `${LABELS[field]} must be between €0 and €${RATE_LIMITS[field] / 100}.`);
  return v;
}

function carFields(body, base = {}) {
  if (findBlocked(body.make) || findBlocked(body.model)) throw new ApiError(400, 'not_allowed', 'That name isn’t allowed.');
  const vehicle = body.vehicle === undefined ? (base.vehicle ?? 'car') : text(body.vehicle, 10);
  if (!VEHICLES.includes(vehicle)) throw new ApiError(400, 'bad_vehicle', 'A vehicle is a car, a motor or a scooter.');
  const seats = seatsOn(vehicle, body.seats === undefined ? base.seats : num(body.seats));
  if (!Number.isInteger(seats) || seats < 1 || seats > 16) throw new ApiError(400, 'bad_seats', 'Seats must be between 1 and 16.');
  const hex = body.colorHex === undefined ? base.color_hex : text(body.colorHex, 7);
  if (hex && !/^#[0-9a-fA-F]{6}$/.test(hex)) throw new ApiError(400, 'bad_colour', 'That colour can’t be used.');
  const body_ = body.body === undefined ? base.body : text(body.body, 12);
  if (body_ && !['hatchback', 'sedan', 'estate', 'suv', 'mpv', 'van'].includes(body_)) throw new ApiError(400, 'bad_body', 'That body type can’t be used.');
  return {
    make: (body.make === undefined ? base.make : text(body.make, 40)) || null,
    model: (body.model === undefined ? base.model : text(body.model, 40)) || null,
    colorName: (body.colorName === undefined ? base.color_name : text(body.colorName, 20)) || null,
    hex: hex || null,
    body: body_ || 'hatchback',
    vehicle,
    seats,
    perKm: rate(body, 'perKmCents', base.per_km_cents),
    perMin: rate(body, 'perMinCents', base.per_min_cents),
    pickup: rate(body, 'pickupPerKmCents', base.pickup_per_km_cents),
    pets: body.petsAllowed === undefined ? (base.pets_allowed ?? 0) : body.petsAllowed ? 1 : 0,
  };
}

route('POST', '/api/cars', async (ctx) => {
  const { user, driver } = requireDriver(ctx);
  const plate = cleanPlate(ctx.body.plate);
  if (plate.length < 4) throw new ApiError(400, 'bad_plate', 'Fill in the number plate.');
  if (get('SELECT COUNT(*) AS n FROM cars WHERE user_id = ? AND deleted_at IS NULL', user.id).n >= 10) throw new ApiError(409, 'too_many_cars', 'You can have up to 10 vehicles.');
  if (get('SELECT 1 AS x FROM cars WHERE plate = ? AND user_id = ? AND deleted_at IS NULL', plate, user.id)) throw new ApiError(409, 'plate_there', 'You already added this plate.');
  const register = await lookupPlate(plate);
  const vehicle = ctx.body.vehicle ?? register?.vehicle ?? 'car';
  const merged = { vehicle, seats: ctx.body.seats ?? register?.seats ?? (vehicle === 'car' ? 4 : 1), make: ctx.body.make ?? register?.make, model: ctx.body.model ?? register?.model,
    colorName: ctx.body.colorName ?? register?.colorName, colorHex: ctx.body.colorHex ?? register?.colorHex, body: ctx.body.body ?? register?.body };
  // A new car starts with the prices of the car in use, or the defaults.
  const like = get('SELECT * FROM cars WHERE id = ? AND deleted_at IS NULL', driver.active_car_id ?? '');
  const f = carFields({ ...ctx.body, ...merged }, {
    per_km_cents: like?.per_km_cents ?? driver.per_km_cents,
    per_min_cents: like?.per_min_cents ?? driver.per_min_cents,
    pickup_per_km_cents: like?.pickup_per_km_cents ?? driver.pickup_per_km_cents,
    pets_allowed: like?.pets_allowed ?? 0,
  });
  const id = uid('car_');
  tx(() => {
    run(`INSERT INTO cars (id, user_id, plate, vehicle, make, model, color_name, color_hex, body, seats, year, verified, per_km_cents, per_min_cents, pickup_per_km_cents, pets_allowed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, user.id, plate, f.vehicle, f.make, f.model, f.colorName, f.hex, f.body, f.seats, register?.year ?? null, register ? 1 : 0, f.perKm, f.perMin, f.pickup, f.pets, now());
    if (!driver.active_car_id) run('UPDATE drivers SET active_car_id = ? WHERE user_id = ?', id, user.id);
  });
  return { car: publicCar(get('SELECT * FROM cars WHERE id = ?', id)), driver: ownDriver(user) };
});

function ownCar(user, id) {
  const car = get('SELECT * FROM cars WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, user.id);
  if (!car) throw new ApiError(404, 'not_found', 'This vehicle is no longer here.');
  return car;
}

route('PATCH', '/api/cars/:id', (ctx) => {
  const { user } = requireDriver(ctx);
  const car = ownCar(user, ctx.params.id);
  const f = carFields(ctx.body, car);
  run('UPDATE cars SET vehicle = ?, make = ?, model = ?, color_name = ?, color_hex = ?, body = ?, seats = ?, per_km_cents = ?, per_min_cents = ?, pickup_per_km_cents = ?, pets_allowed = ? WHERE id = ?',
    f.vehicle, f.make, f.model, f.colorName, f.hex, f.body, f.seats, f.perKm, f.perMin, f.pickup, f.pets, car.id);
  // A new price shows on riders' maps at their next look, not when what's kept runs out.
  forgetLooksOf(user.id);
  return { car: publicCar(get('SELECT * FROM cars WHERE id = ?', car.id)), driver: ownDriver(user) };
});

route('POST', '/api/cars/:id/activate', async (ctx) => {
  const { user, driver } = requireDriver(ctx);
  const car = ownCar(user, ctx.params.id);
  if (isDriving(user.id)) throw new ApiError(409, 'on_a_ride', 'Finish your ride first.');
  // Online in the Netherlands, a car only takes over if it may drive there.
  if (isOnline(driver)) {
    const need = await checksNeeded(user, car, { lat: driver.lat, lng: driver.lng });
    if (need) throw checksError(need);
  }
  run('UPDATE drivers SET active_car_id = ? WHERE user_id = ?', car.id, user.id);
  carChanged(user.id);
  forgetLooksOf(user.id);
  return { driver: ownDriver(user) };
});

route('DELETE', '/api/cars/:id', (ctx) => {
  const { user, driver } = requireDriver(ctx);
  const car = ownCar(user, ctx.params.id);
  if (get(`SELECT 1 AS x FROM rides WHERE car_id = ? AND status IN ('scheduled', 'accepted', 'arrived', 'riding')`, car.id)) throw new ApiError(409, 'car_booked', 'This vehicle has rides booked.');
  tx(() => {
    run('UPDATE cars SET deleted_at = ? WHERE id = ?', now(), car.id);
    if (driver.active_car_id === car.id) {
      const next = get('SELECT id FROM cars WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1', user.id);
      run('UPDATE drivers SET active_car_id = ? WHERE user_id = ?', next?.id ?? null, user.id);
      if (!next && driver.online_since) setOffline(user.id);
    }
  });
  forgetLooksOf(user.id);
  return { driver: ownDriver(user) };
});

route('POST', '/api/cars/:id/photos', (ctx) => {
  const { user } = requireDriver(ctx);
  const car = ownCar(user, ctx.params.id);
  const asked = ctx.query.get('kind');
  const kind = ['front', 'back', 'inside'].includes(asked) ? asked : 'outside';
  if (!ctx.raw?.length) throw new ApiError(400, 'no_photo', 'No photo came through.');
  // A JPEG starts FF D8 FF; the app always sends one.
  if (ctx.raw[0] !== 0xff || ctx.raw[1] !== 0xd8 || ctx.raw[2] !== 0xff) throw new ApiError(400, 'not_jpeg', 'Send a JPEG photo.');
  if (get('SELECT COUNT(*) AS n FROM car_photos WHERE car_id = ?', car.id).n >= 12) throw new ApiError(409, 'too_many_photos', 'A vehicle can have up to 12 photos.');
  // One each of the required ones: a new one replaces the old.
  if (kind !== 'outside') {
    for (const old of all('SELECT * FROM car_photos WHERE car_id = ? AND kind = ?', car.id, kind)) {
      run('DELETE FROM car_photos WHERE id = ?', old.id);
      fs.rmSync(path.join(PHOTO_DIR, old.file), { force: true });
    }
  }
  const id = uid('ph_');
  fs.writeFileSync(path.join(PHOTO_DIR, `${id}.jpg`), ctx.raw);
  run('INSERT INTO car_photos (id, car_id, kind, file, created_at) VALUES (?, ?, ?, ?, ?)', id, car.id, kind, `${id}.jpg`, now());
  if (kind === 'back') backPhotoRead(ctx, user, car);
  forgetLooksOf(user.id);
  return { car: publicCar(get('SELECT * FROM cars WHERE id = ?', car.id)), driver: ownDriver(user) };
});

route('DELETE', '/api/car-photos/:id', (ctx) => {
  const { user, driver } = requireDriver(ctx);
  const p = get('SELECT p.* FROM car_photos p JOIN cars c ON c.id = p.car_id WHERE p.id = ? AND c.user_id = ?', ctx.params.id, user.id);
  if (!p) throw new ApiError(404, 'not_found', 'This photo is no longer here.');
  if (p.kind !== 'outside' && p.car_id === driver.active_car_id && isOnline(driver)) throw new ApiError(409, 'needed_online', 'You need this photo while you’re online. Replace it, or go offline first.');
  run('DELETE FROM car_photos WHERE id = ?', p.id);
  fs.rmSync(path.join(PHOTO_DIR, p.file), { force: true });
  return { driver: ownDriver(user) };
});

route('GET', '/api/car-photos/:id', (ctx) => {
  const p = get('SELECT file FROM car_photos WHERE id = ?', ctx.params.id);
  const file = p && path.join(PHOTO_DIR, p.file);
  if (!file || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Not found.');
  serveFile(ctx.res, file, { cache: 'public, max-age=86400' });
});
