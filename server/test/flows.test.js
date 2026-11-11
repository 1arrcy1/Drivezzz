import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { client, startServer } from './helpers.js';
import crypto from 'node:crypto';
import { chatKey, newKeys, open, seal } from '../src/e2e.js';
import { b58encode } from '../src/coins.js';

let srv, admin;
const AMS = { lat: 52.37, lng: 4.89 };
const NEAR = { lat: 52.372, lng: 4.895 };
const DROP = { lat: 52.37, lng: 4.95, label: 'Drop-off' };
const PICK = { lat: 52.37, lng: 4.89, label: 'Pickup' };

before(async () => {
  srv = await startServer();
  admin = client(srv.base);
  assert.equal((await admin.post('/admin/api/login', { email: 'admin@test.local', password: 'admin' })).status, 200);
  assert.equal((await admin.post('/admin/api/password', { current: 'admin', password: 'test-admin-new' })).status, 200);
});
after(() => srv.stop());

const dev = (p) => fetch(srv.base + p, { method: 'POST' }).then((r) => r.json());

// A Solana wallet address of its own: bans cover wallets, so no two test people share one.
const newWallet = () => b58encode(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));

async function rider() {
  const c = client(srv.base);
  await c.start();
  await c.post('/api/location', AMS);
  c.wallet = newWallet();
  return c;
}

// The rider pays a ride into its escrow. The chain is pretend here: the payment counts at the next look.
async function pay(r, rideId) {
  const p = await r.post(`/api/rides/${rideId}/pay`, { account: r.wallet });
  assert.equal(p.status, 200, JSON.stringify(p));
  await dev('/dev/payments');
  return (await r.get(`/api/rides/${rideId}`)).ride;
}

const photo = (c, carId, kind) => c.upload(`/api/cars/${carId}/photos?kind=${kind}`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));

// A real driver with their own login, so the driver's calls can be tried.
async function driver({ at = NEAR, perKm = 90, perMin = 20, pickup = 50, pets = false, plate, plans = true } = {}) {
  const c = client(srv.base);
  await c.start();
  assert.equal((await c.post('/api/driver/enable')).status, 200);
  const car = await c.post('/api/cars', { plate: plate ?? `DZ${Math.floor(Math.random() * 90000) + 10000}`, make: 'Toyota', model: 'Prius', seats: 4, colorHex: '#F4F4F2', body: 'hatchback', perKmCents: perKm, perMinCents: perMin, pickupPerKmCents: pickup, petsAllowed: pets });
  assert.equal(car.status, 200, JSON.stringify(car));
  for (const kind of ['front', 'back', 'inside']) await photo(c, car.car.id, kind);
  c.wallet = newWallet();
  const w = await c.post('/api/wallet/address', { coin: 'sol', address: c.wallet });
  assert.equal(w.status, 200, JSON.stringify(w));
  if (plans) assert.equal((await c.patch('/api/driver', { allowsPlanning: true })).status, 200);
  const on = await c.post('/api/driver/online', at);
  assert.equal(on.status, 200, JSON.stringify(on));
  return c;
}

const stopAll = async (...cs) => { for (const c of cs) await c.post('/api/driver/offline'); };

test('continue makes an ID that stays, and the name can change', async () => {
  const c = client(srv.base);
  const first = await c.start();
  assert.match(first.user.id, /^dz-[a-z0-9]{6}$/);
  assert.equal(first.user.name, first.user.id);
  assert.equal(first.isNew, true);
  const renamed = await c.patch('/api/me', { name: 'Sam' });
  assert.equal(renamed.user.name, 'Sam');
  assert.equal(renamed.user.id, first.user.id);
  const again = await c.post('/api/auth/continue', { deviceId: c.deviceId });
  assert.equal(again.user.id, first.user.id, 'same phone, same account');
  assert.equal(again.isNew, false);
});

test('admin: email and password, and nothing works until the first password is changed', async () => {
  const s = await startServer();
  try {
    const a = client(s.base);
    const logIn = (c, email, password) => c.post('/admin/api/login', { email, password });
    const setPassword = (current, password) => a.post('/admin/api/password', { current, password });
    assert.equal((await a.get('/admin/api/overview')).status, 401);
    assert.equal((await setPassword('admin', 'a-long-new-password')).status, 401);
    assert.equal((await a.post('/admin/api/login', { password: 'admin' })).status, 401);
    assert.equal((await logIn(a, 'someone@test.local', 'admin')).status, 401);
    assert.equal((await logIn(a, 'admin@test.local', 'nope')).status, 401);

    const first = await logIn(a, 'Admin@Test.local', 'admin');
    assert.equal(first.status, 200);
    assert.equal(first.mustChangePassword, true);
    const blocked = await a.get('/admin/api/overview');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.code, 'change_password');
    assert.equal((await a.post('/admin/api/network', { network: 'mainnet' })).status, 403);

    assert.equal((await setPassword('nope', 'a-long-new-password')).code, 'wrong_current');
    assert.equal((await setPassword('admin', 'short')).code, 'bad_password');
    assert.equal((await a.get('/admin/api/overview')).status, 403);

    // A new password ends other browsers' sessions, and the first password stops working.
    const other = client(s.base);
    await logIn(other, 'admin@test.local', 'admin');
    assert.equal((await setPassword('admin', 'a-long-new-password')).status, 200);
    assert.equal((await a.get('/admin/api/overview')).status, 200);
    assert.equal((await other.get('/admin/api/overview')).status, 401);
    assert.equal((await logIn(client(s.base), 'admin@test.local', 'admin')).status, 401);
    const again = await logIn(other, 'admin@test.local', 'a-long-new-password');
    assert.equal(again.status, 200);
    assert.equal(again.mustChangePassword, false);
    assert.equal((await other.get('/admin/api/overview')).status, 200);
    assert.equal((await setPassword('a-long-new-password', 'a-long-new-password')).code, 'same_password');
    assert.equal((await a.post('/admin/api/logout')).status, 200);
    assert.equal((await a.get('/admin/api/overview')).status, 401);
  } finally { s.stop(); }
});

test('messages: end-to-end encrypted, 3 before a driver can reply, and only a report makes a chat readable', async () => {
  const r = await rider();
  const d = await driver({ at: { lat: 53.3, lng: 6.6 } });
  const rk = newKeys(), dk = newKeys();
  const send = (from, to, mine, theirs, words) => from.post(`/api/messages/${to.id}`, {
    body: seal(chatKey(mine.privateKey, mine.publicKey, theirs.publicKey), words), senderKey: mine.publicKey, toKey: theirs.publicKey,
  });
  const fromRider = (words) => send(r, d, rk, dk, words);
  const fromDriver = (words) => send(d, r, dk, rk, words);

  // Both need a key first.
  await r.post('/api/me/key', { publicKey: rk.publicKey });
  assert.equal((await r.post('/api/me/key', { publicKey: 'short' })).code, 'bad_key');
  assert.equal((await r.get(`/api/messages/${d.id}`)).canSend, false, 'no key on the other side yet');
  await d.post('/api/me/key', { publicKey: dk.publicKey });
  assert.equal((await r.get(`/api/messages/${d.id}`)).messagesLeft, 3);

  // A driver can't start a chat, and riders can't be written to first.
  assert.equal((await fromDriver('Hello')).code, 'cant_send');

  assert.equal((await fromRider('One')).messagesLeft, 2);
  const unreadDriver = await d.get('/api/sync?rev=0');
  assert.equal(unreadDriver.unreadMessages, 1);
  assert.equal((await fromDriver('Too soon')).code, 'cant_send', 'not until the third');
  assert.match((await d.get(`/api/messages/${r.id}`)).why, /once .* has sent 3 messages/);
  assert.equal((await fromRider('Two')).messagesLeft, 1);
  const third = await fromRider('Three');
  assert.equal(third.canSend, false);
  assert.match(third.why, /once .* replies/);
  assert.equal((await fromRider('Four')).code, 'cant_send');

  // Now the driver can answer, which gives the rider three more.
  const view = await d.get(`/api/messages/${r.id}`);
  assert.equal(view.canSend, true);
  assert.equal(open(chatKey(dk.privateKey, dk.publicKey, rk.publicKey), view.messages[0].body), 'One');
  assert.equal((await fromDriver('Hello back')).status, 200);
  assert.equal((await r.get(`/api/messages/${d.id}`)).messagesLeft, 3);

  // Sealed for an old key: the app is told to seal it again. And the list shows the chat.
  const stale = await r.post(`/api/messages/${d.id}`, { body: 'x'.repeat(60), senderKey: rk.publicKey, toKey: newKeys().publicKey });
  assert.equal(stale.code, 'key_changed');
  assert.equal((await r.get('/api/messages')).conversations[0].person.id, d.id);
  assert.equal((await d.get('/api/messages')).unread, 3);
  await d.post(`/api/messages/${r.id}/read`);
  assert.equal((await d.get('/api/messages')).unread, 0);

  // What the server holds can't be read without a phone's key.
  const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'), { readOnly: true });
  const stored = db.prepare('SELECT body FROM messages').all().map((m) => m.body).join(' ');
  db.close();
  assert.ok(!/One|Three|Hello/.test(Buffer.from(stored.replace(/\s/g, ''), 'base64').toString('latin1')) && !stored.includes('Hello'));

  // A report without keys shows only that there's a chat that can't be opened; with them, the admin reads it, sender by sender.
  await r.post('/api/reports', { userId: d.id, reason: 'Harassment or abuse' });
  await r.post('/api/reports', { userId: d.id, reason: 'Harassment or abuse', chatKeys: [chatKey(rk.privateKey, rk.publicKey, dk.publicKey).toString('base64')] });
  const reports = (await admin.get('/admin/api/reports?filter=open')).reports.filter((x) => x.target_id === d.id);
  assert.equal(reports.length, 2);
  const read = reports.find((x) => x.chat?.[0]?.text);
  assert.deepEqual(read.chat.map((m) => m.text), ['One', 'Two', 'Three', 'Hello back']);
  assert.equal(read.chat[3].from, d.id);
  assert.equal(read.chat[0].from, r.id);
  assert.equal(reports.find((x) => x !== read).chat, null, 'no keys, nothing readable');
  const wrong = await r.post('/api/reports', { userId: d.id, reason: 'Something else', chatKeys: [newKeys().publicKey] });
  assert.equal(wrong.status, 200);

  // A block stops it both ways, and deleting an account takes its chats along.
  await d.post('/api/blocks', { userId: r.id });
  assert.equal((await fromRider('Hi')).code, 'cant_send');
  await d.del('/api/blocks/' + r.id);
  assert.equal((await fromRider('Hi again')).status, 200);
  await d.post('/api/driver/offline');
  assert.equal((await r.del('/api/me')).status, 200);
  assert.equal((await d.get('/api/messages')).conversations.length, 0);
});

test('removing a chat: gone from your own list only, the limits and a report still see it, and it goes once both removed it', async () => {
  const r = await rider();
  const d = await driver({ at: { lat: 53.31, lng: 6.61 } });
  const rk = newKeys(), dk = newKeys();
  await r.post('/api/me/key', { publicKey: rk.publicKey });
  await d.post('/api/me/key', { publicKey: dk.publicKey });
  const send = (from, to, mine, theirs, words) => from.post(`/api/messages/${to.id}`, {
    body: seal(chatKey(mine.privateKey, mine.publicKey, theirs.publicKey), words), senderKey: mine.publicKey, toKey: theirs.publicKey,
  });
  const fromRider = (words) => send(r, d, rk, dk, words);
  const fromDriver = (words) => send(d, r, dk, rk, words);
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));
  for (const words of ['One', 'Two', 'Three']) assert.equal((await fromRider(words)).status, 200);
  assert.equal((await d.get('/api/messages')).unread, 3);

  // The driver removes it: gone for them, unread count too, and nothing changes for the rider.
  await later();
  assert.equal((await d.del(`/api/messages/${r.id}`)).status, 200);
  const list = await d.get('/api/messages');
  assert.equal(list.conversations.length, 0);
  assert.equal(list.unread, 0);
  assert.equal((await d.get(`/api/messages/${r.id}`)).messages.length, 0);
  assert.equal((await r.get(`/api/messages/${d.id}`)).messages.length, 3);

  // It's no way around the rule of 3: the server still counts what was removed.
  assert.equal((await fromRider('Four')).code, 'cant_send');
  assert.equal((await d.get(`/api/messages/${r.id}`)).canSend, true);

  // A new message brings the chat back, with only what's new.
  await later();
  assert.equal((await fromDriver('Back')).status, 200);
  assert.equal((await d.get('/api/messages')).conversations.length, 1);
  assert.equal((await d.get(`/api/messages/${r.id}`)).messages.length, 1);
  assert.equal((await r.get(`/api/messages/${d.id}`)).messages.length, 4);

  // A report still shows all of it, also what the other person removed.
  await r.post('/api/reports', { userId: d.id, reason: 'Harassment or abuse', chatKeys: [chatKey(rk.privateKey, rk.publicKey, dk.publicKey).toString('base64')] });
  const report = (await admin.get('/admin/api/reports?filter=open')).reports.find((x) => x.target_id === d.id && x.chat?.[0]?.text);
  assert.deepEqual(report.chat.map((m) => m.text), ['One', 'Two', 'Three', 'Back']);

  // Someone who was never in the chat gets nothing, and removing it changes nothing for them.
  const stranger = await rider();
  assert.equal((await stranger.del(`/api/messages/${d.id}`)).status, 200);
  assert.equal((await r.get(`/api/messages/${d.id}`)).messages.length, 4);

  // Removed by both: the messages are gone from the server.
  await later();
  await r.del(`/api/messages/${d.id}`);
  await later();
  await d.del(`/api/messages/${r.id}`);
  const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'), { readOnly: true });
  const left = db.prepare('SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.rider_id = ? AND c.driver_id = ?').get(r.id, d.id).n;
  db.close();
  assert.equal(left, 0);
  assert.equal((await r.get('/api/messages')).conversations.length, 0);
});

