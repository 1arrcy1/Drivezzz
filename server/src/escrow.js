// Rides paid into the escrow on Solana (contract/). The server builds the rider's payment for their wallet to sign,
// sees it arrive on the chain, and later picks the outcome: pay out (the price minus Drivezzz's €0.10 to the driver),
// 50/50, or refund. The coins never pass through a wallet of ours: the contract only lets them go to the address that
// paid, the driver and the fee address, and refunds the rider by itself after 30 days if nothing was decided.
import crypto from 'node:crypto';
import { config, rules } from './config.js';
import { all, get, getMeta, now, run, setMeta } from './db.js';
import { ApiError, limit } from './http.js';
import { notify } from './push.js';
import * as coins from './coins.js';
import * as sol from './solana.js';
import { latestPrice, unitsFor } from './wallet.js';

export const COINS = ['usdc-sol', 'sol'];
const OUTCOMES = { payout: 0, split: 1, refund: 2 };
const ESCROW_LEN = 140;
// What a payment needs in SOL besides a SOL ride's price: the escrow's deposit, its allowance and the transaction's fees (docs/escrow.md, section 20).
const DEPOSIT_SOL = 1_385_000n, DEPOSIT_USDC = 2_875_000n;
const RENT_MINIMUM = 890_880n;
// Compute units a transaction may use (a limit, so the priority fee stays small): well above what it needs. The server's key pays the
// priority fee on outcomes, and the contract only gives back the base fee, so its SOL slowly goes down (see LOW_FLOAT).
const UNITS = { pay: 60_000, settle: 30_000, admin: 100_000 };
const LOW_FLOAT = 2_000_000n; // 0.002 SOL
// A rider waits on these: they go before paying out when the connection is busy (solana.js).
const URGENT = { urgent: true };

// Tests only (DEV=1 and ESCROW_FAKE=1): no chain. A requested payment counts as paid at the next look, and an outcome
// is settled as soon as it's sent. The contract itself is tested on devnet (contract/test/devnet.mjs).
const fake = config.pretendChain;
if (process.env.PRETEND_CHAIN === '1' && config.escrow.programId) throw new Error('PRETEND_CHAIN is on next to a real contract (ESCROW_PROGRAM_ID): take it out of /etc/default/drivezzz.');
export const pretendChain = () => fake;

let keyCache;
function serverKey() {
  if (keyCache === undefined) {
    try { keyCache = sol.loadKeypair(config.escrow.keyFile); } catch { keyCache = null; }
  }
  return keyCache;
}
export const ready = () => fake || Boolean(config.escrow.programId && serverKey());
export const serverAddress = () => serverKey()?.address ?? null;
const program = () => sol.unb58(config.escrow.programId);
export const usdcMint = coins.usdcMint;
const usdc = (coin) => coin === 'usdc-sol';
const configAddress = () => sol.pda([Buffer.from('config')], program()).address;
const escrowPda = (id) => sol.pda([Buffer.from('escrow'), id], program());
const vaultPda = (id) => sol.pda([Buffer.from('vault'), id], program());

// Where Drivezzz's €0.10 goes: the address set in the admin panel, else the one in the server's settings.
export const feeAddress = () => getMeta('escrow:feeAddress') || config.escrow.feeAddress;

function adminKey() {
  try { return sol.loadKeypair(config.escrow.adminKeyFile); } catch { return null; }
}

// How the fee address stands on this network, for the admin panel.
export async function feeStatus() {
  const address = feeAddress();
  if (fake || !ready()) return { sol: null, usdcAccount: null };
  const [a, t] = await sol.accounts([address, sol.tokenAccountOf(address, usdcMint())]);
  return { sol: Number(a?.lamports ?? 0n) / 1e9, usdcAccount: Boolean(t) };
}

