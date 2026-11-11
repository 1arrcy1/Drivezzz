// The escrow on devnet, for real: every outcome in SOL and USDC with exact balances, and attacks that must fail.
// Run: node test/devnet.mjs <program id>    (keys are kept in ~/devnet; the deploy key must be the upgrade authority)
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  b58, unb58, key, loadKeypair, keypair, pda, ix, u64, send, simulate, balance, account, tokenBalance, rentFor, rpc, sleep,
  SYSTEM, TOKEN, ATA, LOADER, tokenAccountOf,
} from './sol.mjs';

const PROGRAM = unb58(process.argv[2] || fs.readFileSync(path.join(os.homedir(), 'devnet/program-id'), 'utf8').trim());
const FEE_WALLET = unb58('6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN');
const dir = path.join(os.homedir(), 'devnet');
fs.mkdirSync(dir, { recursive: true });
const K = (name) => loadKeypair(path.join(dir, `${name}.json`));
const admin = K('deployer');
const server = K('server');
const rider = K('rider');
const driver = K('driver');
const mintKey = K('test-usdc-mint');
const stranger = K('stranger');
const ALLOWANCE = 5000n;
const TIMEOUT_S = 10 * 60;

let failures = 0;
const results = [];
function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const custom = (err) => err?.InstructionError?.[1]?.Custom;
async function mustFail(name, instructions, signers, code) {
  const err = await simulate(instructions, signers);
  ok(name, err && (code === undefined || custom(err) === code), JSON.stringify(err));
}

// ---------- instructions ----------
const config = pda([Buffer.from('config')], PROGRAM);
const programdata = pda([PROGRAM], LOADER).address;
const initIx = (who, server_, fee, mint) => ix(PROGRAM, [[who, 1, 1], [config.address, 0, 1], [programdata], [SYSTEM]],
  Buffer.concat([Buffer.from([0, config.bump]), key(server_), key(fee), key(mint)]));
const updateIx = (who, server_, fee, newAdmin) => ix(PROGRAM, [[who, 1, 0], [config.address, 0, 1]],
  Buffer.concat([Buffer.from([1]), key(server_), key(fee), key(newAdmin)]));

function escrowFor(id) {
  const e = pda([Buffer.from('escrow'), id], PROGRAM);
  const v = pda([Buffer.from('vault'), id], PROGRAM);
  return { id, escrow: e.address, bump: e.bump, vault: v.address, vaultBump: v.bump };
}
function payIx(payer, esc, kind, driverAddr, driverAmount, feeAmount, mint = mintKey.pub) {
  const metas = [[payer, 1, 1], [config.address], [esc.escrow, 0, 1], [SYSTEM]];
  if (kind === 1) metas.push([mint], [tokenAccountOf(payer, mint), 0, 1], [esc.vault, 0, 1], [TOKEN]);
  return ix(PROGRAM, metas, Buffer.concat([Buffer.from([2]), esc.id, Buffer.from([esc.bump, esc.vaultBump, kind]), key(driverAddr), u64(driverAmount), u64(feeAmount)]));
}
function settleIx(who, esc, kind, outcome, o = {}) {
  const p = o.payer ?? rider.pub, d = o.driver ?? driver.pub, f = o.fee ?? FEE_WALLET;
  const metas = [[who, 1, 1], [config.address], [esc.escrow, 0, 1], [p, 0, 1], [d, 0, 1], [f, 0, 1]];
  if (kind === 1) {
    metas.push([o.vault ?? esc.vault, 0, 1], [o.payerToken ?? tokenAccountOf(p, mintKey.pub), 0, 1],
      [o.driverToken ?? tokenAccountOf(d, mintKey.pub), 0, 1], [o.feeToken ?? tokenAccountOf(f, mintKey.pub), 0, 1], [TOKEN]);
  }
  return ix(PROGRAM, metas, Buffer.from([3, outcome]));
}
function expireIx(who, esc, kind, o = {}) {
  const p = o.payer ?? rider.pub;
  const metas = [[who, 1, 1], [esc.escrow, 0, 1], [p, 0, 1]];
  if (kind === 1) metas.push([o.vault ?? esc.vault, 0, 1], [o.payerToken ?? tokenAccountOf(p, mintKey.pub), 0, 1], [TOKEN]);
  return ix(PROGRAM, metas, Buffer.from([4]));
}
const newId = () => crypto.randomBytes(16);

