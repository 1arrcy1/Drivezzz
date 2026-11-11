// Messages between someone and a driver. End-to-end encrypted (e2e.js): the server holds ciphertext it can't read, and tells
// the two phones each other's public keys. It does see who wrote to whom and when, because it enforces the rule: someone
// can send a driver up to 3 messages in a row, and only after 3 can the driver reply.
// When someone reports a chat their phone hands over the keys to it (readChat). The server knows who sent each message, so a
// reporter can't put words in the other person's mouth. The keys are used for that and not kept.
// Removing a chat only takes it off your own list, up to that moment: the other person keeps theirs, the limits still count it, and
// a report can still show it. Once both have removed something, it's deleted.
import { all, get, now, run, tx, uid } from './db.js';
import { rules } from './config.js';
import { ApiError, limit, route, text } from './http.js';
import { requireUser } from './auth.js';
import { blockedBetween } from './safety.js';
import { BLOCKED_WORDS } from './filter.js';
import { notify } from './push.js';
import { bump } from './sync.js';
import { open, validKey } from './e2e.js';

const between = (a, b) => get('SELECT * FROM conversations WHERE (rider_id = ? AND driver_id = ?) OR (rider_id = ? AND driver_id = ?)', a, b, b, a);

function person(user, id) {
  const other = get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', id);
  // Real people and the demo world never meet.
  if (!other || other.id === user.id || Boolean(other.is_demo) !== Boolean(user.is_demo)) throw new ApiError(404, 'not_found', 'This person is no longer here.');
  return other;
}

const clearedFor = (conv, id) => (conv.rider_id === id ? conv.rider_cleared_at : conv.driver_cleared_at) ?? 0;
const CLEARED = 'COALESCE(CASE WHEN c.rider_id = ? THEN c.rider_cleared_at ELSE c.driver_cleared_at END, 0)';

const countFrom = (conv, id) => get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id = ?', conv.id, id).n;

// Whether this person can send now, how many more, and if not, why not.
function sendState(user, other, conv) {
  const no = (why) => ({ canSend: false, why, messagesLeft: 0 });
  const max = rules.messagesInARow;
  if (blockedBetween(user.id, other.id)) return no('You can’t message each other.');
  if (!other.e2e_key) return no(`${other.name} can’t get messages yet.`);
  if (!conv) return other.is_driver ? { canSend: true, why: null, messagesLeft: max } : no('You can only start a chat with a driver.');
  const starter = conv.rider_id === user.id;
  const fromThem = countFrom(conv, other.id);
  if (!starter && fromThem < max) return no(`You can reply once ${other.name} has sent ${max} messages.`);
  const last = all('SELECT sender_id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', conv.id, max);
  const inARow = last.findIndex((m) => m.sender_id !== user.id);
  const mine = inARow === -1 ? last.length : inARow;
  if (mine >= max) return no(`You can send more once ${other.name} replies.`);
  return { canSend: true, why: null, messagesLeft: max - mine };
}

const publicPerson = (u) => ({ id: u.id, name: u.name, isDriver: Boolean(u.is_driver), publicKey: u.e2e_key ?? null });
const publicMessage = (m, me) => ({ id: m.id, fromMe: m.sender_id === me, body: m.body, senderKey: m.sender_key, toKey: m.to_key, at: m.created_at, readAt: m.read_at ?? null });

function thread(user, other) {
  const conv = between(user.id, other.id);
  const messages = conv ? all('SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at, rowid', conv.id, clearedFor(conv, user.id)) : [];
  return { with: publicPerson(other), messages: messages.map((m) => publicMessage(m, user.id)), ...sendState(user, other, conv) };
}

