// Apple's App Attest: proof that a request comes from the real Drivezzz app on a real iPhone, not from a changed copy or a script.
// Android's Key Attestation is below, doing the same for Android phones.
// The app makes a key in the phone's Secure Enclave and Apple certifies it once (an attestation); after that the app signs what
// it sends with it (an assertion). The face match runs on the phone (checks.js), so its result only counts when it's signed this way.
// https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, oidOf, tagged, intOf } from './der.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = new crypto.X509Certificate(fs.readFileSync(path.join(HERE, 'attest', 'apple-app-attest-root.pem')));
export const APP_ID = process.env.APP_ATTEST_APP_ID || 'N92R3SAXJ7.eu.drivezzz.app';
const sha256 = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };

// Just enough CBOR (RFC 8949) for what App Attest sends: maps, arrays, byte and text strings, numbers.
export function cbor(buf) {
  let i = 0;
  const item = () => {
    const b = buf[i++];
    const major = b >> 5, info = b & 31;
    let n;
    if (info < 24) n = info;
    else if (info === 24) n = buf[i++];
    else if (info === 25) { n = buf.readUInt16BE(i); i += 2; }
    else if (info === 26) { n = buf.readUInt32BE(i); i += 4; }
    else if (info === 27) { n = Number(buf.readBigUInt64BE(i)); i += 8; }
    else throw new Error('CBOR: not supported');
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { const v = buf.subarray(i, i + n); i += n; return v; }
      case 3: { const v = buf.subarray(i, i + n).toString('utf8'); i += n; return v; }
      case 4: return Array.from({ length: n }, item);
      case 5: { const o = {}; for (let k = 0; k < n; k++) { const key = item(); o[key] = item(); } return o; }
      case 6: return item();
      default: return n === 20 ? false : n === 21 ? true : null;
    }
  };
  return item();
}

// An assertion's authenticator data stops after the counter; an attestation's goes on with the environment and the key's id.
function readAuthData(a) {
  const out = { rpIdHash: a.subarray(0, 32), flags: a[32], counter: a.readUInt32BE(33) };
  if (a.length >= 55) Object.assign(out, { aaguid: a.subarray(37, 53), credentialId: a.subarray(55, 55 + a.readUInt16BE(53)) });
  return out;
}

const AAGUIDS = { development: Buffer.from('appattestdevelop'), production: Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]) };

// The nonce Apple put in the leaf certificate: extension 1.2.840.113635.100.8.2, a SEQUENCE with [1] OCTET STRING.
function nonceOf(cert) {
  const tbs = parse(cert.raw).children[0];
  const extensions = tagged(tbs, 3)?.children[0].children ?? [];
  const ext = extensions.find((e) => oidOf(e.children[0]) === '1.2.840.113635.100.8.2');
  if (!ext) return null;
  const inner = parse(ext.children[ext.children.length - 1].value);
  return tagged(inner, 1)?.children[0].value ?? null;
}

// The first time: the attestation of a new key. Returns its public key (DER, for later) and which environment it's in.
export function verifyAttestation({ keyId, attestation, challenge }) {
  const keyIdBytes = Buffer.from(keyId, 'base64');
  const att = cbor(Buffer.from(attestation, 'base64'));
  if (att.fmt !== 'apple-appattest') throw new Error('not an App Attest attestation');
  const [leafDer, middleDer] = att.attStmt.x5c;
  const leaf = new crypto.X509Certificate(leafDer), middle = new crypto.X509Certificate(middleDer);
  const t = new Date();
  for (const c of [leaf, middle]) if (new Date(c.validFrom) > t || new Date(c.validTo) < t) throw new Error('certificate out of date');
  if (!leaf.checkIssued(middle) || !leaf.verify(middle.publicKey) || !middle.checkIssued(ROOT) || !middle.verify(ROOT.publicKey)) throw new Error('not certified by Apple');
  const nonce = sha256(att.authData, sha256(Buffer.from(challenge)));
  if (!nonceOf(leaf)?.equals(nonce)) throw new Error('not for this challenge');
  const publicKey = leaf.publicKey.export({ type: 'spki', format: 'der' });
  if (!sha256(publicKey.subarray(publicKey.length - 65)).equals(keyIdBytes)) throw new Error('not this key');
  const auth = readAuthData(att.authData);
  if (!auth.rpIdHash.equals(sha256(APP_ID))) throw new Error('not this app');
  if (auth.counter !== 0) throw new Error('not a new key');
  const environment = Object.keys(AAGUIDS).find((k) => AAGUIDS[k].equals(auth.aaguid));
  if (!environment) throw new Error('unknown environment');
  if (!auth.credentialId.equals(keyIdBytes)) throw new Error('not this key');
  return { publicKey: publicKey.toString('base64'), environment };
}

