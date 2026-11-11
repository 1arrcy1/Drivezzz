// Riders in the same small area share one answer for a few seconds, ready and compressed. Everything else about nearby is in flows.test.js.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { client, startServer } from './helpers.js';
import { b58encode } from '../src/coins.js';

let srv;
const AT = { lat: 52.37, lng: 4.89 };
const BESIDE = { lat: 52.3705, lng: 4.8905 };
before(async () => { srv = await startServer({ SHARED_LOOK_MS: '60000' }); });
after(() => srv.stop());

const newWallet = () => b58encode(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==', 'base64');

async function driver(at, perKm) {
  const c = client(srv.base);
  await c.start();
  await c.post('/api/driver/enable');
  const { car } = await c.post('/api/cars', { plate: `DZ${crypto.randomInt(10000, 99999)}`, make: 'Toyota', model: 'Prius', seats: 4, colorHex: '#F4F4F2', body: 'hatchback', perKmCents: perKm, perMinCents: 20, pickupPerKmCents: 50 });
  for (const kind of ['front', 'back', 'inside']) await c.upload(`/api/cars/${car.id}/photos?kind=${kind}`, jpeg);
  await c.post('/api/wallet/address', { coin: 'sol', address: newWallet() });
  assert.equal((await c.post('/api/driver/online', at)).status, 200);
  return c;
}
async function rider() {
  const c = client(srv.base);
  c.bearer = (await c.start()).token;
  return c;
}
const look = (c, at) => c.get(`/api/drivers/nearby?lat=${at.lat}&lng=${at.lng}`);

test('riders close together share an answer, and someone who blocked a driver gets their own', async () => {
  const first = await driver(AT, 80);
  const a = await rider(), b = await rider();
  const seen = await look(a, AT);
  assert.deepEqual(seen.drivers.map((d) => d.id), [first.id]);
  assert.equal(seen.total, 1);
  const late = await driver(BESIDE, 60);
  // With helpers (WORKERS) each keeps its own answer, and b may ask another one.
  if (!Number(process.env.WORKERS)) assert.deepEqual((await look(b, BESIDE)).drivers.map((d) => d.id), [first.id], 'still the shared answer');
  const blocker = await rider();
  assert.equal((await blocker.post('/api/blocks', { userId: first.id })).status, 200);
  assert.deepEqual((await look(blocker, AT)).drivers.map((d) => d.id), [late.id], 'its own, right now');
  assert.ok(!(await look(first, AT)).drivers.some((d) => d.id === first.id), 'a driver never sees themselves');
});

test('it comes compressed for whoever asks', async () => {
  const c = await rider();
  await look(c, AT);
  const raw = await new Promise((resolve, reject) => {
    const url = new URL(`${srv.base}/api/drivers/nearby?lat=${AT.lat}&lng=${AT.lng}`);
    http.get(url, { headers: { authorization: `Bearer ${c.bearer}`, 'x-device-id': c.deviceId, 'accept-encoding': 'gzip' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers));
    }).on('error', reject);
  });
  assert.equal(raw['content-encoding'], 'gzip');
});

// Pieter, 8 November 2026: a driver who's booked or goes offline should go from riders' maps quickly, not when the shared answer runs out.
// Helpers (WORKERS) hear of it from the main process in batches of 20 ms.
const heard = () => new Promise((resolve) => { setTimeout(resolve, Number(process.env.WORKERS) ? 100 : 0); });
test('a driver who goes offline or is offered a ride leaves the shared answer at once', async () => {
  const HERE = { lat: 52.5, lng: 4.6 };
  const one = await driver(HERE, 70), two = await driver({ lat: 52.5005, lng: 4.6005 }, 75);
  assert.deepEqual((await look(await rider(), HERE)).drivers.map((d) => d.id).sort(), [one.id, two.id].sort());
  await one.post('/api/driver/offline');
  await heard();
  assert.deepEqual((await look(await rider(), HERE)).drivers.map((d) => d.id), [two.id], 'offline: gone without waiting a minute');
  const r = await rider();
  const made = await r.post('/api/rides', { pickup: { ...HERE, label: 'P' }, dropoff: { lat: 52.51, lng: 4.62, label: 'D' }, passengers: 1, mode: 'driver', driverId: two.id, coin: 'sol' });
  assert.equal(made.ride.status, 'offered', JSON.stringify(made));
  await heard();
  assert.deepEqual((await look(await rider(), HERE)).drivers, [], 'offered a ride: gone too');
  // Coming back is the other way round: the answer without them lasts its few seconds (5 on the live server).
});

// Pieter, 8 November 2026: someone looking at the map should see a driver's new price at the next look.
test('a driver who changes their price shows the new one at the next look', async () => {
  const THERE = { lat: 52.6, lng: 4.7 };
  const d = await driver(THERE, 80);
  const first = (await look(await rider(), THERE)).drivers.find((x) => x.id === d.id);
  assert.equal(first.perKmCents, 80);
  const carId = (await d.get('/api/driver')).driver.activeCarId;
  assert.equal((await d.patch(`/api/cars/${carId}`, { perKmCents: 65 })).status, 200);
  await heard();
  assert.equal((await look(await rider(), THERE)).drivers.find((x) => x.id === d.id).perKmCents, 65, 'not the minute-old answer');
});