test('signing out stops alerts to that phone, not to another phone of the same person', async () => {
  const pushToken = (id) => {
    const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'), { readOnly: true });
    try { return db.prepare('SELECT push_token AS t FROM users WHERE id = ?').get(id).t; } finally { db.close(); }
  };
  const elsewhere = client(srv.base);
  await elsewhere.start();
  await elsewhere.patch('/api/me', { pushToken: 'other-phone', pushEnv: 'sandbox' });
  assert.equal((await elsewhere.post('/api/auth/logout', { pushToken: 'this-phone' })).status, 200);
  assert.equal(pushToken(elsewhere.id), 'other-phone');

  const c = client(srv.base);
  await c.start();
  await c.patch('/api/me', { pushToken: 'this-phone', pushEnv: 'sandbox' });
  assert.equal(pushToken(c.id), 'this-phone');
  assert.equal((await c.post('/api/auth/logout', { pushToken: 'this-phone' })).status, 200);
  assert.equal(pushToken(c.id), null);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('a login works from another phone; deleting ends the account', async () => {
  const c = client(srv.base);
  await c.start();
  const email = `t${Date.now()}@example.com`;
  assert.equal((await c.post('/api/auth/register', { email, password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { email, password: 'long-enough' })).status, 200);
  const other = client(srv.base);
  assert.equal((await other.post('/api/auth/login', { email, password: 'wrong-password' })).status, 401);
  const ok = await other.post('/api/auth/login', { email, password: 'long-enough' });
  assert.equal(ok.user.id, c.id);
  other.setToken(ok.token);
  assert.equal((await other.del('/api/me')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await other.post('/api/auth/login', { email, password: 'long-enough' })).status, 401);
});

test('deleting takes photos, plates, wallets and review texts along; the rides stay without them', async () => {
  const at = { lat: 48.63, lng: 5.55 };
  const d = await driver({ at });
  const car = (await d.get('/api/driver')).driver.cars[0];
  const photo = `${srv.base}${car.photos[0].url}`;
  assert.equal((await fetch(photo)).status, 200);
  assert.equal((await admin.get(`/admin/api/users/${d.id}`)).wallets.length, 1);
  assert.equal((await d.post('/api/driver/offline')).status, 200);
  assert.equal((await d.del('/api/me')).status, 200);
  assert.equal((await fetch(photo)).status, 404);
  const seen = await admin.get(`/admin/api/users/${d.id}`);
  assert.equal(seen.wallets.length, 0);
  assert.equal(seen.user?.name ?? seen.name, 'Deleted');
  assert.equal((await d.get('/api/me')).status, 401);
});

test('three strikes: each a week on the phone, the third for good; one appeal a day, none after a decision', async () => {
  const c = await rider();
  const first = await admin.post(`/admin/api/users/${c.id}/strike`, { reason: 'Rude' });
  assert.equal(first.strikes, 1);
  assert.equal(first.permanent, false);
  // Banned everywhere except standing.
  const blocked = await c.get('/api/wallet');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.code, 'banned');
  // A new account on the same phone is the same ban.
  const again = client(srv.base, c.deviceId);
  const back = await again.post('/api/auth/continue', { deviceId: c.deviceId });
  assert.equal(back.user.id, c.id);
  assert.equal(back.standing.ban.kind, 'week');
  // Logging in to another account on that phone doesn't help.
  const friend = client(srv.base);
  await friend.start();
  const email = `f${Date.now()}@example.com`;
  await friend.post('/api/auth/register', { email, password: 'long-enough' });
  const onBanned = client(srv.base, c.deviceId);
  const login = await onBanned.post('/api/auth/login', { email, password: 'long-enough' });
  onBanned.setToken(login.token);
  assert.equal((await onBanned.get('/api/wallet')).status, 403);
  assert.ok(login.standing.ban);
  // Appeals: one in 24 hours.
  assert.equal((await c.post('/api/appeals', { message: 'Sorry about that' })).status, 200);
  const tooSoon = await c.post('/api/appeals', { message: 'Please please' });
  assert.equal(tooSoon.status, 429);
  await dev(`/dev/clock?ms=${25 * 3600_000}`);
  const second = await c.post('/api/appeals', { message: 'Second try here' });
  assert.equal(second.status, 200);
  assert.equal(second.ban.canAppeal, false);
  // A decision ends it, for this ban.
  const open = await admin.get('/admin/api/appeals');
  const mine = open.appeals.find((a) => a.user_id === c.id);
  assert.equal((await admin.post(`/admin/api/appeals/${mine.id}`, { decision: 'uphold', answer: 'It stays' })).status, 200);
  const standing = await c.get('/api/standing');
  assert.equal(standing.ban.decided, true);
  assert.equal(standing.ban.canAppeal, false);
  assert.equal(standing.ban.answer, 'It stays');
  await dev(`/dev/clock?ms=${25 * 3600_000}`);
  assert.equal((await c.post('/api/appeals', { message: 'One more time' })).status, 409);
  // A week later it's over, and the strike stays.
  await dev(`/dev/clock?ms=${6 * 24 * 3600_000}`);
  assert.equal((await c.get('/api/wallet')).status, 200);
  assert.equal((await c.get('/api/standing')).strikes, 1);
  const second2 = await admin.post(`/admin/api/users/${c.id}/strike`, { reason: 'Two' });
  assert.equal(second2.permanent, false);
  const third = await admin.post(`/admin/api/users/${c.id}/strike`, { reason: 'Three' });
  assert.equal(third.strikes, 3);
  assert.equal(third.permanent, true);
  // Reinstalling the app: no login any more, the same phone. It gets the banned account back.
  const reinstalled = client(srv.base, c.deviceId);
  const after = await reinstalled.post('/api/auth/continue', { deviceId: c.deviceId });
  assert.equal(after.user.id, c.id);
  assert.equal(after.standing.ban.endsAt, null, 'still for good');
  reinstalled.setToken(after.token);
  assert.equal((await reinstalled.get('/api/wallet')).code, 'banned');
  assert.equal((await c.get('/api/standing')).ban.endsAt, null);
  await dev(`/dev/clock?ms=${40 * 24 * 3600_000}`);
  assert.equal((await c.get('/api/wallet')).status, 403, 'still banned much later');
  // Lifting by an admin brings them back and takes back that strike.
  assert.equal((await admin.post(`/admin/api/users/${c.id}/unban`, { why: 'Mistake' })).status, 200);
  assert.equal((await c.get('/api/wallet')).status, 200);
  assert.equal((await c.get('/api/standing')).strikes, 2);
});

test('quotes: the cheapest driver includes the way to the pickup, and the spot moves to the road', async () => {
  const near = await driver({ at: NEAR, perKm: 100, pickup: 100 });
  const far = await driver({ at: { lat: 52.40, lng: 4.95 }, perKm: 100, pickup: 100 });
  const cheapRate = await driver({ at: { lat: 52.40, lng: 4.95 }, perKm: 50, pickup: 10 });
  const tooFar = await driver({ at: { lat: 52.8, lng: 5.6 }, perKm: 10, pickup: 10 });
  const r = await rider();
  const q = await r.post('/api/quote', { pickup: { ...PICK, lat: 52.373 }, dropoff: DROP, passengers: 1, coin: 'sol' });
  assert.equal(q.status, 200, JSON.stringify(q));
  assert.equal(q.pickup.lat, 52.37, 'moved to the road');
  assert.ok(q.pickup.movedM > 300);
  const ids = q.offers.map((o) => o.id);
  assert.ok(!ids.includes(tooFar.id), 'more than 40 km away');
  assert.deepEqual(ids.indexOf(cheapRate.id), 0, 'lowest per km wins here');
  const nearOffer = q.offers.find((o) => o.id === near.id), farOffer = q.offers.find((o) => o.id === far.id);
  assert.ok(nearOffer.priceCents < farOffer.priceCents, 'same rate: the longer way to the pickup costs more');
  await stopAll(near, far, cheapRate, tooFar);
});

test('each car has its own prices: the active one is what riders are quoted', async () => {
  const d = await driver({ at: { lat: 47.0, lng: 4.9 }, perKm: 100, perMin: 20, pickup: 50 });
  const r = await rider();
  const route = { pickup: { lat: 47.0, lng: 4.9, label: 'P' }, dropoff: { lat: 47.0, lng: 4.95, label: 'D' }, passengers: 1, coin: 'sol' };
  const cheap = (await r.post('/api/quote', route)).offers.find((o) => o.id === d.id);
  // A second car starts with the prices of the car in use.
  const added = await d.post('/api/cars', { plate: 'VAN123', make: 'VW', model: 'Crafter', seats: 8, body: 'van' });
  assert.equal(added.car.perKmCents, 100);
  for (const kind of ['front', 'back', 'inside']) await photo(d, added.car.id, kind);
  assert.equal((await d.patch(`/api/cars/${added.car.id}`, { perKmCents: 300, petsAllowed: true })).car.perKmCents, 300);
  assert.equal((await r.post('/api/quote', route)).offers.find((o) => o.id === d.id).priceCents, cheap.priceCents, 'still the first car');
  // Pets and seats follow the car in use too.
  assert.ok(!(await r.post('/api/quote', { ...route, pets: true })).offers.some((o) => o.id === d.id));
  assert.ok(!(await r.post('/api/quote', { ...route, passengers: 6 })).offers.some((o) => o.id === d.id));
  assert.equal((await d.post(`/api/cars/${added.car.id}/activate`)).driver.perKmCents, 300);
  const van = (await r.post('/api/quote', route)).offers.find((o) => o.id === d.id);
  assert.ok(van.priceCents > cheap.priceCents, `${van.priceCents} > ${cheap.priceCents}`);
  assert.equal(van.perKmCents, 300);
  assert.equal(van.car.plate, 'VAN123');
  assert.ok((await r.post('/api/quote', { ...route, pets: true })).offers.some((o) => o.id === d.id));
  assert.ok((await r.post('/api/quote', { ...route, passengers: 6 })).offers.some((o) => o.id === d.id));
  assert.equal((await d.patch(`/api/cars/${added.car.id}`, { perKmCents: 99999 })).code, 'bad_rate');
  await d.post('/api/driver/offline');
});

test('a motor or scooter takes one passenger, whatever an app sends', async () => {
  const d = client(srv.base);
  await d.start();
  await d.post('/api/driver/enable');
  const prices = { perKmCents: 40, perMinCents: 10, pickupPerKmCents: 20 };
  const motor = (await d.post('/api/cars', { plate: 'ONE12K', vehicle: 'motor', seats: 2, make: 'BMW', model: 'R 1250', ...prices })).car;
  assert.equal(motor.seats, 1);
  assert.equal((await d.patch(`/api/cars/${motor.id}`, { seats: 3 })).car.seats, 1);
  const car = (await d.post('/api/cars', { plate: 'ONE13K', vehicle: 'car', seats: 6, make: 'VW', model: 'Touran', ...prices })).car;
  assert.equal(car.seats, 6, 'a car keeps its seats');
  assert.equal((await d.patch(`/api/cars/${car.id}`, { vehicle: 'scooter' })).car.seats, 1, 'also when a car becomes a scooter');
});

test('motors and scooters: a rider can ask for one, and an order for one only goes to one', async () => {
  const at = { lat: 44.0, lng: 4.9 };
  const carDriver = await driver({ at });
  const scooter = client(srv.base);
  await scooter.start();
  await scooter.post('/api/driver/enable');
  const added = await scooter.post('/api/cars', { plate: 'DGB12K', vehicle: 'scooter', make: 'Piaggio', model: 'Zip', perKmCents: 40, perMinCents: 10, pickupPerKmCents: 20 });
  assert.equal(added.car.vehicle, 'scooter');
  assert.equal(added.car.seats, 1, 'one passenger unless said otherwise');
  for (const kind of ['front', 'back']) await photo(scooter, added.car.id, kind);
  await scooter.post('/api/wallet/address', { coin: 'sol', address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' });
  // Drivezzz checks no licences: the app tells a driver once that they're up to them, and the server keeps when.
  assert.equal((await scooter.get('/api/driver')).driver.rulesSeenAt, null);
  assert.ok((await scooter.post('/api/driver/rules-seen')).driver.rulesSeenAt > 0);
  await scooter.post('/api/driver/online', at);
  const r = await rider();
  const ride = { pickup: { ...at, label: 'P' }, dropoff: { lat: 44.0, lng: 4.95, label: 'D' }, passengers: 1, coin: 'sol' };
  const ids = async (extra) => (await r.post('/api/quote', { ...ride, ...extra })).offers.map((o) => o.id);
  assert.ok((await ids({})).includes(scooter.id) && (await ids({})).includes(carDriver.id), 'any vehicle by default');
  assert.deepEqual(await ids({ vehicle: 'scooter' }), [scooter.id]);
  assert.deepEqual(await ids({ vehicle: 'car' }), [carDriver.id]);
  assert.deepEqual(await ids({ vehicle: 'motor' }), []);
  assert.ok(!(await ids({ passengers: 2 })).includes(scooter.id), 'no room for two');
  const near = await r.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}&vehicle=scooter`);
  assert.deepEqual(near.drivers.map((d) => d.id), [scooter.id]);
  // Name your price for a scooter: a car doesn't see it and can't claim it; the scooter does.
  const bid = await r.post('/api/rides', { ...ride, vehicle: 'scooter', mode: 'bid', bidCents: 500 });
  assert.equal(bid.ride.vehicle, 'scooter');
  const market = async (d) => (await d.get(`/api/driver/market?lat=${at.lat}&lng=${at.lng}`)).orders.map((o) => o.id);
  assert.ok(!(await market(carDriver)).includes(bid.ride.id));
  assert.ok((await market(scooter)).includes(bid.ride.id));
  assert.equal((await carDriver.post(`/api/rides/${bid.ride.id}/claim`)).code, 'wrong_vehicle');
  assert.equal((await scooter.post(`/api/rides/${bid.ride.id}/claim`)).ride.status, 'awaiting_payment');
  await scooter.post(`/api/rides/${bid.ride.id}/driver-cancel`, { reason: 'Other' });
  await stopAll(carDriver, scooter);
});

test('an order on the market shows the street, not the door', async () => {
  const d = await driver({ at: { lat: 46.0, lng: 4.9 } });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: { lat: 46.0, lng: 4.9, label: 'Sint Agnietenstraat 14, Amsterdam' }, dropoff: { lat: 46.0, lng: 4.95, label: 'Kramatplantsoen 100B, Amsterdam' }, passengers: 1, mode: 'bid', bidCents: 900, coin: 'sol' });
  assert.equal(made.status, 200, JSON.stringify(made));
  const order = (await d.get('/api/driver/market?lat=46.0&lng=4.9')).orders.find((o) => o.id === made.ride.id);
  assert.equal(order.pickupLabel, 'Sint Agnietenstraat, Amsterdam');
  assert.equal(order.dropoffLabel, 'Kramatplantsoen, Amsterdam');
  // Taking it shows the whole address.
  assert.equal((await d.post(`/api/rides/${made.ride.id}/claim`)).ride.pickup.label, 'Sint Agnietenstraat 14, Amsterdam');
  await d.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Other' });
  await d.post('/api/driver/offline');
});

test('the whole ride: offer, accept, check in within 100 m, check out at the drop-off, paid after 24 hours', async () => {
  const d = await driver({ at: NEAR, plate: 'AB123C' });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'auto', coin: 'sol' });
  assert.equal(made.status, 200, JSON.stringify(made));
  assert.equal(made.ride.status, 'offered');
  assert.equal(made.ride.payUrl, undefined, 'nothing to pay before a driver has it');
  const id = made.ride.id;
  // The driver hears of it at once.
  const sync = await d.get('/api/sync?rev=0');
  assert.equal(sync.driving.offer.id, id);
  assert.ok(sync.driving.offer.offeredUntil);
  // A stranger can't take it.
  const other = await driver({ at: NEAR });
  assert.equal((await other.post(`/api/rides/${id}/accept`)).status, 409);
  await other.post('/api/driver/offline');
  const accepted = await d.post(`/api/rides/${id}/accept`);
  assert.equal(accepted.ride.status, 'awaiting_payment');
  // The driver can set off already; the rider gets a Solana Pay link and 5 minutes.
  assert.equal((await d.get('/api/sync?rev=0')).driving.drive.status, 'awaiting_payment');
  const asked = (await r.get(`/api/rides/${id}`)).ride;
  assert.ok(asked.payUrl.startsWith('solana:'), asked.payUrl);
  assert.ok(asked.payBy > Date.now() + 4 * 60_000);
  const token = decodeURIComponent(asked.payUrl.slice(7)).split('/').pop();
  assert.equal((await r.get(`/api/pay/${token}`)).label, 'Drivezzz', 'the wallet asks who it is');
  assert.equal((await r.post(`/api/pay/${token}`, { account: 'nope' })).code, 'bad_account');
  assert.equal((await r.post(`/api/pay/${token}`, { account: r.wallet })).transaction, 'fake');
  assert.equal((await r.post(`/api/rides/${made.ride.id}/pay`, { account: r.wallet })).transaction, 'fake', 'the app asks the same, for a wallet that only signs');
  assert.equal((await r.post(`/api/rides/${made.ride.id}/pay/send`, { transaction: 'x' })).ok, true, 'and hands back what it signed');
  assert.equal((await d.post(`/api/rides/${made.ride.id}/pay/send`, { transaction: 'x' })).code, 'not_found', 'only the rider');
  // The pay card shows what it comes to in SOL: what the wallet was asked for (SOL at €100 here).
  const quoted = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(quoted.eurPerCoin, 100);
  assert.ok(Math.abs(Number(quoted.payAmount) * quoted.eurPerCoin * 100 - quoted.priceCents) < 1, `${quoted.payAmount} SOL for ${quoted.priceCents} cents`);
  assert.equal((await d.get(`/api/rides/${id}`)).ride.payAmount, undefined, 'for the rider');
  await dev('/dev/payments');
  const view = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(view.status, 'accepted');
  assert.equal(view.escrow.status, 'paid');
  assert.ok(Number(view.escrow.amount) > 0);
  assert.equal(view.driver.car.plate, 'AB123C');
  assert.ok(view.driver.lat, 'the rider sees the driver on the way');
  assert.equal((await d.get('/api/sync?rev=0')).driving.drive.status, 'accepted');
  // Check in: too far, then close.
  await r.post('/api/location', AMS);
  const far = await r.post(`/api/rides/${id}/check-in`, { ...AMS, plateChecked: true });
  assert.equal(far.status, 409);
  assert.equal(far.code, 'too_far');
  await d.post('/api/location', { lat: 52.3703, lng: 4.8902, driving: true });
  assert.equal((await r.get(`/api/rides/${id}`)).ride.status, 'arrived');
  assert.equal((await r.get(`/api/rides/${id}`)).ride.canCheckIn, true);
  assert.equal((await r.post(`/api/rides/${id}/check-in`, { ...AMS })).status, 400, 'plate first');
  const inCar = await r.post(`/api/rides/${id}/check-in`, { ...AMS, plateChecked: true });
  assert.equal(inCar.ride.status, 'riding');
  assert.equal((await r.post(`/api/rides/${id}/cancel`)).status, 409, 'too late to cancel');
  // Together along the way.
  for (let lng = 4.892; lng < 4.93; lng += 0.002) {
    await d.post('/api/location', { lat: 52.37, lng, driving: true });
    await r.post('/api/location', { lat: 52.37, lng });
  }
  // Check out: the driver needs to be there, and the rider too.
  const early = await d.post(`/api/rides/${id}/check-out`, { lat: 52.37, lng: 4.93 });
  assert.equal(early.status, 409);
  assert.equal(early.code, 'too_far');
  assert.equal((await d.get(`/api/rides/${id}`)).ride.checkOutM, 200, 'the app greys the button until then');
  // About 270 m off isn't there yet: 200 m (Pieter, 8 November 2026).
  assert.equal((await d.post(`/api/rides/${id}/check-out`, { lat: 52.37, lng: 4.946 })).code, 'too_far', '270 m is too far');
  await d.post('/api/location', { lat: 52.37, lng: 4.9495, driving: true });
  await r.post('/api/location', { lat: 52.37, lng: 4.9497 });
  const done = await d.post(`/api/rides/${id}/check-out`, { lat: 52.37, lng: 4.9495 });
  assert.equal(done.ride.status, 'completed');
  assert.equal(done.ride.checkoutWarning, false);
  assert.ok(done.ride.syncScore >= 0.8, `sync ${done.ride.syncScore}`);
  assert.equal(done.ride.payout.status, 'held');
  assert.ok(done.ride.payout.dueAt > Date.now() + 23 * 3600_000 - 1000);
  // A review shows on the driver's profile.
  assert.equal((await r.post(`/api/rides/${id}/review`, { stars: 5, text: 'Great' })).status, 200);
  const profile = await r.get(`/api/drivers/${d.id}`);
  assert.equal(profile.driver.rating, 5);
  assert.equal(profile.reviews[0].text, 'Great');
  assert.equal(profile.driver.arrivalScore, 100);
  // Earnings.
  const home = await d.get('/api/driver/home?tzMinutes=60');
  assert.equal(home.earnedTodayCents, done.ride.priceCents - 10, 'the price minus Drivezzz’s 10 cents');
  await d.post('/api/driver/offline');
  // A day later the escrow pays out.
  await dev(`/dev/clock?ms=${24 * 3600_000 + 1000}`);
  await dev('/dev/money');
  const settled = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(settled.escrow.status, 'settled');
  assert.equal(settled.escrow.outcome, 'payout');
  assert.equal(settled.payout.status, 'confirmed');
});

test('someone stays rider or driver until the ride or drive is over', async () => {
  const order = (c) => c.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'auto', coin: 'sol' });
  const d = await driver({ at: NEAR });
  const both = await driver({ at: { lat: 53.2, lng: 6.5 } });
  await both.post('/api/driver/offline');
  await both.post('/api/location', AMS);

  // A ride planned for later doesn't count until it starts.
  const later = await both.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'auto', coin: 'sol', scheduledAt: (await dev('/dev/clock?ms=0')).now + 3 * 3600_000 });
  assert.equal(later.status, 200, JSON.stringify(later));
  assert.equal((await both.post('/api/driver/online', NEAR)).status, 200);
  await both.post('/api/driver/offline');
  await both.post(`/api/rides/${later.ride.id}/cancel`);

  // Waiting for a driver already counts: no going online, not even through the phone's position.
  const made = await order(both);
  assert.equal(made.status, 200, JSON.stringify(made));
  assert.equal((await both.post('/api/driver/online', NEAR)).code, 'on_a_ride');
  await both.post('/api/location', { ...NEAR, driving: true });
  assert.equal((await both.get('/api/sync?rev=0')).driving.online, false);

  // The driver who takes it can't order a ride until it's over.
  assert.equal((await d.post(`/api/rides/${made.ride.id}/accept`)).ride.status, 'awaiting_payment');
  assert.equal((await order(d)).code, 'on_a_drive', 'waiting for the payment counts');
  assert.equal((await both.post('/api/driver/online', NEAR)).code, 'on_a_ride');

  // Over: both are free again.
  await d.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Alcohol abuse' });
  assert.equal((await both.post('/api/driver/online', NEAR)).status, 200);
  const own = await order(d);
  assert.equal(own.status, 200, JSON.stringify(own));

  // A driver with an order of their own can't go back online and isn't offered anything.
  assert.equal((await d.post('/api/driver/online', NEAR)).code, 'on_a_ride');
  await both.post('/api/driver/offline');
  const r = await rider();
  const stranger = await order(r);
  assert.equal((await d.get('/api/sync?rev=0')).driving.offer, null);
  if (stranger.ride) await r.post(`/api/rides/${stranger.ride.id}/cancel`);
  await d.post(`/api/rides/${own.ride.id}/cancel`);
  assert.equal((await d.post('/api/driver/online', NEAR)).status, 200);
  await stopAll(d, both);
});

test('the Driving tab’s acceptance rate counts what a driver said yes and no to', async () => {
  const d = await driver({ at: NEAR });
  const r = await rider();
  assert.equal((await d.get('/api/driver/home')).acceptancePercent, null);
  const first = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  await d.post(`/api/rides/${first.ride.id}/decline`);
  assert.equal((await d.get('/api/driver/home')).acceptancePercent, 0);
  await r.post(`/api/rides/${first.ride.id}/cancel`);
  const second = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  await d.post(`/api/rides/${second.ride.id}/accept`);
  assert.equal((await d.get('/api/driver/home')).acceptancePercent, 50);
  await d.post(`/api/rides/${second.ride.id}/driver-cancel`, { reason: 'Other' });
  await d.post('/api/driver/offline');
});

test('cancelling: free before paying, a driver cancelling refunds, a rider cancelling late splits 50/50', async () => {
  const d = await driver({ at: NEAR });
  const r = await rider();
  const order = () => r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'auto', coin: 'sol' });
  const outcome = async (id) => (await r.get(`/api/rides/${id}`)).ride.escrow?.outcome ?? null;
  const made = await order();
  assert.equal(made.ride.refundPercent, 100, 'nobody took it yet: free to cancel');
  assert.equal((await r.post(`/api/rides/${made.ride.id}/cancel`)).ride.status, 'cancelled');
  // Taken but not paid yet: still free, nothing to give back.
  const unpaid = await order();
  await d.post(`/api/rides/${unpaid.ride.id}/accept`);
  assert.equal((await r.get(`/api/rides/${unpaid.ride.id}`)).ride.refundPercent, 100);
  await r.post(`/api/rides/${unpaid.ride.id}/cancel`);
  assert.equal(await outcome(unpaid.ride.id), null);
  // Paid, then the driver cancels: everything back.
  const again = await order();
  await d.post(`/api/rides/${again.ride.id}/accept`);
  await pay(r, again.ride.id);
  const gone = await d.post(`/api/rides/${again.ride.id}/driver-cancel`, { reason: 'Alcohol abuse' });
  assert.equal(gone.ride.status, 'cancelled');
  assert.equal(gone.ride.cancelReason, 'Alcohol abuse');
  assert.equal(await outcome(again.ride.id), 'refund');
  await dev('/dev/money');
  assert.equal((await r.get(`/api/rides/${again.ride.id}`)).ride.escrow.status, 'settled', 'a refund goes right away');
  // Paid, the driver there in time and the 5 minutes for paying over: the driver can't go offline, and a rider cancelling gets
  // half back after the 24 hours.
  const third = await order();
  await d.post(`/api/rides/${third.ride.id}/accept`);
  const firstMinutes = await pay(r, third.ride.id);
  assert.equal(firstMinutes.refundPercent, 50, 'half from the moment it’s paid');
  assert.equal((await d.post('/api/driver/offline')).code, 'on_a_drive');
  await d.post('/api/location', { lat: PICK.lat, lng: PICK.lng, driving: true, speed: 0 });
  await dev('/dev/clock?ms=301000');
  const taken = (await r.get(`/api/rides/${third.ride.id}`)).ride;
  assert.equal(taken.refundPercent, 50);
  assert.equal((await r.post(`/api/rides/${third.ride.id}/cancel`)).ride.status, 'cancelled');
  assert.equal(await outcome(third.ride.id), 'split');
  const half = await payoutOf(d, third.ride.id);
  assert.equal(Number(half.amount), Math.floor(Number(taken.escrow.amount) * 1e9 / 2) / 1e9);
  assert.equal(half.status, 'held');
  await dev('/dev/money');
  assert.equal((await r.get(`/api/rides/${third.ride.id}`)).ride.escrow.status, 'paid', 'held for 24 hours, for an appeal');
  assert.equal((await d.post('/api/driver/offline')).status, 200, 'no rider any more');
  // Planned with a driver: paid when a driver has it, free to cancel until 3 hours before, half after that.
  await d.post('/api/driver/online', NEAR);
  const clock = (await dev('/dev/clock?ms=0')).now;
  const plan = async (at) => {
    const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol', scheduledAt: at });
    assert.equal(made.ride.status, 'open', JSON.stringify(made));
    assert.equal((await d.post(`/api/rides/${made.ride.id}/claim`)).status, 200);
    return r.get(`/api/rides/${made.ride.id}`);
  };
  const early = await plan(clock + 5 * 3600_000);
  assert.equal(early.ride.status, 'awaiting_payment', JSON.stringify(early));
  assert.ok(early.ride.payBy >= clock + 5 * 3600_000 - 30 * 60_000, 'until 30 minutes before');
  const paidEarly = await pay(r, early.ride.id);
  assert.equal(paidEarly.status, 'scheduled');
  assert.equal(paidEarly.refundPercent, 100);
  assert.equal(paidEarly.freeCancelUntil, clock + 2 * 3600_000);
  await r.post(`/api/rides/${early.ride.id}/cancel`);
  assert.equal(await outcome(early.ride.id), 'refund');
  assert.equal(await payoutOf(d, early.ride.id), undefined, 'no payout when it was free');
  const late = await plan(clock + 2 * 3600_000);
  assert.equal((await pay(r, late.ride.id)).refundPercent, 50);
  await r.post(`/api/rides/${late.ride.id}/cancel`);
  assert.equal(await outcome(late.ride.id), 'split');
  assert.ok(await payoutOf(d, late.ride.id), 'the driver gets half');
  await d.post('/api/driver/offline');
});

test('paying: within 5 minutes, once; a late or second payment is refunded', async () => {
  const d = await driver({ at: NEAR });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  assert.equal(made.status, 200, JSON.stringify(made));
  assert.equal((await r.post(`/api/rides/${made.ride.id}/pay`, { account: r.wallet })).code, 'not_waiting', 'not before a driver has it');
  await d.post(`/api/rides/${made.ride.id}/accept`);
  // Someone else can't pay it through the app.
  const stranger = await rider();
  assert.equal((await stranger.post(`/api/rides/${made.ride.id}/pay`, { account: stranger.wallet })).status, 404);
  // Two wallets pay: the first counts, the second goes back.
  await r.post(`/api/rides/${made.ride.id}/pay`, { account: r.wallet });
  await r.post(`/api/rides/${made.ride.id}/pay`, { account: newWallet() });
  await dev('/dev/payments');
  await dev('/dev/money');
  const after = (await admin.get(`/admin/api/rides/${made.ride.id}`));
  assert.equal(after.escrows.length, 2);
  assert.deepEqual(after.escrows.map((e) => e.outcome).sort(), [null, 'refund']);
  assert.ok(after.escrows.some((e) => e.status === 'settled' && e.outcome === 'refund'));
  assert.equal(after.ride.status, 'accepted');
  await d.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Other' });
  // Not paid within 5 minutes: cancelled, and the driver is free again.
  const slow = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  await d.post(`/api/rides/${slow.ride.id}/accept`);
  await dev(`/dev/clock?ms=${11 * 60_000}`);
  await d.post('/api/location', { ...NEAR, driving: true });
  await dev('/dev/tick');
  const over = (await r.get(`/api/rides/${slow.ride.id}`)).ride;
  assert.equal(over.status, 'cancelled');
  assert.equal(over.cancelReason, 'Not paid in time');
  assert.equal((await d.get('/api/sync?rev=0')).driving.drive, null);
  assert.equal((await r.post(`/api/rides/${slow.ride.id}/pay`, { account: r.wallet })).code, 'not_waiting');
  await d.post('/api/driver/offline');
});

test('name your price: drivers see it on the market and the first to claim gets it', async () => {
  const d1 = await driver({ at: NEAR });
  const d2 = await driver({ at: NEAR });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 2, mode: 'bid', bidCents: 1500, coin: 'sol' });
  assert.equal(made.ride.status, 'open');
  const market = await d1.get(`/api/driver/market?lat=${NEAR.lat}&lng=${NEAR.lng}`);
  const order = market.orders.find((o) => o.id === made.ride.id);
  assert.equal(order.bidCents, 1500);
  assert.equal(order.kind, 'now');
  assert.equal(order.lat, 52.37);
  const raised = await r.post(`/api/rides/${made.ride.id}/bid`, { bidCents: 1800 });
  assert.equal(raised.ride.maxCents, 1800);
  const claimed = await d1.post(`/api/rides/${made.ride.id}/claim`);
  assert.equal(claimed.ride.status, 'awaiting_payment');
  assert.equal(claimed.ride.priceCents, 1800);
  assert.equal((await d2.post(`/api/rides/${made.ride.id}/claim`)).code, 'order_gone');
  // With a rider, d1 still sees new orders but can't claim one, a planned one neither.
  const next = await (await rider()).post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'bid', bidCents: 1500, coin: 'sol' });
  const busy = await d1.get(`/api/driver/market?lat=${NEAR.lat}&lng=${NEAR.lng}`);
  assert.equal(busy.driving, true);
  assert.equal(busy.orders.find((o) => o.id === next.ride.id).canClaim, false);
  // What d1 booked is on their map as a ride of theirs, with its exact pickup, and on nobody else's.
  assert.ok(!busy.orders.some((o) => o.id === made.ride.id));
  const mine = busy.booked.find((x) => x.id === made.ride.id);
  assert.equal(mine.status, 'awaiting_payment');
  assert.equal(mine.role, 'driver');
  assert.equal(mine.pickup.lat, PICK.lat);
  assert.ok(!(await d2.get(`/api/driver/market?lat=${NEAR.lat}&lng=${NEAR.lng}`)).booked.some((x) => x.id === made.ride.id));
  assert.equal((await d1.post(`/api/rides/${next.ride.id}/claim`)).code, 'on_a_ride');
  assert.equal((await d2.post(`/api/rides/${next.ride.id}/claim`)).ride.status, 'awaiting_payment');
  await d2.post(`/api/rides/${next.ride.id}/driver-cancel`, { reason: 'Other' });
  await d1.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Other' });
  assert.ok(!(await d1.get(`/api/driver/market?lat=${NEAR.lat}&lng=${NEAR.lng}`)).booked.some((x) => x.id === made.ride.id), 'cancelled: off the map');
  await stopAll(d1, d2);
});

test('the admin panel connects a Solana address for the fee, and only a real one', async () => {
  assert.equal((await admin.post('/admin/api/fee-address', { address: 'not an address' })).status, 400);
  assert.equal((await rider()).id && (await client(srv.base).post('/admin/api/fee-address', { address: 'G3kHqyNHGJyyALZykui6mkURog453C2RMN4pQSggvoxf' })).status, 401);
  const before = (await admin.get('/admin/api/escrow')).feeAddress;
  const wallet = newWallet();
  assert.equal((await admin.post('/admin/api/fee-address', { address: wallet })).status, 200);
  assert.equal((await admin.get('/admin/api/escrow')).feeAddress, wallet);
  assert.equal((await admin.post('/admin/api/fee-address', { address: before })).status, 200);
});

test('the list of drivers nearby says who takes planned rides', async () => {
  const at = { lat: 48.53, lng: 5.45 };
  const plans = await driver({ at, plans: true });
  const not = await driver({ at: { lat: 48.531, lng: 5.451 }, plans: false });
  const r = await rider();
  const list = (await r.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}&radiusKm=5`)).drivers;
  assert.equal(list.find((d) => d.id === plans.id).allowsPlanning, true);
  assert.equal(list.find((d) => d.id === not.id).allowsPlanning, false);
});

test('planning: the cheapest fit counts other planned drives, and clashes are left out', async () => {
  // Far from the other tests' drivers, who stay bookable for 24 hours.
  const clock = (await dev('/dev/clock?ms=0')).now;
  const at = clock + 3 * 3600_000;
  const close = await driver({ at: { lat: 48.03, lng: 4.95 }, perKm: 100, pickup: 200 });
  const r = await rider();
  // One planned drive that ends right where the next rider starts.
  const first = await r.post('/api/rides', { pickup: { lat: 48.03, lng: 4.95, label: 'A' }, dropoff: { lat: 48.0, lng: 4.895, label: 'B' }, passengers: 1, mode: 'driver', driverId: close.id, coin: 'sol', scheduledAt: at });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.ride.status, 'open', 'planned with a chosen driver: nothing to pay until they claim it');
  assert.equal((await close.post(`/api/rides/${first.ride.id}/claim`)).ride.status, 'awaiting_payment');
  const rideEnd = at + first.ride.durationS * 1000;
  // The other driver has the same rates, and would have to come from further.
  const other = await driver({ at: { lat: 48.05, lng: 4.95 }, perKm: 100, pickup: 200 });
  const second = await rider();
  const after = await second.post('/api/quote', { pickup: { lat: 48.0, lng: 4.9, label: 'C' }, dropoff: { lat: 48.0, lng: 4.95, label: 'D' }, passengers: 1, coin: 'sol', scheduledAt: rideEnd + 15 * 60_000 });
  assert.equal(after.status, 200, JSON.stringify(after));
  assert.equal(after.offers[0].id, close.id, 'the driver already finishing nearby is cheapest');
  assert.equal(after.offers[0].afterAnotherDrive, true);
  assert.ok(after.offers[0].priceCents < after.offers.find((o) => o.id === other.id).priceCents);
  // Booking without choosing goes for that cheapest price, but isn't given to anyone until a driver claims it.
  const auto = await second.post('/api/rides', { pickup: { lat: 48.0, lng: 4.9, label: 'C' }, dropoff: { lat: 48.0, lng: 4.95, label: 'D' }, passengers: 1, mode: 'auto', coin: 'sol', scheduledAt: rideEnd + 15 * 60_000 });
  assert.equal(auto.ride.status, 'open');
  assert.equal(auto.ride.driver, undefined);
  assert.equal(auto.ride.maxCents, after.offers[0].priceCents);
  await second.post(`/api/rides/${auto.ride.id}/cancel`);
  // During that drive they aren't offered.
  const clash = await second.post('/api/quote', { pickup: { lat: 48.0, lng: 4.9, label: 'C' }, dropoff: { lat: 48.0, lng: 4.95, label: 'D' }, passengers: 1, coin: 'sol', scheduledAt: at + 60_000 });
  assert.ok(!clash.offers.some((o) => o.id === close.id));
  // Passing on a drive not paid yet puts it back on the market: the rider isn't asked to pay until another driver claims it.
  assert.equal((await close.post(`/api/rides/${first.ride.id}/release`)).status, 200);
  const moved = (await r.get(`/api/rides/${first.ride.id}`)).ride;
  assert.equal(moved.status, 'open');
  assert.equal(moved.driver, undefined);
  assert.equal(moved.payBy, undefined);
  assert.equal(moved.payUrl, undefined);
  await r.post(`/api/rides/${first.ride.id}/cancel`);
  await stopAll(close, other);
});