// Connects another Solana address for the €0.10. Only ever a public address: no wallet's keys come near this. Once the contract
// is set up the change goes on the chain, with its USDC account, paid by the admin key, and counts for every payout from then on.
export async function setFeeAddress(address) {
  if (!sol.isWalletAddress(address)) throw new ApiError(400, 'bad_address', 'That isn’t a Solana wallet address.');
  const c = !fake && ready() ? await sol.account(configAddress()) : null;
  if (c) {
    const admin = adminKey();
    if (!admin || !c.data.subarray(2, 34).equals(admin.pub)) throw new ApiError(409, 'not_admin', 'This server isn’t the contract’s admin, so it can’t change the address on the chain.');
    const instructions = [sol.ix(program(), [[admin, 1, 0], [configAddress(), 0, 1]], Buffer.concat([Buffer.from([1]), c.data.subarray(34, 66), sol.unb58(address), c.data.subarray(2, 34)]))];
    const token = sol.tokenAccountOf(address, usdcMint());
    if (!(await sol.account(token))) instructions.unshift(sol.ix(sol.ATA, [[admin, 1, 1], [token, 0, 1], [address], [usdcMint()], [sol.SYSTEM], [sol.TOKEN]], Buffer.from([1])));
    const { blockhash } = await sol.latestBlockhash();
    const t = sol.transaction(admin.pub, [...sol.priority(UNITS.admin), ...instructions], [admin], blockhash);
    await sol.sendRaw(t.bytes);
    // The chain has the last word: only then does this server use it.
    let there = false;
    for (let i = 0; i < 30 && !there; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      there = sol.b58((await sol.account(configAddress())).data.subarray(66, 98)) === address;
    }
    if (!there) throw new ApiError(502, 'not_confirmed', 'The chain hasn’t confirmed the change. Nothing changed here: look again in a minute.');
  }
  setMeta('escrow:feeAddress', address);
}

// What the contract's settings say, checked against ours when the server starts.
export async function checkSettings() {
  if (fake) return null;
  if (!ready()) return 'The escrow isn’t set up: ESCROW_PROGRAM_ID and the escrow key are needed.';
  const c = await sol.account(configAddress());
  if (!c) return 'The escrow contract has no settings yet: set it up from the admin page.';
  if (!c.data.subarray(34, 66).equals(serverKey().pub)) return 'The escrow contract expects another server key.';
  if (sol.b58(c.data.subarray(66, 98)) !== feeAddress()) return 'The escrow contract pays fees to another address than ESCROW_FEE_ADDRESS.';
  if (sol.b58(c.data.subarray(98, 130)) !== usdcMint()) return 'The escrow contract uses another USDC than this network’s.';
  // Every USDC ride paid out in full sends the fee here: without this account those payouts are refused by the chain.
  if (!(await sol.account(sol.tokenAccountOf(feeAddress(), usdcMint())))) return 'The fee address has no USDC account yet, so USDC rides can’t be paid out: receive or swap a little USDC there once.';
  // Solana refuses leaving an empty address with less than its rent minimum, and the fee is less than that.
  if (!(await sol.account(feeAddress()))) return 'The fee address holds no SOL, so SOL rides can’t be paid out: keep a little SOL there, never empty it.';
  // At zero nothing settles any more: no payouts, no refunds.
  if (((await sol.account(serverKey().pub))?.lamports ?? 0n) < LOW_FLOAT) return `The server key ${serverAddress()} is low on SOL: send it 0.01 SOL, or outcomes stop going out.`;
  return null;
}

// ---------- paying ----------

