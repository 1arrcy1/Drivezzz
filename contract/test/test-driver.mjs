// A pretend driver, for trying a ride on a real phone or the simulator against a DEV=1 test instance: goes online where you say,
// takes every offer and claims what's on the market after a moment, so the waiting can be seen, drives to the pickup, and once
// the rider checks in drives to the drop-off and checks out. Its wallet is a key file in ~/devnet.
// It has chat keys like a phone: it reads what it's sent, end-to-end encrypted, and answers as soon as the rules let a driver reply.
//   node test/test-driver.mjs http://127.0.0.1:8081 <lat> <lng> [key name, default driver] [per km cents, default 90]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKeypair, sleep } from './sol.mjs';

const [BASE, lat, lng, keyName = 'driver', perKm = '90'] = process.argv.slice(2);
// Not on the live server, unless it's asked for by name; and even then it stops below once real money moves there.
const onLive = /s3rver\.nl|:8080/.test(BASE);
if (onLive && process.env.TEST_DRIVER_ON_LIVE !== '1') throw new Error('not the live server, unless TEST_DRIVER_ON_LIVE=1');
const RADIUS_KM = Number(process.env.TEST_DRIVER_RADIUS_KM ?? 40);
const wallet = loadKeypair(path.join(os.homedir(), 'devnet', `${keyName}.json`));
const here = { lat: Number(lat), lng: Number(lng) };
let token;
const device = `test-driver-${keyName}`;
const call = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-device-id': device, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Chat: the same as server/src/e2e.js and the app's Core/E2E.swift.
const chatPrivate = crypto.createHash('sha256').update(wallet.seed).update('chat').digest();
const asPrivate = (raw) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
const asPublic = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]), format: 'der', type: 'spki' });
const chatPublic = crypto.createPublicKey(asPrivate(chatPrivate)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const chatKey = (theirs) => Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: asPrivate(chatPrivate), publicKey: asPublic(Buffer.from(theirs, 'base64')) }), 'drivezzz-e2e-v1', `chat|${[chatPublic, theirs].sort().join('|')}`, 32));
const sealText = (key, text) => {
  const nonce = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64');
};
const openText = (key, sealed) => {
  const raw = Buffer.from(String(sealed), 'base64');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
  } catch { return null; }
};

