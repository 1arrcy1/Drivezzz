// Wallets and prices. Drivezzz holds no money and keeps no balances: each ride is paid into its own escrow on Solana
// (escrow.js). What's here: the wallet addresses people connect (a driver's is where payouts go), prices in euros,
// and what the Wallet screen shows: money on hold for rides and payouts on their way.
import { config } from './config.js';
import { all, get, now, run, tx, uid } from './db.js';
import { ApiError, route, text } from './http.js';
import { requireUser } from './auth.js';
import * as coins from './coins.js';
import * as sol from './solana.js';
import { bump } from './sync.js';

export const COIN_IDS = ['usdc-sol', 'sol'];
export const isCoin = (c) => typeof c === 'string' && COIN_IDS.includes(c);
// Cash goes from rider to driver in the car: it has a ride's place in `coin`, and nothing on the chain.
export const CASH = 'cash';
export const PAY_IDS = [...COIN_IDS, CASH];
export const canPayWith = (c) => isCoin(c) || c === CASH;
export const fromUnits = (coin, units) => coins.fromUnits(coin, BigInt(units));

// The coins a driver has turned on, with a wallet connected.
export function walletCoins(userId) {
  // The demo account drives without a wallet: nothing is ever sent to it.
  if (get('SELECT is_demo FROM users WHERE id = ?', userId)?.is_demo) return COIN_IDS;
  return all('SELECT coin FROM wallets WHERE user_id = ? AND enabled = 1', userId).map((w) => w.coin).filter(isCoin);
}
// What a driver can be paid in: those, and cash unless they turned it off.
export function enabledCoins(userId) {
  const takesCash = get('SELECT takes_cash FROM drivers WHERE user_id = ?', userId)?.takes_cash;
  return takesCash === 0 ? walletCoins(userId) : [...walletCoins(userId), CASH];
}
// The same for many drivers at once: a look at the map needs it for each of them.
export function enabledCoinsOf(userIds) {
  const list = JSON.stringify(userIds);
  const out = new Map(userIds.map((id) => [id, []]));
  for (const w of all('SELECT user_id, coin FROM wallets WHERE enabled = 1 AND user_id IN (SELECT value FROM json_each(?))', list)) {
    if (isCoin(w.coin)) out.get(w.user_id).push(w.coin);
  }
  for (const d of all('SELECT user_id FROM drivers WHERE takes_cash = 1 AND user_id IN (SELECT value FROM json_each(?))', list)) out.get(d.user_id).push(CASH);
  return out;
}
export const payoutAddress = (userId, coin) => get('SELECT address FROM wallets WHERE user_id = ? AND coin = ?', userId, coin)?.address ?? null;

// USDC only reaches a wallet with a USDC account, which a wallet gets the first time it holds USDC. The chain not
// answering blocks nobody: paying checks again.
const noChain = config.pretendChain;
export async function hasUsdcAccount(address) {
  if (noChain) return true;
  try { return Boolean(await sol.account(sol.tokenAccountOf(address, coins.usdcMint()), { urgent: true })); } catch { return true; }
}
// Turned on before this check existed, or the account is gone: off, so no USDC rides come in that can't be paid out.
function turnOffUsdc(userId) {
  run(`UPDATE wallets SET enabled = 0, updated_at = ? WHERE user_id = ? AND coin = 'usdc-sol'`, now(), userId);
}
export async function checkUsdcEnabled(user) {
  const w = get(`SELECT address, enabled FROM wallets WHERE user_id = ? AND coin = 'usdc-sol'`, user.id);
  if (w?.enabled && !user.is_demo && !(await hasUsdcAccount(w.address))) turnOffUsdc(user.id);
}
const NO_USDC = 'This wallet has no USDC account yet, so USDC can’t reach it. Swap a little SOL to USDC in your wallet once, then turn this on.';

// A fare in a coin at a fixed price, rounded up to the coin's smallest unit.
export function unitsFor(coin, cents, eurPerCoin) {
  const decimals = coins.ASSETS[coin].decimals;
  // Whole micro-euros keep this exact enough without floats running through BigInt.
  const micro = BigInt(Math.round(cents * 10_000));
  const price = BigInt(Math.max(1, Math.round(eurPerCoin * 1e8)));
  const scale = 10n ** BigInt(decimals) * 100n;
  return (micro * scale + price - 1n) / price;
}

