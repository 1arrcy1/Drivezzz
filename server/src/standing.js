// Strikes, bans and appeals. Three strikes is a permanent ban; every strike is a one-week ban. A ban covers
// the account and its phones, and once someone's ID has been read for the driver checks, the person: their other accounts
// and new phones (Pieter's request, 6 November 2026). A banned person can appeal once per 24 hours; once an admin has decided,
// the app offers no more appeals on that ban.
import { all, get, now, run, tx, uid } from './db.js';
import { rules } from './config.js';
import { ApiError, route, text } from './http.js';
import { requireSignedIn } from './auth.js';
import { bump } from './sync.js';

const banLive = (b, t = now()) => !b.lifted_at && (b.ends_at == null || b.ends_at > t);

// The same person's other accounts, known from their ID's chip (checks.js, person_hash). On the other side only an account whose
// check showed it really was that person counts (approved, or the face matched the chip), so reading someone else's ID and
// getting banned can't get that someone banned.
const proven = (c) => `(${c}.status = 'approved' OR (${c}.face_live = 1 AND ${c}.face_score >= ${Number(rules.faceAutoMatch)}))`;
const SAME_PERSON = `SELECT other.user_id FROM driver_checks me JOIN driver_checks other ON other.person_hash = me.person_hash
  WHERE me.user_id = ? AND me.person_hash IS NOT NULL AND other.user_id != me.user_id AND ${proven('other')}`;
// Who a ban on this account reaches as the same person.
const reachedAsPerson = (userId) => all(`SELECT me.user_id FROM driver_checks other JOIN driver_checks me ON me.person_hash = other.person_hash
  WHERE other.user_id = ? AND other.person_hash IS NOT NULL AND me.user_id != other.user_id AND ${proven('other')}`, userId).map((r) => r.user_id);

export function activeBan(userId, deviceId) {
  const t = now();
  const own = get('SELECT * FROM bans WHERE user_id = ? AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?) ORDER BY ends_at IS NULL DESC, ends_at DESC LIMIT 1', userId, t);
  if (own) return own;
  return banForPerson(userId) ?? (deviceId ? banForDevice(deviceId) : null);
}
export function banForPerson(userId) {
  return get(`SELECT * FROM bans WHERE user_id IN (${SAME_PERSON}) AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?)
              ORDER BY ends_at IS NULL DESC, ends_at DESC LIMIT 1`, userId, now()) ?? null;
}
export function banForDevice(deviceId) {
  return get(`SELECT b.* FROM banned_devices d JOIN bans b ON b.id = d.ban_id
              WHERE d.device_id = ? AND b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > ?)
              ORDER BY b.ends_at IS NULL DESC, b.ends_at DESC LIMIT 1`, deviceId, now()) ?? null;
}
// Every live ban on someone: on the account itself, or on a phone they use (banned through another account).
export function liveBansOf(userId) {
  const t = now();
  return all(`SELECT DISTINCT b.* FROM bans b LEFT JOIN banned_devices bd ON bd.ban_id = b.id LEFT JOIN user_devices d ON d.device_id = bd.device_id
              WHERE (b.user_id = ? OR d.user_id = ? OR b.user_id IN (${SAME_PERSON})) AND b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > ?)
              ORDER BY b.ends_at IS NULL DESC, b.ends_at DESC`, userId, userId, userId, t);
}
// A banned account's new phone is banned with it, also when the ban was on the same person's other account.
export function attachDeviceToBans(userId, deviceId) {
  const t = now();
  for (const b of all(`SELECT id FROM bans WHERE (user_id = ? OR user_id IN (${SAME_PERSON})) AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?)`, userId, userId, t)) {
    run('INSERT OR IGNORE INTO banned_devices (device_id, ban_id) VALUES (?, ?)', deviceId, b.id);
  }
}

