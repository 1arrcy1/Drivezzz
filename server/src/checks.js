// Driving a taxi in the Netherlands: what a driver hands in before a car can go online there, and what's checked by itself
// (docs/driver-checks-nl.md). Pieter's decisions, 5 November 2026: the Netherlands only at launch; a car needs it, a motor or
// scooter doesn't (the taxi law only covers cars); approved by itself when everything checks out, a person otherwise; the photos
// of documents go 30 days after the decision.
//   Who they are: their passport or ID card's chip, read by NFC on the phone and checked here (chip.js): signed by the issuing
//     state, and with chips that can, signing our challenge (so it was there, not a copy of its data).
//   That it's them: a selfie with a turn of the head, matched with the chip's photo on the phone (the face never leaves it). The
//     result counts by itself only when App Attest (attest.js) shows it came from the real app.
//   Chauffeurskaart and taxi permit: scanned and read on the phone, signed with App Attest, and compared here: the name on them,
//     the number and date against what the scan read, how far off the date is, and whether another account has the same one.
//     Kiwa has no register to ask, so a good fake or a withdrawn card still passes (docs/driver-checks-nl.md).
//   KvK: KvK's API: it exists, hasn't ended, does taxi work, and its name is on the permit. Asked again every 30 days, as the
//     permit ends with the registration.
//   The car: the RDW's open register: a passenger car, registered as a taxi, insured, APK valid, not exported. The RDW only
//     registers a taxi for a business with a KvK taxi registration and a Kiwa permit, which makes this the permit's best proof.
//     The plate must be on the car's back photo, as anyone can type a plate they saw.
// What can't be confirmed automatically waits for a person. Nothing is ever declined by itself (GDPR article 22, the Platform
// Work Directive).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, DATA_DIR, get, getMeta, now, run, setMeta, uid } from './db.js';
import { config, rules } from './config.js';
import { ApiError, clientIp, limit, route, text } from './http.js';
import { requireUser } from './auth.js';
import { inNetherlands, validPoint } from './geo.js';
import { lookupRegister, plateInText, prettyPlate } from './rdw.js';
import { readDg1, verifyActiveAuth, verifySod } from './chip.js';
import { checkAssertion, refreshRevocations, verifyAndroidAttestation, verifyAttestation } from './attest.js';
import { notify } from './push.js';
import { bump } from './sync.js';
import { isDriving, setOffline } from './drivers.js';
import { banFollowsPerson } from './standing.js';

export const CHECK_DIR = path.join(DATA_DIR, 'checks');
fs.mkdirSync(CHECK_DIR, { recursive: true, mode: 0o700 });
// What the driver agreed to. A new version of the consent text: raise it, and drivers are asked again.
export const CONSENT_VERSION = 1;
const ITEMS = ['consent', 'id', 'face', 'chauffeurskaart', 'permit', 'kvk'];
const NAMES = { consent: 'Consent', id: 'Your ID', face: 'Your face', chauffeurskaart: 'Chauffeurskaart', permit: 'Taxi permit', kvk: 'KvK number' };

export const checkRow = (userId) => get('SELECT * FROM driver_checks WHERE user_id = ?', userId);
function save(userId, fields) {
  const t = now();
  if (!checkRow(userId)) run('INSERT INTO driver_checks (user_id, created_at, updated_at) VALUES (?, ?, ?)', userId, t, t);
  const keys = Object.keys(fields);
  run(`UPDATE driver_checks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`, ...keys.map((k) => fields[k]), t, userId);
}
const today = () => new Date(now()).toISOString().slice(0, 10);
const plusDays = (iso, days) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

