// The chip of a passport or ID card (ICAO 9303), checked here rather than on the phone, so a changed app can't say a fake one is real.
// The phone reads the chip by NFC and sends what it read: the document security object (SOD), DG1 (the MRZ: names, birth date,
// expiry) and, for chips that have it, DG15 (the chip's own public key) with its signature over our challenge.
//   Passive authentication: the issuing state signed the hashes of every data group (SOD), with a document signer's key, whose
//     certificate its country signing CA (CSCA) signed. The CSCAs are the German BSI's master list (csca/masterlist.ml).
//   Active authentication: the chip signs a fresh challenge from us with a key that can't be copied off it, so it was really there.
// The BSN, which older Dutch documents have in the MRZ's optional data, is never read out: only the fields below leave this file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { intOf, oidOf, parse, tagged } from './der.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HASHES = {
  '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.4': 'sha224', '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512',
};
// Signature algorithms: null hash means "the signer's digest algorithm". plain: r||s rather than DER (BSI TR-03111).
const SIGNATURES = {
  '1.2.840.113549.1.1.1': { hash: null }, '1.2.840.113549.1.1.5': { hash: 'sha1' }, '1.2.840.113549.1.1.14': { hash: 'sha224' },
  '1.2.840.113549.1.1.11': { hash: 'sha256' }, '1.2.840.113549.1.1.12': { hash: 'sha384' }, '1.2.840.113549.1.1.13': { hash: 'sha512' },
  '1.2.840.113549.1.1.10': { pss: true },
  '1.2.840.10045.2.1': { hash: null }, '1.2.840.10045.4.1': { hash: 'sha1' }, '1.2.840.10045.4.3.1': { hash: 'sha224' },
  '1.2.840.10045.4.3.2': { hash: 'sha256' }, '1.2.840.10045.4.3.3': { hash: 'sha384' }, '1.2.840.10045.4.3.4': { hash: 'sha512' },
  '0.4.0.127.0.7.1.1.4.1.1': { hash: 'sha1', plain: true }, '0.4.0.127.0.7.1.1.4.1.2': { hash: 'sha224', plain: true },
  '0.4.0.127.0.7.1.1.4.1.3': { hash: 'sha256', plain: true }, '0.4.0.127.0.7.1.1.4.1.4': { hash: 'sha384', plain: true },
  '0.4.0.127.0.7.1.1.4.1.5': { hash: 'sha512', plain: true },
};

function verifySignature(algNode, key, data, signature, digest) {
  const oid = oidOf(algNode.children[0]);
  const alg = SIGNATURES[oid];
  if (!alg) throw new Error(`signature algorithm ${oid} not known`);
  if (alg.pss) {
    // RSASSA-PSS-params: [0] hash, [1] mask (MGF1 with the same hash, as everywhere in practice), [2] salt length.
    const params = algNode.children[1];
    const h = params && tagged(params, 0);
    const s = params && tagged(params, 2);
    const hash = h ? HASHES[oidOf(h.children[0].children[0])] : 'sha1';
    return crypto.verify(hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: s ? intOf(s.children[0]) : 20 }, signature);
  }
  return crypto.verify(alg.hash ?? digest, data, { key, dsaEncoding: alg.plain ? 'ieee-p1363' : 'der' }, signature);
}

// The country signing CAs, by subject. Loaded once, when first needed. A newer master list: replace the file (docs/driver-checks-nl.md).
let cscas = null;
function loadCscas(file = process.env.CSCA_MASTER_LIST || path.join(HERE, 'csca', 'masterlist.ml')) {
  const bySubject = new Map();
  const add = (cert) => {
    const list = bySubject.get(cert.subject) ?? [];
    list.push(cert);
    bySubject.set(cert.subject, list);
  };
  let n = 0;
  if (fs.existsSync(file)) {
    const info = parse(fs.readFileSync(file));
    const signed = info.children[1].children[0];
    const list = parse(signed.children[2].children[1].children[0].value);
    for (const c of list.children[1].children) {
      try { add(new crypto.X509Certificate(c.bytes)); n++; } catch { /* a certificate this Node can't read: its documents go to a person */ }
    }
  }
  // Extra CSCAs (PEM files) next to it, such as a newer Dutch one before the next master list.
  for (const f of fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)) : []) {
    if (!f.endsWith('.pem')) continue;
    for (const pem of fs.readFileSync(path.join(path.dirname(file), f), 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
      try { add(new crypto.X509Certificate(pem)); n++; } catch { /* skipped */ }
    }
  }
  return { bySubject, count: n };
}
export function cscaCount() {
  cscas ??= loadCscas();
  return cscas.count;
}
export function setCscaFile(file) { cscas = loadCscas(file); }

