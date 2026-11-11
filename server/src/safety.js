// Keeping people safe from each other (App Store guideline 1.2): reporting, blocking and a way to reach us. Blocking
// works both ways: neither side is offered to or sees the other any more. Reports land in the admin panel.
import { all, get, now, run, uid } from './db.js';
import { ApiError, clientIp, limit, route, text } from './http.js';
import { requireUser } from './auth.js';
import { readChat } from './messages.js';

export const REPORT_REASONS = ['Unsafe driving', 'Harassment or abuse', 'Offensive photo or text', 'Fraud or wrong car', 'Impossible drop-off location', 'Something else'];

export const blockedBetween = (a, b) => Boolean(a && b && get('SELECT 1 AS x FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)', a, b, b, a));
export const blockedIds = (userId) => new Set(all('SELECT blocked_id AS id FROM blocks WHERE user_id = ? UNION SELECT user_id AS id FROM blocks WHERE blocked_id = ?', userId, userId).map((r) => r.id));

const userExists = (id) => get('SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL', id);

route('POST', '/api/reports', (ctx) => {
  const user = requireUser(ctx);
  if (!limit(`report:${user.id}`, 10, 3600_000)) throw new ApiError(429, 'too_many', 'You sent a lot of reports. Try again later.');
  const target = text(ctx.body.userId, 40);
  if (!userExists(target) || target === user.id) throw new ApiError(404, 'not_found', 'This person is no longer here.');
  const reason = REPORT_REASONS.includes(ctx.body.reason) ? ctx.body.reason : 'Something else';
  const rideId = text(ctx.body.rideId, 40) || null;
  if (rideId && !get('SELECT 1 AS x FROM rides WHERE id = ? AND (rider_id = ? OR driver_id = ?)', rideId, user.id, user.id)) throw new ApiError(404, 'not_found', 'This ride is no longer here.');
  const chat = readChat(user.id, target, ctx.body.chatKeys);
  run('INSERT INTO reports (id, reporter_id, target_id, ride_id, reason, message, chat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    uid('rep_'), user.id, target, rideId, reason, text(ctx.body.message, 1000) || null, chat ? JSON.stringify(chat) : null, now());
  return { ok: true };
});

route('GET', '/api/blocks', (ctx) => {
  const user = requireUser(ctx);
  return { blocks: all('SELECT u.id, u.name, b.created_at AS at FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at DESC', user.id) };
});
route('POST', '/api/blocks', (ctx) => {
  const user = requireUser(ctx);
  const target = text(ctx.body.userId, 40);
  if (!userExists(target) || target === user.id) throw new ApiError(404, 'not_found', 'This person is no longer here.');
  run('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)', user.id, target, now());
  return { ok: true };
});
route('DELETE', '/api/blocks/:id', (ctx) => {
  const user = requireUser(ctx);
  run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', user.id, ctx.params.id);
  return { ok: true };
});

// The support page's form. Works without an account.
route('POST', '/api/support', (ctx) => {
  if (!limit(`support:${clientIp(ctx.req)}`, 5, 3600_000)) throw new ApiError(429, 'too_many', 'Too many messages. Try again later.');
  const email = text(ctx.body.email, 200);
  const message = text(ctx.body.message, 4000);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'bad_email', 'Fill in your email address, so we can answer.');
  if (message.length < 5) throw new ApiError(400, 'too_short', 'Tell us a little more.');
  run('INSERT INTO support_requests (id, email, topic, message, created_at) VALUES (?, ?, ?, ?, ?)', uid('sup_'), email, text(ctx.body.topic, 60) || null, message, now());
  return { ok: true };
});