// A keyed hash of a document number, to see the same ID on two accounts without keeping the number.
function docHash(country, number) {
  let secret = getMeta('checks_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setMeta('checks_secret', secret); }
  return crypto.createHmac('sha256', secret).update(`${country}|${number}`).digest('hex');
}

// Who someone is, from their ID's chip: a keyed hash of their name and date of birth, the same on a new phone, a new account or a
// renewed ID. A ban follows the person with it (standing.js, Pieter's request of 6 November 2026). Pretend passes have none.
const personHash = (surname, givenNames, birthDate) => (surname && birthDate ? docHash('person', `${plain(surname)}|${plain(givenNames)}|${birthDate}`) : null);

// Letters only, without accents or case, to look for a name in text read from a card.
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
const letterDigits = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function nameOnCard(c, cardText) {
  if (!c.surname || !cardText) return false;
  // "DE BRUIJN" is often "Bruijn" on a card, so the longest part of the surname is enough.
  const part = c.surname.split(/[\s-]+/).sort((a, b) => b.length - a.length)[0];
  return plain(part).length >= 2 && plain(cardText).includes(plain(part));
}
// Words any taxi business can have in its name, which say nothing about which one it is.
const COMMON_WORDS = new Set(['TAXI', 'TAXIS', 'TAXIBEDRIJF', 'TAXICENTRALE', 'TAXIVERVOER', 'TAXISERVICE', 'VERVOER', 'PERSONENVERVOER', 'BEDRIJF', 'SERVICE', 'SERVICES', 'HOLDING', 'GROEP', 'BEHEER', 'THE', 'HET', 'VAN', 'DEN', 'DER', 'VOF', 'NV']);
function nameOnPermit(names, cardText) {
  const read = plain(cardText);
  return names.some((name) => {
    const whole = plain(name);
    if (whole.length >= 3 && read.includes(whole)) return true;
    const part = String(name).split(/[\s.,&'’/-]+/).map(plain).filter((w) => w.length >= 3 && !COMMON_WORDS.has(w)).sort((a, b) => b.length - a.length)[0];
    return Boolean(part) && read.includes(part);
  });
}
const kvkNames = (c) => { try { return JSON.parse(c.kvk_names ?? '[]'); } catch { return []; } };
// A date typed in, in the ways a card can print it.
function dateOnCard(iso, cardText) {
  const [y, m, d] = String(iso).split('-');
  const read = letterDigits(cardText);
  return [`${d}${m}${y}`, `${y}${m}${d}`, `${d}${m}${y.slice(2)}`].some((v) => read.includes(v));
}
const age = (birth) => {
  if (!birth) return null;
  const [y, m, d] = birth.split('-').map(Number);
  const t = new Date(now());
  return t.getUTCFullYear() - y - (t.getUTCMonth() + 1 < m || (t.getUTCMonth() + 1 === m && t.getUTCDate() < d) ? 1 : 0);
};

// What the scan of a chauffeurskaart or permit doesn't confirm by itself, in words for the admin panel.
const SCANS = {
  ck: { name: 'chauffeurskaart', words: /CHAUFFEUR|BESTUURDER|TAXI/ },
  permit: { name: 'taxi permit', words: /VERGUNNING|TAXI/ },
};
function scanProblems(c, p) {
  const { name, words } = SCANS[p];
  const read = c[`${p}_text`], number = c[`${p}_number`], expires = c[`${p}_expires`];
  const r = [];
  if (!c[`${p}_attested`]) r.push(`The ${name} wasn’t signed by the real app (App Attest)`);
  if (!c[`${p}_camera`]) r.push(`The ${name} came from the photo library, not the camera`);
  if (!words.test(plain(read))) r.push(`The ${name}’s scan doesn’t say what it is`);
  if (!letterDigits(read).includes(letterDigits(number))) r.push(`The ${name}’s number isn’t what the scan read`);
  if (expires && !dateOnCard(expires, read)) r.push(`The ${name}’s date isn’t what the scan read`);
  if (p === 'ck') {
    if (!expires) r.push('No expiry date on the chauffeurskaart');
    else if (expires > plusDays(today(), Math.ceil(rules.cardYears * 365.25))) r.push(`The chauffeurskaart says ${expires}: a card lasts ${rules.cardYears} years`);
    if (!nameOnCard(c, read)) r.push('The ID’s surname isn’t on the chauffeurskaart');
  } else {
    const names = kvkNames(c);
    if (names.length && !nameOnPermit(names, read)) r.push(`KvK’s name (${names[0]}) isn’t on the taxi permit`);
  }
  return r;
}
function kvkProblems(c) {
  const r = [];
  if (c.kvk_found == null) r.push('KvK couldn’t be asked: look the number up by hand');
  if (c.kvk_found === 0) r.push('KvK number not found');
  if (c.kvk_active === 0) r.push('KvK registration has ended');
  if (c.kvk_taxi === 0) r.push('KvK doesn’t list taxi transport (SBI 49.32)');
  return r;
}

// Per item: missing, expired, waiting (in, but a person must look) or done.
function itemsOf(c) {
  const t = today();
  const out = Object.fromEntries(ITEMS.map((k) => [k, 'missing']));
  if (!c) return out;
  if (c.consent_version >= CONSENT_VERSION) out.consent = 'done';
  if (c.chip_at) out.id = c.doc_expires && c.doc_expires < t ? 'expired' : c.chip_signed && c.chip_live !== 0 ? 'done' : 'waiting';
  if (c.face_at) out.face = !c.face_by_person && c.face_live && c.face_attested && c.face_score >= rules.faceAutoMatch ? 'done' : 'waiting';
  if (c.ck_at) out.chauffeurskaart = c.ck_expires && c.ck_expires < t ? 'expired' : scanProblems(c, 'ck').length ? 'waiting' : 'done';
  if (c.permit_at) out.permit = c.permit_expires && c.permit_expires < t ? 'expired' : scanProblems(c, 'permit').length ? 'waiting' : 'done';
  if (c.kvk_number) out.kvk = kvkProblems(c).length ? 'waiting' : 'done';
  return out;
}

// Why a person has to look, in words for the admin panel. Empty: it passes by itself.
function reasonsOf(c) {
  const r = [];
  if (!c.chip_signed) r.push(`ID chip not confirmed${c.chip_problems ? `: ${c.chip_problems}` : ''}`);
  if (c.chip_live === 0) r.push('The chip didn’t sign our challenge (possibly a copy)');
  const years = age(c.birth_date);
  if (years != null && years < 18) r.push(`Under 18 (${years})`);
  if (c.face_by_person) r.push('Asked for a person to compare the face');
  else {
    if (!c.face_live) r.push('No turn of the head seen');
    if (!c.face_attested) r.push('Face match not signed by the real app (App Attest)');
    if (!(c.face_score >= rules.faceAutoMatch)) r.push(`Face match ${Math.round((c.face_score ?? 0) * 100)}, below ${Math.round(rules.faceAutoMatch * 100)}`);
  }
  r.push(...scanProblems(c, 'ck'), ...scanProblems(c, 'permit'), ...kvkProblems(c));
  const sameCard = c.ck_number && get('SELECT user_id FROM driver_checks WHERE ck_number = ? AND user_id != ?', c.ck_number, c.user_id);
  if (sameCard) r.push(`The same chauffeurskaart is on account ${sameCard.user_id}`);
  // Drivers of one taxi company share a permit, and with it a KvK number.
  const samePermit = c.permit_number && get('SELECT user_id FROM driver_checks WHERE permit_number = ? AND user_id != ? AND kvk_number IS NOT ?', c.permit_number, c.user_id, c.kvk_number);
  if (samePermit) r.push(`The same permit is on account ${samePermit.user_id}, with another KvK number`);
  const plate = plateReason(c.user_id);
  if (plate) r.push(plate);
  const twin = c.doc_hash && get(`SELECT user_id FROM driver_checks WHERE doc_hash = ? AND user_id != ? AND status = 'approved'`, c.doc_hash, c.user_id);
  if (twin) r.push(`The same ID is approved on account ${twin.user_id}`);
  return r;
}

// What the driver hears about what's still open: only that it's waiting for review (Pieter, 8 November 2026: "only give info as in
// waiting for review or please scan this document again"). Never why: the reasons are for the panel (reasonsOf), and the driver
// can't do anything with them. Nothing is asked for again by itself, only by a person after review (the panel's "Ask again for…",
// `again` with their note): what the phone reads from a real card misses its words, number or date too often to tell a bad photo
// from a good one, and a good one was asked for again right after it was sent (Pieter: "only after review").
const REVIEW_LINES = {
  id: 'Your ID is waiting for review.',
  face: 'Your selfie is waiting for review.',
  chauffeurskaart: 'Your chauffeurskaart is waiting for review.',
  permit: 'Your taxi permit is waiting for review.',
  kvk: 'Your KvK number is waiting for review.',
};
// One line per thing a person has to look at, in the order of the app's rows, from the moment it's sent (a person gets it once
// everything is in, and the app's footer says so). The car's plate only once everything is in: until then its back photo may not
// have been read yet, which isn't waiting for anyone.
function openLinesOf(c) {
  const items = itemsOf(c);
  const r = Object.keys(REVIEW_LINES).filter((k) => items[k] === 'waiting').map((k) => REVIEW_LINES[k]);
  if (c.status === 'review' && plateReason(c.user_id)) r.push('Your car’s number plate is waiting for review.');
  return r;
}

// After anything new: everything in and nothing to look at is approved by itself; anything to look at waits for a person.
// A person's yes or no stands until the driver sends something new.
function evaluate(userId) {
  const c = checkRow(userId);
  if (!c) return;
  const was = c.status;
  const items = itemsOf(c);
  const allIn = ITEMS.every((k) => items[k] === 'done' || items[k] === 'waiting');
  const t = now();
  if (!allIn) save(userId, { status: 'started', review_reasons: null, auto: null });
  else {
    const reasons = reasonsOf(c);
    if (reasons.length) {
      save(userId, { status: 'review', review_reasons: JSON.stringify(reasons), submitted_at: t, decided_at: null, decided_by: null, auto: null, decision_note: null, asked_again: null });
      // Everything's in and goes to a person: the driver hears so.
      if (was !== 'review') notify(userId, 'A person checks your documents', 'Usually within a day. You’ll hear when it’s done.');
    } else {
      save(userId, { status: 'approved', review_reasons: null, submitted_at: t, decided_at: t, decided_by: 'auto', auto: 1, decision_note: null, asked_again: null, files_delete_after: t + rules.checksFilesKept });
      if (was !== 'approved') notify(userId, 'You can drive in the Netherlands', 'Your ID, chauffeurskaart and permit checked out.');
    }
  }
  refreshVerified(userId);
}

// A car changed while a person hasn't decided yet: look again. What a person or the checks approved stays; a car that needs a
// look waits by itself (vehicleCheck), without taking the driver's other car off the road.
export function carChanged(userId) {
  if (['review', 'started'].includes(checkRow(userId)?.status)) evaluate(userId);
}

// "Verified" for riders: approved and nothing has run out.
export function refreshVerified(userId) {
  const c = checkRow(userId);
  const items = itemsOf(c);
  const ok = c?.status === 'approved' && !ITEMS.some((k) => items[k] === 'expired' || items[k] === 'missing');
  const d = get('SELECT verified_at FROM drivers WHERE user_id = ?', userId);
  if (!d) return ok;
  if (ok && !d.verified_at) run('UPDATE drivers SET verified_at = ? WHERE user_id = ?', now(), userId);
  if (!ok && d.verified_at) {
    run('UPDATE drivers SET verified_at = NULL WHERE user_id = ?', userId);
    // No blue check, no taxi: off the road with a car, after the drive they're on. A motor or scooter carries on.
    const online = get(`SELECT d.online_since, d.lat, d.lng, c.vehicle, u.is_demo FROM drivers d JOIN users u ON u.id = d.user_id
                        LEFT JOIN cars c ON c.id = d.active_car_id WHERE d.user_id = ? AND d.online_since IS NOT NULL`, userId);
    if (online && !showsToRiders({ ...online, verified_at: null }) && !isDriving(userId)) {
      setOffline(userId);
      notify(userId, 'You’re offline', 'Your blue check is gone. Open Driving in the Netherlands to see what’s needed.');
    }
  }
  if (Boolean(d.verified_at) !== ok) bump(userId);
  return ok;
}

// ---------- the car, from the RDW ----------

const PROBLEMS = {
  not_registered: 'This plate isn’t in the RDW’s register.',
  not_a_car: 'In the Netherlands only a passenger car can drive taxi rides.',
  not_taxi: 'This car isn’t registered as a taxi at the RDW (blue plates).',
  not_insured: 'The RDW has no insurance for this car.',
  apk: 'This car’s APK has run out.',
  exported: 'The RDW says this car was exported.',
  plate: 'A person is checking this car’s number plate. That’s usually done within 24 hours.',
  rdw_down: 'The RDW’s register can’t be reached right now. Try again in a moment.',
};
// What the RDW and the back photo say about a car, from what's stored: the first is what stops it most.
function problemsOf(row) {
  const problems = [];
  // The test server's pretend plates aren't in the register, nor are the live server's pretend drivers' (their pretend pass
  // covers the car); a real plate is still checked for real.
  const pretendPlate = config.checks.fake || (config.checks.fakeLocal && row.plate_ok_by === 'fake');
  if (!row.rdw_found) { if (!pretendPlate) problems.push('not_registered'); }
  else {
    if (row.rdw_kind && row.rdw_kind !== 'Personenauto') problems.push('not_a_car');
    if (!row.rdw_taxi) problems.push('not_taxi');
    if (!row.rdw_insured) problems.push('not_insured');
    if (!row.rdw_apk_until || row.rdw_apk_until < today()) problems.push('apk');
    if (row.rdw_exported) problems.push('exported');
    if (plateUnseen(row)) problems.push('plate');
  }
  return problems;
}
// Why a car of the driver's can't drive in the Netherlands yet, for their vehicle page (ownDriver in drivers.js). From what's
// stored, without asking the RDW; null when nothing's known against it. `review`: only a person looking is left (Pieter,
// 8 November 2026: say so plainly, instead of sending the driver through the checks again).
export function carHold(user, car) {
  if (!config.checks.required || user.is_demo || !car || (car.vehicle || 'car') !== 'car') return null;
  const codes = car.rdw_checked_at ? problemsOf(car) : plateUnseen(car) ? ['plate'] : [];
  return codes.length ? { code: codes[0], text: PROBLEMS[codes[0]], review: codes[0] === 'plate' } : null;
}
// The driver's car in use, when its plate wasn't read from its back photo and nobody looked instead.
const plateUnseen = (car) => Boolean(car) && (car.vehicle || 'car') === 'car' && car.plate_seen !== 1 && !car.plate_ok_by;
export function plateReason(userId) {
  const car = get('SELECT c.* FROM cars c JOIN drivers d ON d.active_car_id = c.id WHERE d.user_id = ? AND c.deleted_at IS NULL', userId);
  return plateUnseen(car) ? `Plate ${prettyPlate(car.plate)} wasn’t read from the car’s back photo by the real app` : null;
}
// Who waits for a person: for admin.js, with driver_checks as c.
export const CHECK_WAITS = `(c.status = 'review' OR (c.status = 'approved' AND EXISTS (SELECT 1 FROM cars a JOIN drivers d ON d.active_car_id = a.id
  WHERE d.user_id = c.user_id AND a.deleted_at IS NULL AND COALESCE(a.vehicle, 'car') = 'car' AND COALESCE(a.plate_seen, 0) != 1 AND a.plate_ok_by IS NULL)))`;

// The text the phone read from a car's back photo. Only the real app counts, or a typed plate would do.
export function backPhotoRead(ctx, user, car) {
  slowDown(ctx, user, 'plate');
  const read = ctx.query.get('read') ?? '';
  const signed = signedByApp(ctx, user.id, ['drivezzz-plate-1', car.id, sha256(read)]);
  run('UPDATE cars SET plate_seen = ? WHERE id = ?', signed && plateInText(car.plate, read) ? 1 : 0, car.id);
  carChanged(user.id);
}

export async function vehicleCheck(car) {
  if (!car) return { problems: [] };
  let row = car;
  if (!row.rdw_checked_at || now() - row.rdw_checked_at > rules.rdwFresh) {
    const answer = await lookupRegister(row.plate);
    if (answer.reached) {
      const r = answer.found?.register;
      run('UPDATE cars SET rdw_found = ?, rdw_taxi = ?, rdw_insured = ?, rdw_apk_until = ?, rdw_kind = ?, rdw_exported = ?, rdw_checked_at = ? WHERE id = ?',
        answer.found ? 1 : 0, r?.taxi ? 1 : 0, r?.insured ? 1 : 0, r?.apkUntil ?? null, r?.kind ?? null, r?.exported ? 1 : 0, now(), row.id);
      row = get('SELECT * FROM cars WHERE id = ?', row.id);
    } else if (!row.rdw_checked_at || now() - row.rdw_checked_at > 7 * rules.rdwFresh) {
      return { plate: row.plate, problems: [{ code: 'rdw_down', text: PROBLEMS.rdw_down }] };
    }
  }
  const problems = problemsOf(row);
  return { plate: row.plate, found: Boolean(row.rdw_found), taxi: Boolean(row.rdw_taxi), insured: Boolean(row.rdw_insured), apkUntil: row.rdw_apk_until, kind: row.rdw_kind, exported: Boolean(row.rdw_exported), problems: problems.map((code) => ({ code, text: PROBLEMS[code] })) };
}

// ---------- what going online and taking a ride ask ----------

// Whether a driver may drive here with this vehicle. null: yes. Otherwise what's missing, for the error and the app's wizard.
export async function checksNeeded(user, car, point) {
  if (!config.checks.required || user.is_demo) return null;
  if (!car || (car.vehicle || 'car') !== 'car') return null;
  if (point && !inNetherlands(point.lat, point.lng)) return null;
  const c = checkRow(user.id);
  const items = itemsOf(c);
  const approved = c?.status === 'approved';
  const missing = ITEMS.filter((k) => items[k] === 'missing' || items[k] === 'expired' || (items[k] === 'waiting' && !approved));
  const vehicle = await vehicleCheck(car);
  if (approved && !missing.length && !vehicle.problems.length) return null;
  const waiting = c?.status === 'review' && ITEMS.every((k) => items[k] === 'done' || items[k] === 'waiting');
  // Everything's in and only a person looking is left: the plate of this car, the documents, or both. The driver can't do anything
  // about it in the checks, so the app says so plainly instead of opening them again (Pieter, 8 November 2026).
  const plateOnly = vehicle.problems.length > 0 && vehicle.problems.every((p) => p.code === 'plate');
  const held = (approved && !missing.length && plateOnly) || (waiting && (plateOnly || !vehicle.problems.length))
    ? { documents: waiting, plate: plateOnly ? prettyPlate(car.plate) : null, carId: car.id } : null;
  const carName = `your ${[car.make, car.model].filter(Boolean).join(' ') || 'car'}`;
  const later = 'That’s usually done within 24 hours, and you’ll hear when it is.';
  let message;
  if (held?.plate && !held.documents) message = `A person is checking the number plate ${held.plate} of ${carName}. ${later} Until then you can drive another vehicle that’s cleared, or take the back photo again: both on My page.`;
  else if (held?.plate) message = `A person is checking your documents and the number plate ${held.plate} of ${carName}. ${later}`;
  else if (held) message = `A person is checking your documents. ${later}`;
  else if (vehicle.problems.length && (approved || waiting)) message = vehicle.problems[0].text;
  else if (c?.status === 'declined') message = `Your check wasn’t approved${c.decision_note ? `: ${c.decision_note}` : '.'} Open Driving in the Netherlands to send it again.`;
  else message = `Before you drive in the Netherlands: ${missing.filter((k) => k !== 'consent').map((k) => NAMES[k].toLowerCase()).join(', ') || 'a few checks'}. It takes about 10 minutes.`;
  return { message, missing, waiting, held, status: c?.status ?? 'none', vehicle };
}

// The error for what checksNeeded found. Only a person's look left is `checks_review`, which the app shows as it is (an app from
// before shows its message, rather than the checks); anything the driver must do is `need_checks`, which opens the checks.
export function checksError(need) {
  if (need.held) return new ApiError(409, 'checks_review', need.message, { missing: need.missing, documents: need.held.documents ? 1 : 0, plate: need.held.plate ? 1 : 0 });
  return new ApiError(409, 'need_checks', need.message, { missing: need.missing, waiting: need.waiting });
}

// Riders only get a car with a blue check, unless it's a motor or scooter (Pieter's decision, 5 November 2026). checksNeeded stops
// the unverified from going online, and this is the last word for everyone riders get: whoever was online before, and planned
// drives, which go to drivers who may be offline. `lat` and `lng`: where it counts, as in checksNeeded.
export function showsToRiders({ verified_at, vehicle, is_demo, lat, lng }) {
  if (!config.checks.required || is_demo || verified_at || (vehicle || 'car') !== 'car') return true;
  return !inNetherlands(lat, lng);
}

// Only in the Netherlands for now. Demo accounts (App Review) can be anywhere.
export function requireNetherlands(user, lat, lng, what) {
  if (!config.checks.onlyNetherlands || user.is_demo || !validPoint(lat, lng)) return;
  if (!inNetherlands(lat, lng)) throw new ApiError(409, 'not_here', what === 'drive' ? 'Drivezzz is only in the Netherlands for now: you can go online once you’re there.' : 'Drivezzz is only in the Netherlands for now: the pickup has to be there.');
}

// ---------- what the driver sees ----------

// What's still open, in the driver's words: while it's being decided, and not while a person asked for something again (they've
// looked at the rest, and the app says what to send instead, with their note). After a decline the note says it all.
const againOf = (c) => (c?.status === 'started' ? c.asked_again ?? null : null);
const openOf = (c) => (c && ['started', 'review'].includes(c.status) && !againOf(c) ? openLinesOf(c) : []);

// A row that's done is locked in the app (Pieter, 8 November 2026: nothing to send over what checked out), except what runs out
// within the warning time, so the new one can be sent before the old one ends.
function renewable(c) {
  if (!c) return [];
  const soon = plusDays(today(), rules.checksWarnBefore / 86_400_000);
  return [['id', c.doc_expires], ['chauffeurskaart', c.ck_expires], ['permit', c.permit_expires]].filter(([, d]) => d && d <= soon).map(([k]) => k);
}

// For the driver's own data (ownDriver in drivers.js): enough to say what needs attention outside the checks, and for a phone
// without push to notice a change and say it. `open` would count what the driver must do: nothing is asked for again by itself
// (what a person asks for is `again`), and what waits for review needs nothing from them, so it's 0, for the apps that read it.
export function checksSummary(userId) {
  const c = checkRow(userId);
  if (!c) return null;
  return { status: c.status, open: 0, again: againOf(c) };
}

export function publicChecks(user) {
  const c = checkRow(user.id);
  const items = itemsOf(c);
  const cars = all('SELECT * FROM cars WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at', user.id);
  const again = againOf(c);
  return {
    status: c?.status ?? 'none',
    verified: Boolean(get('SELECT verified_at FROM drivers WHERE user_id = ?', user.id)?.verified_at),
    // Once approved, by itself or by a person, what a person had to look at is done too: the app shows every row as done.
    items: c?.status === 'approved' ? Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v === 'waiting' ? 'done' : v])) : items,
    // Until then, what's waiting for review, for the driver to read.
    open: openOf(c),
    // Done rows that may be sent again all the same, as they run out soon: id, chauffeurskaart, permit.
    renew: renewable(c),
    consentVersion: CONSENT_VERSION,
    faceByPerson: Boolean(c?.face_by_person),
    id: c?.chip_at ? { surname: c.surname, givenNames: c.given_names, birthDate: c.birth_date, expires: c.doc_expires, docType: c.doc_type, country: c.doc_country, numberEnd: c.doc_last4 } : null,
    chauffeurskaart: c?.ck_at ? { number: c.ck_number, expires: c.ck_expires } : null,
    permit: c?.permit_at ? { number: c.permit_number, expires: c.permit_expires } : null,
    kvk: c?.kvk_number ? { number: c.kvk_number, name: c.kvk_name, found: c.kvk_found == null ? null : Boolean(c.kvk_found) } : null,
    note: c?.status === 'declined' || again ? c.decision_note ?? null : null,
    // What a person asked to have sent again (the panel's "Ask again for…"): id, face, chauffeurskaart, permit or kvk. Until it's
    // all in once more, the app says so, with the note, instead of the first-time card.
    again,
    vehicles: cars.filter((x) => (x.vehicle || 'car') === 'car').map((x) => ({
      id: x.id, plate: x.plate, checkedAt: x.rdw_checked_at ?? null, found: x.rdw_found == null ? null : Boolean(x.rdw_found),
      taxi: Boolean(x.rdw_taxi), insured: Boolean(x.rdw_insured), apkUntil: x.rdw_apk_until ?? null, exported: Boolean(x.rdw_exported),
      plateSeen: !plateUnseen(x), platePretty: prettyPlate(x.plate),
    })),
    fake: config.checks.fake,
  };
}

