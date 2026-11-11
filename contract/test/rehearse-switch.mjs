// For rehearse-golive.sh: the server's move from the pretend chain to the contract, on one database. Rides are left half done on the
// pretend chain, the server comes back without it, as in docs/mainnet-checklist.md, the panel switches to the real network, and
// rides are paid in both coins, every amount read from the chain.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unb58, loadKeypair, balance, tokenBalance, tokenAccountOf, account, sleep } from './sol.mjs';
import { fakeRoads } from '../../server/test/helpers.js';

const R = process.env.R;
const BASE = 'http://127.0.0.1:18082';
const USDC = unb58('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const FEE = unb58('6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN');
const rider = loadKeypair(`${R}/keys/rider.json`);
const driverKey = loadKeypair(`${R}/keys/driver.json`);
const programId = /ESCROW_PROGRAM_ID=(\S+)/.exec(fs.readFileSync(`${R}/keys/drivezzz-escrow.env`, 'utf8'))[1];

const ADMIN_EMAIL = 'admin@rehearsal.test', ADMIN_PASSWORD = crypto.randomBytes(18).toString('base64url');
// Roads aren't what's rehearsed: the free public service answers differently when it's busy, which changes a price by a cent.
const roads = await fakeRoads();
const common = { ...process.env, OSRM_URL: roads.url, DEV: '1', PORT: '18082', HOST: '127.0.0.1', BASE_URL: BASE, DATA_DIR: `${R}/data`, NL_CHECKS: '0', ADMIN_EMAIL, ADMIN_PASSWORD };
const pretend = { ...common, PRETEND_CHAIN: '1', JOBS: '0' };
const real = { ...common, JOBS: '1', ESCROW_PROGRAM_ID: programId, ESCROW_KEY_FILE: `${R}/keys/drivezzz-escrow-key.json`, ESCROW_ADMIN_KEY_FILE: `${R}/keys/drivezzz-deploy-key.json`, CRYPTO_SOL_URL: process.env.RPC, SOL_RPC_PER_10S: '40' };
const node = (...a) => [process.execPath, ['--disable-warning=ExperimentalWarning', ...a]];

let failures = 0;
const ok = (name, cond, detail = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

let child, log = '';
async function start(env) {
  log = '';
  child = spawn(...node('src/index.js'), { cwd: `${R}/server`, env });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80 && !log.includes('Listening'); i++) await sleep(250);
  if (!log.includes('Listening')) throw new Error(`the server didn't start: ${log.slice(0, 800)}`);
}
async function stop() {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

function client() {
  let token;
  const device = `rehearse-${crypto.randomBytes(4).toString('hex')}`;
  const call = async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-device-id': device, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  return {
    upload: (p) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'image/jpeg', authorization: `Bearer ${token}` }, body: fs.readFileSync(path.join(R, 'contract/test/photos/front.jpg')) }),
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b),
    async start() { const r = await call('POST', '/api/auth/continue', {}); token = r.token; this.id = r.user?.id; return this; },
  };
}
const dev = (p) => fetch(BASE + p, { method: 'POST' }).then((r) => r.json());
let cookie = '';
async function admin(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

const at = { lat: 52.37, lng: 4.89 };
const pickup = { ...at, label: 'Dam, Amsterdam' };
const dropoff = { lat: 52.37, lng: 4.88, label: 'Museumplein, Amsterdam' };
async function makeDriver(n) {
  const d = await client().start();
  await d.post('/api/driver/enable');
  const car = await d.post('/api/cars', { plate: `RH${n}${Math.floor(Math.random() * 900) + 100}`, make: 'Toyota', model: 'Prius', seats: 4, perKmCents: 90, perMinCents: 20, pickupPerKmCents: 50 });
  for (const kind of ['front', 'back', 'inside']) await d.upload(`/api/cars/${car.car.id}/photos?kind=${kind}`);
  for (const coin of ['sol', 'usdc-sol']) await d.post('/api/wallet/address', { coin, address: driverKey.address, via: 'Test' });
  await d.post('/api/driver/rules-seen');
  const on = await d.post('/api/driver/online', at);
  if (on.driver?.online !== true) throw new Error(`driver ${n} isn't online: ${JSON.stringify(on).slice(0, 300)}`);
  return d;
}
async function makeRider() {
  const r = await client().start();
  await r.post('/api/location', at);
  return r;
}
const order = async (r, d, coin) => {
  const made = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'driver', driverId: d.id, coin });
  if (!made.ride) throw new Error(`no ride: ${JSON.stringify(made).slice(0, 300)}`);
  const took = await d.post(`/api/rides/${made.ride.id}/accept`);
  if (took.ride?.status !== 'awaiting_payment') throw new Error(`not accepted: ordered ${made.ride.status}, then ${JSON.stringify(took).slice(0, 300)}`);
  return made.ride.id;
};
async function driveIt(r, d, id) {
  await d.post('/api/location', { ...at, driving: true });
  await r.post('/api/location', at);
  ok('  checked in', (await r.post(`/api/rides/${id}/check-in`, { ...at, plateChecked: true })).ride?.status === 'riding');
  await d.post('/api/location', { ...dropoff, driving: true });
  await r.post('/api/location', dropoff);
  ok('  checked out', (await d.post(`/api/rides/${id}/check-out`, dropoff)).ride?.status === 'completed');
}
async function walletPays(r, id, coinName) {
  const res = await r.post(`/api/rides/${id}/pay`, { account: rider.address });
  if (!res.transaction) throw new Error(`no transaction: ${JSON.stringify(res).slice(0, 300)}`);
  const tx = Buffer.from(res.transaction, 'base64');
  if (coinName === 'USDC') ok('  the payment names real USDC', tx.includes(USDC));
  const message = tx.subarray(1 + 64 * tx[0]);
  crypto.sign(null, message, crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), rider.seed]), format: 'der', type: 'pkcs8' })).copy(tx, 1);
  const sent = await r.post(`/api/rides/${id}/pay/send`, { transaction: tx.toString('base64') });
  if (sent.ok !== true) throw new Error(`not sent: ${JSON.stringify(sent).slice(0, 300)}`);
  for (let i = 0; i < 40; i++) {
    const ride = (await r.get(`/api/rides/${id}`)).ride;
    if (ride.status === 'accepted') return ride;
    await sleep(500);
  }
  throw new Error('the job never saw the payment');
}
async function settledOnChain(r, id) {
  for (let i = 0; i < 60; i++) {
    const ride = (await r.get(`/api/rides/${id}`)).ride;
    if (ride.escrow?.status === 'settled') return ride;
    await sleep(1000);
  }
  return (await r.get(`/api/rides/${id}`)).ride;
}
const coinBalance = (coin, owner) => (coin === 'sol' ? balance(owner) : tokenBalance(tokenAccountOf(owner, USDC)));