// ---------- setup ----------
const transfer = (from, to, lamports) => ix(SYSTEM, [[from, 1, 1], [to, 0, 1]], Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(lamports)]));
const createAta = (payer, owner, mint) => ix(ATA, [[payer, 1, 1], [tokenAccountOf(owner, mint), 0, 1], [owner], [mint], [SYSTEM], [TOKEN]], [1]);

async function fund(who, lamports) {
  const have = await balance(who);
  if (have < lamports) await send([transfer(admin.pub, key(who), lamports - have)], [admin]);
}

async function setup() {
  console.log(`program ${b58(PROGRAM)}\nadmin ${admin.address}\nserver ${server.address}\nrider ${rider.address}\ndriver ${driver.address}\nfee ${b58(FEE_WALLET)}`);
  console.log(`admin balance ${Number(await balance(admin)) / 1e9} SOL`);
  // A driver and the fee wallet need some SOL to exist; small payouts to an empty address would be refused by Solana's rent rule.
  await fund(server, 20_000_000n);
  await fund(rider, 200_000_000n);
  await fund(driver, 5_000_000n);
  await fund(stranger, 20_000_000n);
  await fund(FEE_WALLET, 5_000_000n);
  // Our own devnet "USDC": 6 decimals, minted by the admin.
  if (!(await account(mintKey))) {
    const rent = await rentFor(82);
    await send([
      ix(SYSTEM, [[admin, 1, 1], [mintKey, 1, 1]], Buffer.concat([Buffer.from([0, 0, 0, 0]), u64(rent), u64(82), TOKEN])),
      ix(TOKEN, [[mintKey, 0, 1]], Buffer.concat([Buffer.from([20, 6]), admin.pub, Buffer.from([0])])),
    ], [admin, mintKey]);
  }
  for (const owner of [rider.pub, driver.pub, FEE_WALLET, stranger.pub]) {
    if (!(await account(tokenAccountOf(owner, mintKey.pub)))) await send([createAta(admin.pub, owner, mintKey.pub)], [admin]);
  }
  const have = await tokenBalance(tokenAccountOf(rider.pub, mintKey.pub));
  if (have < 100_000_000n) {
    await send([ix(TOKEN, [[mintKey, 0, 1], [tokenAccountOf(rider.pub, mintKey.pub), 0, 1], [admin, 1, 0]], Buffer.concat([Buffer.from([7]), u64(100_000_000n - have)]))], [admin]);
  }
  console.log(`test USDC mint ${mintKey.address}`);
}

// ---------- tests ----------
async function initTests() {
  if (await account(config.address)) { console.log('config already there'); return; }
  await mustFail('init by someone who isn\'t the upgrade authority', [initIx(stranger.pub, server, FEE_WALLET, mintKey)], [stranger], 2);
  await send([initIx(admin.pub, server, FEE_WALLET, mintKey)], [admin]);
  const c = await account(config.address);
  ok('init by the upgrade authority', c && c.data[0] === 1 && c.data.subarray(34, 66).equals(server.pub) && c.data.subarray(66, 98).equals(FEE_WALLET));
}

async function configTests() {
  await mustFail('init a second time', [initIx(admin.pub, server, FEE_WALLET, mintKey)], [admin]);
  await mustFail('update by someone else', [updateIx(stranger.pub, stranger, stranger, stranger)], [stranger], 2);
  // Swap the server key to the stranger and back: only the admin can.
  await send([updateIx(admin.pub, stranger, FEE_WALLET, admin)], [admin]);
  ok('admin can change the server key', (await account(config.address)).data.subarray(34, 66).equals(stranger.pub));
  await send([updateIx(admin.pub, server, FEE_WALLET, admin)], [admin]);
  ok('and change it back', (await account(config.address)).data.subarray(34, 66).equals(server.pub));
}

