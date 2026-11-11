// More of the escrow on devnet, past devnet.mjs: broken instructions, forged accounts, wallets that changed after paying, two
// settles racing, keys changed mid-ride, the rent rule, the timeout. Whatever fails must leave the money where it was.
// Run after devnet.mjs set things up: node test/edge.mjs. It takes over 10 minutes: it waits for the devnet timeout.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chainClock,
  b58, unb58, key, loadKeypair, keypair, pda, ix, u64, send, simulate, balance, account, tokenBalance, rentFor, rpc, sleep, transaction, blockhash,
  SYSTEM, TOKEN, ATA, tokenAccountOf,
} from './sol.mjs';

const dir = path.join(os.homedir(), 'devnet');
const K = (name) => loadKeypair(path.join(dir, `${name}.json`));
const PROGRAM = unb58(fs.readFileSync(path.join(dir, 'program-id'), 'utf8').trim());
const FEE = unb58('6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN');
const TOKEN22 = unb58('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const admin = K('deployer'), server = K('server'), rider = K('rider'), driver = K('driver'), stranger = K('stranger'), mintKey = K('test-usdc-mint');
const MINT = mintKey.pub;
const ALLOWANCE = 5000n, TIMEOUT_MS = 10 * 60_000;
const config = pda([Buffer.from('config')], PROGRAM);

let failures = 0, passes = 0;
function ok(name, cond, detail = '') {
  if (cond) passes++; else failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
}
const part = (t) => console.log(`\n--- ${t}`);
const eq = (name, got, want) => ok(name, got === want, got === want ? '' : `got ${got}, wanted ${want}`);
const custom = (err) => err?.InstructionError?.[1]?.Custom;
async function refused(name, instructions, signers, code) {
  const err = await simulate(instructions, signers);
  ok(name, err && (code === undefined || custom(err) === code), JSON.stringify(err));
}
// The same, for a transaction that really goes out: it must fail on the chain and change nothing.
const fails = async (name, instructions, signers, code) => {
  try {
    await send(instructions, signers);
    ok(name, false, 'it went through');
  } catch (e) {
    const err = e.txErr ?? e.rpc?.data?.err;
    ok(name, Boolean(err) && (code === undefined || custom(err) === code), JSON.stringify(err ?? e.message).slice(0, 120));
  }
};

const newEscrow = (id = crypto.randomBytes(16)) => {
  const e = pda([Buffer.from('escrow'), id], PROGRAM), v = pda([Buffer.from('vault'), id], PROGRAM);
  return { id, escrow: e.address, bump: e.bump, vault: v.address, vaultBump: v.bump };
};
function payIx(payer, esc, kind, driverAddr, driverAmount, feeAmount, o = {}) {
  const metas = [[payer, o.unsigned ? 0 : 1, 1], [config.address], [esc.escrow, 0, 1], [o.system ?? SYSTEM]];
  if (kind === 1) metas.push([o.mint ?? MINT], [o.payerToken ?? tokenAccountOf(payer, MINT), 0, 1], [o.vault ?? esc.vault, 0, 1], [o.token ?? TOKEN]);
  return ix(PROGRAM, metas, Buffer.concat([Buffer.from([2]), esc.id, Buffer.from([esc.bump, esc.vaultBump, o.kindByte ?? kind]), key(driverAddr), u64(driverAmount), u64(feeAmount)]));
}
function settleIx(who, esc, kind, outcome, o = {}) {
  const p = o.payer ?? rider.pub, d = o.driver ?? driver.pub, f = o.fee ?? FEE;
  const metas = [[who, o.unsigned ? 0 : 1, 1], [o.config ?? config.address], [o.escrowAccount ?? esc.escrow, 0, 1], [p, 0, 1], [d, 0, 1], [f, 0, 1]];
  if (kind === 1) {
    metas.push([o.vault ?? esc.vault, 0, 1], [o.payerToken ?? tokenAccountOf(p, MINT), 0, 1], [o.driverToken ?? tokenAccountOf(d, MINT), 0, 1], [o.feeToken ?? tokenAccountOf(f, MINT), 0, 1], [o.token ?? TOKEN]);
  }
  return ix(PROGRAM, metas, Buffer.from([3, outcome]));
}
function expireIx(who, esc, kind, o = {}) {
  const p = o.payer ?? rider.pub;
  const metas = [[who, o.unsigned ? 0 : 1, 1], [esc.escrow, 0, 1], [p, 0, 1]];
  if (kind === 1) metas.push([o.vault ?? esc.vault, 0, 1], [o.payerToken ?? tokenAccountOf(p, MINT), 0, 1], [TOKEN]);
  return ix(PROGRAM, metas, Buffer.from([4]));
}
const updateIx = (who, server_, fee, newAdmin) => ix(PROGRAM, [[who, 1, 0], [config.address, 0, 1]], Buffer.concat([Buffer.from([1]), key(server_), key(fee), key(newAdmin)]));
const transfer = (from, to, lamports) => ix(SYSTEM, [[from, 1, 1], [to, 0, 1]], Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(lamports)]));
const createAta = (payer, owner, mint = MINT) => ix(ATA, [[payer, 1, 1], [tokenAccountOf(owner, mint), 0, 1], [owner], [mint], [SYSTEM], [TOKEN]], [1]);
const closeAta = (owner) => ix(TOKEN, [[tokenAccountOf(owner, MINT), 0, 1], [owner, 0, 1], [owner, 1, 0]], [9]);
const mintTo = (owner, amount) => ix(TOKEN, [[MINT, 0, 1], [tokenAccountOf(owner, MINT), 0, 1], [admin, 1, 0]], Buffer.concat([Buffer.from([7]), u64(amount)]));
const tokenSend = (from, to, amount, signer) => ix(TOKEN, [[from, 0, 1], [to, 0, 1], [signer, 1, 0]], Buffer.concat([Buffer.from([3]), u64(amount)]));
const setOwner = (owner, newOwner, account_ = tokenAccountOf(owner, MINT)) => ix(TOKEN, [[account_, 0, 1], [owner, 1, 0]], Buffer.concat([Buffer.from([6, 2, 1]), key(newOwner)]));
const tokens = async (owner) => (await tokenBalance(tokenAccountOf(owner, MINT))) ?? 0n;