function findCsca(ds) {
  cscas ??= loadCscas();
  const t = new Date();
  for (const csca of cscas.bySubject.get(ds.issuer) ?? []) {
    try {
      if (ds.checkIssued(csca) && ds.verify(csca.publicKey) && new Date(csca.validFrom) <= t) return csca;
    } catch { /* a key this Node can't use */ }
  }
  return null;
}

const countryOf = (subject) => /(?:^|\n)C=([A-Z]{2,3})/.exec(subject)?.[1] ?? null;

// Checks the SOD, and that the data groups sent are the ones it signed. Throws for what can't be read; a document that doesn't pass
// comes back with ok false and the reasons, for a person to look at.
export function verifySod(sod, dataGroups) {
  const problems = [];
  let node = parse(sod);
  if (node.cls === 1 && node.tag === 23) node = node.children[0];   // the 0x77 wrapper
  const signed = node.children[1].children[0];
  const [, , encap, ...rest] = signed.children;
  const certs = (tagged(signed, 0)?.children ?? []).map((c) => new crypto.X509Certificate(c.bytes));
  const signerInfo = rest[rest.length - 1].children[0];
  const content = encap.children[1].children[0].value;

  // The hashes the state signed: LDSSecurityObject { version, hashAlgorithm, dataGroupHashValues }.
  const lds = parse(content);
  const hash = HASHES[oidOf(lds.children[1].children[0])];
  if (!hash) throw new Error('hash algorithm not known');
  const signedHashes = new Map(lds.children[2].children.map((e) => [intOf(e.children[0]), e.children[1].value]));
  for (const [n, bytes] of Object.entries(dataGroups)) {
    if (!bytes) continue;
    const expected = signedHashes.get(Number(n));
    if (!expected) problems.push(`DG${n} isn't in the signed list`);
    else if (!crypto.createHash(hash).update(bytes).digest().equals(expected)) problems.push(`DG${n} isn't what the state signed`);
  }

  // The signer: SignerInfo { version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature }.
  const parts = signerInfo.children;
  const digest = HASHES[oidOf(parts[2].children[0])];
  let k = 3;
  let signedBytes = content;
  if (parts[k].cls === 2 && parts[k].tag === 0) {
    const attrs = parts[k];
    signedBytes = Buffer.from(attrs.bytes);
    signedBytes[0] = 0x31;   // signed as a SET
    const md = attrs.children.find((a) => oidOf(a.children[0]) === '1.2.840.113549.1.9.4');
    if (!md || !crypto.createHash(digest).update(content).digest().equals(md.children[1].children[0].value)) problems.push('the signed digest doesn’t match');
    k++;
  }
  const ds = certs[0];
  let csca = null;
  if (!ds) problems.push('no document signer certificate');
  else {
    if (!verifySignature(parts[k], ds.publicKey, signedBytes, parts[k + 1].value, digest)) problems.push('the state’s signature doesn’t match');
    csca = findCsca(ds);
    if (!csca) problems.push(`no trusted country certificate for ${countryOf(ds.issuer) ?? 'this document'}`);
  }
  return { ok: problems.length === 0, problems, country: ds ? countryOf(ds.issuer) : null, signer: ds?.subject ?? null, hash, signedGroups: [...signedHashes.keys()] };
}

// ---------- the MRZ, from DG1 ----------

