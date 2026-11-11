// The server and the escrow together on devnet, the way the app and a wallet use them: a rider orders, a driver accepts,
// the rider's wallet asks the server for the payment (Solana Pay) and signs it, and the server refunds or pays out.
// Run on the server against a DEV=1 instance with the devnet escrow:  node test/e2e-server.mjs http://127.0.0.1:8081
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { b58, unb58, loadKeypair, balance, tokenBalance, tokenAccountOf, rpc, sleep } from './sol.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8081';
const dir = path.join(os.homedir(), 'devnet');
const rider = loadKeypair(path.join(dir, 'rider.json'));
const driverKey = loadKeypair(path.join(dir, 'driver.json'));
const MINT = loadKeypair(path.join(dir, 'test-usdc-mint.json')).pub;
const FEE = unb58('6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN');

let failures = 0;
const ok = (name, cond, detail = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const dev = (p) => fetch(BASE + p, { method: 'POST' }).then((r) => r.json());
function client() {
  let token;
  const call = async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-device-id': `e2e-${crypto.randomBytes(4).toString('hex')}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  return { upload: (p) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'image/jpeg', authorization: `Bearer ${token}` }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) }),
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), async start() { const r = await call('POST', '/api/auth/continue', {}); token = r.token; this.id = r.user.id; } };
}
const at = { lat: 52.37, lng: 4.89 };
const pickup = { ...at, label: 'Dam, Amsterdam' };
const dropoff = { lat: 52.36, lng: 4.88, label: 'Museumplein, Amsterdam' };

// What a wallet does with a Solana Pay link: POST its address, sign the transaction it gets back, send it.
async function walletPays(payUrl, signer) {
  const url = decodeURIComponent(payUrl.slice('solana:'.length));
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: signer.address }) }).then((r) => r.json());
  if (!res.transaction) throw new Error(`no transaction: ${JSON.stringify(res)}`);
  const tx = Buffer.from(res.transaction, 'base64');
  const message = tx.subarray(1 + 64 * tx[0]);
  const sig = crypto.sign(null, message, crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), signer.seed]), format: 'der', type: 'pkcs8' }));
  sig.copy(tx, 1);
  const signature = await rpc('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  for (let i = 0; i < 40; i++) {
    const st = (await rpc('getSignatureStatuses', [[signature]])).value[0];
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return { signature, message: res.message };
    if (st?.err) throw new Error(`payment failed ${JSON.stringify(st.err)}`);
    await sleep(800);
  }
  throw new Error('payment not confirmed');
}
// The app with a wallet that only signs (Phantom's and Solflare's links, WalletConnect): the app asks for the payment,
// the wallet signs it, and the server sends it on.
async function appPays(r, rideId, signer) {
  const res = await r.post(`/api/rides/${rideId}/pay`, { account: signer.address });
  if (!res.transaction) throw new Error(`no transaction: ${JSON.stringify(res)}`);
  const tx = Buffer.from(res.transaction, 'base64');
  const message = tx.subarray(1 + 64 * tx[0]);
  crypto.sign(null, message, crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), signer.seed]), format: 'der', type: 'pkcs8' })).copy(tx, 1);
  return r.post(`/api/rides/${rideId}/pay/send`, { transaction: tx.toString('base64') });
}
async function settleOnChain(r, rideId) {
  for (let i = 0; i < 20; i++) {
    await dev('/dev/money');
    const ride = (await r.get(`/api/rides/${rideId}`)).ride;
    if (ride.escrow?.status === 'settled') return ride;
    await sleep(2000);
  }
  return (await r.get(`/api/rides/${rideId}`)).ride;
}

