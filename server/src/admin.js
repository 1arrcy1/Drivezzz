// The admin panel's API, behind an email and password. A signed cookie keeps the session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, getMeta, now, PHOTO_DIR, run, setMeta, tx, uid } from './db.js';
import { checkPassword, hashPassword } from './auth.js';
import { config, rules } from './config.js';
import { ApiError, clientIp, cookies, limit, num, route, safeEqual, text } from './http.js';
import { banForDevice, banForPerson, banUser, decideAppeal, giveStrike, liftBan, liveBansOf, strikeCount } from './standing.js';
import { APPEAL_DECISIONS, DECISIONS, decideDispute, decideRide, drivenShare, holdRide, publicRide, runMoney, syncScore, rideRow } from './rides.js';
import * as coins from './coins.js';
import * as escrow from './escrow.js';
import * as sol from './solana.js';
import { decodePolyline } from './geo.js';
import { completedScore, arrivalScore, isOnline, driverRow } from './drivers.js';
import { bump } from './sync.js';
import { CHECK_WAITS, checkFile, checkRow, decideCheck, plateReason, publicChecks } from './checks.js';
import { notify } from './push.js';
import { linkList, removeLink, saveLink } from './links.js';

const COOKIE = 'dz_admin';
const LIFETIME = 12 * 3600_000;

