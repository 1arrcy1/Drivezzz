// Android push through Firebase Cloud Messaging, against a pretend Google: the token endpoint and FCM's send. An iPhone's token
// never goes there, an Android one never to Apple, and a phone FCM says is gone is forgotten.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { client, startServer } from './helpers.js';

let srv, google, keyFile;
const sent = [], tokens = [];
const gone = new Set(['gone-token']);
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

before(async () => {
  google = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/token') {
        const assertion = new URLSearchParams(body).get('assertion');
        const [h, c, sig] = assertion.split('.');
        const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'));
        const claims = JSON.parse(Buffer.from(c, 'base64url'));
        tokens.push({ ok, claims });
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(ok ? { access_token: 'access-1', expires_in: 3600 } : { error: 'invalid_grant' }));
      }
      const m = req.url.match(/^\/v1\/projects\/([^/]+)\/messages:send$/);
      if (!m || req.headers.authorization !== 'Bearer access-1') { res.writeHead(401); return res.end('{}'); }
      const { message } = JSON.parse(body);
      sent.push({ project: m[1], message });
      if (gone.has(message.token)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
      }
      res.end(JSON.stringify({ name: `projects/${m[1]}/messages/1` }));
    });
  });
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${google.address().port}`;
  keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-fcm-')), 'firebase.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    type: 'service_account', project_id: 'drivezzz-test', client_email: 'push@drivezzz-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${url}/token`,
  }));
  srv = await startServer({ FCM_KEY_FILE: keyFile, FCM_URL: url });
});
after(() => { srv.stop(); google.close(); fs.rmSync(path.dirname(keyFile), { recursive: true, force: true }); });

const AMS = { lat: 52.37, lng: 4.89 };
const NEAR = { lat: 52.372, lng: 4.895 };
const PICK = { lat: 52.37, lng: 4.89, label: 'Pickup' };
const DROP = { lat: 52.37, lng: 4.95, label: 'Drop-off' };
const wallet = () => {
  const raw = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${raw.toString('hex')}`), out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  return out;
};

// A driver online near Amsterdam, as test/flows.test.js makes one.
async function driver(pushToken) {
  const c = client(srv.base);
  await c.start();
  await c.post('/api/driver/enable');
  const car = await c.post('/api/cars', { plate: `DZ${crypto.randomInt(10000, 99999)}`, make: 'Toyota', model: 'Prius', seats: 4, perKmCents: 90, perMinCents: 20, pickupPerKmCents: 50 });
  for (const kind of ['front', 'back', 'inside']) await c.upload(`/api/cars/${car.car.id}/photos?kind=${kind}`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  assert.equal((await c.post('/api/wallet/address', { coin: 'sol', address: wallet() })).status, 200);
  if (pushToken) {
    assert.equal((await c.patch('/api/me', { pushEnv: 'fcm' })).fcmOn, true, 'the app asks first');
    assert.equal((await c.patch('/api/me', { pushToken, pushEnv: 'fcm' })).pushOn, true);
  }
  assert.equal((await c.post('/api/driver/online', NEAR)).status, 200);
  return c;
}

async function rider(pushToken, pushEnv) {
  const c = client(srv.base);
  await c.start();
  await c.post('/api/location', AMS);
  if (pushToken) await c.patch('/api/me', { pushToken, pushEnv });
  return c;
}

test('an Android driver hears of a new ride through FCM, and only a server with Firebase says pushOn', async () => {
  const d = await driver('android-token-1');
  const r = await rider('apple-token-1', 'production');
  assert.equal((await r.patch('/api/me', { pushToken: 'apple-token-1', pushEnv: 'production' })).pushOn, false, 'no APNs key here');
  const before = sent.length;
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'auto', coin: 'sol' });
  assert.equal(made.status, 200, JSON.stringify(made).slice(0, 300));
  assert.ok(await until(() => sent.slice(before).some((s) => s.message.token === 'android-token-1')), 'FCM was asked');
  const m = sent.slice(before).find((s) => s.message.token === 'android-token-1');
  assert.equal(m.project, 'drivezzz-test');
  assert.equal(m.message.notification.title, 'New ride');
  assert.equal(m.message.android.priority, 'HIGH');
  assert.equal(m.message.android.notification.channel_id, 'rides');
  assert.equal(m.message.data.rideId, made.ride.id);
  for (const v of Object.values(m.message.data)) assert.equal(typeof v, 'string', 'FCM data is text only');
  assert.ok(tokens.length >= 1 && tokens.every((t) => t.ok), 'the JWT is signed with the service account key');
  assert.equal(tokens[0].claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(tokens[0].claims.iss, 'push@drivezzz-test.iam.gserviceaccount.com');

  // The driver accepts: the rider has an iPhone, and its token never goes to Google.
  const sentBefore = sent.length;
  assert.equal((await d.post(`/api/rides/${made.ride.id}/accept`)).status, 200);
  await new Promise((res) => setTimeout(res, 500));
  assert.ok(!sent.slice(sentBefore).some((s) => s.message.token.startsWith('apple-')), 'no Apple token reached Google');
  await r.post(`/api/rides/${made.ride.id}/cancel`, {});
  await d.post('/api/driver/offline');
});

test('a phone FCM no longer knows is forgotten, and the access token is kept', async () => {
  const d = await driver('gone-token');
  const r = await rider();
  const before = sent.length;
  const made = await r.post('/api/rides', { pickup: PICK, dropoff: DROP, passengers: 1, mode: 'auto', coin: 'sol' });
  assert.equal(made.status, 200);
  assert.ok(await until(() => sent.slice(before).some((s) => s.message.token === 'gone-token')));
  // Forgotten: a fresh PATCH without a token answers pushOn from what's kept, which is nothing now.
  await until(() => false, 300);
  const me = await d.patch('/api/me', { name: 'Gone' });
  assert.equal(me.pushOn, false, 'the gone token was cleared');
  assert.equal(tokens.length, 1, 'one access token for every send');
  await r.post(`/api/rides/${made.ride.id}/cancel`, {});
  await d.post('/api/driver/offline');
});