async function main() {
  const d = client(); await d.start();
  await d.post('/api/driver/enable');
  const car = await d.post('/api/cars', { plate: `E2E${Math.floor(Math.random() * 900) + 100}`, make: 'Toyota', model: 'Prius', seats: 4, perKmCents: 90, perMinCents: 20, pickupPerKmCents: 50 });
  for (const kind of ['front', 'back', 'inside']) await d.upload(`/api/cars/${car.car.id}/photos?kind=${kind}`);
  for (const coin of ['sol', 'usdc-sol']) await d.post('/api/wallet/address', { coin, address: driverKey.address, via: 'Test' });
  await d.post('/api/driver/rules-seen');
  ok('driver online', (await d.post('/api/driver/online', at)).driver?.online === true);
  const r = client(); await r.start();
  await r.post('/api/location', at);

  for (const coin of ['sol', 'usdc-sol']) {
    const name = coin === 'sol' ? 'SOL' : 'USDC';
    // 1. Paid, then the driver cancels: refunded on the chain.
    const made = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'driver', driverId: d.id, coin });
    ok(`${name}: ordered`, made.status === 200, JSON.stringify(made).slice(0, 200));
    await d.post(`/api/rides/${made.ride.id}/accept`);
    const asked = (await r.get(`/api/rides/${made.ride.id}`)).ride;
    ok(`${name}: a Solana Pay link`, asked.payUrl?.startsWith('solana:'));
    const before = coin === 'sol' ? await balance(rider) : await tokenBalance(tokenAccountOf(rider.pub, MINT));
    const paid = await walletPays(asked.payUrl, rider);
    ok(`${name}: the wallet paid on devnet`, Boolean(paid.signature), paid.message);
    await dev('/dev/payments');
    const accepted = (await r.get(`/api/rides/${made.ride.id}`)).ride;
    ok(`${name}: the server saw it: accepted`, accepted.status === 'accepted' && accepted.escrow?.status === 'paid', `${accepted.status} ${accepted.escrow?.status}`);
    await d.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Other' });
    const refunded = await settleOnChain(r, made.ride.id);
    ok(`${name}: refunded on devnet`, refunded.escrow?.status === 'settled' && refunded.escrow.outcome === 'refund', refunded.escrow?.settleExplorer);
    const after = coin === 'sol' ? await balance(rider) : await tokenBalance(tokenAccountOf(rider.pub, MINT));
    // SOL: only the network fees are gone (two base fees of 5000 lamports, and the priority fee on paying); USDC: all of it is back.
    ok(`${name}: the rider has everything back but the network fees`, coin === 'sol' ? before - after >= 10_000n && before - after <= 22_000n : before === after, `${before - after}`);

    // 2. A ride that's checked out: paid out to the driver, the fee to the fee address.
    const ride = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'driver', driverId: d.id, coin });
    await d.post(`/api/rides/${ride.ride.id}/accept`);
    await walletPays((await r.get(`/api/rides/${ride.ride.id}`)).ride.payUrl, rider);
    await dev('/dev/payments');
    const paidRide = (await r.get(`/api/rides/${ride.ride.id}`)).ride;
    await d.post('/api/location', { ...at, driving: true });
    await r.post('/api/location', at);
    ok(`${name}: checked in`, (await r.post(`/api/rides/${ride.ride.id}/check-in`, { ...at, plateChecked: true })).ride?.status === 'riding');
    await d.post('/api/location', { ...dropoff, driving: true });
    await r.post('/api/location', dropoff);
    ok(`${name}: checked out`, (await d.post(`/api/rides/${ride.ride.id}/check-out`, dropoff)).ride?.status === 'completed');
    const driverBefore = coin === 'sol' ? await balance(driverKey) : await tokenBalance(tokenAccountOf(driverKey.pub, MINT));
    const feeBefore = coin === 'sol' ? await balance(FEE) : await tokenBalance(tokenAccountOf(FEE, MINT));
    await dev('/dev/money');
    ok(`${name}: not paid out before 24 hours`, (await r.get(`/api/rides/${ride.ride.id}`)).ride.escrow.status === 'paid');
    await dev(`/dev/clock?ms=${24 * 3600_000 + 60_000}`);
    const done = await settleOnChain(r, ride.ride.id);
    ok(`${name}: paid out on devnet`, done.escrow?.status === 'settled' && done.escrow.outcome === 'payout', done.escrow?.settleExplorer);
    const driverAfter = coin === 'sol' ? await balance(driverKey) : await tokenBalance(tokenAccountOf(driverKey.pub, MINT));
    const feeAfter = coin === 'sol' ? await balance(FEE) : await tokenBalance(tokenAccountOf(FEE, MINT));
    const decimals = coin === 'sol' ? 1e9 : 1e6;
    ok(`${name}: the driver got the price minus the fee`, Number(driverAfter - driverBefore) / decimals === Number(paidRide.escrow.driverAmount), `${Number(driverAfter - driverBefore) / decimals} vs ${paidRide.escrow.driverAmount}`);
    ok(`${name}: the fee address got the fee`, Number(feeAfter - feeBefore) / decimals === Number(paidRide.escrow.feeAmount), `${Number(feeAfter - feeBefore) / decimals}`);
    await d.post('/api/driver/online', at);
  }
  // 3. A wallet that only signs: the server sends what it signed, and nothing else.
  // A wallet nobody has ever used: on the curve, no SOL, no USDC account.
  const fresh = b58(crypto.createPublicKey(crypto.generateKeyPairSync('ed25519').privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));
  for (const coin of ['sol', 'usdc-sol']) {
    const name = coin === 'sol' ? 'SOL' : 'USDC';
    const made = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'driver', driverId: d.id, coin });
    await d.post(`/api/rides/${made.ride.id}/accept`);
    const bad = await r.post(`/api/rides/${made.ride.id}/pay/send`, { transaction: Buffer.alloc(300, 7).toString('base64') });
    ok(`${name}: the server sends nothing but this payment`, bad.code === 'bad_transaction', bad.code);
    const unsigned = (await r.post(`/api/rides/${made.ride.id}/pay`, { account: rider.address })).transaction;
    const notSigned = await r.post(`/api/rides/${made.ride.id}/pay/send`, { transaction: unsigned });
    ok(`${name}: an unsigned payment isn't sent`, notSigned.code === 'bad_transaction', notSigned.code);
    const short = await r.post(`/api/rides/${made.ride.id}/pay`, { account: fresh });
    ok(`${name}: an empty wallet is told so`, short.code === 'short', short.message);
    const sent = await appPays(r, made.ride.id, rider);
    ok(`${name}: the server sent what the wallet signed`, sent.ok === true, JSON.stringify(sent).slice(0, 200));
    let seen;
    for (let i = 0; i < 20; i++) {
      await dev('/dev/payments');
      seen = (await r.get(`/api/rides/${made.ride.id}`)).ride;
      if (seen.status === 'accepted') break;
      await sleep(1500);
    }
    ok(`${name}: and it landed: accepted`, seen.status === 'accepted' && seen.escrow?.status === 'paid', `${seen.status} ${seen.escrow?.status}`);
    await d.post(`/api/rides/${made.ride.id}/driver-cancel`, { reason: 'Other' });
    const refunded = await settleOnChain(r, made.ride.id);
    ok(`${name}: refunded`, refunded.escrow?.status === 'settled' && refunded.escrow.outcome === 'refund', refunded.escrow?.settleExplorer);
    await d.post('/api/driver/online', at);
  }

  // 4. A driver's wallet without a USDC account: USDC stays off, so no USDC ride reaches a payout that would fail. A new driver:
  // a connected wallet is locked since 4 November (only the first one is free), so an existing driver can't switch to one.
  await d.post('/api/driver/offline');
  const d2 = client(); await d2.start();
  await d2.post('/api/driver/enable');
  const car2 = await d2.post('/api/cars', { plate: `E2F${Math.floor(Math.random() * 900) + 100}`, make: 'Toyota', model: 'Prius', seats: 4, perKmCents: 90, perMinCents: 20, pickupPerKmCents: 50 });
  for (const kind of ['front', 'back', 'inside']) await d2.upload(`/api/cars/${car2.car.id}/photos?kind=${kind}`);
  const connected = await d2.post('/api/wallet/address', { coin: 'usdc-sol', address: fresh, via: 'Test' });
  const usdc = connected.coins?.find((c) => c.id === 'usdc-sol');
  ok('no USDC account: saved, but off and explained', usdc?.address === fresh && usdc.enabled === false && usdc.needsTokenAccount === true, JSON.stringify(usdc ?? connected).slice(0, 200));
  const on = await d2.post('/api/wallet/enable', { coin: 'usdc-sol', enabled: true });
  ok('no USDC account: can\'t be turned on', on.code === 'no_usdc_account', on.message);
  await d2.post('/api/wallet/address', { coin: 'sol', address: fresh, via: 'Test' });
  await d2.post('/api/driver/rules-seen');
  ok('no USDC account: online with SOL', (await d2.post('/api/driver/online', at)).driver?.online === true);
  const made = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'driver', driverId: d2.id, coin: 'usdc-sol' });
  const took = made.ride ? await d2.post(`/api/rides/${made.ride.id}/accept`) : null;
  ok('no USDC account: a USDC ride can\'t be taken', made.status !== 200 || took?.code === 'coin_off', made.code ?? took?.code);
  if (made.ride) await r.post(`/api/rides/${made.ride.id}/cancel`);
  // The same driver in SOL: so it was the coin, not something else.
  const inSol = await r.post('/api/rides', { pickup, dropoff, passengers: 1, mode: 'driver', driverId: d2.id, coin: 'sol' });
  ok('no USDC account: the same driver takes SOL', inSol.status === 200, inSol.code);
  if (inSol.ride) await r.post(`/api/rides/${inSol.ride.id}/cancel`);

  await d2.post('/api/driver/offline');
  console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
