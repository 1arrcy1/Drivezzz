// A pretend wallet on the real WalletConnect relay, with the official libraries, to try the app's connect screen without
// a phone. Give it the wc: link from the app (Another wallet → Copy the link) and it approves with these accounts:
//   node wc-wallet.mjs <project id> <wc link> <solana|all>
// Or as a wallet that pays: it shares the address of a Solana CLI key file and signs the ride's payment, answering with only
// the signature or with the whole transaction (wallets do either):
//   node wc-wallet.mjs <project id> <wc link> pay <key file> <signature|transaction>
import crypto from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';
import { decrypt, deriveSymKey, encrypt, generateKeyPair, hashKey } from '@walletconnect/utils';
import * as relayAuth from '@walletconnect/relay-auth';

const [projectId, link, what = 'all', keyFile, answers = 'signature'] = process.argv.slice(2);
const seed = keyFile ? Buffer.from(JSON.parse(fs.readFileSync(keyFile, 'utf8')).slice(0, 32)) : null;
const signer = seed && crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const b58 = (buf) => {
  const abc = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`), out = '';
  while (n > 0n) { out = abc[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b) break; out = `1${out}`; }
  return out;
};
const myAddress = signer && b58(crypto.createPublicKey(signer).export({ format: 'der', type: 'spki' }).subarray(-32));
const m = link.match(/^wc:([0-9a-f]{64})@2\?.*symKey=([0-9a-f]{64})/);
if (!m) throw new Error('not a wc: link');
const [, pairing, pairingKey] = m;
const keys = new Map([[pairing, pairingKey]]);

const pair = relayAuth.generateKeyPair(crypto.randomBytes(32));
const jwt = await relayAuth.signJWT(crypto.randomBytes(16).toString('hex'), 'wss://relay.walletconnect.org', 3600, pair);
const socket = new WebSocket(`wss://relay.walletconnect.org/?auth=${jwt}&projectId=${projectId}&ua=wc-2/js-2/node/pretend-wallet`);
let id = Date.now() * 1000;
const rpc = (method, params) => socket.send(JSON.stringify({ id: ++id, jsonrpc: '2.0', method, params }));
const publish = (topic, payload, tag) => rpc('irn_publish', { topic, message: encrypt({ symKey: keys.get(topic), message: JSON.stringify(payload) }), ttl: 300, tag, prompt: false });
const done = (code, text) => { console.log(text); setTimeout(() => process.exit(code), 300); };

socket.on('unexpected-response', (_, res) => done(1, `relay refused the project id: HTTP ${res.statusCode}`));
socket.on('error', (e) => done(1, `socket: ${e.message}`));
socket.on('open', () => { console.log('relay accepted the project id'); rpc('irn_subscribe', { topic: pairing }); });
setTimeout(() => done(1, 'timed out'), signer ? 300000 : 60000);

socket.on('message', async (raw) => {
  const msg = JSON.parse(raw);
  if (msg.method === 'irn_subscription') {
    socket.send(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: true }));
    const { topic, message, tag } = msg.params.data;
    const key = keys.get(topic);
    if (!key) return;
    const plain = JSON.parse(decrypt({ symKey: key, encoded: message }));
    if (plain.method === 'wc_sessionPropose') {
      const p = plain.params;
      console.log('proposal from', p.proposer.metadata.name, 'asks for', JSON.stringify(Object.fromEntries(Object.entries(p.optionalNamespaces).map(([k, v]) => [k, v.chains]))));
      const me = generateKeyPair();
      const sym = deriveSymKey(me.privateKey, p.proposer.publicKey);
      const session = hashKey(sym);
      keys.set(session, sym);
      rpc('irn_subscribe', { topic: session });
      publish(pairing, { id: plain.id, jsonrpc: '2.0', result: { relay: { protocol: 'irn' }, responderPublicKey: me.publicKey } }, 1101);
      const addresses = {
        solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        xrpl: 'xrpl:0:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        bip122: 'bip122:12a765e31ffd4059bada1e25190f6e98:ltc1qcxh6nuuz2056y8hdnxu2zgck4nvnu67p9cx0nj',
        stellar: 'stellar:pubnet:GDQNH4OC5YUWSSVXT4KSOVJIEDSTZTBEXOARVF6OIF4SMYWXRIUOZ6YP',
      };
      // A wallet that pays answers on the network the app asks for first.
      if (signer) addresses.solana = `${p.optionalNamespaces.solana.chains[0]}:${myAddress}`;
      const namespaces = {};
      for (const [ns, account] of Object.entries(addresses)) {
        if (what !== 'all' && ns !== 'solana') continue;
        namespaces[ns] = { accounts: [account], methods: p.optionalNamespaces[ns]?.methods ?? [], events: [] };
      }
      setTimeout(() => publish(session, { id: Date.now() * 1000, jsonrpc: '2.0', method: 'wc_sessionSettle', params: { relay: { protocol: 'irn' }, controller: { publicKey: me.publicKey, metadata: { name: 'Pretend wallet', description: '', url: 'https://example.com', icons: [] } }, namespaces, expiry: Math.floor(Date.now() / 1000) + 604800 } }, 1102), 800);
    } else if (tag === 1103) {
      if (!signer) done(0, 'the app accepted the session');
      else console.log('the app accepted the session, waiting for the payment');
    } else if (plain.method === 'wc_sessionRequest') {
      const { method, params } = plain.params.request;
      console.log('asked for', method, 'on', plain.params.chainId);
      const tx = Buffer.from(params.transaction, 'base64');
      const signature = crypto.sign(null, tx.subarray(1 + 64 * tx[0]), signer);
      signature.copy(tx, 1);
      publish(topic, { id: plain.id, jsonrpc: '2.0', result: answers === 'transaction' ? { signature: b58(signature), transaction: tx.toString('base64') } : { signature: b58(signature) } }, 1109);
      setTimeout(() => done(0, `signed and answered with the ${answers}`), 2000);
    } else {
      console.log('also got tag', tag, plain.method ?? JSON.stringify(plain.result ?? plain.error));
    }
  }
});