// ---------- the steps ----------

function requireDriverRow(ctx) {
  const user = requireUser(ctx);
  if (!get('SELECT 1 AS x FROM drivers WHERE user_id = ?', user.id)) throw new ApiError(403, 'not_driver', 'Turn on driving in Profile first.');
  return user;
}

route('GET', '/api/checks', async (ctx) => {
  const user = requireDriverRow(ctx);
  // The active car's register, fresh, so the wizard shows what going online would say.
  const d = get('SELECT active_car_id FROM drivers WHERE user_id = ?', user.id);
  const car = d?.active_car_id && get('SELECT * FROM cars WHERE id = ? AND deleted_at IS NULL', d.active_car_id);
  if (car && (car.vehicle || 'car') === 'car') await vehicleCheck(car);
  return { checks: publicChecks(user) };
});

// No more than a driver needs (Pieter, 7 November 2026: nobody should be able to send thousands of these from a script): per hour,
// per person and per address. A driver sends each a few times at most, retries included. Off in DEV, as all limits are.
const HOURLY = { consent: 20, challenge: 60, chip: 20, face: 20, photo: 10, document: 30, kvk: 20, plate: 30, attest: 20 };
function slowDown(ctx, user, kind) {
  const max = HOURLY[kind];
  if (!limit(`checks:${kind}:${user.id}`, max, 3600_000) || !limit(`checks:${kind}:${clientIp(ctx.req)}`, max * 3, 3600_000)) {
    throw new ApiError(429, 'too_many', 'That’s been sent too often. Wait an hour, then try again.');
  }
}