// Every time after: the app signed clientData (the exact bytes it sent) with that key. Returns the new counter.
export function verifyAssertion({ assertion, clientData, publicKey, counter }) {
  const a = cbor(Buffer.from(assertion, 'base64'));
  const nonce = sha256(a.authenticatorData, sha256(clientData));
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify('sha256', nonce, key, a.signature)) throw new Error('signature doesn’t match');
  const auth = readAuthData(a.authenticatorData);
  if (!auth.rpIdHash.equals(sha256(APP_ID))) throw new Error('not this app');
  if (auth.counter <= counter) throw new Error('used before');
  return auth.counter;
}

// ---------- Android: Key Attestation ----------
// The same on Android (Pieter, 7 November 2026: Android's results should count by themselves too, and nobody should be able to
// send results from a script). The app makes a key in the phone's secure hardware (TEE or StrongBox), and the phone's
// attestation certificates, chained to Google's hardware attestation root, say what holds it: this app (its package and signing
// key), on a phone with a locked bootloader running the Android it was verified to boot. After that the app signs what it sends
// with that key (AppAttest.kt). https://developer.android.com/privacy-and-security/security-key-attestation
const GOOGLE_ROOT_KEYS = fs.readFileSync(path.join(HERE, 'attest', 'google-hardware-attestation-roots.pem'), 'utf8')
  .split(/(?=-----BEGIN CERTIFICATE-----)/).filter((p) => p.includes('BEGIN'))
  .map((p) => new crypto.X509Certificate(p).publicKey.export({ type: 'spki', format: 'der' }));
export const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || 'eu.drivezzz.app';
// The apps that count, by the SHA-256 of their signing certificate: the Mac's own key, which signs the live and qa APKs, the upload
// key in android/keystore.properties, which signs a release APK (8 November 2026: Pieter's phone had one, and nothing it sent was
// signed), and once the app is on Google Play, Play's app signing key (Play Console, Test and release, App integrity).
export const ANDROID_SIGNERS = (process.env.ANDROID_SIGNING_SHA256 || '2be13b0cf1ca3aeccb49b24fb9a4695eb06fafbce7582f3590e0fae3afc3a7b7,2dcd138157db2c8d453dd976b09eeb9f40b7b839cac898846376d5dd2d29eadd')
  .split(',').map((s) => s.trim().toLowerCase().replace(/:/g, '')).filter(Boolean);
const KEY_DESCRIPTION = '1.3.6.1.4.1.11129.2.1.17';
const PROVISIONING_INFO = '1.3.6.1.4.1.11129.2.1.30';

function extensionOf(cert, oid) {
  const tbs = parse(cert.raw).children[0];
  const ext = (tagged(tbs, 3)?.children[0].children ?? []).find((e) => oidOf(e.children[0]) === oid);
  return ext ? ext.children[ext.children.length - 1].value : null;
}
const fieldOf = (list, n) => tagged(list, n)?.children[0] ?? null;

// Google's list of attestation keys it has revoked or suspended, by serial: kept for 6 hours, fetched again after that.
const revocations = { at: 0, serials: new Set() };
export async function refreshRevocations(fetcher = fetch) {
  if (Date.now() - revocations.at < 6 * 3600_000) return;
  try {
    const r = await fetcher('https://android.googleapis.com/attestation/status', { signal: AbortSignal.timeout(5000) });
    const json = await r.json();
    revocations.serials = new Set(Object.keys(json.entries ?? {}).map((k) => k.toLowerCase()));
    revocations.at = Date.now();
  } catch (e) {
    console.warn(`attest: Google's revocation list couldn't be fetched (${e.message}); using the one from before`);
  }
}
const serialOf = (cert) => cert.serialNumber.toLowerCase().replace(/^0+(?=.)/, '');

