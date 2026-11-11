// The demo account for App Review (guideline 2.1). A reviewer in California has no drivers near them and no crypto, so
// this one account sees simulated drivers and riders around wherever it is, and a ride plays out by itself. Everything
// is kept apart: real people never see demo people and the other way round, demo coins aren't money (nothing can be
// deposited or withdrawn), and a demo ride's payout is marked 'demo', which nothing ever sends.
import { all, get, getMeta, now, run, setMeta, tx, uid } from './db.js';
import { rules } from './config.js';
import { decodePolyline, metres } from './geo.js';
import * as routing from './routing.js';
import { driverRow, isBusy } from './drivers.js';
import { arrive, assignDriver, botCheckIn, complete, insertRide, rideRow } from './rides.js';
import { bump } from './sync.js';
import { addMessage } from './messages.js';
import { chatKey, newKeys, seal } from './e2e.js';

const BOTS = [
  { id: 'demo-anna', name: 'Anna', plate: 'DM111A', make: 'Toyota', model: 'Prius', color: ['White', '#F4F4F2'], body: 'hatchback', seats: 4, rates: [85, 18, 40], pets: 1, at: [0.004, 0.002] },
  { id: 'demo-bram', name: 'Bram', plate: 'DM222B', make: 'Volkswagen', model: 'Touran', color: ['Blue', '#1F4E9E'], body: 'mpv', seats: 6, rates: [70, 15, 60], pets: 0, at: [-0.006, 0.004] },
  { id: 'demo-cato', name: 'Cato', plate: 'DM333C', make: 'Piaggio', model: 'Zip', color: ['Red', '#B3202A'], body: 'hatchback', seats: 1, rates: [45, 10, 25], pets: 0, at: [0.002, -0.006], vehicle: 'scooter' },
];
const BOT_RIDER = 'demo-rider';
const isBot = (id) => String(id).startsWith('demo-');
const lastOffer = new Map();

function ensureBots() {
  const t = now();
  tx(() => {
    if (!get('SELECT 1 AS x FROM users WHERE id = ?', BOT_RIDER)) run('INSERT INTO users (id, name, is_demo, last_seen_at, created_at) VALUES (?, ?, 1, ?, ?)', BOT_RIDER, 'Sam', t, t);
    for (const b of BOTS) {
      if (get('SELECT 1 AS x FROM users WHERE id = ?', b.id)) continue;
      run('INSERT INTO users (id, name, is_driver, is_demo, last_seen_at, created_at) VALUES (?, ?, 1, 1, ?, ?)', b.id, b.name, t, t);
      const car = uid('car_');
      run('INSERT INTO drivers (user_id, per_km_cents, per_min_cents, pickup_per_km_cents, allows_planning, active_car_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)', b.id, ...b.rates, car, t);
      run(`INSERT INTO cars (id, user_id, plate, vehicle, make, model, color_name, color_hex, body, seats, verified, per_km_cents, per_min_cents, pickup_per_km_cents, pets_allowed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`, car, b.id, b.plate, b.vehicle ?? 'car', b.make, b.model, ...b.color, b.body, b.seats, ...b.rates, b.pets, t);
    }
  });
}

// Keeps the free simulated drivers online, near whoever is looking.
export function placeBots(person) {
  if (person?.lat == null) return;
  ensureBots();
  const t = now();
  for (const b of BOTS) {
    const busy = isBusy(b.id);
    if (busy) {
      run('UPDATE drivers SET heartbeat_at = ?, last_online_at = ?, loc_at = ? WHERE user_id = ?', t, t, t, b.id);
    } else {
      run('UPDATE drivers SET online_since = COALESCE(online_since, ?), heartbeat_at = ?, last_online_at = ?, lat = ?, lng = ?, loc_at = ? WHERE user_id = ?',
        t, t, t, person.lat + b.at[0], person.lng + b.at[1], t, b.id);
    }
  }
}