function secret() {
  let s = getMeta('admin:secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setMeta('admin:secret', s); }
  return s;
}
// The password's hash is part of what's signed, so a new password signs out every other browser.
const sign = (v) => crypto.createHmac('sha256', secret()).update(`${v}.${getMeta('admin:password')}`).digest('base64url');

function requireSignedIn(ctx) {
  const c = cookies(ctx.req)[COOKIE] ?? '';
  const [until, sig] = c.split('.');
  if (!until || !sig || !safeEqual(sig, sign(until)) || Number(until) < Date.now()) throw new ApiError(401, 'admin_signed_out', 'Please log in.');
}
function requireAdmin(ctx) {
  requireSignedIn(ctx);
  // The first password is only to get in: nothing works until there's a new one.
  if (getMeta('admin:must_change')) throw new ApiError(403, 'change_password', 'Choose a new password first.');
}
function startSession(ctx) {
  const until = String(Date.now() + LIFETIME);
  const secure = config.dev ? '' : '; Secure';
  ctx.setHeader('Set-Cookie', `${COOKIE}=${until}.${sign(until)}; HttpOnly; SameSite=Strict; Path=/admin${secure}; Max-Age=${LIFETIME / 1000}`);
}
const log = (action, target, detail) => run('INSERT INTO admin_log (id, at, action, target, detail) VALUES (?, ?, ?, ?, ?)', uid('al_'), now(), action, target ?? null, detail ?? null);

route('POST', '/admin/api/login', (ctx) => {
  if (!limit(`admin:${clientIp(ctx.req)}`, 10, 900_000)) throw new ApiError(429, 'too_many', 'Too many tries. Wait a while.');
  const stored = getMeta('admin:password');
  if (!stored) throw new ApiError(503, 'no_admin', 'The admin login isn’t set on the server.');
  const rightPassword = typeof ctx.body.password === 'string' && checkPassword(ctx.body.password, stored);
  if (!rightPassword || text(ctx.body.email, 200).toLowerCase() !== getMeta('admin:email')) throw new ApiError(401, 'wrong', 'That email or password isn’t right.');
  startSession(ctx);
  return { ok: true, mustChangePassword: Boolean(getMeta('admin:must_change')) };
});
route('POST', '/admin/api/password', (ctx) => {
  requireSignedIn(ctx);
  if (!limit(`admin-password:${clientIp(ctx.req)}`, 10, 900_000)) throw new ApiError(429, 'too_many', 'Too many tries. Wait a while.');
  const { current, password } = ctx.body;
  if (typeof current !== 'string' || !checkPassword(current, getMeta('admin:password'))) throw new ApiError(400, 'wrong_current', 'That isn’t your current password.');
  if (typeof password !== 'string' || password.length < 10) throw new ApiError(400, 'bad_password', 'Use at least 10 characters for your new password.');
  if (password === current) throw new ApiError(400, 'same_password', 'Choose a different password.');
  setMeta('admin:password', hashPassword(password));
  setMeta('admin:must_change', '');
  log('admin_password_changed');
  startSession(ctx);
  return { ok: true };
});
route('POST', '/admin/api/logout', (ctx) => {
  ctx.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
  return { ok: true };
});

const onlineSince = () => now() - rules.onlineTimeout;

function userRow(u) {
  const d = driverRow(u.id);
  const ban = liveBansOf(u.id)[0];
  const ride = get(`SELECT id, status FROM rides WHERE (rider_id = ? OR driver_id = ?) AND status IN ('accepted', 'arrived', 'riding') LIMIT 1`, u.id, u.id);
  return {
    id: u.id, name: u.name, email: u.email ?? null, lat: u.lat, lng: u.lng, locAt: u.loc_at, lastSeenAt: u.last_seen_at, createdAt: u.created_at,
    deleted: Boolean(u.deleted_at), demo: Boolean(u.is_demo), isDriver: Boolean(u.is_driver), driving: isOnline(d),
    online: u.last_seen_at > onlineSince() || isOnline(d),
    strikes: strikeCount(u.id), ban: ban ? { kind: ban.kind, reason: ban.reason, endsAt: ban.ends_at, viaPhone: ban.user_id !== u.id, viaPerson: ban.user_id !== u.id && banForPerson(u.id)?.id === ban.id } : null,
    ride: ride ? { id: ride.id, status: ride.status } : null,
    devices: get('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?', u.id).n,
    ...(u.is_driver ? { ...completedScore(u.id), arrivalScore: arrivalScore(u.id).arrivalScore } : {}),
  };
}

route('GET', '/admin/api/overview', (ctx) => {
  requireAdmin(ctx);
  const since = onlineSince();
  return {
    maxStrikes: rules.maxStrikes,
    faceAutoMatch: rules.faceAutoMatch,
    pretendChain: process.env.PRETEND_CHAIN === '1',
    online: get('SELECT COUNT(*) AS n FROM users WHERE last_seen_at > ? AND deleted_at IS NULL AND is_demo = 0', since).n,
    driving: get('SELECT COUNT(*) AS n FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.online_since IS NOT NULL AND d.heartbeat_at > ? AND u.is_demo = 0', since).n,
    users: get('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND is_demo = 0').n,
    reportsOpen: get(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`).n,
    supportOpen: get(`SELECT COUNT(*) AS n FROM support_requests WHERE status = 'open'`).n,
    walletChangesOpen: get(`SELECT COUNT(*) AS n FROM wallet_change_requests WHERE status = 'open'`).n,
    checksOpen: get(`SELECT COUNT(*) AS n FROM driver_checks c WHERE ${CHECK_WAITS}`).n,
    ridesLive: get(`SELECT COUNT(*) AS n FROM rides WHERE status IN ('accepted', 'arrived', 'riding') AND rider_id NOT IN (SELECT id FROM users WHERE is_demo = 1)`).n,
    ordersOpen: get(`SELECT COUNT(*) AS n FROM rides WHERE status IN ('offered', 'open', 'scheduled') AND rider_id NOT IN (SELECT id FROM users WHERE is_demo = 1)`).n,
    appealsOpen: get(`SELECT COUNT(*) AS n FROM appeals WHERE status = 'open'`).n,
    disputesOpen: get(`SELECT COUNT(*) AS n FROM disputes WHERE status = 'open'`).n,
    // Escrows whose outcome didn't go through on its last try (the error says why); they're tried again by themselves.
    escrowErrors: get(`SELECT COUNT(*) AS n FROM escrows WHERE status = 'paid' AND error IS NOT NULL`).n,
    network: coins.network(),
  };
});

route('GET', '/admin/api/users', (ctx) => {
  requireAdmin(ctx);
  const filter = ctx.query.get('filter') ?? 'online';
  const q = `%${text(ctx.query.get('q'), 100)}%`;
  const since = onlineSince();
  const t = now();
  const where = {
    online: `(u.last_seen_at > ${since} OR EXISTS (SELECT 1 FROM drivers d WHERE d.user_id = u.id AND d.online_since IS NOT NULL AND d.heartbeat_at > ${since}))`,
    drivers: 'u.is_driver = 1',
    banned: `(EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id AND b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > ${t}))
              OR EXISTS (SELECT 1 FROM user_devices d JOIN banned_devices bd ON bd.device_id = d.device_id JOIN bans b ON b.id = bd.ban_id
                         WHERE d.user_id = u.id AND b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > ${t})))`,
    all: '1 = 1',
  }[filter] ?? '1 = 1';
  const rows = all(`SELECT u.* FROM users u WHERE ${where} AND u.deleted_at IS NULL AND u.id NOT LIKE 'demo-%' AND (u.id LIKE ? OR u.name LIKE ? OR COALESCE(u.email, '') LIKE ?) ORDER BY u.last_seen_at DESC LIMIT 200`, q, q, q);
  return { users: rows.map(userRow) };
});

route('GET', '/admin/api/users/:id', (ctx) => {
  requireAdmin(ctx);
  const u = get('SELECT * FROM users WHERE id = ?', ctx.params.id);
  if (!u) throw new ApiError(404, 'not_found', 'Not found.');
  return {
    user: userRow(u),
    strikes: all('SELECT id, reason, given_by, created_at, removed_at, removed_why FROM strikes WHERE user_id = ? ORDER BY created_at DESC', u.id),
    bans: all('SELECT id, kind, reason, given_by, created_at, ends_at, lifted_at, lifted_why FROM bans WHERE user_id = ? ORDER BY created_at DESC', u.id),
    appeals: all('SELECT * FROM appeals WHERE user_id = ? ORDER BY created_at DESC', u.id),
    devices: all('SELECT device_id, last_seen_at FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC', u.id)
      .map((d) => ({ ...d, banned: Boolean(banForDevice(d.device_id)) })),
    held: all(`SELECT e.ride_id, e.coin, e.units, e.status, e.outcome FROM escrows e JOIN rides r ON r.id = e.ride_id WHERE r.rider_id = ? AND e.status IN ('paid', 'settling')`, u.id)
      .map((e) => ({ rideId: e.ride_id, coin: e.coin, amount: coins.fromUnits(e.coin, BigInt(e.units)), status: e.status, outcome: e.outcome })),
    bannedWallets: all('SELECT address, created_at FROM banned_wallets WHERE user_id = ?', u.id),
    wallets: all('SELECT coin, address, tag, via, enabled, updated_at FROM wallets WHERE user_id = ? ORDER BY coin', u.id),
    rides: all('SELECT id, status, rider_id, driver_id, price_cents, max_cents, coin, created_at FROM rides WHERE rider_id = ? OR driver_id = ? ORDER BY created_at DESC LIMIT 50', u.id, u.id),
    bio: driverRow(u.id)?.bio ?? null,
    rulesSeenAt: driverRow(u.id)?.rules_seen_at ?? null,
    eula: u.eula_accepted_at ? { version: u.eula_version, at: u.eula_accepted_at } : null,
    photos: all(`SELECT p.id, p.kind, c.plate FROM car_photos p JOIN cars c ON c.id = p.car_id WHERE c.user_id = ? ORDER BY p.created_at DESC LIMIT 40`, u.id).map((p) => ({ ...p, url: `/api/car-photos/${p.id}` })),
    reviews: all('SELECT ride_id, stars, text, created_at FROM reviews WHERE driver_id = ? ORDER BY created_at DESC LIMIT 40', u.id),
    reports: all('SELECT reason, message, status, created_at, reporter_id FROM reports WHERE target_id = ? ORDER BY created_at DESC LIMIT 40', u.id),
  };
});

// Removing a connected address: only here, after a support request.
route('POST', '/admin/api/users/:id/wallets/:coin/remove', (ctx) => {
  requireAdmin(ctx);
  const w = get('SELECT * FROM wallets WHERE user_id = ? AND coin = ?', ctx.params.id, ctx.params.coin);
  if (!w) throw new ApiError(404, 'not_found', 'Not found.');
  if (get(`SELECT 1 AS x FROM payouts WHERE user_id = ? AND coin = ? AND status IN ('held', 'queued', 'sending', 'sent', 'stuck')`, w.user_id, w.coin)) {
    throw new ApiError(409, 'sending', 'A payment to this address is waiting or on its way: deal with that first.');
  }
  run('DELETE FROM wallets WHERE user_id = ? AND coin = ?', w.user_id, w.coin);
  log('wallet_removed', w.user_id, `${w.coin} ${w.address}`);
  bump(w.user_id);
  return { ok: true };
});

route('POST', '/admin/api/users/:id/ban', (ctx) => {
  requireAdmin(ctx);
  if (!get('SELECT 1 AS x FROM users WHERE id = ?', ctx.params.id)) throw new ApiError(404, 'not_found', 'Not found.');
  const reason = text(ctx.body.reason, 300);
  if (!reason) throw new ApiError(400, 'no_reason', 'Say why: the person sees this.');
  const out = banUser(ctx.params.id, ctx.body.kind === 'week' ? 'week' : 'permanent', reason, 'admin');
  log('ban', ctx.params.id, `${ctx.body.kind}: ${reason}`);
  return out;
});
route('POST', '/admin/api/users/:id/strike', (ctx) => {
  requireAdmin(ctx);
  if (!get('SELECT 1 AS x FROM users WHERE id = ?', ctx.params.id)) throw new ApiError(404, 'not_found', 'Not found.');
  const reason = text(ctx.body.reason, 300);
  if (!reason) throw new ApiError(400, 'no_reason', 'Say why: the person sees this.');
  const out = giveStrike(ctx.params.id, reason, 'admin');
  log('strike', ctx.params.id, reason);
  return out;
});
route('POST', '/admin/api/users/:id/unban', (ctx) => {
  requireAdmin(ctx);
  const why = text(ctx.body.why, 300) || 'Lifted by an admin';
  const live = liveBansOf(ctx.params.id);
  if (!live.length) throw new ApiError(409, 'not_banned', 'This person isn’t banned.');
  for (const b of live) liftBan(b.id, why, 'admin');
  log('unban', ctx.params.id, why);
  return { ok: true };
});
route('POST', '/admin/api/strikes/:id/remove', (ctx) => {
  requireAdmin(ctx);
  const s = get('SELECT * FROM strikes WHERE id = ? AND removed_at IS NULL', ctx.params.id);
  if (!s) throw new ApiError(404, 'not_found', 'Not found.');
  const why = text(ctx.body.why, 300) || 'Removed by an admin';
  run('UPDATE strikes SET removed_at = ?, removed_why = ? WHERE id = ?', now(), why, s.id);
  bump(s.user_id);
  log('strike_removed', s.user_id, why);
  return { ok: true };
});

// ---------- reports and what can be taken down ----------

route('GET', '/admin/api/reports', (ctx) => {
  requireAdmin(ctx);
  const rows = all(`SELECT r.*, a.name AS reporter_name, b.name AS target_name FROM reports r JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.target_id
                    WHERE (? = 'all' OR r.status = 'open') ORDER BY r.created_at DESC LIMIT 200`, ctx.query.get('filter') ?? 'open');
  return { reports: rows.map((r) => ({ ...r, chat: r.chat ? JSON.parse(r.chat) : null })) };
});
route('POST', '/admin/api/reports/:id/close', (ctx) => {
  requireAdmin(ctx);
  run(`UPDATE reports SET status = 'closed', note = ?, closed_at = ? WHERE id = ?`, text(ctx.body.note, 500) || null, now(), ctx.params.id);
  log('report_closed', ctx.params.id);
  return { ok: true };
});
route('GET', '/admin/api/support', (ctx) => {
  requireAdmin(ctx);
  return { requests: all(`SELECT * FROM support_requests WHERE (? = 'all' OR status = 'open') ORDER BY created_at DESC LIMIT 200`, ctx.query.get('filter') ?? 'open') };
});
route('POST', '/admin/api/support/:id/close', (ctx) => {
  requireAdmin(ctx);
  run(`UPDATE support_requests SET status = 'closed' WHERE id = ?`, ctx.params.id);
  return { ok: true };
});
// Requests to change a connected wallet (wallet.js). What's next to the message is there to help judge whether it's really them.
route('GET', '/admin/api/wallet-changes', (ctx) => {
  requireAdmin(ctx);
  const filter = ctx.query.get('filter') ?? 'open';
  const rows = all(`SELECT r.*, u.name, u.email, u.created_at AS joined_at FROM wallet_change_requests r JOIN users u ON u.id = r.user_id
                    WHERE (? = 'all' OR r.status = ?) ORDER BY r.created_at DESC LIMIT 200`, filter, filter);
  return {
    requests: rows.map((r) => ({
      ...r,
      wallets: all('SELECT coin, address, via, updated_at FROM wallets WHERE user_id = ? ORDER BY coin', r.user_id),
      drives: get(`SELECT COUNT(*) AS n FROM rides WHERE driver_id = ? AND status = 'completed'`, r.user_id).n,
      earlier: get('SELECT COUNT(*) AS n FROM wallet_change_requests WHERE user_id = ? AND id != ?', r.user_id, r.id).n,
    })),
  };
});
route('POST', '/admin/api/wallet-changes/:id', (ctx) => {
  requireAdmin(ctx);
  const allow = ctx.body.decision === 'allow';
  if (!allow && ctx.body.decision !== 'decline') throw new ApiError(400, 'bad_decision', 'Allow or decline.');
  const r = get('SELECT * FROM wallet_change_requests WHERE id = ?', ctx.params.id);
  if (!r) throw new ApiError(404, 'not_found', 'Not found.');
  // Declining also takes back a yes that hasn't been used.
  if (r.status !== 'open' && (allow || r.status !== 'allowed')) throw new ApiError(409, 'decided', 'This one was already decided.');
  run('UPDATE wallet_change_requests SET status = ?, decided_at = ? WHERE id = ?', allow ? 'allowed' : 'declined', now(), r.id);
  log(allow ? 'wallet_change_allowed' : 'wallet_change_declined', r.user_id, r.id);
  if (allow) notify(r.user_id, 'You can change your wallet', 'Support said yes. Open Wallet in Drivezzz to connect the new one.');
  else notify(r.user_id, 'Your wallet stays as it is', 'Support didn’t allow this wallet change.');
  return { ok: true };
});
// Driver checks in the Netherlands (checks.js): what waits for a person, and their decision.
// An approved driver's new car can wait too: its plate is the only reason then.
function withReasons(r) {
  const reasons = r.review_reasons ? JSON.parse(r.review_reasons) : [];
  const plate = plateReason(r.user_id);
  return { ...r, review_reasons: plate && !reasons.includes(plate) ? [...reasons, plate] : reasons };
}
route('GET', '/admin/api/checks', (ctx) => {
  requireAdmin(ctx);
  const filter = ctx.query.get('filter') ?? 'review';
  const rows = all(`SELECT c.user_id, c.status, c.auto, c.surname, c.given_names, c.doc_country, c.face_score, c.review_reasons, c.submitted_at, c.decided_at, c.decided_by, c.updated_at,
                    u.name, u.email FROM driver_checks c JOIN users u ON u.id = c.user_id
                    WHERE (? = 'all' OR (? = 'review' AND ${CHECK_WAITS}) OR c.status = ?) ORDER BY COALESCE(c.submitted_at, c.updated_at) DESC LIMIT 200`, filter, filter, filter);
  return { checks: rows.map(withReasons) };
});
route('GET', '/admin/api/checks/:id', (ctx) => {
  requireAdmin(ctx);
  const c = checkRow(ctx.params.id);
  const user = get('SELECT * FROM users WHERE id = ?', ctx.params.id);
  if (!c || !user) throw new ApiError(404, 'not_found', 'Not found.');
  const { doc_hash: docHash, chip_dg1_hash: _dg1, ...shown } = c;
  return {
    check: { ...withReasons(shown), files: { ck: Boolean(c.ck_file), permit: Boolean(c.permit_file), face: Boolean(c.face_file) } },
    user: { id: user.id, name: user.name, email: user.email, joinedAt: user.created_at, isDemo: Boolean(user.is_demo) },
    // The same ID on other accounts.
    sameId: docHash ? all('SELECT c.user_id, c.status, u.name FROM driver_checks c JOIN users u ON u.id = c.user_id WHERE c.doc_hash = ? AND c.user_id != ?', docHash, c.user_id) : [],
    vehicles: publicChecks(user).vehicles.map((v) => {
      const back = get(`SELECT id FROM car_photos WHERE car_id = ? AND kind = 'back'`, v.id);
      return { ...v, backPhoto: back ? `/api/car-photos/${back.id}` : null };
    }),
    drives: get(`SELECT COUNT(*) AS n FROM rides WHERE driver_id = ? AND status = 'completed'`, user.id).n,
    // The phones that proved they run the real app (App Attest, Android's Key Attestation): without one nothing they sent is signed.
    signingKeys: all('SELECT environment, created_at AS at FROM attest_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', user.id),
  };
});
route('GET', '/admin/api/checks/:id/file/:kind', (ctx) => {
  requireAdmin(ctx);
  const c = checkRow(ctx.params.id);
  const file = checkFile({ ck: c?.ck_file, permit: c?.permit_file, face: c?.face_file }[ctx.params.kind]);
  if (!file || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'This photo is no longer here.');
  ctx.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store, private' });
  ctx.res.end(fs.readFileSync(file));
});
route('POST', '/admin/api/checks/:id', (ctx) => {
  requireAdmin(ctx);
  const decision = text(ctx.body.decision, 30);
  const note = text(ctx.body.note, 500);
  decideCheck(ctx.params.id, decision, note, 'admin');
  log(`check_${decision.replace(':', '_')}`, ctx.params.id, note || null);
  return { ok: true };
});
route('POST', '/admin/api/photos/:id/remove', (ctx) => {
  requireAdmin(ctx);
  const p = get('SELECT * FROM car_photos WHERE id = ?', ctx.params.id);
  if (!p) throw new ApiError(404, 'not_found', 'Not found.');
  run('DELETE FROM car_photos WHERE id = ?', p.id);
  fs.rmSync(path.join(PHOTO_DIR, p.file), { force: true });
  log('photo_removed', p.id);
  return { ok: true };
});
route('POST', '/admin/api/reviews/:id/remove', (ctx) => {
  requireAdmin(ctx);
  run('DELETE FROM reviews WHERE ride_id = ?', ctx.params.id);
  log('review_removed', ctx.params.id);
  return { ok: true };
});
route('POST', '/admin/api/users/:id/clean', (ctx) => {
  requireAdmin(ctx);
  const u = get('SELECT * FROM users WHERE id = ?', ctx.params.id);
  if (!u) throw new ApiError(404, 'not_found', 'Not found.');
  // Back to their user ID as a name, and no bio.
  run('UPDATE users SET name = id WHERE id = ?', u.id);
  run('UPDATE drivers SET bio = NULL WHERE user_id = ?', u.id);
  bump(u.id);
  log('profile_cleaned', u.id);
  return { ok: true };
});

route('GET', '/admin/api/appeals', (ctx) => {
  requireAdmin(ctx);
  const rows = all(`SELECT a.*, u.name, b.kind, b.reason, b.ends_at FROM appeals a JOIN users u ON u.id = a.user_id JOIN bans b ON b.id = a.ban_id
                    WHERE (? = 'all' OR a.status = 'open') ORDER BY a.created_at DESC LIMIT 200`, ctx.query.get('filter') ?? 'open');
  return { appeals: rows };
});
route('POST', '/admin/api/appeals/:id', (ctx) => {
  requireAdmin(ctx);
  const decision = ctx.body.decision === 'lift' ? 'lift' : 'uphold';
  const out = decideAppeal(ctx.params.id, decision, text(ctx.body.answer, 1000), 'admin');
  log(`appeal_${decision}`, ctx.params.id);
  return { appeal: out };
});

const adminEscrow = (e) => e && {
  id: e.id, status: e.status, outcome: e.outcome, settleAfter: e.settle_after, onHold: Boolean(e.manual_hold), error: e.error, coin: e.coin, payer: e.payer, driverAddress: e.driver_address,
  amount: coins.fromUnits(e.coin, BigInt(e.units)), fee: coins.fromUnits(e.coin, BigInt(e.fee_units)),
  explorer: sol.explorerAddress(e.address), settleExplorer: e.settle_sig ? sol.explorerTx(e.settle_sig) : null,
};

function adminRide(r) {
  const names = (id) => (id ? get('SELECT name FROM users WHERE id = ?', id)?.name : null);
  return {
    id: r.id, status: r.status, mode: r.mode, scheduledAt: r.scheduled_at, riderId: r.rider_id, riderName: names(r.rider_id), driverId: r.driver_id, driverName: names(r.driver_id),
    pickup: r.pickup_label, dropoff: r.dropoff_label, dropoffMovedM: r.dropoff_moved_m, distanceM: r.distance_m, priceCents: r.price_cents, maxCents: r.max_cents, coin: r.coin, coinAmount: r.coin_units ? coins.fromUnits(r.coin, BigInt(r.coin_units)) : null,
    escrow: adminEscrow(escrow.paidEscrow(r.id)), checkoutWarning: Boolean(r.checkout_warning),
    progress: drivenShare(r) == null ? null : Math.round(drivenShare(r) * 100),
    createdAt: r.created_at, checkedInAt: r.checked_in_at, checkedOutAt: r.checked_out_at, cancelledBy: r.cancelled_by, cancelReason: r.cancel_reason,
    syncScore: syncScore(r), closestM: r.closest_m, arrivalLateS: r.arrival_late_s, safetyAnswer: r.safety_answer, safetyAskedAt: r.safety_asked_at, reviewRequired: Boolean(r.review_required),
  };
}

route('GET', '/admin/api/rides', (ctx) => {
  requireAdmin(ctx);
  const filter = ctx.query.get('filter') ?? 'live';
  const where = {
    live: `status IN ('accepted', 'arrived', 'riding')`,
    open: `status IN ('searching', 'awaiting_payment', 'offered', 'open', 'scheduled')`,
    flagged: `(safety_asked_at IS NOT NULL OR review_required = 1 OR checkout_warning = 1)`,
    all: '1 = 1',
  }[filter] ?? '1 = 1';
  return { rides: all(`SELECT * FROM rides WHERE ${where} ORDER BY created_at DESC LIMIT 200`).map(adminRide) };
});
route('GET', '/admin/api/rides/:id', (ctx) => {
  requireAdmin(ctx);
  const r = rideRow(ctx.params.id);
  if (!r) throw new ApiError(404, 'not_found', 'Not found.');
  return {
    ride: adminRide(r),
    events: all('SELECT at, kind, detail FROM ride_events WHERE ride_id = ? ORDER BY at', r.id),
    disputes: all('SELECT * FROM disputes WHERE ride_id = ? ORDER BY created_at', r.id),
    payouts: all('SELECT * FROM payouts WHERE ride_id = ?', r.id),
    escrows: all('SELECT * FROM escrows WHERE ride_id = ? ORDER BY created_at', r.id).map(adminEscrow),
    // The planned route and both phones' positions, for the map and its playback. Positions are kept for 90 days (Privacy).
    map: {
      pickup: { lat: r.pickup_lat, lng: r.pickup_lng }, dropoff: { lat: r.dropoff_lat, lng: r.dropoff_lng },
      route: r.polyline ? decodePolyline(r.polyline) : [],
      rider: all(`SELECT at, lat, lng FROM ride_points WHERE ride_id = ? AND who = 'rider' ORDER BY at LIMIT 5000`, r.id),
      driver: all(`SELECT at, lat, lng FROM ride_points WHERE ride_id = ? AND who = 'driver' ORDER BY at LIMIT 5000`, r.id),
    },
    points: { rider: get(`SELECT COUNT(*) AS n FROM ride_points WHERE ride_id = ? AND who = 'rider'`, r.id).n, driver: get(`SELECT COUNT(*) AS n FROM ride_points WHERE ride_id = ? AND who = 'driver'`, r.id).n },
  };
});

route('GET', '/admin/api/disputes', (ctx) => {
  requireAdmin(ctx);
  const rows = all(`SELECT * FROM disputes WHERE (? = 'all' OR status = 'open') ORDER BY created_at DESC LIMIT 200`, ctx.query.get('filter') ?? 'open');
  return { disputes: rows.map((d) => ({ ...d, ride: adminRide(rideRow(d.ride_id)) })) };
});
route('POST', '/admin/api/disputes/:id', (ctx) => {
  requireAdmin(ctx);
  const decision = APPEAL_DECISIONS.includes(ctx.body.decision) ? ctx.body.decision : null;
  if (!decision) throw new ApiError(400, 'bad_decision', 'Refund the rider, pay the driver, or split it.');
  decideDispute(ctx.params.id, decision, text(ctx.body.answer, 1000), 'admin');
  log(`dispute_${decision}`, ctx.params.id);
  sendNow();
  return { ok: true };
});

// ---------- money ----------

// A decision goes out straight away rather than at the next round of the money job.
const sendNow = () => { if (config.jobs) runMoney().catch((e) => console.error('[drivezzz] sending a decision:', e.message)); };

// Stepping in on any paid ride, with or without an appeal: hold it, or refund, split or pay it out right now.
route('POST', '/admin/api/rides/:id/hold', (ctx) => {
  requireAdmin(ctx);
  const on = ctx.body.hold !== false;
  holdRide(ctx.params.id, on, 'admin');
  log(on ? 'escrow_hold' : 'escrow_hold_released', ctx.params.id);
  if (!on) sendNow();
  return { ok: true };
});
route('POST', '/admin/api/rides/:id/decide', (ctx) => {
  requireAdmin(ctx);
  const decision = DECISIONS.includes(ctx.body.decision) ? ctx.body.decision : null;
  if (!decision) throw new ApiError(400, 'bad_decision', 'Refund the rider, pay the driver, or split it.');
  decideRide(ctx.params.id, decision, text(ctx.body.answer, 1000), 'admin');
  log(`escrow_${decision}`, ctx.params.id, text(ctx.body.answer, 1000) || null);
  sendNow();
  return { ok: true };
});

// The escrow on Solana: whether it's set up as we expect, the server key's SOL for fees, and what it holds.
route('GET', '/admin/api/escrow', async (ctx) => {
  requireAdmin(ctx);
  let problem = null, serverSol = null;
  try {
    problem = await escrow.checkSettings();
    const key = escrow.serverAddress();
    if (key) serverSol = Number((await sol.account(key))?.lamports ?? 0n) / 1e9;
  } catch (e) { problem = e.message; }
  const held = (coin) => coins.fromUnits(coin, BigInt(get(`SELECT COALESCE(SUM(units), 0) AS u FROM escrows WHERE coin = ? AND status IN ('paid', 'settling')`, coin).u));
  const row = (e) => ({ ...adminEscrow(e), rideId: e.ride_id, rideStatus: rideRow(e.ride_id)?.status, paidAt: e.paid_at, settledAt: e.settled_at });
  return {
    pretendChain: escrow.pretendChain(), network: coins.network(), programId: config.escrow.programId || null, feeAddress: escrow.feeAddress(), fee: await escrow.feeStatus().catch(() => ({})), problem,
    serverKey: escrow.serverAddress(), serverSol,
    held: { 'usdc-sol': held('usdc-sol'), sol: held('sol') },
    open: all(`SELECT * FROM escrows WHERE status IN ('paid', 'settling') ORDER BY error IS NULL, paid_at LIMIT 100`).map(row),
    recent: all(`SELECT * FROM escrows WHERE status = 'settled' ORDER BY settled_at DESC LIMIT 30`).map(row),
  };
});

// Your own Solana address, for the €0.10: a public address only.
route('POST', '/admin/api/fee-address', async (ctx) => {
  requireAdmin(ctx);
  const address = text(ctx.body.address, 60).trim();
  await escrow.setFeeAddress(address);
  log('fee_address', null, address);
  return { feeAddress: address };
});

// Devnet or the real network. Nothing may be in an escrow or waiting for a payment while switching.
route('POST', '/admin/api/network', (ctx) => {
  requireAdmin(ctx);
  const net = ctx.body.network === 'mainnet' ? 'mainnet' : 'testnet';
  if (net === coins.network()) return { network: net };
  if (ctx.body.confirm !== `SWITCH TO ${net.toUpperCase()}`) throw new ApiError(400, 'confirm', `Type SWITCH TO ${net.toUpperCase()}.`);
  const open = get(`SELECT COUNT(*) AS n FROM rides WHERE status IN ('awaiting_payment', 'scheduled', 'accepted', 'arrived', 'riding') AND rider_id NOT IN (SELECT id FROM users WHERE is_demo = 1)`).n;
  if (open) throw new ApiError(409, 'rides_open', `${open} ride(s) are still going. Finish or cancel them first.`);
  // A payment asked for and never made stays 'requested' for good. On the test network that's nothing, so it only holds up leaving the real one.
  if (get(`SELECT COUNT(*) AS n FROM escrows WHERE status IN (${net === 'mainnet' ? '' : `'requested', `}'paid', 'settling')`).n) throw new ApiError(409, 'escrows_open', 'Some escrows aren’t settled yet. Wait for them first.');
  coins.setNetwork(net);
  log('network', null, net);
  return { network: coins.network() };
});

// Taking a wallet off the banned list (an admin lifted a ban that was wrong).
route('POST', '/admin/api/banned-wallets/remove', (ctx) => {
  requireAdmin(ctx);
  const address = text(ctx.body.address, 60);
  if (!run('DELETE FROM banned_wallets WHERE address = ?', address).changes) throw new ApiError(404, 'not_found', 'That wallet isn’t banned.');
  log('wallet_unbanned', null, address);
  return { ok: true };
});

// Short links on the website (links.js): their clicks, and where they go.
route('GET', '/admin/api/links', (ctx) => {
  requireAdmin(ctx);
  return { links: linkList(), base: config.baseUrl };
});
route('POST', '/admin/api/links', (ctx) => {
  requireAdmin(ctx);
  const { action, detail } = saveLink({ was: ctx.body.was || null, slug: ctx.body.slug, target: ctx.body.target, androidTarget: ctx.body.androidTarget });
  log(action, null, detail);
  return { ok: true };
});
route('POST', '/admin/api/links/:slug/remove', (ctx) => {
  requireAdmin(ctx);
  const link = removeLink(ctx.params.slug);
  log('link_removed', null, `/${link.slug} → ${link.target}`);
  return { ok: true };
});

route('GET', '/admin/api/log', (ctx) => {
  requireAdmin(ctx);
  return { log: all('SELECT * FROM admin_log ORDER BY at DESC LIMIT 200') };
});

export { num, publicRide };
