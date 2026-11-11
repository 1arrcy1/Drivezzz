// What a ride costs with whom. A price is an open market rate, set per car: the way to the pickup
// (voorrijkosten) at the car's pickup rate, plus the ride per km and per minute.
import { all, get, now } from './db.js';
import { rules } from './config.js';
import { metres } from './geo.js';
import { manyToOne } from './routing.js';
import { driverCard, driverCards, driversAround, driverStats, fillDrivers, isDemoUser, rankDrivers } from './drivers.js';
import { blockedIds } from './safety.js';
import { enabledCoinsOf, PAY_IDS } from './wallet.js';
import { showsToRiders } from './checks.js';

export function fareCents(car, { pickupM, distanceM, durationS }) {
  const cents = (pickupM / 1000) * car.pickup_per_km_cents + (distanceM / 1000) * car.per_km_cents + (durationS / 60) * car.per_min_cents;
  return Math.max(rules.minFareCents, Math.round(cents));
}

// Right now: online, free drivers around the pickup, cheapest first. `sort` says who gets looked at when there are too many.
export async function offersNow({ pickup, route, passengers, pets, coin, driverId, vehicle, viewerId, sort = 'cheapest', fresh = false }) {
  const around = (km) => driversAround({ ...pickup, radiusM: km * 1000, seats: passengers, pets, coin, vehicle, viewerId, fresh });
  // With plenty of drivers close by there's no need to look through everyone: the way to the pickup is in the price, so someone far away is
  // rarely the cheapest. Further away is only for when there are few. For stars or being on time, a little further anyway.
  let list = [];
  if (!driverId) {
    for (const km of sort === 'stars' || sort === 'onTime' ? [rules.defaultRadiusKm] : [3, rules.defaultRadiusKm]) {
      list = around(km);
      if (list.length >= 60) break;
    }
  }
  if (list.length < rules.driversShown + 10) list = around(rules.maxRadiusKm);
  if (driverId) list = list.filter((x) => x.user_id === driverId);
  // Roads are asked for the first few, going by a straight line; the rest doesn't need the server's time.
  // Not the closest few: with many drivers online, the cheapest might be further away.
  const guess = (x) => fareCents(x, { pickupM: metres(pickup.lat, pickup.lng, x.lat, x.lng) * 1.3, distanceM: route.distanceM, durationS: route.durationS });
  const near = fillDrivers(rankDrivers(list, pickup, sort, guess, rules.driversShown + 10), rules.driversShown, viewerId);
  const ways = await manyToOne(near.map(({ d, spot }) => ({ lat: spot?.lat ?? d.lat, lng: spot?.lng ?? d.lng })), pickup);
  const cards = driverCards(near, pickup);
  return near.map(({ car }, i) => ({
    ...cards[i],
    priceCents: fareCents(car, { pickupM: ways[i].distanceM, distanceM: route.distanceM, durationS: route.durationS }),
    pickupM: ways[i].distanceM,
    pickupS: ways[i].durationS,
  })).sort((a, b) => a.priceCents - b.priceCents || a.pickupS - b.pickupS);
}

const endOf = (r) => r.scheduled_at + r.duration_s * 1000;

