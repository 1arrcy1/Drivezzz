// Just enough Solana for testing the escrow on devnet with plain Node: keys, addresses, transactions, RPC.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';

// ---------- base58 ----------
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58(buf) {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = `1${out}`; else break; }
  return out;
}
export function unb58(str) {
  let n = 0n;
  for (const c of str) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error(`bad base58 ${str}`); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = `0${hex}`;
  const body = n ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
  const zeros = str.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
export const key = (k) => (Buffer.isBuffer(k) ? k : k.pub ?? unb58(k));

// ---------- keys ----------
const pkcs8 = (seed) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
export function keypair(seed = crypto.randomBytes(32)) {
  const pub = crypto.createPublicKey(pkcs8(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { seed, pub, address: b58(pub) };
}
// Solana CLI's format: 64 numbers, seed then public key.
export function loadKeypair(file) {
  if (!fs.existsSync(file)) {
    const k = keypair();
    fs.writeFileSync(file, JSON.stringify([...k.seed, ...k.pub]), { mode: 0o600 });
  }
  return keypair(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).slice(0, 32)));
}
const sign = (k, msg) => crypto.sign(null, msg, pkcs8(k.seed));

// ---------- program addresses ----------
const P = 2n ** 255n - 19n;
const pow = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const D = (-121665n * pow(121666n, P - 2n)) % P + P;
function onCurve(bytes) {
  const y = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`) & ((1n << 255n) - 1n);
  if (y >= P) return false;
  const y2 = (y * y) % P, u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P, v3 = (v * v * v) % P;
  const x = (u * v3 % P) * pow((u * v3 % P) * v3 % P * v % P, (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  return vx2 === u || vx2 === (P - u) % P;
}
export function pda(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256').update(Buffer.concat([...seeds.map(Buffer.from), Buffer.from([bump]), key(program), Buffer.from('ProgramDerivedAddress')])).digest();
    if (!onCurve(h)) return { address: h, bump };
  }
  throw new Error('no program address');
}

export const SYSTEM = Buffer.alloc(32);
export const TOKEN = unb58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA = unb58('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const LOADER = unb58('BPFLoaderUpgradeab1e11111111111111111111111');
export const tokenAccountOf = (owner, mint) => pda([key(owner), TOKEN, key(mint)], ATA).address;

// ---------- transactions ----------
export const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const shortvec = (n) => { const out = []; for (let v = n; ; v >>= 7) { if (v < 0x80) { out.push(v); break; } out.push((v & 0x7f) | 0x80); } return Buffer.from(out); };
// meta: [key, signer, writable]
export const ix = (program, metas, data) => ({ program: key(program), metas: metas.map(([k, s, w]) => ({ key: key(k), signer: !!s, writable: !!w })), data: Buffer.from(data) });

export function transaction(instructions, signers, blockhash) {
  const list = [{ key: signers[0].pub, signer: true, writable: true }];
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
    if (!s) throw new Error(`missing signer ${b58(a.key)}`);
    return sign(s, message);
  });
  return Buffer.concat([shortvec(nSigners), ...sigs, message]);
}

// ---------- RPC ----------
let id = 0;
export async function rpc(method, params = []) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (res.status === 429 && attempt < 8) { await sleep(1500 * (attempt + 1)); continue; }
    const json = await res.json();
    if (json.error) throw Object.assign(new Error(`${method}: ${json.error.message}`), { rpc: json.error });
    return json.result;
  }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const blockhash = async () => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
export const balance = async (k) => BigInt((await rpc('getBalance', [b58(key(k)), { commitment: 'confirmed' }])).value);
export async function account(k) {
  const v = (await rpc('getAccountInfo', [b58(key(k)), { encoding: 'base64', commitment: 'confirmed' }])).value;
  return v && { ...v, data: Buffer.from(v.data[0], 'base64'), lamports: BigInt(v.lamports) };
}
export async function tokenBalance(k) {
  const a = await account(k);
  return a ? a.data.readBigUInt64LE(64) : null;
}
export const rentFor = async (bytes) => BigInt(await rpc('getMinimumBalanceForRentExemption', [bytes]));

// Sends and waits until confirmed; throws with the program's error if it failed.
// The chain's own clock in seconds, which is the one the contract goes by. A busy network can run behind the wall clock.
export async function chainClock() {
  const r = await rpc('getAccountInfo', ['SysvarC1ock11111111111111111111111111111111', { encoding: 'base64', commitment: 'confirmed' }]);
  return Number(Buffer.from(r.value.data[0], 'base64').readBigInt64LE(32));
}

export async function send(instructions, signers) {
  const tx = transaction(instructions, signers, await blockhash());
  const signature = await rpc('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  for (let i = 0; i < 60; i++) {
    const st = (await rpc('getSignatureStatuses', [[signature]])).value[0];
    if (st?.err) throw Object.assign(new Error(`failed: ${JSON.stringify(st.err)}`), { txErr: st.err, signature });
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
    await sleep(800);
  }
  throw new Error(`not confirmed: ${signature}`);
}
// Runs without sending: the error a transaction would get, or null.
export async function simulate(instructions, signers) {
  const tx = transaction(instructions, signers, await blockhash());
  const r = await rpc('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }]);
  return r.value.err;
}