// Strikes stay with the phone and the person: they count for every account that ever used it, and every account of someone
// whose ID was read, so logging out, deleting the account or a new phone doesn't give a clean slate.
const ACCOUNTS_OF_SOMEONE = `(SELECT ? UNION SELECT other.user_id FROM user_devices mine JOIN user_devices other ON other.device_id = mine.device_id WHERE mine.user_id = ? UNION ${SAME_PERSON})`;
export const strikeCount = (userId) => get(`SELECT COUNT(*) AS n FROM strikes WHERE removed_at IS NULL AND user_id IN ${ACCOUNTS_OF_SOMEONE}`, userId, userId, userId).n;

// Set by rides.js: what happens to someone's rides when they're banned.
let onBan = () => {};
export const setOnBan = (fn) => { onBan = fn; };

function placeBan(userId, kind, reason, strikeId, by) {
  const id = uid('ban_');
  const t = now();
  run('INSERT INTO bans (id, user_id, kind, reason, strike_id, given_by, created_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, userId, kind, reason, strikeId, by, t, kind === 'week' ? t + rules.banWeek : null);
  for (const d of all('SELECT device_id FROM user_devices WHERE user_id = ?', userId)) {
    run('INSERT OR IGNORE INTO banned_devices (device_id, ban_id) VALUES (?, ?)', d.device_id, id);
  }
  run('DELETE FROM sessions WHERE user_id = ? AND device_id IS NULL', userId);
  // The same person's other accounts are banned with it (activeBan finds it), and so are their phones.
  for (const other of reachedAsPerson(userId)) {
    for (const d of all('SELECT device_id FROM user_devices WHERE user_id = ?', other)) run('INSERT OR IGNORE INTO banned_devices (device_id, ban_id) VALUES (?, ?)', d.device_id, id);
  }
  return id;
}
// What a new ban does to the rest of the person: their rides end and their apps hear it.
const banTheRest = (userId) => { for (const other of reachedAsPerson(userId)) { onBan(other); bump(other); } };

// Just after someone's ID was read (checks.js): banned elsewhere as the same person, so banned here too, with this account's
// phones, right away. Returns that ban, or null.
export function banFollowsPerson(userId) {
  const ban = banForPerson(userId);
  if (!ban) return null;
  for (const d of all('SELECT device_id FROM user_devices WHERE user_id = ?', userId)) run('INSERT OR IGNORE INTO banned_devices (device_id, ban_id) VALUES (?, ?)', d.device_id, ban.id);
  run('DELETE FROM sessions WHERE user_id = ? AND device_id IS NULL', userId);
  onBan(userId);
  bump(userId);
  return ban;
}

export function giveStrike(userId, reason, by) {
  return tx(() => {
    const id = uid('st_');
    run('INSERT INTO strikes (id, user_id, reason, given_by, created_at) VALUES (?, ?, ?, ?, ?)', id, userId, reason, by, now());
    const count = strikeCount(userId);
    const permanent = count >= rules.maxStrikes;
    const banId = placeBan(userId, permanent ? 'permanent' : 'week', reason, id, by);
    onBan(userId);
    bump(userId);
    banTheRest(userId);
    return { strikeId: id, banId, strikes: count, permanent };
  });
}

export function banUser(userId, kind, reason, by) {
  return tx(() => {
    const banId = placeBan(userId, kind === 'week' ? 'week' : 'permanent', reason, null, by);
    onBan(userId);
    bump(userId);
    banTheRest(userId);
    return { banId };
  });
}

// Lifting a ban also takes back the strike it came with: the admin agreed it was wrong.
export function liftBan(banId, why, by, { removeStrike = true } = {}) {
  return tx(() => {
    const b = get('SELECT * FROM bans WHERE id = ?', banId);
    if (!b || b.lifted_at) throw new ApiError(409, 'not_active', 'That ban is no longer active.');
    const t = now();
    run('UPDATE bans SET lifted_at = ?, lifted_why = ? WHERE id = ?', t, why, banId);
    if (removeStrike && b.strike_id) run('UPDATE strikes SET removed_at = ?, removed_why = ? WHERE id = ?', t, why, b.strike_id);
    run(`UPDATE appeals SET status = 'lifted', answer = ?, decided_at = ?, decided_by = ? WHERE ban_id = ? AND status = 'open'`, why, t, by, banId);
    bump(b.user_id);
    return b;
  });
}

export function decideAppeal(appealId, decision, answer, by) {
  return tx(() => {
    const a = get('SELECT * FROM appeals WHERE id = ?', appealId);
    if (!a) throw new ApiError(404, 'not_found', 'Not found.');
    if (a.status !== 'open') throw new ApiError(409, 'decided', 'This appeal has been decided.');
    if (decision === 'lift') {
      const b = get('SELECT * FROM bans WHERE id = ?', a.ban_id);
      if (b && !b.lifted_at) liftBan(a.ban_id, answer || 'Appeal granted', by);
      else run(`UPDATE appeals SET status = 'lifted', answer = ?, decided_at = ?, decided_by = ? WHERE id = ?`, answer || 'Appeal granted', now(), by, appealId);
    } else {
      run(`UPDATE appeals SET status = 'upheld', answer = ?, decided_at = ?, decided_by = ? WHERE id = ?`, answer || 'Your ban stays.', now(), by, appealId);
    }
    bump(a.user_id);
    return get('SELECT * FROM appeals WHERE id = ?', appealId);
  });
}

export function standingFor(userId, deviceId) {
  const ban = activeBan(userId, deviceId);
  const strikes = all(`SELECT id, reason, created_at FROM strikes WHERE removed_at IS NULL AND user_id IN ${ACCOUNTS_OF_SOMEONE} ORDER BY created_at DESC`, userId, userId, userId)
    .map((s) => ({ id: s.id, reason: s.reason, at: s.created_at }));
  const out = { strikes: strikes.length, maxStrikes: rules.maxStrikes, strikeList: strikes, ban: null };
  if (!ban) return out;
  const appeals = all('SELECT * FROM appeals WHERE ban_id = ? ORDER BY created_at DESC', ban.id);
  const decided = appeals.find((a) => a.status === 'upheld' || a.status === 'lifted');
  const last = appeals[0];
  const nextAt = last ? last.created_at + rules.appealEvery : null;
  out.ban = {
    id: ban.id,
    kind: ban.kind,
    reason: ban.reason,
    at: ban.created_at,
    endsAt: ban.ends_at,
    decided: Boolean(decided),
    answer: decided?.answer ?? null,
    canAppeal: !decided && (!nextAt || nextAt <= now()),
    nextAppealAt: !decided && nextAt > now() ? nextAt : null,
    appeals: appeals.map((a) => ({ id: a.id, message: a.message, at: a.created_at, status: a.status, answer: a.answer })),
  };
  return out;
}

route('GET', '/api/standing', (ctx) => {
  const user = requireSignedIn(ctx);
  return standingFor(user.id, user.deviceId);
});

route('POST', '/api/appeals', (ctx) => {
  const user = requireSignedIn(ctx);
  const message = text(ctx.body.message, 2000);
  if (message.length < 5) throw new ApiError(400, 'too_short', 'Write a little more.');
  const ban = activeBan(user.id, user.deviceId);
  if (!ban || !banLive(ban)) throw new ApiError(409, 'not_banned', 'You are not banned.');
  return tx(() => {
    const appeals = all('SELECT * FROM appeals WHERE ban_id = ? ORDER BY created_at DESC', ban.id);
    if (appeals.some((a) => a.status === 'upheld' || a.status === 'lifted')) throw new ApiError(409, 'decided', 'A decision was made on this ban. You can’t appeal again from the app.');
    if (appeals[0] && appeals[0].created_at + rules.appealEvery > now()) {
      throw new ApiError(429, 'appeal_wait', 'You can send one appeal every 24 hours.', { nextAppealAt: appeals[0].created_at + rules.appealEvery });
    }
    run(`UPDATE appeals SET status = 'superseded' WHERE ban_id = ? AND status = 'open'`, ban.id);
    run('INSERT INTO appeals (id, user_id, ban_id, message, created_at) VALUES (?, ?, ?, ?, ?)', uid('ap_'), user.id, ban.id, message, now());
    bump(user.id);
    return standingFor(user.id, user.deviceId);
  });
});