// For a planned time: drivers who allow planning that far ahead, were online in the last 24 hours and are near,
// with their other planned drives taken into account. A driver dropping someone near your pickup just before has short voorrijkosten,
// so the cheapest driver is often the one already coming your way. A driver whose drives don't fit is left out.
export async function offersPlanned({ pickup, dropoff, route, when, passengers, pets, coin, driverId, excludeRideId, vehicle, viewerId }) {
  const t = now();
  const demo = isDemoUser(viewerId);
  const hidden = viewerId ? blockedIds(viewerId) : new Set();
  const rows = all(`SELECT d.*, u.name AS user_name FROM drivers d JOIN users u ON u.id = d.user_id
                    WHERE d.allows_planning = 1 AND d.last_online_at > ? AND d.lat IS NOT NULL AND d.active_car_id IS NOT NULL AND u.deleted_at IS NULL AND u.is_demo = ?`, t - rules.bookableWindow, demo ? 1 : 0);
  const allowed = rows.filter((d) => (!driverId || d.user_id === driverId) && d.user_id !== viewerId && !hidden.has(d.user_id) && when <= t + d.plan_days * 86_400_000);
  const ids = JSON.stringify(allowed.map((d) => d.user_id));
  const cars = new Map(all('SELECT * FROM cars WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))', JSON.stringify(allowed.map((d) => d.active_car_id))).map((c) => [c.id, c]));
  const wallets = coin && !demo ? enabledCoinsOf(allowed.map((d) => d.user_id)) : null;
  // A planned drive waiting for its payment is spoken for too.
  const plannedBy = new Map();
  for (const r of all(`SELECT * FROM rides WHERE driver_id IN (SELECT value FROM json_each(?)) AND (status IN ('scheduled', 'accepted', 'arrived', 'riding') OR (status = 'awaiting_payment' AND scheduled_at IS NOT NULL)) ORDER BY COALESCE(scheduled_at, accepted_at)`, ids)) {
    if (r.id === excludeRideId) continue;
    if (!plannedBy.has(r.driver_id)) plannedBy.set(r.driver_id, []);
    plannedBy.get(r.driver_id).push(r);
  }
  const candidates = [];
  for (const d of allowed) {
    const car = cars.get(d.active_car_id);
    if (!car || car.seats < passengers) continue;
    if (!showsToRiders({ verified_at: d.verified_at, vehicle: car.vehicle, is_demo: demo, lat: pickup.lat, lng: pickup.lng })) continue;
    if (pets && !car.pets_allowed) continue;
    if (vehicle && car.vehicle !== vehicle) continue;
    if (coin && !(demo ? PAY_IDS : wallets.get(d.user_id)).includes(coin)) continue;
    const dated = (plannedBy.get(d.user_id) ?? []).map((r) => ({ ...r, scheduled_at: r.scheduled_at ?? r.accepted_at }));
    const before = dated.filter((r) => endOf(r) <= when).at(-1) ?? null;
    const after = dated.find((r) => r.scheduled_at >= when) ?? null;
    if (dated.some((r) => r.scheduled_at < when && endOf(r) > when)) continue;
    const from = before ? { lat: before.dropoff_lat, lng: before.dropoff_lng } : { lat: d.lat, lng: d.lng };
    const away = metres(from.lat, from.lng, pickup.lat, pickup.lng);
    if (away > rules.maxRadiusKm * 1000) continue;
    candidates.push({ d, car, from, before, after, guess: fareCents(car, { pickupM: away * 1.3, distanceM: route.distanceM, durationS: route.durationS }) });
  }
  // Roads are asked for the cheapest few, as for a ride right now.
  candidates.sort((a, b) => a.guess - b.guess);
  candidates.length = Math.min(candidates.length, rules.driversShown + 10);
  const stats = driverStats(candidates.map((c) => c.d.user_id));
  const ways = await manyToOne(candidates.map((c) => c.from), pickup);
  const offers = [];
  for (let i = 0; i < candidates.length; i++) {
    const { d, car, before, after } = candidates[i];
    const way = ways[i];
    const freeAt = before ? endOf(before) : t;
    if (freeAt + way.durationS * 1000 + rules.planBuffer > when) continue;
    const rideEnd = when + route.durationS * 1000;
    if (after) {
      const [next] = await manyToOne([dropoff], { lat: after.pickup_lat, lng: after.pickup_lng });
      if (rideEnd + next.durationS * 1000 + rules.planBuffer > after.scheduled_at) continue;
    }
    offers.push({
      ...driverCard(d, { name: d.user_name }, car, pickup, { stats: stats.get(d.user_id) }),
      lat: null, lng: null,
      priceCents: fareCents(car, { pickupM: way.distanceM, distanceM: route.distanceM, durationS: route.durationS }),
      pickupM: way.distanceM,
      pickupS: way.durationS,
      afterAnotherDrive: Boolean(before),
    });
  }
  return offers.sort((a, b) => a.priceCents - b.priceCents || b.ratingCount - a.ratingCount);
}
