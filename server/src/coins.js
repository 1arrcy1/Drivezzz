// The two coins Drivezzz uses, USDC and SOL on Solana: the network, amounts, addresses and prices in euros. Paying and
// settling are in escrow.js, the chain itself in solana.js. Drivezzz holds no money: there are no deposits, balances or
// wallets of its own, and the server has no keys but the escrow's.
import { getMeta, setMeta } from './db.js';

export const ASSETS = {
  'usdc-sol': { symbol: 'USDC', name: 'USDC on Solana', decimals: 6, price: 'USDCEUR',
    token: { mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', testnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' } },
  sol: { symbol: 'SOL', name: 'SOL', decimals: 9, price: 'SOLEUR' },
};
export const ASSET_IDS = Object.keys(ASSETS);
// Rides from before the escrow can still be in these: only to show their amounts.
const OLD_DECIMALS = { xrp: 6, ltc: 8, xlm: 7 };

// The network starts as testnet; the admin panel switches it to mainnet.
// With a pretend chain it says so: nothing real moves, whatever the switch says.
export const network = () => (process.env.PRETEND_CHAIN !== '1' && getMeta('crypto:network') === 'mainnet' ? 'mainnet' : 'testnet');
export const setNetwork = (net) => setMeta('crypto:network', net === 'mainnet' ? 'mainnet' : '');
export const usdcMint = () => process.env.CRYPTO_USDC_SOL_MINT || ASSETS['usdc-sol'].token[network()];

// Amounts are whole base units (lamports, millionths of a USDC) as BigInt; shown as decimal strings.
export function fromUnits(coin, units) {
  const d = ASSETS[coin]?.decimals ?? OLD_DECIMALS[coin];
  const s = BigInt(units).toString().padStart(d + 1, '0');
  return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '') || '0';
}

// ---------- base58 ----------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const bn = (b) => (b.length ? BigInt(`0x${b.toString('hex')}`) : 0n);
export function b58encode(buf) {
  let n = bn(Buffer.from(buf));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of buf) { if (byte !== 0) break; s = B58[0] + s; }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  for (const ch of str) { if (ch !== B58[0]) break; zeros++; }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}

// ---------- addresses ----------

function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
// Whether 32 bytes are a point on the curve: Solana's program addresses must not be.
const P25519 = 2n ** 255n - 19n;
const D25519 = (-121665n * modPow(121666n, P25519 - 2n, P25519)) % P25519 + P25519;
export function onCurve(bytes) {
  const y = bn(Buffer.from(bytes).reverse()) & ((1n << 255n) - 1n);
  if (y >= P25519) return false;
  const y2 = (y * y) % P25519;
  const u = (y2 - 1n + P25519) % P25519;
  const v = (D25519 * y2 + 1n) % P25519;
  const v3 = (v * v * v) % P25519;
  const x = (u * v3 % P25519) * modPow((u * v3 % P25519) * v3 % P25519 * v % P25519, (P25519 - 5n) / 8n, P25519) % P25519;
  const vx2 = (v * x % P25519) * x % P25519;
  return vx2 === u || vx2 === (P25519 - u) % P25519;
}

// A Solana address someone gave us: the address, or an error.
export function checkAddress(raw) {
  const address = String(raw ?? '').trim();
  let key;
  try { key = b58decode(address); } catch { key = null; }
  if (!key || key.length !== 32 || key.equals(Buffer.alloc(32))) throw new Error('That isn’t a Solana address');
  return { address, key };
}

// ---------- prices ----------

let priceCache = { at: 0, eur: {} };
// The price from the last few minutes without waiting, for showing what a ride comes to in a coin (the pay card): an older one is
// asked for again in the background, and until there is one, there's nothing to show. Paying always asks for the latest.
export function knownPriceEur(coin) {
  if (Date.now() - priceCache.at > 60_000) pricesEur().catch(() => {});
  return Date.now() - priceCache.at < 10 * 60_000 ? priceCache.eur[coin] ?? null : null;
}
export async function pricesEur() {
  if (Date.now() - priceCache.at < 60000 && Object.keys(priceCache.eur).length) return priceCache.eur;
  const base = process.env.CRYPTO_PRICE_URL || 'https://api.kraken.com';
  const pairs = ['SOLEUR', 'USDCEUR'];
  const byPair = {};
  try {
    const r = await fetch(`${base}/0/public/Ticker?pair=${pairs.join(',')}`, { signal: AbortSignal.timeout(10000) });
    const json = await r.json();
    for (const [key, t] of Object.entries(json.result ?? {})) {
      const name = key.replace(/^X(?=[A-Z]{3}Z?EUR$)|Z(?=EUR$)/g, '');
      const pair = pairs.find((p) => name === p);
      if (pair && Number(t?.c?.[0]) > 0) byPair[pair] = Number(t.c[0]);
    }
  } catch { /* the next source */ }
  if (pairs.some((p) => !byPair[p]) && !process.env.CRYPTO_PRICE_URL) {
    const ids = { SOLEUR: 'solana', USDCEUR: 'usd-coin' };
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(ids).join(',')}&vs_currencies=eur`, { signal: AbortSignal.timeout(10000) });
      const json = await r.json();
      for (const p of pairs) if (!byPair[p] && json[ids[p]]?.eur > 0) byPair[p] = json[ids[p]].eur;
    } catch { /* none */ }
  }
  const eur = {};
  for (const a of ASSET_IDS) {
    if (byPair[ASSETS[a].price]) eur[a] = byPair[ASSETS[a].price];
  }
  if (Object.keys(byPair).length) priceCache = { at: Date.now(), eur };
  return eur;
}