test('planning: a driver has to allow it and says how far ahead, seven days at most', async () => {
  const clock = (await dev('/dev/clock?ms=0')).now;
  const day = 86_400_000;
  const at = { lat: 45.0, lng: 4.9 };
  const d = await driver({ at, plans: false });
  const r = await rider();
  const ride = { pickup: { ...at, label: 'P' }, dropoff: { lat: 45.0, lng: 4.95, label: 'D' }, passengers: 1, coin: 'sol' };
  const has = async (when) => (await r.post('/api/quote', { ...ride, scheduledAt: when })).offers?.some((o) => o.id === d.id);
  assert.equal(await has(clock + 2 * day), false, 'off by default');
  assert.equal((await r.get(`/api/drivers/${d.id}`)).availability.bookable, false);
  assert.equal((await d.get('/api/driver')).driver.allowsPlanning, false);
  assert.equal((await d.patch('/api/driver', { allowsPlanning: true, planDays: 3 })).driver.planDays, 3);
  assert.equal(await has(clock + 2 * day), true, 'within their 3 days');
  assert.equal(await has(clock + 4 * day), false, 'further than their 3 days');
  assert.equal((await r.get(`/api/drivers/${d.id}`)).availability.planDays, 3);
  assert.equal((await d.patch('/api/driver', { planDays: 8 })).code, 'bad_days', 'seven at most');
  assert.equal((await r.post('/api/quote', { ...ride, scheduledAt: clock + 8 * day })).code, 'too_far_ahead', 'nobody can plan past seven days');
  // On the market too: a planned order further ahead isn't shown, and with planning off it can't be claimed.
  const bid = await r.post('/api/rides', { ...ride, mode: 'bid', bidCents: 900, scheduledAt: clock + 6 * day });
  assert.equal(bid.ride.status, 'open');
  const orders = async () => (await d.get(`/api/driver/market?lat=${at.lat}&lng=${at.lng}`)).orders.map((o) => o.id);
  assert.ok(!(await orders()).includes(bid.ride.id));
  assert.equal((await d.post(`/api/rides/${bid.ride.id}/claim`)).code, 'too_far_ahead');
  await d.patch('/api/driver', { planDays: 7 });
  assert.ok((await orders()).includes(bid.ride.id));
  await d.patch('/api/driver', { allowsPlanning: false });
  assert.equal((await d.post(`/api/rides/${bid.ride.id}/claim`)).code, 'no_planning');
  await r.post(`/api/rides/${bid.ride.id}/cancel`);
  await d.post('/api/driver/offline');
});

