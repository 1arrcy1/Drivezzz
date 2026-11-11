// Accounts. Continue makes an account with an ID (dz-xxxxxx) that never changes; the name starts as that
// ID and can be anything. An email and password can be added later in Profile, and log in from another
// phone. A phone is known by its X-Device-Id, kept in the Keychain so it survives reinstalling the app.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, now, PHOTO_DIR, randomId, run, tx } from './db.js';
import { ApiError, clientIp, limit, route, text } from './http.js';
import { activeBan, attachDeviceToBans, banForDevice, standingFor } from './standing.js';
import { rules } from './config.js';
import { findBlocked } from './filter.js';
import { pushOn } from './push.js';
import { forgetChecks } from './checks.js';
import { eula } from './eula.js';

function forgetChats(userId) {
  run('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE rider_id = ? OR driver_id = ?)', userId, userId);
  run('DELETE FROM conversations WHERE rider_id = ? OR driver_id = ?', userId, userId);
}

// What's only about this person goes with their account, as Apple asks (guideline 5.1.1(v)) and Privacy says. What stays, without
// a name: rides and payments for the accounts and disputes, reports for safety, and the phone's record. A car's make stays on old
// rides, its plate doesn't.
function forgetPerson(userId) {
  forgetChats(userId);
  for (const p of all('SELECT p.id, p.file FROM car_photos p JOIN cars c ON c.id = p.car_id WHERE c.user_id = ?', userId)) {
    run('DELETE FROM car_photos WHERE id = ?', p.id);
    fs.rmSync(path.join(PHOTO_DIR, p.file), { force: true });
  }
  run(`UPDATE cars SET plate = '–', deleted_at = COALESCE(deleted_at, ?) WHERE user_id = ?`, now(), userId);
  run('UPDATE drivers SET bio = NULL, lat = NULL, lng = NULL, heading = NULL WHERE user_id = ?', userId);
  run('DELETE FROM wallets WHERE user_id = ?', userId);
  run('DELETE FROM wallet_change_requests WHERE user_id = ?', userId);
  forgetChecks(userId);
  run('DELETE FROM online_log WHERE user_id = ?', userId);
  run('DELETE FROM blocks WHERE user_id = ? OR blocked_id = ?', userId, userId);
  run('UPDATE reviews SET text = NULL WHERE rider_id = ? OR driver_id = ?', userId, userId);
}

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function checkPassword(password, stored) {
  const [, salt, key] = String(stored).split('$');
  if (!salt || !key) return false;
  const got = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, Buffer.from(key, 'hex'));
}

export const deviceOf = (req) => {
  const d = text(req.headers['x-device-id'], 100);
  return /^[\w-]{8,100}$/.test(d) ? d : '';
};

function startSession(userId, deviceId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  run('INSERT INTO sessions (token_hash, user_id, device_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)', hashToken(token), userId, deviceId || null, t, t);
  if (deviceId) noteDevice(userId, deviceId);
  return token;
}

function noteDevice(userId, deviceId) {
  run(`INSERT INTO user_devices (user_id, device_id, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`, userId, deviceId, now());
  // A banned account's new phone is banned with it.
  attachDeviceToBans(userId, deviceId);
}

// Who's asking. Returns the user or null; touches last_seen at most once a minute.
// When someone was last seen is written in one go every few seconds: with many people online, a write each would add up.
const seenSessions = new Map();
const seenUsers = new Map();
export function writeSeen() {
  if (!seenSessions.size && !seenUsers.size) return;
  tx(() => {
    for (const [hash, at] of seenSessions) run('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?', at, hash);
    for (const [id, at] of seenUsers) run('UPDATE users SET last_seen_at = ? WHERE id = ?', at, id);
  });
  seenSessions.clear();
  seenUsers.clear();
}
if (process.env.DRIVEZZZ_ROLE !== 'edge') setInterval(writeSeen, 5000).unref();
// A helper process (edge.js) can't write: it hands them over, and the main process takes them in.
export function flushSeenTo() {
  if (!seenSessions.size && !seenUsers.size) return null;
  const seen = { sessions: [...seenSessions], users: [...seenUsers] };
  seenSessions.clear();
  seenUsers.clear();
  return seen;
}
export function takeSeen({ sessions, users }) {
  for (const [hash, at] of sessions) seenSessions.set(hash, at);
  for (const [id, at] of users) seenUsers.set(id, at);
}

export function currentUser(req) {
  // Asked more than once for the same request in a helper process.
  if (req.drivezzzUser !== undefined) return req.drivezzzUser;
  req.drivezzzUser = findCurrentUser(req);
  return req.drivezzzUser;
}