// The payment for a ride, for the wallet at `payer` to sign and send. Its amounts are fixed now, at today's price.
// The same wallet asking again gets the same escrow, with a fresh blockhash.
export async function paymentFor(r, payer, driverAddress) {
  if (!ready()) throw new ApiError(503, 'escrow_off', 'Paying isn’t possible right now. Try again in a moment.');
  if (!sol.isWalletAddress(payer)) throw new ApiError(400, 'bad_account', 'That isn’t a Solana wallet address.');
  if (get('SELECT 1 AS x FROM banned_wallets WHERE address = ?', payer)) throw new ApiError(403, 'banned', 'This wallet can’t be used on Drivezzz.');
  let e = get(`SELECT * FROM escrows WHERE ride_id = ? AND payer = ? AND status = 'requested' AND driver_address = ?`, r.id, payer, driverAddress);
  if (!e) {
    const eur = await latestPrice(r.coin);
    const units = unitsFor(r.coin, r.price_cents, eur);
    const fee = unitsFor(r.coin, rules.feeCents, eur);
    if (fee >= units) throw new ApiError(400, 'too_cheap', 'This ride is too cheap to pay.');
    const id = crypto.randomBytes(16);
    run(`INSERT INTO escrows (id, ride_id, coin, address, payer, driver_address, units, fee_units, eur_per_coin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?)`,
      id.toString('hex'), r.id, r.coin, fake ? `fake-${id.toString('hex')}` : sol.b58(escrowPda(id).address), payer, driverAddress, Number(units), Number(fee), eur, now());
    e = get('SELECT * FROM escrows WHERE id = ?', id.toString('hex'));
  }
  if (fake) return { transaction: 'fake', escrow: e };
  const id = Buffer.from(e.id, 'hex');
  const esc = escrowPda(id), vault = vaultPda(id);
  const kind = usdc(e.coin) ? 1 : 0;
  const metas = [[payer, 1, 1], [configAddress()], [esc.address, 0, 1], [sol.SYSTEM]];
  // Everything to look at, in one question to the network: the free public connection counts requests.
  const mint = usdcMint();
  const from = kind ? sol.tokenAccountOf(payer, mint) : null;
  const [payerAccount, driverAccount, have, driverToken] = await sol.accounts([payer, e.driver_address, ...(kind ? [from, sol.tokenAccountOf(e.driver_address, mint)] : [])], URGENT);
  // Solana refuses leaving an empty wallet with less than its rent minimum: half the price has to get there too.
  if (!kind && BigInt(e.units) / 2n < RENT_MINIMUM && !driverAccount) {
    throw new ApiError(409, 'driver_empty', 'Your driver’s wallet is empty and can’t receive this little SOL yet. We told them. You can wait, or cancel for free.');
  }
  // Said here, in words, rather than as a failed simulation in the wallet. The SOL also covers the escrow's deposit.
  const needSol = (kind ? DEPOSIT_USDC : DEPOSIT_SOL + BigInt(e.units));
  if ((payerAccount?.lamports ?? 0n) < needSol) {
    throw new ApiError(409, 'short', `This wallet needs about ${coins.fromUnits('sol', needSol)} SOL${kind ? ' for the deposit, which comes back' : ', with the deposit that comes back'}.`);
  }
  if (kind) {
    // Paid out to a wallet without a USDC account, the chain would refuse it until the refund after 30 days.
    if (!driverToken) throw new ApiError(409, 'driver_usdc', 'Your driver’s wallet can’t receive USDC yet. We told them. You can wait, or cancel for free.');
    if (!have || have.data.readBigUInt64LE(64) < BigInt(e.units)) throw new ApiError(409, 'short', `This wallet doesn’t have ${coins.fromUnits(e.coin, BigInt(e.units))} USDC on Solana.`);
    metas.push([mint], [from, 0, 1], [vault.address, 0, 1], [sol.TOKEN]);
  }
  const data = Buffer.concat([Buffer.from([2]), id, Buffer.from([esc.bump, vault.bump, kind]), sol.unb58(e.driver_address),
    sol.u64(BigInt(e.units) - BigInt(e.fee_units)), sol.u64(e.fee_units)]);
  const { blockhash } = await sol.latestBlockhash(URGENT);
  const t = sol.transaction(payer, [...sol.priority(UNITS.pay), sol.ix(program(), metas, data)], [], blockhash);
  return { transaction: t.bytes.toString('base64'), escrow: e };
}