test('rider and driver apart during a ride: the rider is asked; checking out without the rider warns both', async () => {
  const d = await driver({ at: NEAR });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  const id = made.ride.id;
  await d.post(`/api/rides/${id}/accept`);
  await pay(r, id);
  await d.post('/api/location', { ...AMS, driving: true });
  await r.post('/api/location', AMS);
  await r.post(`/api/rides/${id}/check-in`, { ...AMS, plateChecked: true });
  for (let i = 0; i < 10; i++) {
    await r.post('/api/location', AMS);
    await d.post('/api/location', { lat: 52.37, lng: 4.92 + i * 0.001, driving: true });
  }
  const during = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(during.safetyAsked, true);
  assert.equal((await r.post(`/api/rides/${id}/safety`, { ok: true })).ride.safetyAsked, false);
  // At the drop-off without the rider's phone: it goes through, with a warning to both.
  await d.post('/api/location', { lat: 52.37, lng: 4.9495, driving: true });
  const finished = await d.post(`/api/rides/${id}/check-out`, { lat: 52.37, lng: 4.9495 });
  assert.equal(finished.ride.status, 'completed');
  assert.equal(finished.ride.checkoutWarning, true);
  // The rider appeals; an admin refunds; the escrow sends it back.
  assert.equal((await r.post(`/api/rides/${id}/appeal`, { message: 'I never got there' })).status, 200);
  const dispute = (await admin.get('/admin/api/disputes')).disputes.find((x) => x.ride_id === id);
  assert.ok(dispute.ride.checkoutWarning);
  assert.equal((await admin.post(`/admin/api/disputes/${dispute.id}`, { decision: 'nonsense' })).code, 'bad_decision');
  assert.equal((await admin.post(`/admin/api/disputes/${dispute.id}`, { decision: 'refund_rider', answer: 'Refunded' })).status, 200);
  await dev('/dev/money');
  const after = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(after.payout.status, 'cancelled');
  assert.equal(after.escrow.outcome, 'refund');
  assert.equal(after.escrow.status, 'settled');
  await d.post('/api/driver/offline');
});

test('banning a driver takes them offline and returns their rider’s money; the admin sees who is online', async () => {
  const d = await driver({ at: NEAR });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  await d.post(`/api/rides/${made.ride.id}/accept`);
  await pay(r, made.ride.id);
  const online = await admin.get('/admin/api/users?filter=online');
  const row = online.users.find((u) => u.id === d.id);
  assert.equal(row.driving, true);
  assert.equal(row.ride.status, 'accepted');
  assert.equal((await admin.post(`/admin/api/users/${d.id}/ban`, { kind: 'permanent', reason: 'Fraud' })).status, 200);
  const cancelled = (await r.get(`/api/rides/${made.ride.id}`)).ride;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.escrow.outcome, 'refund');
  // Banned for good: their wallet is banned too.
  const fresh = client(srv.base);
  await fresh.start();
  assert.equal((await fresh.post('/api/wallet/address', { coin: 'sol', address: d.wallet })).code, 'banned');
  const near = await r.get(`/api/drivers/nearby?lat=${AMS.lat}&lng=${AMS.lng}`);
  assert.ok(!near.drivers.some((x) => x.id === d.id));
  const sync = await d.get('/api/sync?rev=0');
  assert.equal(sync.banned, true);
});

test('nearby: the cheapest first, as many as asked, and how many there are', async () => {
  const at = { lat: 48.2, lng: 16.37 };
  const dear = await driver({ at, perKm: 200 });
  const cheap = await driver({ at, perKm: 60 });
  const middle = await driver({ at, perKm: 120 });
  const r = await rider();
  const list = (q = '') => r.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}${q}`);
  const two = await list('&limit=2');
  assert.deepEqual(two.drivers.map((x) => x.id), [cheap.id, middle.id], 'the two cheapest');
  assert.equal(two.total, 3, 'and how many are online');
  assert.equal((await list()).drivers.length, 3, 'an app that doesn’t ask gets up to the default');
  const close = await driver({ at: { lat: 48.2005, lng: 16.3705 }, perKm: 200, perMin: 200 });
  assert.equal((await list()).drivers.at(-1).id, close.id, 'being closest doesn’t make a driver cheap');
  await stopAll(dear, cheap, middle, close);
});

test('nearby: by stars, by who’s closest or by who’s on time, if the rider asks', async () => {
  const at = { lat: 47.5, lng: 19.05 };
  const cheap = await driver({ at: { lat: 47.52, lng: 19.05 }, perKm: 60 });
  const loved = await driver({ at: { lat: 47.51, lng: 19.05 }, perKm: 150 });
  const once = await driver({ at: { lat: 47.505, lng: 19.05 }, perKm: 120 });
  const close = await driver({ at: { lat: 47.5005, lng: 19.05 }, perKm: 180 });
  const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'), { enableForeignKeyConstraints: false });
  const review = db.prepare('INSERT INTO reviews (ride_id, rider_id, driver_id, stars, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 30; i++) review.run(`loved-${i}`, 'nobody', loved.id, i % 10 === 0 ? 4 : 5, Date.now());
  review.run('once', 'nobody', once.id, 5, Date.now());
  const ride = db.prepare(`INSERT INTO rides (id, rider_id, driver_id, status, mode, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_m, duration_s, max_cents, coin, coin_units, eur_per_coin, arrived_at, pickup_deadline_at, created_at)
                           VALUES (?, 'nobody', ?, 'completed', 'driver', 0, 0, 0, 0, 1, 1, 1, 'sol', 1, 1, ?, ?, ?)`);
  for (let i = 0; i < 5; i++) {
    ride.run(`on-time-${i}`, close.id, 1000, 2000, Date.now());
    ride.run(`late-${i}`, cheap.id, 3000, 2000, Date.now());
  }
  db.close();
  const r = await rider();
  const first = async (sort) => (await r.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}&sort=${sort}`)).drivers.map((x) => x.id);
  assert.equal((await first('cheapest'))[0], cheap.id);
  assert.deepEqual((await first('stars')).slice(0, 2), [loved.id, once.id], 'one perfect review doesn’t beat thirty good ones');
  assert.equal((await first('fastest'))[0], close.id);
  const onTime = await first('onTime');
  assert.equal(onTime[0], close.id);
  assert.equal(onTime.indexOf(cheap.id), 1, 'late still comes before nothing to go on');
  const card = (await r.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}&sort=stars`)).drivers[0];
  assert.equal(card.rating, 4.9);
  assert.equal(card.ratingCount, 30);
  assert.ok(card.car.photos.length >= 3 && card.coins.includes('sol'), 'the card is whole');
  await stopAll(cheap, loved, once, close);
});

test('GPS wobble: a phone standing still hasn’t moved, and a car may move up at the pickup', async () => {
  const d = await driver({ at: PICK });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  assert.equal((await d.post(`/api/rides/${made.ride.id}/accept`)).status, 200);
  await pay(r, made.ride.id);
  const at = (metresNorth, speed = 0) => d.post('/api/location', { lat: PICK.lat + metresNorth / 111_000, lng: PICK.lng, driving: true, speed });
  const look = async () => (await r.get(`/api/rides/${made.ride.id}`)).ride;
  const points = () => {
    const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'), { readOnly: true });
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ride_points WHERE ride_id = ? AND who = 'driver'`).get(made.ride.id).n;
    db.close();
    return n;
  };
  await at(0);
  const parked = await look();
  assert.equal(parked.status, 'arrived');
  assert.ok(parked.noShowFrom, 'stopped at the spot: the wait runs');
  const stored = points();
  // Ten metres off, with the phone saying it moves: that's what GPS does standing still.
  const answer = await at(10, 2);
  assert.equal(answer.every, 15, 'no need to hear from it so often');
  const wobbled = await look();
  assert.equal(wobbled.driver.lat, parked.driver.lat, 'the rider sees no micro updates');
  assert.equal(wobbled.noShowFrom, parked.noShowFrom);
  assert.equal(points(), stored, 'nothing to store');
  // Further than that, as a car moving up does: not gone yet.
  await at(130, 2);
  const movedUp = await look();
  assert.notEqual(movedUp.driver.lat, parked.driver.lat, 'a real move shows');
  assert.equal(movedUp.noShowFrom, parked.noShowFrom, 'still at the pickup');
  assert.equal(points(), stored + 1);
  assert.equal((await at(131, 0)).every, 15);
  await at(600, 8);
  assert.equal((await look()).noShowFrom, null, 'drove off: the wait starts over');
  await d.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Other' });
  await stopAll(d);
});

test('a driver sees the pickup and the drop-off, never where the rider is', async () => {
  const d = await driver();
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  assert.equal((await d.post(`/api/rides/${made.ride.id}/accept`)).status, 200);
  await pay(r, made.ride.id);
  await d.post('/api/location', NEAR);
  await r.post('/api/location', NEAR);
  const seen = (await d.get(`/api/rides/${made.ride.id}`)).ride;
  assert.equal(seen.rider.lat, undefined);
  assert.equal(seen.rider.lng, undefined);
  assert.equal(seen.apartM, undefined, 'how far apart they are would give it away');
  assert.ok(seen.pickup.lat != null && seen.dropoff.lat != null, 'where to go is there');
  const own = (await r.get(`/api/rides/${made.ride.id}`)).ride;
  assert.ok(own.driver.lat != null, 'the rider still follows the driver');
  assert.ok(own.apartM != null, 'and knows how close the car is');
  await d.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Other' });
  await stopAll(d);
});

test('nearby: the filter goes up to 10 km, drivers on a drive are hidden by default', async () => {
  const d = await driver({ at: { lat: 52.385, lng: 4.9 } });
  const r = await rider();
  const list = (q = '') => r.get(`/api/drivers/nearby?lat=${AMS.lat}&lng=${AMS.lng}${q}`);
  assert.ok((await list()).drivers.some((x) => x.id === d.id));
  assert.ok(!(await list('&radiusKm=0.5')).drivers.some((x) => x.id === d.id), 'radius');
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  await d.post(`/api/rides/${made.ride.id}/accept`);
  assert.ok(!(await list()).drivers.some((x) => x.id === d.id), 'hidden while driving');
  await d.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Other' });
  await d.post('/api/driver/offline');
  assert.ok(!(await list()).drivers.some((x) => x.id === d.id), 'offline drivers are not shown');
});

test('the wallet: USDC and SOL on Solana, addresses are checked, and it shows money on hold', async () => {
  const r = await rider();
  const v = await r.get('/api/wallet');
  assert.deepEqual(v.coins.map((c) => c.id).sort(), ['sol', 'usdc-sol']);
  assert.equal(v.held.length, 0);
  assert.equal((await r.post('/api/wallet/address', { coin: 'xrp', address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' })).code, 'bad_coin');
  assert.equal((await r.post('/api/wallet/address', { coin: 'sol', address: 'nope' })).code, 'bad_address');
  assert.equal((await r.post('/api/wallet/address', { coin: 'sol', address: '' })).code, 'support_only');
  const linked = await r.post('/api/wallet/address', { coin: 'sol', address: r.wallet, via: 'Phantom' });
  assert.equal(linked.coins.find((c) => c.id === 'sol').via, 'Phantom');
  assert.equal((await r.post('/api/wallet/deposit', { coin: 'sol', eurCents: 500 })).status, 404, 'no deposits');
  assert.equal((await r.post('/api/wallet/withdraw', { coin: 'sol' })).status, 404, 'no withdrawals');
  // A paid ride shows as on hold.
  const d = await driver({ at: NEAR });
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'usdc-sol' });
  assert.equal(made.code, 'driver_not_free', 'this driver only takes SOL');
  await d.post('/api/wallet/address', { coin: 'usdc-sol', address: d.wallet });
  const usdc = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'usdc-sol' });
  await d.post(`/api/rides/${usdc.ride.id}/accept`);
  await pay(r, usdc.ride.id);
  const held = (await r.get('/api/wallet')).held;
  assert.equal(held.length, 1);
  assert.equal(held[0].rideId, usdc.ride.id);
  assert.ok(held[0].eurCents > 0);
  await d.post(`/api/rides/${usdc.ride.id}/driver-cancel`, { reason: 'Other' });
  await dev('/dev/money');
  assert.equal((await r.get('/api/wallet')).held.length, 0, 'refunded: nothing on hold');
  await d.post('/api/driver/offline');
});

const HOUR = 3600_000;
const tick = () => dev('/dev/tick');
const keepOnline = async (...cs) => { for (const c of cs) await c.post('/api/location', { ...at40, driving: true }); };
const at40 = { lat: 40.0, lng: 4.9 };

test('an offer nobody answers goes to the next driver, then to the market', async () => {
  const a = await driver({ at: at40, perKm: 90 });
  const b = await driver({ at: at40, perKm: 100 });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, mode: 'auto', coin: 'sol' });
  assert.equal((await a.get('/api/sync?rev=0')).driving.offer.id, made.ride.id, 'cheapest first');
  await dev('/dev/clock?ms=301000');
  await keepOnline(a, b);
  await tick();
  assert.equal((await a.get('/api/sync?rev=0')).driving.offer, null);
  assert.equal((await b.get('/api/sync?rev=0')).driving.offer?.id, made.ride.id, 'then the next');
  await b.post(`/api/rides/${made.ride.id}/decline`);
  assert.equal((await r.get(`/api/rides/${made.ride.id}`)).ride.status, 'open', 'nobody left: the market');
  // Nobody claims it in 2 hours: it ends, nothing was paid.
  await dev(`/dev/clock?ms=${90 * 60_000}`);
  await tick();
  assert.equal((await r.get(`/api/rides/${made.ride.id}`)).ride.status, 'open');
  await dev(`/dev/clock?ms=${31 * 60_000}`);
  await tick();
  assert.equal((await r.get(`/api/rides/${made.ride.id}`)).ride.status, 'cancelled');
  await stopAll(a, b);
});