function findCurrentUser(req) {
  const m = (req.headers.authorization ?? '').match(/^Bearer (\S+)$/);
  if (!m) return null;
  const s = get('SELECT * FROM sessions WHERE token_hash = ?', hashToken(m[1]));
  if (!s) return null;
  const user = get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', s.user_id);
  if (!user) return null;
  const t = now();
  if (t - s.last_used_at > 60_000) seenSessions.set(s.token_hash, t);
  if (t - user.last_seen_at > 60_000) {
    seenUsers.set(user.id, t);
    user.last_seen_at = t;
  }
  const device = deviceOf(req) || s.device_id || '';
  // Not in a helper process, which can't write: the next thing this phone does that changes anything notes it.
  if (device && device !== s.device_id && process.env.DRIVEZZZ_ROLE !== 'edge') noteDevice(user.id, device);
  user.deviceId = device;
  return user;
}

// Every API route but standing and appeals: signed in and not banned.
export function requireUser(ctx) {
  const user = currentUser(ctx.req);
  if (!user) throw new ApiError(401, 'signed_out', 'Please sign in again.');
  const ban = activeBan(user.id, user.deviceId);
  if (ban) throw new ApiError(403, 'banned', 'You are banned.', { ban: { reason: ban.reason, kind: ban.kind, endsAt: ban.ends_at } });
  return user;
}
export function requireSignedIn(ctx) {
  const user = currentUser(ctx.req);
  if (!user) throw new ApiError(401, 'signed_out', 'Please sign in again.');
  return user;
}

export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email ?? null,
  hasLogin: Boolean(u.password_hash),
  isDriver: Boolean(u.is_driver),
  demo: Boolean(u.is_demo),
  createdAt: u.created_at,
});

function newUserId() {
  for (let i = 0; i < 20; i++) {
    const id = `dz-${randomId(6)}`;
    if (!get('SELECT 1 AS x FROM users WHERE id = ?', id)) return id;
  }
  throw new Error('no free user id');
}

const cleanName = (raw) => text(raw, 30).replace(/\s+/g, ' ');

const noteEula = (userId, version) => { if (version) run('UPDATE users SET eula_version = ?, eula_accepted_at = ? WHERE id = ?', version, now(), userId); };

route('POST', '/api/auth/continue', (ctx) => {
  if (!limit(`continue:${clientIp(ctx.req)}`, 30, 3600_000)) throw new ApiError(429, 'too_many', 'Too many tries. Wait a while.');
  const deviceId = deviceOf(ctx.req) || text(ctx.body.deviceId, 100);
  if (!/^[\w-]{8,100}$/.test(deviceId)) throw new ApiError(400, 'no_device', 'This phone could not be recognised.');
  // What was accepted has to be what the server shows now. Android has no EULA screen yet and sends nothing (docs/android.md).
  const accepted = ctx.body.eula;
  if (accepted !== undefined && accepted !== eula.version) throw new ApiError(409, 'eula_changed', 'The agreement was just updated. Please read it again.');
  // A banned phone gets back the banned account: it can see why and appeal, nothing else.
  const banned = banForDevice(deviceId);
  if (banned) {
    const u = get('SELECT * FROM users WHERE id = ?', banned.user_id);
    return { token: startSession(u.id, deviceId), user: publicUser(u), standing: standingFor(u.id, deviceId), isNew: false };
  }
  // The same phone coming back without a login gets its own account again, not a clean slate.
  const known = get(`SELECT u.* FROM user_devices d JOIN users u ON u.id = d.user_id
                     WHERE d.device_id = ? AND u.deleted_at IS NULL AND u.password_hash IS NULL
                     ORDER BY d.last_seen_at DESC LIMIT 1`, deviceId);
  if (known) {
    noteEula(known.id, accepted);
    return { token: startSession(known.id, deviceId), user: publicUser(known), standing: standingFor(known.id, deviceId), isNew: false };
  }
  const id = newUserId();
  const t = now();
  run('INSERT INTO users (id, name, last_seen_at, created_at) VALUES (?, ?, ?, ?)', id, id, t, t);
  noteEula(id, accepted);
  const u = get('SELECT * FROM users WHERE id = ?', id);
  return { token: startSession(id, deviceId), user: publicUser(u), standing: standingFor(id, deviceId), isNew: true };
});

route('POST', '/api/auth/login', (ctx) => {
  const ip = clientIp(ctx.req);
  if (!limit(`login:${ip}`, 20, 900_000)) throw new ApiError(429, 'too_many', 'Too many tries. Wait a while.');
  const email = text(ctx.body.email, 200).toLowerCase();
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  const u = email ? get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', email) : null;
  if (!u?.password_hash || !checkPassword(password, u.password_hash)) throw new ApiError(401, 'wrong_login', 'That email and password don’t match.');
  const deviceId = deviceOf(ctx.req) || text(ctx.body.deviceId, 100);
  return { token: startSession(u.id, deviceId), user: publicUser(u), standing: standingFor(u.id, deviceId) };
});

route('POST', '/api/auth/register', (ctx) => {
  const user = requireUser(ctx);
  if (!limit(`register:${clientIp(ctx.req)}`, 20, 3600_000)) throw new ApiError(429, 'too_many', 'Too many tries. Wait a while.');
  if (user.password_hash) throw new ApiError(409, 'has_login', 'This account already has a login.');
  const email = text(ctx.body.email, 200).toLowerCase();
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'bad_email', 'That isn’t an email address.');
  if (password.length < 8) throw new ApiError(400, 'bad_password', 'Use at least 8 characters for your password.');
  if (get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new ApiError(409, 'email_taken', 'That email already has an account. Log in instead.');
  run('UPDATE users SET email = ?, password_hash = ? WHERE id = ?', email, hashPassword(password), user.id);
  return { user: publicUser(get('SELECT * FROM users WHERE id = ?', user.id)) };
});