async function main() {
  fs.rmSync(`${R}/data`, { recursive: true, force: true });
  spawnSync(...node('src/make-admin.js'), { cwd: `${R}/server`, env: pretend, stdio: 'ignore' });

  console.log('--- On the pretend chain: rides left half done');
  await start(pretend);
  const [d1, d2, d3, d4] = [await makeDriver(1), await makeDriver(2), await makeDriver(3), await makeDriver(4)];
  const [rA, rB, rC] = [await makeRider(), await makeRider(), await makeRider()];
  const going = await order(rA, d1, 'sol');
  await rA.post(`/api/rides/${going}/pretend-pay`);
  ok('a paid ride that is going', (await rA.get(`/api/rides/${going}`)).ride.status === 'accepted');
  const done = await order(rB, d2, 'usdc-sol');
  await rB.post(`/api/rides/${done}/pretend-pay`);
  await driveIt(rB, d2, done);
  ok('a finished ride whose money waits its 24 hours', (await rB.get(`/api/rides/${done}`)).ride.escrow?.status === 'paid');
  const waiting = await order(rC, d3, 'sol');
  await rC.post(`/api/rides/${waiting}/pay`, { account: rider.address });
  ok('a ride waiting to be paid, its payment asked for', (await rC.get(`/api/rides/${waiting}`)).ride.status === 'awaiting_payment');
  await stop();

  console.log('--- The contract: no PRETEND_CHAIN, ESCROW_PROGRAM_ID in, still on the test network');
  await start(real);
  await sleep(11_000);
  const jobErrors = log.split('\n').filter((l) => /\[drivezzz\] (payments|money)/.test(l));
  ok('the payment and money jobs run without errors', jobErrors.length === 0, jobErrors[0]?.slice(0, 160));
  ok('nothing pretend is left on: no test pay', (await rC.get(`/api/rides/${waiting}`)).ride?.testPay !== true);
  ok('a pretend ride that was going has ended', (await rA.get(`/api/rides/${going}`)).ride.status === 'cancelled', (await rA.get(`/api/rides/${going}`)).ride.status);
  ok('so has one waiting to be paid', (await rC.get(`/api/rides/${waiting}`)).ride.status === 'cancelled', (await rC.get(`/api/rides/${waiting}`)).ride.status);
  ok('a finished one stays finished', (await rB.get(`/api/rides/${done}`)).ride.status === 'completed', (await rB.get(`/api/rides/${done}`)).ride.status);

  await admin('POST', '/admin/api/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  await admin('POST', '/admin/api/password', { current: ADMIN_PASSWORD, password: `${ADMIN_PASSWORD}-new` });
  const before = await admin('GET', '/admin/api/escrow');
  ok('the money page says the USDC is wrong until the switch', /another USDC/.test(before.problem ?? ''), before.problem);
  const noWord = await admin('POST', '/admin/api/network', { network: 'mainnet', confirm: 'yes' });
  ok('the switch wants the words', noWord.code === 'confirm', noWord.code);
  const switched = await admin('POST', '/admin/api/network', { network: 'mainnet', confirm: 'SWITCH TO MAINNET' });
  ok('the panel switches to the real network', switched.network === 'mainnet', JSON.stringify(switched).slice(0, 160));
  if (switched.network !== 'mainnet') return;
  const after = await admin('GET', '/admin/api/escrow');
  ok('the money page sees no problem', after.problem === null, after.problem);
  ok('and nothing open or held', after.open?.length === 0 && Number(after.held?.sol) === 0 && Number(after.held?.['usdc-sol']) === 0, JSON.stringify(after.held));
  ok('and the contract and network it should', after.programId === programId && after.network === 'mainnet' && after.pretendChain === false);
  const wallet = await rA.get('/api/wallet');
  ok('the app is told it is the real network', wallet.network === 'mainnet', wallet.network);

  await d2.post('/api/driver/online', at);
  const r = await makeRider();
  for (const coin of ['sol', 'usdc-sol']) {
    const name = coin === 'sol' ? 'SOL' : 'USDC';
    console.log(`--- ${name}, on the real network's settings`);
    const id = await order(r, d2, coin);
    const asked = (await r.get(`/api/rides/${id}`)).ride;
    ok(`${name}: the ride says mainnet`, asked.network === 'mainnet' && asked.testPay !== true, `${asked.network} ${asked.testPay}`);
    const riderBefore = await balance(rider);
    const riderCoinBefore = await coinBalance(coin, rider);
    const paid = await walletPays(r, id, name);
    ok(`${name}: paid`, paid.escrow?.status === 'paid');
    ok(`${name}: the link is mainnet's`, !String(paid.escrow?.explorer ?? '').includes('cluster'), paid.escrow?.explorer);
    await driveIt(r, d2, id);
    const [driverBefore, feeBefore] = [await coinBalance(coin, driverKey), await coinBalance(coin, FEE)];
    await dev(`/dev/clock?ms=${24 * 3600_000 + 60_000}`);
    const finished = await settledOnChain(r, id);
    ok(`${name}: paid out by the job`, finished.escrow?.status === 'settled' && finished.escrow.outcome === 'payout', finished.escrow?.settleExplorer);
    const decimals = coin === 'sol' ? 1e9 : 1e6;
    const [driverAfter, feeAfter] = [await coinBalance(coin, driverKey), await coinBalance(coin, FEE)];
    ok(`${name}: the driver got the price minus the fee`, Number(driverAfter - driverBefore) / decimals === Number(paid.escrow.driverAmount), `${Number(driverAfter - driverBefore) / decimals} of ${paid.escrow.driverAmount}`);
    ok(`${name}: the fee address got the fee`, Number(feeAfter - feeBefore) / decimals === Number(paid.escrow.feeAmount), `${Number(feeAfter - feeBefore) / decimals}`);
    const riderAfter = await balance(rider);
    if (coin === 'sol') {
      const price = BigInt(Math.round((Number(paid.escrow.driverAmount) + Number(paid.escrow.feeAmount)) * decimals));
      const spent = riderBefore - riderAfter - price;
      ok('SOL: the rider paid the price and the network fees, the deposit came back', spent >= 10_000n && spent <= 22_000n, `${spent} lamports on top`);
    } else {
      const units = (amount) => BigInt(Math.round(Number(amount) * decimals));
      const gone = riderCoinBefore - await coinBalance(coin, rider);
      ok('USDC: the rider paid the price', gone === units(paid.escrow.driverAmount) + units(paid.escrow.feeAmount), `${Number(gone) / decimals}`);
      const spent = riderBefore - riderAfter;
      ok('USDC: the deposit came back, only network fees gone', spent >= 10_000n && spent <= 22_000n, `${spent} lamports`);
    }
    await d2.post('/api/driver/online', at);
  }

  console.log('--- A refund and a 50/50 on the real network\'s settings');
  const refundId = await order(r, d2, 'usdc-sol');
  const usdcBefore = await coinBalance('usdc-sol', rider);
  await walletPays(r, refundId, 'USDC');
  await d2.post(`/api/rides/${refundId}/driver-cancel`, { reason: 'Other' });
  const refunded = await settledOnChain(r, refundId);
  ok('USDC: the driver cancels, refunded by the job', refunded.escrow?.outcome === 'refund' && refunded.escrow.status === 'settled');
  ok('USDC: all of it is back', (await coinBalance('usdc-sol', rider)) === usdcBefore);
  await d2.post('/api/driver/online', at);
  const splitId = await order(r, d2, 'sol');
  const driverBefore = await balance(driverKey);
  const paidSplit = await walletPays(r, splitId, 'SOL');
  await r.post(`/api/rides/${splitId}/cancel`, { reason: 'Other' });
  await dev(`/dev/clock?ms=${24 * 3600_000 + 60_000}`);
  const split = await settledOnChain(r, splitId);
  ok('SOL: the rider cancels once paid: 50/50 after 24 hours', split.escrow?.outcome === 'split' && split.escrow.status === 'settled');
  const whole = BigInt(Math.round((Number(paidSplit.escrow.driverAmount) + Number(paidSplit.escrow.feeAmount)) * 1e9));
  ok('SOL: half to the driver', (await balance(driverKey)) - driverBefore === whole / 2n, `${(await balance(driverKey)) - driverBefore} of ${whole}`);

  const end = await admin('GET', '/admin/api/escrow');
  ok('the money page still sees no problem', end.problem === null, end.problem);
  ok('and every real escrow closed', end.open?.length === 0 && end.recent?.length >= 4, `${end.open?.length} open, ${end.recent?.length} recent`);
  for (const e of end.recent ?? []) {
    const address = e.explorer.split('/address/')[1];
    if (!address.startsWith('fake-')) ok(`  escrow ${address.slice(0, 8)}… gone from the chain`, !(await account(unb58(address))));
  }
  const noise = log.split('\n').filter((l) => l.trim() && !/Listening|left the pretend chain|another USDC than/.test(l));
  ok('the server said nothing went wrong', noise.length === 0, noise[0]?.slice(0, 200));
}

try { await main(); } catch (e) { failures++; console.log(`FAIL  stopped: ${e.message}`); console.log(log.slice(-1200)); }
if (child && child.exitCode === null) await stop();
console.log(`\n${failures} failed`);
process.exit(failures ? 1 : 0);
