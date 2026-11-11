// A ride from order to payout. Ordering costs nothing; the rider pays once a driver has it, into the ride's own escrow
// on Solana (escrow.js), and the escrow pays out, splits or refunds when it's over.
//
//   searching         being offered to the cheapest drivers nearby
//   offered           one driver has 5 minutes to accept; not answering puts them offline, and it goes to the next cheapest
//   open              on the market: any driver can claim it at the rider's price. Every planned order starts here, as
//                     nobody has it until they claim it; a driver the rider chose has it to themselves at first (offered_to)
//   awaiting_payment  a driver has it and can set off; the rider pays within 5 minutes (planned: up to 30 minutes before)
//   scheduled         planned for later, with a driver, paid
//   accepted          paid; the driver is on the way. Past pickup_deadline_at the rider can cancel for a full refund
//   arrived           the driver reached the pickup; the rider checks in once in the car. Their 10 minutes start with a full stop
//   riding            checked in; rider and driver are compared along the way. A driver cancelling now refunds it all
//   completed         checked out at the drop-off; the escrow pays out after 24 hours, unless someone appeals
//   cancelled         what was paid is refunded, or split 50/50 (see riderRefundPercent and the driver's cancel)
//
// A ride paid in cash (`coin` is 'cash') goes the same way with the same checks, but past awaiting_payment: no escrow, no
// refund and no 50/50, as nothing is held, and no €0.10, as it can't be taken. It says paid in cash once checked out.
import crypto from 'node:crypto';
import { all, get, getMeta, now, run, setMeta, tx, uid } from './db.js';
import { config, rules } from './config.js';
import { ApiError, limit, num, route, text } from './http.js';
import { requireUser } from './auth.js';
import { VEHICLES } from './rdw.js';
import { decodePolyline, metres, metresToLine, validPoint } from './geo.js';
import * as routing from './routing.js';
import { ACTIVE_STATUSES, activeCarReady, areaAround, driverRow, forgetDriverStats, forgetLooksOf, isBusy, isDemoUser, isDriving, isOnRide, isOnline, publicCar, requireDriver, setOffline, setOnline, reviewStats, arrivalScore, SORTS } from './drivers.js';
import { offersNow, offersPlanned } from './pricing.js';
import { bump } from './sync.js';
import { notify } from './push.js';
import { setOnBan } from './standing.js';
import { blockedBetween, blockedIds } from './safety.js';
import { unreadFor } from './messages.js';
import { findBlocked } from './filter.js';
import { knownPriceEur, network as chainNetwork } from './coins.js';
import { canPayWith, CASH, enabledCoins, fromUnits, payoutAddress, unitsFor } from './wallet.js';
import { checksError, checksNeeded, checksSummary, requireNetherlands } from './checks.js';
import * as escrow from './escrow.js';

const STATUS_ACTIVE = `('accepted', 'arrived', 'riding')`;
const rideRow = (id) => get('SELECT * FROM rides WHERE id = ?', id);
const isDemoRide = (r) => isDemoUser(r.rider_id);
const isCash = (r) => r.coin === CASH;
export const event = (rideId, kind, detail) => run('INSERT INTO ride_events (id, ride_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)', uid('ev_'), rideId, now(), kind, detail ?? null);
// Something about the ride changed. A driver it was offered to, who has it or who's free again is no longer what riders' maps showed.
const touchBoth = (r) => { bump(r.rider_id); bump(r.driver_id); bump(r.offered_to); forgetLooksOf(r.driver_id); forgetLooksOf(r.offered_to); };

export const syncScore = (r) => (r.sync_ok + r.sync_off ? Math.round((r.sync_ok / (r.sync_ok + r.sync_off)) * 100) / 100 : null);

function place(p) {
  const lat = num(p?.lat), lng = num(p?.lng);
  if (!validPoint(lat, lng)) throw new ApiError(400, 'bad_place', 'That place could not be used.');
  const label = text(p.label, 140);
  // Drivers read this, so nothing that isn't allowed in a name.
  return { lat, lng, label: (!findBlocked(label) && label) || null };
}

// ---------- what the app sees ----------

// How long the driver still needs to the pickup, asked of the roads at most once a minute per ride.
const etas = new Map();
function askEta(r, lat, lng, t) {
  const known = etas.get(r.id);
  if (known && t - known.at < 60_000) return;
  if (etas.size > 500) etas.clear();
  etas.set(r.id, { at: t, seconds: known?.seconds ?? null });
  routing.manyToOne([{ lat, lng }], { lat: r.pickup_lat, lng: r.pickup_lng })
    .then(([way]) => etas.set(r.id, { at: t, seconds: way.durationS }))
    .catch(() => {});
}
function driverEtaS(r, t) {
  const known = etas.get(r.id);
  if (known?.seconds != null) return Math.max(0, Math.round(known.seconds - (t - known.at) / 1000));
  return r.pickup_eta_at ? Math.max(0, Math.round((r.pickup_eta_at - t) / 1000)) : null;
}

// Late: past their time to reach the pickup, and not there in time. It stays that way until the rider is in the car, also
// once the driver has come, so a rider can always walk away from a late driver for free.
export function driverIsLate(r, t = now()) {
  if (!['accepted', 'arrived'].includes(r.status) || !r.pickup_deadline_at || t <= r.pickup_deadline_at) return false;
  return !(r.arrived_at && r.arrived_at <= r.pickup_deadline_at);
}
// Until when a rider who paid gets everything back, with the driver on time: only a planned ride has such a time.
const freeUntil = (r) => (!isCash(r) && r.status === 'scheduled' && r.driver_id ? r.scheduled_at - rules.planCancelFree : null);

// The ride's price in its coin: what a wallet was last asked to pay, or else at the price of the last few minutes. Paying asks for
// the latest price, so it can differ a little from this.
function payQuote(r) {
  const asked = get(`SELECT units, eur_per_coin FROM escrows WHERE ride_id = ? AND status = 'requested' ORDER BY created_at DESC LIMIT 1`, r.id);
  if (asked?.units && asked.eur_per_coin) return { payAmount: fromUnits(r.coin, BigInt(asked.units)), eurPerCoin: asked.eur_per_coin };
  const eur = r.price_cents ? knownPriceEur(r.coin) : null;
  return eur ? { payAmount: fromUnits(r.coin, unitsFor(r.coin, r.price_cents, eur)), eurPerCoin: eur } : {};
}

export function publicRide(r, viewerId) {
  const asRider = r.rider_id === viewerId;
  const live = ACTIVE_STATUSES.includes(r.status);
  // A driver who has it can set off before it's paid, and the rider can watch them come.
  const coming = r.status === 'accepted' || (r.status === 'awaiting_payment' && !r.scheduled_at);
  const t = now();
  const out = {
    id: r.id, status: r.status, mode: r.mode, scheduledAt: r.scheduled_at,
    role: asRider ? 'rider' : 'driver',
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng, label: r.pickup_label, movedM: r.pickup_moved_m },
    dropoff: { lat: r.dropoff_lat, lng: r.dropoff_lng, label: r.dropoff_label, movedM: r.dropoff_moved_m },
    polyline: r.polyline, distanceM: r.distance_m, durationS: r.duration_s,
    passengers: r.passengers, pets: Boolean(r.pets), vehicle: r.vehicle,
    priceCents: r.price_cents, maxCents: r.max_cents, feeCents: rules.feeCents,
    coin: r.coin, coinAmount: r.coin_units ? fromUnits(r.coin, r.coin_units) : null,
    // For the rider: what cancelling now gives back, and until when a planned ride with a driver is free to cancel.
    ...(asRider ? { refundPercent: riderRefundPercent(r, t), freeCancelUntil: freeUntil(r) } : {}),
    pickupDeadlineAt: r.pickup_deadline_at, driverLate: !isCash(r) && driverIsLate(r, t),
    driverEtaS: coming && r.driver_id ? driverEtaS(r, t) : null,
    // A driver stopped at the pickup can cancel for half the price from this time, if the rider still hasn't checked in.
    noShowFrom: !isCash(r) && r.status === 'arrived' && r.waiting_since ? r.waiting_since + rules.riderNoShow : null,
    createdAt: r.created_at, acceptedAt: r.accepted_at, arrivedAt: r.arrived_at, pickupEtaAt: r.pickup_eta_at, pickupM: r.pickup_m,
    checkedInAt: r.checked_in_at, checkedOutAt: r.checked_out_at,
    cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by, cancelReason: r.cancel_reason,
    offeredUntil: asRider || r.offered_to === viewerId ? r.offered_until : null,
    syncScore: syncScore(r), reviewRequired: Boolean(r.review_required),
    now: t,
  };
  if (r.driver_id) {
    const d = driverRow(r.driver_id);
    const u = get('SELECT name FROM users WHERE id = ?', r.driver_id);
    const car = r.car_id ? get('SELECT * FROM cars WHERE id = ?', r.car_id) : null;
    out.driver = {
      id: r.driver_id, name: u?.name ?? 'Driver', car: publicCar(car), ...reviewStats(r.driver_id), ...arrivalScore(r.driver_id),
      lat: (live || coming) && asRider ? d?.lat : null, lng: (live || coming) && asRider ? d?.lng : null, heading: (live || coming) && asRider ? d?.heading : null, locAt: live || coming ? d?.loc_at : null,
    };
    // How far the driver still is from the pickup, in a straight line, for the rider waiting: it changes with every position.
    if (asRider && coming && d?.lat != null) out.driverToPickupM = Math.round(metres(d.lat, d.lng, r.pickup_lat, r.pickup_lng));
  }
  // A driver knows who to expect and where to go, not where the rider is: the pickup spot is where they wait (Pieter's decision, 5 November 2026).
  if (!asRider) {
    const u = get('SELECT name FROM users WHERE id = ?', r.rider_id);
    out.rider = { id: r.rider_id, name: u?.name ?? 'Rider' };
  }
  if (live && r.driver_id) {
    const d = driverRow(r.driver_id);
    const rider = get('SELECT lat, lng, loc_at FROM users WHERE id = ?', r.rider_id);
    const fresh = (at) => at && t - at < rules.locationFresh;
    // For the rider only: how far apart the two phones are would give a driver the rider's position after all.
    if (asRider && d?.lat != null && rider?.lat != null && fresh(d.loc_at) && fresh(rider.loc_at)) {
      out.apartM = Math.round(metres(d.lat, d.lng, rider.lat, rider.lng));
      out.canCheckIn = r.status !== 'riding' && out.apartM <= rules.checkInRadius;
    }
    if (r.status === 'arrived' && isDemoRide(r)) out.canCheckIn = true;
    if (r.status === 'riding') {
      out.driverToDropoffM = d?.lat != null ? Math.round(metres(d.lat, d.lng, r.dropoff_lat, r.dropoff_lng)) : null;
      // Check-out opens this close to the drop-off: the app keeps the button grey until then.
      out.checkOutM = rules.checkOutRadius;
      out.riderToDropoffM = rider?.lat != null && fresh(rider.loc_at) ? Math.round(metres(rider.lat, rider.lng, r.dropoff_lat, r.dropoff_lng)) : null;
      out.safetyAsked = Boolean(asRider && r.safety_asked_at && !r.safety_answer);
    }
  }
  if (r.status === 'awaiting_payment') {
    out.payBy = r.pay_by;
    out.network = chainNetwork();
    // A Solana Pay link: the wallet asks our server for the payment, then the rider approves it.
    if (asRider && r.pay_token) out.payUrl = `solana:${encodeURIComponent(`${config.baseUrl}/api/pay/${r.pay_token}`)}`;
    // A test server has no chain for a wallet to pay on: the app offers to pay as if with one (/dev/pay).
    if (asRider && escrow.pretendChain()) out.testPay = true;
    // What it comes to in the coin, for the pay card: what the wallet was asked for, or at the latest price (Pieter, 8 November 2026).
    if (asRider && !isCash(r)) Object.assign(out, payQuote(r));
  }
  const paid = escrow.paidEscrow(r.id);
  if (paid) out.escrow = escrow.publicEscrow(paid);
  out.checkoutWarning = Boolean(r.checkout_warning);
  if (r.status === 'completed' || r.status === 'cancelled') {
    const p = get(`SELECT status, due_at, coin, units, eur_cents, confirmed_at FROM payouts WHERE ride_id = ? AND kind = 'payout' ORDER BY created_at DESC LIMIT 1`, r.id);
    if (p) out.payout = { status: p.status, dueAt: p.due_at, amount: isCash(r) ? null : fromUnits(p.coin, p.units), eurCents: p.eur_cents };
    const rev = get('SELECT stars, text FROM reviews WHERE ride_id = ?', r.id);
    if (rev) out.review = rev;
    const dis = get('SELECT status, answer, message, created_at FROM disputes WHERE ride_id = ? ORDER BY created_at DESC LIMIT 1', r.id);
    if (dis) out.dispute = { status: dis.status, answer: dis.answer, message: dis.message, at: dis.created_at };
  }
  return out;
}