const VALUE = (c) => (c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
const checkDigit = (s) => String([...s].reduce((sum, c, i) => sum + VALUE(c) * [7, 3, 1][i % 3], 0) % 10);
const clean = (s) => s.replace(/<+$/g, '').replace(/</g, ' ').trim();

function dateOf(yymmdd, future) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const thisYear = new Date().getUTCFullYear() % 100;
  // A birth date is in the past; an expiry date is this century.
  const century = future ? 2000 : yy > thisYear ? 1900 : 2000;
  return `${century + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

function namesOf(field) {
  const [surname, ...given] = field.split('<<');
  return { surname: clean(surname), givenNames: clean(given.join(' ')) };
}

// TD1 (ID cards, 3 lines of 30), TD2 (2 of 36) and TD3 (passports, 2 of 44). The optional data fields are left out on purpose.
export function readMrz(mrz) {
  let f;
  if (mrz.length === 90) {
    const [a, b, c] = [mrz.slice(0, 30), mrz.slice(30, 60), mrz.slice(60, 90)];
    let number = a.slice(5, 14), numberCheck = a[14];
    // A number longer than 9 goes on into the optional data, ending in its check digit.
    if (numberCheck === '<') {
      const more = a.slice(15, 30).split('<')[0];
      number += more.slice(0, -1);
      numberCheck = more.slice(-1);
    }
    f = { type: a.slice(0, 2), country: a.slice(2, 5), number, numberCheck, birth: b.slice(0, 6), birthCheck: b[6], sex: b[7], expiry: b.slice(8, 14), expiryCheck: b[14], nationality: b.slice(15, 18), ...namesOf(c) };
  } else if (mrz.length === 88 || mrz.length === 72) {
    const w = mrz.length / 2;
    const [a, b] = [mrz.slice(0, w), mrz.slice(w)];
    f = { type: a.slice(0, 2), country: a.slice(2, 5), ...namesOf(a.slice(5)), number: b.slice(0, 9), numberCheck: b[9], nationality: b.slice(10, 13), birth: b.slice(13, 19), birthCheck: b[19], sex: b[20], expiry: b.slice(21, 27), expiryCheck: b[27] };
  } else {
    throw new Error('MRZ of an unknown size');
  }
  const checksOk = checkDigit(f.number) === f.numberCheck && checkDigit(f.birth) === f.birthCheck && checkDigit(f.expiry) === f.expiryCheck;
  return {
    docType: clean(f.type),
    country: clean(f.country),
    number: clean(f.number).replace(/ /g, ''),
    surname: f.surname,
    givenNames: f.givenNames,
    nationality: clean(f.nationality),
    birthDate: dateOf(f.birth, false),
    sex: f.sex === '<' ? null : f.sex,
    expires: dateOf(f.expiry, true),
    checksOk,
  };
}

export function readDg1(dg1) {
  const node = parse(dg1);   // 0x61
  const mrz = node.children?.find((c) => c.cls === 1 && c.tag === 31);   // 0x5F1F
  if (!mrz) throw new Error('DG1 without an MRZ');
  return readMrz(mrz.value.toString('latin1'));
}

// ---------- active authentication ----------

const ISO_HASH = { 0x33: 'sha1', 0x34: 'sha256', 0x35: 'sha512', 0x36: 'sha384', 0x38: 'sha224' };
const HASH_BYTES = { sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64 };

// DG15 holds the chip's public key. RSA chips sign as ISO/IEC 9796-2 scheme 1; EC chips sign the challenge as plain r||s.
export function verifyActiveAuth(dg15, challenge, signature) {
  let node = parse(dg15);
  if (node.cls === 1 && node.tag === 15) node = node.children[0];   // the 0x6F wrapper
  const key = crypto.createPublicKey({ key: Buffer.from(node.bytes), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType === 'rsa') {
    const m = crypto.publicDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, signature);
    if ((m[0] & 0xf0) !== 0x60) return false;
    let hash, trailer;
    if (m[m.length - 1] === 0xbc) { hash = 'sha1'; trailer = 1; } else if (m[m.length - 1] === 0xcc) { hash = ISO_HASH[m[m.length - 2]]; trailer = 2; }
    if (!hash) return false;
    const h = HASH_BYTES[hash];
    const recovered = m.subarray(1, m.length - trailer - h);
    const digest = m.subarray(m.length - trailer - h, m.length - trailer);
    return crypto.createHash(hash).update(recovered).update(challenge).digest().equals(digest);
  }
  for (const hash of ['sha256', 'sha384', 'sha512', 'sha224', 'sha1']) {
    for (const dsaEncoding of ['ieee-p1363', 'der']) {
      try { if (crypto.verify(hash, challenge, { key, dsaEncoding }, signature)) return true; } catch { /* the other encoding */ }
    }
  }
  return false;
}