export async function latestPrice(coin) {
  const prices = await coins.pricesEur();
  const p = prices[coin];
  if (!p) throw new ApiError(503, 'no_price', 'Prices can’t be fetched right now. Try again in a moment.');
  return p;
}

// ---------- the app ----------

// A connected wallet is locked, so someone who gets into a driver's account can't send their pay elsewhere. Changing it
// takes a request with a message and an admin's yes on the panel, good for one change. The first wallet needs none,
// and neither does the same address on the other coin. Rides already paid keep the address they were paid with.
const latestChange = (userId) => get('SELECT * FROM wallet_change_requests WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', userId);
function changeView(user, connected) {
  const r = latestChange(user.id);
  return {
    locked: connected && r?.status !== 'allowed',
    request: r ? { status: r.status, message: r.message, at: r.created_at, decidedAt: r.decided_at } : null,
  };
}

const explorerAddress = (address) => `https://explorer.solana.com/address/${address}${coins.network() === 'mainnet' ? '' : '?cluster=devnet'}`;
const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}${coins.network() === 'mainnet' ? '' : '?cluster=devnet'}`;

// Each line of the overview: which way the money goes, why, which wallet, and when it clears. `reason` is ride (paying for a
// ride), half (a cancelled ride split 50/50), refund, drive (a driver's pay) or driveHalf (their half of a cancelled ride).
// In euros at the price when it was paid, so a ride's lines add up to what it cost.
function moneyMoves(user) {
  const moves = [];
  const link = (e) => (e.address?.startsWith('fake-') ? null : e.settle_sig && e.status === 'settled' ? explorerTx(e.settle_sig) : e.address ? explorerAddress(e.address) : null);
  for (const e of all(`SELECT e.*, r.status AS ride_status, r.dropoff_label FROM escrows e JOIN rides r ON r.id = e.ride_id
                       WHERE r.rider_id = ? AND e.status IN ('paid', 'settling', 'settled') ORDER BY COALESCE(e.settled_at, e.paid_at) DESC LIMIT 60`, user.id)) {
    const units = BigInt(e.units);
    const open = e.status !== 'settled';
    const line = (direction, reason, part, wallet, pending = open) => moves.push({
      id: `${e.id}-${direction}`, direction, reason, coin: e.coin, amount: coins.fromUnits(e.coin, part), wallet,
      eurCents: Math.round(Number(coins.fromUnits(e.coin, part)) * e.eur_per_coin * 100),
      pending, when: open ? e.settle_after : null, settling: e.status === 'settling', onHold: Boolean(e.manual_hold),
      rideId: e.ride_id, rideStatus: e.ride_status, to: e.dropoff_label, at: e.settled_at, explorer: link(e),
      // The driver has been paid; the rider's part waits on the chain until their wallet has a USDC account.
      needsUsdcAccount: pending && !open,
    });
    if (e.outcome === 'refund' || e.outcome === 'expired') {
      line('in', 'refund', units, e.payer, open || Boolean(e.leftover));
    } else if (e.outcome === 'split') {
      // The rider gets any odd unit.
      line('out', 'half', units / 2n, e.driver_address);
      line('in', 'half', units - units / 2n, e.payer, open || Boolean(e.leftover));
    } else {
      line('out', 'ride', units, e.driver_address);
    }
  }
  for (const p of all(`SELECT p.*, e.settle_sig, e.status AS escrow_status, e.manual_hold, e.address, e.driver_address, e.outcome, r.status AS ride_status, r.dropoff_label
                       FROM payouts p JOIN rides r ON r.id = p.ride_id LEFT JOIN escrows e ON e.ride_id = p.ride_id AND e.status IN ('paid', 'settling', 'settled')
                       WHERE p.user_id = ? AND p.kind = 'payout' AND p.status != 'cancelled' AND p.coin != 'cash' ORDER BY p.created_at DESC LIMIT 60`, user.id)) {
    const demo = p.status === 'demo';
    moves.push({
      id: p.id, direction: 'in', reason: p.outcome === 'split' || p.ride_status === 'cancelled' ? 'driveHalf' : 'drive', coin: p.coin, amount: coins.fromUnits(p.coin, BigInt(p.units)),
      eurCents: p.eur_cents, wallet: p.driver_address ?? payoutAddress(user.id, p.coin), pending: !demo && p.status !== 'confirmed', when: p.due_at,
      settling: ['queued', 'sending', 'sent'].includes(p.status), onHold: Boolean(p.manual_hold) || p.status === 'stuck', rideId: p.ride_id, rideStatus: p.ride_status,
      to: p.dropoff_label, at: p.confirmed_at ?? p.created_at, demo, explorer: p.settle_sig && p.status === 'confirmed' && !p.address?.startsWith('fake-') ? explorerTx(p.settle_sig) : null,
    });
  }
  return moves.sort((a, b) => (b.at ?? Infinity) - (a.at ?? Infinity));
}

export async function walletView(user) {
  const prices = await coins.pricesEur().catch(() => ({}));
  const addresses = Object.fromEntries(all('SELECT * FROM wallets WHERE user_id = ?', user.id).map((w) => [w.coin, w]));
  const eur = (coin, units) => (prices[coin] ? Math.round(Number(coins.fromUnits(coin, BigInt(units))) * prices[coin] * 100) : null);
  // A rider's rides with money in an escrow that isn't settled yet.
  const held = all(`SELECT e.*, r.status AS ride_status, r.dropoff_label, r.scheduled_at FROM escrows e JOIN rides r ON r.id = e.ride_id
                    WHERE r.rider_id = ? AND e.status IN ('paid', 'settling') ORDER BY e.paid_at DESC`, user.id).map((e) => ({
    rideId: e.ride_id, coin: e.coin, amount: coins.fromUnits(e.coin, BigInt(e.units)), eurCents: eur(e.coin, e.units),
    status: e.status, outcome: e.outcome, settleAfter: e.settle_after, onHold: Boolean(e.manual_hold), rideStatus: e.ride_status, to: e.dropoff_label, scheduledAt: e.scheduled_at,
    explorer: explorerAddress(e.address),
  }));
  const usdcAddress = addresses['usdc-sol']?.address;
  const needsUsdc = Boolean(usdcAddress && !user.is_demo && get('SELECT 1 AS x FROM drivers WHERE user_id = ?', user.id) && !(await hasUsdcAccount(usdcAddress)));
  if (needsUsdc && addresses['usdc-sol'].enabled) { turnOffUsdc(user.id); addresses['usdc-sol'].enabled = 0; }
  return {
    network: coins.network(),
    demo: Boolean(user.is_demo),
    change: changeView(user, Object.keys(addresses).length > 0),
    takesCash: get('SELECT takes_cash FROM drivers WHERE user_id = ?', user.id)?.takes_cash === 1,
    coins: COIN_IDS.map((coin) => {
      const w = addresses[coin];
      const a = coins.ASSETS[coin];
      return {
        id: coin, name: a.name, symbol: a.symbol, chain: 'Solana', eurPerCoin: prices[coin] ?? null,
        address: w?.address ?? null, enabled: w ? Boolean(w.enabled) : false, via: w?.via ?? null, available: true,
        needsTokenAccount: coin === 'usdc-sol' && needsUsdc,
      };
    }),
    held,
    heldEurCents: held.reduce((s, h) => s + (h.eurCents ?? 0), 0),
    moves: moneyMoves(user),
    payouts: all(`SELECT p.*, e.settle_sig, e.manual_hold, e.address AS escrow FROM payouts p LEFT JOIN escrows e ON e.ride_id = p.ride_id AND e.status IN ('paid', 'settling', 'settled')
                  WHERE p.user_id = ? AND p.kind = 'payout' AND p.coin != 'cash' ORDER BY p.created_at DESC LIMIT 30`, user.id).map((p) => ({
      id: p.id, kind: p.kind, coin: p.coin, amount: coins.fromUnits(p.coin, BigInt(p.units)), eurCents: p.eur_cents, status: p.status,
      dueAt: p.due_at, onHold: Boolean(p.manual_hold), rideId: p.ride_id, at: p.created_at, explorer: p.settle_sig && p.status === 'confirmed' ? explorerTx(p.settle_sig) : null,
    })),
  };
}

route('GET', '/api/wallet', async (ctx) => walletView(requireUser(ctx)));
// The line for the Solana connection (solana.js): how many requests wait and about how long, so the app can say a payment is in
// the queue. Asks nothing of the network itself.
route('GET', '/api/chain/queue', (ctx) => { requireUser(ctx); return sol.queueStatus(); });

// Connecting a wallet: an address per coin, and whether the driver wants to be paid in that coin.
route('POST', '/api/wallet/address', async (ctx) => {
  const user = requireUser(ctx);
  const coin = ctx.body.coin;
  if (!isCoin(coin)) throw new ApiError(400, 'bad_coin', 'Drivezzz uses USDC and SOL on Solana.');
  const raw = text(ctx.body.address, 120);
  // An address can be replaced by connecting another wallet, never just taken away: that goes through support.
  if (!raw) throw new ApiError(403, 'support_only', 'To remove an address, send a support request. You can connect another wallet to change it.');
  let checked;
  try { checked = coins.checkAddress(raw); } catch (e) { throw new ApiError(400, 'bad_address', e.message); }
  if (get('SELECT 1 AS x FROM banned_wallets WHERE address = ?', checked.address)) throw new ApiError(403, 'banned', 'This wallet can’t be used on Drivezzz.');
  let enabled = ctx.body.enabled === undefined ? 1 : ctx.body.enabled ? 1 : 0;
  if (enabled && coin === 'usdc-sol' && !user.is_demo && !(await hasUsdcAccount(checked.address))) enabled = 0;
  const via = text(ctx.body.via, 40) || null;
  // In one go, after the wait above: two at once can't both use the same yes.
  tx(() => {
    const mine = all('SELECT address FROM wallets WHERE user_id = ?', user.id).map((w) => w.address);
    if (mine.length && !mine.includes(checked.address)) {
      const yes = get(`SELECT id FROM wallet_change_requests WHERE user_id = ? AND status = 'allowed' ORDER BY created_at DESC LIMIT 1`, user.id);
      if (!yes) throw new ApiError(403, 'wallet_locked', 'Your wallet is locked. Request a change on the Wallet screen, and you can change it once support says yes.');
      run(`UPDATE wallet_change_requests SET status = 'used', used_at = ?, old_address = ?, new_address = ? WHERE id = ?`, now(), mine[0], checked.address, yes.id);
    }
    run(`INSERT INTO wallets (user_id, coin, address, tag, enabled, via, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(user_id, coin) DO UPDATE SET address = excluded.address, tag = NULL, enabled = excluded.enabled, via = excluded.via, updated_at = excluded.updated_at`,
      user.id, coin, checked.address, enabled, via, now());
  });
  bump(user.id);
  return walletView(user);
});

// Asking to change a connected wallet, with a message for whoever decides. One at a time: a second tap changes nothing.
route('POST', '/api/wallet/change-request', async (ctx) => {
  const user = requireUser(ctx);
  if (!get('SELECT 1 AS x FROM wallets WHERE user_id = ? LIMIT 1', user.id)) throw new ApiError(409, 'no_address', 'Connect a wallet first: that needs no request.');
  const latest = latestChange(user.id);
  if (latest?.status !== 'open' && latest?.status !== 'allowed') {
    run(`INSERT INTO wallet_change_requests (id, user_id, message, created_at) VALUES (?, ?, ?, ?)`, uid('wc_'), user.id, text(ctx.body.message, 1000) || null, now());
    bump(user.id);
  }
  return walletView(user);
});

route('POST', '/api/wallet/enable', async (ctx) => {
  const user = requireUser(ctx);
  const coin = ctx.body.coin;
  if (!isCoin(coin)) throw new ApiError(400, 'bad_coin', 'Drivezzz uses USDC and SOL on Solana.');
  const address = payoutAddress(user.id, coin);
  if (ctx.body.enabled && coin === 'usdc-sol' && address && !user.is_demo && !(await hasUsdcAccount(address))) throw new ApiError(409, 'no_usdc_account', NO_USDC);
  const changed = run('UPDATE wallets SET enabled = ?, updated_at = ? WHERE user_id = ? AND coin = ?', ctx.body.enabled ? 1 : 0, now(), user.id, coin);
  if (!changed.changes) throw new ApiError(409, 'no_address', 'Connect a wallet for this coin first.');
  return walletView(user);
});

// A driver can say no to cash, like to a coin. Rides they already have stay theirs.
route('POST', '/api/wallet/cash', async (ctx) => {
  const user = requireUser(ctx);
  const changed = run('UPDATE drivers SET takes_cash = ? WHERE user_id = ?', ctx.body.enabled ? 1 : 0, user.id);
  if (!changed.changes) throw new ApiError(409, 'not_a_driver', 'Only drivers take cash.');
  return walletView(user);
});