test('ordering: 5 minutes for the driver, offline without an answer, one order at a time, 5 minutes to pay while the driver sets off', async () => {
  const a = await driver({ at: at40, perKm: 90 });
  const b = await driver({ at: at40, perKm: 100 });
  const c = await driver({ at: at40, perKm: 110 });
  const r = await rider();
  const body = { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, coin: 'sol' };
  const made = await r.post('/api/rides', { ...body, mode: 'auto' });
  const id = made.ride.id;
  // The rider sees the countdown too.
  assert.equal(made.ride.status, 'offered');
  assert.ok(Math.abs(made.ride.offeredUntil - made.ride.now - 5 * 60_000) < 2000, 'five minutes');
  assert.equal(made.ride.refundPercent, 100, 'and can still cancel for free');
  // One order at a time: not now, not with another driver, not planned either.
  assert.equal((await r.post('/api/rides', { ...body, mode: 'auto' })).code, 'has_ride');
  assert.equal((await r.post('/api/rides', { ...body, mode: 'driver', driverId: b.id })).code, 'has_ride');
  const clock = (await dev('/dev/clock?ms=0')).now;
  assert.equal((await r.post('/api/rides', { ...body, mode: 'auto', scheduledAt: clock + 3 * HOUR })).code, 'has_ride');
  // Four minutes on it's still that driver's.
  await dev('/dev/clock?ms=240000');
  await keepOnline(a, b, c);
  await tick();
  assert.equal((await a.get('/api/sync?rev=0')).driving.offer?.id, id);
  // Five: no answer, so offline. It goes to the next driver, who gets a new five minutes.
  await dev('/dev/clock?ms=61000');
  await keepOnline(a, b, c);
  await tick();
  const left = await a.get('/api/sync?rev=0');
  assert.equal(left.driving.offer, null);
  assert.equal(left.driving.online, false, 'put offline');
  assert.equal(left.driving.putOffline, true, 'and told why');
  // Drive mode still on in the app doesn't bring them back.
  assert.equal((await a.post('/api/location', { ...at40, driving: true })).online, false);
  assert.equal((await a.get('/api/driver')).driver.online, false);
  assert.ok(!(await r.get(`/api/drivers/nearby?lat=${at40.lat}&lng=${at40.lng}`)).drivers.some((x) => x.id === a.id), 'riders don’t see them');
  // Going online themselves does.
  const back = await a.post('/api/driver/online', at40);
  assert.equal(back.driver.online, true);
  assert.equal(back.driver.putOffline, false);
  const offered = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal((await b.get('/api/sync?rev=0')).driving.offer?.id, id);
  assert.ok(offered.offeredUntil - offered.now > 4.9 * 60_000);
  // Declining isn't going offline.
  await b.post(`/api/rides/${id}/decline`);
  assert.equal((await b.get('/api/driver')).driver.online, true);
  // Accepted: the rider has 5 minutes, and the driver sees where to go and can set off.
  const accepted = await c.post(`/api/rides/${id}/accept`);
  assert.equal(accepted.ride.status, 'awaiting_payment');
  assert.ok(Math.abs(accepted.ride.payBy - accepted.ride.now - 5 * 60_000) < 2000, 'five minutes');
  const drive = (await c.get('/api/sync?rev=0')).driving.drive;
  assert.equal(drive.pickup.label, 'P');
  assert.equal(drive.dropoff.label, 'D');
  assert.equal((await c.post('/api/location', { lat: 40.03, lng: 4.9, driving: true })).every, 5, 'often, as the rider watches');
  const watching = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(watching.driver.lat, 40.03, 'on the rider’s map');
  assert.ok(watching.driverEtaS != null, 'with how long it takes');
  assert.equal(typeof watching.driverToPickupM, 'number', 'and how far they still are');
  assert.equal(drive.driverToPickupM, undefined, 'only for the rider');
  assert.ok(watching.payUrl);
  assert.equal(watching.refundPercent, 100, 'nothing paid: still free to cancel');
  // Not paid in 5 minutes: the order ends, and everyone is free.
  await dev('/dev/clock?ms=301000');
  await keepOnline(a, b, c);
  await tick();
  const over = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(over.status, 'cancelled');
  assert.equal(over.cancelReason, 'Not paid in time');
  assert.equal((await c.get('/api/sync?rev=0')).driving.drive, null);
  assert.equal((await r.post('/api/rides', { ...body, mode: 'auto' })).status, 200, 'and they can order again');
  const last = (await r.get('/api/rides')).rides.find((x) => x.status !== 'cancelled');
  await r.post(`/api/rides/${last.id}/cancel`);
  await stopAll(a, b, c);
});

test('the refund table: 5 minutes to pay, a late driver until check-in, 10 minutes stopped at the pickup, all back after check-in', async () => {
  const d = await driver({ at: NEAR });
  const r = await rider();
  const outcome = async (id) => (await r.get(`/api/rides/${id}`)).ride.escrow?.outcome ?? null;
  const stay = () => d.post('/api/location', { ...NEAR, driving: true });
  const atPickup = (speed) => d.post('/api/location', { lat: PICK.lat, lng: PICK.lng, driving: true, ...(speed == null ? {} : { speed }) });
  const look = async (id) => (await r.get(`/api/rides/${id}`)).ride;
  const order = async () => {
    await stay();
    const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'auto', coin: 'sol' });
    assert.equal(made.status, 200, JSON.stringify(made));
    return (await d.post(`/api/rides/${made.ride.id}/accept`)).ride;
  };

  // Taking almost the whole 5 minutes to accept doesn't shorten the driver's time: they haven't set off yet.
  await stay();
  const slow = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'auto', coin: 'sol' });
  const wayAtOffer = slow.ride.pickupEtaAt - slow.ride.now;
  await dev('/dev/clock?ms=280000');
  await stay();
  const slowly = (await d.post(`/api/rides/${slow.ride.id}/accept`)).ride;
  assert.ok(Math.abs(slowly.pickupEtaAt - slowly.acceptedAt - wayAtOffer) < 1500, JSON.stringify([slowly.pickupEtaAt - slowly.acceptedAt, wayAtOffer]));
  assert.equal(slowly.refundPercent, undefined, 'the driver doesn\'t see the rider\'s refund');
  assert.equal((await look(slow.ride.id)).refundPercent, 100, 'accepted, not paid: no money involved');
  await r.post(`/api/rides/${slow.ride.id}/cancel`);
  assert.equal(await outcome(slow.ride.id), null, 'no payment made');

  // What it takes, plus 30%, plus the 5 minutes for paying.
  const ride = await order();
  const way = ride.pickupEtaAt - ride.acceptedAt;
  assert.ok(way > 0);
  assert.ok(Math.abs(ride.pickupDeadlineAt - ride.acceptedAt - way * 1.3 - 5 * 60_000) < 1000, JSON.stringify([way, ride.pickupDeadlineAt - ride.acceptedAt]));
  const paid = await pay(r, ride.id);
  assert.equal(paid.status, 'accepted');
  assert.equal(paid.pickupEtaAt, ride.pickupEtaAt, 'paying doesn’t move it: the driver could set off already');
  assert.equal(paid.driverLate, false);
  // Paid: half back from that moment, also within the 5 minutes, and nothing says it's free.
  assert.equal(paid.refundPercent, 50);
  assert.equal(paid.freeCancelUntil, null);
  await r.post(`/api/rides/${ride.id}/cancel`);
  assert.equal(await outcome(ride.id), 'split');
  assert.ok(await payoutOf(d, ride.id), 'half for the driver');

  // After them, on the way and within their time: half. Past their time: late, and all of it.
  const second = await order();
  await pay(r, second.id);
  await dev('/dev/clock?ms=305000');
  await stay();
  const during = await look(second.id);
  assert.equal(during.refundPercent, 50);
  assert.equal(during.driverLate, false);
  await dev(`/dev/clock?ms=${second.pickupDeadlineAt - during.now + 1000}`);
  await stay();
  await tick();
  const late = await look(second.id);
  assert.equal(late.driverLate, true);
  assert.equal(late.refundPercent, 100);
  assert.ok(late.driverEtaS != null);
  assert.ok(late.driver.lat != null, 'the rider can look where they are');
  // Arriving doesn't end it: a full refund until the rider is in the car.
  await atPickup(8);
  const there = await look(second.id);
  assert.equal(there.status, 'arrived');
  assert.equal(there.driverLate, true);
  assert.equal(there.refundPercent, 100);
  assert.equal(there.noShowFrom, null, 'still rolling: their 10 minutes haven\'t started');
  await atPickup(0);
  assert.ok((await look(second.id)).noShowFrom > there.now, 'a full stop starts them');
  await r.post(`/api/rides/${second.id}/cancel`);
  assert.equal(await outcome(second.id), 'refund');
  assert.equal(await payoutOf(d, second.id), undefined);

  // There in time, the rider cancels: half.
  const third = await order();
  await pay(r, third.id);
  await atPickup(0);
  await dev('/dev/clock?ms=400000');
  const onTime = await look(third.id);
  assert.equal(onTime.driverLate, false, 'past their time, but they were there in time');
  assert.equal(onTime.refundPercent, 50);
  await r.post(`/api/rides/${third.id}/cancel`);
  assert.equal(await outcome(third.id), 'split');
  assert.ok(await payoutOf(d, third.id), 'the driver gets half');

  // There before the rider paid: the ride goes on from there, and the 10 minutes start once it's paid.
  const fourth = await order();
  await atPickup(0);
  assert.equal((await look(fourth.id)).status, 'awaiting_payment');
  const paidThere = await pay(r, fourth.id);
  assert.equal(paidThere.status, 'arrived');
  assert.equal(paidThere.noShowFrom, null);
  await atPickup(0);
  const stopped = await look(fourth.id);
  assert.ok(Math.abs(stopped.noShowFrom - stopped.now - 10 * 60_000) < 2000, 'ten minutes');
  // Too early, the driver cancelling refunds everything.
  await dev('/dev/clock?ms=540000');
  await atPickup(0);
  await d.post(`/api/rides/${fourth.id}/driver-cancel`, { reason: 'Rider not there' });
  assert.equal(await outcome(fourth.id), 'refund');

  // After 10 minutes, still there: half.
  const fifth = await order();
  await atPickup(0);
  await pay(r, fifth.id);
  await atPickup(0);
  await dev('/dev/clock?ms=601000');
  await atPickup(0);
  assert.equal((await r.post(`/api/rides/${fifth.id}/check-in`, {})).status !== 200, true);
  await d.post(`/api/rides/${fifth.id}/driver-cancel`, { reason: 'Rider not there' });
  assert.equal(await outcome(fifth.id), 'split');
  assert.ok(await payoutOf(d, fifth.id));

  // Driving off starts the wait over, and a phone without a speed counts as stopped once it hardly moved.
  const sixth = await order();
  await atPickup(0);
  await pay(r, sixth.id);
  await atPickup(0);
  await dev('/dev/clock?ms=900000');
  await stay();
  assert.equal((await look(sixth.id)).noShowFrom, null, 'drove off');
  await atPickup();
  assert.equal((await look(sixth.id)).noShowFrom, null, 'just came back: 400 m since the last position');
  await atPickup();
  const again = await look(sixth.id);
  assert.ok(Math.abs(again.noShowFrom - again.now - 10 * 60_000) < 2000, 'starts over');
  await dev('/dev/clock?ms=601000');
  await stay();
  await d.post(`/api/rides/${sixth.id}/driver-cancel`, { reason: 'Rider not there' });
  assert.equal(await outcome(sixth.id), 'refund', 'not there any more');

  // Only for that reason.
  const seventh = await order();
  await atPickup(0);
  await pay(r, seventh.id);
  await atPickup(0);
  await dev('/dev/clock?ms=601000');
  await atPickup(0);
  await d.post(`/api/rides/${seventh.id}/driver-cancel`, { reason: 'Car trouble' });
  assert.equal(await outcome(seventh.id), 'refund', 'the driver’s own reason');

  // Checked in, the driver cancels: all of it back to the rider, and nothing for the driver.
  const checkedIn = async () => {
    const x = await order();
    await atPickup(0);
    await pay(r, x.id);
    await atPickup(0);
    await r.post('/api/location', AMS);
    const inCar = await r.post(`/api/rides/${x.id}/check-in`, { lat: PICK.lat, lng: PICK.lng, plateChecked: true });
    assert.equal(inCar.ride?.status, 'riding', JSON.stringify(inCar));
    return x.id;
  };
  const eighth = await checkedIn();
  assert.equal((await r.post(`/api/rides/${eighth}/cancel`)).code, 'cant_cancel', 'the rider can\'t any more');
  assert.equal((await d.post(`/api/rides/${eighth}/driver-cancel`, { reason: 'Misbehaviour' })).ride.status, 'cancelled');
  assert.equal(await outcome(eighth), 'refund');
  assert.equal(await payoutOf(d, eighth), undefined, 'nothing for the driver');
  await dev('/dev/money');
  assert.equal((await look(eighth)).escrow.status, 'settled', 'refunded straight away');

  // The driver's half for a rider not there is paid by itself after the 24 hours for an appeal.
  const notThere = async () => {
    const x = await order();
    await atPickup(0);
    await pay(r, x.id);
    await atPickup(0);
    await dev('/dev/clock?ms=601000');
    await atPickup(0);
    assert.equal((await d.post(`/api/rides/${x.id}/driver-cancel`, { reason: 'Rider not there' })).ride.status, 'cancelled');
    return x.id;
  };
  const ninth = await notThere();
  assert.equal(await outcome(ninth), 'split');
  assert.equal((await payoutOf(d, ninth)).status, 'held');
  await dev('/dev/money');
  assert.equal((await look(ninth)).escrow.status, 'paid', 'it waits 24 hours for an appeal');
  await dev(`/dev/clock?ms=${24 * HOUR + 1000}`);
  await dev('/dev/money');
  assert.equal((await look(ninth)).escrow.status, 'settled');

  // An appeal freezes it for a manual review. Nobody decides within 30 days: all of it back to the rider.
  const tenth = await notThere();
  assert.equal((await r.post(`/api/rides/${tenth}/appeal`, { message: 'I was at the other entrance the whole time' })).status, 200);
  await dev(`/dev/clock?ms=${25 * HOUR}`);
  await dev('/dev/money');
  const frozen = await look(tenth);
  assert.equal(frozen.escrow.status, 'paid', 'frozen');
  assert.equal(frozen.dispute.status, 'open');
  await dev(`/dev/clock?ms=${30 * 24 * HOUR}`);
  await dev('/dev/money');
  const refunded = await look(tenth);
  assert.equal(refunded.escrow.status, 'settled');
  assert.equal(refunded.escrow.outcome, 'expired');
  assert.equal((await payoutOf(d, tenth)).status, 'cancelled', 'nothing for the driver');
  await d.post('/api/driver/offline');
});

