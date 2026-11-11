// Driver checks in the Netherlands (src/checks.js): a passport chip signed by a pretend state (openssl makes its certificates),
// the face match signed with a pretend App Attest key, a pretend RDW and KvK, and the way to going online.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { client, startServer } from './helpers.js';
import { b58encode } from '../src/coins.js';

const AMS = { lat: 52.37, lng: 4.89 };
const BRUSSELS = { lat: 50.85, lng: 4.35 };
const APP_ID = 'N92R3SAXJ7.eu.drivezzz.app';
let srv, admin, rdw, kvk, state;

// ---------- DER and CBOR, to make what a chip and App Attest send ----------
const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(Array.isArray(tag) ? tag : [tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const int = (n) => tlv(0x02, Buffer.from([n]));
const octet = (b) => tlv(0x04, b);
function oid(s) {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [a * 40 + b];
  for (const n of rest) { const bytes = [n & 0x7f]; let v = n >> 7; while (v) { bytes.unshift((v & 0x7f) | 0x80); v >>= 7; } out.push(...bytes); }
  return tlv(0x06, Buffer.from(out));
}
const sha = (alg, ...parts) => { const h = crypto.createHash(alg); for (const p of parts) h.update(p); return h.digest(); };
const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
const cborMap = (o) => Buffer.concat([head(5, Object.keys(o).length), ...Object.entries(o).flatMap(([k, v]) => [head(3, Buffer.byteLength(k)), Buffer.from(k), head(2, v.length), v])]);

// The MRZ of a pretend Dutch passport, with a pretend BSN in its optional data that must never come back out.
const VALUE = (c) => (c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
const cd = (s) => String([...s].reduce((sum, c, i) => sum + VALUE(c) * [7, 3, 1][i % 3], 0) % 10);
function mrz({ surname = 'DE<BRUIJN', given = 'WILLEKE<LISELOTTE', number = 'SPECI2014', birth = '650310', expiry = '341231' } = {}) {
  const l1 = `P<NLD${`${surname}<<${given}`.padEnd(39, '<')}`;
  const opt = '999999990'.padEnd(14, '<');
  const body = `${number}${cd(number)}NLD${birth}${cd(birth)}F${expiry}${cd(expiry)}${opt}${cd(opt)}`;
  return l1 + body + cd(`${number}${cd(number)}${birth}${cd(birth)}${expiry}${cd(expiry)}${opt}${cd(opt)}`);
}

// A pretend state: a CSCA and a document signer, made with openssl, and a passport signed by it.
function makeState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-csca-'));
  const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'csca.key', '-out', 'csca.pem', '-subj', '/C=NL/O=Pretend State/CN=CSCA TEST', '-days', '3650');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ds.key', '-out', 'ds.csr', '-subj', '/C=NL/O=Pretend State/CN=DS TEST');
  ssl('x509', '-req', '-in', 'ds.csr', '-CA', 'csca.pem', '-CAkey', 'csca.key', '-CAcreateserial', '-out', 'ds.pem', '-days', '3650');
  const aa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  return {
    dir, aa,
    passport(opts = {}) {
      const dg1 = tlv(0x61, tlv([0x5f, 0x1f], Buffer.from(mrz(opts))));
      const dg15 = tlv(0x6f, aa.publicKey.export({ type: 'spki', format: 'der' }));
      const lds = seq(int(0), seq(oid('2.16.840.1.101.3.4.2.1')), seq(seq(int(1), octet(sha('sha256', dg1))), seq(int(15), octet(sha('sha256', dg15)))));
      fs.writeFileSync(path.join(dir, 'lds.der'), lds);
      ssl('cms', '-sign', '-binary', '-nodetach', '-in', 'lds.der', '-outform', 'DER', '-signer', 'ds.pem', '-inkey', 'ds.key', '-md', 'sha256', '-nosmimecap', '-econtent_type', '2.23.136.1.1.1', '-out', 'sod.der');
      return { dg1, dg15, sod: tlv(0x77, fs.readFileSync(path.join(dir, 'sod.der'))) };
    },
    // The chip's answer to a challenge: ISO 9796-2 scheme 1 with SHA-1, as many RSA chips do.
    signChallenge(challenge, key = aa.privateKey) {
      const m1 = crypto.randomBytes(128 - 1 - 20 - 1);
      const m = Buffer.concat([Buffer.from([0x6a]), m1, sha('sha1', m1, challenge), Buffer.from([0xbc])]);
      return crypto.privateEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, m);
    },
  };
}