const me = await call('POST', '/api/auth/continue', {});
token = me.token;
// A pretend driver takes every order it sees: fine with pretend money, never with real money.
if (onLive && (await call('GET', '/api/wallet')).network === 'mainnet') {
  say('the live server is on the real network: not starting');
  process.exit(0);
}
await call('POST', '/api/driver/enable', {});
await call('PATCH', '/api/me', { name: process.env.TEST_DRIVER_NAME || 'Test driver' });
// The same phone gets its own account back, so only the first time.
if (!(await call('GET', '/api/driver')).driver?.cars?.length) {
  await call('POST', '/api/cars', { plate: `TD${Math.floor(Math.random() * 9000) + 1000}`, make: 'Toyota', model: 'Prius', seats: 4, colorName: 'White', perKmCents: Number(perKm), perMinCents: 5, pickupPerKmCents: 10 });
}
// The photos every vehicle needs: real test pictures, from the server's test folder.
for (const car of (await call('GET', '/api/driver')).driver?.cars ?? []) {
  for (const kind of car.photosMissing ?? []) {
    await fetch(`${BASE}/api/cars/${car.id}/photos?kind=${kind}`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-device-id': device, authorization: `Bearer ${token}` }, body: fs.readFileSync(new URL(`./photos/${kind}.jpg`, import.meta.url)) });
  }
}
for (const coin of ['sol', 'usdc-sol']) await call('POST', '/api/wallet/address', { coin, address: wallet.address, via: 'Test' });
await call('POST', '/api/driver/rules-seen', {});
// A car in the Netherlands needs the driver checks; test servers pass them pretend (checks.js, CHECKS_FAKE). Older servers answer 404.
await call('POST', '/api/checks/fake', { result: 'pass' });
await call('PATCH', '/api/driver', { allowsPlanning: true });
await call('POST', '/api/me/key', { publicKey: chatPublic });
const online = await call('POST', '/api/driver/online', here);
say('online as', me.user.id, 'wallet', wallet.address, online.driver?.online ? '' : JSON.stringify(online).slice(0, 160));

// New messages: read them, and answer if a driver may.
const seen = new Set();
async function chats() {
  const { conversations } = await call('GET', '/api/messages');
  for (const c of conversations ?? []) {
    if (!c.unread) continue;
    const t = await call('GET', `/api/messages/${c.person.id}`);
    let got = 0;
    for (const m of t.messages ?? []) {
      if (seen.has(m.id) || m.fromMe) continue;
      seen.add(m.id);
      got++;
      say(`from ${c.person.name}:`, openText(chatKey(m.senderKey ?? c.person.publicKey), m.body) ?? '(can\'t open this one)');
    }
    if (got) await call('POST', `/api/messages/${c.person.id}/read`, {});
    const lastOne = t.messages?.at(-1);
    if (t.canSend && lastOne && !lastOne.fromMe) {
      const words = 'Got your messages, I read them here. This is the test driver.';
      const sent = await call('POST', `/api/messages/${c.person.id}`, { body: sealText(chatKey(c.person.publicKey), words), senderKey: chatPublic, toKey: c.person.publicKey });
      say('replied', sent.status);
    }
  }
}

// How long it waits before answering an order, one by one, so the screens that wait for a driver can be seen.
const THINK_MS = Number(process.env.TEST_DRIVER_THINK_MS ?? 20000);
const firstSeen = new Map();
const thoughtAbout = (id) => {
  if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
  return Date.now() - firstSeen.get(id) >= THINK_MS;
};
const triedToClaim = new Set();

let last = '';
let where = here;
let drivingOff = false;
for (;;) {
  const moving = drivingOff;
  await call('POST', '/api/location', { ...where, driving: true, speed: moving ? 20 : 0 });
  await chats().catch((e) => say('chat', e.message));
  const { driving } = await call('GET', '/api/sync?rev=0');
  const drive = driving?.drive;
  const now = drive ? `${drive.id} ${drive.status}` : 'free';
  if (now !== last) { say(now, drive?.escrow ? `escrow ${drive.escrow.status} ${drive.escrow.amount} ${drive.escrow.coin}` : ''); last = now; }
  if (driving?.offer && thoughtAbout(driving.offer.id)) {
    const a = await call('POST', `/api/rides/${driving.offer.id}/accept`, {});
    say('accepted', driving.offer.id, a.ride?.status ?? JSON.stringify(a).slice(0, 160));
  }
  // Planned orders and named prices wait on the market until a driver claims them.
  // There: at the pickup and stopped, which is what starts a rider's 10 minutes. Also after a restart, which starts it at home.
  if (drive?.status === 'arrived') {
    where = { lat: drive.pickup.lat, lng: drive.pickup.lng };
    drivingOff = false;
  }
  // A rider who never gets in: after the 10 minutes it cancels as a driver would, or it would stay busy for ever.
  if (drive?.status === 'arrived' && drive.noShowFrom && drive.now >= drive.noShowFrom) {
    const gone = await call('POST', `/api/rides/${drive.id}/driver-cancel`, { reason: 'Rider not there' });
    say('rider not there', gone.ride?.status ?? JSON.stringify(gone).slice(0, 160));
  }
  if (!drive && !driving?.offer) {
    // Free again: back to where it waits.
    where = here;
    drivingOff = false;
    const { orders } = await call('GET', `/api/driver/market?lat=${where.lat}&lng=${where.lng}&radiusKm=${RADIUS_KM}`);
    const order = (orders ?? []).find((o) => o.canClaim && !triedToClaim.has(o.id) && thoughtAbout(o.id));
    if (order) {
      triedToClaim.add(order.id);
      const c = await call('POST', `/api/rides/${order.id}/claim`, {});
      say('claimed', order.id, c.ride?.status ?? JSON.stringify(c).slice(0, 160));
    }
  }
  // It sets off as soon as it has accepted, before the rider pays, so you can watch it come on the map. 72 km/h.
  if (drive?.status === 'accepted' || drive?.status === 'awaiting_payment') {
    const north = (drive.pickup.lat - where.lat) * 111_000, east = (drive.pickup.lng - where.lng) * 67_000;
    const left = Math.hypot(north, east);
    const part = left > 50 ? 50 / left : 1;
    drivingOff = left > 50;
    where = { lat: where.lat + (drive.pickup.lat - where.lat) * part, lng: where.lng + (drive.pickup.lng - where.lng) * part };
  }
  if (drive?.status === 'riding') {
    await sleep(15000);
    where = { lat: drive.dropoff.lat, lng: drive.dropoff.lng };
    await call('POST', '/api/location', { ...where, driving: true });
    const out = await call('POST', `/api/rides/${drive.id}/check-out`, where);
    say('checked out', out.ride?.status ?? JSON.stringify(out).slice(0, 160), out.ride?.checkoutWarning ? '(rider warned)' : '');
    where = here;
    drivingOff = false;
    await call('POST', '/api/driver/online', here);
  }
  await sleep(2500);
}
