// The whole money checklist of docs/escrow.md (section 15), with real transactions on devnet: the server, the contract and
// wallets signing, every amount checked on the chain to the smallest unit. Run on the server against a DEV=1 JOBS=0 instance:
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node test/checklist.mjs http://127.0.0.1:8081
// (the admin login from src/make-admin.js on that instance). Takes about 15 minutes: the 30-day refund waits out the contract's
// 10-minute devnet timer. Never point this at the live server: it moves the clock and bans people.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { b58, unb58, ix, keypair, pda, send, loadKeypair, balance, tokenBalance, tokenAccountOf, rpc, sleep, account, ATA, SYSTEM, TOKEN, u64 } from './sol.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8081';
if (/s3rver\.nl|:8080/.test(BASE)) throw new Error('never the live server');
const dir = path.join(os.homedir(), 'devnet');
const key = (n) => loadKeypair(path.join(dir, `${n}.json`));
const rider = key('rider'), driverKey = key('driver'), stranger = key('stranger'), serverKey = key('server'), deployer = key('deployer');
const MINT = key('test-usdc-mint').pub;
const FEE = unb58('6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN');

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => { cond ? passed++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
const eq = (name, got, want) => ok(name, got === want, got === want ? '' : `got ${got}, wanted ${want}`);
const part = (title) => console.log(`\n--- ${title}`);

const dev = (p) => fetch(BASE + p, { method: 'POST' }).then((r) => r.json());
const clock = (ms) => dev(`/dev/clock?ms=${ms}`);
const HOUR = 3600_000, MIN = 60_000;
const serverNow = async () => (await clock(0)).now;

function client(device = `cl-${crypto.randomBytes(5).toString('hex')}`) {
  let token;
  const call = async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-device-id': device, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  return {
    device, get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b = {}) => call('PATCH', p, b),
    upload: (p, bytes) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-device-id': device, authorization: `Bearer ${token}` }, body: bytes }),
    async start() { const r = await call('POST', '/api/auth/continue', {}); token = r.token; this.id = r.user.id; return r; },
  };
}

let adminCookie = '';
const admin = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie: adminCookie }, body: body && JSON.stringify(body) });
  const set = r.headers.get('set-cookie');
  if (set) adminCookie = set.split(';')[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

const at = { lat: 52.37, lng: 4.89 };
const pickup = { ...at, label: 'Dam, Amsterdam' };
const dropoff = { lat: 52.36, lng: 4.88, label: 'Museumplein, Amsterdam' };

// ---------- wallets ----------

const sign = (signer, tx) => {
  const message = tx.subarray(1 + 64 * tx[0]);
  crypto.sign(null, message, crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), signer.seed]), format: 'der', type: 'pkcs8' })).copy(tx, 1);
  return tx;
};
const landed = async (signature) => {
  for (let i = 0; i < 60; i++) {
    const st = (await rpc('getSignatureStatuses', [[signature]])).value[0];
    if (st?.err) throw new Error(`failed on the chain: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return signature;
    await sleep(800);
  }
  throw new Error('not confirmed');
};
const sendRaw = (tx) => rpc('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
const payment = async (r, id, signer) => {
  const res = await r.post(`/api/rides/${id}/pay`, { account: signer.address });
  if (!res.transaction) throw new Error(`no transaction: ${JSON.stringify(res).slice(0, 200)}`);
  return Buffer.from(res.transaction, 'base64');
};
// The way the app does it: asks for the payment, the wallet signs, the server sends it on.
const pays = async (r, id, signer = rider) => {
  // What someone would do on "the network is busy" or "took too long": pay again.
  for (let attempt = 0; ; attempt++) {
    const sent = await r.post(`/api/rides/${id}/pay/send`, { transaction: sign(signer, await payment(r, id, signer)).toString('base64') });
    if (sent.ok) return seen(r, id);
    if (attempt >= 4 || !['chain_down', 'too_slow'].includes(sent.code)) throw new Error(`not sent: ${JSON.stringify(sent).slice(0, 200)}`);
    await sleep(5000);
  }
};
// The way a wallet does it with a Solana Pay link: asks the server itself, sends it itself.
const paysByLink = async (r, id, signer = rider) => {
  const url = decodeURIComponent((await r.get(`/api/rides/${id}`)).ride.payUrl.slice('solana:'.length));
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: signer.address }) }).then((x) => x.json());
  await landed(await sendRaw(sign(signer, Buffer.from(res.transaction, 'base64'))));
  return seen(r, id);
};
const sendSigned = async (r, id, tx) => {
  const sent = await r.post(`/api/rides/${id}/pay/send`, { transaction: tx.toString('base64') });
  if (!sent.ok) throw new Error(`not sent: ${JSON.stringify(sent).slice(0, 200)}`);
};
const seen = async (r, id) => {
  let ride;
  for (let i = 0; i < 30; i++) {
    await dev('/dev/payments');
    ride = (await r.get(`/api/rides/${id}`)).ride;
    if (ride.status !== 'awaiting_payment') return ride;
    await sleep(1500);
  }
  return ride;
};
const settled = async (r, id) => {
  let ride;
  for (let i = 0; i < 30; i++) {
    await dev('/dev/money');
    ride = (await r.get(`/api/rides/${id}`)).ride;
    if (ride.escrow?.status === 'settled') return ride;
    await sleep(2000);
  }
  return ride;
};
const tokens = async (owner) => (await tokenBalance(tokenAccountOf(owner, MINT))) ?? 0n;
const SOL = 'sol', USDC = 'usdc-sol';
const name = (coin) => (coin === SOL ? 'SOL' : 'USDC');
const decimals = (coin) => (coin === SOL ? 9 : 6);
const units = (coin, text) => BigInt(Math.round(Number(text) * 10 ** decimals(coin)));

async function snapshot(coin) {
  const riderSol = await balance(rider);
  return {
    riderSol, serverSol: await balance(serverKey),
    rider: coin === SOL ? riderSol : await tokens(rider.pub),
    driver: coin === SOL ? await balance(driverKey) : await tokens(driverKey.pub),
    fee: coin === SOL ? await balance(FEE) : await tokens(FEE),
  };
}
// What a rider pays on top of a ride, whichever coin: two base fees of 5000 lamports (paying, and settling through the allowance),
// plus the priority fee on paying, which follows the network: 600 to 12,000 lamports. A wallet paying by itself may send none.
const feesOnly = (n) => n >= 10_000n && n <= 22_000n;
// Exactly what each side should have gained: a whole ride from before paying to after settling.
function checkMoney(title, coin, before, after, { toDriver, toFee, total }) {
  const riderOut = toDriver + toFee;
  eq(`${title}: driver got exactly the right amount`, after.driver - before.driver, toDriver);
  eq(`${title}: fee address got exactly the right amount`, after.fee - before.fee, toFee);
  if (coin === SOL) {
    ok(`${title}: rider lost exactly that and the network fees, deposit back`, feesOnly(before.rider - after.rider - riderOut), `${before.rider - after.rider - riderOut}`);
  } else {
    eq(`${title}: rider lost exactly that in USDC`, before.rider - after.rider, riderOut);
    ok(`${title}: rider's SOL down by the network fees only, deposit back`, feesOnly(before.riderSol - after.riderSol), `${before.riderSol - after.riderSol}`);
  }
  // The contract gives the base fee back, not the priority fee: 300 to 6000 lamports per outcome, and two for a leftover.
  const serverPaid = before.serverSol - after.serverSol;
  ok(`${title}: the server's wallet paid a priority fee at most`, serverPaid >= 0n && serverPaid <= 12_000n, `${serverPaid}`);
  ok(`${title}: all of it accounted for`, toDriver + toFee <= total);
}
const closed = async (ride) => ok(`escrow account closed on the chain`, (await account(unb58(ride.escrow.address))) === null);

// ---------- people ----------

const d = client(), r = client();
const ready = async () => {
  await r.post('/api/location', at);
  return d.post('/api/driver/online', at);
};
// A ride for now, offered to our driver and accepted: it's waiting to be paid.
async function rideNow(coin, rc = r) {
  await ready();
  const made = await rc.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'driver', driverId: d.id, coin });
  if (!made.ride) throw new Error(`order: ${JSON.stringify(made).slice(0, 200)}`);
  const accepted = await d.post(`/api/rides/${made.ride.id}/accept`);
  if (accepted.ride?.status !== 'awaiting_payment') throw new Error(`accept: ${JSON.stringify(accepted).slice(0, 200)}`);
  return made.ride.id;
}
async function planned(coin, inMs) {
  await ready();
  const made = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'driver', driverId: d.id, coin, scheduledAt: (await serverNow()) + inMs });
  if (made.ride?.status !== 'open') throw new Error(`planned: ${JSON.stringify(made).slice(0, 200)}`);
  const claimed = await d.post(`/api/rides/${made.ride.id}/claim`);
  if (claimed.ride?.status !== 'awaiting_payment') throw new Error(`claim: ${JSON.stringify(claimed).slice(0, 200)}`);
  return made.ride.id;
}
async function checkIn(id) {
  await d.post('/api/location', { ...at, driving: true });
  await r.post('/api/location', at);
  const res = await r.post(`/api/rides/${id}/check-in`, { ...at, plateChecked: true });
  if (res.ride?.status !== 'riding') throw new Error(`check-in: ${JSON.stringify(res).slice(0, 200)}`);
}
async function checkOut(id, { riderThere = true } = {}) {
  await d.post('/api/location', { ...dropoff, driving: true });
  if (riderThere) await r.post('/api/location', dropoff);
  return d.post(`/api/rides/${id}/check-out`, dropoff);
}