// One full SOL ride: pay, settle, then check every balance to the lamport.
async function solRide(outcome, name) {
  const esc = escrowFor(newId());
  const driverAmount = 9_300_000n, feeAmount = 700_000n, total = driverAmount + feeAmount;
  const before = { rider: await balance(rider), driver: await balance(driver), fee: await balance(FEE_WALLET), server: await balance(server) };
  await send([payIx(rider.pub, esc, 0, driver.pub, driverAmount, feeAmount)], [rider]);
  const escrowRent = await rentFor(140);
  const held = await balance(esc.escrow);
  ok(`${name}: escrow holds price + deposit + allowance`, held === total + escrowRent + ALLOWANCE, `${held}`);
  await send([settleIx(server.pub, esc, 0, outcome)], [server]);
  const after = { rider: await balance(rider), driver: await balance(driver), fee: await balance(FEE_WALLET), server: await balance(server) };
  const toDriver = outcome === 0 ? driverAmount : outcome === 1 ? total / 2n : 0n;
  const toFee = outcome === 0 ? feeAmount : 0n;
  // The rider pays its own transaction fee and the allowance for the settle transaction, and gets back everything
  // not sent to the driver or the fee address.
  ok(`${name}: driver got ${toDriver}`, after.driver - before.driver === toDriver, `${after.driver - before.driver}`);
  ok(`${name}: fee address got ${toFee}`, after.fee - before.fee === toFee, `${after.fee - before.fee}`);
  ok(`${name}: rider paid exactly driver + fee + both network fees`, before.rider - after.rider === toDriver + toFee + 5000n + ALLOWANCE, `${before.rider - after.rider}`);
  ok(`${name}: server's wallet unchanged (fee paid back)`, after.server === before.server, `${after.server - before.server}`);
  ok(`${name}: escrow closed`, !(await account(esc.escrow)));
  return esc;
}

async function usdcRide(outcome, name, extra = 0n) {
  const esc = escrowFor(newId());
  const driverAmount = 4_900_000n, feeAmount = 100_000n, total = driverAmount + feeAmount; // €5 ride, €0.10 fee
  const t = (o) => tokenBalance(tokenAccountOf(o, mintKey.pub));
  const before = { rider: await t(rider.pub), driver: await t(driver.pub), fee: await t(FEE_WALLET), riderSol: await balance(rider), server: await balance(server) };
  await send([payIx(rider.pub, esc, 1, driver.pub, driverAmount, feeAmount)], [rider]);
  ok(`${name}: vault holds the price`, (await tokenBalance(esc.vault)) === total);
  if (extra) {
    // Someone sends extra tokens to the vault: it must still close, the extra going to the rider.
    await send([ix(TOKEN, [[mintKey, 0, 1], [esc.vault, 0, 1], [admin, 1, 0]], Buffer.concat([Buffer.from([7]), u64(extra)]))], [admin]);
  }
  await send([settleIx(server.pub, esc, 1, outcome)], [server]);
  const after = { rider: await t(rider.pub), driver: await t(driver.pub), fee: await t(FEE_WALLET), riderSol: await balance(rider), server: await balance(server) };
  const toDriver = outcome === 0 ? driverAmount : outcome === 1 ? total / 2n : 0n;
  const toFee = outcome === 0 ? feeAmount : 0n;
  ok(`${name}: driver got ${toDriver}`, after.driver - before.driver === toDriver, `${after.driver - before.driver}`);
  ok(`${name}: fee address got ${toFee}`, after.fee - before.fee === toFee);
  ok(`${name}: rider's USDC down by exactly driver + fee`, before.rider - after.rider === toDriver + toFee - extra, `${before.rider - after.rider}`);
  ok(`${name}: rider's SOL down by both network fees only (deposits back)`, before.riderSol - after.riderSol === 5000n + ALLOWANCE, `${before.riderSol - after.riderSol}`);
  ok(`${name}: server's wallet unchanged`, after.server === before.server);
  ok(`${name}: escrow and vault closed`, !(await account(esc.escrow)) && !(await account(esc.vault)));
}