export function unreadFor(userId) {
  return get(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE (c.rider_id = ? OR c.driver_id = ?) AND m.sender_id != ? AND m.read_at IS NULL AND m.created_at > ${CLEARED}`, userId, userId, userId, userId).n;
}

// Puts a message in a chat, starting it if needed. The body is sealed already.
export function addMessage(from, to, body, senderKey, toKey) {
  const t = now();
  const id = uid('msg_');
  tx(() => {
    let conv = between(from.id, to.id);
    if (!conv) {
      conv = { id: uid('chat_') };
      run('INSERT INTO conversations (id, rider_id, driver_id, created_at, last_at) VALUES (?, ?, ?, ?, ?)', conv.id, from.id, to.id, t, t);
    }
    run('INSERT INTO messages (id, conversation_id, sender_id, body, sender_key, to_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, conv.id, from.id, body, senderKey, toKey, t);
    run('UPDATE conversations SET last_at = ? WHERE id = ?', t, conv.id);
  });
  // The words stay in the chat: the alert only says who it's from.
  notify(to.id, 'New message', from.name, { kind: 'message', userId: from.id });
  bump(from.id);
}

// What a report adds: the chat in readable form, opened with the keys the reporter's phone sent.
export function readChat(reporterId, targetId, keys) {
  const conv = between(reporterId, targetId);
  if (!conv || !Array.isArray(keys)) return null;
  const usable = keys.slice(0, 20).filter(validKey).map((k) => Buffer.from(k, 'base64'));
  const rows = all('SELECT sender_id, body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200', conv.id).reverse();
  if (!rows.length) return null;
  return rows.map((m) => {
    let read = null;
    for (const key of usable) {
      read = open(key, m.body);
      if (read !== null) break;
    }
    return { from: m.sender_id, at: m.created_at, text: read };
  });
}

route('POST', '/api/me/key', (ctx) => {
  const user = requireUser(ctx);
  if (!validKey(ctx.body.publicKey)) throw new ApiError(400, 'bad_key', 'That key can’t be used.');
  run('UPDATE users SET e2e_key = ? WHERE id = ?', ctx.body.publicKey, user.id);
  return { ok: true };
});

// The server can't read messages, so the app checks them against these before sealing them.
route('GET', '/api/filter', (ctx) => {
  requireUser(ctx);
  return { words: BLOCKED_WORDS };
});

route('GET', '/api/messages', (ctx) => {
  const user = requireUser(ctx);
  const rows = all(`SELECT c.*, u.id AS other_id FROM conversations c JOIN users u ON u.id = CASE WHEN c.rider_id = ? THEN c.driver_id ELSE c.rider_id END
                    WHERE (c.rider_id = ? OR c.driver_id = ?) AND u.deleted_at IS NULL AND c.last_at > ${CLEARED} ORDER BY c.last_at DESC LIMIT 100`, user.id, user.id, user.id, user.id);
  return {
    unread: unreadFor(user.id),
    conversations: rows.map((c) => {
      const last = get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.id);
      const unread = get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL AND created_at > ?', c.id, user.id, clearedFor(c, user.id)).n;
      return { person: publicPerson(get('SELECT * FROM users WHERE id = ?', c.other_id)), lastAt: c.last_at, unread, last: last ? publicMessage(last, user.id) : null };
    }),
  };
});

route('GET', '/api/messages/:id', (ctx) => {
  const user = requireUser(ctx);
  return thread(user, person(user, ctx.params.id));
});

route('POST', '/api/messages/:id', (ctx) => {
  const user = requireUser(ctx);
  if (!limit(`message:${user.id}`, 30, 60_000)) throw new ApiError(429, 'too_many', 'That’s a lot of messages. Wait a moment.');
  const other = person(user, ctx.params.id);
  const state = sendState(user, other, between(user.id, other.id));
  if (!state.canSend) throw new ApiError(409, 'cant_send', state.why);
  const body = text(ctx.body.body, 8000);
  if (body.length < 40) throw new ApiError(400, 'bad_message', 'That message can’t be sent.');
  // Sealed for a key they no longer use: the app seals it again for the new one.
  if (ctx.body.toKey !== other.e2e_key) throw new ApiError(409, 'key_changed', 'Try that again.', { publicKey: other.e2e_key });
  if (!validKey(ctx.body.senderKey) || ctx.body.senderKey !== user.e2e_key) throw new ApiError(409, 'own_key', 'Encryption isn’t set up on this phone yet. Try again in a moment.');
  addMessage(user, other, body, ctx.body.senderKey, ctx.body.toKey);
  return thread(user, other);
});

route('DELETE', '/api/messages/:id', (ctx) => {
  const user = requireUser(ctx);
  const conv = between(user.id, ctx.params.id);
  if (conv) {
    tx(() => {
      run(`UPDATE conversations SET ${conv.rider_id === user.id ? 'rider_cleared_at' : 'driver_cleared_at'} = ? WHERE id = ?`, now(), conv.id);
      const c = get('SELECT * FROM conversations WHERE id = ?', conv.id);
      const both = Math.min(c.rider_cleared_at ?? 0, c.driver_cleared_at ?? 0);
      if (both) run('DELETE FROM messages WHERE conversation_id = ? AND created_at <= ?', conv.id, both);
    });
  }
  bump(user.id);
  return { ok: true };
});

route('POST', '/api/messages/:id/read', (ctx) => {
  const user = requireUser(ctx);
  const conv = between(user.id, ctx.params.id);
  if (conv) run('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL', now(), conv.id, user.id);
  bump(user.id);
  return { ok: true };
});