route('POST', '/api/checks/consent', (ctx) => {
  const user = requireDriverRow(ctx);
  slowDown(ctx, user, 'consent');
  if (Number(ctx.body.version) !== CONSENT_VERSION) throw new ApiError(409, 'old_consent', 'Update Drivezzz first.');
  save(user.id, { consent_at: now(), consent_version: CONSENT_VERSION, face_by_person: ctx.body.faceByPerson ? 1 : 0 });
  evaluate(user.id);
  return { checks: publicChecks(user) };
});

// One-time challenges: for the chip to sign, and the turns of the head the selfie must show. Kept in memory for 10 minutes.
const challenges = new Map();
const CHALLENGE_TTL = 10 * 60_000;
function takeChallenge(userId, id) {
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.userId !== userId || now() - c.at > CHALLENGE_TTL) throw new ApiError(409, 'old_challenge', 'That took too long. Start the check again.');
  return c;
}
route('POST', '/api/checks/challenge', (ctx) => {
  const user = requireDriverRow(ctx);
  slowDown(ctx, user, 'challenge');
  for (const [k, v] of challenges) if (now() - v.at > CHALLENGE_TTL) challenges.delete(k);
  const id = uid('chl_');
  const steps = crypto.randomInt(2) ? ['left', 'right'] : ['right', 'left'];
  challenges.set(id, { userId: user.id, at: now(), nonce: crypto.randomBytes(8), steps, kind: ctx.body.kind === 'face' ? 'face' : 'chip' });
  const c = challenges.get(id);
  return { id, nonce: c.nonce.toString('base64'), steps };
});