async function attackTests() {
  // A paid SOL escrow to attack.
  const esc = escrowFor(newId());
  await send([payIx(rider.pub, esc, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await mustFail('settle by someone other than the server', [settleIx(stranger.pub, esc, 0, 0)], [stranger], 2);
  await mustFail('settle paying another "driver"', [settleIx(server.pub, esc, 0, 0, { driver: stranger.pub })], [server], 1);
  await mustFail('settle with another fee address', [settleIx(server.pub, esc, 0, 0, { fee: stranger.pub })], [server], 1);
  await mustFail('settle refunding another "rider"', [settleIx(server.pub, esc, 0, 2, { payer: stranger.pub })], [server], 1);
  await mustFail('settle with an unknown outcome', [settleIx(server.pub, esc, 0, 7)], [server], 3);
  await mustFail('expire before the timeout', [expireIx(stranger.pub, esc, 0)], [stranger], 4);
  await mustFail('expire paying another address', [expireIx(stranger.pub, esc, 0, { payer: stranger.pub })], [stranger], 1);
  await mustFail('the same id paid twice', [payIx(rider.pub, esc, 0, driver.pub, 1n, 1n)], [rider]);
  const own = escrowFor(newId());
  await mustFail('pay with the escrow as its own driver', [payIx(rider.pub, own, 0, own.escrow, 1n, 1n)], [rider], 1);
  await mustFail('pay nothing', [payIx(rider.pub, escrowFor(newId()), 0, driver.pub, 0n, 0n)], [rider], 3);
  await mustFail('amounts that overflow', [payIx(rider.pub, escrowFor(newId()), 0, driver.pub, 2n ** 64n - 1n, 2n)], [rider], 5);
  const wrongBump = escrowFor(newId());
  wrongBump.escrow = escrowFor(newId()).escrow;
  await mustFail('pay into an escrow address of another id', [payIx(rider.pub, wrongBump, 0, driver.pub, 1n, 1n)], [rider], 1);
  // Settle it for real, then try again.
  await send([settleIx(server.pub, esc, 0, 2)], [server]);
  await mustFail('settle the same escrow twice', [settleIx(server.pub, esc, 0, 0)], [server], 1);
  await mustFail('settle twice in one transaction', [settleIx(server.pub, escrowFor(newId()), 0, 0), settleIx(server.pub, escrowFor(newId()), 0, 0)], [server]);

  // USDC attacks.
  const u = escrowFor(newId());
  const fake = keypair();
  await send([ix(SYSTEM, [[admin, 1, 1], [fake, 1, 1]], Buffer.concat([Buffer.from([0, 0, 0, 0]), u64(await rentFor(82)), u64(82), TOKEN])),
    ix(TOKEN, [[fake, 0, 1]], Buffer.concat([Buffer.from([20, 6]), admin.pub, Buffer.from([0])]))], [admin, fake]);
  await send([createAta(admin.pub, rider.pub, fake.pub), ix(TOKEN, [[fake, 0, 1], [tokenAccountOf(rider.pub, fake.pub), 0, 1], [admin, 1, 0]], Buffer.concat([Buffer.from([7]), u64(5_000_000n)]))], [admin]);
  await mustFail('pay in a fake token', [payIx(rider.pub, u, 1, driver.pub, 1_000_000n, 0n, fake.pub)], [rider], 1);
  await send([payIx(rider.pub, u, 1, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await mustFail('settle into a token account of someone else', [settleIx(server.pub, u, 1, 0, { driverToken: tokenAccountOf(stranger.pub, mintKey.pub) })], [server], 1);
  await mustFail('refund into a token account of someone else', [settleIx(server.pub, u, 1, 2, { payerToken: tokenAccountOf(stranger.pub, mintKey.pub) })], [server], 1);
  // A look-alike vault: a token account owned by the escrow, but not the real one.
  const decoy = keypair();
  await send([ix(SYSTEM, [[admin, 1, 1], [decoy, 1, 1]], Buffer.concat([Buffer.from([0, 0, 0, 0]), u64(await rentFor(165)), u64(165), TOKEN])),
    ix(TOKEN, [[decoy, 0, 1], [mintKey]], Buffer.concat([Buffer.from([18]), u.escrow]))], [admin, decoy]);
  await mustFail('settle with a look-alike vault', [settleIx(server.pub, u, 1, 2, { vault: decoy.pub })], [server], 1);
  await mustFail('expire with a look-alike vault', [expireIx(stranger.pub, u, 1, { vault: decoy.pub })], [stranger]);
  await mustFail('settle a USDC escrow without its token accounts', [settleIx(server.pub, u, 0, 0)], [server]);
  await send([settleIx(server.pub, u, 1, 2)], [server]);
  ok('the attacked USDC escrow still refunds normally', !(await account(u.escrow)));
}

async function main() {
  await setup();
  await initTests();
  await configTests();
  // Two escrows left alone, to expire after the timeout.
  const oldSol = escrowFor(newId());
  const oldUsdc = escrowFor(newId());
  await send([payIx(rider.pub, oldSol, 0, driver.pub, 2_000_000n, 100_000n)], [rider]);
  await send([payIx(rider.pub, oldUsdc, 1, driver.pub, 2_000_000n, 100_000n)], [rider]);
  const startedAt = Date.now();

  await solRide(0, 'SOL pay out');
  await solRide(1, 'SOL 50/50');
  await solRide(2, 'SOL refund');
  await usdcRide(0, 'USDC pay out');
  await usdcRide(1, 'USDC 50/50');
  await usdcRide(2, 'USDC refund');
  await usdcRide(0, 'USDC pay out with extra tokens sent to the vault', 12_345n);
  await attackTests();

  const wait = TIMEOUT_S * 1000 + 30_000 - (Date.now() - startedAt);
  if (wait > 0) { console.log(`waiting ${Math.ceil(wait / 1000)} s for the timeout…`); await sleep(wait); }
  // Past the timeout, a look-alike vault must still be refused (before the timeout the time check stops it first).
  const decoy = keypair();
  await send([ix(SYSTEM, [[admin, 1, 1], [decoy, 1, 1]], Buffer.concat([Buffer.from([0, 0, 0, 0]), u64(await rentFor(165)), u64(165), TOKEN])),
    ix(TOKEN, [[decoy, 0, 1], [mintKey]], Buffer.concat([Buffer.from([18]), oldUsdc.escrow]))], [admin, decoy]);
  await mustFail('expire with a look-alike vault, after the timeout', [expireIx(stranger.pub, oldUsdc, 1, { vault: decoy.pub })], [stranger], 1);
  await mustFail('expire paying another address, after the timeout', [expireIx(stranger.pub, oldSol, 0, { payer: stranger.pub })], [stranger], 1);
  const r0 = await balance(rider), t0 = await tokenBalance(tokenAccountOf(rider.pub, mintKey.pub)), s0 = await balance(stranger);
  await send([expireIx(stranger.pub, oldSol, 0)], [stranger]);
  await send([expireIx(stranger.pub, oldUsdc, 1)], [stranger]);
  const escrowRent = await rentFor(140), vaultRent = await rentFor(165);
  ok('expire: SOL escrow refunded to the rider by a stranger', (await balance(rider)) - r0 === 2_100_000n + escrowRent * 2n + vaultRent, `${(await balance(rider)) - r0}`);
  ok('expire: USDC refunded', (await tokenBalance(tokenAccountOf(rider.pub, mintKey.pub))) - t0 === 2_100_000n);
  ok('expire: the stranger got its fees back, nothing more', (await balance(stranger)) === s0);
  ok('expire: escrows closed', !(await account(oldSol.escrow)) && !(await account(oldUsdc.escrow)) && !(await account(oldUsdc.vault)));

  console.log(`\n${results.filter((r) => r.pass).length} passed, ${failures} failed`);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 1));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