// ---------- quoting ----------

async function plan(body) {
  const rawPickup = place(body.pickup), rawDropoff = place(body.dropoff);
  if (metres(rawPickup.lat, rawPickup.lng, rawDropoff.lat, rawDropoff.lng) < 100) throw new ApiError(400, 'too_close', 'That’s the same place as your pickup.');
  const [pickupSnap, dropoffSnap] = await Promise.all([routing.snap(rawPickup), routing.snap(rawDropoff)]);
  const pickup = { ...rawPickup, lat: pickupSnap.lat, lng: pickupSnap.lng, movedM: pickupSnap.movedM + (num(body.pickup.movedM) ?? 0), road: pickupSnap.road };
  const dropoff = { ...rawDropoff, lat: dropoffSnap.lat, lng: dropoffSnap.lng, movedM: dropoffSnap.movedM + (num(body.dropoff.movedM) ?? 0), road: dropoffSnap.road };
  const way = await routing.route(pickup, dropoff);
  const passengers = Math.round(num(body.passengers) ?? 1);
  if (passengers < 1 || passengers > 16) throw new ApiError(400, 'bad_passengers', 'How many people are coming?');
  const pets = body.pets === true;
  const coin = body.coin == null ? null : String(body.coin);
  if (coin && !canPayWith(coin)) throw new ApiError(400, 'bad_coin', 'Pay with USDC, SOL or cash.');
  let when = null;
  if (body.scheduledAt != null) {
    when = num(body.scheduledAt);
    const t = now();
    if (!when || when < t + 15 * 60_000) throw new ApiError(400, 'too_soon', 'Plan a ride at least 15 minutes ahead, or book now.');
    if (when > t + rules.maxPlanDays * 86_400_000) throw new ApiError(400, 'too_far_ahead', `Plan a ride up to ${rules.maxPlanDays} days ahead.`);
  }
  const vehicle = VEHICLES.includes(body.vehicle) ? body.vehicle : null;
  return { pickup, dropoff, way, passengers, pets, coin, when, vehicle, sort: SORTS.includes(body.sort) ? body.sort : 'cheapest' };
}

async function offersFor(p, driverId, excludeRideId) {
  const q = { pickup: p.pickup, dropoff: p.dropoff, route: p.way, passengers: p.passengers, pets: p.pets, coin: p.coin, vehicle: p.vehicle, driverId, viewerId: p.userId, sort: p.sort, fresh: p.fresh };
  return p.when ? offersPlanned({ ...q, when: p.when, excludeRideId }) : offersNow(q);
}

route('POST', '/api/quote', async (ctx) => {
  const viewer = requireUser(ctx);
  if (!limit(`quote:${viewer.id}`, 60, 60_000)) throw new ApiError(429, 'too_many', 'Too many requests. Wait a moment.');
  const p = await plan(ctx.body);
  p.userId = viewer.id;
  const offers = await offersFor(p, ctx.body.driverId ? String(ctx.body.driverId) : null);
  // What most drivers around here would charge, as a start for naming your own price.
  const middle = offers.length ? offers[Math.floor(offers.length / 2)].priceCents : Math.max(rules.minFareCents, Math.round((p.way.distanceM / 1000) * 100 + (p.way.durationS / 60) * 20));
  return {
    pickup: p.pickup, dropoff: p.dropoff, polyline: p.way.polyline, distanceM: p.way.distanceM, durationS: p.way.durationS,
    estimated: p.way.estimated, scheduledAt: p.when, offers: offers.slice(0, rules.driversShown), suggestedBidCents: middle,
    autoCushion: rules.autoCushion,
  };
});

// ---------- ordering ----------