const b64 = (v, max) => {
  if (typeof v !== 'string' || !v.length || v.length > max) return null;
  const buf = Buffer.from(v, 'base64');
  return buf.length ? buf : null;
};

route('POST', '/api/checks/chip', (ctx) => {
  const user = requireDriverRow(ctx);
  slowDown(ctx, user, 'chip');
  const sod = b64(ctx.body.sod, 60_000), dg1 = b64(ctx.body.dg1, 2000);
  if (!sod || !dg1) throw new ApiError(400, 'bad_chip', 'The ID’s chip couldn’t be read. Try again.');
  const dg15 = b64(ctx.body.dg15, 4000);
  const challenge = ctx.body.challengeId ? takeChallenge(user.id, String(ctx.body.challengeId)) : null;
  let id;
  try { id = readDg1(dg1); } catch { throw new ApiError(400, 'bad_chip', 'The ID’s chip couldn’t be read. Try again.'); }
  if (!id.checksOk) throw new ApiError(400, 'bad_chip', 'The ID’s chip couldn’t be read. Try again.');
  let signed;
  try { signed = verifySod(sod, { 1: dg1, 15: dg15 }); } catch (e) { signed = { ok: false, problems: [`couldn’t be read (${e.message})`] }; }
  // Active authentication: only chips with DG15 can; null when it can't be done.
  let live = null;
  if (dg15) {
    const signature = b64(ctx.body.aaSignature, 2000);
    live = challenge && signature ? (() => { try { return verifyActiveAuth(dg15, challenge.nonce, signature); } catch { return false; } })() : false;
  }
  if (id.expires && id.expires < today()) throw new ApiError(409, 'id_expired', 'This ID has expired. Use one that’s still valid.');
  const changed = checkRow(user.id)?.doc_hash !== docHash(id.country, id.number);
  save(user.id, {
    doc_type: id.docType, doc_country: id.country, surname: id.surname, given_names: id.givenNames, nationality: id.nationality,
    birth_date: id.birthDate, sex: id.sex, doc_expires: id.expires, doc_last4: id.number.slice(-4), doc_hash: docHash(id.country, id.number),
    person_hash: personHash(id.surname, id.givenNames, id.birthDate),
    chip_signed: signed.ok ? 1 : 0, chip_live: live == null ? null : live ? 1 : 0, chip_problems: signed.problems.join('; ') || null,
    chip_dg1_hash: crypto.createHash('sha256').update(dg1).digest('hex'), chip_at: now(),
    // A face match belongs to one chip: another ID needs the selfie again.
    ...(changed ? { face_at: null, face_score: null, face_live: null, face_attested: null } : {}),
  });
  evaluate(user.id);
  // Banned elsewhere as the same person: banned here too, with this phone.
  banFollowsPerson(user.id);
  return { checks: publicChecks(user), chip: { signed: signed.ok, live, country: signed.country } };
});