// The RDW: TX111A and TX555E are taxis; NT222B a plain car; MO333C a motor; EX444D a taxi that was exported and is still insured,
// as 428 real ones are (5 November 2026).
function fakeRdw() {
  const cars = {
    TX111A: { voertuigsoort: 'Personenauto', taxi_indicator: 'Ja', wam_verzekerd: 'Ja', vervaldatum_apk: '20301231', merk: 'TOYOTA', handelsbenaming: 'PRIUS', aantal_zitplaatsen: '5', eerste_kleur: 'WIT' },
    TX555E: { voertuigsoort: 'Personenauto', taxi_indicator: 'Ja', wam_verzekerd: 'Ja', vervaldatum_apk: '20301231', merk: 'SKODA', handelsbenaming: 'OCTAVIA', aantal_zitplaatsen: '5', eerste_kleur: 'ZWART' },
    EX444D: { voertuigsoort: 'Personenauto', taxi_indicator: 'Ja', wam_verzekerd: 'Ja', vervaldatum_apk: '20301231', export_indicator: 'Ja', merk: 'SEAT', handelsbenaming: 'IBIZA', aantal_zitplaatsen: '5', eerste_kleur: 'GRIJS' },
    NT222B: { voertuigsoort: 'Personenauto', taxi_indicator: 'Nee', wam_verzekerd: 'Ja', vervaldatum_apk: '20301231', merk: 'KIA', handelsbenaming: 'NIRO', aantal_zitplaatsen: '5', eerste_kleur: 'ROOD' },
    MO333C: { voertuigsoort: 'Motorfiets', taxi_indicator: 'Nee', wam_verzekerd: 'Ja', merk: 'BMW', handelsbenaming: 'R 1250', aantal_zitplaatsen: '2', eerste_kleur: 'ZWART' },
    SC666F: { voertuigsoort: 'Motorfiets', taxi_indicator: 'Nee', wam_verzekerd: 'Ja', merk: 'URAL', handelsbenaming: 'GEAR UP', aantal_zitplaatsen: '3', eerste_kleur: 'ZWART' },
  };
  const server = http.createServer((req, res) => {
    const plate = new URL(req.url, 'http://x').searchParams.get('kenteken');
    res.end(JSON.stringify(cars[plate] ? [{ kenteken: plate, ...cars[plate] }] : []));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
// KvK: 12345678 is a taxi business; 87654321 doesn't exist; 11112222 ended; 55556666 doesn't answer until told to.
let kvkAnswers = false;
function fakeKvk() {
  const server = http.createServer((req, res) => {
    if (req.headers.apikey !== 'test-key') { res.writeHead(401); res.end(); return; }
    const taxi = { materieleRegistratie: { datumAanvang: '20200101' }, sbiActiviteiten: [{ sbiCode: '49320', indHoofdactiviteit: 'Ja' }] };
    if (req.url.startsWith('/basisprofielen/12345678')) res.end(JSON.stringify({ ...taxi, kvkNummer: '12345678', naam: 'Taxi De Bruijn', handelsnamen: [{ naam: 'Taxi De Bruijn', volgorde: 1 }, { naam: 'Haagse Rit', volgorde: 2 }] }));
    else if (req.url.startsWith('/basisprofielen/11112222')) res.end(JSON.stringify({ ...taxi, kvkNummer: '11112222', naam: 'Oud Taxi', materieleRegistratie: { datumAanvang: '20200101', datumEinde: '20260101' } }));
    else if (req.url.startsWith('/basisprofielen/55556666')) {
      if (kvkAnswers) res.end(JSON.stringify({ ...taxi, kvkNummer: '55556666', naam: 'Taxi De Bruijn' }));
      else { res.writeHead(500); res.end(); }
    } else { res.writeHead(404); res.end('{}'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

before(async () => {
  state = makeState();
  fs.copyFileSync(path.join(state.dir, 'csca.pem'), path.join(state.dir, 'trusted.pem'));
  rdw = await fakeRdw();
  kvk = await fakeKvk();
  srv = await startServer({
    NL_CHECKS: '1', ONLY_NETHERLANDS: '1', CHECKS_FAKE: '0', RDW_URL: rdw.url, KVK_URL: `${kvk.url}/basisprofielen`, KVK_API_KEY: 'test-key',
    CSCA_MASTER_LIST: path.join(state.dir, 'none.ml'),
  });
  admin = client(srv.base);
  assert.equal((await admin.post('/admin/api/login', { email: 'admin@test.local', password: 'admin' })).status, 200);
  assert.equal((await admin.post('/admin/api/password', { current: 'admin', password: 'test-admin-new' })).status, 200);
});
after(() => { srv.stop(); rdw.server.close(); kvk.server.close(); fs.rmSync(state.dir, { recursive: true, force: true }); });

const photo = fs.readFileSync(new URL('./photos/front.jpg', import.meta.url));
const newWallet = () => b58encode(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));

async function driver(plate = 'TX111A', vehicle = 'car') {
  const c = client(srv.base);
  await c.start();
  assert.equal((await c.post('/api/driver/enable')).status, 200);
  const car = await c.post('/api/cars', { plate, vehicle, seats: vehicle === 'car' ? 4 : 1, perKmCents: 100, perMinCents: 10, pickupPerKmCents: 20 });
  assert.equal(car.status, 200, JSON.stringify(car));
  for (const kind of vehicle === 'car' ? ['front', 'back', 'inside'] : ['front', 'back']) {
    assert.equal((await c.upload(`/api/cars/${car.car.id}/photos?kind=${kind}`, photo)).status, 200);
  }
  assert.equal((await c.post('/api/wallet/address', { coin: 'sol', address: newWallet() })).status, 200);
  c.carId = car.car.id;
  c.plate = plate;
  return c;
}

// A pretend App Attest key for this account, put straight into the database: Apple's own certificates can't be made here.
function attestKey(userId) {
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyId = crypto.randomBytes(32).toString('base64');
  const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'));
  db.prepare('INSERT INTO attest_keys (key_id, user_id, public_key, environment, counter, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(keyId, userId, key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), 'development', Date.now());
  db.close();
  let counter = 0;
  return {
    keyId,
    sign(payload) {
      counter++;
      const auth = Buffer.concat([sha('sha256', APP_ID), Buffer.from([0x40]), Buffer.from([0, 0, 0, counter])]);
      const signature = crypto.sign('sha256', sha('sha256', auth, sha('sha256', Buffer.from(payload))), key.privateKey);
      return cborMap({ signature, authenticatorData: auth }).toString('base64');
    },
  };
}

// The same for an Android phone (AppAttest.kt): its attested key, and "drivezzz-android-1", a counter and the payload's hash signed.
function androidKey(userId) {
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyId = crypto.randomBytes(32).toString('base64');
  const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'));
  db.prepare('INSERT INTO attest_keys (key_id, user_id, public_key, environment, counter, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(keyId, userId, key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), 'android', Date.now());
  db.close();
  let counter = 0;
  return {
    keyId,
    sign(payload) {
      counter++;
      const n = Buffer.alloc(4);
      n.writeUInt32BE(counter);
      const signature = crypto.sign('sha256', Buffer.concat([Buffer.from('drivezzz-android-1'), n, sha('sha256', Buffer.from(payload))]), key.privateKey);
      return Buffer.concat([n, signature]).toString('base64');
    },
  };
}

// The whole wizard, the way the app goes through it.
async function readChip(c, passport = state.passport(), { wrongChip = false } = {}) {
  const ch = await c.post('/api/checks/challenge', { kind: 'chip' });
  const signature = state.signChallenge(Buffer.from(ch.nonce, 'base64'), wrongChip ? crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey : undefined);
  return c.post('/api/checks/chip', { challengeId: ch.id, sod: passport.sod.toString('base64'), dg1: passport.dg1.toString('base64'), dg15: passport.dg15.toString('base64'), aaSignature: signature.toString('base64') });
}
async function face(c, { score = 0.62, key, passport = state.passport() } = {}) {
  const ch = await c.post('/api/checks/challenge', { kind: 'face' });
  const payload = JSON.stringify({ v: 1, challengeId: ch.id, score, live: true, steps: ch.steps, model: 'sface-2021dec', dg1: sha('sha256', passport.dg1).toString('hex'), at: Date.now() });
  return c.post('/api/checks/face', { payload, ...(key ? { keyId: key.keyId, assertion: key.sign(payload) } : {}) });
}
const hex = (v) => sha('sha256', Buffer.from(v)).toString('hex');
const signedBy = (key, lines) => (key ? { 'X-Attest-Key': key.keyId, 'X-Attest-Assertion': key.sign([...lines, hex(photo)].join('\n')) } : {});
// A document the way the app sends it: from the camera, read on the phone, and signed when it has a key.
function card(c, kind, number, expires, text, { key, camera = true, signedText = text } = {}) {
  const flag = camera ? '1' : '0';
  return c.upload(`/api/checks/document?kind=${kind}&number=${number}&expires=${expires}&camera=${flag}&text=${encodeURIComponent(text)}`, photo,
    signedBy(key, ['drivezzz-doc-1', kind, number, expires, flag, hex(signedText)]));
}
// The car's back photo, with what the phone read on it.
const backPhoto = (c, read, { key, carId = c.carId } = {}) => c.upload(`/api/cars/${carId}/photos?kind=back&read=${encodeURIComponent(read)}`, photo,
  signedBy(key, ['drivezzz-plate-1', carId, hex(read)]));
// Everyone their own ID, for tests about something else: the same ID twice waits for a person.
const ownId = () => ({ passport: state.passport({ number: `P${crypto.randomInt(1e7, 1e8)}` }) });
const CARD_TEXT = (number) => `CHAUFFEURSKAART TAXI Bruijn W.L. ${number} 01-06-2030`;
const PERMIT_TEXT = (number) => `VERGUNNING TAXIVERVOER Taxi De Bruijn ${number}`;
async function everything(c, opts = {}) {
  assert.equal((await c.post('/api/checks/consent', { version: 1 })).status, 200);
  const chip = await readChip(c, opts.passport);
  assert.equal(chip.status, 200, JSON.stringify(chip));
  const key = opts.android ? androidKey(c.id) : attestKey(c.id);
  c.key = key;
  const f = await face(c, { key, ...opts });
  assert.equal(f.status, 200, JSON.stringify(f));
  const number = opts.card ?? `NL${crypto.randomInt(1e6, 1e7)}`;
  assert.equal((await card(c, 'chauffeurskaart', number, '2030-06-01', CARD_TEXT(number), { key })).status, 200);
  const permit = opts.permit ?? 'T123456';
  assert.equal((await card(c, 'permit', permit, '', PERMIT_TEXT(permit), { key })).status, 200);
  assert.equal((await backPhoto(c, `TAXI ${c.plate.replace(/(..)(...)(.)/, '$1-$2-$3')}`, { key })).status, 200);
  return c.post('/api/checks/kvk', { number: opts.kvk ?? '1234 5678' });
}

test('a car in the Netherlands needs the checks; everything checking out approves it by itself', async () => {
  const d = await driver();
  const first = await d.post('/api/driver/online', AMS);
  assert.equal(first.status, 409);
  assert.equal(first.code, 'need_checks');
  assert.deepEqual(first.missing, ['consent', 'id', 'face', 'chauffeurskaart', 'permit', 'kvk']);
  const done = await everything(d);
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(done.checks.status, 'approved');
  assert.equal(done.checks.verified, true);
  assert.equal(done.checks.id.surname, 'DE BRUIJN');
  assert.equal(done.checks.id.birthDate, '1965-03-10');
  assert.equal(done.checks.kvk.name, 'Taxi De Bruijn');
  // Nothing of the optional data (the BSN on older Dutch documents) is anywhere.
  assert.ok(!JSON.stringify(done).includes('99999999'));
  const on = await d.post('/api/driver/online', AMS);
  assert.equal(on.status, 200, JSON.stringify(on));
  assert.equal(on.driver.verified, true);
  // Riders see "Verified".
  const r = client(srv.base);
  await r.start();
  assert.equal((await r.get(`/api/drivers/${d.id}`)).driver.verified, true);
  // The admin panel has it, approved by itself.
  const list = await admin.get('/admin/api/checks?filter=approved');
  assert.ok(list.checks.some((x) => x.user_id === d.id && x.auto === 1));
});

test('an Android phone’s signatures count as an iPhone’s: everything checking out approves it by itself', async () => {
  const d = await driver();
  const done = await everything(d, { android: true, ...ownId() });
  assert.equal(done.checks.status, 'approved', JSON.stringify(done.checks.open));
  assert.deepEqual(done.checks.open, []);
  // A signature sent again (the same counter) doesn't count.
  const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'));
  const row = db.prepare('SELECT counter, environment FROM attest_keys WHERE key_id = ?').get(d.key.keyId);
  db.close();
  assert.equal(row.environment, 'android');
  assert.ok(row.counter >= 4);
});

test('a car that isn’t a registered taxi can’t drive in the Netherlands, a motor needs nothing', async () => {
  const d = await driver('NT222B');
  await everything(d);
  const on = await d.post('/api/driver/online', AMS);
  assert.equal(on.status, 409);
  assert.match(on.error, /isn’t registered as a taxi/);
  const m = await driver('MO333C', 'motor');
  assert.equal((await m.post('/api/driver/online', AMS)).status, 200);
});

test('a motor with a sidecar still takes one passenger', async () => {
  const m = await driver('MO333C', 'motor');
  const found = await m.get('/api/plates/SC666F');
  assert.equal(found.car.vehicle, 'motor');
  assert.equal(found.car.seats, 1);
});

test('only in the Netherlands: no going online or ordering elsewhere', async () => {
  const m = await driver('MO333C', 'motor');
  const away = await m.post('/api/driver/online', BRUSSELS);
  assert.equal(away.status, 409);
  assert.equal(away.code, 'not_here');
  const r = client(srv.base);
  await r.start();
  const order = await r.post('/api/rides', { pickup: { ...BRUSSELS, label: 'P' }, dropoff: { lat: 50.86, lng: 4.36, label: 'D' }, passengers: 1, coin: 'sol' });
  assert.equal(order.code, 'not_here');
});

test('anything that doesn’t check out waits for a person, who decides', async () => {
  // A low face match without App Attest: two reasons.
  const d = await driver();
  assert.equal((await d.post('/api/checks/consent', { version: 1 })).status, 200);
  assert.equal((await readChip(d)).status, 200);
  assert.equal((await face(d, { score: 0.21 })).status, 200);
  await card(d, 'chauffeurskaart', 'NL7654321', '2030-06-01', 'CHAUFFEURSKAART Jansen');
  await card(d, 'permit', 'T654321', '', 'VERGUNNING');
  const k = await d.post('/api/checks/kvk', { number: '87654321' });
  assert.equal(k.checks.status, 'review');
  // The driver only hears that something waits for review: never why, and nothing is asked for again by itself (Pieter,
  // 8 November 2026).
  assert.deepEqual(k.checks.open, [
    'Your selfie is waiting for review.',
    'Your chauffeurskaart is waiting for review.',
    'Your taxi permit is waiting for review.',
    'Your KvK number is waiting for review.',
    'Your car’s number plate is waiting for review.',
  ]);
  // Outside the checks too, for Profile and My page: nothing for the driver to do.
  const own = (await d.get('/api/driver')).driver.checks;
  assert.deepEqual(own, { status: 'review', open: 0, again: null });
  // Only a person's look is left: said plainly, not the checks again.
  const waiting = await d.post('/api/driver/online', AMS);
  assert.equal(waiting.code, 'checks_review');
  assert.equal(waiting.documents, 1);
  // This driver's car had no back photo read either.
  assert.equal(waiting.plate, 1);
  assert.match(waiting.error, /A person is checking your documents and the number plate .* That’s usually done within 24 hours/);
  const seen = await admin.get(`/admin/api/checks/${d.id}`);
  // The panel shows what the app sent, as it was sent, and what the chip gave.
  assert.equal(seen.check.surname, 'DE BRUIJN');
  assert.equal(seen.check.birth_date, '1965-03-10');
  assert.equal(seen.check.chip_signed, 1);
  assert.equal(seen.check.face_score, 0.21);
  assert.deepEqual(seen.signingKeys, [], 'no phone of theirs signs: the panel says so');
  assert.equal(seen.check.face_live, 1);
  assert.equal(seen.check.face_attested, 0);
  assert.equal(seen.check.ck_number, 'NL7654321');
  assert.equal(seen.check.ck_expires, '2030-06-01');
  assert.equal(seen.check.ck_text, 'CHAUFFEURSKAART Jansen');
  assert.equal(seen.check.ck_camera, 1);
  assert.equal(seen.check.permit_number, 'T654321');
  assert.equal(seen.check.permit_expires, null);
  assert.equal(seen.check.permit_text, 'VERGUNNING');
  assert.equal(seen.check.kvk_number, '87654321');
  assert.deepEqual(seen.check.files, { ck: true, permit: true, face: false });
  assert.equal(seen.check.doc_hash, undefined);
  const reasons = seen.check.review_reasons.join(' | ');
  assert.match(reasons, /Face match 21/);
  assert.match(reasons, /App Attest/);
  assert.match(reasons, /surname isn’t on the chauffeurskaart/);
  assert.match(reasons, /KvK number not found/);
  // The same ID is already approved elsewhere (the first test's passport).
  assert.match(reasons, /same ID is approved/);
  const img = await fetch(`${srv.base}/admin/api/checks/${d.id}/file/ck`, { headers: { Cookie: (await adminCookie()) } });
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  // Declined: the driver sees why, and can't drive.
  assert.equal((await admin.post(`/admin/api/checks/${d.id}`, { decision: 'decline', note: 'The chauffeurskaart is someone else’s.' })).status, 200);
  const declined = await d.get('/api/checks');
  assert.equal(declined.checks.status, 'declined');
  assert.equal(declined.checks.note, 'The chauffeurskaart is someone else’s.');
  assert.match((await d.post('/api/driver/online', AMS)).error, /wasn’t approved/);
  // A person can also say yes despite the reasons: then every row shows done, and nothing is open.
  assert.equal((await admin.post(`/admin/api/checks/${d.id}`, { decision: 'approve' })).status, 200);
  const approved = (await d.get('/api/checks')).checks;
  assert.deepEqual(Object.values(approved.items).filter((v) => v === 'waiting'), []);
  assert.deepEqual(approved.open, []);
  assert.equal((await d.post('/api/driver/online', AMS)).status, 200);
});

test('a person asking for one thing again: the app hears what and why, and sending it in checks it again', async () => {
  const d = await driver();
  await everything(d, ownId());
  assert.equal((await d.get('/api/checks')).checks.status, 'approved');
  assert.equal((await admin.post(`/admin/api/checks/${d.id}`, { decision: 'again:permit', note: 'The photo is blurred.' })).status, 200);
  const asked = (await d.get('/api/checks')).checks;
  assert.equal(asked.status, 'started');
  assert.equal(asked.again, 'permit');
  assert.equal(asked.note, 'The photo is blurred.');
  assert.equal(asked.items.permit, 'missing');
  assert.equal(asked.items.chauffeurskaart, 'done');
  assert.equal(asked.verified, false);
  // Only what was asked for: not what a person already looked at.
  assert.deepEqual(asked.open, []);
  assert.deepEqual((await d.get('/api/driver')).driver.checks, { status: 'started', open: 0, again: 'permit' });
  // Sent again, everything's in: approved by itself, and nothing is asked any more.
  const back = await card(d, 'permit', 'T123456', '', PERMIT_TEXT('T123456'), { key: d.key });
  assert.equal(back.checks.status, 'approved');
  assert.equal(back.checks.again, null);
  assert.equal(back.checks.note, null);
  assert.equal(back.checks.verified, true);
});

test('a row that checked out is locked in the app, unless it runs out within 30 days', async () => {
  const d = await driver();
  const done = await everything(d, ownId());
  assert.equal(done.checks.status, 'approved');
  assert.deepEqual(done.checks.renew, []);
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const [y, m, day] = soon.split('-');
  const number = 'NL7777123';
  const renewed = await card(d, 'chauffeurskaart', number, soon, `CHAUFFEURSKAART TAXI Bruijn W.L. ${number} ${day}-${m}-${y}`, { key: d.key });
  assert.equal(renewed.checks.items.chauffeurskaart, 'done');
  assert.deepEqual(renewed.checks.renew, ['chauffeurskaart']);
});

const reasonsFor = async (d) => (await admin.get(`/admin/api/checks/${d.id}`)).check.review_reasons.join(' | ');

test('a scan that can’t be confirmed by itself goes to a person, with the reason', async () => {
  // Sent by hand, not by the real app, and picked from the library.
  const d = await driver();
  await everything(d, ownId());
  const number = 'NL3333333';
  await card(d, 'chauffeurskaart', number, '2030-06-01', CARD_TEXT(number), { camera: false });
  let reasons = await reasonsFor(d);
  assert.match(reasons, /chauffeurskaart wasn’t signed by the real app/);
  assert.match(reasons, /chauffeurskaart came from the photo library/);
  assert.equal((await d.get('/api/checks')).checks.items.chauffeurskaart, 'waiting');
  // A signature over something else counts for nothing.
  await card(d, 'chauffeurskaart', number, '2030-06-01', CARD_TEXT(number), { key: d.key, signedText: 'something else' });
  assert.match(await reasonsFor(d), /wasn’t signed by the real app/);
  // A number or a date typed over what the scan read.
  await card(d, 'chauffeurskaart', 'NL4444444', '2031-06-01', CARD_TEXT(number), { key: d.key });
  reasons = await reasonsFor(d);
  assert.match(reasons, /chauffeurskaart’s number isn’t what the scan read/);
  assert.match(reasons, /chauffeurskaart’s date isn’t what the scan read/);
  // No card lasts longer than 5 years.
  await card(d, 'chauffeurskaart', number, '2039-06-01', `CHAUFFEURSKAART Bruijn ${number} 01-06-2039`, { key: d.key });
  assert.match(await reasonsFor(d), /a card lasts 5 years/);
  // Not a chauffeurskaart at all.
  await card(d, 'chauffeurskaart', number, '2030-06-01', `SUPERMARKT BONUSKAART Bruijn ${number} 01-06-2030`, { key: d.key });
  assert.match(await reasonsFor(d), /scan doesn’t say what it is/);
  // Put right, it approves by itself.
  const right = await card(d, 'chauffeurskaart', number, '2030-06-01', CARD_TEXT(number), { key: d.key });
  assert.equal(right.checks.status, 'approved');
});

test('a sent document that doesn’t check out says it’s waiting for review, and is only asked for again by a person', async () => {
  const d = await driver();
  assert.equal((await d.post('/api/checks/consent', { version: 1 })).status, 200);
  const id = ownId();
  assert.equal((await readChip(d, id.passport)).status, 200);
  d.key = attestKey(d.id);
  assert.equal((await face(d, { key: d.key, ...id })).status, 200);
  const number = 'NL8888123';
  // What the phone read misses the number and the date (the date left as the form gave it, today): straight after sending it says
  // it's waiting for review, never to photograph it again (Pieter: "only after review").
  const today = new Date().toISOString().slice(0, 10);
  const first = (await card(d, 'permit', 'T135790', today, 'VERGUNNING TAXIVERVOER', { key: d.key })).checks;
  assert.equal(first.status, 'started');
  assert.deepEqual(first.open, ['Your taxi permit is waiting for review.']);
  assert.equal(first.retake, undefined);
  assert.equal(first.items.permit, 'waiting');
  assert.deepEqual((await d.get('/api/driver')).driver.checks, { status: 'started', open: 0, again: null });
  // Sent again, the same: still waiting for review.
  const second = (await card(d, 'permit', 'T135790', today, 'VERGUNNING TAXIVERVOER', { key: d.key })).checks;
  assert.deepEqual(second.open, ['Your taxi permit is waiting for review.']);
  // Everything in: a person has it.
  assert.equal((await card(d, 'chauffeurskaart', number, '2030-06-01', CARD_TEXT(number), { key: d.key })).status, 200);
  assert.equal((await backPhoto(d, `TAXI ${d.plate.replace(/(..)(...)(.)/, '$1-$2-$3')}`, { key: d.key })).status, 200);
  const all = (await d.post('/api/checks/kvk', { number: '12345678' })).checks;
  assert.equal(all.status, 'review');
  assert.deepEqual(all.open, ['Your taxi permit is waiting for review.']);
  // The panel has the reasons.
  assert.match(await reasonsFor(d), /taxi permit’s number isn’t what the scan read/);
  assert.match(await reasonsFor(d), /taxi permit’s date isn’t what the scan read/);
  // Going online says a person is checking, not why.
  const waiting = await d.post('/api/driver/online', AMS);
  assert.equal(waiting.code, 'checks_review');
  assert.equal(waiting.error, 'A person is checking your documents. That’s usually done within 24 hours, and you’ll hear when it is.');
  // A person asks for it again after review: that's what the app says then, with their note, and nothing else.
  assert.equal((await admin.post(`/admin/api/checks/${d.id}`, { decision: 'again:permit', note: 'The photo is blurred.' })).status, 200);
  const asked = (await d.get('/api/checks')).checks;
  assert.equal(asked.again, 'permit');
  assert.equal(asked.note, 'The photo is blurred.');
  assert.deepEqual(asked.open, []);
  // Readable this time: approved by itself.
  const right = (await card(d, 'permit', 'T135790', '', PERMIT_TEXT('T135790'), { key: d.key })).checks;
  assert.equal(right.status, 'approved');
  assert.deepEqual(right.open, []);
});

test('a KvK number KvK doesn’t know waits for review, not asked for again by itself', async () => {
  const d = await driver();
  // A permit of its own: the same permit under another KvK number is a reason of its own.
  await everything(d, { kvk: '87654321', permit: 'T246802', ...ownId() });
  assert.deepEqual((await d.get('/api/checks')).checks.open, ['Your KvK number is waiting for review.']);
  assert.match(await reasonsFor(d), /KvK number not found/);
});

test('one card on two accounts, or a permit under another KvK number, goes to a person; drivers of one company are fine', async () => {
  const a = await driver();
  assert.equal((await everything(a, { card: 'NL5555555', ...ownId() })).checks.status, 'approved');
  const b = await driver();
  await everything(b, { card: 'NL5555555', ...ownId() });
  assert.match(await reasonsFor(b), new RegExp(`same chauffeurskaart is on account ${a.id}`));
  // The same permit and KvK number, as drivers of one taxi company have, isn't a reason. The second ID is.
  assert.doesNotMatch(await reasonsFor(b), /same permit/);
  const c = await driver();
  await everything(c, { card: 'NL6666666', kvk: '55556666', ...ownId() });
  assert.match(await reasonsFor(c), /same permit is on account/);
});

test('KvK: its name must be on the permit, one that ended waits, and one that didn’t answer is asked again', async () => {
  // Another of the business's names counts.
  const d = await driver();
  await everything(d, ownId());
  const other = await card(d, 'permit', 'T123456', '', 'VERGUNNING TAXIVERVOER HAAGSE RIT T123456', { key: d.key });
  assert.equal(other.checks.items.permit, 'done');
  await card(d, 'permit', 'T123456', '', 'VERGUNNING TAXIVERVOER Taxi Jansen T123456', { key: d.key });
  assert.match(await reasonsFor(d), /KvK’s name \(Taxi De Bruijn\) isn’t on the taxi permit/);
  // A registration that ended.
  const ended = await driver();
  await everything(ended, { kvk: '11112222', ...ownId() });
  assert.match(await reasonsFor(ended), /KvK registration has ended/);
  // KvK down: a person could look it up, but the job asks again and it passes by itself.
  const late = await driver();
  const down = await everything(late, { kvk: '55556666', ...ownId() });
  assert.equal(down.checks.status, 'review');
  assert.equal(down.checks.items.kvk, 'waiting');
  assert.match(await reasonsFor(late), /KvK couldn’t be asked/);
  kvkAnswers = true;
  assert.equal((await client(srv.base).post('/dev/tick')).status, 200);
  assert.doesNotMatch(await reasonsFor(late), /KvK couldn’t be asked/);
});

test('a typed plate isn’t enough: it must be on the car’s back photo, or a person looks, and the driver’s other car stays', async () => {
  const d = await driver();
  assert.equal((await everything(d, { permit: 'T777777', ...ownId() })).checks.status, 'approved');
  assert.equal((await d.post('/api/driver/online', AMS)).status, 200);
  assert.equal((await d.post('/api/driver/offline')).status, 200);
  // A second car, a real taxi, with a photo that doesn't show its plate.
  const second = await d.post('/api/cars', { plate: 'TX555E', vehicle: 'car', seats: 4, perKmCents: 100, perMinCents: 10, pickupPerKmCents: 20 });
  for (const kind of ['front', 'inside']) await d.upload(`/api/cars/${second.car.id}/photos?kind=${kind}`, photo);
  await backPhoto(d, 'TAXI 11-XX-22', { key: d.key, carId: second.car.id });
  assert.equal((await d.post(`/api/cars/${second.car.id}/activate`)).status, 200);
  // Only a person looking at the plate is left: said plainly, with what the driver can do meanwhile, not the checks again.
  const waits = await d.post('/api/driver/online', AMS);
  assert.equal(waits.code, 'checks_review');
  assert.equal(waits.plate, 1);
  assert.equal(waits.documents, 0);
  assert.match(waits.error, /A person is checking the number plate TX-555-E of your .*within 24 hours.*another vehicle that’s cleared/);
  // The car's page says so too, and the other car has nothing against it.
  const own = (await d.get('/api/driver')).driver.cars;
  assert.deepEqual(own.find((c) => c.id === second.car.id).hold, { code: 'plate', text: own.find((c) => c.id === second.car.id).hold.text, review: true });
  // Waiting for a person, without why (Pieter, 8 November 2026).
  assert.equal(own.find((c) => c.id === second.car.id).hold.text, 'A person is checking this car’s number plate. That’s usually done within 24 hours.');
  assert.equal(own.find((c) => c.id === d.carId).hold, null);
  // On the panel, though their checks stay approved.
  const list = await admin.get('/admin/api/checks?filter=review');
  const row = list.checks.find((x) => x.user_id === d.id);
  assert.equal(row.status, 'approved');
  assert.match(row.review_reasons.join(), /Plate .* wasn’t read/);
  assert.equal((await admin.get('/admin/api/overview')).checksOpen >= 1, true);
  // A hand-made request with the right text isn't the real app.
  await backPhoto(d, 'TX-555-E', { carId: second.car.id });
  assert.equal((await d.post('/api/driver/online', AMS)).code, 'checks_review');
  // The real app reading it passes by itself, a 5 read as an S too.
  await backPhoto(d, 'NL TX-SSS-E', { key: d.key, carId: second.car.id });
  assert.equal((await d.post('/api/driver/online', AMS)).status, 200);
  assert.equal((await d.get('/api/checks')).checks.status, 'approved');
  assert.ok(!(await admin.get('/admin/api/checks?filter=review')).checks.some((x) => x.user_id === d.id));
  // The other car still works, and a person can say yes for a photo that can't be read.
  assert.equal((await d.post('/api/driver/offline')).status, 200);
  await backPhoto(d, 'blurred', { key: d.key, carId: second.car.id });
  assert.equal((await d.post('/api/driver/online', AMS)).code, 'checks_review');
  assert.equal((await d.post(`/api/cars/${d.carId}/activate`)).status, 200);
  assert.equal((await d.post('/api/driver/online', AMS)).status, 200);
  assert.equal((await d.post('/api/driver/offline')).status, 200);
  assert.equal((await d.post(`/api/cars/${second.car.id}/activate`)).status, 200);
  assert.equal((await admin.post(`/admin/api/checks/${d.id}`, { decision: 'approve' })).status, 200);
  assert.equal((await d.get('/api/driver')).driver.cars.find((c) => c.id === second.car.id).hold, null);
  assert.equal((await d.post('/api/driver/online', AMS)).status, 200);
});

test('a taxi that was exported can’t drive, even if the RDW still says it’s insured', async () => {
  const d = await driver('EX444D');
  await everything(d, ownId());
  const on = await d.post('/api/driver/online', AMS);
  assert.equal(on.status, 409);
  assert.match(on.error, /exported/);
});

test('riders only get a car with a blue check, a motor needs none, and losing it takes a car off the road', async () => {
  const d = await driver();
  await everything(d, { permit: 'T888888', ...ownId() });
  const on = await d.post('/api/driver/online', AMS);
  assert.equal(on.status, 200, JSON.stringify(on));
  assert.equal((await d.patch('/api/driver', { allowsPlanning: true })).status, 200);
  const m = await driver('MB12CD', 'motor');
  assert.equal((await m.post('/api/driver/online', AMS)).status, 200);
  assert.equal((await m.patch('/api/driver', { allowsPlanning: true })).status, 200);
  const r = client(srv.base);
  await r.start();
  const shown = async () => (await r.get(`/api/drivers/nearby?lat=${AMS.lat}&lng=${AMS.lng}&radiusKm=10`)).drivers.map((x) => x.id);
  const planned = async () => {
    const q = await r.post('/api/quote', { pickup: { ...AMS, label: 'A' }, dropoff: { lat: 52.38, lng: 4.9, label: 'B' }, passengers: 1, pets: false, scheduledAt: Date.now() + 86_400_000 });
    return (q.offers ?? []).map((x) => x.id);
  };
  assert.ok((await shown()).includes(d.id));
  assert.ok((await planned()).includes(d.id));
  assert.ok((await shown()).includes(m.id), 'a motor needs no checks');

  assert.equal((await admin.post(`/admin/api/checks/${d.id}`, { decision: 'decline', note: 'Not valid.' })).status, 200);
  const after = await d.get('/api/driver');
  assert.equal(after.driver.verified, false);
  assert.equal(after.driver.online, false);
  assert.ok(!(await shown()).includes(d.id), 'off the map');
  assert.ok(!(await planned()).includes(d.id), 'and not planned either, offline or not');
  assert.ok((await planned()).includes(m.id));
  assert.equal((await d.post('/api/driver/online', AMS)).code, 'need_checks');
});

test('the pretend pass of a test server takes a pretend driver straight online, and a real taxi with its RDW rules', async () => {
  const fake = await startServer({ NL_CHECKS: '1', ONLY_NETHERLANDS: '1', CHECKS_FAKE: '1', RDW_URL: rdw.url });
  try {
    for (const [plate, seen] of [['TD1234', 'not in the register'], ['TX111A', 'a real taxi'], ['NT222B', 'a real plate that isn’t a taxi']]) {
      const c = client(fake.base);
      await c.start();
      await c.post('/api/driver/enable');
      const { car } = await c.post('/api/cars', { plate, vehicle: 'car', seats: 4, perKmCents: 100, perMinCents: 10, pickupPerKmCents: 20 });
      for (const kind of ['front', 'back', 'inside']) await c.upload(`/api/cars/${car.id}/photos?kind=${kind}`, photo);
      await c.post('/api/wallet/address', { coin: 'sol', address: newWallet() });
      assert.equal((await c.post('/api/checks/fake', { result: 'pass' })).checks.status, 'approved', seen);
      const on = await c.post('/api/driver/online', AMS);
      if (plate === 'NT222B') assert.match(on.error, /isn’t registered as a taxi/, seen);
      else assert.equal(on.status, 200, seen);
    }
  } finally { fake.stop(); }
});

test('the live server on a pretend chain does the real checks: only its own pretend drivers pass pretend, and older pretend passes go', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-live-'));
  const env = { NL_CHECKS: '1', ONLY_NETHERLANDS: '1', RDW_URL: rdw.url, DATA_DIR: path.join(data, 'data') };
  const ready = async (c, plate) => {
    await c.post('/api/driver/enable');
    const { car } = await c.post('/api/cars', { plate, vehicle: 'car', seats: 4, perKmCents: 100, perMinCents: 10, pickupPerKmCents: 20 });
    for (const kind of ['front', 'back', 'inside']) await c.upload(`/api/cars/${car.id}/photos?kind=${kind}`, photo);
    await c.post('/api/wallet/address', { coin: 'sol', address: newWallet() });
  };
  // Before: the live server let anyone pass pretend.
  const before = await startServer({ ...env, CHECKS_FAKE: '1' });
  const early = client(before.base);
  let token;
  try {
    ({ token } = await early.start());
    await ready(early, 'TD1111');
    assert.equal((await early.post('/api/checks/fake', { result: 'pass' })).checks.status, 'approved');
    assert.equal((await early.post('/api/driver/online', AMS)).status, 200);
  } finally { before.stop(); }
  // Now: PRETEND_CHAIN alone, as /etc/default/drivezzz has it.
  const live = await startServer({ ...env, ESCROW_FAKE: '', PRETEND_CHAIN: '1' });
  try {
    const was = client(live.base, early.deviceId);
    was.setToken(token);
    const checks = await was.get('/api/checks');
    assert.equal(checks.checks.status, 'none', 'the old pretend pass is gone');
    assert.equal(checks.checks.fake, false, 'and the app shows no test buttons');
    assert.equal((await was.get('/api/driver')).driver.verified, false);
    assert.equal((await was.post('/api/driver/online', AMS)).code, 'need_checks');
    // Through Cloudflare (or anything passing it on) there's no pretend pass.
    const someone = client(live.base);
    await someone.start();
    await ready(someone, 'TD2222');
    assert.equal((await someone.call('POST', '/api/checks/fake', { result: 'pass' }, { 'CF-Connecting-IP': '203.0.113.9' })).status, 404);
    assert.equal((await someone.call('POST', '/api/checks/fake', { result: 'pass' }, { 'X-Forwarded-For': '127.0.0.1' })).status, 404);
    // The server's own pretend driver, on this machine: passes, and its pretend plate counts. Behind helpers (WORKERS) the main
    // process can't tell where a request came from, so nobody does.
    const own = client(live.base);
    await own.start();
    await ready(own, 'TD3333');
    if (process.env.WORKERS) assert.equal((await own.post('/api/checks/fake', { result: 'pass' })).status, 404);
    else {
      assert.equal((await own.post('/api/checks/fake', { result: 'pass' })).checks.status, 'approved');
      assert.equal((await own.post('/api/driver/online', AMS)).status, 200);
    }
    // But a pretend plate without the pretend pass is a real plate that isn't in the register.
    assert.notEqual((await someone.post('/api/driver/online', AMS)).status, 200);
  } finally { live.stop(); }
  // On the real network nobody's pretend pass counts.
  const real = await startServer({ ...env, ESCROW_FAKE: '' });
  try {
    const db = new DatabaseSync(env.DATA_DIR + '/drivezzz.db', { readOnly: true });
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM driver_checks WHERE doc_hash LIKE 'fake-%'`).get().n, 0);
    db.close();
  } finally { real.stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('leaving the pretend chain: rides under way end, its escrows close by themselves, a finished ride stays, and only once', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-pretend-'));
  const env = { DATA_DIR: data, NL_CHECKS: '0', ONLY_NETHERLANDS: '0', CHECKS_FAKE: '0' };
  const open = () => new DatabaseSync(`${data}/drivezzz.db`);
  let db;
  const before = await startServer({ ...env, ESCROW_FAKE: '1' });
  try {
    db = open();
    const t = Date.now();
    db.exec(`INSERT INTO users (id, name, last_seen_at, created_at) VALUES ('dz-rider', 'R', ${t}, ${t}), ('dz-driver', 'D', ${t}, ${t})`);
    const ride = (id, status, coin) => db.prepare(`INSERT INTO rides (id, rider_id, driver_id, status, mode, coin, coin_units, eur_per_coin, max_cents, price_cents, created_at, pickup_lat, pickup_lng, pickup_label, dropoff_lat, dropoff_lng, dropoff_label, distance_m, duration_s)
      VALUES (?, 'dz-rider', 'dz-driver', ?, 'driver', ?, 100, 80, 500, 500, ${t}, 52, 4, 'a', 52, 4, 'b', 1000, 100)`).run(id, status, coin);
    const held = (id, rideId, status) => db.prepare(`INSERT INTO escrows (id, ride_id, coin, address, payer, driver_address, units, fee_units, eur_per_coin, status, created_at)
      VALUES (?, ?, 'sol', ?, 'p', 'd', 100, 1, 80, ?, ${t})`).run(id, rideId, `fake-${id}`, status);
    ride('r_going', 'accepted', 'sol'); held('e1', 'r_going', 'paid');
    ride('r_asked', 'awaiting_payment', 'sol'); held('e2', 'r_asked', 'requested');
    ride('r_done', 'completed', 'sol'); held('e3', 'r_done', 'paid');
    db.prepare(`INSERT INTO payouts (id, user_id, ride_id, kind, coin, units, eur_cents, status, due_at, created_at) VALUES ('po_1', 'dz-driver', 'r_done', 'payout', 'sol', 99, 490, 'held', ${t}, ${t})`).run();
    ride('r_cash', 'accepted', 'cash');
    db.close();
  } finally { before.stop(); }
  const real = await startServer({ ...env, ESCROW_FAKE: '' });
  try {
    db = open();
    const status = (id) => db.prepare('SELECT status FROM rides WHERE id = ?').get(id).status;
    assert.equal(status('r_going'), 'cancelled');
    assert.equal(status('r_asked'), 'cancelled');
    assert.equal(status('r_done'), 'completed', 'what was finished stays finished');
    assert.equal(status('r_cash'), 'accepted', 'a cash ride has no chain to leave');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM escrows WHERE status != 'settled'`).get().n, 0, 'nothing left for the chain jobs to choke on');
    assert.equal(db.prepare(`SELECT status FROM payouts WHERE id = 'po_1'`).get().status, 'cancelled');
    // And it was once: a ride under way on the real chain is never ended by a later start.
    db.exec(`UPDATE rides SET status = 'accepted' WHERE id = 'r_asked'`);
    db.close();
  } finally { real.stop(); }
  const again = await startServer({ ...env, ESCROW_FAKE: '' });
  try {
    db = open();
    assert.equal(db.prepare(`SELECT status FROM rides WHERE id = 'r_asked'`).get().status, 'accepted');
    db.close();
  } finally { again.stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('a ban follows the person: their ID read with a new account on a new phone bans that one too, and the phone', async () => {
  const who = { surname: 'BANNED<PERSON', given: 'TEST', birth: '800101' };
  // Proven on the first account: the chip, and a face that matches it.
  const a = await driver();
  await a.post('/api/checks/consent', { version: 1 });
  const first = state.passport({ ...who, number: 'BAN111111' });
  await readChip(a, first);
  await face(a, { passport: first, score: 0.7 });
  assert.equal((await admin.post(`/admin/api/users/${a.id}/ban`, { kind: 'permanent', reason: 'Drove off with a rider’s bag.' })).status, 200);
  // A renewed ID (another number), a new phone, a new account.
  const b = await driver();
  await b.post('/api/checks/consent', { version: 1 });
  assert.equal((await b.get('/api/standing')).ban, null, 'nobody knows who it is yet');
  await readChip(b, state.passport({ ...who, number: 'BAN222222' }));
  assert.equal((await b.get('/api/standing')).ban?.reason, 'Drove off with a rider’s bag.');
  assert.equal((await b.get('/api/driver')).code, 'banned');
  const db = new DatabaseSync(path.join(srv.dir, 'data', 'drivezzz.db'), { readOnly: true });
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM banned_devices WHERE device_id = ?').get(b.deviceId).n > 0, 'and its phone, for any account on it');
  db.close();
  // Lifting it frees both.
  assert.equal((await admin.post(`/admin/api/users/${a.id}/unban`, { why: 'Test' })).status, 200);
  assert.equal((await b.get('/api/standing')).ban, null);

  // Someone who read another person's ID, with a face that didn't match, and was banned: the real person isn't.
  const someone = { surname: 'NOT<PROVEN', given: 'TEST', birth: '810202' };
  const x = await driver();
  await x.post('/api/checks/consent', { version: 1 });
  const theirs = state.passport({ ...someone, number: 'NPR111111' });
  await readChip(x, theirs);
  await face(x, { passport: theirs, score: 0.1 });
  assert.equal((await admin.post(`/admin/api/users/${x.id}/ban`, { kind: 'permanent', reason: 'Used someone else’s ID.' })).status, 200);
  const y = await driver();
  await y.post('/api/checks/consent', { version: 1 });
  await readChip(y, state.passport({ ...someone, number: 'NPR222222' }));
  assert.equal((await y.get('/api/standing')).ban, null, 'not banned for what someone with their ID did');
});

let cookie;
async function adminCookie() {
  if (cookie) return cookie;
  const r = await fetch(`${srv.base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'test-admin-new' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  return cookie;
}

test('a chip that isn’t signed by a trusted state, or doesn’t sign our challenge, isn’t taken as real', async () => {
  const d = await driver();
  await d.post('/api/checks/consent', { version: 1 });
  // DG1 changed after the state signed it.
  const p = state.passport({ surname: 'FAKE', given: 'NAME', number: 'XX1234567' });
  const tampered = { ...p, dg1: state.passport({ surname: 'OTHER', given: 'NAME', number: 'XX1234567' }).dg1 };
  const bad = await readChip(d, tampered);
  assert.equal(bad.chip.signed, false);
  assert.equal(bad.checks.items.id, 'waiting');
  // Signed, but the answer to our challenge came from another key: a copy of the data, not the chip.
  const copy = await readChip(d, state.passport({ number: 'YY1234567' }), { wrongChip: true });
  assert.equal(copy.chip.signed, true);
  assert.equal(copy.chip.live, false);
  assert.equal(copy.checks.items.id, 'waiting');
  // A face result for another chip doesn't count.
  const other = await face(d, { passport: state.passport({ number: 'ZZ1234567' }) });
  assert.equal(other.code, 'chip_first');
});

test('documents that ran out are refused, and the account taking its checks with it', async () => {
  const d = await driver();
  await d.post('/api/checks/consent', { version: 1 });
  const old = await card(d, 'chauffeurskaart', 'NL1111111', '2020-01-01', 'Bruijn');
  assert.equal(old.code, 'expired');
  const expiredId = await readChip(d, state.passport({ number: 'OLD123456', expiry: '200101' }));
  assert.equal(expiredId.code, 'id_expired');
  await everything(d);
  assert.equal((await d.del('/api/me')).status, 200);
  assert.equal((await admin.get(`/admin/api/checks/${d.id}`)).status, 404);
});