test('a vehicle needs its photos before it can drive; riders see how often a driver finishes and is on time', async () => {
  const d = client(srv.base);
  await d.start();
  await d.post('/api/driver/enable');
  const car = (await d.post('/api/cars', { plate: 'PH123X', make: 'Toyota', model: 'Yaris', seats: 4, perKmCents: 90, perMinCents: 20, pickupPerKmCents: 50 })).car;
  await d.post('/api/wallet/address', { coin: 'sol', address: newWallet() });
  assert.deepEqual(car.photosMissing, ['front', 'back', 'inside']);
  const refused = await d.post('/api/driver/online', NEAR);
  assert.equal(refused.code, 'need_photos');
  assert.deepEqual(refused.missing, ['front', 'back', 'inside']);
  await photo(d, car.id, 'outside');
  assert.equal((await d.post('/api/driver/online', NEAR)).code, 'need_photos', 'any old photo isn\'t enough');
  await photo(d, car.id, 'front');
  await photo(d, car.id, 'back');
  assert.deepEqual((await d.get('/api/driver')).driver.cars[0].photosMissing, ['inside']);
  assert.equal((await d.post('/api/driver/online', NEAR)).code, 'need_photos');
  await photo(d, car.id, 'inside');
  const again = await photo(d, car.id, 'inside');
  assert.equal(again.car.photos.filter((p) => p.kind === 'inside').length, 1, 'a new one replaces the old');
  assert.deepEqual(again.car.photosMissing, []);
  assert.equal((await d.post('/api/driver/online', NEAR)).driver.online, true);
  // Online, the required ones stay.
  assert.equal((await d.del(`/api/car-photos/${again.car.photos.find((p) => p.kind === 'front').id}`)).code, 'needed_online');
  // Scores: nothing yet, then a finished ride on time, a driver's cancel, a late one, and a rider's cancel that doesn't count.
  const r = await rider();
  assert.equal((await r.get(`/api/drivers/${d.id}`)).driver.completedPercent, null);
  const order = async () => {
    await d.post('/api/location', { ...NEAR, driving: true });
    const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
    assert.equal(made.status, 200, JSON.stringify(made));
    await d.post(`/api/rides/${made.ride.id}/accept`);
    return made.ride.id;
  };
  const stopAt = (p) => d.post('/api/location', { lat: p.lat, lng: p.lng, driving: true, speed: 0 });
  const done = await order();
  await pay(r, done);
  await stopAt(PICK);
  await r.post(`/api/rides/${done}/check-in`, { lat: PICK.lat, lng: PICK.lng, plateChecked: true });
  await stopAt(DROP);
  await r.post('/api/location', DROP);
  await d.post(`/api/rides/${done}/check-out`, { lat: DROP.lat, lng: DROP.lng });
  let shown = (await r.get(`/api/drivers/${d.id}`)).driver;
  assert.equal(shown.completedPercent, 100);
  assert.equal(shown.ridesDone, 1);
  assert.equal(shown.arrivalScore, 100);
  const dropped = await order();
  await pay(r, dropped);
  await d.post(`/api/rides/${dropped}/driver-cancel`, { reason: 'Car trouble' });
  shown = (await r.get(`/api/drivers/${d.id}`)).driver;
  assert.equal(shown.completedPercent, 50, 'one of two');
  const riderCancels = await order();
  await pay(r, riderCancels);
  await r.post(`/api/rides/${riderCancels}/cancel`);
  assert.equal((await r.get(`/api/drivers/${d.id}`)).driver.completedPercent, 50, 'a rider cancelling isn\'t the driver\'s doing');
  const tooLate = await order();
  const lateRide = await pay(r, tooLate);
  await dev(`/dev/clock?ms=${lateRide.pickupDeadlineAt - lateRide.now + 1000}`);
  await r.post('/api/location', AMS);
  await r.post(`/api/rides/${tooLate}/cancel`);
  assert.equal((await r.get(`/api/drivers/${d.id}`)).driver.arrivalScore, 50, 'one of two on time: this one wasn\'t');
  // A review shows on the profile.
  assert.equal((await r.post(`/api/rides/${done}/review`, { stars: 4, text: 'Nice and quiet' })).status, 200);
  const profile = await r.get(`/api/drivers/${d.id}`);
  assert.equal(profile.reviews[0].text, 'Nice and quiet');
  assert.equal(profile.driver.rating, 4);
  await d.post('/api/driver/offline');
});

test('strikes and bans stay with the phone, whichever account is on it, and the admin sees that', async () => {
  const a = client(srv.base);
  await a.start();
  const strike = (u, reason = 'Testing') => admin.post(`/admin/api/users/${u.id}/strike`, { reason });
  assert.equal((await strike(a)).status, 200);
  assert.ok((await a.get('/api/me')).standing.ban);
  // Banned: the account can't be deleted, the record of the phone has to stay.
  assert.equal((await a.del('/api/me')).code, 'banned');
  // Another account logging in on that phone is banned too, and the panel says so.
  const email = `other${crypto.randomBytes(4).toString('hex')}@test.local`;
  const other = client(srv.base);
  await other.start();
  assert.equal((await other.post('/api/auth/register', { email, password: 'long-enough-pass-1' })).status, 200);
  const onPhone = client(srv.base, a.deviceId);
  const login = await onPhone.post('/api/auth/login', { email, password: 'long-enough-pass-1', deviceId: a.deviceId });
  assert.equal(login.status, 200, JSON.stringify(login));
  assert.ok(login.standing.ban, 'banned on this phone');
  const seen = await admin.get(`/admin/api/users/${other.id}`);
  assert.equal(seen.user.ban.viaPhone, true);
  assert.ok(seen.devices.some((d) => d.banned), 'that phone is marked');
  assert.ok((await admin.get('/admin/api/users?filter=banned')).users.some((u) => u.id === other.id));
  assert.equal(seen.user.strikes, 1, 'the phone’s strike counts here too');
  // Lifting it from either account frees the phone, and takes the strike back.
  assert.equal((await admin.post(`/admin/api/users/${other.id}/unban`, { why: 'Mistake' })).status, 200);
  assert.equal((await a.get('/api/me')).standing.ban, null);
  assert.equal((await a.get('/api/me')).standing.strikes, 0);
  // A strike whose week is over: deleting the account doesn't wipe it, the phone keeps counting.
  await strike(a);
  await dev(`/dev/clock?ms=${8 * 24 * HOUR}`);
  assert.equal((await a.get('/api/me')).standing.ban, null, 'the week is over');
  assert.equal((await a.del('/api/me')).status, 200);
  const again = client(srv.base, a.deviceId);
  const fresh = await again.start();
  assert.notEqual(fresh.user.id, a.id, 'a new account');
  assert.equal(fresh.standing.strikes, 1, 'with the phone’s strike');
  // Two more and it's for good.
  await strike(again);
  await dev(`/dev/clock?ms=${8 * 24 * HOUR}`);
  const third = await strike(again);
  assert.equal(third.strikes, 3, JSON.stringify(third));
  const ban = (await again.get('/api/me')).standing.ban;
  assert.equal(ban.kind, 'permanent');
  assert.equal(ban.endsAt, null);
});

test('a driver who stops reporting goes offline by themselves after 3 minutes', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const near = async () => (await r.get(`/api/drivers/nearby?lat=${at40.lat}&lng=${at40.lng}`)).drivers.some((x) => x.id === d.id);
  assert.equal(await near(), true);
  await dev('/dev/clock?ms=200000');
  assert.equal(await near(), false, 'hidden at once');
  await tick();
  assert.equal((await d.get('/api/driver')).driver.online, false);
  // Its phone reporting in Drive mode puts it straight back.
  await d.post('/api/location', { ...at40, driving: true });
  assert.equal(await near(), true, 'reconnected by itself');
  await d.post('/api/driver/offline');
});

test('a planned drive: reminder, start, and a driver who doesn’t show loses it to the market', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const clock = (await dev('/dev/clock?ms=0')).now;
  const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol', scheduledAt: clock + 2 * HOUR });
  assert.equal(made.ride.status, 'open');
  assert.equal((await d.post(`/api/rides/${made.ride.id}/claim`)).ride.status, 'awaiting_payment');
  assert.equal((await pay(r, made.ride.id)).status, 'scheduled');
  await tick();
  assert.equal((await r.get(`/api/rides/${made.ride.id}`)).ride.status, 'scheduled', 'too early to start');
  assert.equal((await d.get('/api/driver/home')).planned[0].id, made.ride.id);
  // On the driver's map as theirs, planned and paid.
  const booked = (await d.get(`/api/driver/market?lat=${at40.lat}&lng=${at40.lng}`)).booked;
  assert.equal(booked.find((x) => x.id === made.ride.id)?.status, 'scheduled');
  await dev(`/dev/clock?ms=${2 * HOUR - 15 * 60_000}`);
  await d.post('/api/location', { ...at40, driving: true });
  await tick();
  assert.equal((await r.get(`/api/rides/${made.ride.id}`)).ride.status, 'accepted', '20 minutes before, the drive starts');
  assert.equal((await d.get('/api/sync?rev=0')).driving.drive.id, made.ride.id);
  await d.post('/api/driver/offline');
  await dev(`/dev/clock?ms=${26 * 60_000}`);
  await tick();
  const passed = (await r.get(`/api/rides/${made.ride.id}`)).ride;
  assert.equal(passed.status, 'cancelled', 'not there and offline: the escrow only pays that driver, so it’s refunded');
  assert.equal(passed.escrow.outcome, 'refund');
});

test('a planned order waits for a driver: no wallet to order, and nothing to pay until one claims it', async () => {
  const at = { lat: 41.0, lng: 4.9 };
  const clock = (await dev('/dev/clock?ms=0')).now;
  const chosen = await driver({ at, perKm: 100 });
  const other = await driver({ at: { lat: 41.002, lng: 4.9 }, perKm: 100 });
  const market = (d, from = at) => d.get(`/api/driver/market?lat=${from.lat}&lng=${from.lng}&radiusKm=10`).then((m) => m.orders);
  const seen = async (d, id, from) => (await market(d, from)).find((o) => o.id === id);
  const r = await rider();
  const ride = { pickup: { ...at, label: 'P' }, dropoff: { lat: 41.0, lng: 4.95, label: 'D' }, passengers: 1, coin: 'sol' };

  // No wallet connected, and ordering doesn't ask for one.
  assert.ok((await r.get('/api/wallet')).coins.every((c) => c.address === null));
  const made = await r.post('/api/rides', { ...ride, mode: 'driver', driverId: chosen.id, scheduledAt: clock + 3 * HOUR });
  assert.equal(made.status, 200, JSON.stringify(made));
  const id = made.ride.id;
  assert.equal(made.ride.status, 'open');
  assert.equal(made.ride.driver, undefined);
  assert.equal(made.ride.payBy, undefined);
  assert.equal(made.ride.payUrl, undefined);
  assert.equal(made.ride.refundPercent, 100);
  assert.equal((await r.post(`/api/rides/${id}/pay`, { account: r.wallet })).code, 'not_waiting', 'not before a driver has it');
  assert.equal((await r.get('/api/sync?rev=0')).toPay, undefined);

  // The driver the rider chose has it to themselves, wherever they are; for anyone else it isn't there yet.
  assert.equal((await seen(chosen, id)).forYou, true);
  assert.equal((await seen(chosen, id, { lat: 41.3, lng: 4.9 })).forYou, true, 'further than their own range');
  assert.equal(await seen(other, id), undefined);
  assert.equal((await other.post(`/api/rides/${id}/claim`)).code, 'order_gone');

  // They don't answer: no penalty, and now any driver can claim it. Still nothing to pay.
  await dev(`/dev/clock?ms=${31 * 60_000}`);
  await tick();
  assert.equal((await r.get(`/api/rides/${id}`)).ride.status, 'open');
  assert.equal((await seen(chosen, id)).forYou, false);
  assert.equal((await seen(other, id)).forYou, false);
  assert.equal((await chosen.get('/api/sync?rev=0')).driving.putOffline, false);

  // A driver claims it: only now the rider is asked to pay, from a wallet picked right then.
  const claimed = await other.post(`/api/rides/${id}/claim`);
  assert.equal(claimed.ride.status, 'awaiting_payment', JSON.stringify(claimed));
  assert.equal((await chosen.post(`/api/rides/${id}/claim`)).code, 'order_gone', 'one driver');
  const asked = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(asked.driver.id, other.id);
  assert.equal(asked.testPay, true, 'this test server has no chain');
  assert.equal(claimed.ride.testPay, undefined, 'it’s the rider who pays');
  assert.equal(asked.payBy, asked.scheduledAt - 30 * 60_000);
  assert.ok(asked.payUrl);
  assert.equal((await r.get('/api/sync?rev=0')).toPay.id, id);
  assert.equal((await pay(r, id)).status, 'scheduled');
  assert.equal((await r.get('/api/sync?rev=0')).toPay, undefined, 'paid: nothing more to ask');
  await r.post(`/api/rides/${id}/cancel`);

  // Not choosing anyone: on the market straight away, for any driver.
  const auto = await r.post('/api/rides', { ...ride, mode: 'auto', scheduledAt: (await dev('/dev/clock?ms=0')).now + 3 * HOUR });
  assert.equal(auto.ride.status, 'open', JSON.stringify(auto));
  assert.equal((await seen(chosen, auto.ride.id)).forYou, false);
  assert.equal((await seen(other, auto.ride.id)).forYou, false);
  await r.post(`/api/rides/${auto.ride.id}/cancel`);

  // Soon: the chosen driver gets half the time that's left, so others still have time to claim it.
  const nowish = (await dev('/dev/clock?ms=0')).now;
  const soon = await r.post('/api/rides', { ...ride, mode: 'driver', driverId: chosen.id, scheduledAt: nowish + 40 * 60_000 });
  assert.equal(soon.status, 200, JSON.stringify(soon));
  assert.ok(soon.ride.offeredUntil <= nowish + 20 * 60_000 + 5000, 'half of 40 minutes');
  await r.post(`/api/rides/${soon.ride.id}/cancel`);
  await stopAll(chosen, other);
});

test('the wallet says what goes out, what comes back and why, per wallet, and when', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const ride = { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' };
  const paidRide = async () => {
    const made = await r.post('/api/rides', ride);
    assert.equal(made.status, 200, JSON.stringify(made));
    await d.post(`/api/rides/${made.ride.id}/accept`);
    await pay(r, made.ride.id);
    return made.ride.id;
  };
  const moves = async (who, id) => (await who.get('/api/wallet')).moves.filter((m) => m.rideId === id);

  // Paid and on its way: all of it is going out, and nobody knows when yet.
  const split = await paidRide();
  const out = await moves(r, split);
  assert.equal(out.length, 1);
  assert.equal(out[0].direction, 'out');
  assert.equal(out[0].reason, 'ride');
  assert.equal(out[0].pending, true);
  assert.equal(out[0].when, null);
  assert.equal(out[0].to, 'D');

  // The rider cancels: half out and half back to the wallet that paid, with a time, and the driver sees their half coming.
  await r.post(`/api/rides/${split}/cancel`);
  const both = await moves(r, split);
  const back = both.find((m) => m.direction === 'in');
  const half = both.find((m) => m.direction === 'out');
  assert.equal(back.reason, 'half');
  assert.equal(half.reason, 'half');
  assert.equal(back.wallet, r.wallet);
  assert.ok(back.when > Date.now() - 86_400_000, 'a time for the timer');
  assert.ok(Math.abs(Number(back.amount) - Number(half.amount)) < 0.00000001 * 2);
  assert.ok(Math.abs(back.eurCents + half.eurCents - out[0].eurCents) <= 1, 'the two parts add up');
  const driverSide = await moves(d, split);
  assert.equal(driverSide.length, 1);
  assert.equal(driverSide[0].direction, 'in');
  assert.equal(driverSide[0].reason, 'driveHalf');
  assert.equal(driverSide[0].wallet, d.wallet);
  assert.equal(driverSide[0].pending, true);

  // The driver cancels: everything comes back, as a refund, and once settled it's history. The driver gets nothing.
  const refund = await paidRide();
  await d.post(`/api/rides/${refund}/driver-cancel`, { reason: 'Other' });
  const refunded = await moves(r, refund);
  assert.equal(refunded.length, 1);
  assert.equal(refunded[0].direction, 'in');
  assert.equal(refunded[0].reason, 'refund');
  await dev('/dev/money');
  assert.equal((await moves(r, refund))[0].pending, false);
  assert.deepEqual(await moves(d, refund), []);

  // A finished ride: the driver's pay is for driving, and it goes to their connected wallet.
  const done = await finishedRide(d, r);
  const pay2 = (await moves(d, done.id ?? done))[0];
  assert.equal(pay2.reason, 'drive');
  assert.equal(pay2.direction, 'in');
  assert.equal(pay2.wallet, d.wallet);
  assert.ok(pay2.when, 'when it clears');
  await d.post('/api/driver/offline');
});

test('a report about an impossible drop-off brings the ride, its planned route and both phones to the admin panel', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const id = await finishedRide(d, r);
  assert.equal((await d.post('/api/reports', { userId: r.id, reason: 'Impossible drop-off location', rideId: id })).status, 200);
  const report = (await admin.get('/admin/api/reports')).reports.find((x) => x.ride_id === id);
  assert.equal(report.reason, 'Impossible drop-off location');
  assert.equal(report.target_id, r.id);
  const { map } = await admin.get(`/admin/api/rides/${id}`);
  assert.equal(map.dropoff.lng, 4.92);
  assert.ok(Array.isArray(map.route));
  assert.ok(map.driver.length > 3 && map.rider.length > 3, 'both phones can be played back');
  assert.ok(map.driver[0].at <= map.driver.at(-1).at, 'in order of time');

  // A stranger can't report on someone else's ride.
  const stranger = await rider();
  assert.equal((await stranger.post('/api/reports', { userId: r.id, reason: 'Impossible drop-off location', rideId: id })).status, 404);
  await d.post('/api/driver/offline');
});

test('with no chain, the rider’s pay button counts as paying, but only theirs and only when it’s waiting', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  const id = made.ride.id;
  assert.equal((await r.post(`/api/rides/${id}/pretend-pay`)).code, 'not_waiting', 'not before a driver has it');
  await d.post(`/api/rides/${id}/accept`);
  assert.equal((await (await rider()).post(`/api/rides/${id}/pretend-pay`)).status, 404);
  const paid = await r.post(`/api/rides/${id}/pretend-pay`);
  assert.equal(paid.ride.status, 'accepted', JSON.stringify(paid));
  assert.equal(paid.ride.escrow.status, 'paid');
  await r.post(`/api/rides/${id}/cancel`);
  await d.post('/api/driver/offline');
});