function moveBot(id, lat, lng) {
  const t = now();
  run('UPDATE drivers SET lat = ?, lng = ?, loc_at = ?, heartbeat_at = ? WHERE user_id = ?', lat, lng, t, t, id);
  run('UPDATE users SET lat = ?, lng = ?, loc_at = ? WHERE id = ?', lat, lng, t, id);
}

// A simulated rider's order near a real driver: on the market, or offered to them directly.
async function botOrder(driverUser, { planned = false, offerTo = null, bidCents = 950 } = {}) {
  const pickup = { lat: driverUser.lat + 0.003, lng: driverUser.lng + 0.002 };
  const dropoff = { lat: driverUser.lat + 0.018, lng: driverUser.lng + 0.012 };
  const way = await routing.route(pickup, dropoff);
  const t = now();
  const id = uid('r_');
  insertRide({
    id, rider_id: BOT_RIDER, status: offerTo ? 'offered' : 'open', mode: 'bid', created_at: t, scheduled_at: planned ? t + 2 * 3600_000 : null,
    pickup_lat: pickup.lat, pickup_lng: pickup.lng, pickup_label: 'Near you', pickup_moved_m: 0,
    dropoff_lat: dropoff.lat, dropoff_lng: dropoff.lng, dropoff_label: 'A demo destination', dropoff_moved_m: 0,
    polyline: way.polyline, distance_m: way.distanceM, duration_s: way.durationS, passengers: 1, pets: 0, vehicle: null,
    price_cents: offerTo ? bidCents : null, max_cents: bidCents, coin: 'sol', coin_units: 0, eur_per_coin: 0,
    offered_to: offerTo, offered_until: offerTo ? t + rules.offerTime : null, pickup_m: offerTo ? 400 : null, pickup_eta_at: offerTo ? t + 120_000 : null,
  });
  bump(driverUser.id);
  return id;
}

// Every few seconds, only while someone is on a demo account: plays the other side of the ride.
export async function runDemo() {
  const t = now();
  const people = all(`SELECT * FROM users WHERE is_demo = 1 AND id NOT LIKE 'demo-%' AND deleted_at IS NULL AND last_seen_at > ?`, t - 10 * 60_000);
  if (!people.length) return;
  for (const person of people) {
    placeBots(person);
    await asRider(person, t);
    await asDriver(person, t);
    chat(person, t);
  }
}

// Simulated people have keys like anyone. A driver answers as soon as the rule allows it, and a rider writes first.
function botKeys(botId) {
  let saved = getMeta(`demo:key:${botId}`);
  if (!saved) {
    saved = JSON.stringify(newKeys());
    setMeta(`demo:key:${botId}`, saved);
  }
  const keys = JSON.parse(saved);
  run('UPDATE users SET e2e_key = ? WHERE id = ? AND e2e_key IS NOT ?', keys.publicKey, botId, keys.publicKey);
  return keys;
}

function botSay(botId, person, words) {
  const { publicKey, privateKey } = botKeys(botId);
  addMessage(get('SELECT * FROM users WHERE id = ?', botId), person, seal(chatKey(privateKey, publicKey, person.e2e_key), words), publicKey, person.e2e_key);
}

