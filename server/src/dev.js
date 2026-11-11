// Only with DEV=1, on test servers: quick ways to set up a test. Money is real devnet money through the escrow.
import fs from 'node:fs';
import path from 'node:path';
import { get, moveClock, now, PHOTO_DIR, run, uid } from './db.js';
import { ApiError, route } from './http.js';
import * as coins from './coins.js';
import { setOnline } from './drivers.js';
import { DRIVER_DEFAULTS } from './config.js';
import { bump } from './sync.js';
import { expireOffers, forgetOldPoints, runMoney, runOffline, runPlanned, watchPayments } from './rides.js';
import { runDemo } from './demo.js';
import { runChecks } from './checks.js';
import { paymentFor } from './escrow.js';
import { payoutAddress } from './wallet.js';

const PLATES = [['Toyota', 'Prius', 'White', '#F4F4F2', 'hatchback', 4], ['Tesla', 'Model 3', 'Black', '#1C1C1E', 'sedan', 4], ['Volkswagen', 'Touran', 'Blue', '#1F4E9E', 'mpv', 6], ['Skoda', 'Octavia', 'Grey', '#8A8D91', 'estate', 4], ['Kia', 'Niro', 'Red', '#B3202A', 'suv', 4]];

route('POST', '/dev/driver', (ctx) => {
  const q = ctx.query;
  const id = q.get('id') || `dz-${uid().slice(0, 6)}`;
  const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
  const t = now();
  if (!get('SELECT 1 AS x FROM users WHERE id = ?', id)) run('INSERT INTO users (id, name, is_driver, last_seen_at, created_at) VALUES (?, ?, 1, ?, ?)', id, q.get('name') || id, t, t);
  if (!get('SELECT 1 AS x FROM drivers WHERE user_id = ?', id)) {
    const perKm = Number(q.get('perKm')) || DRIVER_DEFAULTS.perKmCents, perMin = Number(q.get('perMin')) || DRIVER_DEFAULTS.perMinCents, pickup = Number(q.get('pickup')) || DRIVER_DEFAULTS.pickupPerKmCents;
    run('INSERT INTO drivers (user_id, per_km_cents, per_min_cents, pickup_per_km_cents, allows_planning, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, perKm, perMin, pickup, q.get('plans') === '0' ? 0 : 1, t);
    const [make, model, colorName, hex, body, seats] = PLATES[Math.abs(id.charCodeAt(4)) % PLATES.length];
    const car = uid('car_');
    run('INSERT INTO cars (id, user_id, plate, make, model, color_name, color_hex, body, seats, verified, per_km_cents, per_min_cents, pickup_per_km_cents, pets_allowed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
      car, id, q.get('plate') || `${id.slice(3, 5).toUpperCase()}123${id.slice(5, 6).toUpperCase()}`, make, model, colorName, hex, body, seats, perKm, perMin, pickup, q.get('pets') === '1' ? 1 : 0, t);
    run('UPDATE drivers SET active_car_id = ? WHERE user_id = ?', car, id);
    for (const kind of ['front', 'back', 'inside']) {
      const photo = uid('ph_');
      fs.copyFileSync(new URL(`../test/photos/${kind}.jpg`, import.meta.url), path.join(PHOTO_DIR, `${photo}.jpg`));
      run('INSERT INTO car_photos (id, car_id, kind, file, created_at) VALUES (?, ?, ?, ?, ?)', photo, car, kind, `${photo}.jpg`, t);
    }
    for (const coin of coins.ASSET_IDS) {
      const addr = q.get('wallet') || '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
      run('INSERT OR REPLACE INTO wallets (user_id, coin, address, enabled, updated_at) VALUES (?, ?, ?, 1, ?)', id, coin, addr, t);
    }
  }
  if (q.get('online') !== '0') setOnline(id, lat, lng);
  return { id };
});

route('POST', '/dev/move', (ctx) => {
  const id = ctx.query.get('id');
  const lat = Number(ctx.query.get('lat')), lng = Number(ctx.query.get('lng'));
  run('UPDATE users SET lat = ?, lng = ?, loc_at = ? WHERE id = ?', lat, lng, now(), id);
  run('UPDATE drivers SET lat = ?, lng = ?, loc_at = ?, heartbeat_at = ? WHERE user_id = ?', lat, lng, now(), now(), id);
  bump(id);
  return { ok: true };
});

// The money jobs on their own: payments seen on the (pretend) chain, and outcomes sent.
route('POST', '/dev/payments', async () => { await watchPayments(); return { ok: true }; });
route('POST', '/dev/money', async () => { await runMoney(); return { ok: true }; });
route('POST', '/dev/tick', async () => {
  forgetOldPoints();
  expireOffers();
  runOffline();
  await runPlanned();
  await watchPayments();
  await runMoney();
  await runDemo();
  await runChecks();
  return { ok: true };
});
// A rider without a wallet app, on a test server with ESCROW_FAKE: as if they paid.
route('POST', '/dev/pay', async (ctx) => {
  const r = get('SELECT * FROM rides WHERE id = ?', ctx.query.get('ride'));
  if (r?.status !== 'awaiting_payment') throw new ApiError(409, 'not_waiting', 'This ride isn’t waiting for a payment.');
  await paymentFor(r, ctx.query.get('wallet') || '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', payoutAddress(r.driver_id, r.coin));
  await watchPayments();
  return { ok: true };
});
// As if the server crashed before it noted a settled escrow: it thinks the outcome still has to be sent.
route('POST', '/dev/forget-settled', (ctx) => {
  run(`UPDATE escrows SET status = 'paid', settle_sig = NULL, settled_at = NULL, settle_after = ? WHERE ride_id = ? AND status = 'settled'`, now(), ctx.query.get('ride'));
  return { ok: true };
});
route('POST', '/dev/make-demo', (ctx) => {
  run('UPDATE users SET is_demo = 1 WHERE id = ?', ctx.query.get('id'));
  return { ok: true };
});
route('POST', '/dev/clock', async (ctx) => { moveClock(Number(ctx.query.get('ms')) || 0); if (process.env.WORKERS) await new Promise((r) => setTimeout(r, 50)); return { now: now() }; });
