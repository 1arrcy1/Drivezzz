// Just enough Solana for the escrow, without any library: keys, program addresses, transactions with several
// signers, and the JSON-RPC calls we need. The same code runs the contract's own tests (contract/test/sol.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { b58decode, b58encode, network, onCurve } from './coins.js';
import { makeQueue } from './rpcqueue.js';

export const b58 = (buf) => b58encode(Buffer.from(buf));
export const unb58 = (str) => b58decode(str);
export const key = (k) => (Buffer.isBuffer(k) ? k : k.pub ?? unb58(k));

export const SYSTEM = Buffer.alloc(32);
export const TOKEN = unb58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA = unb58('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const pkcs8 = (seed) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
export function keypair(seed) {
  const pub = crypto.createPublicKey(pkcs8(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { seed, pub, address: b58(pub) };
}
// Solana CLI's key file: 64 numbers, the seed then the public key.
export const loadKeypair = (file) => keypair(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).slice(0, 32)));

export function pda(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256').update(Buffer.concat([...seeds.map((s) => Buffer.from(s)), Buffer.from([bump]), key(program), Buffer.from('ProgramDerivedAddress')])).digest();
    if (!onCurve(h)) return { address: h, bump };
  }
  throw new Error('no program address');
}
export const tokenAccountOf = (owner, mint) => pda([key(owner), TOKEN, key(mint)], ATA).address;
// Whether a string is a Solana address someone can sign for (on the curve, so not a program address).
export function isWalletAddress(str) {
  try { const k = unb58(String(str)); return k.length === 32 && onCurve(k); } catch { return false; }
}

export const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const shortvec = (n) => { const out = []; for (let v = n; ; v >>= 7) { if (v < 0x80) { out.push(v); break; } out.push((v & 0x7f) | 0x80); } return Buffer.from(out); };
// metas: [key, signer, writable]
export const ix = (program, metas, data) => ({ program: key(program), metas: metas.map(([k, s, w]) => ({ key: key(k), signer: !!s, writable: !!w })), data: Buffer.from(data) });

// A legacy transaction. The first key pays the fee. Signers not given leave an empty signature, for a wallet to fill in.
export function transaction(feePayer, instructions, signers, blockhash) {
  const list = [{ key: key(feePayer), signer: true, writable: true }];
  for (const i of instructions) {
    for (const m of i.metas) list.push(m);
    list.push({ key: i.program, signer: false, writable: false });
  }
  const merged = [];
  for (const a of list) {
    const have = merged.find((x) => x.key.equals(a.key));
    if (have) { have.signer ||= a.signer; have.writable ||= a.writable; } else merged.push({ ...a });
  }
  const rank = (a) => (a.signer ? (a.writable ? 0 : 1) : a.writable ? 2 : 3);
  const ordered = merged.map((a, i) => ({ ...a, i })).sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  const index = (k) => ordered.findIndex((a) => a.key.equals(k));
  const nSigners = ordered.filter((a) => a.signer).length;
  const header = Buffer.from([nSigners, ordered.filter((a) => a.signer && !a.writable).length, ordered.filter((a) => !a.signer && !a.writable).length]);
  const body = instructions.map((i) => Buffer.concat([Buffer.from([index(i.program)]), shortvec(i.metas.length), Buffer.from(i.metas.map((m) => index(m.key))), shortvec(i.data.length), i.data]));
  const message = Buffer.concat([header, shortvec(ordered.length), ...ordered.map((a) => a.key), unb58(blockhash), shortvec(body.length), ...body]);
  const sigs = ordered.slice(0, nSigners).map((a) => {
    const s = signers.find((k) => k.pub.equals(a.key));
    return s ? crypto.sign(null, message, pkcs8(s.seed)) : Buffer.alloc(64);
  });
  return { bytes: Buffer.concat([shortvec(nSigners), ...sigs, message]), signature: sigs[0].some((b) => b) ? b58(sigs[0]) : null };
}

// ---------- RPC ----------
export const rpcUrl = () => process.env.CRYPTO_SOL_URL || (network() === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
// The free public connection allows 100 requests in 10 seconds and 40 of one kind: this stays a fifth under that, and what doesn't
// fit waits in line (rpcqueue.js). A connection of your own (CRYPTO_SOL_URL) has no line unless SOL_RPC_PER_10S says so.
const perWindow = process.env.SOL_RPC_PER_10S !== undefined ? Number(process.env.SOL_RPC_PER_10S) || 0 : process.env.CRYPTO_SOL_URL ? 0 : 80;
const queue = makeQueue({ perWindow, perMethod: Math.max(1, Math.round(perWindow * 0.4)) });
export const queueStatus = () => queue.status();
// `urgent`: a rider is waiting on it (paying, or seeing a payment arrive), so it goes before paying out.
export async function rpc(method, params = [], { urgent = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    await queue.take(method, urgent);
    const res = await fetch(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
    // Busy anyway: the whole line waits a moment. Sending is only ever retried by the caller, knowing the signature.
    if (res.status === 429) queue.busy(1500 * (attempt + 1));
    if (res.status === 429 && attempt < 3 && method !== 'sendTransaction') continue;
    if (res.status === 429) throw Object.assign(new Error(`${method}: the network is busy`), { busy: true });
    const json = await res.json();
    if (json.error) throw Object.assign(new Error(`${method}: ${json.error.message}`), { rpc: json.error });
    return json.result;
  }
}
export const latestBlockhash = async (opts) => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }], opts)).value;
export async function accounts(keys, opts) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const v = (await rpc('getMultipleAccounts', [keys.slice(i, i + 100).map((k) => b58(key(k))), { encoding: 'base64', commitment: 'confirmed' }], opts)).value;
    out.push(...v.map((a) => a && { ...a, data: Buffer.from(a.data[0], 'base64'), lamports: BigInt(a.lamports) }));
  }
  return out;
}
export const account = async (k, opts) => (await accounts([k], opts))[0];

// What a transaction offers on top of the base fee, so a busy network doesn't drop it. In micro-lamports per compute unit: the price
// of getting into a block lately, within limits. Fetched in the background, so paying never waits for it.
const COMPUTE_BUDGET = unb58('ComputeBudget111111111111111111111111111111');
const TIP = { least: 10_000, most: 200_000, keepFor: 30_000 };
let tip = { price: TIP.least, at: 0 };
function refreshTip() {
  tip.at = Date.now();
  rpc('getRecentPrioritizationFees', [[]]).then((recent) => {
    const fees = recent.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    if (fees.length) tip.price = Math.min(TIP.most, Math.max(TIP.least, fees[Math.floor(fees.length * 0.75)]));
  }).catch(() => {});
}
// To put in front of a transaction's instructions. `units` is all it may use: the fee is that times the price, used or not.
export function priority(units) {
  if (Date.now() - tip.at > TIP.keepFor) refreshTip();
  return [ix(COMPUTE_BUDGET, [], Buffer.concat([Buffer.from([2]), u32(units)])), ix(COMPUTE_BUDGET, [], Buffer.concat([Buffer.from([3]), u64(tip.price)]))];
}
export const sendRaw = (bytes, opts) => rpc('sendTransaction', [bytes.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }], opts);
export async function statuses(signatures) {
  return (await rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }])).value;
}
export const blockHeight = async () => rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
export const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}${network() === 'mainnet' ? '' : '?cluster=devnet'}`;
export const explorerAddress = (addr) => `https://explorer.solana.com/address/${addr}${network() === 'mainnet' ? '' : '?cluster=devnet'}`;