// The face match, from the phone. payload is the exact JSON text the app signed with App Attest (when the phone can).
route('POST', '/api/checks/face', (ctx) => {
  const user = requireDriverRow(ctx);
  slowDown(ctx, user, 'face');
  const raw = text(ctx.body.payload, 4000);
  let p;
  try { p = JSON.parse(raw); } catch { throw new ApiError(400, 'bad_face', 'The face check didn’t come through. Try again.'); }
  const c = checkRow(user.id);
  if (!c?.chip_at) throw new ApiError(409, 'chip_first', 'Read your ID’s chip first.');
  const challenge = takeChallenge(user.id, String(p.challengeId ?? ''));
  if (p.dg1 !== c.chip_dg1_hash) throw new ApiError(409, 'chip_first', 'Read your ID’s chip again, then the selfie.');
  const score = Number(p.score);
  if (!Number.isFinite(score) || score < -1 || score > 1) throw new ApiError(400, 'bad_face', 'The face check didn’t come through. Try again.');
  const live = Array.isArray(p.steps) && p.steps.join() === challenge.steps.join() && p.live === true;
  let attested = 0;
  const key = ctx.body.keyId && get('SELECT * FROM attest_keys WHERE key_id = ? AND user_id = ?', String(ctx.body.keyId), user.id);
  if (key && ctx.body.assertion) {
    try {
      const counter = checkAssertion(key, { assertion: String(ctx.body.assertion), clientData: Buffer.from(raw, 'utf8') });
      run('UPDATE attest_keys SET counter = ? WHERE key_id = ?', counter, key.key_id);
      attested = 1;
    } catch { attested = 0; }
  }
  save(user.id, { face_score: score, face_live: live ? 1 : 0, face_attested: attested, face_model: text(p.model, 60) || null, face_at: now(), face_by_person: 0 });
  evaluate(user.id);
  return { checks: publicChecks(user), face: { passed: score >= rules.faceAutoMatch && live && Boolean(attested) } };
});

function saveFile(raw, oldFile) {
  if (!raw?.length) throw new ApiError(400, 'no_photo', 'No photo came through.');
  if (raw[0] !== 0xff || raw[1] !== 0xd8 || raw[2] !== 0xff) throw new ApiError(400, 'not_jpeg', 'Send a JPEG photo.');
  if (oldFile) fs.rmSync(path.join(CHECK_DIR, oldFile), { force: true });
  const file = `${uid('chk_')}.jpg`;
  fs.writeFileSync(path.join(CHECK_DIR, file), raw, { mode: 0o600 });
  return file;
}