// A payment signed in the rider's wallet (one that only signs), sent on from here. It has to be into one of this ride's
// requested escrows: this is no free relay for anything else. The chain decides from there; the watcher sees it land.
export async function sendPayment(r, base64) {
  if (fake) return;
  const bytes = Buffer.from(String(base64 ?? ''), 'base64');
  const bad = new ApiError(400, 'bad_transaction', 'Your wallet sent back something else than this payment. Try again.');
  if (bytes.length < 66 || bytes.length > 1232 || bytes[0] !== 1 || !bytes.subarray(1, 65).some((b) => b)) throw bad;
  const message = bytes.subarray(65);
  const ours = all(`SELECT address FROM escrows WHERE ride_id = ? AND status = 'requested'`, r.id).some((e) => message.includes(sol.unb58(e.address)));
  if (!ours || !message.includes(program())) throw bad;
  try {
    // A busy network is waited out a little: the same signed transaction can't land twice.
    for (let attempt = 0; ; attempt++) {
      try { await sol.sendRaw(bytes, URGENT); break; } catch (err) {
        if (!err.busy || attempt >= 3) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  } catch (err) {
    if (!err.rpc) throw new ApiError(503, 'chain_down', 'The network doesn’t answer right now. Try again in a moment.');
    const said = String(err.message);
    console.error('[drivezzz] payment refused:', said.slice(0, 300), JSON.stringify(err.rpc.data?.logs ?? []).slice(0, 600));
    if (/already been processed/i.test(said)) return;
    if (/blockhash not found/i.test(said)) throw new ApiError(409, 'too_slow', 'That took a little too long for the network. Pay again.');
    throw new ApiError(409, 'refused', 'The network refused this payment. Check that this wallet has enough for the ride and a little SOL, then pay again.');
  }
}

// Reads escrows from the chain: what's paid, and whether it's exactly what we asked for.
function parse(a) {
  if (!a || a.owner !== config.escrow.programId || a.data.length !== ESCROW_LEN || a.data[0] !== 2) return null;
  const d = a.data;
  return {
    usdc: d[3] === 1, payer: sol.b58(d.subarray(20, 52)), driver: sol.b58(d.subarray(52, 84)),
    driverUnits: d.readBigUInt64LE(116), feeUnits: d.readBigUInt64LE(124), createdAt: Number(d.readBigInt64LE(132)) * 1000,
  };
}
const matches = (e, p) => p && p.usdc === usdc(e.coin) && p.payer === e.payer && p.driver === e.driver_address
  && p.feeUnits === BigInt(e.fee_units) && p.driverUnits + p.feeUnits === BigInt(e.units);

// Payments waiting to show up, for two days (a late one still has to be refunded). `onPaid` decides what the ride does
// with it and returns the outcome to give it right away, if any (a payment for a ride that's gone is refunded).
export async function watchPayments(onPaid) {
  if (!ready()) return;
  const waiting = all(`SELECT * FROM escrows WHERE status = 'requested' AND created_at > ?`, now() - 2 * 86_400_000);
  if (!waiting.length) return;
  const found = fake ? waiting.map(() => true) : await sol.accounts(waiting.map((e) => sol.unb58(e.address)), URGENT);
  for (const [i, e] of waiting.entries()) {
    if (!found[i]) continue;
    const p = fake ? { usdc: usdc(e.coin), payer: e.payer, driver: e.driver_address, feeUnits: BigInt(e.fee_units), driverUnits: BigInt(e.units) - BigInt(e.fee_units) } : parse(found[i]);
    if (!p) continue;
    const t = now();
    if (!run(`UPDATE escrows SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'requested'`, t, e.id).changes) continue;
    // Not what we asked for (someone built their own): straight back to whoever paid it. The outcome has to name what the chain has.
    if (!matches(e, p)) {
      run('UPDATE escrows SET payer = ?, driver_address = ?, coin = ? WHERE id = ?', p.payer, p.driver, p.usdc ? 'usdc-sol' : 'sol', e.id);
      decide(e.id, 'refund', t);
      continue;
    }
    try { await onPaid(get('SELECT * FROM escrows WHERE id = ?', e.id)); } catch (err) { console.error('[drivezzz] paid escrow', e.id, err); }
  }
}

// ---------- outcomes ----------

// Sets what happens to a ride's paid escrow and from when. The settle job sends it, unless an appeal is open.
export function decide(escrowId, outcome, after = now()) {
  run(`UPDATE escrows SET outcome = ?, settle_after = ?, error = NULL WHERE id = ? AND status = 'paid'`, outcome, after, escrowId);
}
export const setHold = (escrowId, on) => run(`UPDATE escrows SET manual_hold = ? WHERE id = ? AND status = 'paid'`, on ? 1 : 0, escrowId).changes > 0;
export const paidEscrow = (rideId) => get(`SELECT * FROM escrows WHERE ride_id = ? AND status IN ('paid', 'settling', 'settled') ORDER BY paid_at LIMIT 1`, rideId);

function settleIx(e, outcome) {
  const id = Buffer.from(e.id, 'hex');
  const fee = feeAddress();
  const metas = [[serverKey(), 1, 1], [configAddress()], [e.address, 0, 1], [e.payer, 0, 1], [e.driver_address, 0, 1], [fee, 0, 1]];
  if (usdc(e.coin)) {
    const mint = usdcMint();
    metas.push([vaultPda(id).address, 0, 1], [sol.tokenAccountOf(e.payer, mint), 0, 1], [sol.tokenAccountOf(e.driver_address, mint), 0, 1], [sol.tokenAccountOf(fee, mint), 0, 1], [sol.TOKEN]);
  }
  return sol.ix(program(), metas, [3, OUTCOMES[outcome]]);
}
function expireIx(e) {
  const id = Buffer.from(e.id, 'hex');
  const metas = [[serverKey(), 1, 1], [e.address, 0, 1], [e.payer, 0, 1]];
  if (usdc(e.coin)) metas.push([vaultPda(id).address, 0, 1], [sol.tokenAccountOf(e.payer, usdcMint()), 0, 1], [sol.TOKEN]);
  return sol.ix(program(), metas, [4]);
}

// Is this someone's usable USDC account? The contract takes nothing else.
const hasTokenAccount = async (owner) => usableTokenAccount(await sol.account(sol.tokenAccountOf(owner, usdcMint())), owner);

// Someone closed the USDC account an outcome has to go to: the chain would refuse it. They're told, once a day; the admin
// sees why and can pick another outcome. A rider's own account only holds up their own part (the contract pays the driver).
const NO_ACCOUNT = {
  driver: ['Your wallet has no USDC account', 'A ride’s payment can’t reach your wallet until it has one: swap a little SOL to USDC there.'],
  rider: ['Your wallet has no USDC account', 'Your refund can’t reach your wallet until it has one: swap a little SOL to USDC there.'],
};
function tellNoAccount(e, who) {
  if (!limit(`no-usdc:${e.id}:${who}`, 1, 86_400_000)) return;
  const r = get('SELECT rider_id, driver_id FROM rides WHERE id = ?', e.ride_id);
  const person = who === 'driver' ? r?.driver_id : r?.rider_id;
  if (person) notify(person, NO_ACCOUNT[who][0], NO_ACCOUNT[who][1], { rideId: e.ride_id });
}
// The same test on an account already read (`round`, below).
const usableTokenAccount = (a, owner) => Boolean(a && a.data.length === 165 && a.data.subarray(32, 64).equals(sol.unb58(owner)) && a.data[108] === 1);
function blockedBy(e, round) {
  if (!usdc(e.coin)) return null;
  const ok = (owner) => usableTokenAccount(round.account(sol.tokenAccountOf(owner, usdcMint())), owner);
  if (e.outcome === 'refund' || e.outcome === 'expired') return ok(e.payer) ? null : 'rider';
  if (!ok(e.driver_address)) return 'driver';
  if (e.outcome === 'payout' && !ok(feeAddress())) return 'the fee address';
  return null;
}

// What a round of outcomes needs from the network, asked once for all of them: the escrows, the USDC accounts they pay into,
// and one blockhash. Asked one by one, twenty payouts falling due together came to about a hundred requests, the free public
// connection's limit for ten seconds.
async function readRound(due) {
  const keys = new Set();
  for (const e of due) {
    keys.add(e.address);
    if (usdc(e.coin)) for (const owner of [e.payer, e.driver_address, feeAddress()]) keys.add(sol.b58(sol.tokenAccountOf(owner, usdcMint())));
  }
  const list = [...keys];
  const [found, hash] = await Promise.all([sol.accounts(list), sol.latestBlockhash()]);
  const byKey = new Map(list.map((k, i) => [k, found[i]]));
  return { account: (k) => byKey.get(typeof k === 'string' ? k : sol.b58(k)) ?? null, ...hash };
}

async function sendOutcome(e, round) {
  if (fake) {
    run(`UPDATE escrows SET status = 'settled', settle_sig = 'fake', settled_at = ? WHERE id = ? AND status = 'paid'`, now(), e.id);
    return get('SELECT * FROM escrows WHERE id = ?', e.id);
  }
  const key = serverKey();
  // Gone from the chain already (refunded after the timeout by someone else, or our earlier send landed): done.
  if (!round.account(e.address)) {
    run(`UPDATE escrows SET status = 'settled', settled_at = ?, error = 'Closed on the chain already' WHERE id = ? AND status = 'paid'`, now(), e.id);
    return get('SELECT * FROM escrows WHERE id = ?', e.id);
  }
  const blocked = blockedBy(e, round);
  if (blocked) {
    run(`UPDATE escrows SET settle_after = ?, error = ? WHERE id = ?`, now() + 10 * 60_000, `${blocked === 'the fee address' ? 'The fee address' : `The ${blocked}’s wallet`} has no USDC account.`, e.id);
    if (blocked !== 'the fee address') tellNoAccount(e, blocked);
    return null;
  }
  const { blockhash, lastValidBlockHeight } = round;
  const t = sol.transaction(key.pub, [...sol.priority(UNITS.settle), e.outcome === 'expired' ? expireIx(e) : settleIx(e, e.outcome)], [key], blockhash);
  // Marked first, with the signature it will have: a crash mid-send is looked up next round, never sent twice blind.
  if (!run(`UPDATE escrows SET status = 'settling', settle_sig = ?, last_valid = ? WHERE id = ? AND status = 'paid'`, t.signature, lastValidBlockHeight, e.id).changes) return null;
  try {
    await sol.sendRaw(t.bytes);
  } catch (err) {
    // Refused before it went out: nothing happened. Tried again in 10 minutes, with the reason for the admin.
    if (err.rpc) run(`UPDATE escrows SET status = 'paid', settle_sig = NULL, settle_after = ?, error = ? WHERE id = ?`, now() + 10 * 60_000, String(err.message).slice(0, 300), e.id);
  }
  return null;
}

// What's left of an escrow whose rider had no USDC account when it settled: the driver has been paid, and the rest goes to
// the rider as soon as they have one again. Anyone can also send it after the contract's timeout.
async function sendLeftovers() {
  for (const e of all(`SELECT * FROM escrows WHERE leftover = 1 AND status = 'settled' LIMIT 20`)) {
    if (!limit(`leftover:${e.id}`, 1, 60_000)) continue;
    if (!(await sol.account(e.address))) {
      run('UPDATE escrows SET leftover = 0 WHERE id = ?', e.id);
    } else if (!(await hasTokenAccount(e.payer))) {
      tellNoAccount(e, 'rider');
    } else {
      const { blockhash } = await sol.latestBlockhash();
      try { await sol.sendRaw(sol.transaction(serverKey().pub, [...sol.priority(UNITS.settle), settleIx(e, 'refund')], [serverKey()], blockhash).bytes); } catch (err) { console.error('[drivezzz] leftover', e.id, err.message); }
    }
  }
}

let busy = false;
// Sends what's due and confirms what was sent. `onSettled` tells the ride (payout records, notifications).
export async function runSettlements(onSettled) {
  if (!ready() || busy) return;
  busy = true;
  try {
    const t = now();
    // The contract refunds by itself after its timeout; the server does it on the day, whatever was pending.
    for (const e of all(`SELECT * FROM escrows WHERE status = 'paid' AND paid_at + ? < ? AND (outcome IS NULL OR outcome != 'expired')`, rules.escrowTimeout + 60_000, t)) {
      decide(e.id, 'expired', t);
    }
    // An appeal or an admin's hold keeps it here, except the refund after 30 days, which nothing stops.
    const due = all(`SELECT * FROM escrows e WHERE status = 'paid' AND outcome IS NOT NULL AND settle_after <= ?
                     AND (outcome = 'expired' OR (manual_hold = 0 AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.ride_id = e.ride_id AND d.status = 'open')))
                     ORDER BY settle_after LIMIT 20`, t);
    const round = due.length && !fake ? await readRound(due) : null;
    for (const e of due) {
      const done = await sendOutcome(e, round);
      if (done) onSettled(done);
    }
    if (fake) return;
    await sendLeftovers();
    const sending = all(`SELECT * FROM escrows WHERE status = 'settling'`);
    if (!sending.length) return;
    const [st, height] = await Promise.all([sol.statuses(sending.map((e) => e.settle_sig)), sol.blockHeight()]);
    const landed = (s) => s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');
    // A USDC escrow still there after paying out holds a rider's part that couldn't reach them: asked once for all of them.
    const leftCheck = sending.filter((e, i) => landed(st[i]) && usdc(e.coin) && e.outcome !== 'refund' && e.outcome !== 'expired');
    const stillThere = new Set(leftCheck.length ? (await sol.accounts(leftCheck.map((e) => e.address))).flatMap((a, i) => (a ? [leftCheck[i].id] : [])) : []);
    for (const [i, e] of sending.entries()) {
      const s = st[i];
      if (s?.err) {
        run(`UPDATE escrows SET status = 'paid', settle_sig = NULL, settle_after = ?, error = ? WHERE id = ?`, now() + 10 * 60_000, JSON.stringify(s.err).slice(0, 300), e.id);
      } else if (landed(s)) {
        const left = stillThere.has(e.id);
        run(`UPDATE escrows SET status = 'settled', settled_at = ?, error = NULL, leftover = ? WHERE id = ?`, now(), left ? 1 : 0, e.id);
        onSettled(get('SELECT * FROM escrows WHERE id = ?', e.id));
      } else if (!s && height > e.last_valid) {
        // Its blockhash ran out without it landing: it never will. Sent again next round.
        run(`UPDATE escrows SET status = 'paid', settle_sig = NULL WHERE id = ? AND status = 'settling'`, e.id);
      }
    }
  } finally {
    busy = false;
  }
}

// What the app shows of a ride's escrow.
export function publicEscrow(e) {
  if (!e) return null;
  return {
    status: e.status, outcome: e.outcome, settleAfter: e.settle_after, onHold: Boolean(e.manual_hold), coin: e.coin,
    amount: coins.fromUnits(e.coin, BigInt(e.units)), feeAmount: coins.fromUnits(e.coin, BigInt(e.fee_units)),
    driverAmount: coins.fromUnits(e.coin, BigInt(e.units) - BigInt(e.fee_units)),
    address: e.address, explorer: sol.explorerAddress(e.address), settleExplorer: e.settle_sig && e.status === 'settled' ? sol.explorerTx(e.settle_sig) : null,
  };
}