function rideValues(p, extra) {
  return {
    pickup_lat: p.pickup.lat, pickup_lng: p.pickup.lng, pickup_label: p.pickup.label, pickup_moved_m: p.pickup.movedM,
    dropoff_lat: p.dropoff.lat, dropoff_lng: p.dropoff.lng, dropoff_label: p.dropoff.label, dropoff_moved_m: p.dropoff.movedM,
    polyline: p.way.polyline, distance_m: p.way.distanceM, duration_s: p.way.durationS, passengers: p.passengers, pets: p.pets ? 1 : 0,
    vehicle: p.vehicle, scheduled_at: p.when, ...extra,
  };
}
export function insertRide(values) {
  const keys = Object.keys(values);
  run(`INSERT INTO rides (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => values[k]));
}

route('POST', '/api/rides', async (ctx) => {
  const user = requireUser(ctx);
  const body = ctx.body;
  if (!limit(`order:${user.id}`, 20, 60_000)) throw new ApiError(429, 'too_many', 'Too many requests. Wait a moment.');
  if (isDriving(user.id)) throw new ApiError(409, 'on_a_drive', 'Finish your drive first.');
  const mode = ['auto', 'driver', 'bid'].includes(body.mode) ? body.mode : 'auto';
  if (!canPayWith(body.coin)) throw new ApiError(400, 'bad_coin', 'Choose what you pay with.');
  requireNetherlands(user, num(body.pickup?.lat), num(body.pickup?.lng), 'ride');
  const p = await plan(body);
  p.userId = user.id;
  p.fresh = true;   // a booking goes by who's there right now
  // One order at a time: while one is going there's no ordering, planning or choosing another driver.
  const busy = get(`SELECT id FROM rides WHERE rider_id = ? AND (status IN ('accepted', 'arrived', 'riding') OR (scheduled_at IS NULL AND status IN ('searching', 'awaiting_payment', 'offered', 'open')))`, user.id);
  if (busy) throw new ApiError(409, 'has_ride', 'You already have an order going. Cancel it first if you want another.', { rideId: busy.id });
  if (get(`SELECT COUNT(*) AS n FROM rides WHERE rider_id = ? AND status IN ('awaiting_payment', 'open', 'scheduled')`, user.id).n >= 20) {
    throw new ApiError(409, 'too_many', 'You have too many rides booked.');
  }
  let maxCents, driverId = null, offers = [];
  if (mode === 'bid') {
    maxCents = Math.round(num(body.bidCents) ?? 0);
    if (maxCents < rules.minFareCents || maxCents > 100_000) throw new ApiError(400, 'bad_bid', `Name a price between €${(rules.minFareCents / 100).toFixed(2)} and €1000.`);
  } else {
    const wanted = mode === 'driver' ? String(body.driverId ?? '') : null;
    if (mode === 'driver' && !wanted) throw new ApiError(400, 'no_driver', 'Choose a driver.');
    offers = await offersFor(p, wanted);
    if (!offers.length) throw new ApiError(409, mode === 'driver' ? 'driver_not_free' : 'no_drivers', mode === 'driver' ? 'This driver can’t take this ride.' : 'No drivers can take this ride right now. Name your price and drivers can claim it.');
    const offer = offers[0];
    const expected = num(body.expectedCents);
    if (expected != null && offer.priceCents > expected * 1.1) {
      throw new ApiError(409, 'price_changed', 'Prices just changed. Have a look.', { offers: offers.slice(0, 30) });
    }
    maxCents = mode === 'auto' && !p.when ? Math.round(offer.priceCents * rules.autoCushion) : offer.priceCents;
    if (mode === 'driver') driverId = offer.id;
  }
  const id = uid('r_');
  const t = now();
  // Nothing is paid yet: the amount in the coin is fixed when the rider pays, once a driver has it (cash: at the end). No wallet is needed for
  // this either: the rider picks one when paying. A planned order waits for a driver to claim it, and one the rider chose
  // has it to themselves at first, leaving the others time to claim it.
  const chosen = p.when ? driverId : null;
  insertRide(rideValues(p, {
    id, rider_id: user.id, status: mode === 'bid' || p.when ? 'open' : 'searching', mode, created_at: t,
    max_cents: maxCents, coin: body.coin, coin_units: 0, fee_units: 0, eur_per_coin: 0,
    queue: !p.when && driverId ? JSON.stringify([driverId]) : null,
    offered_to: chosen, offered_until: chosen ? t + Math.min(rules.planFirstLook, Math.round((p.when - t) / 2)) : null,
  }));
  event(id, 'ordered', `${mode}, max ${maxCents} cents in ${body.coin}`);
  if (mode !== 'bid') {
    if (p.when) tellPlanned(rideRow(id), offers);
    else await dispatch(id);
  }
  return { ride: publicRide(rideRow(id), user.id) };
});

const plannedLine = (r) => `${new Date(r.scheduled_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${(r.price_cents ?? r.max_cents) / 100} euro`;

// Nobody has a planned order until they claim it, so the drivers whose price it meets hear that it's there.
function tellPlanned(r, drivers) {
  for (const d of drivers.filter((o) => o.priceCents <= r.max_cents).slice(0, 10)) {
    notify(d.id, r.offered_to ? 'A rider asks for you' : 'New planned order', `${plannedLine(r)}. Claim it to take it: ${isCash(r) ? 'the rider pays you in cash' : 'the rider pays once you have'}.`, { rideId: r.id, kind: 'planned' });
  }
}
// Only for telling them, so a problem with the roads can't get in the way of anything.
const plannedDrivers = (r, notId) => offersPlanned({
  pickup: { lat: r.pickup_lat, lng: r.pickup_lng }, dropoff: { lat: r.dropoff_lat, lng: r.dropoff_lng }, route: { distanceM: r.distance_m, durationS: r.duration_s },
  when: r.scheduled_at, passengers: r.passengers, pets: Boolean(r.pets), coin: r.coin, vehicle: r.vehicle, excludeRideId: r.id, viewerId: r.rider_id,
}).then((offers) => offers.filter((o) => o.id !== notId)).catch(() => []);

// Who to offer a ride-now to: the cheapest drivers its held amount covers. A chosen driver goes first.
async function dispatch(rideId) {
  const r = rideRow(rideId);
  const chosen = r.queue ? JSON.parse(r.queue)[0] : null;
  const q = {
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng }, dropoff: { lat: r.dropoff_lat, lng: r.dropoff_lng },
    route: { distanceM: r.distance_m, durationS: r.duration_s }, passengers: r.passengers, pets: Boolean(r.pets), coin: r.coin, vehicle: r.vehicle, viewerId: r.rider_id,
  };
  const declined = new Set(all(`SELECT detail FROM ride_events WHERE ride_id = ? AND kind IN ('declined', 'offer_expired')`, r.id).map((e) => e.detail));
  const offers = (await offersNow(q)).filter((o) => o.priceCents <= r.max_cents && !declined.has(o.id));
  if (chosen) offers.sort((a, b) => (b.id === chosen) - (a.id === chosen));
  run('UPDATE rides SET queue = ? WHERE id = ?', JSON.stringify(offers.map((o) => ({ id: o.id, priceCents: o.priceCents, pickupM: o.pickupM, pickupS: o.pickupS }))), r.id);
  offerNext(r.id);
}

export function offerNext(rideId) {
  const r = rideRow(rideId);
  if (!r || !['searching', 'offered'].includes(r.status)) return;
  // Whoever had it before is free again for riders' maps.
  forgetLooksOf(r.offered_to);
  const queue = r.queue ? JSON.parse(r.queue) : [];
  const t = now();
  while (queue.length) {
    const next = queue.shift();
    if (typeof next !== 'object') continue;
    const d = driverRow(next.id);
    if (!isOnline(d, t) || isBusy(next.id)) continue;
    if (get(`SELECT 1 AS x FROM rides WHERE offered_to = ? AND status = 'offered' AND offered_until > ? AND id != ?`, next.id, t, r.id)) continue;
    if (blockedBetween(next.id, r.rider_id)) continue;
    run(`UPDATE rides SET status = 'offered', offered_to = ?, offered_until = ?, price_cents = ?, pickup_m = ?, queue = ? WHERE id = ?`,
      next.id, t + rules.offerTime, next.priceCents, next.pickupM, JSON.stringify(queue), r.id);
    // The way to the pickup, for the promised time when accepted.
    run('UPDATE rides SET pickup_eta_at = ? WHERE id = ?', t + next.pickupS * 1000, r.id);
    notify(next.id, 'New ride', `€${(next.priceCents / 100).toFixed(2)} · ${(r.distance_m / 1000).toFixed(1)} km. Accept within ${rules.offerTime / 60_000} minutes, or you go offline.`, { rideId: r.id, kind: 'offer' });
    bump(r.rider_id);
    forgetLooksOf(next.id);
    return;
  }
  // Nobody left: it goes on the market at the most the rider said they'd pay.
  run(`UPDATE rides SET status = 'open', offered_to = NULL, offered_until = NULL, price_cents = NULL, pickup_m = NULL, pickup_eta_at = NULL, queue = NULL WHERE id = ?`, r.id);
  event(r.id, 'to_market');
  notify(r.rider_id, 'Still looking for a driver', 'Drivers nearby can see your order and claim it. You can also raise your price.', { rideId: r.id });
}

const startsLater = (r, t = now()) => Boolean(r.scheduled_at && r.scheduled_at - rules.planStart > t);

// A driver has the ride: now the rider pays, within 5 minutes (a planned ride: until 30 minutes before, at least 5 minutes).
// A demo ride or one paid in cash has nothing to pay now and goes straight on. The driver can set off straight away. Their time to reach the pickup
// is what it takes plus 30%, plus the 5 minutes for paying; after that they're late.
export function assignDriver(r, driverId, priceCents, pickupM, pickupS) {
  const t = now();
  const d = driverRow(driverId);
  const later = startsLater(r, t);
  const payNothing = isDemoRide(r) || isCash(r);
  const status = payNothing ? (later ? 'scheduled' : 'accepted') : 'awaiting_payment';
  const way = (pickupS ?? 0) * 1000;
  run(`UPDATE rides SET status = ?, driver_id = ?, car_id = ?, price_cents = ?, pickup_m = ?, offered_to = NULL, offered_until = NULL, queue = NULL,
       accepted_at = ?, pickup_eta_at = ?, pickup_deadline_at = ?, pay_by = ?, pay_token = ? WHERE id = ?`,
    status, driverId, d.active_car_id, priceCents, pickupM, t,
    // Promised for the planned time, or as soon as they can be there.
    later ? null : Math.max(r.scheduled_at ?? 0, t + way),
    later ? null : Math.max(r.scheduled_at ? r.scheduled_at + rules.planNoShow : 0, t + Math.round(way * rules.pickupSlack) + rules.payNow),
    payNothing ? null : later ? Math.max(t + rules.payNow, r.scheduled_at - rules.payPlannedBefore) : t + rules.payNow,
    payNothing ? null : crypto.randomBytes(18).toString('base64url'), r.id);
  event(r.id, later ? 'planned_with' : 'accepted', driverId);
}

// Who hears what once a driver has a ride.
function notifyAssigned(r) {
  const driver = get('SELECT name FROM users WHERE id = ?', r.driver_id)?.name ?? 'A driver';
  if (r.status === 'awaiting_payment') {
    const minutes = Math.max(1, Math.round((r.pay_by - now()) / 60_000));
    notify(r.rider_id, `${driver} accepted your ride`, `Pay €${(r.price_cents / 100).toFixed(2)} to confirm${r.scheduled_at ? '' : `, within ${minutes} minutes`}.`, { rideId: r.id, kind: 'pay' });
    notify(r.driver_id, r.scheduled_at ? 'New planned drive' : 'You can start driving', r.scheduled_at ? `${plannedLine(r)}. We tell you once it’s paid.` : `Head to the pickup. The rider has ${minutes} minutes to pay; we tell you when they have.`, { rideId: r.id });
  } else {
    const cash = isCash(r) ? `. Have €${(r.price_cents / 100).toFixed(2)} in cash ready.` : '';
    notify(r.rider_id, r.status === 'scheduled' ? 'A driver took your planned ride' : 'Your driver is on the way', driver + cash, { rideId: r.id });
  }
  touchBoth(r);
}

// The chain shows a payment (escrow.js). Only one counts per ride, and only for the driver it was made out to; any
// other, or one that came too late, is refunded straight away.
async function paid(e) {
  const r = rideRow(e.ride_id);
  const other = get(`SELECT 1 AS x FROM escrows WHERE ride_id = ? AND id != ? AND status IN ('paid', 'settling', 'settled')`, e.ride_id, e.id);
  const wanted = r && r.status === 'awaiting_payment' && !other && payoutAddress(r.driver_id, r.coin) === e.driver_address;
  if (!wanted) {
    escrow.decide(e.id, 'refund');
    event(e.ride_id, 'payment_refunded', e.id);
    if (r) notify(r.rider_id, 'Your payment goes back', 'It came in after the ride was no longer waiting for it. It’s refunded to your wallet.', { rideId: r.id });
    return;
  }
  const t = now();
  const later = startsLater(r, t);
  // The driver may have reached the pickup already while the rider was paying.
  const there = !later && Boolean(r.arrived_at);
  tx(() => {
    run(`UPDATE rides SET status = ?, coin_units = ?, fee_units = ?, eur_per_coin = ?, pay_token = NULL, held = 1 WHERE id = ? AND status = 'awaiting_payment'`,
      later ? 'scheduled' : there ? 'arrived' : 'accepted', e.units, e.fee_units, e.eur_per_coin, r.id);
    event(r.id, 'paid', e.id);
  });
  const fresh = rideRow(r.id);
  notify(r.driver_id, later ? 'Paid: see you then' : 'It’s paid', later ? plannedLine(fresh) : `€${(r.price_cents / 100).toFixed(2)} is in escrow. ${there ? 'The rider checks in once they’re in the car.' : 'Keep going to the pickup.'}`, { rideId: r.id, kind: later ? 'planned' : 'paid' });
  if (there) notify(r.rider_id, 'Your driver is here', 'Check the number plate, get in, then check in.', { rideId: r.id, kind: 'arrived' });
  touchBoth(fresh);
}


route('POST', '/api/rides/:id/accept', async (ctx) => {
  const { user } = requireDriver(ctx);
  const r = rideRow(ctx.params.id);
  if (!r || r.offered_to !== user.id || r.status !== 'offered' || r.offered_until < now()) throw new ApiError(409, 'offer_gone', 'This ride is no longer available.');
  if (isBusy(user.id)) throw new ApiError(409, 'on_a_ride', 'Finish your ride first.');
  if (!driverRow(user.id).active_car_id) throw new ApiError(409, 'need_car', 'Choose a car on My page first.');
  await requireChecks(user, driverRow(user.id).active_car_id, r);
  // The await let other requests in: the offer may have gone meanwhile.
  const still = rideRow(r.id);
  if (still?.status !== 'offered' || still.offered_to !== user.id || isBusy(user.id)) throw new ApiError(409, 'offer_gone', 'This ride is no longer available.');
  if (!isCash(r) && !payoutAddress(user.id, r.coin) && !user.is_demo) throw new ApiError(409, 'need_wallet', 'Connect a wallet in Profile first, so you can be paid.');
  // The way as it was when offered: the driver hasn't set off while the offer was waiting for an answer.
  const offeredAt = r.offered_until - rules.offerTime;
  tx(() => assignDriver(r, user.id, r.price_cents, r.pickup_m, Math.max(0, Math.round((r.pickup_eta_at - offeredAt) / 1000))));
  const fresh = rideRow(r.id);
  notifyAssigned(fresh);
  return { ride: publicRide(fresh, user.id) };
});

route('POST', '/api/rides/:id/decline', (ctx) => {
  const { user } = requireDriver(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.offered_to !== user.id || r.status !== 'offered') return { ok: true };
  event(r.id, 'declined', user.id);
  run('UPDATE rides SET offered_to = NULL, offered_until = NULL WHERE id = ?', r.id);
  bump(user.id);
  offerNext(r.id);
  return { ok: true };
});

// No answer within the time: that driver isn't at their phone, so they go offline, also with drive mode still on, until
// they go online again themselves. The ride goes to the next cheapest.
export function expireOffers() {
  const t = now();
  for (const r of all(`SELECT * FROM rides WHERE status = 'offered' AND offered_until < ?`, t)) {
    event(r.id, 'offer_expired', r.offered_to);
    if (driverRow(r.offered_to)?.online_since) setOffline(r.offered_to);
    run('UPDATE drivers SET inactive_at = ? WHERE user_id = ?', t, r.offered_to);
    notify(r.offered_to, 'You’re offline', `You didn’t answer a ride within ${rules.offerTime / 60_000} minutes. Go online again when you’re ready.`, { kind: 'offline' });
    bump(r.offered_to);
    run('UPDATE rides SET offered_to = NULL, offered_until = NULL WHERE id = ?', r.id);
    offerNext(r.id);
  }
}

// ---------- the market: orders any driver can claim ----------

// A street without its house number: enough to decide, not the exact door.
const area = (label) => (label ? label.replace(/^([^,]*?)\s+\d[^,]*(,|$)/, '$1$2') : label);

function marketOrder(r, from) {
  return {
    id: r.id,
    kind: r.scheduled_at ? 'planned' : 'now',
    scheduledAt: r.scheduled_at,
    // Near the pickup, not on it: the exact spot comes with claiming.
    lat: Math.round(r.pickup_lat * 1000) / 1000,
    lng: Math.round(r.pickup_lng * 1000) / 1000,
    pickupLabel: area(r.pickup_label),
    dropoffLabel: area(r.dropoff_label),
    dropoffLat: Math.round(r.dropoff_lat * 1000) / 1000,
    dropoffLng: Math.round(r.dropoff_lng * 1000) / 1000,
    distanceM: r.distance_m,
    durationS: r.duration_s,
    passengers: r.passengers,
    pets: Boolean(r.pets),
    vehicle: r.vehicle,
    bidCents: r.max_cents,
    coin: r.coin,
    awayM: Math.round(metres(from.lat, from.lng, r.pickup_lat, r.pickup_lng)),
  };
}

route('GET', '/api/driver/market', (ctx) => {
  const { user, driver } = requireDriver(ctx);
  const lat = Number(ctx.query.get('lat')), lng = Number(ctx.query.get('lng'));
  if (!validPoint(lat, lng)) throw new ApiError(400, 'bad_location', 'We need your location to use this app.');
  const radius = Math.min(rules.maxRadiusKm, Math.max(0.5, Number(ctx.query.get('radiusKm')) || rules.defaultRadiusKm)) * 1000;
  const coins = new Set(enabledCoins(user.id));
  const car = get('SELECT * FROM cars WHERE id = ? AND deleted_at IS NULL', driver.active_car_id ?? '');
  const hidden = blockedIds(user.id);
  // With a rider on board nothing can be claimed; the orders still show.
  const driving = isDriving(user.id);
  const orders = all(`SELECT r.* FROM rides r JOIN users u ON u.id = r.rider_id WHERE r.status = 'open' AND r.rider_id != ? AND u.is_demo = ?`, user.id, user.is_demo ? 1 : 0)
    // A planned order for a chosen driver shows to them wherever they are, and to nobody else for now.
    .filter((r) => !hidden.has(r.rider_id) && (r.offered_to ? r.offered_to === user.id : metres(lat, lng, r.pickup_lat, r.pickup_lng) <= radius))
    // A car sees car orders, a motor or scooter its own kind; "any vehicle" is for everyone.
    .filter((r) => !r.vehicle || !car || car.vehicle === r.vehicle)
    // Planned orders are only for drivers who plan that far ahead.
    .filter((r) => !r.scheduled_at || (driver.allows_planning && r.scheduled_at <= now() + driver.plan_days * 86_400_000))
    // Those for you first, then the closest: a busy city has more orders than a map can show.
    .sort((a, b) => Number(b.offered_to === user.id) - Number(a.offered_to === user.id) || metres(lat, lng, a.pickup_lat, a.pickup_lng) - metres(lat, lng, b.pickup_lat, b.pickup_lng))
    .slice(0, rules.driversShown)
    .map((r) => ({ ...marketOrder(r, { lat, lng }), forYou: r.offered_to === user.id, canClaim: !driving && coins.has(r.coin) && (!r.pets || Boolean(car?.pets_allowed)) && Boolean(car) && car.seats >= r.passengers && (!r.vehicle || car.vehicle === r.vehicle) }));
  // What this driver has booked, now or planned, also shows on the map, and a tap on it opens the ride (Pieter, 8 November 2026).
  // A ride on its way to the drop-off has its own directions.
  const booked = all(`SELECT * FROM rides WHERE driver_id = ? AND status IN ('awaiting_payment', 'accepted', 'arrived', 'scheduled') ORDER BY COALESCE(scheduled_at, accepted_at) LIMIT 20`, user.id)
    .map((r) => publicRide(r, user.id));
  return { orders, driving, booked };
});

// Would this planned drive fit between the driver's others? Only times are checked: a claim is the driver's own choice.
function plannedClash(driverId, r) {
  const start = r.scheduled_at, end = start + r.duration_s * 1000;
  return Boolean(get(`SELECT 1 AS x FROM rides WHERE driver_id = ? AND status IN ('scheduled', 'awaiting_payment') AND scheduled_at IS NOT NULL AND id != ?
                      AND scheduled_at < ? AND scheduled_at + duration_s * 1000 + ? > ?`, driverId, r.id, end + rules.planBuffer, rules.planBuffer, start));
}

// A car taking a ride whose pickup is in the Netherlands needs the checks (checks.js).
async function requireChecks(user, carId, r) {
  const car = get('SELECT * FROM cars WHERE id = ?', carId);
  const need = await checksNeeded(user, car, { lat: r.pickup_lat, lng: r.pickup_lng });
  if (need) throw checksError(need);
}

route('POST', '/api/rides/:id/claim', async (ctx) => {
  const { user, driver } = requireDriver(ctx);
  const r = rideRow(ctx.params.id);
  if (!r || r.status !== 'open') throw new ApiError(409, 'order_gone', 'Another driver was quicker.');
  if (r.offered_to && r.offered_to !== user.id) throw new ApiError(409, 'order_gone', 'This order is no longer available.');
  if (r.rider_id === user.id) throw new ApiError(409, 'own_order', 'This is your own order.');
  if (blockedBetween(user.id, r.rider_id) || Boolean(user.is_demo) !== isDemoRide(r)) throw new ApiError(409, 'order_gone', 'This order is no longer available.');
  if (isDriving(user.id)) throw new ApiError(409, 'on_a_ride', 'Finish the drive you’re on first.');
  if (!enabledCoins(user.id).includes(r.coin)) throw new ApiError(409, 'coin_off', isCash(r) ? 'This rider pays in cash, which you’ve turned off in Wallet.' : `This rider pays in a coin you haven’t turned on in Profile.`);
  if (!isCash(r) && !payoutAddress(user.id, r.coin) && !user.is_demo) throw new ApiError(409, 'need_wallet', 'Connect a wallet in Profile first, so you can be paid.');
  const car = driver.active_car_id && get('SELECT * FROM cars WHERE id = ? AND deleted_at IS NULL', driver.active_car_id);
  if (!car) throw new ApiError(409, 'need_car', 'Add a vehicle on My page first.');
  if (car.seats < r.passengers) throw new ApiError(409, 'too_few_seats', 'Your active vehicle has too few seats for this order.');
  if (r.vehicle && car.vehicle !== r.vehicle) throw new ApiError(409, 'wrong_vehicle', `This rider asked for a ${r.vehicle}.`);
  if (r.pets && !car.pets_allowed) throw new ApiError(409, 'no_pets', 'This rider brings a pet. Allow pets on your active vehicle to claim it.');
  await requireChecks(user, car.id, r);
  let pickupM = null, pickupS = null;
  const startsNow = !r.scheduled_at || r.scheduled_at - rules.planStart <= now();
  if (r.scheduled_at && !driver.allows_planning) throw new ApiError(409, 'no_planning', 'Allow planning on My page to claim planned drives.');
  if (r.scheduled_at && r.scheduled_at > now() + driver.plan_days * 86_400_000) throw new ApiError(409, 'too_far_ahead', `This is further ahead than the ${driver.plan_days} days you plan.`);
  if (startsNow) {
    if (isBusy(user.id)) throw new ApiError(409, 'on_a_ride', 'Finish your ride first.');
    if (!isOnline(driver)) throw new ApiError(409, 'not_online', 'Go online on the Driving tab first.');
    if (metres(driver.lat, driver.lng, r.pickup_lat, r.pickup_lng) > rules.maxRadiusKm * 1000) throw new ApiError(409, 'too_far', `This rider is more than ${rules.maxRadiusKm} km from you.`);
    const [way] = await routing.manyToOne([{ lat: driver.lat, lng: driver.lng }], { lat: r.pickup_lat, lng: r.pickup_lng });
    pickupM = way.distanceM;
    pickupS = way.durationS;
  } else if (plannedClash(user.id, r)) {
    throw new ApiError(409, 'clash', 'You already have a drive planned at that time.');
  }
  const taken = tx(() => {
    const fresh = rideRow(r.id);
    if (fresh.status !== 'open') return false;
    assignDriver(fresh, user.id, fresh.max_cents, pickupM, pickupS);
    return true;
  });
  if (!taken) throw new ApiError(409, 'order_gone', 'Another driver was quicker.');
  const fresh = rideRow(r.id);
  notifyAssigned(fresh);
  return { ride: publicRide(fresh, user.id) };
});

route('POST', '/api/rides/:id/bid', async (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.rider_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  if (r.status !== 'open') throw new ApiError(409, 'not_open', 'This order can’t be changed now.');
  const cents = Math.round(num(ctx.body.bidCents) ?? 0);
  if (cents <= r.max_cents || cents > 100_000) throw new ApiError(400, 'bad_bid', 'Name a higher price, up to €1000.');
  run('UPDATE rides SET max_cents = ? WHERE id = ?', cents, r.id);
  event(r.id, 'bid_raised', String(cents));
  bump(user.id);
  return { ride: publicRide(rideRow(r.id), user.id) };
});

// A driver passing on a planned drive. Paid, its escrow pays only that driver, so it's refunded and the rider can book
// again; not paid yet, or paid in cash, it goes back on the market, and the rider pays whoever claims it.
export async function replan(rideId, dropDriverId) {
  const r = rideRow(rideId);
  if (!r || !['scheduled', 'awaiting_payment'].includes(r.status) || !r.scheduled_at) return;
  if (r.status === 'scheduled' && !isCash(r)) {
    cancel(r, 'system', 'Your driver can’t make it');
    notify(r.rider_id, 'Your driver can’t make it', 'Your planned ride is cancelled and refunded to your wallet. You can book again.', { rideId: r.id });
    return;
  }
  tx(() => {
    run(`UPDATE rides SET status = 'open', driver_id = NULL, car_id = NULL, price_cents = NULL, pickup_m = NULL, accepted_at = NULL, arrived_at = NULL,
         pickup_eta_at = NULL, pickup_deadline_at = NULL, plan_notice_sent = 0, pay_by = NULL, pay_token = NULL WHERE id = ?`, r.id);
    event(r.id, 'to_market');
  });
  notify(r.rider_id, 'Looking for a new driver', `Your driver can’t make it. Drivers nearby can now claim your order${isCash(r) ? '' : ', and you pay once one has'}.`, { rideId: r.id });
  tellPlanned(rideRow(r.id), await plannedDrivers(r, dropDriverId));
}

route('POST', '/api/rides/:id/release', async (ctx) => {
  const { user } = requireDriver(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.driver_id !== user.id || !['scheduled', 'awaiting_payment'].includes(r.status) || !r.scheduled_at) throw new ApiError(409, 'not_yours', 'This drive can’t be released.');
  event(r.id, 'released', user.id);
  await replan(r.id, user.id);
  bump(user.id);
  return { ok: true };
});

// ---------- cancelling ----------

// Cancelling: what was paid into the escrow is refunded right away, or (a rider cancelling late) split 50/50 once the
// 24 hours for an appeal are over. Before paying there is nothing to give back.
function cancel(r, by, reason, { driverShare = false } = {}) {
  const e = escrow.paidEscrow(r.id);
  const t = now();
  tx(() => {
    if (e?.status === 'paid' && driverShare && r.driver_id) {
      const share = BigInt(e.units) / 2n;
      run(`INSERT INTO payouts (id, user_id, ride_id, kind, coin, units, eur_cents, status, due_at, created_at) VALUES (?, ?, ?, 'payout', ?, ?, ?, 'held', ?, ?)`,
        uid('po_'), r.driver_id, r.id, r.coin, Number(share), Math.round((r.price_cents ?? 0) * rules.riderCancelShare), t + rules.payoutAfter, t);
      escrow.decide(e.id, 'split', t + rules.payoutAfter);
      event(r.id, 'cancel_share', String(share));
    } else if (e?.status === 'paid') {
      escrow.decide(e.id, 'refund', t);
    } else if (driverShare && r.driver_id && isDemoRide(r)) {
      run(`INSERT INTO payouts (id, user_id, ride_id, kind, coin, units, eur_cents, status, due_at, created_at) VALUES (?, ?, ?, 'payout', ?, 0, ?, 'demo', ?, ?)`,
        uid('po_'), r.driver_id, r.id, r.coin, Math.round((r.price_cents ?? 0) * rules.riderCancelShare), t + rules.payoutAfter, t);
    }
    run(`UPDATE rides SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, offered_to = NULL, offered_until = NULL, queue = NULL, pay_token = NULL, held = 0 WHERE id = ?`, t, by, reason, r.id);
    forgetDriverStats(r.driver_id);
    event(r.id, 'cancelled', `${by}: ${reason ?? ''}`);
  });
  touchBoth(r);
}

// What a rider gets back on cancelling now, in percent. All of it while no driver took it or it isn't paid, and for a planned
// ride with a driver until 3 hours before. A ride for now that's paid: half from that moment, the other half is the driver's
// for the trouble. All of it again when the driver is late, until the rider is in the car. Cash isn't paid until the end, so that's free too.
export function riderRefundPercent(r, t = now()) {
  if (isCash(r) || !r.driver_id || !['scheduled', 'accepted', 'arrived'].includes(r.status)) return 100;
  const free = freeUntil(r);
  if (free && t <= free) return 100;
  if (driverIsLate(r, t)) return 100;
  return Math.round((1 - rules.riderCancelShare) * 100);
}

// A rider's order can always go before check-in. What's refunded goes back to the wallet that paid.
route('POST', '/api/rides/:id/cancel', (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.rider_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  if (!['searching', 'awaiting_payment', 'offered', 'open', 'scheduled', 'accepted', 'arrived'].includes(r.status)) throw new ApiError(409, 'cant_cancel', 'This ride can’t be cancelled any more.');
  const percent = riderRefundPercent(r);
  cancel(r, 'rider', text(ctx.body.reason, 200) || null, { driverShare: percent < 100 });
  if (r.driver_id) notify(r.driver_id, 'Ride cancelled', percent < 100 ? `The rider cancelled. You get ${100 - percent}% of the price after 24 hours.` : 'The rider cancelled.', { rideId: r.id });
  return { ride: publicRide(rideRow(r.id), user.id) };
});

export const DRIVER_CANCEL_REASONS = ['Alcohol abuse', 'Misbehaviour', 'Rider not there', 'Car trouble', 'Other'];

route('POST', '/api/rides/:id/driver-cancel', (ctx) => {
  const { user } = requireDriver(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.driver_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  if (![...ACTIVE_STATUSES, 'awaiting_payment'].includes(r.status)) throw new ApiError(409, 'cant_cancel', 'This ride can’t be cancelled now.');
  const reason = DRIVER_CANCEL_REASONS.includes(ctx.body.reason) ? ctx.body.reason : 'Other';
  const wasPaid = r.status !== 'awaiting_payment' && !isCash(r);
  // Half the price for the driver, automatically after the 24 hours for an appeal, in one case only: the driver stopped at
  // the pickup, waited 10 minutes there and the rider never checked in. An appeal freezes it for a manual review; nobody
  // deciding within the escrow's 30 days refunds the rider. Any other driver cancelling refunds it all, also once the rider
  // has checked in (Pieter's decision, 8 November 2026).
  const t = now();
  const d = driverRow(user.id);
  const noShow = !isCash(r) && reason === 'Rider not there' && r.status === 'arrived' && r.waiting_since && t >= r.waiting_since + rules.riderNoShow
    && d?.loc_at && t - d.loc_at <= rules.locationFresh && metres(d.lat, d.lng, r.pickup_lat, r.pickup_lng) <= rules.leftPickupRadius;
  cancel(r, 'driver', reason, { driverShare: Boolean(noShow) });
  const words = noShow ? 'You didn’t check in. Half goes back to your wallet and half to your driver after 24 hours. Something wrong? Appeal within 24 hours.'
    : wasPaid ? `${reason}. Everything is refunded to your wallet.` : `${reason}. You haven’t paid anything.`;
  notify(r.rider_id, 'Your driver cancelled', words, { rideId: r.id });
  return { ride: publicRide(rideRow(r.id), user.id) };
});

// ---------- where everyone is ----------

const lines = new Map();
function lineOf(r) {
  if (!r.polyline) return [];
  let line = lines.get(r.id);
  if (!line) {
    if (lines.size > 200) lines.clear();
    line = decodePolyline(r.polyline);
    lines.set(r.id, line);
  }
  return line;
}

function askRider(r, why) {
  const t = now();
  if (r.safety_asked_at && t - r.safety_asked_at < 10 * 60_000) return;
  run('UPDATE rides SET safety_asked_at = ?, safety_answer = NULL WHERE id = ?', t, r.id);
  event(r.id, why);
  notify(r.rider_id, 'Is everything OK?', 'Your phone and the car seem to be going different ways.', { rideId: r.id, kind: 'safety' });
}

export function arrive(r, t) {
  const eta = r.pickup_eta_at ?? t;
  const late = Math.round((t - eta) / 1000);
  run(`UPDATE rides SET status = 'arrived', arrived_at = ?, arrival_late_s = ? WHERE id = ? AND status = 'accepted'`, t, late, r.id);
  forgetDriverStats(r.driver_id);
  event(r.id, 'arrived', String(late));
  notify(r.rider_id, 'Your driver is here', 'Check the number plate, get in, then check in.', { rideId: r.id, kind: 'arrived' });
}

// `still`: the phone hasn't really moved, so there's nothing to tell anyone. `fresh`: it has, or it's time to note it's still there.
function track(r, who, lat, lng, t, stopped, still = false, fresh = true) {
  // A demo ride only happens on a screen: there are no two phones to compare.
  if (isDemoRide(r)) {
    touchBoth(rideRow(r.id));
    return;
  }
  if (fresh) run('INSERT INTO ride_points (ride_id, who, at, lat, lng) VALUES (?, ?, ?, ?, ?)', r.id, who, t, lat, lng);
  const other = who === 'driver' ? get('SELECT lat, lng, loc_at FROM users WHERE id = ?', r.rider_id) : driverRow(r.driver_id);
  if (who === 'driver' && ['accepted', 'awaiting_payment', 'arrived'].includes(r.status)) {
    // There within arrivedRadius, but only gone again well beyond it: GPS wobbles, and a car may move up a little.
    if (metres(lat, lng, r.pickup_lat, r.pickup_lng) > (r.status === 'arrived' ? rules.leftPickupRadius : rules.arrivedRadius)) {
      if (r.status !== 'arrived') askEta(r, lat, lng, t);
      // Drove off again: the wait starts over when they're back.
      else if (r.waiting_since) run('UPDATE rides SET waiting_since = NULL WHERE id = ?', r.id);
    } else {
      if (r.status === 'accepted') arrive(r, t);
      // There before the rider paid: noted, and the ride goes on from here once they have.
      else if (r.status === 'awaiting_payment' && !r.arrived_at) run('UPDATE rides SET arrived_at = ?, arrival_late_s = ? WHERE id = ?', t, Math.round((t - (r.pickup_eta_at ?? t)) / 1000), r.id);
      // The driver's 10 minutes start with a full stop at the spot, on a paid ride.
      if (r.status !== 'awaiting_payment' && stopped && !r.waiting_since) run('UPDATE rides SET waiting_since = ? WHERE id = ?', t, r.id);
    }
  }
  if (r.status === 'riding' && fresh) {
    if (other?.lat != null && other.loc_at && t - other.loc_at <= rules.syncPair) {
      // The other position is a few seconds old, and the car has moved on since: allow for motorway speed.
      const apart = metres(lat, lng, other.lat, other.lng);
      if (apart <= rules.syncDistance + rules.syncFastestMps * ((t - other.loc_at) / 1000)) {
        run('UPDATE rides SET sync_ok = sync_ok + 1, sync_streak = 0 WHERE id = ?', r.id);
      } else {
        run('UPDATE rides SET sync_off = sync_off + 1, sync_streak = sync_streak + 1 WHERE id = ?', r.id);
        if (r.sync_streak + 1 >= rules.syncAlertAfter) askRider(r, 'out_of_sync');
      }
    }
    if (who === 'driver') {
      const toDropoff = Math.round(metres(lat, lng, r.dropoff_lat, r.dropoff_lng));
      if (r.closest_m == null || toDropoff < r.closest_m) run('UPDATE rides SET closest_m = ? WHERE id = ?', toDropoff, r.id);
      if (metresToLine(lat, lng, lineOf(r)) > rules.offRouteDistance) {
        run('UPDATE rides SET route_off_streak = route_off_streak + 1 WHERE id = ?', r.id);
        if (r.route_off_streak + 1 >= rules.offRouteAlertAfter) { askRider(r, 'off_route'); run('UPDATE rides SET route_off_streak = 0 WHERE id = ?', r.id); }
      } else if (r.route_off_streak) {
        run('UPDATE rides SET route_off_streak = 0 WHERE id = ?', r.id);
      }
    }
  }
  // Who needs to hear of this, as each one wakes a phone that then asks for all there is. Something changed: both.
  const after = rideRow(r.id);
  if (after.status !== r.status || after.waiting_since !== r.waiting_since) { touchBoth(after); return; }
  if (still) return;
  if (who === 'rider') {
    // Close enough to check in is worked out from both phones.
    if (r.status === 'accepted' || r.status === 'arrived') bump(r.rider_id);
    return;
  }
  // The rider sees the car move. The driver has directions, and only needs to hear how far it still is now and then, and all the time close by.
  bump(r.rider_id);
  if (r.status === 'riding') {
    const toDropoff = metres(lat, lng, r.dropoff_lat, r.dropoff_lng);
    if (toDropoff < 1000 || Math.ceil(toDropoff / 1000) !== Math.ceil((r.closest_m ?? Infinity) / 1000)) bump(r.driver_id);
  }
}

route('POST', '/api/location', (ctx) => {
  const user = requireUser(ctx);
  if (!validPoint(ctx.body.lat, ctx.body.lng)) throw new ApiError(400, 'bad_location', 'We need your location to use this app.');
  const t = now();
  const d = driverRow(user.id);
  // GPS wobbles, also standing still. A few metres from the position we have aren't a move: it stays where it was, so nobody sees a car
  // twitch on the map, nothing is stored and nobody is woken. Now and then it's noted that the phone is still there.
  const sameSpot = (p) => p?.lat != null && metres(p.lat, p.lng, ctx.body.lat, ctx.body.lng) <= rules.sameSpotWithin;
  const dueAgain = (at) => !at || t - at >= rules.sameSpotRefresh;
  const still = sameSpot(user);
  const fresh = !still || dueAgain(user.loc_at);
  const lat = still ? user.lat : ctx.body.lat, lng = still ? user.lng : ctx.body.lng;
  if (!still) run('UPDATE users SET lat = ?, lng = ?, loc_at = ?, last_seen_at = ? WHERE id = ?', lat, lng, t, t, user.id);
  else if (fresh) run('UPDATE users SET loc_at = ?, last_seen_at = ? WHERE id = ?', t, t, user.id);
  let online = false;
  // Stopped: by the phone's own speed, or having hardly moved since the last position. A phone standing still can report a little speed too.
  const speed = num(ctx.body.speed);
  const stopped = (speed != null && speed >= 0 && speed < rules.stoppedBelowMps) || sameSpot(d);
  if (d) {
    const heading = num(ctx.body.heading);
    // Drive mode: a phone that was cut off comes straight back online.
    if (ctx.body.driving === true && !isOnline(d, t) && !isOnRide(user.id) && !d.inactive_at && activeCarReady(d, user)) setOnline(user.id, lat, lng);
    if (ctx.body.driving === true || isOnline(d, t) || isDriving(user.id)) {
      if (!sameSpot(d)) {
        run('UPDATE drivers SET lat = ?, lng = ?, heading = ?, loc_at = ?, heartbeat_at = CASE WHEN online_since IS NOT NULL THEN ? ELSE heartbeat_at END, last_online_at = CASE WHEN online_since IS NOT NULL THEN ? ELSE last_online_at END WHERE user_id = ?',
          ctx.body.lat, ctx.body.lng, heading, t, t, t, user.id);
      } else if (dueAgain(d.heartbeat_at)) {
        run('UPDATE drivers SET loc_at = ?, heartbeat_at = CASE WHEN online_since IS NOT NULL THEN ? ELSE heartbeat_at END, last_online_at = CASE WHEN online_since IS NOT NULL THEN ? ELSE last_online_at END WHERE user_id = ?',
          t, t, t, user.id);
      }
    }
    online = Boolean(driverRow(user.id).online_since);
  }
  // A driver can set off before the rider has paid, so the rider sees them come.
  const rides = all(`SELECT * FROM rides WHERE (rider_id = ? AND status IN ${STATUS_ACTIVE}) OR (driver_id = ? AND status IN ('accepted', 'arrived', 'riding', 'awaiting_payment') AND (status != 'awaiting_payment' OR scheduled_at IS NULL))`, user.id, user.id);
  for (const r of rides) track(r, r.driver_id === user.id ? 'driver' : 'rider', lat, lng, t, stopped, still, fresh);
  // Within 15 m of the last position is standing, whatever the phone says its speed is (GPS wobbles, and so does its speed). In slow
  // traffic that's soon more than 15 m, so the rider still sees the car come.
  if (rides.length) return { every: still ? rules.locationStillEverySec : rules.locationRideEverySec, online };
  if (online) return { every: still ? rules.locationOnlineStillEverySec : rules.locationEverySec, online };
  return { every: isOnRide(user.id) ? rules.locationEverySec : rules.locationIdleEverySec, online };
});

// ---------- check in, check out ----------

route('POST', '/api/rides/:id/check-in', (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.rider_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  if (!['accepted', 'arrived'].includes(r.status)) throw new ApiError(409, 'not_now', 'You can’t check in to this ride now.');
  if (ctx.body.plateChecked !== true) throw new ApiError(400, 'check_plate', 'Check the number plate first.');
  const { lat, lng } = ctx.body;
  if (!validPoint(lat, lng)) throw new ApiError(400, 'bad_location', 'We need your location to check in.');
  const t = now();
  run('UPDATE users SET lat = ?, lng = ?, loc_at = ? WHERE id = ?', lat, lng, t, user.id);
  const d = driverRow(r.driver_id);
  if (d?.lat == null || !d.loc_at || t - d.loc_at > rules.locationFresh) throw new ApiError(409, 'driver_unknown', 'We can’t see where your driver is right now. Try again in a moment.');
  const apart = Math.round(metres(lat, lng, d.lat, d.lng));
  if (apart > rules.checkInRadius && !isDemoRide(r)) throw new ApiError(409, 'too_far', `You can check in within ${rules.checkInRadius} m of the car. It’s ${apart} m away.`, { apartM: apart });
  tx(() => {
    if (r.status === 'accepted') arrive(r, t);
    run(`UPDATE rides SET status = 'riding', checked_in_at = ? WHERE id = ?`, t, r.id);
    event(r.id, 'checked_in', String(apart));
  });
  notify(r.driver_id, 'Checked in', 'You can drive.', { rideId: r.id, kind: 'checked_in' });
  touchBoth(r);
  return { ride: publicRide(rideRow(r.id), user.id) };
});

// The simulated rider gets in (demo.js).
export function botCheckIn(r, t) {
  run(`UPDATE rides SET status = 'riding', checked_in_at = ? WHERE id = ?`, t, r.id);
  event(r.id, 'checked_in', 'demo');
  notify(r.driver_id, 'Checked in', 'You can drive.', { rideId: r.id, kind: 'checked_in' });
  touchBoth(r);
}

// Checked out: the escrow pays the driver (the price minus Drivezzz's €0.10) after 24 hours, unless someone appeals.
// Cash has changed hands by now: the whole price is noted for the driver's earnings, and nothing is sent.
export function complete(r, { warning = false } = {}) {
  const t = now();
  const demo = isDemoRide(r), cash = isCash(r);
  const e = escrow.paidEscrow(r.id);
  tx(() => {
    run(`UPDATE rides SET status = 'completed', checked_out_at = ?, held = 0, checkout_warning = ? WHERE id = ?`, t, warning ? 1 : 0, r.id);
    forgetDriverStats(r.driver_id);
    // A demo ride's payout is marked as such and nothing ever sends it.
    run(`INSERT INTO payouts (id, user_id, ride_id, kind, coin, units, eur_cents, status, due_at, created_at) VALUES (?, ?, ?, 'payout', ?, ?, ?, ?, ?, ?)`,
      uid('po_'), r.driver_id, r.id, r.coin, e ? Number(BigInt(e.units) - BigInt(e.fee_units)) : 0, cash ? r.price_cents : Math.max(0, r.price_cents - rules.feeCents), demo ? 'demo' : cash ? 'cash' : 'held', t + rules.payoutAfter, t);
    if (e) escrow.decide(e.id, 'payout', t + rules.payoutAfter);
    event(r.id, 'checked_out', warning ? 'rider not near the drop-off' : null);
  });
  if (warning) {
    notify(r.rider_id, 'Did you reach your destination?', 'Heads-up: your phone wasn’t within 500 m of the drop-off when you were checked out. If you were dropped off correctly, you can ignore this. If not, you have 24 hours to appeal.', { rideId: r.id, kind: 'checkout_warning' });
    notify(r.driver_id, 'Heads-up about your check-out', 'The rider’s phone wasn’t within 500 m of the drop-off. If you dropped them off correctly, you can ignore this. They have 24 hours to appeal.', { rideId: r.id, kind: 'checkout_warning' });
  } else {
    notify(r.rider_id, 'You’ve arrived', `${cash ? 'Paid in cash. ' : ''}How was your ride? You can appeal within 24 hours if something went wrong.`, { rideId: r.id, kind: 'completed' });
  }
  touchBoth(r);
}

route('POST', '/api/rides/:id/check-out', (ctx) => {
  const { user } = requireDriver(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.driver_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  if (r.status !== 'riding') throw new ApiError(409, 'not_now', 'You can’t check out now.');
  const { lat, lng } = ctx.body;
  if (!validPoint(lat, lng)) throw new ApiError(400, 'bad_location', 'We need your location to check out.');
  const t = now();
  run('UPDATE drivers SET lat = ?, lng = ?, loc_at = ? WHERE user_id = ?', lat, lng, t, user.id);
  if (isDemoRide(r)) {
    complete(r);
    return { ride: publicRide(rideRow(r.id), user.id) };
  }
  const away = Math.round(metres(lat, lng, r.dropoff_lat, r.dropoff_lng));
  if (r.closest_m == null || away < r.closest_m) run('UPDATE rides SET closest_m = ? WHERE id = ?', away, r.id);
  if (away > rules.checkOutRadius) throw new ApiError(409, 'too_far', `Check out within ${rules.checkOutRadius} m of the drop-off. You’re ${away} m away.`, { awayM: away });
  // The rider's phone far from the drop-off (or not seen) only warns both: their phone may be off or the app closed.
  const rider = get('SELECT lat, lng, loc_at FROM users WHERE id = ?', r.rider_id);
  const riderFresh = rider?.loc_at && t - rider.loc_at <= rules.locationFresh;
  const riderAway = riderFresh ? Math.round(metres(rider.lat, rider.lng, r.dropoff_lat, r.dropoff_lng)) : null;
  complete(r, { warning: riderAway == null || riderAway > rules.checkOutWarn });
  return { ride: publicRide(rideRow(r.id), user.id) };
});

route('POST', '/api/rides/:id/safety', (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.rider_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  const ok = ctx.body.ok === true;
  run('UPDATE rides SET safety_answer = ? WHERE id = ?', ok ? 'ok' : 'not_ok', r.id);
  event(r.id, ok ? 'rider_ok' : 'rider_not_ok');
  if (!ok) run('INSERT INTO disputes (id, ride_id, opened_by, message, created_at) VALUES (?, ?, ?, ?, ?)', uid('di_'), r.id, user.id, 'Safety: the rider said something is wrong during the ride.', now());
  bump(user.id);
  return { ride: publicRide(rideRow(r.id), user.id) };
});

route('POST', '/api/rides/:id/review', (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.rider_id !== user.id || r.status !== 'completed') throw new ApiError(409, 'not_now', 'You can review after your ride.');
  const stars = Math.round(num(ctx.body.stars) ?? 0);
  if (stars < 1 || stars > 5) throw new ApiError(400, 'bad_stars', 'Give 1 to 5 stars.');
  if (findBlocked(ctx.body.text)) throw new ApiError(400, 'not_allowed', 'That text isn’t allowed.');
  run(`INSERT INTO reviews (ride_id, rider_id, driver_id, stars, text, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ride_id) DO UPDATE SET stars = excluded.stars, text = excluded.text`, r.id, user.id, r.driver_id, stars, text(ctx.body.text, 500) || null, now());
  forgetDriverStats(r.driver_id);
  return { ride: publicRide(rideRow(r.id), user.id) };
});

// An appeal about a ride. A rider's appeal holds the payout until an admin looks at it.
route('POST', '/api/rides/:id/appeal', (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  if (!r || (r.rider_id !== user.id && r.driver_id !== user.id)) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  // A driver can appeal a ride they couldn't check out, before it's refunded.
  const stuck = r.status === 'riding' && r.driver_id === user.id && now() > r.checked_in_at + r.duration_s * 1000;
  if (!['completed', 'cancelled'].includes(r.status) && !stuck) throw new ApiError(409, 'not_now', 'You can appeal once the ride is over.');
  const message = text(ctx.body.message, 2000);
  if (message.length < 5) throw new ApiError(400, 'too_short', 'Write a little more.');
  if (get('SELECT 1 AS x FROM disputes WHERE ride_id = ? AND opened_by = ?', r.id, user.id)) throw new ApiError(409, 'appealed', 'You already appealed this ride.');
  const payout = get(`SELECT status FROM payouts WHERE ride_id = ? AND kind = 'payout'`, r.id);
  // Cash has no escrow to end the 24 hours, so they're counted here. An appeal then only reaches a person: there's no money to hold.
  if (isCash(r)) {
    if (now() > (r.checked_out_at ?? r.cancelled_at ?? now()) + rules.payoutAfter) throw new ApiError(409, 'too_late', 'You can appeal within 24 hours after the ride.');
  } else if (r.rider_id === user.id && r.status === 'completed' && payout?.status !== 'held') throw new ApiError(409, 'paid_out', 'This ride has been paid out to the driver.');
  const e = escrow.paidEscrow(r.id);
  if (e && e.status !== 'paid') throw new ApiError(409, 'settled', 'This ride’s money has been settled already.');
  run('INSERT INTO disputes (id, ride_id, opened_by, message, created_at) VALUES (?, ?, ?, ?, ?)', uid('di_'), r.id, user.id, message, now());
  event(r.id, 'appealed', user.id);
  touchBoth(r);
  return { ride: publicRide(rideRow(r.id), user.id) };
});

// Decided by an admin, or by Drivezzz by default (a driver's appeal after most of the way).
// The escrow then pays the driver, splits 50/50 or refunds the rider.
export const DECISIONS = ['refund_rider', 'pay_driver', 'split'];
export const APPEAL_DECISIONS = [...DECISIONS, 'closed'];
// What a decision does, on an appeal or when an admin steps in by themselves: the payout record, the escrow's outcome, sent
// straight away, a ride that wasn't over yet ends there, and any appeal on it is closed.
function applyDecision(r, e, decision, answer, by) {
  const t = now();
  const units = !e ? 0n : decision === 'split' ? BigInt(e.units) / 2n : decision === 'pay_driver' ? BigInt(e.units) - BigInt(e.fee_units) : 0n;
  const cents = decision === 'split' ? Math.round((r.price_cents ?? 0) / 2) : Math.max(0, (r.price_cents ?? 0) - rules.feeCents);
  const payout = get(`SELECT * FROM payouts WHERE ride_id = ? AND kind = 'payout'`, r.id);
  if (decision === 'refund_rider') {
    if (payout) run(`UPDATE payouts SET status = 'cancelled', error = 'Refunded to the rider' WHERE id = ?`, payout.id);
  } else if (payout) {
    run(`UPDATE payouts SET units = ?, eur_cents = ?, status = 'held', error = NULL WHERE id = ?`, Number(units), cents, payout.id);
  } else if (r.driver_id) {
    run(`INSERT INTO payouts (id, user_id, ride_id, kind, coin, units, eur_cents, status, due_at, created_at) VALUES (?, ?, ?, 'payout', ?, ?, ?, ?, ?, ?)`,
      uid('po_'), r.driver_id, r.id, r.coin, Number(units), cents, isDemoRide(r) ? 'demo' : 'held', t, t);
  }
  if (e) {
    escrow.decide(e.id, { refund_rider: 'refund', pay_driver: 'payout', split: 'split' }[decision], t);
    escrow.setHold(e.id, false);
  }
  if (['scheduled', 'accepted', 'arrived', 'riding'].includes(r.status)) {
    forgetDriverStats(r.driver_id);
    if (decision === 'pay_driver') run(`UPDATE rides SET status = 'completed', checked_out_at = ?, held = 0 WHERE id = ?`, t, r.id);
    else run(`UPDATE rides SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'admin', cancel_reason = ?, held = 0 WHERE id = ?`, t, by === 'drivezzz' ? 'Decided on appeal' : 'Decided by Drivezzz', r.id);
  }
  run(`UPDATE disputes SET status = ?, answer = ?, decided_at = ?, decided_by = ? WHERE ride_id = ? AND status = 'open'`, decision, answer || null, t, by, r.id);
}

const decisionWords = {
  refund_rider: ['Everything is refunded to your wallet.', 'The rider got their money back.'],
  pay_driver: ['The driver is paid for this ride.', 'You’re paid for this ride.'],
  split: ['Half is refunded to your wallet, half goes to the driver.', 'You get half the price; the other half goes back to the rider.'],
  closed: ['Drivezzz has looked at it. This ride was paid in cash, so no money moves.', 'Drivezzz has looked at it. This ride was paid in cash, so no money moves.'],
};

export function decideDispute(disputeId, decision, answer, by) {
  if (!APPEAL_DECISIONS.includes(decision)) throw new ApiError(400, 'bad_decision', 'Refund the rider, pay the driver, or split it.');
  return tx(() => {
    const dis = get('SELECT * FROM disputes WHERE id = ?', disputeId);
    if (!dis) throw new ApiError(404, 'not_found', 'Not found.');
    if (dis.status !== 'open') throw new ApiError(409, 'decided', 'This appeal has been decided.');
    const r = rideRow(dis.ride_id);
    // Drivezzz has no part in cash: an appeal about a ride paid in it can only be closed, and the ride itself goes on.
    if (isCash(r) !== (decision === 'closed')) throw new ApiError(400, 'bad_decision', isCash(r) ? 'This ride was paid in cash: there’s no money to move.' : 'Refund the rider, pay the driver, or split it.');
    const e = escrow.paidEscrow(r.id);
    if (e && e.status !== 'paid') throw new ApiError(409, 'settled', 'This ride’s money has been settled already.');
    if (isCash(r)) run(`UPDATE disputes SET status = 'closed', answer = ?, decided_at = ?, decided_by = ? WHERE ride_id = ? AND status = 'open'`, answer || null, now(), by, r.id);
    else applyDecision(r, e, decision, answer, by);
    event(r.id, 'appeal_decided', `${decision} by ${by}`);
    touchBoth(r);
    notify(r.rider_id, 'Your ride’s appeal was decided', decisionWords[decision][0], { rideId: r.id });
    if (r.driver_id) notify(r.driver_id, 'A ride’s appeal was decided', decisionWords[decision][1], { rideId: r.id });
    return rideRow(r.id);
  });
}

// An admin stepping in on any paid ride, with or without an appeal. Only while the money is still in its escrow.
function adminEscrowOf(rideId) {
  const r = rideRow(rideId);
  if (!r) throw new ApiError(404, 'not_found', 'Not found.');
  const e = escrow.paidEscrow(r.id);
  if (!e) throw new ApiError(409, 'not_paid', 'This ride has no money in escrow.');
  if (e.status !== 'paid') throw new ApiError(409, 'settled', 'This ride’s money has been settled already.');
  return { r, e };
}
export function decideRide(rideId, decision, answer, by) {
  if (!DECISIONS.includes(decision)) throw new ApiError(400, 'bad_decision', 'Refund the rider, pay the driver, or split it.');
  return tx(() => {
    const { r, e } = adminEscrowOf(rideId);
    applyDecision(r, e, decision, answer, by);
    event(r.id, 'admin_decided', `${decision} by ${by}`);
    touchBoth(r);
    const why = answer ? ` ${answer}` : '';
    notify(r.rider_id, 'About your ride’s payment', decisionWords[decision][0] + why, { rideId: r.id });
    if (r.driver_id) notify(r.driver_id, 'About a ride’s payment', decisionWords[decision][1] + why, { rideId: r.id });
    return rideRow(r.id);
  });
}
// Holding keeps the money where it is, whatever comes due, until it's released or decided. The escrow's 30 days still count.
export function holdRide(rideId, on, by) {
  return tx(() => {
    const { r, e } = adminEscrowOf(rideId);
    escrow.setHold(e.id, on);
    event(r.id, on ? 'admin_hold' : 'admin_hold_released', by);
    touchBoth(r);
    const words = on ? 'Drivezzz is checking this ride. The money stays in escrow until then.' : 'The check is done: the payment goes on as planned.';
    notify(r.rider_id, on ? 'Payment on hold' : 'Payment no longer on hold', words, { rideId: r.id });
    if (r.driver_id) notify(r.driver_id, on ? 'Payment on hold' : 'Payment no longer on hold', words, { rideId: r.id });
    return rideRow(r.id);
  });
}

// ---------- paying ----------

// The payment a wallet signs: built here for the wallet's own address, into the ride's escrow for its driver.
async function payment(r, account) {
  if (!limit(`pay:${r.id}`, 30, 60_000)) throw new ApiError(429, 'too_many', 'Too many requests. Wait a moment.');
  const to = payoutAddress(r.driver_id, r.coin);
  if (!to) throw new ApiError(409, 'driver_wallet', 'Your driver has no wallet for this coin any more.');
  let built;
  try {
    built = await escrow.paymentFor(r, String(account ?? ''), to);
  } catch (e) {
    if (e.code === 'driver_usdc' && limit(`usdc:${r.id}`, 1, 10 * 60_000)) {
      notify(r.driver_id, 'Your rider can’t pay yet', 'Your wallet has no USDC account. Swap a little SOL to USDC in your wallet once, so the rider can pay.', { rideId: r.id });
    }
    if (e.code === 'driver_empty' && limit(`empty:${r.id}`, 1, 10 * 60_000)) {
      notify(r.driver_id, 'Your rider can’t pay yet', 'Your wallet is empty, and Solana refuses to send it this little SOL. Keep a little SOL in it, so the rider can pay.', { rideId: r.id });
    }
    throw e;
  }
  const { transaction } = built;
  return { transaction, message: `Drivezzz: €${(r.price_cents / 100).toFixed(2)} for your ride${r.dropoff_label ? ` to ${r.dropoff_label}` : ''}, held until the ride is done.` };
}
const payable = (r) => r?.status === 'awaiting_payment' && r.pay_by > now();

// Solana Pay transaction request: the link in the app opens the rider's wallet, which asks here for the payment.
route('GET', '/api/pay/:token', () => ({ label: 'Drivezzz', icon: `${config.baseUrl}/logo.png` }));
route('POST', '/api/pay/:token', async (ctx) => {
  const r = get(`SELECT * FROM rides WHERE pay_token = ?`, String(ctx.params.token));
  if (!payable(r)) throw new ApiError(410, 'not_waiting', 'This ride isn’t waiting for a payment any more.');
  return payment(r, ctx.body.account);
});
// The same for the app itself, for wallets connected with WalletConnect.
route('POST', '/api/rides/:id/pay', async (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.rider_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  if (!payable(r)) throw new ApiError(410, 'not_waiting', 'This ride isn’t waiting for a payment any more.');
  return payment(r, ctx.body.account);
});
// What the wallet signed, for wallets that only sign.
route('POST', '/api/rides/:id/pay/send', async (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  if (r?.rider_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  if (!payable(r)) throw new ApiError(410, 'not_waiting', 'This ride isn’t waiting for a payment any more.');
  if (!limit(`pay:${r.id}`, 30, 60_000)) throw new ApiError(429, 'too_many', 'Too many requests. Wait a moment.');
  await escrow.sendPayment(r, ctx.body.transaction);
  return { ok: true };
});

// A server with no chain: the rider's pay button counts as paying. No wallet could, and no money moves.
route('POST', '/api/rides/:id/pretend-pay', async (ctx) => {
  const user = requireUser(ctx);
  if (!escrow.pretendChain()) throw new ApiError(404, 'not_found', 'Not found.');
  const r = rideRow(ctx.params.id);
  if (r?.rider_id !== user.id) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  if (!payable(r)) throw new ApiError(410, 'not_waiting', 'This ride isn’t waiting for a payment any more.');
  await payment(r, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  await watchPayments();
  return { ride: publicRide(rideRow(r.id), user.id) };
});

// ---------- lists ----------

route('GET', '/api/rides', (ctx) => {
  const user = requireUser(ctx);
  const rows = all(`SELECT * FROM rides WHERE rider_id = ? ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 100`, user.id);
  return { rides: rows.map((r) => publicRide(r, user.id)) };
});

route('GET', '/api/rides/:id', (ctx) => {
  const user = requireUser(ctx);
  const r = rideRow(ctx.params.id);
  const mayLook = r && (r.rider_id === user.id || r.driver_id === user.id || r.offered_to === user.id);
  if (!mayLook) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  return { ride: publicRide(r, user.id) };
});

route('GET', '/api/driver/rides', (ctx) => {
  const { user } = requireDriver(ctx);
  const rows = all(`SELECT * FROM rides WHERE driver_id = ? ORDER BY COALESCE(checked_out_at, scheduled_at, created_at) DESC LIMIT 100`, user.id);
  return { rides: rows.map((r) => publicRide(r, user.id)) };
});

// What the Driving tab shows: earnings, and what others charge around here.
route('GET', '/api/driver/home', (ctx) => {
  const { user, driver } = requireDriver(ctx);
  const tz = Math.max(-840, Math.min(840, Number(ctx.query.get('tzMinutes')) || 0));
  const t = now();
  const dayStart = Math.floor((t + tz * 60_000) / 86_400_000) * 86_400_000 - tz * 60_000;
  const earned = (since) => get(`SELECT COALESCE(SUM(p.eur_cents), 0) AS c, COUNT(*) AS n FROM payouts p WHERE p.user_id = ? AND p.kind = 'payout' AND p.status != 'cancelled' AND p.created_at >= ?`, user.id, since);
  const today = earned(dayStart), total = earned(0);
  const pending = get(`SELECT COALESCE(SUM(eur_cents), 0) AS c FROM payouts WHERE user_id = ? AND kind = 'payout' AND status IN ('held', 'queued', 'sending', 'sent')`, user.id).c;
  const area = driver.lat == null ? null : areaAround(driver.lat, driver.lng);
  const planned = all(`SELECT * FROM rides WHERE driver_id = ? AND (status = 'scheduled' OR (status = 'awaiting_payment' AND scheduled_at IS NOT NULL)) ORDER BY scheduled_at LIMIT 10`, user.id);
  const offers = get(`SELECT COALESCE(SUM(kind = 'accepted'), 0) AS yes, COUNT(*) AS n FROM ride_events WHERE detail = ? AND kind IN ('accepted', 'declined', 'offer_expired')`, user.id);
  return {
    earnedTodayCents: today.c, ridesToday: today.n, earnedTotalCents: total.c, ridesTotal: total.n, pendingCents: pending,
    onTimePercent: arrivalScore(user.id).arrivalScore,
    acceptancePercent: offers.n ? Math.round((offers.yes / offers.n) * 100) : null,
    // Not counting this driver, if they're there.
    area: area ? { ...area, driversOnline: Math.max(0, area.driversOnline - (isOnline(driver) ? 1 : 0)) } : { driversOnline: 0, cheapestPerKmCents: null, middlePerKmCents: null, cheapestPerMinCents: null, middlePerMinCents: null },
    planned: planned.map((r) => publicRide(r, user.id)),
  };
});

// ---------- the app's wait-for-news call ----------

export function syncState(user) {
  const asRider = get(`SELECT * FROM rides WHERE rider_id = ? AND scheduled_at IS NULL AND status IN ('searching', 'awaiting_payment', 'offered', 'open', 'accepted', 'arrived', 'riding') ORDER BY created_at DESC LIMIT 1`, user.id)
    ?? get(`SELECT * FROM rides WHERE rider_id = ? AND status IN ('accepted', 'arrived', 'riding') ORDER BY created_at DESC LIMIT 1`, user.id);
  const out = { ride: asRider ? publicRide(asRider, user.id) : null, unreadMessages: unreadFor(user.id) };
  // A driver claimed a planned order: it's the rider's turn to pay now, however far off the ride itself is.
  const toPay = get(`SELECT * FROM rides WHERE rider_id = ? AND status = 'awaiting_payment' AND scheduled_at IS NOT NULL ORDER BY pay_by LIMIT 1`, user.id);
  if (toPay) out.toPay = publicRide(toPay, user.id);
  if (driverRow(user.id)) {
    const d = driverRow(user.id);
    const offer = get(`SELECT * FROM rides WHERE offered_to = ? AND status = 'offered' AND offered_until > ? ORDER BY offered_until DESC LIMIT 1`, user.id, now());
    // Waiting for the rider to pay counts as the drive: the driver can set off already.
    const drive = get(`SELECT * FROM rides WHERE driver_id = ? AND (status IN ${STATUS_ACTIVE} OR (status = 'awaiting_payment' AND scheduled_at IS NULL)) ORDER BY accepted_at DESC LIMIT 1`, user.id);
    out.driving = { online: isOnline(d), putOffline: Boolean(d.inactive_at), offer: offer ? publicRide(offer, user.id) : null, drive: drive ? publicRide(drive, user.id) : null,
      // Driving in the Netherlands in short (checks.js): a person's decision reaches the app with the next sync.
      checks: checksSummary(user.id) };
  }
  return out;
}

// ---------- on a timer ----------

export async function runPlanned() {
  const t = now();
  // Reminders.
  for (const r of all(`SELECT * FROM rides WHERE status = 'scheduled' AND plan_notice_sent = 0 AND scheduled_at - ? <= ?`, rules.planNoticeBefore, t)) {
    run('UPDATE rides SET plan_notice_sent = 1 WHERE id = ?', r.id);
    notify(r.driver_id, 'Planned drive soon', plannedLine(r), { rideId: r.id, kind: 'planned' });
    notify(r.rider_id, 'Your ride is coming up', `Your driver is planned to pick you up soon.`, { rideId: r.id });
  }
  // Time to go.
  for (const r of all(`SELECT * FROM rides WHERE status = 'scheduled' AND scheduled_at - ? <= ?`, rules.planStart, t)) {
    if (isBusy(r.driver_id)) {
      if (t > r.scheduled_at + rules.planNoShow) { event(r.id, 'driver_late', r.driver_id); await replan(r.id, r.driver_id); }
      continue;
    }
    if (r.scheduled_at + rules.planNoShow < t) { event(r.id, 'driver_late', r.driver_id); await replan(r.id, r.driver_id); continue; }
    const d = driverRow(r.driver_id);
    tx(() => run(`UPDATE rides SET status = 'accepted', accepted_at = ?, pickup_eta_at = ?, pickup_deadline_at = ?, car_id = COALESCE(?, car_id) WHERE id = ? AND status = 'scheduled'`, t, r.scheduled_at, r.scheduled_at + rules.planNoShow, d?.active_car_id, r.id));
    event(r.id, 'planned_started');
    touchBoth(r);
    notify(r.driver_id, 'Time to go', 'Your planned drive starts now. Go online and head to the pickup.', { rideId: r.id, kind: 'planned' });
  }
  // A driver who still isn't there and isn't online: the escrow pays only them, so it's refunded.
  for (const r of all(`SELECT * FROM rides WHERE status = 'accepted' AND scheduled_at IS NOT NULL AND scheduled_at + ? < ?`, rules.planNoShow, t)) {
    const d = driverRow(r.driver_id);
    if (isOnline(d, t)) continue;
    event(r.id, 'driver_no_show', r.driver_id);
    cancel(r, 'system', 'Your driver didn’t show up');
    notify(r.rider_id, 'Your driver didn’t show up', `${isCash(r) ? 'Nothing was paid.' : 'Everything is refunded to your wallet.'} You can book again.`, { rideId: r.id });
    notify(r.driver_id, 'Planned drive missed', 'You weren’t online for a planned drive.', { rideId: r.id });
  }
  // The driver's time to reach the pickup is over: the rider may cancel for free now, and hears so once.
  for (const r of all(`SELECT * FROM rides WHERE status IN ('accepted', 'arrived') AND late_notice_sent = 0 AND pickup_deadline_at IS NOT NULL AND pickup_deadline_at < ?
                       AND (arrived_at IS NULL OR arrived_at > pickup_deadline_at)`, t)) {
    run('UPDATE rides SET late_notice_sent = 1 WHERE id = ?', r.id);
    event(r.id, 'driver_late', r.driver_id);
    notify(r.rider_id, 'Your driver is late', `You can cancel ${isCash(r) ? 'for free' : 'for a full refund'} until you check in. If you see them coming your way on the map, we recommend waiting.`, { rideId: r.id, kind: 'late' });
    notify(r.driver_id, 'You’re late', isCash(r) ? 'You’re past your time to reach the pickup.' : 'The rider can now cancel for a full refund until they check in.', { rideId: r.id, kind: 'late' });
    touchBoth(r);
  }
  // A chosen driver didn't claim a planned order in time: now any driver can. There's still nothing to pay until one does.
  for (const r of all(`SELECT * FROM rides WHERE status = 'open' AND offered_to IS NOT NULL AND offered_until < ?`, t)) {
    run('UPDATE rides SET offered_to = NULL, offered_until = NULL WHERE id = ?', r.id);
    event(r.id, 'to_market', r.offered_to);
    bump(r.offered_to);
    notify(r.rider_id, 'Still looking for a driver', 'The driver you chose hasn’t answered, so others can claim your order now. You pay once one has.', { rideId: r.id });
    tellPlanned(rideRow(r.id), await plannedDrivers(r, r.offered_to));
  }
  // Orders nobody claimed: nothing was paid.
  for (const r of all(`SELECT * FROM rides WHERE status IN ('open', 'searching') AND ((scheduled_at IS NULL AND created_at + ? < ?) OR (scheduled_at IS NOT NULL AND scheduled_at < ?))`, rules.openExpiry, t, t)) {
    cancel(r, 'system', 'No driver claimed this order');
    notify(r.rider_id, 'No driver found', 'Nothing was paid. You can order again.', { rideId: r.id });
  }
  // Not paid in time: the driver is free again.
  for (const r of all(`SELECT * FROM rides WHERE status = 'awaiting_payment' AND pay_by < ?`, t)) {
    cancel(r, 'system', 'Not paid in time');
    notify(r.rider_id, 'Ride cancelled', 'It wasn’t paid in time. Nothing was paid.', { rideId: r.id });
    notify(r.driver_id, 'The rider didn’t pay', 'The ride is cancelled. You’re free for the next one.', { rideId: r.id });
  }
  // No check-out a day after the ride should have ended: refunded, unless the driver appealed (then an admin decides).
  for (const r of all(`SELECT * FROM rides WHERE status = 'riding' AND checked_in_at + duration_s * 1000 + ? < ?`, rules.noCheckOut, t)) {
    if (get(`SELECT 1 AS x FROM disputes WHERE ride_id = ? AND opened_by = ? AND status = 'open'`, r.id, r.driver_id)) continue;
    cancel(r, 'system', 'No check-out');
    if (isCash(r)) {
      notify(r.rider_id, 'Ride closed', 'Your driver never checked out at the drop-off, so this ride was closed.', { rideId: r.id });
      notify(r.driver_id, 'Ride closed', 'You didn’t check out at the drop-off, so this ride was closed.', { rideId: r.id });
      continue;
    }
    notify(r.rider_id, 'Refunded', 'Your driver never checked out at the drop-off, so everything is refunded to your wallet.', { rideId: r.id });
    notify(r.driver_id, 'Not paid', 'You didn’t check out at the drop-off, so the rider is refunded.', { rideId: r.id });
  }
}

// ---------- money ----------

// The escrow's outcome is on the chain: the payout record and the people follow.
function settled(e) {
  const r = rideRow(e.ride_id);
  if (!r) return;
  const payout = get(`SELECT * FROM payouts WHERE ride_id = ? AND kind = 'payout'`, r.id);
  const toDriver = e.outcome === 'payout' || e.outcome === 'split';
  if (payout) run(`UPDATE payouts SET status = ?, confirmed_at = ? WHERE id = ?`, toDriver ? 'confirmed' : 'cancelled', now(), payout.id);
  event(r.id, 'settled', `${e.outcome} ${e.settle_sig ?? ''}`);
  const amount = (units) => `${fromUnits(e.coin, units)} ${e.coin === 'sol' ? 'SOL' : 'USDC'}`;
  if (toDriver && r.driver_id) notify(r.driver_id, 'You’re paid', `${amount(payout?.units ?? 0)} reached your wallet.`, { rideId: r.id });
  if (e.outcome !== 'payout') notify(r.rider_id, e.outcome === 'split' ? 'Half refunded' : 'Refunded', e.outcome === 'split' ? 'Half of the price is back in your wallet.' : 'Everything is back in your wallet.', { rideId: r.id });
  touchBoth(r);
}

// How much of the way the driver got, from 0 to 1. Measured as the crow flies both ways: against the route's length, a winding
// route counts a driver who hardly moved as most of the way there.
export function drivenShare(r) {
  const whole = metres(r.pickup_lat, r.pickup_lng, r.dropoff_lat, r.dropoff_lng);
  return r.closest_m != null && whole ? Math.max(0, 1 - r.closest_m / whole) : null;
}

// An appeal holds the money until an admin decides, or the escrow's 30 days are over and it's refunded. One exception by
// default, if no admin got to it: a driver's own appeal after driving most of the way pays the driver.
function defaultDecisions(t) {
  for (const dis of all(`SELECT * FROM disputes WHERE status = 'open' AND created_at + ? < ?`, rules.disputeAutoAfter, t)) {
    const r = rideRow(dis.ride_id);
    if (!r?.driver_id || dis.opened_by !== r.driver_id || isCash(r)) continue;
    if ((drivenShare(r) ?? 0) < rules.driverDefault) continue;
    try { decideDispute(dis.id, 'pay_driver', 'The driver drove most of the way.', 'drivezzz'); } catch (e) { console.error('[drivezzz] default decision:', e.message); }
  }
}

// The first start on a real chain, after the pretend one: what was pretended stops here. Rides under way end, and escrows that
// never existed are closed without asking the network, whose jobs can't read their made-up addresses. Cash rides go on.
export function leavePretendChain() {
  if (escrow.pretendChain() || getMeta('chain:real')) return;
  setMeta('chain:real', String(now()));
  const going = all(`SELECT r.* FROM rides r JOIN users u ON u.id = r.rider_id
                     WHERE r.status IN ('awaiting_payment', 'scheduled', 'accepted', 'arrived', 'riding') AND r.coin != ? AND u.is_demo = 0`, CASH);
  for (const r of going) cancel(r, 'system', 'The test period is over');
  const t = now();
  tx(() => {
    run(`UPDATE payouts SET status = 'cancelled', confirmed_at = ? WHERE status = 'held' AND ride_id IN (SELECT ride_id FROM escrows WHERE address LIKE 'fake-%')`, t);
    run(`UPDATE escrows SET status = 'settled', settled_at = ?, error = 'From the pretend chain' WHERE address LIKE 'fake-%' AND status IN ('requested', 'paid', 'settling')`, t);
  });
  if (going.length) console.log(`[drivezzz] left the pretend chain: ${going.length} ride(s) ended`);
}

export const watchPayments = () => escrow.watchPayments(paid);
export async function runMoney() {
  defaultDecisions(now());
  await escrow.runSettlements(settled);
}

// Where people were during a ride is only kept as long as an appeal could need it. These are the periods in Privacy.
export function forgetOldPoints() {
  run('DELETE FROM ride_points WHERE at < ?', now() - rules.keepPointsDays * 86_400_000);
  run('DELETE FROM online_log WHERE ended_at < ?', now() - rules.keepOnlineDays * 86_400_000);
  run(`DELETE FROM support_requests WHERE status = 'closed' AND created_at < ?`, now() - rules.keepSupportDays * 86_400_000);
}

export function runOffline() {
  const t = now();
  for (const d of all('SELECT user_id, heartbeat_at FROM drivers WHERE online_since IS NOT NULL AND (heartbeat_at IS NULL OR heartbeat_at < ?)', t - rules.onlineTimeout)) {
    setOffline(d.user_id, d.heartbeat_at ?? t);
  }
}

// What a ban does: a banned rider's waiting orders go, a banned driver stops and hands back what isn't under way.
setOnBan((userId) => {
  // Banned for good: their wallets too, so a new phone and account with the same wallet don't get back in.
  if (get(`SELECT 1 AS x FROM bans WHERE user_id = ? AND kind = 'permanent' AND lifted_at IS NULL`, userId)) {
    const t = now();
    const addresses = [...all('SELECT address FROM wallets WHERE user_id = ?', userId).map((w) => w.address),
      ...all('SELECT DISTINCT e.payer AS address FROM escrows e JOIN rides r ON r.id = e.ride_id WHERE r.rider_id = ?', userId).map((w) => w.address)];
    for (const a of new Set(addresses)) run('INSERT OR IGNORE INTO banned_wallets (address, user_id, created_at) VALUES (?, ?, ?)', a, userId, t);
  }
  for (const r of all(`SELECT * FROM rides WHERE rider_id = ? AND status IN ('searching', 'awaiting_payment', 'offered', 'open', 'scheduled', 'accepted', 'arrived')`, userId)) {
    cancel(r, 'system', 'The rider was banned');
    if (r.driver_id) notify(r.driver_id, 'Ride cancelled', 'This ride was cancelled by Drivezzz.', { rideId: r.id });
  }
  const d = driverRow(userId);
  if (!d) return;
  if (d.online_since) setOffline(userId);
  for (const r of all(`SELECT * FROM rides WHERE driver_id = ? AND status IN ('awaiting_payment', 'accepted', 'arrived')`, userId)) {
    cancel(r, 'system', 'Your driver can’t drive any more');
    notify(r.rider_id, 'Your driver cancelled', isCash(r) ? 'Nothing was paid.' : 'Anything you paid is refunded to your wallet.', { rideId: r.id });
  }
  for (const r of all(`SELECT id FROM rides WHERE driver_id = ? AND status = 'scheduled'`, userId)) {
    replan(r.id, userId).catch((e) => console.error('[drivezzz] replan', e));
  }
});

export { rideRow };