// The face for a person to compare, for drivers who'd rather not have the automatic match. Gone 30 days after the decision.
route('POST', '/api/checks/face-photo', (ctx) => {
  const user = requireDriverRow(ctx);
  slowDown(ctx, user, 'photo');
  const c = checkRow(user.id);
  save(user.id, { face_file: saveFile(ctx.raw, c?.face_file), face_by_person: 1, face_at: now(), face_score: null, face_live: null, face_attested: null });
  evaluate(user.id);
  return { checks: publicChecks(user) };
});

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
// A photo and what the phone read from it, signed with App Attest (this app, unchanged, on a real iPhone) or Android's Key
// Attestation (the same on Android). The app signs the same lines, ending in the photo's hash (AppAttest.headers). 0 where it
// can't, like a simulator or a phone with an unlocked bootloader: then a person looks.
function signedByApp(ctx, userId, lines) {
  const keyId = ctx.req.headers['x-attest-key'], assertion = ctx.req.headers['x-attest-assertion'];
  const key = keyId && assertion && get('SELECT * FROM attest_keys WHERE key_id = ? AND user_id = ?', String(keyId), userId);
  if (!key) return 0;
  try {
    const counter = checkAssertion(key, { assertion: String(assertion), clientData: Buffer.from([...lines, sha256(ctx.raw)].join('\n'), 'utf8') });
    run('UPDATE attest_keys SET counter = ? WHERE key_id = ?', counter, key.key_id);
    return 1;
  } catch {
    return 0;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const docNumber = (v) => text(v, 30).toUpperCase().replace(/[^A-Z0-9]/g, '');

// The chauffeurskaart or taxi permit: a photo, with what the phone read from it (the driver checked it).
route('POST', '/api/checks/document', (ctx) => {
  const user = requireDriverRow(ctx);
  slowDown(ctx, user, 'document');
  const kind = ctx.query.get('kind');
  if (!['chauffeurskaart', 'permit'].includes(kind)) throw new ApiError(400, 'bad_kind', 'Which document is this?');
  const number = docNumber(ctx.query.get('number'));
  if (number.length < 4) throw new ApiError(400, 'bad_number', 'Fill in the number on it.');
  const expires = text(ctx.query.get('expires'), 10);
  if (expires && !DATE.test(expires)) throw new ApiError(400, 'bad_date', 'That date can’t be read.');
  if (expires && expires < today()) throw new ApiError(409, 'expired', kind === 'permit' ? 'This permit has expired.' : 'This chauffeurskaart has expired.');
  if (kind === 'chauffeurskaart' && !expires) throw new ApiError(400, 'bad_date', 'Fill in the date it’s valid until.');
  const cardText = text(ctx.query.get('text'), 3000) || null;
  const camera = ctx.query.get('camera') === '1';
  const attested = signedByApp(ctx, user.id, ['drivezzz-doc-1', kind, ctx.query.get('number') ?? '', ctx.query.get('expires') ?? '', camera ? '1' : '0', sha256(ctx.query.get('text') ?? '')]);
  const c = checkRow(user.id);
  const p = kind === 'chauffeurskaart' ? 'ck' : 'permit';
  save(user.id, {
    [`${p}_file`]: saveFile(ctx.raw, c?.[`${p}_file`]), [`${p}_number`]: number, [`${p}_expires`]: expires || null, [`${p}_text`]: cardText, [`${p}_at`]: now(),
    [`${p}_attested`]: attested, [`${p}_camera`]: camera ? 1 : 0,
  });
  evaluate(user.id);
  return { checks: publicChecks(user) };
});

// KvK: the number, and with a key what KvK says about it: does it exist, has it ended, is taxi transport (SBI 49.32) among its work.
async function askKvk(number) {
  if (!config.checks.kvkKey) return null;
  try {
    const r = await fetch(`${config.checks.kvkUrl}/${number}?geoData=false`, { headers: { apikey: config.checks.kvkKey }, signal: AbortSignal.timeout(8000) });
    if (r.status === 400 || r.status === 404) return { found: false };
    if (!r.ok) return null;
    const p = await r.json();
    return {
      found: true,
      name: p.naam ?? null,
      names: [...new Set([p.naam, p.statutaireNaam, ...(p.handelsnamen ?? []).map((h) => h.naam)].filter(Boolean))],
      active: !p.materieleRegistratie?.datumEinde,
      taxi: (p.sbiActiviteiten ?? []).some((a) => String(a.sbiCode).startsWith('4932')),
    };
  } catch {
    return null;
  }
}
const saveKvk = (userId, number, k) => save(userId, {
  kvk_number: number, kvk_name: k?.name ?? null, kvk_names: k?.names ? JSON.stringify(k.names) : null, kvk_found: k ? (k.found ? 1 : 0) : null,
  kvk_active: k?.found ? (k.active ? 1 : 0) : null, kvk_taxi: k?.found ? (k.taxi ? 1 : 0) : null, kvk_checked_at: k ? now() : null,
});
route('POST', '/api/checks/kvk', async (ctx) => {
  const user = requireDriverRow(ctx);
  slowDown(ctx, user, 'kvk');
  const number = String(ctx.body.number ?? '').replace(/\D/g, '');
  if (number.length !== 8) throw new ApiError(400, 'bad_kvk', 'A KvK number has 8 digits.');
  saveKvk(user.id, number, await askKvk(number));
  evaluate(user.id);
  return { checks: publicChecks(user) };
});

// A connection from this machine itself, not passed on by Cloudflare or a helper process: the pretend drivers' services. With
// helpers (WORKERS) every request comes through them, so none counts.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const fromThisMachine = (req) => LOOPBACK.has(req.socket?.remoteAddress) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];

// The test server: pass (or wait for a person) without documents. The live server on a pretend chain: only its own pretend
// drivers. Their passes are marked, so the real network, or a server that stopped allowing them, can drop them (dropPretendPasses).
route('POST', '/api/checks/fake', (ctx) => {
  const local = !config.checks.fake && config.checks.fakeLocal && fromThisMachine(ctx.req);
  if (!config.checks.fake && !local) throw new ApiError(404, 'not_found', 'Not found.');
  const user = requireDriverRow(ctx);
  const t = now();
  const review = ctx.body.result === 'review';
  const number = `TEST${user.id.replace(/\W/g, '').toUpperCase()}`, until = plusDays(today(), 1500);
  save(user.id, {
    consent_at: t, consent_version: CONSENT_VERSION, face_by_person: 0,
    doc_type: 'P', doc_country: 'NLD', surname: 'TEST', given_names: 'PRETEND', nationality: 'NLD', birth_date: '1990-01-01', doc_expires: plusDays(today(), 3650),
    doc_last4: 'TEST', doc_hash: `${local ? 'fake-local' : 'fake'}-${user.id}`, person_hash: null, chip_signed: 1, chip_live: 1, chip_problems: null, chip_dg1_hash: 'fake', chip_at: t,
    face_score: review ? 0.2 : 0.9, face_live: 1, face_attested: 1, face_model: 'fake', face_at: t,
    ck_number: number, ck_expires: until, ck_text: `TEST TAXI ${number} ${until}`, ck_at: t, ck_attested: 1, ck_camera: 1,
    permit_number: number, permit_expires: null, permit_text: `TEST TAXI ${number}`, permit_at: t, permit_attested: 1, permit_camera: 1,
    kvk_number: '00000000', kvk_name: 'Test', kvk_names: '["Test"]', kvk_found: 1, kvk_active: 1, kvk_taxi: 1,
  });
  // A pretend pass covers the car too; a real plate added later is still checked for real.
  run('UPDATE cars SET plate_ok_by = ? WHERE id = (SELECT active_car_id FROM drivers WHERE user_id = ?)', 'fake', user.id);
  evaluate(user.id);
  return { checks: publicChecks(user) };
});

// ---------- App Attest, and Android's Key Attestation ----------

const attestChallenges = new Map();
route('POST', '/api/attest/challenge', (ctx) => {
  const user = requireUser(ctx);
  slowDown(ctx, user, 'attest');
  for (const [k, v] of attestChallenges) if (now() - v.at > CHALLENGE_TTL) attestChallenges.delete(k);
  const id = uid('att_');
  const challenge = crypto.randomBytes(32).toString('base64');
  attestChallenges.set(id, { userId: user.id, at: now(), challenge });
  return { id, challenge };
});
route('POST', '/api/attest/key', async (ctx) => {
  const user = requireUser(ctx);
  slowDown(ctx, user, 'attest');
  const c = attestChallenges.get(String(ctx.body.challengeId ?? ''));
  attestChallenges.delete(String(ctx.body.challengeId ?? ''));
  if (!c || c.userId !== user.id || now() - c.at > CHALLENGE_TTL) throw new ApiError(409, 'old_challenge', 'That took too long. Try again.');
  const keyId = text(ctx.body.keyId, 100);
  const android = ctx.body.platform === 'android';
  if (android) await refreshRevocations();
  let out;
  try {
    out = android
      ? verifyAndroidAttestation({ keyId, chain: ctx.body.chain, challenge: c.challenge })
      : verifyAttestation({ keyId, attestation: String(ctx.body.attestation ?? ''), challenge: c.challenge });
  } catch (e) {
    // In the log, so a phone whose scans all go to a person can be looked into: which phone said what.
    console.warn(`[drivezzz] attest: ${android ? 'Android' : 'iPhone'} key of ${user.id} refused: ${e.message}`);
    throw new ApiError(400, 'not_attested', `This phone couldn’t prove it runs the real Drivezzz app (${e.message}).`);
  }
  run('INSERT INTO attest_keys (key_id, user_id, public_key, environment, counter, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(key_id) DO UPDATE SET user_id = excluded.user_id, public_key = excluded.public_key, counter = 0',
    keyId, user.id, out.publicKey, out.environment, now());
  return { ok: true, environment: out.environment };
});

// ---------- a person's decision (admin.js) ----------

export function decideCheck(userId, decision, note, admin) {
  const c = checkRow(userId);
  if (!c) throw new ApiError(404, 'not_found', 'Not found.');
  const t = now();
  if (decision === 'approve') {
    save(userId, { status: 'approved', decided_at: t, decided_by: admin, auto: 0, decision_note: note || null, asked_again: null, files_delete_after: t + rules.checksFilesKept });
    run('UPDATE cars SET plate_ok_by = ? WHERE id = (SELECT active_car_id FROM drivers WHERE user_id = ?)', admin, userId);
    // Approved before: only a car's plate was waiting for a person.
    notify(userId, 'You can drive in the Netherlands', c.status === 'approved' ? 'Your car’s number plate was checked.' : 'Your documents were checked.');
  } else if (decision === 'decline') {
    save(userId, { status: 'declined', decided_at: t, decided_by: admin, auto: 0, decision_note: note || null, asked_again: null, files_delete_after: t + rules.checksFilesKept });
    notify(userId, 'Your check wasn’t approved', note || 'Open Driving in the Netherlands to see why.');
  } else if (decision === 'again:plate') {
    // A new photo of the car's back is enough: the rest stays as it is.
    notify(userId, 'One thing to send again', note || 'Add a photo of your car’s back with the plate readable.');
    return;
  } else if (['id', 'face', 'chauffeurskaart', 'permit', 'kvk'].includes(decision.replace(/^again:/, ''))) {
    // Ask for one item again.
    const item = decision.replace(/^again:/, '');
    const reset = {
      id: { chip_at: null, face_at: null }, face: { face_at: null, face_score: null },
      chauffeurskaart: { ck_at: null }, permit: { permit_at: null }, kvk: { kvk_number: null },
    }[item];
    save(userId, { ...reset, status: 'started', decided_at: t, decided_by: admin, decision_note: note || null, asked_again: item });
    notify(userId, 'One thing to send again', note || `${NAMES[item]}: open Driving in the Netherlands.`);
  } else {
    throw new ApiError(400, 'bad_decision', 'Approve, decline, or ask again.');
  }
  refreshVerified(userId);
}
export const checkFile = (name) => (name && /^chk_[a-z0-9]+\.jpg$/.test(name) ? path.join(CHECK_DIR, name) : null);

// ---------- once an hour ----------

// The documents' photos go 30 days after the decision; whoever's ID, chauffeurskaart or permit runs out loses "Verified" and is
// told 30 days before. KvK is asked again: who it didn't answer for needn't wait on a person, and an ended registration ends the
// permit with it, so that driver goes to one.
export async function runChecks() {
  const t = now();
  if (config.checks.kvkKey) {
    for (const c of all(`SELECT user_id, kvk_number FROM driver_checks WHERE status = 'review' AND kvk_number IS NOT NULL AND kvk_found IS NULL LIMIT 50`)) {
      const k = await askKvk(c.kvk_number);
      if (k) { saveKvk(c.user_id, c.kvk_number, k); evaluate(c.user_id); }
    }
    for (const c of all(`SELECT user_id, kvk_number FROM driver_checks WHERE status = 'approved' AND kvk_number IS NOT NULL AND COALESCE(kvk_checked_at, 0) < ? LIMIT 50`, t - rules.kvkRecheck)) {
      const k = await askKvk(c.kvk_number);
      if (!k) continue;
      saveKvk(c.user_id, c.kvk_number, k);
      if (!k.found || !k.active) evaluate(c.user_id);
    }
  }
  for (const c of all('SELECT user_id, ck_file, permit_file, face_file FROM driver_checks WHERE files_delete_after IS NOT NULL AND files_delete_after < ? AND (ck_file IS NOT NULL OR permit_file IS NOT NULL OR face_file IS NOT NULL)', t)) {
    for (const f of [c.ck_file, c.permit_file, c.face_file]) if (f) fs.rmSync(path.join(CHECK_DIR, f), { force: true });
    run('UPDATE driver_checks SET ck_file = NULL, permit_file = NULL, face_file = NULL WHERE user_id = ?', c.user_id);
  }
  const soon = plusDays(today(), rules.checksWarnBefore / 86_400_000);
  for (const c of all(`SELECT * FROM driver_checks WHERE status = 'approved'`)) {
    refreshVerified(c.user_id);
    const ending = [['your ID', c.doc_expires], ['your chauffeurskaart', c.ck_expires], ['your taxi permit', c.permit_expires]].filter(([, d]) => d && d <= soon);
    if (ending.length && (!c.warned_at || t - c.warned_at > rules.checksWarnBefore)) {
      run('UPDATE driver_checks SET warned_at = ? WHERE user_id = ?', t, c.user_id);
      notify(c.user_id, 'Something runs out soon', `${ending.map(([w, d]) => `${w} on ${d}`).join(', ')}. Send the new one in Driving in the Netherlands, so you can keep driving.`);
    }
  }
}

// At start: a pretend pass only counts where it can still be made. On the live server on a pretend chain that's the server's own
// pretend drivers (who pass again as they start), and on the real network nobody: everyone else does the real checks.
export function dropPretendPasses() {
  const keep = config.checks.fake ? `doc_hash LIKE 'fake-%'` : config.checks.fakeLocal ? `doc_hash LIKE 'fake-local-%'` : '0';
  for (const c of all(`SELECT user_id, ck_file, permit_file, face_file FROM driver_checks WHERE doc_hash LIKE 'fake-%' AND NOT (${keep})`)) {
    for (const f of [c.ck_file, c.permit_file, c.face_file]) if (f) fs.rmSync(path.join(CHECK_DIR, f), { force: true });
    run('DELETE FROM driver_checks WHERE user_id = ?', c.user_id);
    run(`UPDATE cars SET plate_ok_by = NULL WHERE user_id = ? AND plate_ok_by = 'fake'`, c.user_id);
    refreshVerified(c.user_id);
    console.log(`[drivezzz] checks: dropped the pretend pass of ${c.user_id}`);
  }
}

// At start: checks from before persons were kept get their person, from what their chip gave.
export function fillPersonHashes() {
  for (const c of all(`SELECT user_id, surname, given_names, birth_date FROM driver_checks WHERE person_hash IS NULL AND chip_at IS NOT NULL AND surname IS NOT NULL AND COALESCE(doc_hash, '') NOT LIKE 'fake-%'`)) {
    run('UPDATE driver_checks SET person_hash = ? WHERE user_id = ?', personHash(c.surname, c.given_names, c.birth_date), c.user_id);
  }
}

// When an account goes (auth.js, forgetPerson).
export function forgetChecks(userId) {
  const c = checkRow(userId);
  for (const f of [c?.ck_file, c?.permit_file, c?.face_file]) if (f) fs.rmSync(path.join(CHECK_DIR, f), { force: true });
  run('DELETE FROM driver_checks WHERE user_id = ?', userId);
  run('DELETE FROM attest_keys WHERE user_id = ?', userId);
}

