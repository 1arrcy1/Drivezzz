// A pretend MetaMask on MetaMask's real relay, with their own wallet client and encryption library, to try the app's side of
// MetaMask Connect (drivezzz/Core/MetaMaskConnect.swift) without a phone. It takes the link the app opens, checks it the way
// their phone app does, and answers.
//   node mm-wallet.mjs <link> <approve|decline|empty> [seconds before answering]
// In a folder with: npm i --ignore-scripts @metamask/mobile-wallet-protocol-core @metamask/mobile-wallet-protocol-wallet-client eciesjs pako ws
// (The real wallet's refusal over WalletConnect, and why this exists, is at the top of MetaMaskConnect.swift.)
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { inflate } from 'pako';
import { PrivateKey, PublicKey, decrypt, encrypt } from 'eciesjs';
import { SessionStore, WebSocketTransport } from '@metamask/mobile-wallet-protocol-core';
import { WalletClient } from '@metamask/mobile-wallet-protocol-wallet-client';

const [link, what = 'approve', delay = '0'] = process.argv.slice(2);
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const RELAY = 'wss://mm-sdk-relay.api.cx.metamask.io/connection/websocket';
const ADDRESS = 'G3kHqPretendWalletAddress1111111111111111111';
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const done = (code, text) => { console.log(text); setTimeout(() => process.exit(code), 500); };
setTimeout(() => done(1, 'timed out'), 120000);

// As their app reads it: app/core/SDKConnectV2/utils/parseMwpConnectDeeplink.ts and types/connection-request.ts.
const url = new URL(link);
if (url.protocol !== 'metamask:' || !link.startsWith('metamask://connect/mwp')) throw new Error(`not their link: ${link.slice(0, 40)}`);
const p = url.searchParams.get('p');
const json = url.searchParams.get('c') === '1' ? new TextDecoder().decode(inflate(Uint8Array.from(atob(p), (c) => c.charCodeAt(0)))) : p;
const request = JSON.parse(json);
const { sessionRequest: s, metadata: m } = request;
const checks = [
  ['uuid id', /^[0-9a-f-]{36}$/i.test(s.id)],
  ['33-byte key', Buffer.from(s.publicKeyB64, 'base64').length === 33],
  ['handshake channel', /^handshake:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.channel)],
  ['mode', ['trusted', 'untrusted'].includes(s.mode)],
  ['not expired', s.expiresAt > Date.now()],
  ['dapp name and https url', Boolean(m.dapp.name) && new URL(m.dapp.url).protocol === 'https:'],
  ['sdk', Boolean(m.sdk.version) && Boolean(m.sdk.platform)],
];
for (const [name, ok] of checks) if (!ok) throw new Error(`the link fails their check: ${name}`);
console.log('link passes their checks:', checks.map((c) => c[0]).join(', '));
if (s.initialMessage.payload.name !== 'metamask-multichain-provider' || s.initialMessage.payload.data.method !== 'wallet_createSession') throw new Error('first request is wrong');
console.log('scopes asked:', Object.keys(s.initialMessage.payload.data.params.optionalScopes).join(', '));

const memory = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }; };
const keymanager = {
  generateKeyPair() { const k = new PrivateKey(); return { privateKey: new Uint8Array(k.secret), publicKey: k.publicKey.toBytes(true) }; },
  validatePeerKey(key) { PublicKey.fromHex(Buffer.from(key).toString('hex')); },
  async encrypt(text, to) { return Buffer.from(encrypt(to, Buffer.from(text, 'utf8'))).toString('base64'); },
  async decrypt(sealed, secret) { return Buffer.from(decrypt(secret, Buffer.from(sealed, 'base64'))).toString('utf8'); },
};
const transport = await WebSocketTransport.create({ url: RELAY, kvstore: memory(), websocket: WebSocket });
const sessionstore = await SessionStore.create(memory());
const client = new WalletClient({ transport, sessionstore, keymanager });
client.on('error', (e) => console.log('client error:', e.message));
client.on('message', async ({ name, data }) => {
  console.log('asked:', name, data.method);
  await wait(Number(delay));
  const answer = (body) => client.sendResponse({ name, data: { jsonrpc: '2.0', id: data.id, ...body } });
  if (data.method === 'wallet_createSession') {
    if (what === 'decline') return void (await answer({ error: { code: 4001, message: 'User rejected the request.' } }), console.log('declined'));
    const accounts = what === 'empty' ? [] : [`${SOLANA}:${ADDRESS}`];
    await answer({ result: { sessionScopes: { [SOLANA]: { methods: ['signTransaction'], notifications: [], accounts } } } });
    console.log('approved');
  } else if (data.method === 'wallet_invokeMethod') {
    const { scope, request: inner } = data.params;
    if (scope !== SOLANA || inner.method !== 'signTransaction' || inner.params.account.address !== ADDRESS || inner.params.scope !== SOLANA) throw new Error(`bad sign request: ${JSON.stringify(data.params)}`);
    // What their Solana part does: the transaction back, with a signature in it. Here, a hash of it up front, for the other side to check.
    const tx = Buffer.from(inner.params.transaction, 'base64');
    await answer({ result: { signedTransaction: Buffer.concat([crypto.createHash('sha256').update(tx).digest(), tx]).toString('base64') } });
    done(0, 'signed');
  }
});
await client.connect({ sessionRequest: s });
console.log('connected to the relay; the offer is out');
if (what !== 'approve') setTimeout(() => done(0, 'finished'), 8000);