function chat(person, t) {
  // Every time: a simulated person can be made after this first runs.
  for (const b of [...BOTS.map((x) => x.id), BOT_RIDER]) botKeys(b);
  if (!person.e2e_key) return;
  for (const c of all(`SELECT * FROM conversations WHERE rider_id = ? AND driver_id LIKE 'demo-%' AND last_at < ?`, person.id, t - 3000)) {
    const last = get('SELECT sender_id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.id);
    const sent = get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id = ?', c.id, person.id).n;
    if (last?.sender_id === person.id && sent >= rules.messagesInARow) botSay(c.driver_id, person, 'Thanks for your messages! This is a simulated driver. See you soon.');
  }
  // On a demo drive, the simulated rider writes first, so the reviewer can see a driver's side of a chat.
  const drive = get(`SELECT * FROM rides WHERE driver_id = ? AND rider_id = ? AND status IN ('accepted', 'arrived', 'riding') LIMIT 1`, person.id, BOT_RIDER);
  if (drive && !get('SELECT 1 AS x FROM conversations WHERE rider_id = ? AND driver_id = ?', BOT_RIDER, person.id)) {
    for (const words of ['Hi, I’m at the pickup.', 'I have one small bag.', 'This is a simulated rider, by the way.']) botSay(BOT_RIDER, person, words);
  }
}

async function asRider(person, t) {
  // A driver takes it after a few seconds, then comes to wherever the reviewer is.
  for (const r of all(`SELECT * FROM rides WHERE rider_id = ? AND status IN ('offered', 'open', 'accepted', 'arrived', 'riding')`, person.id)) {
    if (r.status === 'offered' && isBot(r.offered_to) && t - (r.offered_until - rules.offerTime) > 3000) {
      tx(() => assignDriver(r, r.offered_to, r.price_cents, r.pickup_m, 40));
      bump(person.id);
    } else if (r.status === 'open' && t - r.created_at > 6000) {
      const free = BOTS.find((b) => !isBusy(b.id) && get('SELECT seats FROM cars WHERE id = ?', driverRow(b.id).active_car_id).seats >= r.passengers);
      if (free) {
        tx(() => assignDriver(r, free.id, r.max_cents, 800, 40));
        bump(person.id);
      }
    } else if (r.status === 'accepted' && isBot(r.driver_id)) {
      const d = driverRow(r.driver_id);
      const away = metres(d.lat, d.lng, person.lat, person.lng);
      if (away < 60) {
        arrive(r, t);
      } else {
        // The rest of the way in about 25 seconds.
        moveBot(r.driver_id, d.lat + (person.lat - d.lat) * 0.2, d.lng + (person.lng - d.lng) * 0.2);
      }
      bump(person.id);
    } else if (r.status === 'arrived' && isBot(r.driver_id)) {
      moveBot(r.driver_id, person.lat + 0.0002, person.lng + 0.0002);
      bump(person.id);
    } else if (r.status === 'riding' && isBot(r.driver_id)) {
      const line = decodePolyline(r.polyline);
      const share = Math.min(1, (t - r.checked_in_at) / 40_000);
      const at = line[Math.min(line.length - 1, Math.floor(share * (line.length - 1)))];
      if (at) moveBot(r.driver_id, at[0], at[1]);
      if (share >= 1) complete(rideRow(r.id));
      else bump(person.id);
    }
  }
}

async function asDriver(person, t) {
  const me = driverRow(person.id);
  if (!me?.online_since || person.lat == null) return;
  const drive = get(`SELECT * FROM rides WHERE driver_id = ? AND status IN ('accepted', 'arrived', 'riding') LIMIT 1`, person.id);
  if (drive) {
    if (drive.status === 'accepted' && t - drive.accepted_at > 8000) arrive(drive, t);
    else if (drive.status === 'arrived' && t - (drive.arrived_at ?? t) > 6000) botCheckIn(drive, t);
    return;
  }
  const open = all(`SELECT id, scheduled_at FROM rides WHERE rider_id = ? AND status = 'open'`, BOT_RIDER);
  if (!open.some((o) => !o.scheduled_at)) await botOrder(person);
  if (me.allows_planning && !open.some((o) => o.scheduled_at)) await botOrder(person, { planned: true, bidCents: 1400 });
  // Now and then an offer with its countdown.
  const offered = get(`SELECT 1 AS x FROM rides WHERE offered_to = ? AND status = 'offered'`, person.id);
  if (!offered && t - (lastOffer.get(person.id) ?? 0) > 120_000) {
    lastOffer.set(person.id, t);
    await botOrder(person, { offerTo: person.id, bidCents: 780 });
  }
}