async function wallet(lamports = 30_000_000n, usdc = 0n) {
  const k = keypair();
  await send([transfer(admin.pub, k.pub, lamports)], [admin]);
  if (usdc) await send([createAta(admin.pub, k.pub), mintTo(k.pub, usdc)], [admin]);
  return k;
}
const cost = async (instructions, signers) => {
  const t = transaction(instructions, signers, await blockhash());
  const r = await rpc('simulateTransaction', [t.toString('base64'), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }]);
  return { units: r.value.unitsConsumed, bytes: t.length, err: r.value.err };
};

async function brokenInstructions() {
  part('Broken instructions: all refused, nothing moves');
  const esc = newEscrow();
  await refused('an unknown instruction', [ix(PROGRAM, [[stranger, 1, 1]], [9])], [stranger], 3);
  await refused('no data at all', [ix(PROGRAM, [[stranger, 1, 1]], [])], [stranger], 3);
  await refused('pay with too little data', [ix(PROGRAM, [[rider, 1, 1], [config.address], [esc.escrow, 0, 1], [SYSTEM]], Buffer.concat([Buffer.from([2]), esc.id]))], [rider], 3);
  const whole = payIx(rider.pub, esc, 0, driver.pub, 1000n, 1000n);
  await refused('pay with too much data', [{ ...whole, data: Buffer.concat([whole.data, Buffer.from([0])]) }], [rider], 3);
  await refused('pay with an unknown coin', [payIx(rider.pub, esc, 0, driver.pub, 1000n, 1000n, { kindByte: 2 })], [rider], 3);
  await refused('pay with too few accounts', [ix(PROGRAM, [[rider, 1, 1], [config.address]], whole.data)], [rider]);
  await refused('pay in USDC without its token accounts', [ix(PROGRAM, [[rider, 1, 1], [config.address], [esc.escrow, 0, 1], [SYSTEM]], payIx(rider.pub, esc, 1, driver.pub, 1000n, 1000n).data)], [rider]);
  await refused('settle with too few accounts', [ix(PROGRAM, [[server, 1, 1], [config.address]], [3, 0])], [server]);
  await refused('settle with too much data', [ix(PROGRAM, settleIx(server.pub, esc, 0, 0).metas.map((m) => [m.key, m.signer, m.writable]), [3, 0, 0])], [server], 3);
  await refused('expire with too few accounts', [ix(PROGRAM, [[stranger, 1, 1]], [4])], [stranger]);
  await refused('update with too little data', [ix(PROGRAM, [[admin, 1, 0], [config.address, 0, 1]], [1, 0, 0])], [admin], 3);
  await refused('init with too little data', [ix(PROGRAM, [[admin, 1, 1], [config.address, 0, 1], [config.address], [SYSTEM]], [0, 0])], [admin], 3);
}