route('POST', '/api/auth/logout', (ctx) => {
  const m = (ctx.req.headers.authorization ?? '').match(/^Bearer (\S+)$/);
  if (m) {
    // Alerts stop on the phone signing out; another phone of the same person keeps its own.
    const session = get('SELECT user_id FROM sessions WHERE token_hash = ?', hashToken(m[1]));
    if (session && ctx.body.pushToken) run('UPDATE users SET push_token = NULL, push_env = NULL WHERE id = ? AND push_token = ?', session.user_id, text(ctx.body.pushToken, 200));
    run('DELETE FROM sessions WHERE token_hash = ?', hashToken(m[1]));
  }
  return { ok: true };
});

route('GET', '/api/me', (ctx) => {
  const user = requireSignedIn(ctx);
  return { user: publicUser(user), standing: standingFor(user.id, user.deviceId) };
});

route('PATCH', '/api/me', (ctx) => {
  const user = requireUser(ctx);
  if (ctx.body.name !== undefined) {
    const name = cleanName(ctx.body.name);
    if (!name) throw new ApiError(400, 'bad_name', 'Fill in a name.');
    if (findBlocked(name)) throw new ApiError(400, 'not_allowed', 'That name isn’t allowed.');
    run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
  }
  if (ctx.body.pushToken !== undefined) {
    const token = text(ctx.body.pushToken, 200);
    // Apple's two, or 'fcm' for an Android phone (Firebase).
    const env = ['sandbox', 'fcm'].includes(ctx.body.pushEnv) ? ctx.body.pushEnv : 'production';
    run('UPDATE users SET push_token = NULL, push_env = NULL WHERE push_token = ? AND id != ?', token, user.id);
    run('UPDATE users SET push_token = ?, push_env = ? WHERE id = ?', token || null, token ? env : null, user.id);
  }
  const fresh = get('SELECT * FROM users WHERE id = ?', user.id);
  // fcmOn: an Android phone only sends its token once the server says it can push through Firebase. An older server would
  // have taken it for an iPhone's and handed it to Apple.
  return { user: publicUser(fresh), pushOn: pushOn(fresh.push_env ?? ctx.body.pushEnv), fcmOn: pushOn('fcm') };
});

route('DELETE', '/api/me', (ctx) => {
  const user = requireSignedIn(ctx);
  // The review login has to keep working for the next look: it signs out instead. Real accounts go, below.
  if (user.is_demo) {
    run('DELETE FROM sessions WHERE user_id = ?', user.id);
    forgetChats(user.id);
    run('UPDATE users SET push_token = NULL, push_env = NULL WHERE id = ?', user.id);
    return { ok: true };
  }
  // A banned phone stays on the books: no deleting your way out, or the record of what happened goes with it.
  if (activeBan(user.id, user.deviceId)) throw new ApiError(403, 'banned', 'You can’t delete your account while you’re banned.');
  // Strikes keep counting on the phone; only the account goes.
  // A ride with a driver may have money in its escrow: it's cancelled (and refunded) first, the normal way.
  const busy = get(`SELECT 1 AS x FROM rides WHERE (rider_id = ? OR driver_id = ?)
                    AND status IN ('awaiting_payment', 'scheduled', 'accepted', 'arrived', 'riding')`, user.id, user.id);
  if (busy) throw new ApiError(409, 'on_a_ride', 'Finish or cancel your rides first, also planned ones.');
  // Money still in an escrow always goes to a wallet (the rider's that paid, or the driver's), never to the account.
  tx(() => {
    run(`UPDATE rides SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'rider', cancel_reason = 'Account deleted'
         WHERE rider_id = ? AND status IN ('searching', 'offered', 'open')`, now(), user.id);
    run('UPDATE drivers SET online_since = NULL, active_car_id = NULL WHERE user_id = ?', user.id);
    run('DELETE FROM sessions WHERE user_id = ?', user.id);
    forgetPerson(user.id);
    run(`UPDATE users SET name = 'Deleted', email = NULL, password_hash = NULL, push_token = NULL, e2e_key = NULL, lat = NULL, lng = NULL, deleted_at = ? WHERE id = ?`, now(), user.id);
  });
  return { ok: true };
});

route('GET', '/api/config', () => ({
  maxRadiusKm: rules.maxRadiusKm,
  defaultRadiusKm: rules.defaultRadiusKm,
  locationEverySec: rules.locationEverySec,
  locationRideEverySec: rules.locationRideEverySec,
  checkInRadius: rules.checkInRadius,
  checkOutRadius: rules.checkOutRadius,
  maxStrikes: rules.maxStrikes,
}));