// The admin stepping in by themselves, without an appeal: hold, release, and settling right now. Every amount on the chain.
async function manual(coin) {
  const C = name(coin);
  const finished = async () => {
    const id = await rideNow(coin);
    const before = await snapshot(coin);
    await pays(r, id);
    await checkIn(id);
    await checkOut(id);
    return { id, before };
  };
  const allOf = (ride) => ({ total: units(coin, ride.escrow.amount), driver: units(coin, ride.escrow.driverAmount), fee: units(coin, ride.escrow.feeAmount) });

  part(`${C}: the admin holds a ride`);
  let { id, before } = await finished();
  eq(`${C}: holds it`, (await admin('POST', `/admin/api/rides/${id}/hold`, {})).ok, true);
  eq(`${C}: the rider sees it's being checked`, (await r.get(`/api/rides/${id}`)).ride.escrow.onHold, true);
  await clock(25 * HOUR);
  await dev('/dev/money');
  await sleep(6000);
  await dev('/dev/money');
  eq(`${C}: 24 hours are over, and it's still in escrow`, (await r.get(`/api/rides/${id}`)).ride.escrow.status, 'paid');
  eq(`${C}: the driver got nothing`, (await snapshot(coin)).driver, before.driver);
  const page = await admin('GET', '/admin/api/escrow');
  eq(`${C}: the money page shows it on hold`, page.open.find((e) => e.rideId === id)?.onHold, true);
  eq(`${C}: releases it`, (await admin('POST', `/admin/api/rides/${id}/hold`, { hold: false })).ok, true);
  let done = await settled(r, id);
  eq(`${C}: released, it goes on as planned`, done.escrow?.outcome, 'payout');
  let after = await snapshot(coin);
  let money = allOf(done);
  checkMoney(`${C} held, then paid out`, coin, before, after, { toDriver: money.driver, toFee: money.fee, total: money.total });
  await closed(done);
  eq(`${C}: too late to hold once it's gone`, (await admin('POST', `/admin/api/rides/${id}/hold`, {})).code, 'settled');
  eq(`${C}: too late to refund once it's gone`, (await admin('POST', `/admin/api/rides/${id}/decide`, { decision: 'refund_rider' })).code, 'settled');

  part(`${C}: the admin refunds a ride on hold, with no appeal`);
  ({ id, before } = await finished());
  await admin('POST', `/admin/api/rides/${id}/hold`, {});
  eq(`${C}: refunds it`, (await admin('POST', `/admin/api/rides/${id}/decide`, { decision: 'refund_rider', answer: 'Checked it.' })).ok, true);
  done = await settled(r, id);
  eq(`${C}: refunded right away, hold or not`, done.escrow?.outcome, 'refund');
  after = await snapshot(coin);
  checkMoney(`${C} admin refund`, coin, before, after, { toDriver: 0n, toFee: 0n, total: units(coin, done.escrow.amount) });
  await closed(done);

  part(`${C}: the admin splits a ride still under way`);
  id = await rideNow(coin);
  before = await snapshot(coin);
  await pays(r, id);
  await checkIn(id);
  eq(`${C}: splits it`, (await admin('POST', `/admin/api/rides/${id}/decide`, { decision: 'split', answer: 'Checked it.' })).ok, true);
  eq(`${C}: the ride ends there`, (await r.get(`/api/rides/${id}`)).ride.status, 'cancelled');
  done = await settled(r, id);
  eq(`${C}: split right away, not in 24 hours`, done.escrow?.outcome, 'split');
  after = await snapshot(coin);
  checkMoney(`${C} admin 50/50`, coin, before, after, { toDriver: units(coin, done.escrow.amount) / 2n, toFee: 0n, total: units(coin, done.escrow.amount) });
  await closed(done);

  part(`${C}: the admin pays out before the 24 hours`);
  ({ id, before } = await finished());
  eq(`${C}: pays it now`, (await admin('POST', `/admin/api/rides/${id}/decide`, { decision: 'pay_driver' })).ok, true);
  done = await settled(r, id);
  eq(`${C}: paid right away`, done.escrow?.outcome, 'payout');
  after = await snapshot(coin);
  money = allOf(done);
  checkMoney(`${C} admin pay out`, coin, before, after, { toDriver: money.driver, toFee: money.fee, total: money.total });
  await closed(done);
  eq(`${C}: the log has it`, JSON.stringify(await admin('GET', '/admin/api/log')).includes('escrow_pay_driver'), true);
}