async function forgedThings() {
  part('Forged accounts and missing signatures');
  const esc = newEscrow();
  // Someone else's wallet, without their signature: the person sending pays only the network fee.
  await refused('paying from a wallet that didn\'t sign', [payIx(rider.pub, esc, 0, driver.pub, 1000n, 1000n, { unsigned: true })], [stranger], 2);
  await refused('paying from someone else\'s USDC', [payIx(stranger.pub, newEscrow(), 1, driver.pub, 1000n, 1000n, { payerToken: tokenAccountOf(rider.pub, MINT) })], [stranger]);
  await refused('paying through a fake system program', [payIx(rider.pub, newEscrow(), 0, driver.pub, 1000n, 1000n, { system: stranger.pub })], [rider], 1);
  await refused('paying through the newer token program', [payIx(rider.pub, newEscrow(), 1, driver.pub, 1000n, 1000n, { token: TOKEN22 })], [rider], 1);
  const v = newEscrow();
  await refused('paying with the vault as the driver', [payIx(rider.pub, v, 1, v.vault, 1000n, 1000n)], [rider], 1);
  const w = newEscrow();
  await refused('paying into a vault of another id', [payIx(rider.pub, w, 1, driver.pub, 1000n, 1000n, { vault: newEscrow().vault })], [rider]);

  const paid = newEscrow();
  await send([payIx(rider.pub, paid, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await refused('settle naming the server without its signature', [settleIx(server.pub, paid, 0, 0, { unsigned: true })], [stranger], 2);
  await refused('settle by the admin, who isn\'t the server', [settleIx(admin.pub, paid, 0, 0)], [admin], 2);
  await refused('settle with a wallet as the settings', [settleIx(server.pub, paid, 0, 0, { config: stranger.pub })], [server], 1);
  await refused('settle with an escrow as the settings', [settleIx(server.pub, paid, 0, 0, { config: paid.escrow })], [server], 1);
  await refused('settle with the settings as the escrow', [settleIx(server.pub, paid, 0, 0, { escrowAccount: config.address })], [server], 1);
  await refused('settle with a wallet as the escrow', [settleIx(server.pub, paid, 0, 0, { escrowAccount: stranger.pub })], [server], 1);
  await refused('expire naming a sender without a signature', [expireIx(rider.pub, paid, 0, { unsigned: true })], [stranger], 2);
  await send([settleIx(server.pub, paid, 0, 2)], [server]);

  const u = newEscrow();
  await send([payIx(rider.pub, u, 1, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await refused('settle through the wrong token program', [settleIx(server.pub, u, 1, 0, { token: TOKEN22 })], [server], 1);
  await refused('the fee into someone else\'s token account', [settleIx(server.pub, u, 1, 0, { feeToken: tokenAccountOf(stranger.pub, MINT) })], [server], 1);
  await refused('the rider\'s part into the vault itself', [settleIx(server.pub, u, 1, 2, { payerToken: u.vault })], [server], 1);
  await refused('the driver\'s part into the vault itself', [settleIx(server.pub, u, 1, 0, { driverToken: u.vault })], [server], 1);
  await send([settleIx(server.pub, u, 1, 2)], [server]);
  ok('after all that it still refunds', !(await account(u.escrow)));
}

// Every outcome with a wallet paying itself, or money sent in on top: exact to the unit.
async function exactMoney() {
  part('Exact money in unusual cases');
  const rent = await rentFor(140);
  // SOL sent to the escrow on top: back to the rider, the others get exactly their part.
  const extra = newEscrow();
  let before = { r: await balance(rider), d: await balance(driver), f: await balance(FEE) };
  await send([payIx(rider.pub, extra, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([transfer(stranger.pub, extra.escrow, 777n)], [stranger]);
  await send([settleIx(server.pub, extra, 0, 0)], [server]);
  eq('SOL on top: the driver gets exactly their part', await balance(driver) - before.d, 1_000_000n);
  eq('SOL on top: the fee address exactly the fee', await balance(FEE) - before.f, 100_000n);
  eq('SOL on top: goes to the rider', before.r - await balance(rider), 1_100_000n - 777n + 5000n + ALLOWANCE);

  // An odd amount can't be halved: the rider gets the extra unit.
  for (const coin of [0, 1]) {
    const odd = newEscrow();
    const [r0, d0] = coin ? [await tokens(rider.pub), await tokens(driver.pub)] : [await balance(rider), await balance(driver)];
    await send([payIx(rider.pub, odd, coin, driver.pub, 1_000_001n, 0n)], [rider]);
    await send([settleIx(server.pub, odd, coin, 1)], [server]);
    const [r1, d1] = coin ? [await tokens(rider.pub), await tokens(driver.pub)] : [await balance(rider), await balance(driver)];
    eq(`${coin ? 'USDC' : 'SOL'} 50/50 of an odd amount: the driver gets the lower half`, d1 - d0, 500_000n);
    eq(`${coin ? 'USDC' : 'SOL'} 50/50 of an odd amount: the rider the rest`, r0 - r1, coin ? 500_000n : 500_000n + 5000n + ALLOWANCE);
  }
  // The smallest amounts.
  const one = newEscrow();
  const t0 = await tokens(rider.pub);
  await send([payIx(rider.pub, one, 1, driver.pub, 1n, 0n)], [rider]);
  await send([settleIx(server.pub, one, 1, 1)], [server]);
  eq('USDC 50/50 of one unit: it stays with the rider', await tokens(rider.pub), t0);
  ok('and it still closes', !(await account(one.vault)) && !(await account(one.escrow)));

  // USDC on top of a 50/50: half of the price to the driver, not half of what's there.
  const topped = newEscrow();
  const u0 = { r: await tokens(rider.pub), d: await tokens(driver.pub) };
  await send([payIx(rider.pub, topped, 1, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([tokenSend(tokenAccountOf(rider.pub, MINT), topped.vault, 5_000n, rider.pub)], [rider]);
  await send([settleIx(server.pub, topped, 1, 1)], [server]);
  eq('USDC on top of a 50/50: the driver gets half the price', await tokens(driver.pub) - u0.d, 550_000n);
  eq('USDC on top of a 50/50: the rest is the rider\'s', u0.r - await tokens(rider.pub), 550_000n);

  // A wallet paying itself: the same address as rider and driver.
  const self = await wallet(40_000_000n, 5_000_000n);
  for (const [outcome, name] of [[0, 'pay out'], [1, '50/50'], [2, 'refund']]) {
    for (const coin of [0, 1]) {
      const e = newEscrow();
      const fee = coin ? await tokens(FEE) : await balance(FEE);
      const start = coin ? await tokens(self.pub) : await balance(self);
      await send([payIx(self.pub, e, coin, self.pub, 1_000_000n, 100_000n)], [self]);
      await send([settleIx(server.pub, e, coin, outcome, { payer: self.pub, driver: self.pub })], [server]);
      const end = coin ? await tokens(self.pub) : await balance(self);
      const toFee = outcome === 0 ? 100_000n : 0n;
      eq(`rider = driver, ${coin ? 'USDC' : 'SOL'} ${name}: only the fee leaves`, start - end, toFee + (coin ? 0n : 5000n + ALLOWANCE));
      eq(`rider = driver, ${coin ? 'USDC' : 'SOL'} ${name}: the fee address gets its part`, (coin ? await tokens(FEE) : await balance(FEE)) - fee, toFee);
      ok(`rider = driver, ${coin ? 'USDC' : 'SOL'} ${name}: closed`, !(await account(e.escrow)));
    }
  }
  // The server's wallet as the driver, and the rider as the sender of a refund: no double counting.
  const sd = newEscrow();
  const s0 = await balance(server);
  await send([payIx(rider.pub, sd, 0, server.pub, 1_000_000n, 100_000n)], [rider]);
  await send([settleIx(server.pub, sd, 0, 0, { driver: server.pub })], [server]);
  eq('the server\'s own wallet as the driver: it gets exactly the part', await balance(server) - s0, 1_000_000n);
  ok('deposit math holds', rent > 0n);
}

// Money that can't go where it should stays in the escrow, and a refund must still get it out.
async function changedWallets() {
  part('Wallets that changed after paying');
  // Solana refuses a transfer leaving an empty wallet with less than the rent minimum.
  const minimum = await rentFor(0);
  const empty = keypair();
  const small = newEscrow();
  await send([payIx(rider.pub, small, 0, empty.pub, minimum - 1n, 100_000n)], [rider]);
  await fails('SOL: too little for an empty driver wallet is refused by Solana', [settleIx(server.pub, small, 0, 0, { driver: empty.pub })], [server]);
  await fails('SOL: its 50/50 too', [settleIx(server.pub, small, 0, 1, { driver: empty.pub })], [server]);
  ok('nothing moved: the escrow is still there', Boolean(await account(small.escrow)));
  eq('the driver wallet is still empty', await balance(empty), 0n);
  await send([settleIx(server.pub, small, 0, 2, { driver: empty.pub })], [server]);
  ok('a refund still gets the money out', !(await account(small.escrow)));
  const enough = newEscrow();
  await send([payIx(rider.pub, enough, 0, empty.pub, minimum, 100_000n)], [rider]);
  await send([settleIx(server.pub, enough, 0, 0, { driver: empty.pub })], [server]);
  eq('SOL: the rent minimum itself reaches an empty wallet', await balance(empty), minimum);

  // A driver "wallet" that's a program: the chain lets it be paid, so it can't block anything. The server only takes real wallets.
  const prog = newEscrow();
  await send([payIx(rider.pub, prog, 0, TOKEN, 1_000_000n, 100_000n)], [rider]);
  await send([settleIx(server.pub, prog, 0, 0, { driver: TOKEN })], [server]);
  ok('SOL: a program as the driver blocks nothing', !(await account(prog.escrow)));

  // The driver closes their USDC account after the rider paid.
  const closer = await wallet(10_000_000n, 1n);
  await send([tokenSend(tokenAccountOf(closer.pub, MINT), tokenAccountOf(rider.pub, MINT), 1n, closer.pub)], [closer]);
  const dclosed = newEscrow();
  await send([payIx(rider.pub, dclosed, 1, closer.pub, 1_000_000n, 100_000n)], [rider]);
  await send([closeAta(closer.pub)], [closer]);
  await fails('USDC: a driver who closed their account can\'t be paid', [settleIx(server.pub, dclosed, 1, 0, { driver: closer.pub })], [server], 1);
  await fails('USDC: nor split with', [settleIx(server.pub, dclosed, 1, 1, { driver: closer.pub })], [server], 1);
  const r0 = await tokens(rider.pub);
  await send([settleIx(server.pub, dclosed, 1, 2, { driver: closer.pub })], [server]);
  eq('USDC: the refund works, as the driver gets nothing', await tokens(rider.pub) - r0, 1_100_000n);

  // The rider empties and closes theirs after paying.
  const leaver = await wallet(30_000_000n, 2_200_000n);
  const lrefund = newEscrow(), lpayout = newEscrow();
  await send([payIx(leaver.pub, lrefund, 1, driver.pub, 1_000_000n, 100_000n)], [leaver]);
  await send([payIx(leaver.pub, lpayout, 1, driver.pub, 1_000_000n, 100_000n)], [leaver]);
  await send([closeAta(leaver.pub)], [leaver]);
  const d0 = await tokens(driver.pub);
  await send([settleIx(server.pub, lpayout, 1, 0, { payer: leaver.pub })], [server]);
  eq('USDC: a rider\'s closed account doesn\'t stop paying the driver', await tokens(driver.pub) - d0, 1_000_000n);
  await fails('USDC: but a refund has nowhere to go', [settleIx(server.pub, lrefund, 1, 2, { payer: leaver.pub })], [server], 1);
  ok('and stays in the vault', (await tokenBalance(lrefund.vault)) === 1_100_000n);
  // Anyone can make the account again, for free but the deposit.
  await send([createAta(leaver.pub, leaver.pub)], [leaver]);
  await send([settleIx(server.pub, lrefund, 1, 2, { payer: leaver.pub })], [server]);
  eq('USDC: once the account is back the refund arrives', await tokens(leaver.pub), 1_100_000n);

  // The free ride: close your account and send a token to the vault, so the payout fails until the refund after the timeout.
  const grief = await wallet(30_000_000n, 1_100_000n);
  const blocked = newEscrow();
  await send([payIx(grief.pub, blocked, 1, driver.pub, 1_000_000n, 100_000n)], [grief]);
  await send([closeAta(grief.pub)], [grief]);
  await send([tokenSend(tokenAccountOf(rider.pub, MINT), blocked.vault, 7n, rider.pub)], [rider]);
  let dBefore = await tokens(driver.pub), fBefore = await tokens(FEE);
  const sBefore = await balance(server);
  await send([settleIx(server.pub, blocked, 1, 0, { payer: grief.pub })], [server]);
  eq('the free ride fails: the driver is paid anyway', await tokens(driver.pub) - dBefore, 1_000_000n);
  eq('so is the fee', await tokens(FEE) - fBefore, 100_000n);
  eq('the server got its network fee back', await balance(server), sBefore);
  eq('what\'s on top waits in the vault', await tokenBalance(blocked.vault), 7n);
  ok('the escrow stays open for it', Boolean(await account(blocked.escrow)));
  eq('and owes the driver and the fee address nothing more', (await account(blocked.escrow)).data.subarray(116, 132).equals(Buffer.alloc(16)), true);
  dBefore = await tokens(driver.pub); fBefore = await tokens(FEE);
  await fails('with nobody to pay and no account, nothing happens', [settleIx(server.pub, blocked, 1, 0, { payer: grief.pub })], [server], 1);
  await send([createAta(grief.pub, grief.pub)], [grief]);
  const gBefore = await balance(grief);
  await send([settleIx(server.pub, blocked, 1, 0, { payer: grief.pub })], [server]);
  eq('with the account back, the same outcome pays nobody twice: driver', await tokens(driver.pub), dBefore);
  eq('nor the fee address', await tokens(FEE), fBefore);
  eq('the rider gets what\'s left', await tokens(grief.pub), 7n);
  ok('and the deposits, less the network fee paid twice', await balance(grief) > gBefore, `${await balance(grief) - gBefore}`);
  ok('and it all closes', !(await account(blocked.escrow)) && !(await account(blocked.vault)));

  // The same with a 50/50, where the rider's part is real money, and by giving the account away instead of closing it.
  const giver = await wallet(30_000_000n, 1_100_000n);
  const halved = newEscrow();
  await send([payIx(giver.pub, halved, 1, driver.pub, 1_000_000n, 100_000n)], [giver]);
  await send([setOwner(giver.pub, stranger.pub)], [giver]);
  dBefore = await tokens(driver.pub);
  await send([settleIx(server.pub, halved, 1, 1, { payer: giver.pub })], [server]);
  eq('a rider who gave their account away: the driver still gets their half', await tokens(driver.pub) - dBefore, 550_000n);
  eq('the rider\'s half waits', await tokenBalance(halved.vault), 550_000n);
  await fails('the stranger now holding that account gets none of it', [settleIx(server.pub, halved, 1, 2, { payer: giver.pub })], [server], 1);
  await send([setOwner(stranger.pub, giver.pub, tokenAccountOf(giver.pub, MINT))], [stranger]);
  await send([settleIx(server.pub, halved, 1, 2, { payer: giver.pub })], [server]);
  eq('with the account back the rider has their half', await tokens(giver.pub), 550_000n);
  eq('and the driver no more than theirs', await tokens(driver.pub) - dBefore, 550_000n);

  // SOL sent to an escrow's address before it's paid: the payment is refused, no money lost, and the id is spoiled.
  const pre = newEscrow();
  await send([transfer(stranger.pub, pre.escrow, 1_000_000n)], [stranger]);
  const start = await balance(rider);
  await fails('SOL sent to the address before paying blocks that one id', [payIx(rider.pub, pre, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  ok('the rider loses at most the network fee', start - await balance(rider) <= 5000n, `${start - await balance(rider)}`);

  // Paying the same id again after it closed: a new escrow, which the server ignores (the rider's own doing) and expires.
  const again = newEscrow();
  await send([payIx(rider.pub, again, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([settleIx(server.pub, again, 0, 2)], [server]);
  await send([payIx(rider.pub, again, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  ok('an id can be paid again once closed', Boolean(await account(again.escrow)));
  await send([settleIx(server.pub, again, 0, 2)], [server]);
}

async function racing() {
  part('Two at once');
  for (const coin of [0, 1]) {
    const e = newEscrow();
    await send([payIx(rider.pub, e, coin, driver.pub, 1_000_000n, 100_000n)], [rider]);
    const before = coin ? { r: await tokens(rider.pub), d: await tokens(driver.pub), f: await tokens(FEE) } : { r: await balance(rider), d: await balance(driver), f: await balance(FEE) };
    const hash = await blockhash();
    const all = [0, 1, 2].map((o) => transaction([settleIx(server.pub, e, coin, o)], [server], hash).toString('base64'));
    const sigs = await Promise.allSettled(all.map((t) => rpc('sendTransaction', [t, { encoding: 'base64', skipPreflight: true }])));
    const sent = sigs.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    for (let i = 0; i < 40; i++) {
      const st = (await rpc('getSignatureStatuses', [sent])).value;
      if (st.every((s) => s && ['confirmed', 'finalized'].includes(s.confirmationStatus))) break;
      await sleep(800);
    }
    const st = (await rpc('getSignatureStatuses', [sent])).value;
    eq(`${coin ? 'USDC' : 'SOL'}: three outcomes at once, exactly one lands`, st.filter((s) => s && !s.err).length, 1);
    const after = coin ? { r: await tokens(rider.pub), d: await tokens(driver.pub), f: await tokens(FEE) } : { r: await balance(rider), d: await balance(driver), f: await balance(FEE) };
    const got = [after.d - before.d, after.f - before.f];
    ok(`${coin ? 'USDC' : 'SOL'}: and the money moved once`, [[1_000_000n, 100_000n], [550_000n, 0n], [0n, 0n]].some(([d, f]) => got[0] === d && got[1] === f), got.join(' / '));
  }
}

async function keysChanging() {
  part('Keys and the fee address changing mid-ride');
  const e = newEscrow();
  await send([payIx(rider.pub, e, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  const newServer = await wallet(10_000_000n);
  const newFee = await wallet(1_000_000n);
  try {
    await send([updateIx(admin.pub, newServer.pub, newFee.pub, admin.pub)], [admin]);
    await refused('the old server key can\'t settle any more', [settleIx(server.pub, e, 0, 0)], [server], 2);
    await refused('nor pay the old fee address', [settleIx(newServer.pub, e, 0, 0)], [newServer], 1);
    const f0 = await balance(newFee), d0 = await balance(driver);
    await send([settleIx(newServer.pub, e, 0, 0, { fee: newFee.pub })], [newServer]);
    eq('the new key settles a ride paid before the change: driver paid', await balance(driver) - d0, 1_000_000n);
    eq('the fee goes to the new address', await balance(newFee) - f0, 100_000n);
    // An empty fee address and a fee under the rent minimum: SOL payouts are refused until it holds a little.
    const emptyFee = keypair();
    await send([updateIx(admin.pub, server.pub, emptyFee.pub, admin.pub)], [admin]);
    const small = newEscrow();
    await send([payIx(rider.pub, small, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
    await fails('an emptied fee address blocks SOL payouts', [settleIx(server.pub, small, 0, 0, { fee: emptyFee.pub })], [server]);
    const r0 = await balance(rider);
    await send([settleIx(server.pub, small, 0, 2, { fee: emptyFee.pub })], [server]);
    ok('but not a refund', await balance(rider) > r0);
    // The admin handed over, then back.
    const newAdmin = await wallet(5_000_000n);
    await send([updateIx(admin.pub, server.pub, FEE, newAdmin.pub)], [admin]);
    await refused('the old admin has no say any more', [updateIx(admin.pub, server.pub, FEE, admin.pub)], [admin], 2);
    await send([updateIx(newAdmin.pub, server.pub, FEE, admin.pub)], [newAdmin]);
    eq('the new admin can hand it back', (await account(config.address)).data.subarray(2, 34).equals(admin.pub), true);
  } finally {
    // Whatever went wrong, the settings go back. If the admin was handed over and the test stopped there, this says so loudly.
    const c = (await account(config.address)).data;
    if (c.subarray(2, 34).equals(admin.pub)) await send([updateIx(admin.pub, server.pub, FEE, admin.pub)], [admin]);
    else console.log('!!! the admin of the settings is not the deployer any more');
  }
  const c = (await account(config.address)).data;
  ok('the settings are back as they were', c.subarray(34, 66).equals(server.pub) && c.subarray(66, 98).equals(FEE) && c.subarray(2, 34).equals(admin.pub));
}

async function sizes() {
  part('What it costs on the chain');
  const pays = newEscrow(), payu = newEscrow(), s = newEscrow(), u = newEscrow();
  const a = await cost([payIx(rider.pub, pays, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  const b = await cost([payIx(rider.pub, payu, 1, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([payIx(rider.pub, s, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([payIx(rider.pub, u, 1, driver.pub, 1_000_000n, 100_000n)], [rider]);
  const c = await cost([settleIx(server.pub, s, 0, 0)], [server]);
  const d = await cost([settleIx(server.pub, u, 1, 0)], [server]);
  for (const [name, x] of [['pay SOL', a], ['pay USDC', b], ['settle SOL', c], ['settle USDC', d]]) {
    ok(`${name}: under the default 200,000 units and Solana's 1232 bytes`, !x.err && x.units < 200_000 && x.bytes <= 1232, `${x.units} units, ${x.bytes} bytes`);
  }
  await send([settleIx(server.pub, s, 0, 2)], [server]);
  await send([settleIx(server.pub, u, 1, 2)], [server]);
}

async function afterTheTimeout() {
  part('The timeout');
  const sol1 = newEscrow(), sol2 = newEscrow(), sol3 = newEscrow(), usd1 = newEscrow(), usd2 = newEscrow(), mine = newEscrow(), race = newEscrow();
  const leaver = await wallet(30_000_000n, 1_100_000n), reclaim = await wallet(30_000_000n);
  const left = newEscrow(), part1 = newEscrow();
  const partial = await wallet(30_000_000n, 1_100_000n);
  await send([payIx(partial.pub, part1, 1, driver.pub, 1_000_000n, 100_000n)], [partial]);
  await send([closeAta(partial.pub)], [partial]);
  await send([settleIx(server.pub, part1, 1, 1, { payer: partial.pub })], [server]);
  await send([payIx(rider.pub, sol1, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([payIx(rider.pub, sol2, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([payIx(rider.pub, sol3, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([payIx(rider.pub, usd1, 1, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([payIx(rider.pub, usd2, 1, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([payIx(reclaim.pub, mine, 0, driver.pub, 1_000_000n, 100_000n)], [reclaim]);
  await send([payIx(rider.pub, race, 0, driver.pub, 1_000_000n, 100_000n)], [rider]);
  await send([payIx(leaver.pub, left, 1, driver.pub, 1_000_000n, 100_000n)], [leaver]);
  await send([closeAta(leaver.pub)], [leaver]);
  await send([tokenSend(tokenAccountOf(rider.pub, MINT), usd2.vault, 4_321n, rider.pub)], [rider]);
  await refused('a second before the timeout it still refuses', [expireIx(stranger.pub, sol1, 0)], [stranger], 4);
  console.log(`waiting ${TIMEOUT_MS / 60_000 + 0.5} minutes for the devnet timeout…`);
  const paidBy = await chainClock(), wallStart = Date.now();
  await sleep(TIMEOUT_MS + 30_000);
  // The contract goes by the chain's clock, so that's the one to wait for.
  while (await chainClock() < paidBy + TIMEOUT_MS / 1000 + 5) await sleep(3000);
  console.log(`the chain's clock moved ${(await chainClock()) - paidBy} s in ${Math.round((Date.now() - wallStart) / 1000)} s of real time`);

  await refused('expire into someone else\'s token account', [expireIx(stranger.pub, usd1, 1, { payerToken: tokenAccountOf(stranger.pub, MINT) })], [stranger], 1);
  await refused('expire with the wrong token program', [ix(PROGRAM, expireIx(stranger.pub, usd1, 1).metas.map((m, i) => [i === 5 ? TOKEN22 : m.key, m.signer, m.writable]), [4])], [stranger], 1);

  // The server can still settle after the timeout: a late payout isn't lost if nobody refunded yet.
  const d0 = await balance(driver);
  await send([settleIx(server.pub, sol2, 0, 0)], [server]);
  eq('settling after the timeout still works', await balance(driver) - d0, 1_000_000n);
  await fails('expire after it was settled', [expireIx(stranger.pub, sol2, 0)], [stranger], 1);

  // Anyone refunds: the sender gets exactly the fee back.
  const s0 = await balance(stranger);
  await send([expireIx(stranger.pub, sol1, 0)], [stranger]);
  eq('a stranger expiring gets its fee back, nothing more', await balance(stranger), s0);
  await fails('expire a second time', [expireIx(stranger.pub, sol1, 0)], [stranger], 1);
  await fails('settle after it expired', [settleIx(server.pub, sol1, 0, 0)], [server], 1);

  // USDC with extra on top: everything back to the rider.
  const t0 = await tokens(rider.pub);
  await send([expireIx(stranger.pub, usd2, 1)], [stranger]);
  eq('USDC on top comes back with the expire', await tokens(rider.pub) - t0, 1_100_000n + 4_321n);
  ok('and the vault closes', !(await account(usd2.vault)));

  // The rider themselves, with no server at all.
  const m0 = await balance(reclaim);
  await send([expireIx(reclaim.pub, mine, 0, { payer: reclaim.pub })], [reclaim]);
  ok('a rider can get their own money back with no server at all', await balance(reclaim) - m0 > 1_100_000n, `${await balance(reclaim) - m0}`);

  // A rider whose USDC account is gone gets it back too, once there is one.
  await fails('expire to a rider who closed their USDC account has nowhere to go', [expireIx(stranger.pub, left, 1, { payer: leaver.pub })], [stranger], 1);
  await send([createAta(stranger.pub, leaver.pub), expireIx(stranger.pub, left, 1, { payer: leaver.pub })], [stranger]);
  eq('anyone can make that account, and then it arrives', await tokens(leaver.pub), 1_100_000n);

  // A rider's part left waiting after a 50/50: after the timeout anyone can send it to them, and only to them.
  const dPart = await tokens(driver.pub);
  await fails('expire of what\'s left, with no account yet, has nowhere to go', [expireIx(stranger.pub, part1, 1, { payer: partial.pub })], [stranger], 1);
  await send([createAta(stranger.pub, partial.pub), expireIx(stranger.pub, part1, 1, { payer: partial.pub })], [stranger]);
  eq('what was left reaches the rider', await tokens(partial.pub), 550_000n);
  eq('the driver gets nothing more', await tokens(driver.pub), dPart);
  ok('and it closes', !(await account(part1.escrow)) && !(await account(part1.vault)));

  // Settle and expire at the same time.
  const r0 = await balance(rider), dr = await balance(driver);
  const hash = await blockhash();
  const txs = [transaction([settleIx(server.pub, race, 0, 0)], [server], hash), transaction([expireIx(stranger.pub, race, 0)], [stranger], hash)];
  const sent = (await Promise.allSettled(txs.map((t) => rpc('sendTransaction', [t.toString('base64'), { encoding: 'base64', skipPreflight: true }])))).filter((s) => s.status === 'fulfilled').map((s) => s.value);
  for (let i = 0; i < 40; i++) {
    const st = (await rpc('getSignatureStatuses', [sent])).value;
    if (st.every((s) => s && ['confirmed', 'finalized'].includes(s.confirmationStatus))) break;
    await sleep(800);
  }
  const st = (await rpc('getSignatureStatuses', [sent])).value;
  eq('settle and expire at once: one lands', st.filter((s) => s && !s.err).length, 1);
  const paidDriver = await balance(driver) - dr, back = await balance(rider) - r0;
  ok('and the money moved once', (paidDriver === 1_000_000n && back > 0n) || (paidDriver === 0n && back > 1_100_000n), `driver ${paidDriver}, rider ${back}`);

  await send([settleIx(server.pub, sol3, 0, 2)], [server]);
  await send([settleIx(server.pub, usd1, 1, 2)], [server]);
}

async function main() {
  const need = 500_000_000n;
  console.log(`program ${b58(PROGRAM)}; deployer has ${Number(await balance(admin)) / 1e9} SOL`);
  if (await balance(admin) < need) throw new Error('the deployer needs more devnet SOL');
  for (const [w, want] of [[rider, 300_000_000n], [server, 30_000_000n], [stranger, 30_000_000n], [driver, 5_000_000n], [FEE, 5_000_000n]]) {
    const have = await balance(w);
    if (have < want) await send([transfer(admin.pub, key(w), want - have)], [admin]);
  }
  if (await tokens(rider.pub) < 30_000_000n) await send([mintTo(rider.pub, 50_000_000n)], [admin]);
  await brokenInstructions();
  await forgedThings();
  await exactMoney();
  await changedWallets();
  await racing();
  await keysChanging();
  await sizes();
  await afterTheTimeout();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\nSTOPPED: ${passes} passed, ${failures} failed before this`); process.exit(1); });