test('a planned order nobody claims ends at its time; nothing was paid', async () => {
  const r = await rider();
  const clock = (await dev('/dev/clock?ms=0')).now;
  const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, mode: 'bid', bidCents: 900, coin: 'sol', scheduledAt: clock + HOUR });
  await dev(`/dev/clock?ms=${HOUR - 60_000}`);
  await tick();
  assert.equal((await r.get(`/api/rides/${made.ride.id}`)).ride.status, 'open', 'still on the market until its time');
  await dev(`/dev/clock?ms=${2 * 60_000}`);
  await tick();
  const over = (await r.get(`/api/rides/${made.ride.id}`)).ride;
  assert.equal(over.status, 'cancelled');
  assert.equal(over.escrow, undefined);
});

async function finishedRide(d, r, coin = 'sol') {
  const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, mode: 'driver', driverId: d.id, coin });
  assert.equal(made.status, 200, JSON.stringify(made));
  const id = made.ride.id;
  await d.post(`/api/rides/${id}/accept`);
  await pay(r, id);
  await d.post('/api/location', { ...at40, driving: true });
  await r.post('/api/location', at40);
  await r.post(`/api/rides/${id}/check-in`, { ...at40, plateChecked: true });
  const end = { lat: 40.0, lng: 4.9199 };
  for (const lng of [4.903, 4.906, 4.909, 4.912, 4.915, 4.918, 4.9199]) {
    await d.post('/api/location', { lat: 40.0, lng, driving: true });
    await r.post('/api/location', { lat: 40.0, lng });
  }
  const done = await d.post(`/api/rides/${id}/check-out`, end);
  assert.equal(done.ride.status, 'completed', JSON.stringify(done));
  return id;
}
const payoutOf = async (c, id) => (await c.get(`/api/rides/${id}`)).ride.payout;

test('the payout waits 24 hours, and a rider’s appeal holds it until an admin decides, or it’s refunded after 30 days', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const plain = await finishedRide(d, r);
  await dev(`/dev/clock?ms=${23 * HOUR}`);
  await tick();
  assert.equal((await payoutOf(d, plain)).status, 'held', 'not before 24 hours');
  await dev(`/dev/clock?ms=${2 * HOUR}`);
  await tick();
  assert.equal((await payoutOf(d, plain)).status, 'confirmed', 'due: the escrow paid out');
  // The rider can't appeal once it's gone.
  assert.equal((await r.post(`/api/rides/${plain}/appeal`, { message: 'Too late now' })).code, 'paid_out');

  await d.post('/api/location', { ...at40, driving: true });
  const appealed = await finishedRide(d, r);
  assert.equal((await r.post(`/api/rides/${appealed}/appeal`, { message: 'The driver was rude' })).status, 200);
  await dev(`/dev/clock?ms=${25 * HOUR}`);
  await tick();
  assert.equal((await payoutOf(d, appealed)).status, 'held', 'an appeal holds it');
  await dev(`/dev/clock?ms=${72 * HOUR}`);
  await tick();
  assert.equal((await payoutOf(d, appealed)).status, 'held', 'also days later, however well they rode together');
  assert.equal((await r.get(`/api/rides/${appealed}`)).ride.dispute.status, 'open');
  await dev(`/dev/clock?ms=${30 * 24 * HOUR}`);
  await tick();
  const expired = (await r.get(`/api/rides/${appealed}`)).ride;
  assert.equal(expired.escrow.outcome, 'expired', 'nobody decided in 30 days: everything goes back');
  assert.equal((await payoutOf(d, appealed)).status, 'cancelled');
  await d.post('/api/driver/offline');
});

test('the admin can step in on any paid ride: hold it, or refund, split or pay it out right now', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const stranger = client(srv.base);
  assert.equal((await stranger.post('/admin/api/rides/x/hold', {})).status, 401, 'only an admin');
  const state = async (id) => (await r.get(`/api/rides/${id}`)).ride;
  // Held: nothing goes out when it comes due, and both are told it's being checked, until it's released.
  const held = await finishedRide(d, r);
  assert.equal((await admin.post(`/admin/api/rides/${held}/hold`, {})).ok, true);
  assert.equal((await state(held)).escrow.onHold, true);
  assert.equal((await r.get('/api/wallet')).held.find((h) => h.rideId === held).onHold, true);
  assert.equal((await d.get('/api/wallet')).payouts.find((p) => p.rideId === held).onHold, true);
  await dev(`/dev/clock?ms=${25 * HOUR}`);
  await tick();
  assert.equal((await state(held)).escrow.status, 'paid', 'held past the 24 hours');
  assert.equal((await payoutOf(d, held)).status, 'held');
  assert.equal((await admin.post(`/admin/api/rides/${held}/hold`, { hold: false })).ok, true);
  await tick();
  assert.equal((await state(held)).escrow.outcome, 'payout', 'released: it goes on as planned');
  assert.equal((await state(held)).escrow.status, 'settled');
  assert.equal((await admin.post(`/admin/api/rides/${held}/hold`, {})).code, 'settled', 'too late once it has gone out');
  assert.equal((await admin.post(`/admin/api/rides/${held}/decide`, { decision: 'refund_rider' })).code, 'settled');
  // Pay out now, before the 24 hours.
  await d.post('/api/location', { ...at40, driving: true });
  const early = await finishedRide(d, r);
  assert.equal((await admin.post(`/admin/api/rides/${early}/decide`, { decision: 'nonsense' })).code, 'bad_decision');
  assert.equal((await admin.post(`/admin/api/rides/${early}/decide`, { decision: 'pay_driver' })).ok, true);
  await tick();
  assert.equal((await state(early)).escrow.outcome, 'payout');
  assert.equal((await payoutOf(d, early)).status, 'confirmed');
  // Refund a finished ride: the driver's payout goes, also when it was on hold.
  await d.post('/api/location', { ...at40, driving: true });
  const refunded = await finishedRide(d, r);
  await admin.post(`/admin/api/rides/${refunded}/hold`, {});
  assert.equal((await admin.post(`/admin/api/rides/${refunded}/decide`, { decision: 'refund_rider', answer: 'Not driven' })).ok, true);
  await tick();
  assert.equal((await state(refunded)).escrow.outcome, 'refund');
  assert.equal((await state(refunded)).escrow.onHold, false);
  assert.equal((await payoutOf(d, refunded)).status, 'cancelled');
  // A ride still under way ends there, and an appeal on a ride is closed with the decision.
  await d.post('/api/location', { ...at40, driving: true });
  await r.post('/api/location', at40);
  const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
  await d.post(`/api/rides/${made.ride.id}/accept`);
  assert.equal((await admin.post(`/admin/api/rides/${made.ride.id}/hold`, {})).code, 'not_paid', 'nothing to hold before it is paid');
  await pay(r, made.ride.id);
  assert.equal((await admin.post(`/admin/api/rides/${made.ride.id}/decide`, { decision: 'split' })).ok, true);
  const ended = await state(made.ride.id);
  assert.equal(ended.status, 'cancelled');
  await tick();
  assert.equal((await state(made.ride.id)).escrow.outcome, 'split', 'split now, not in 24 hours');
  await d.post('/api/location', { ...at40, driving: true });
  const appealed = await finishedRide(d, r);
  await r.post(`/api/rides/${appealed}/appeal`, { message: 'Something went wrong here' });
  assert.equal((await admin.post(`/admin/api/rides/${appealed}/decide`, { decision: 'split' })).ok, true);
  assert.equal((await r.get(`/api/rides/${appealed}`)).ride.dispute.status, 'split');
  // A hold doesn't stop the refund after 30 days.
  await d.post('/api/location', { ...at40, driving: true });
  const forgotten = await finishedRide(d, r);
  await admin.post(`/admin/api/rides/${forgotten}/hold`, {});
  await dev(`/dev/clock?ms=${31 * 24 * HOUR}`);
  await tick();
  assert.equal((await state(forgotten)).escrow.outcome, 'expired');
  assert.equal((await state(forgotten)).escrow.status, 'settled');
  await d.post('/api/driver/offline');
});

test('a driver who never checks out isn’t paid, unless their appeal shows most of the way was driven', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const ride = async () => {
    const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: { lat: 40.0, lng: 4.92, label: 'D' }, passengers: 1, mode: 'driver', driverId: d.id, coin: 'sol' });
    await d.post(`/api/rides/${made.ride.id}/accept`);
    await pay(r, made.ride.id);
    await d.post('/api/location', { ...at40, driving: true });
    await r.post('/api/location', at40);
    await r.post(`/api/rides/${made.ride.id}/check-in`, { ...at40, plateChecked: true });
    return made.ride.id;
  };
  // No check-out a day after the ride should have ended: refunded.
  const stuck = await ride();
  await dev(`/dev/clock?ms=${25 * HOUR}`);
  await tick();
  assert.equal((await r.get(`/api/rides/${stuck}`)).ride.escrow.outcome, 'refund');
  // The same, but the driver appeals after driving 3/4 of the way: after 3 days with no admin, they're paid.
  await d.post('/api/location', { ...at40, driving: true });
  const appealed = await ride();
  for (const lng of [4.905, 4.91, 4.915]) await d.post('/api/location', { lat: 40.0, lng, driving: true });
  assert.equal((await d.post(`/api/rides/${appealed}/appeal`, { message: 'The rider left before the drop-off' })).code, 'not_now', 'not before the ride should be over');
  await dev(`/dev/clock?ms=${HOUR}`);
  assert.equal((await d.post(`/api/rides/${appealed}/appeal`, { message: 'The rider left before the drop-off' })).status, 200);
  await dev(`/dev/clock?ms=${25 * HOUR}`);
  await tick();
  assert.equal((await r.get(`/api/rides/${appealed}`)).ride.status, 'riding', 'an admin decides');
  await dev(`/dev/clock?ms=${3 * 24 * HOUR}`);
  await tick();
  const paidDriver = (await r.get(`/api/rides/${appealed}`)).ride;
  assert.equal(paidDriver.status, 'completed');
  assert.equal(paidDriver.escrow.outcome, 'payout');
  await d.post('/api/driver/offline');
});

// ---------- App Store: safety and the review account ----------

test('report and block: a blocked driver is gone for both, and nothing bad can be written', async () => {
  const at = { lat: 39.0, lng: 4.9 };
  const d = await driver({ at });
  const r = await rider();
  const ride = { pickup: { ...at, label: 'P' }, dropoff: { lat: 39.0, lng: 4.92, label: 'D' }, passengers: 1, coin: 'sol' };
  const seen = async () => (await r.post('/api/quote', ride)).offers.some((o) => o.id === d.id);
  assert.equal(await seen(), true);
  assert.equal((await r.post('/api/reports', { userId: d.id, reason: 'Unsafe driving', message: 'Too fast' })).status, 200);
  const open = await admin.get('/admin/api/reports');
  assert.equal(open.reports.find((x) => x.target_id === d.id).reason, 'Unsafe driving');
  assert.ok((await admin.get('/admin/api/overview')).reportsOpen >= 1);
  assert.equal((await r.post('/api/blocks', { userId: d.id })).status, 200);
  assert.equal(await seen(), false, 'the rider no longer sees them');
  assert.equal((await r.get(`/api/drivers/${d.id}`)).status, 404);
  assert.equal((await r.get('/api/blocks')).blocks[0].id, d.id);
  // The driver can't see or take this rider's orders either.
  const bid = await r.post('/api/rides', { ...ride, mode: 'bid', bidCents: 800 });
  assert.ok(!(await d.get(`/api/driver/market?lat=${at.lat}&lng=${at.lng}`)).orders.some((o) => o.id === bid.ride.id));
  assert.equal((await d.post(`/api/rides/${bid.ride.id}/claim`)).code, 'order_gone');
  await r.post(`/api/rides/${bid.ride.id}/cancel`);
  await r.del(`/api/blocks/${d.id}`);
  assert.equal(await seen(), true, 'unblocking brings them back');
  // The filter.
  assert.equal((await r.patch('/api/me', { name: 'Sam from Scunthorpe' })).status, 200, 'only whole words count');
  assert.equal((await r.patch('/api/me', { name: 'k4nker lijer' })).code, 'not_allowed', 'look-alikes count');
  assert.equal((await d.patch('/api/driver', { bio: 'you are a f4ggot' })).code, 'not_allowed');
  assert.equal((await d.post('/api/cars', { plate: 'BAD123', make: 'cunt', model: 'x', seats: 4 })).code, 'not_allowed');
  // The support form, without an account.
  const anon = client(srv.base);
  assert.equal((await anon.post('/api/support', { email: 'a@example.com', topic: 'Other', message: 'Hello there' })).status, 200);
  assert.equal((await anon.post('/api/support', { email: 'nope', message: 'Hello there' })).code, 'bad_email');
  assert.ok((await admin.get('/admin/api/support')).requests.some((x) => x.email === 'a@example.com'));
  await d.post('/api/driver/offline');
});

test('the review account: simulated drivers near it, a ride that plays out, no real money, and real people never mix in', async () => {
  const at = { lat: 37.33, lng: -122.03 }; // Cupertino: nobody real here
  const c = client(srv.base);
  await c.start();
  await dev(`/dev/make-demo?id=${c.id}`);
  const real = await rider();
  await real.post('/api/location', at);
  await c.post('/api/location', at);
  const near = await c.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}`);
  assert.equal(near.drivers.length, 3, 'three simulated drivers');
  assert.ok(near.drivers.every((d) => d.id.startsWith('demo-')));
  assert.equal((await real.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}`)).drivers.length, 0, 'a real person sees none of them');
  // Nothing to pay: a demo ride never touches the chain.
  assert.equal((await c.post('/api/wallet/address', { coin: 'sol', address: newWallet() })).status, 200);
  const view = await c.get('/api/wallet');
  assert.equal(view.demo, true);
  // A ride plays out.
  const pickup = { ...at, label: 'P' };
  const made = await c.post('/api/rides', { pickup, dropoff: { lat: 37.34, lng: -122.02, label: 'D' }, passengers: 1, mode: 'auto', coin: 'sol' });
  assert.equal(made.ride.status, 'offered');
  const id = made.ride.id;
  const status = async () => (await c.get(`/api/rides/${id}`)).ride;
  await dev('/dev/clock?ms=4000');
  await tick();
  assert.equal((await status()).status, 'accepted');
  for (let i = 0; i < 30 && (await status()).status === 'accepted'; i++) { await dev('/dev/clock?ms=3000'); await c.post('/api/location', at); await tick(); }
  assert.equal((await status()).status, 'arrived');
  assert.equal((await status()).canCheckIn, true);
  assert.equal((await c.post(`/api/rides/${id}/check-in`, { ...at, plateChecked: true })).ride.status, 'riding');
  await dev('/dev/clock?ms=20000');
  await c.post('/api/location', at);
  await tick();
  assert.equal((await status()).status, 'riding', 'still on the way');
  await dev('/dev/clock?ms=21000');
  await tick();
  const over = await status();
  assert.equal(over.status, 'completed');
  assert.equal(over.payout.status, 'demo');
  assert.equal(over.safetyAsked, undefined);
  // Nothing about it ever goes out.
  await dev(`/dev/clock?ms=${25 * HOUR}`);
  await c.post('/api/location', at);
  await tick();
  assert.equal((await status()).payout.status, 'demo', 'never sent');
  // As a driver: orders and an offer come to it, no wallet needed, and check-out works from anywhere.
  await c.post('/api/driver/enable');
  await c.post('/api/cars', { plate: 'REVIEW1', make: 'Demo', model: 'Car', seats: 4 });
  await c.patch('/api/driver', { allowsPlanning: true });
  assert.equal((await c.post('/api/driver/online', at)).driver.online, true);
  await tick();
  const market = await c.get(`/api/driver/market?lat=${at.lat}&lng=${at.lng}`);
  assert.ok(market.orders.some((o) => o.kind === 'now') && market.orders.some((o) => o.kind === 'planned'), 'green and red pins');
  assert.equal((await real.get('/api/sync?rev=0')).driving, undefined);
  const offer = (await c.get('/api/sync?rev=0')).driving.offer;
  assert.ok(offer, 'an offer with its countdown');
  const taken = await c.post(`/api/rides/${offer.id}/accept`);
  assert.equal(taken.ride.status, 'accepted');
  await dev('/dev/clock?ms=9000');
  await c.post('/api/location', { ...at, driving: true });
  await tick();
  assert.equal((await c.get(`/api/rides/${offer.id}`)).ride.status, 'arrived');
  await dev('/dev/clock?ms=7000');
  await c.post('/api/location', { ...at, driving: true });
  await tick();
  assert.equal((await c.get(`/api/rides/${offer.id}`)).ride.status, 'riding');
  const out = await c.post(`/api/rides/${offer.id}/check-out`, at);
  assert.equal(out.ride.status, 'completed');
  assert.equal(out.ride.payout.status, 'demo');
  assert.ok((await c.get('/api/driver/home')).earnedTodayCents > 0);
  // Admin's sums don't count demo coins; a delete only signs it out, so the next reviewer can still log in.
  assert.equal((await admin.get('/admin/api/users?filter=all&q=demo-')).users.length, 0);
  assert.equal((await c.del('/api/me')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.ok((await admin.get(`/admin/api/users/${c.id}`)).user);
  await c.post('/api/auth/logout');
});