async function main() {
  part('Getting ready');
  for (const [who, want] of [[rider, 500_000_000n], [driverKey, 50_000_000n], [stranger, 100_000_000n]]) {
    const have = await balance(who);
    if (have < want) await send([ix(SYSTEM, [[deployer, 1, 1], [who, 0, 1]], Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(want - have)]))], [deployer]);
  }
  eq('admin: logs in', (await admin('POST', '/admin/api/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })).ok, true);
  const newPassword = crypto.randomBytes(18).toString('base64url');
  eq('admin: nothing works before the first password is changed', (await admin('GET', '/admin/api/escrow')).code, 'change_password');
  eq('admin: changes the first password', (await admin('POST', '/admin/api/password', { current: process.env.ADMIN_PASSWORD, password: newPassword })).ok, true);
  const setup = await admin('GET', '/admin/api/escrow');
  eq('money page: the contract is set up as the server expects', setup.problem, null);
  ok('money page: shows the program and the server key', Boolean(setup.programId && setup.serverKey), setup.programId);

  await d.start(); await r.start();
  await d.post('/api/driver/enable');
  const made = await d.post('/api/cars', { plate: `CK${Math.floor(Math.random() * 9000) + 1000}`, make: 'Toyota', model: 'Prius', seats: 4, perKmCents: 10, perMinCents: 1, pickupPerKmCents: 1 });
  eq('a car without its photos can\'t go online', (await d.post('/api/driver/online', at)).code, 'need_photos');
  for (const kind of ['front', 'back', 'inside']) await d.upload(`/api/cars/${made.car.id}/photos?kind=${kind}`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  for (const coin of [SOL, USDC]) await d.post('/api/wallet/address', { coin, address: driverKey.address, via: 'Test' });
  await d.patch('/api/driver', { allowsPlanning: true, planDays: 7 });
  await d.post('/api/driver/rules-seen');
  eq('driver goes online', (await ready()).driver?.online, true);

  part('Old money is gone');
  eq('adding crypto is gone', (await r.post('/api/wallet/deposit', { coin: SOL, eurCents: 500 })).status, 404);
  eq('withdrawing is gone', (await r.post('/api/wallet/withdraw', { coin: SOL })).status, 404);
  const coinsNow = (await r.get('/api/wallet')).coins.map((c) => c.id).sort().join();
  eq('the wallet only lists SOL and USDC', coinsNow, 'sol,usdc-sol');
  eq('old coins can\'t be ordered with', (await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'auto', coin: 'xlm' })).code, 'bad_coin');

  // MANUAL_ONLY=1 only tries the admin stepping in; SKIP_RIDES=1 goes straight to the later parts.
  if (process.env.MANUAL_ONLY) {
    await manual(SOL);
    await manual(USDC);
    const left = await admin('GET', '/admin/api/escrow');
    eq('no escrow left open', left.open.length, 0);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
  for (const coin of process.env.SKIP_RIDES ? [] : [SOL, USDC]) {
    const C = name(coin);

    part(`${C}: a whole ride, no appeal`);
    const id = await rideNow(coin);
    eq(`${C}: the driver can set off, waiting for the payment`, (await d.get('/api/sync?rev=0')).driving.drive.status, 'awaiting_payment');
    let before = await snapshot(coin);
    const paid = coin === SOL ? await paysByLink(r, id) : await pays(r, id);
    eq(`${C}: paid, so the driver is told to go`, paid.status, 'accepted');
    const wallet = await r.get('/api/wallet');
    eq(`${C}: the rider's wallet shows it on hold`, wallet.held?.[0]?.rideId, id);
    await checkIn(id);
    eq(`${C}: checks out at the drop-off, no warning`, (await checkOut(id)).ride?.checkoutWarning, false);
    await dev('/dev/money');
    eq(`${C}: not paid out before 24 hours`, (await r.get(`/api/rides/${id}`)).ride.escrow.status, 'paid');
    await clock(24 * HOUR + MIN);
    let done = await settled(r, id);
    eq(`${C}: paid out after 24 hours`, done.escrow?.outcome, 'payout');
    let after = await snapshot(coin);
    const total = units(coin, done.escrow.amount), toDriver = units(coin, done.escrow.driverAmount), toFee = units(coin, done.escrow.feeAmount);
    eq(`${C}: the amounts add up`, toDriver + toFee, total);
    // Drivezzz's part: worth €0.10 in the ride's coin, never 0.10 of the coin itself.
    const worth = Number(done.escrow.feeAmount) * ((done.priceCents / 100) / Number(done.escrow.amount));
    ok(`${C}: the fee is worth €0.10  (${done.escrow.feeAmount} ${C}, €${worth.toFixed(4)})`, Math.abs(worth - 0.1) < 0.001);
    checkMoney(`${C} pay out`, coin, before, after, { toDriver, toFee, total });
    await closed(done);
    eq(`${C}: nothing on hold any more`, (await r.get('/api/wallet')).held.length, 0);
    const out = (await d.get('/api/wallet')).payouts.find((p) => p.rideId === id);
    ok(`${C}: the driver's wallet shows it paid, with a link to the chain`, out?.status === 'confirmed' && Boolean(out.explorer), out?.explorer);
    // Crash just before noting it: looked up on the chain, not sent again.
    before = await snapshot(coin);
    await dev(`/dev/forget-settled?ride=${id}`);
    await dev('/dev/money');
    after = await snapshot(coin);
    eq(`${C}: retrying a settled escrow pays nobody twice (driver)`, after.driver, before.driver);
    eq(`${C}: retrying a settled escrow pays nobody twice (fee)`, after.fee, before.fee);
    eq(`${C}: and the server sent nothing (its SOL didn't move)`, after.serverSol, before.serverSol);
    eq(`${C}: and it's noted as settled again`, (await r.get(`/api/rides/${id}`)).ride.escrow.status, 'settled');

    part(`${C}: paid ride for now, the rider cancels: 50/50`);
    const cancelled = await rideNow(coin);
    before = await snapshot(coin);
    await pays(r, cancelled);
    eq(`${C}: half from the moment it's paid`, (await r.get(`/api/rides/${cancelled}`)).ride.refundPercent, 50);
    await d.post('/api/location', { ...at, driving: true, speed: 0 });
    await clock(5 * MIN + 1000);
    eq(`${C}: the driver there in time, after those 5 minutes: 50%`, (await r.get(`/api/rides/${cancelled}`)).ride.refundPercent, 50);
    await r.post(`/api/rides/${cancelled}/cancel`);
    await clock(24 * HOUR + MIN);
    done = await settled(r, cancelled);
    eq(`${C}: split`, done.escrow?.outcome, 'split');
    after = await snapshot(coin);
    const whole = units(coin, done.escrow.amount);
    checkMoney(`${C} 50/50`, coin, before, after, { toDriver: whole / 2n, toFee: 0n, total: whole });
    await closed(done);

    part(`${C}: planned, the rider cancels 3 hours or more before: refund`);
    const far = await planned(coin, 5 * HOUR);
    before = await snapshot(coin);
    eq(`${C}: planned rides are paid after a driver takes them`, (await pays(r, far)).status, 'scheduled');
    eq(`${C}: free to cancel now`, (await r.get(`/api/rides/${far}`)).ride.refundPercent, 100);
    await r.post(`/api/rides/${far}/cancel`);
    done = await settled(r, far);
    eq(`${C}: refunded right away`, done.escrow?.outcome, 'refund');
    after = await snapshot(coin);
    checkMoney(`${C} planned refund`, coin, before, after, { toDriver: 0n, toFee: 0n, total: units(coin, done.escrow.amount) });
    await closed(done);

    part(`${C}: planned, the rider cancels under 3 hours before: 50/50`);
    const near = await planned(coin, 2 * HOUR);
    before = await snapshot(coin);
    eq(`${C}: paid, planned`, (await pays(r, near)).status, 'scheduled');
    eq(`${C}: 50% now`, (await r.get(`/api/rides/${near}`)).ride.refundPercent, 50);
    await r.post(`/api/rides/${near}/cancel`);
    await clock(24 * HOUR + MIN);
    done = await settled(r, near);
    eq(`${C}: split`, done.escrow?.outcome, 'split');
    after = await snapshot(coin);
    checkMoney(`${C} planned 50/50`, coin, before, after, { toDriver: units(coin, done.escrow.amount) / 2n, toFee: 0n, total: units(coin, done.escrow.amount) });

    part(`${C}: the driver cancels: refund`);
    const dc = await rideNow(coin);
    before = await snapshot(coin);
    await pays(r, dc);
    await d.post(`/api/rides/${dc}/driver-cancel`, { reason: 'Car trouble' });
    done = await settled(r, dc);
    eq(`${C}: refunded`, done.escrow?.outcome, 'refund');
    after = await snapshot(coin);
    checkMoney(`${C} driver cancels`, coin, before, after, { toDriver: 0n, toFee: 0n, total: units(coin, done.escrow.amount) });

    part(`${C}: the driver doesn't show up: refund`);
    const late = await rideNow(coin);
    before = await snapshot(coin);
    await pays(r, late);
    await clock(30 * MIN);
    eq(`${C}: too late at the pickup, so cancelling is free`, (await r.get(`/api/rides/${late}`)).ride.refundPercent, 100);
    await r.post(`/api/rides/${late}/cancel`);
    done = await settled(r, late);
    eq(`${C}: refunded`, done.escrow?.outcome, 'refund');
    after = await snapshot(coin);
    checkMoney(`${C} no-show`, coin, before, after, { toDriver: 0n, toFee: 0n, total: units(coin, done.escrow.amount) });
    const noShow = await planned(coin, 40 * MIN);
    before = await snapshot(coin);
    await pays(r, noShow);
    await clock(40 * MIN + 11 * MIN); // past the planned time; the driver stopped reporting long ago
    await dev('/dev/tick');
    done = await settled(r, noShow);
    eq(`${C}: a planned driver who isn't there: refunded by itself`, done.escrow?.outcome, 'refund');
    after = await snapshot(coin);
    checkMoney(`${C} planned no-show`, coin, before, after, { toDriver: 0n, toFee: 0n, total: units(coin, done.escrow.amount) });

    part(`${C}: a late driver: a full refund until check-in, also once they're there`);
    const overdue = await rideNow(coin);
    before = await snapshot(coin);
    const onWay = await pays(r, overdue);
    eq(`${C}: not late yet`, onWay.driverLate, false);
    await clock(onWay.pickupDeadlineAt - onWay.now + 1000);
    const isLate = (await r.get(`/api/rides/${overdue}`)).ride;
    eq(`${C}: past their time, the rider can cancel for free`, isLate.refundPercent, 100);
    eq(`${C}: and sees the driver is late`, isLate.driverLate, true);
    await d.post('/api/location', { ...at, driving: true, speed: 0 });
    const reached = (await r.get(`/api/rides/${overdue}`)).ride;
    eq(`${C}: the driver makes it after all`, reached.status, 'arrived');
    eq(`${C}: still free, until the rider is in the car`, reached.refundPercent, 100);
    await r.post(`/api/rides/${overdue}/cancel`);
    done = await settled(r, overdue);
    eq(`${C}: refunded`, done.escrow?.outcome, 'refund');
    after = await snapshot(coin);
    checkMoney(`${C} late, then there`, coin, before, after, { toDriver: 0n, toFee: 0n, total: units(coin, done.escrow.amount) });

    part(`${C}: the driver stops at the pickup and the rider never gets in`);
    const stayAway = await rideNow(coin);
    await d.post('/api/location', { ...at, driving: true, speed: 0 });
    eq(`${C}: there, still waiting to be paid`, (await r.get(`/api/rides/${stayAway}`)).ride.status, 'awaiting_payment');
    before = await snapshot(coin);
    eq(`${C}: paid, and the driver is there already`, (await pays(r, stayAway)).status, 'arrived');
    await d.post('/api/location', { ...at, driving: true, speed: 0 });
    ok(`${C}: the 10 minutes start with the full stop`, Boolean((await r.get(`/api/rides/${stayAway}`)).ride.noShowFrom));
    await clock(10 * MIN + 1000);
    await d.post('/api/location', { ...at, driving: true, speed: 0 });
    eq(`${C}: after 10 minutes the driver cancels`, (await d.post(`/api/rides/${stayAway}/driver-cancel`, { reason: 'Rider not there' })).ride?.status, 'cancelled');
    await clock(24 * HOUR + MIN);
    done = await settled(r, stayAway);
    eq(`${C}: half for the driver who came`, done.escrow?.outcome, 'split');
    after = await snapshot(coin);
    checkMoney(`${C} rider no-show`, coin, before, after, { toDriver: units(coin, done.escrow.amount) / 2n, toFee: 0n, total: units(coin, done.escrow.amount) });

    part(`${C}: checked in, the driver cancels: refund`);
    const inCar = await rideNow(coin);
    before = await snapshot(coin);
    await pays(r, inCar);
    await checkIn(inCar);
    eq(`${C}: cancelled by the driver`, (await d.post(`/api/rides/${inCar}/driver-cancel`, { reason: 'Misbehaviour' })).ride?.status, 'cancelled');
    done = await settled(r, inCar);
    eq(`${C}: refunded`, done.escrow?.outcome, 'refund');
    after = await snapshot(coin);
    checkMoney(`${C} driver cancels after check-in`, coin, before, after, { toDriver: 0n, toFee: 0n, total: units(coin, done.escrow.amount) });

    part(`${C}: the rider wasn't near the drop-off: warned, still paid`);
    const warned = await rideNow(coin);
    before = await snapshot(coin);
    await pays(r, warned);
    await checkIn(warned);
    eq(`${C}: the driver sees the warning`, (await checkOut(warned, { riderThere: false })).ride?.checkoutWarning, true);
    eq(`${C}: the rider sees the warning`, (await r.get(`/api/rides/${warned}`)).ride.checkoutWarning, true);
    await clock(24 * HOUR + MIN);
    done = await settled(r, warned);
    eq(`${C}: still paid after 24 hours`, done.escrow?.outcome, 'payout');
    after = await snapshot(coin);
    checkMoney(`${C} warned`, coin, before, after, { toDriver: units(coin, done.escrow.driverAmount), toFee: units(coin, done.escrow.feeAmount), total: units(coin, done.escrow.amount) });

    part(`${C}: no check-out: refund, unless the driver appeals after most of the way`);
    const stuck = await rideNow(coin);
    before = await snapshot(coin);
    await pays(r, stuck);
    await checkIn(stuck);
    await clock(25 * HOUR);
    await dev('/dev/tick');
    done = await settled(r, stuck);
    eq(`${C}: no check-out in 24 hours: refunded`, done.escrow?.outcome, 'refund');
    after = await snapshot(coin);
    checkMoney(`${C} no check-out`, coin, before, after, { toDriver: 0n, toFee: 0n, total: units(coin, done.escrow.amount) });

    const most = await rideNow(coin);
    before = await snapshot(coin);
    await pays(r, most);
    await checkIn(most);
    await d.post('/api/location', { lat: 52.3625, lng: 4.8825, driving: true }); // a good way along, too far to check out
    await clock(HOUR);
    eq(`${C}: the driver can't check out that far away`, (await d.post(`/api/rides/${most}/check-out`, { lat: 52.3625, lng: 4.8825 })).code, 'too_far');
    eq(`${C}: the driver appeals`, (await d.post(`/api/rides/${most}/appeal`, { message: 'The rider left before the drop-off' })).status, 200);
    await clock(25 * HOUR);
    await dev('/dev/tick');
    eq(`${C}: the appeal holds it past the 24 hours`, (await r.get(`/api/rides/${most}`)).ride.escrow.status, 'paid');
    await clock(50 * HOUR);
    await dev('/dev/tick');
    done = await settled(r, most);
    eq(`${C}: 60% or more driven, nobody decided in 3 days: paid out`, done.escrow?.outcome, 'payout');
    after = await snapshot(coin);
    checkMoney(`${C} driver's appeal`, coin, before, after, { toDriver: units(coin, done.escrow.driverAmount), toFee: units(coin, done.escrow.feeAmount), total: units(coin, done.escrow.amount) });

    const little = await rideNow(coin);
    await pays(r, little);
    await checkIn(little);
    await clock(HOUR);
    await d.post('/api/location', { lat: 52.3695, lng: 4.8895, driving: true }); // hardly moved
    eq(`${C}: the driver appeals having hardly moved`, (await d.post(`/api/rides/${little}/appeal`, { message: 'The rider left straight away' })).status, 200);
    await clock(80 * HOUR);
    await dev('/dev/tick');
    eq(`${C}: no default for that: it waits for an admin`, (await r.get(`/api/rides/${little}`)).ride.escrow.outcome ?? null, null);
    const open = (await admin('GET', '/admin/api/disputes')).disputes.find((x) => x.ride_id === little);
    before = await snapshot(coin);
    eq(`${C}: the admin refunds it`, (await admin('POST', `/admin/api/disputes/${open.id}`, { decision: 'refund_rider', answer: 'Not driven.' })).ok, true);
    done = await settled(r, little);
    eq(`${C}: refunded`, done.escrow?.outcome, 'refund');

    part(`${C}: the admin decides a rider's appeal, each outcome once`);
    for (const [decision, outcome] of [['refund_rider', 'refund'], ['split', 'split'], ['pay_driver', 'payout']]) {
      const appealed = await rideNow(coin);
      before = await snapshot(coin);
      await pays(r, appealed);
      await checkIn(appealed);
      await checkOut(appealed);
      eq(`${C} ${decision}: the rider appeals within 24 hours`, (await r.post(`/api/rides/${appealed}/appeal`, { message: 'Something went wrong here' })).status, 200);
      await clock(80 * HOUR);
      await dev('/dev/tick');
      eq(`${C} ${decision}: held for days, however well they rode together`, (await r.get(`/api/rides/${appealed}`)).ride.escrow.status, 'paid');
      const dispute = (await admin('GET', '/admin/api/disputes')).disputes.find((x) => x.ride_id === appealed);
      ok(`${C} ${decision}: the admin sees the escrow on the appeal`, Boolean(dispute?.ride), dispute?.ride?.status);
      eq(`${C} ${decision}: the admin decides`, (await admin('POST', `/admin/api/disputes/${dispute.id}`, { decision, answer: 'Looked at it.' })).ok, true);
      eq(`${C} ${decision}: and can't decide twice`, (await admin('POST', `/admin/api/disputes/${dispute.id}`, { decision: 'pay_driver' })).code, 'decided');
      done = await settled(r, appealed);
      eq(`${C} ${decision}: on the chain`, done.escrow?.outcome, outcome);
      after = await snapshot(coin);
      const all = units(coin, done.escrow.amount);
      checkMoney(`${C} ${decision}`, coin, before, after, {
        toDriver: outcome === 'payout' ? units(coin, done.escrow.driverAmount) : outcome === 'split' ? all / 2n : 0n,
        toFee: outcome === 'payout' ? units(coin, done.escrow.feeAmount) : 0n, total: all,
      });
    }
  }

  if (!process.env.SKIP_RIDES) { await manual(SOL); await manual(USDC); }

  part('Not paid, nobody claims: nothing on the chain');
  const notPaid = await rideNow(SOL);
  await clock(11 * MIN);
  await dev('/dev/tick');
  let view = (await r.get(`/api/rides/${notPaid}`)).ride;
  eq('not paid in 10 minutes: cancelled', view.status, 'cancelled');
  eq('and no escrow', view.escrow ?? null, null);
  eq('the driver is free again', (await d.get('/api/sync?rev=0')).driving.drive ?? null, null);
  const notPaidPlanned = await planned(SOL, 2 * HOUR);
  const by = (await r.get(`/api/rides/${notPaidPlanned}`)).ride;
  ok('a planned ride: pay by 30 minutes before', by.payBy === by.scheduledAt - 30 * MIN, `${(by.scheduledAt - by.payBy) / MIN} minutes`);
  await clock(91 * MIN);
  await dev('/dev/tick');
  eq('not paid 30 minutes before: cancelled', (await r.get(`/api/rides/${notPaidPlanned}`)).ride.status, 'cancelled');
  await d.post('/api/driver/offline');
  const unclaimed = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'bid', bidCents: 100, coin: SOL });
  await clock(2 * HOUR + MIN);
  await dev('/dev/tick');
  eq('nobody claims it in 2 hours: cancelled', (await r.get(`/api/rides/${unclaimed.ride.id}`)).ride.status, 'cancelled');
  const when = (await serverNow()) + 3 * HOUR;
  const unclaimedPlanned = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'bid', bidCents: 100, coin: SOL, scheduledAt: when });
  await clock(3 * HOUR + MIN);
  await dev('/dev/tick');
  eq('a planned order nobody claims ends at its time', (await r.get(`/api/rides/${unclaimedPlanned.ride.id}`)).ride.status, 'cancelled');

  part('While on a drive you can\'t claim another');
  const other = client(); await other.start();
  await other.post('/api/location', at);
  const busyRide = await rideNow(SOL);
  const market = await other.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'bid', bidCents: 100, coin: SOL });
  eq('not while waiting for a rider to pay', (await d.post(`/api/rides/${market.ride.id}/claim`)).code, 'on_a_ride');
  await pays(r, busyRide);
  eq('not with a rider', (await d.post(`/api/rides/${market.ride.id}/claim`)).code, 'on_a_ride');
  await d.post(`/api/rides/${busyRide}/driver-cancel`, { reason: 'Other' });
  await settled(r, busyRide);
  eq('and yes once free', (await d.post(`/api/rides/${market.ride.id}/claim`)).ride?.status, 'awaiting_payment');
  await d.post(`/api/rides/${market.ride.id}/driver-cancel`, { reason: 'Other' });

  part('Payments that shouldn\'t count go back by themselves');
  // Two wallets pay the same ride: one counts.
  let id2 = await rideNow(SOL);
  const riderTx = sign(rider, await payment(r, id2, rider)), strangerTx = sign(stranger, await payment(r, id2, stranger));
  let strangerBefore = await balance(stranger), before2 = await snapshot(SOL);
  await sendSigned(r, id2, riderTx);
  await sendSigned(r, id2, strangerTx);
  await sleep(8000);
  await dev('/dev/payments');
  const refundedOne = async () => [before2.riderSol - (await balance(rider)), strangerBefore - (await balance(stranger))];
  let nets;
  for (let i = 0; i < 20; i++) { await dev('/dev/money'); nets = await refundedOne(); if (nets.some(feesOnly)) break; await sleep(2000); }
  view = (await r.get(`/api/rides/${id2}`)).ride;
  eq('two wallets paid: the ride counts one', view.status, 'accepted');
  ok('and the other got everything back but the fees', nets.filter(feesOnly).length === 1, nets.join(' and '));
  await d.post(`/api/rides/${id2}/driver-cancel`, { reason: 'Other' });
  await settled(r, id2);
  nets = await refundedOne();
  ok('refunding the ride then gives the first wallet everything back too', nets.every(feesOnly), nets.join(' and '));

  // Too late: the ride is gone when the wallet sends it.
  id2 = await rideNow(SOL);
  const lateTx = sign(rider, await payment(r, id2, rider));
  await r.post(`/api/rides/${id2}/cancel`);
  eq('a cancelled ride takes no more payments here', (await r.post(`/api/rides/${id2}/pay/send`, { transaction: lateTx.toString('base64') })).code, 'not_waiting');
  before2 = await snapshot(SOL);
  await landed(await sendRaw(lateTx));
  await dev('/dev/payments');
  for (let i = 0; i < 20; i++) { await dev('/dev/money'); if (feesOnly(before2.riderSol - (await balance(rider)))) break; await sleep(2000); }
  ok('a wallet paying anyway gets everything back but the fees', feesOnly(before2.riderSol - (await balance(rider))), `${before2.riderSol - (await balance(rider))}`);

  // Too little: the rider's wallet changed the amount.
  id2 = await rideNow(SOL);
  const shortTx = await payment(r, id2, rider);
  shortTx.writeBigUInt64LE(1000n, shortTx.length - 16);
  sign(rider, shortTx);
  before2 = await snapshot(SOL);
  await landed(await sendRaw(shortTx));
  await dev('/dev/payments');
  eq('underpaying doesn\'t buy a ride', (await r.get(`/api/rides/${id2}`)).ride.status, 'awaiting_payment');
  for (let i = 0; i < 20; i++) { await dev('/dev/money'); if (feesOnly(before2.riderSol - (await balance(rider)))) break; await sleep(2000); }
  ok('and it goes back', feesOnly(before2.riderSol - (await balance(rider))), `${before2.riderSol - (await balance(rider))}`);
  await r.post(`/api/rides/${id2}/cancel`);

  part('Bans');
  const badDevice = `cl-bad-${crypto.randomBytes(4).toString('hex')}`;
  const bad = client(badDevice); await bad.start();
  await bad.post('/api/location', at);
  await bad.post('/api/wallet/address', { coin: SOL, address: stranger.address, via: 'Test' });
  const badRide = await rideNow(SOL, bad);
  strangerBefore = await balance(stranger);
  await pays(bad, badRide, stranger);
  eq('the admin bans someone for good', (await admin('POST', `/admin/api/users/${bad.id}/ban`, { kind: 'permanent', reason: 'Testing' })).status, 200);
  eq('their paid ride is cancelled', (await r.get('/api/rides')).rides.some((x) => x.id === badRide), false);
  for (let i = 0; i < 20; i++) { await dev('/dev/money'); if (feesOnly(strangerBefore - (await balance(stranger)))) break; await sleep(2000); }
  ok('and refunded to the wallet that paid', feesOnly(strangerBefore - (await balance(stranger))), `${strangerBefore - (await balance(stranger))}`);
  const samePhone = client(badDevice);
  const back = await samePhone.start();
  eq('the same phone gets the banned account back', back.user.id, bad.id);
  eq('and can\'t order', (await samePhone.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'auto', coin: SOL })).code, 'banned');
  const newPhone = client(); await newPhone.start();
  eq('a new phone can\'t connect that wallet', (await newPhone.post('/api/wallet/address', { coin: SOL, address: stranger.address })).code, 'banned');
  const asking = await rideNow(SOL);
  eq('and that wallet can\'t pay for anyone', (await r.post(`/api/rides/${asking}/pay`, { account: stranger.address })).code, 'banned');
  await r.post(`/api/rides/${asking}/cancel`);
  const banned = await admin('GET', `/admin/api/users/${bad.id}`);
  ok('the admin sees the banned wallet', JSON.stringify(banned).includes(stranger.address));
  eq('and can remove it', (await admin('POST', '/admin/api/banned-wallets/remove', { address: stranger.address })).status, 200);
  await admin('POST', `/admin/api/users/${bad.id}/unban`, { reason: 'Test over' });

  part('The demo account');
  const demo = client(); await demo.start();
  await dev(`/dev/make-demo?id=${demo.id}`);
  await demo.post('/api/location', { lat: 48.85, lng: 2.35 });
  await dev('/dev/tick');
  const demoOrder = await demo.post('/api/rides', { pickup: { lat: 48.85, lng: 2.35, label: 'P' }, dropoff: { lat: 48.86, lng: 2.34, label: 'D' }, passengers: 1, mode: 'auto', coin: SOL });
  let demoRide = demoOrder.ride;
  for (let i = 0; i < 10 && demoRide && !['accepted', 'arrived'].includes(demoRide.status); i++) { await dev('/dev/tick'); await sleep(1000); demoRide = (await demo.get(`/api/rides/${demoRide.id}`)).ride; }
  ok('a demo ride goes on with no payment', ['accepted', 'arrived'].includes(demoRide?.status), demoRide?.status ?? JSON.stringify(demoOrder).slice(0, 160));
  eq('and no pay link', demoRide?.payUrl ?? null, null);
  eq('and no escrow', demoRide?.escrow ?? null, null);
  if (demoRide) await demo.post(`/api/rides/${demoRide.id}/cancel`);

  part('USDC: a rider who closes their account to get out of paying');
  const program = unb58(fs.readFileSync(path.join(dir, 'program-id'), 'utf8').trim());
  const leaver = keypair();
  const leaverToken = tokenAccountOf(leaver.pub, MINT), riderToken = tokenAccountOf(rider.pub, MINT);
  const tokenSend = (from, to, amount, signer) => ix(TOKEN, [[from, 0, 1], [to, 0, 1], [signer, 1, 0]], Buffer.concat([Buffer.from([3]), u64(amount)]));
  const makeAccount = (payer, owner) => ix(ATA, [[payer, 1, 1], [tokenAccountOf(owner, MINT), 0, 1], [owner], [MINT], [SYSTEM], [TOKEN]], [1]);
  const closeAccount = (owner) => ix(TOKEN, [[tokenAccountOf(owner, MINT), 0, 1], [owner, 0, 1], [owner, 1, 0]], [9]);
  await send([ix(SYSTEM, [[deployer, 1, 1], [leaver, 0, 1]], Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(60_000_000n)]))], [deployer]);
  await send([makeAccount(leaver.pub, leaver.pub), tokenSend(riderToken, leaverToken, 20_000_000n, rider.pub)], [leaver, rider]);
  const free = await rideNow(USDC);
  const freePaid = await pays(r, free, leaver);
  await checkIn(free);
  await checkOut(free);
  const freeEscrow = unb58(freePaid.escrow.address);
  const vault = pda([Buffer.from('vault'), (await account(freeEscrow)).data.subarray(4, 20)], program).address;
  await send([tokenSend(leaverToken, vault, 7n, leaver.pub), tokenSend(leaverToken, riderToken, (await tokens(leaver.pub)) - 7n, leaver.pub), closeAccount(leaver.pub)], [leaver]);
  const beforeFree = await snapshot(USDC);
  await clock(24 * HOUR + MIN);
  const freeDone = await settled(r, free);
  eq('the free ride fails: the outcome goes out', `${freeDone.escrow?.outcome} ${freeDone.escrow?.status}`, 'payout settled');
  const afterFree = await snapshot(USDC);
  eq('the driver is paid in full', afterFree.driver - beforeFree.driver, units(USDC, freeDone.escrow.driverAmount));
  eq('and the fee address', afterFree.fee - beforeFree.fee, units(USDC, freeDone.escrow.feeAmount));
  ok('the server paid a priority fee at most', beforeFree.serverSol - afterFree.serverSol >= 0n && beforeFree.serverSol - afterFree.serverSol <= 12_000n, `${beforeFree.serverSol - afterFree.serverSol}`);
  eq('what the rider put on top waits in the vault', await tokenBalance(vault), 7n);
  await send([makeAccount(leaver.pub, leaver.pub)], [leaver]);
  for (let i = 0; i < 40 && (await account(freeEscrow)); i++) { await dev('/dev/money'); await sleep(3000); }
  ok('with their account back the rest comes to them, and it all closes', !(await account(freeEscrow)) && !(await account(vault)));
  eq('every last unit', await tokens(leaver.pub), 7n);
  eq('the driver isn\'t paid twice', (await snapshot(USDC)).driver, afterFree.driver);

  part('USDC: a refund for a rider without an account');
  await send([tokenSend(riderToken, leaverToken, 20_000_000n, rider.pub)], [rider]);
  const nowhere = await rideNow(USDC);
  const nowherePaid = await pays(r, nowhere, leaver);
  await send([tokenSend(leaverToken, riderToken, await tokens(leaver.pub), leaver.pub), closeAccount(leaver.pub)], [leaver]);
  await d.post(`/api/rides/${nowhere}/driver-cancel`, { reason: 'Car trouble' });
  await dev('/dev/money');
  eq('it can\'t go out yet', (await r.get(`/api/rides/${nowhere}`)).ride.escrow.status, 'paid');
  const stuckNow = (await admin('GET', '/admin/api/escrow')).open.find((e) => e.rideId === nowhere);
  ok('the admin sees why', /no USDC account/.test(stuckNow?.error ?? ''), stuckNow?.error);
  await send([makeAccount(leaver.pub, leaver.pub)], [leaver]);
  await clock(11 * MIN);
  const nowhereDone = await settled(r, nowhere);
  eq('with the account back it goes out', `${nowhereDone.escrow?.outcome} ${nowhereDone.escrow?.status}`, 'refund settled');
  eq('all of it', await tokens(leaver.pub), units(USDC, nowherePaid.escrow.amount));
  await send([tokenSend(leaverToken, riderToken, await tokens(leaver.pub), leaver.pub)], [leaver]);

  part('The 30-day refund (the contract\'s timer is 10 minutes on devnet)');
  const exp = {};
  for (const coin of [SOL, USDC]) {
    const rc = client(); await rc.start();
    await rc.post('/api/location', at);
    const id = await rideNow(coin, rc);
    exp[coin] = { rc, id, before: await snapshot(coin) };
    await pays(rc, id);
    await checkIn2(rc, id);
    await checkOut(id);
    eq(`${name(coin)}: an appeal nobody decides`, (await rc.post(`/api/rides/${id}/appeal`, { message: 'Nobody will look at this' })).status, 200);
    exp[coin].paidAt = Date.now();
  }
  await clock(30 * 24 * HOUR + 2 * MIN);
  await dev('/dev/money');
  await sleep(8000);
  await dev('/dev/money');
  const early = (await exp[SOL].rc.get(`/api/rides/${exp[SOL].id}`)).ride;
  eq('the server tries on day 30', early.escrow.outcome, 'expired');
  ok('too early by the contract\'s clock: it refuses, nothing moves', early.escrow.status !== 'settled', early.escrow.status);
  const money = (await admin('GET', '/admin/api/escrow')).open;
  ok('the admin sees why', money.some((e) => e.rideId === exp[SOL].id && e.error), money.find((e) => e.rideId === exp[SOL].id)?.error);
  const wait = Math.max(0, exp[SOL].paidAt + 10 * MIN + 20_000 - Date.now());
  console.log(`waiting ${Math.round(wait / 1000)} s for the contract's timer`);
  await sleep(wait);
  await clock(11 * MIN);
  for (const coin of [SOL, USDC]) {
    const { rc, id } = exp[coin];
    const ride = await settled(rc, id);
    eq(`${name(coin)}: refunded when the timer is over`, `${ride.escrow?.outcome} ${ride.escrow?.status}`, 'expired settled');
    await closed(ride);
    await sleep(500);
    const now2 = await snapshot(coin);
    if (coin === USDC) eq(`${name(coin)}: the rider has all the USDC back`, now2.rider, exp[coin].before.rider);
    else ok(`${name(coin)}: the rider has all the SOL back but the fees`, exp[coin].before.rider - now2.rider <= 44_000n, `${exp[coin].before.rider - now2.rider} lamports`);
  }

  part('Nothing left behind');
  const end = await admin('GET', '/admin/api/escrow');
  eq('no escrow left open', end.open.length, 0);
  eq('the money page sees no problem', end.problem, null);
  ok('and the recent ones with their links', end.recent.length > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
async function checkIn2(rc, id) {
  await d.post('/api/driver/online', at);
  await d.post('/api/location', { ...at, driving: true });
  await rc.post('/api/location', at);
  const res = await rc.post(`/api/rides/${id}/check-in`, { ...at, plateChecked: true });
  if (res.ride?.status !== 'riding') throw new Error(`check-in: ${JSON.stringify(res).slice(0, 200)}`);
}
main().catch((e) => { console.error(e); console.log(`\nstopped: ${passed} passed, ${failed} failed so far`); process.exit(1); });
