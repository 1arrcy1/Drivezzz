// The encryption of messages, the same as the app's Core/E2E.swift: keep the two byte-compatible. X25519 between the two
// people's keys, HKDF-SHA256 to a chat key, AES-256-GCM per message (nonce | ciphertext | tag, base64). The server only
// uses this for simulated people in the demo world, and to read a chat someone reported, with the keys their phone sent.
import crypto from 'node:crypto';

const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SALT = 'drivezzz-e2e-v1';

export const validKey = (k) => typeof k === 'string' && k.length === 44 && Buffer.from(k, 'base64').length === 32;

export function newKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = (k, field) => Buffer.from(k.export({ format: 'jwk' })[field], 'base64url').toString('base64');
  return { publicKey: raw(publicKey, 'x'), privateKey: raw(privateKey, 'd') };
}

// The key two people share: either of them gets the same one from their own private key and the other's public key.
export function chatKey(myPrivate, myPublic, theirPublic) {
  const secret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(myPrivate, 'base64')]), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(theirPublic, 'base64')]), format: 'der', type: 'spki' }),
  });
  return Buffer.from(crypto.hkdfSync('sha256', secret, SALT, `chat|${[myPublic, theirPublic].sort().join('|')}`, 32));
}

export function seal(key, text) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64');
}

// The text, or null if this key doesn't open it.
export function open(key, sealed) {
  const raw = Buffer.from(String(sealed), 'base64');
  if (raw.length < 29) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