test('a connected wallet is locked: changing it takes a request and an admin\'s yes, good for one change', async () => {
  const d = client(srv.base);
  await d.start();
  const [first, second, third] = [newWallet(), newWallet(), newWallet()];
  const address = async (coin) => (await d.get('/api/wallet')).coins.find((c) => c.id === coin).address;
  const fresh = await d.get('/api/wallet');
  assert.equal(fresh.change.locked, false, 'nothing connected: nothing to lock');
  assert.equal((await d.post('/api/wallet/change-request', { message: 'hi' })).code, 'no_address', 'the first wallet needs no request');
  // The first wallet is free, on both coins.
  const connected = await d.post('/api/wallet/address', { coin: 'sol', address: first, via: 'Phantom' });
  assert.equal(connected.status, 200);
  assert.equal(connected.change.locked, true);
  assert.equal((await d.post('/api/wallet/address', { coin: 'usdc-sol', address: first })).status, 200, 'the same wallet on the other coin');
  // Another one isn't, on any coin.
  assert.equal((await d.post('/api/wallet/address', { coin: 'sol', address: second })).code, 'wallet_locked');
  assert.equal((await d.post('/api/wallet/address', { coin: 'usdc-sol', address: second })).code, 'wallet_locked');
  assert.equal(await address('sol'), first);
  // Asking changes nothing yet, and a second tap adds nothing.
  const asked = await d.post('/api/wallet/change-request', { message: 'I lost my phone' });
  assert.equal(asked.change.request.status, 'open');
  assert.equal(asked.change.request.message, 'I lost my phone');
  assert.equal(asked.change.locked, true);
  await d.post('/api/wallet/change-request', { message: 'Please' });
  assert.equal((await d.get('/api/wallet')).change.request.message, 'I lost my phone');
  assert.equal((await d.post('/api/wallet/address', { coin: 'sol', address: second })).code, 'wallet_locked', 'not before the yes');
  // It's on the panel, and only there can it be allowed.
  assert.equal((await client(srv.base).get('/admin/api/wallet-changes')).status, 401);
  assert.ok((await admin.get('/admin/api/overview')).walletChangesOpen >= 1);
  const listed = (await admin.get('/admin/api/wallet-changes')).requests.filter((r) => r.user_id === d.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].message, 'I lost my phone');
  assert.equal(listed[0].wallets[0].address, first);
  const id = listed[0].id;
  assert.equal((await d.post(`/admin/api/wallet-changes/${id}`, { decision: 'allow' })).status, 401);
  // Allowed: open for one change. The other coin follows to the same wallet, and that's where it ends.
  assert.equal((await admin.post(`/admin/api/wallet-changes/${id}`, { decision: 'allow' })).status, 200);
  assert.equal((await d.get('/api/wallet')).change.locked, false);
  assert.equal((await d.post('/api/wallet/address', { coin: 'sol', address: first })).status, 200, 'connecting the same wallet again');
  assert.equal((await d.get('/api/wallet')).change.locked, false, 'isn\'t a change, so the yes is still there');
  const changed = await d.post('/api/wallet/address', { coin: 'sol', address: second });
  assert.equal(changed.status, 200);
  assert.equal(changed.change.locked, true, 'gray again');
  assert.equal((await d.post('/api/wallet/address', { coin: 'usdc-sol', address: second })).status, 200);
  assert.equal(await address('usdc-sol'), second);
  assert.equal((await d.post('/api/wallet/address', { coin: 'sol', address: third })).code, 'wallet_locked', 'one change only');
  const used = (await admin.get('/admin/api/wallet-changes?filter=all')).requests.find((r) => r.id === id);
  assert.equal(used.status, 'used');
  assert.equal(used.old_address, first);
  assert.equal(used.new_address, second);
  assert.equal((await admin.post(`/admin/api/wallet-changes/${id}`, { decision: 'allow' })).code, 'decided', 'a used yes can\'t be given twice');
  // Declined: stays locked, and they can ask again. A yes can be taken back before it's used.
  await d.post('/api/wallet/change-request', { message: 'Again' });
  const again = (await admin.get('/admin/api/wallet-changes')).requests.find((r) => r.user_id === d.id);
  assert.equal((await admin.post(`/admin/api/wallet-changes/${again.id}`, { decision: 'decline' })).status, 200);
  const declined = await d.get('/api/wallet');
  assert.equal(declined.change.locked, true);
  assert.equal(declined.change.request.status, 'declined');
  assert.equal((await d.post('/api/wallet/address', { coin: 'sol', address: third })).code, 'wallet_locked');
  await d.post('/api/wallet/change-request', {});
  const third_ = (await admin.get('/admin/api/wallet-changes')).requests.find((r) => r.user_id === d.id);
  await admin.post(`/admin/api/wallet-changes/${third_.id}`, { decision: 'allow' });
  assert.equal((await d.get('/api/wallet')).change.locked, false);
  assert.equal((await admin.post(`/admin/api/wallet-changes/${third_.id}`, { decision: 'decline' })).status, 200, 'taken back');
  assert.equal((await d.get('/api/wallet')).change.locked, true);
  assert.equal((await d.post('/api/wallet/address', { coin: 'sol', address: third })).code, 'wallet_locked');
  // Two at once can't both use one yes.
  await d.post('/api/wallet/change-request', {});
  const fourth = (await admin.get('/admin/api/wallet-changes')).requests.find((r) => r.user_id === d.id);
  await admin.post(`/admin/api/wallet-changes/${fourth.id}`, { decision: 'allow' });
  const both = await Promise.all([d.post('/api/wallet/address', { coin: 'sol', address: third }), d.post('/api/wallet/address', { coin: 'usdc-sol', address: newWallet() })]);
  assert.deepEqual(both.map((b) => b.status).sort(), [200, 403]);
  // Deleting the account takes the requests with it, and a new account starts free.
  assert.equal((await d.del('/api/me')).status, 200);
  assert.equal((await admin.get('/admin/api/wallet-changes?filter=all')).requests.filter((r) => r.user_id === d.id).length, 0);
});

// Cash skips paying and the escrow, and nothing else: the same check-in and check-out, and it says so at the end.
const CASH_DROP = { lat: 40.0, lng: 4.92, label: 'D' };
async function cashOrder(r, d, extra = {}) {
  const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: CASH_DROP, passengers: 1, mode: 'driver', driverId: d.id, coin: 'cash', ...extra });
  assert.equal(made.status, 200, JSON.stringify(made));
  return made.ride.id;
}
async function checkInCash(d, r, id) {
  await d.post('/api/location', { ...at40, driving: true });
  await r.post('/api/location', at40);
  const inside = await r.post(`/api/rides/${id}/check-in`, { ...at40, plateChecked: true });
  assert.equal(inside.ride.status, 'riding', JSON.stringify(inside));
}
async function finishCash(d, r, id) {
  for (const lng of [4.903, 4.906, 4.909, 4.912, 4.915, 4.918, 4.9199]) {
    await d.post('/api/location', { lat: 40.0, lng, driving: true });
    await r.post('/api/location', { lat: 40.0, lng });
  }
  const done = await d.post(`/api/rides/${id}/check-out`, { lat: 40.0, lng: 4.9199 });
  assert.equal(done.ride.status, 'completed', JSON.stringify(done));
  return done.ride;
}

test('cash: the same ride and checks, past paying and the escrow, and it ends paid in cash with no fee', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const quote = await r.post('/api/quote', { pickup: { ...at40, label: 'P' }, dropoff: CASH_DROP, passengers: 1, coin: 'cash' });
  assert.ok(quote.offers.some((o) => o.id === d.id), JSON.stringify(quote));
  assert.ok(quote.offers.find((o) => o.id === d.id).coins.includes('cash'), 'riders see that a driver takes it');
  assert.equal((await r.post('/api/quote', { pickup: { ...at40, label: 'P' }, dropoff: CASH_DROP, passengers: 1, coin: 'gold' })).code, 'bad_coin');
  const id = await cashOrder(r, d);
  const before = await d.get('/api/driver/home');
  const accepted = await d.post(`/api/rides/${id}/accept`);
  assert.equal(accepted.ride.status, 'accepted', 'nothing to wait for');
  assert.equal(accepted.ride.payBy, undefined);
  const asked = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(asked.payUrl, undefined, 'no wallet comes into it');
  assert.equal((await r.post(`/api/rides/${id}/pay`, { account: r.wallet })).code, 'not_waiting');
  // Check-in still takes being at the car, with the plate checked.
  await d.post('/api/location', { ...at40, driving: true });
  assert.equal((await r.post(`/api/rides/${id}/check-in`, { lat: 40.01, lng: 4.9, plateChecked: true })).code, 'too_far');
  assert.equal((await r.post(`/api/rides/${id}/check-in`, { ...at40 })).code, 'check_plate');
  await checkInCash(d, r, id);
  // Check-out still takes being at the drop-off.
  assert.equal((await d.post(`/api/rides/${id}/check-out`, at40)).code, 'too_far');
  const done = await finishCash(d, r, id);
  assert.equal(done.escrow, undefined);
  assert.equal(done.coin, 'cash');
  assert.equal(done.payout.status, 'cash');
  assert.equal(done.payout.eurCents, done.priceCents, 'the whole price: no €0.10 on cash');
  // It counts as earned and is not waiting to arrive, and it never shows as money through a wallet.
  const home = await d.get('/api/driver/home');
  assert.equal(home.earnedTotalCents - before.earnedTotalCents, done.priceCents);
  assert.equal(home.pendingCents, before.pendingCents);
  const wallet = await d.get('/api/wallet');
  assert.equal(wallet.status, 200, JSON.stringify(wallet));
  assert.ok(![...wallet.moves, ...wallet.payouts].some((m) => m.rideId === id));
  // Nothing comes due after the 24 hours.
  await dev(`/dev/clock?ms=${25 * HOUR}`);
  await tick();
  assert.equal((await r.get(`/api/rides/${id}`)).ride.payout.status, 'cash');
  await stopAll(d);
});

test('cash: nothing is held, so cancelling is free for the rider and a no-show or a cancel in the car claims nothing', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  // The rider, with the driver on the way.
  const first = await cashOrder(r, d);
  await d.post(`/api/rides/${first}/accept`);
  assert.equal((await r.get(`/api/rides/${first}`)).ride.refundPercent, 100);
  const gone = await r.post(`/api/rides/${first}/cancel`);
  assert.equal(gone.ride.status, 'cancelled');
  assert.equal(gone.ride.payout, undefined, 'the driver gets no half');
  // A late driver is only a late driver: there's no refund to offer.
  const late = await cashOrder(r, d);
  await d.post(`/api/rides/${late}/accept`);
  await dev(`/dev/clock?ms=${2 * HOUR}`);
  await keepOnline(d);
  assert.equal((await r.get(`/api/rides/${late}`)).ride.driverLate, false);
  // The driver waited 10 minutes at the pickup: no 50% to claim.
  await d.post('/api/location', { ...at40, speed: 0, driving: true });
  await d.post('/api/location', { ...at40, speed: 0, driving: true });
  await dev(`/dev/clock?ms=${11 * 60_000}`);
  await keepOnline(d);
  assert.equal((await d.get(`/api/rides/${late}`)).ride.noShowFrom, null);
  const noShow = await d.post(`/api/rides/${late}/driver-cancel`, { reason: 'Rider not there' });
  assert.equal(noShow.ride.status, 'cancelled');
  assert.equal(noShow.ride.payout, undefined);
  // In the car: the driver can stop, and there's nothing to split.
  const inside = await cashOrder(r, d);
  await d.post(`/api/rides/${inside}/accept`);
  await checkInCash(d, r, inside);
  const stopped = await d.post(`/api/rides/${inside}/driver-cancel`, { reason: 'Misbehaviour' });
  assert.equal(stopped.ride.status, 'cancelled');
  assert.equal(stopped.ride.payout, undefined);
  await stopAll(d);
});

test('cash: a driver can say no to it, needs no wallet address for that coin, and going online still needs a wallet', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  assert.equal((await d.get('/api/wallet')).takesCash, true, 'on by default');
  assert.equal((await r.post('/api/wallet/cash', { enabled: false })).code, 'not_a_driver');
  const off = await d.post('/api/wallet/cash', { enabled: false });
  assert.equal(off.takesCash, false);
  const quote = await r.post('/api/quote', { pickup: { ...at40, label: 'P' }, dropoff: CASH_DROP, passengers: 1, coin: 'cash' });
  assert.ok(!quote.offers.some((o) => o.id === d.id), 'not offered to someone who said no');
  const named = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: CASH_DROP, passengers: 1, mode: 'bid', bidCents: 2000, coin: 'cash' });
  const market = await d.get(`/api/driver/market?lat=${at40.lat}&lng=${at40.lng}`);
  assert.equal(market.orders.find((o) => o.id === named.ride.id).canClaim, false);
  assert.equal((await d.post(`/api/rides/${named.ride.id}/claim`)).code, 'coin_off');
  await d.post('/api/wallet/cash', { enabled: true });
  const claimed = await d.post(`/api/rides/${named.ride.id}/claim`);
  assert.equal(claimed.ride.status, 'accepted', JSON.stringify(claimed));
  await d.post(`/api/rides/${named.ride.id}/driver-cancel`, { reason: 'Other' });
  // Turning every coin off still means no going online: a wallet is what going online takes.
  await stopAll(d);
  await d.post('/api/wallet/enable', { coin: 'sol', enabled: false });
  assert.equal((await d.post('/api/driver/online', at40)).code, 'need_wallet');
  await d.post('/api/wallet/enable', { coin: 'sol', enabled: true });
});

test('cash: a planned ride needs no paying, and a driver passing on it puts it back on the market', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const clock = (await dev('/dev/clock?ms=0')).now;
  const made = await r.post('/api/rides', { pickup: { ...at40, label: 'P' }, dropoff: CASH_DROP, passengers: 1, mode: 'bid', bidCents: 1500, coin: 'cash', scheduledAt: clock + 5 * HOUR });
  const id = made.ride.id;
  assert.equal((await d.post(`/api/rides/${id}/claim`)).ride.status, 'scheduled', 'planned, with nothing to wait for');
  assert.equal((await r.get('/api/sync?rev=0')).toPay, undefined);
  assert.equal((await d.post(`/api/rides/${id}/release`)).ok, true);
  const again = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(again.status, 'open', 'nothing to refund, so the order stays');
  assert.equal(again.driver, undefined);
  await r.post(`/api/rides/${id}/cancel`);
  await stopAll(d);
});

test('cash: an appeal reaches an admin for 24 hours, moves no money and can only be closed', async () => {
  const d = await driver({ at: at40 });
  const r = await rider();
  const id = await cashOrder(r, d);
  await d.post(`/api/rides/${id}/accept`);
  await checkInCash(d, r, id);
  await finishCash(d, r, id);
  const appealed = await d.post(`/api/rides/${id}/appeal`, { message: 'The rider did not pay me.' });
  assert.equal(appealed.status, 200, JSON.stringify(appealed));
  assert.equal(appealed.ride.dispute.status, 'open');
  const disputes = (await admin.get('/admin/api/disputes?filter=open')).disputes;
  const dis = disputes.find((x) => x.ride_id === id);
  assert.equal(dis.ride.coin, 'cash');
  assert.equal((await admin.post(`/admin/api/disputes/${dis.id}`, { decision: 'pay_driver' })).code, 'bad_decision');
  assert.equal((await admin.post(`/admin/api/rides/${id}/decide`, { decision: 'pay_driver' })).code, 'not_paid');
  assert.equal((await admin.post(`/admin/api/disputes/${dis.id}`, { decision: 'closed', answer: 'Noted.' })).status, 200);
  const closed = (await r.get(`/api/rides/${id}`)).ride;
  assert.equal(closed.status, 'completed', 'the ride stands');
  assert.equal(closed.dispute.status, 'closed');
  assert.equal(closed.payout.status, 'cash');
  // The rider has the same 24 hours.
  await dev(`/dev/clock?ms=${25 * HOUR}`);
  assert.equal((await r.post(`/api/rides/${id}/appeal`, { message: 'Too late to say this.' })).code, 'too_late');
  await stopAll(d);
});

test('a rider can choose from 50 drivers, in a look and in a quote', async () => {
  const at = { lat: 47.1, lng: 8.5 };
  for (let i = 0; i < 55; i++) await dev(`/dev/driver?id=dz-list${i}&lat=${at.lat + i / 5000}&lng=${at.lng}&perKm=${80 + i}`);
  const r = await rider();
  await r.post('/api/location', at);
  const look = await r.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}&limit=50`);
  assert.equal(look.drivers.length, 50);
  assert.equal(look.total, 55, 'and it knows how many are out there');
  const quote = await r.post('/api/quote', { pickup: { ...at, label: 'P' }, dropoff: { lat: 47.12, lng: 8.5, label: 'D' }, passengers: 1, coin: 'cash' });
  assert.equal(quote.status, 200, JSON.stringify(quote).slice(0, 200));
  assert.equal(quote.offers.length, 50, 'all 50 with a price for this ride');
  assert.ok(quote.offers.every((o, i) => !i || quote.offers[i - 1].priceCents <= o.priceCents), 'cheapest first');
  for (let i = 0; i < 55; i++) await fetch(`${srv.base}/dev/move?id=dz-list${i}&lat=0.5&lng=0.5`, { method: 'POST' });
});