// The first time: the attestation of a new key, as the chain of certificates the phone gave (DER, base64, the key's own first).
// Returns its public key and 'android'. `roots`, `minLevel` and `allowUnlocked` are for tests with an emulator's chain.
export function verifyAndroidAttestation({ keyId, chain, challenge, roots = GOOGLE_ROOT_KEYS, signers = ANDROID_SIGNERS, packageName = ANDROID_PACKAGE, minLevel = 1, allowUnlocked = false, now = new Date() }) {
  if (!Array.isArray(chain) || chain.length < 2 || chain.length > 10) throw new Error('no certificate chain');
  const certs = chain.map((c) => new crypto.X509Certificate(Buffer.from(String(c), 'base64')));
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].checkIssued(certs[i + 1]) || !certs[i].verify(certs[i + 1].publicKey)) throw new Error('the chain is broken');
  }
  const top = certs[certs.length - 1];
  if (!top.verify(top.publicKey)) throw new Error('the chain is broken');
  const topKey = top.publicKey.export({ type: 'spki', format: 'der' });
  if (!roots.some((r) => r.equals(topKey))) throw new Error('not certified by Google');
  for (const c of certs) if (revocations.serials.has(serialOf(c))) throw new Error('a revoked attestation key');
  // Keys provisioned remotely (RKP, every phone that launched with Android 16) have short-lived certificates whose dates count.
  // Factory keys of older phones have certificates that ran out years ago and are still good: Google says to trust those.
  const rkp = certs.some((c) => extensionOf(c, PROVISIONING_INFO));
  if (rkp) {
    for (const c of certs.slice(1)) if (new Date(c.validFrom) > now || new Date(c.validTo) < now) throw new Error('certificate out of date');
  }
  // Only the one nearest the root can be trusted: anything below it could be someone extending the chain. That must be the key's.
  const described = certs.map((c) => extensionOf(c, KEY_DESCRIPTION));
  if (!described[0] || described.slice(1).some(Boolean)) throw new Error('not a key attestation');
  const d = parse(described[0]).children;
  // KeyDescription: version, its security level, KeyMint's version, its security level, the challenge, an id, then what software
  // and what hardware vouch for.
  const [, attestationLevel, , keyMintLevel, attestedChallenge, , software, hardware] = d;
  // 0 is software, 1 the phone's trusted environment, 2 StrongBox: the key has to be in hardware.
  if (intOf(attestationLevel) < minLevel || intOf(keyMintLevel) < minLevel) throw new Error('not in secure hardware');
  if (!attestedChallenge.value.equals(sha256(Buffer.from(challenge)))) throw new Error('not for this challenge');
  const appIdNode = fieldOf(software, 709) ?? fieldOf(hardware, 709);
  if (!appIdNode) throw new Error('doesn’t say which app');
  const [packages, digests] = parse(appIdNode.value).children;
  const names = (packages.children ?? []).map((p) => p.children[0].value.toString('utf8'));
  const signedBy = (digests.children ?? []).map((x) => x.value.toString('hex'));
  if (!names.includes(packageName)) throw new Error('not this app');
  if (!signedBy.some((h) => signers.includes(h))) throw new Error('not signed by us');
  // How the phone started, as the secure hardware vouches for it (a key in software, only allowed in tests, has it in software).
  const root = fieldOf(hardware, 704) ?? (minLevel < 1 ? fieldOf(software, 704) : null);
  if (!root) throw new Error('doesn’t say how the phone started');
  const [, locked, bootState] = root.children;
  if (!allowUnlocked && (!locked.value[0] || intOf(bootState) !== 0)) throw new Error('the phone’s bootloader is unlocked or Android isn’t verified');
  const leaf = certs[0];
  if (leaf.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not a P-256 key');
  const publicKey = leaf.publicKey.export({ type: 'spki', format: 'der' });
  if (!sha256(publicKey.subarray(publicKey.length - 65)).equals(Buffer.from(String(keyId), 'base64'))) throw new Error('not this key');
  return { publicKey: publicKey.toString('base64'), environment: 'android' };
}

// Every time after: the app signed "drivezzz-android-1", its counter (4 bytes) and the SHA-256 of clientData, the exact bytes it
// sent. The assertion is that counter and the signature (DER). Returns the new counter.
export function verifyAndroidAssertion({ assertion, clientData, publicKey, counter }) {
  const a = Buffer.from(String(assertion), 'base64');
  if (a.length < 12) throw new Error('signature doesn’t match');
  const signed = Buffer.concat([Buffer.from('drivezzz-android-1'), a.subarray(0, 4), sha256(clientData)]);
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify('sha256', signed, key, a.subarray(4))) throw new Error('signature doesn’t match');
  const n = a.readUInt32BE(0);
  if (n <= counter) throw new Error('used before');
  return n;
}

// Whichever kind the stored key is.
export function checkAssertion(key, { assertion, clientData }) {
  const args = { assertion, clientData, publicKey: key.public_key, counter: key.counter };
  return key.environment === 'android' ? verifyAndroidAssertion(args) : verifyAssertion(args);
}
