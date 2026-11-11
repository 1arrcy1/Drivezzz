// Android's Key Attestation (attest.js), against a real chain: a key the app's own AppAttest.kt made on an Android 16 emulator, for
// the challenge "test-challenge", in the debug build signed with the Mac's key, and one signature made with it
// (reference/android-attestation.json). The emulator's chain ends at Google's test root, not the real one, its key is in software
// (security level 0) and its bootloader is unlocked, so those three are passed in; everything else is checked as for a phone.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyAndroidAssertion, verifyAndroidAttestation } from '../src/attest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'reference', 'android-attestation.json'), 'utf8'));
const top = new crypto.X509Certificate(Buffer.from(fixture.chain.at(-1), 'base64'));
const testRoot = top.publicKey.export({ type: 'spki', format: 'der' });
const when = new Date('2026-11-07T12:00:00Z');
const ok = { keyId: fixture.keyId, chain: fixture.chain, challenge: fixture.challenge, roots: [testRoot], minLevel: 0, allowUnlocked: true, now: when };
const refused = (overrides, message) => assert.throws(() => verifyAndroidAttestation({ ...ok, ...overrides }), { message });

test('an Android key attestation: this app, signed with our key, in secure hardware, for this challenge', () => {
  const out = verifyAndroidAttestation(ok);
  assert.equal(out.environment, 'android');
  // Its signature over what was sent, with counter 1.
  assert.equal(verifyAndroidAssertion({ assertion: fixture.assertion, clientData: Buffer.from(fixture.payload), publicKey: out.publicKey, counter: 0 }), 1);
  // Sent again, or for other bytes: no.
  assert.throws(() => verifyAndroidAssertion({ assertion: fixture.assertion, clientData: Buffer.from(fixture.payload), publicKey: out.publicKey, counter: 1 }), { message: 'used before' });
  assert.throws(() => verifyAndroidAssertion({ assertion: fixture.assertion, clientData: Buffer.from('{"score":0.99}'), publicKey: out.publicKey, counter: 0 }), { message: 'signature doesn’t match' });
});

test('an Android key attestation is turned down for anything that isn’t exactly that', () => {
  // Google's real roots: the emulator's test root isn't one of them.
  refused({ roots: undefined }, 'not certified by Google');
  // A key in software, as an emulator's or a rooted phone's: anything could have made it.
  refused({ minLevel: undefined }, 'not in secure hardware');
  refused({ challenge: 'another-challenge' }, 'not for this challenge');
  refused({ signers: ['00'.repeat(32)] }, 'not signed by us');
  refused({ packageName: 'com.example.copy' }, 'not this app');
  refused({ allowUnlocked: false }, 'the phone’s bootloader is unlocked or Android isn’t verified');
  refused({ keyId: crypto.randomBytes(32).toString('base64') }, 'not this key');
  // Certificates in another order, a chain cut short, or one extended with a certificate of someone's own.
  refused({ chain: [fixture.chain[1], fixture.chain[0], fixture.chain[2]] }, 'the chain is broken');
  refused({ chain: [fixture.chain[0]] }, 'no certificate chain');
  const mine = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => verifyAndroidAttestation({ ...ok, chain: [mine.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), ...fixture.chain] }));
  // Its short-lived certificates (the emulator's are remotely provisioned) count by their dates.
  refused({ now: new Date('2027-06-01T00:00:00Z') }, 'certificate out of date');
});
