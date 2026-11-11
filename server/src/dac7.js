// DAC7: once a year, a platform reports to the Belastingdienst what each driver earned through it (EU directive 2021/514, in the
// Netherlands the Wet implementatie EU-richtlijn gegevensuitwisseling digitale platformeconomie). It's a report, not a tax: drivers
// declare and pay their own. Transport is a "personal service", for which there's no lower limit. By 31 January, about the year
// before: per driver their name, address, BSN (the Dutch tax number), date of birth, and per quarter what riders paid them through
// Drivezzz (after the €0.10) and how many rides, and the fees Drivezzz kept. Drivers are told what was reported.
// The report is made on the admin panel (CSV); sending it is Pieter's, through the Belastingdienst's DAC7 portal (eHerkenning).
// The BSN is kept only for this, encrypted with a key that's not in the database or its backups.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, DATA_DIR, db, get, now, run } from './db.js';
import { config, rules } from './config.js';
import { ApiError, route, text } from './http.js';
import { requireUser } from './auth.js';
import { inNetherlands } from './geo.js';
import { checkRow } from './checks.js';

db.exec(`
CREATE TABLE IF NOT EXISTS tax_details (
  user_id TEXT PRIMARY KEY,
  surname TEXT, given_names TEXT, birth_date TEXT,
  street TEXT, postcode TEXT, city TEXT, country TEXT,
  tin_enc TEXT, tin_last3 TEXT, tin_country TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  forgotten_at INTEGER      -- the account went; kept for the reports the law asks to keep (7 years), then gone
);
`);
// The law asks to keep the records at least 5 and at most 10 years.
const KEPT_AFTER = 7 * 365 * 86_400_000;

// The key for the BSN: a file next to the database, not in it, so a copy of the database alone can't read it.
let key = null;
function taxKey() {
  if (key) return key;
  const file = process.env.TAX_KEY_FILE || path.join(DATA_DIR, 'tax.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  return key;
}
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', taxKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function open(sealed) {
  if (!sealed) return null;
  const raw = Buffer.from(sealed, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', taxKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// A BSN has 9 digits and passes the "elfproef".
export function validBsn(s) {
  if (!/^\d{9}$/.test(s)) return false;
  const sum = [...s].reduce((t, d, i) => t + Number(d) * (i === 8 ? -1 : 9 - i), 0);
  return sum % 11 === 0 && Number(s) > 0;
}

const detailsOf = (userId) => get('SELECT * FROM tax_details WHERE user_id = ? AND forgotten_at IS NULL', userId);
export const hasTaxDetails = (userId) => Boolean(detailsOf(userId));

// Going online in the Netherlands asks for these (drivers.js); a demo account never.
export function taxNeeded(user, point) {
  if (!config.checks.required || user.is_demo) return false;
  if (point && !inNetherlands(point.lat, point.lng)) return false;
  return !hasTaxDetails(user.id);
}

// ---------- what was earned ----------

// Per driver and quarter: what reached them (paid out, or cash), how many rides, and Drivezzz's fees. By when it was paid.
function earnings(year, userId = null) {
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
  const rows = all(`SELECT p.user_id, p.eur_cents, p.status, COALESCE(p.confirmed_at, p.created_at) AS at, r.price_cents, r.coin
                    FROM payouts p JOIN rides r ON r.id = p.ride_id JOIN users u ON u.id = p.user_id
                    WHERE p.kind = 'payout' AND p.status IN ('confirmed', 'cash') AND u.is_demo = 0
                    AND COALESCE(p.confirmed_at, p.created_at) >= ? AND COALESCE(p.confirmed_at, p.created_at) < ? ${userId ? 'AND p.user_id = ?' : ''}`,
  from, to, ...(userId ? [userId] : []));
  const by = new Map();
  for (const p of rows) {
    const q = Math.floor(new Date(p.at).getUTCMonth() / 3);
    const e = by.get(p.user_id) ?? { userId: p.user_id, cents: [0, 0, 0, 0], rides: [0, 0, 0, 0], fees: [0, 0, 0, 0] };
    e.cents[q] += p.eur_cents ?? 0;
    e.rides[q] += 1;
    // Paid out in full: Drivezzz kept its €0.10 of the price.
    if (p.status === 'confirmed' && p.eur_cents === Math.max(0, (p.price_cents ?? 0) - rules.feeCents)) e.fees[q] += rules.feeCents;
    by.set(p.user_id, e);
  }
  return [...by.values()];
}

export function dac7Report(year) {
  return earnings(year).map((e) => {
    const d = get('SELECT * FROM tax_details WHERE user_id = ?', e.userId);
    const u = get('SELECT name, email FROM users WHERE id = ?', e.userId);
    const c = checkRow(e.userId);
    return {
      userId: e.userId, account: u?.name ?? null, email: u?.email ?? null,
      surname: d?.surname ?? c?.surname ?? null, givenNames: d?.given_names ?? c?.given_names ?? null, birthDate: d?.birth_date ?? c?.birth_date ?? null,
      street: d?.street ?? null, postcode: d?.postcode ?? null, city: d?.city ?? null, country: d?.country ?? null,
      tin: d ? open(d.tin_enc) : null, tinCountry: d?.tin_country ?? null, kvk: c?.kvk_number ?? null,
      cents: e.cents, rides: e.rides, fees: e.fees,
      missing: !d ? 'No tax details' : null,
    };
  });
}

const CSV_HEAD = ['Surname', 'Given names', 'Date of birth', 'Street', 'Postcode', 'City', 'Country', 'TIN (BSN)', 'TIN country', 'KvK',
  'Q1 paid (EUR)', 'Q1 rides', 'Q1 fees (EUR)', 'Q2 paid (EUR)', 'Q2 rides', 'Q2 fees (EUR)', 'Q3 paid (EUR)', 'Q3 rides', 'Q3 fees (EUR)', 'Q4 paid (EUR)', 'Q4 rides', 'Q4 fees (EUR)', 'Account', 'Missing'];
const cell = (v) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const euros = (c) => (c / 100).toFixed(2);
export function dac7Csv(year) {
  const lines = [CSV_HEAD.join(',')];
  for (const r of dac7Report(year)) {
    lines.push([r.surname, r.givenNames, r.birthDate, r.street, r.postcode, r.city, r.country, r.tin, r.tinCountry, r.kvk,
      ...[0, 1, 2, 3].flatMap((q) => [euros(r.cents[q]), r.rides[q], euros(r.fees[q])]), r.userId, r.missing].map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ---------- the driver's side ----------

function own(user) {
  const d = detailsOf(user.id);
  const c = checkRow(user.id);
  const lastYear = new Date(now()).getUTCFullYear() - 1;
  const last = earnings(lastYear, user.id)[0];
  return {
    filled: Boolean(d),
    // From the ID's chip when the checks have it: nothing to type.
    surname: d?.surname ?? c?.surname ?? null, givenNames: d?.given_names ?? c?.given_names ?? null, birthDate: d?.birth_date ?? c?.birth_date ?? null,
    fromId: Boolean(c?.chip_at),
    street: d?.street ?? null, postcode: d?.postcode ?? null, city: d?.city ?? null, country: d?.country ?? 'NL',
    bsnEnd: d?.tin_last3 ?? null,
    // What was (or will be) reported about last year.
    reported: last ? { year: lastYear, cents: last.cents.reduce((a, b) => a + b, 0), rides: last.rides.reduce((a, b) => a + b, 0) } : null,
  };
}

route('GET', '/api/tax', (ctx) => ({ tax: own(requireUser(ctx)) }));

route('POST', '/api/tax', (ctx) => {
  const user = requireUser(ctx);
  const c = checkRow(user.id);
  const b = ctx.body;
  const bsn = String(b.bsn ?? '').replace(/\D/g, '');
  const country = (text(b.country, 2) || 'NL').toUpperCase();
  if (country === 'NL' && !validBsn(bsn)) throw new ApiError(400, 'bad_bsn', 'That BSN isn’t right: 9 digits, as on your ID or tax letters.');
  if (country !== 'NL' && bsn.length < 5) throw new ApiError(400, 'bad_tin', 'Fill in your tax number.');
  const street = text(b.street, 120), postcode = text(b.postcode, 12).toUpperCase(), city = text(b.city, 80);
  if (!street || !postcode || !city) throw new ApiError(400, 'bad_address', 'Fill in your address.');
  if (country === 'NL' && !/^\d{4}\s?[A-Z]{2}$/.test(postcode)) throw new ApiError(400, 'bad_postcode', 'A Dutch postcode is like 1234 AB.');
  // The name and birth date come from the ID's chip when there is one; otherwise as typed.
  const surname = c?.surname ?? text(b.surname, 80), given = c?.given_names ?? text(b.givenNames, 80), birth = c?.birth_date ?? text(b.birthDate, 10);
  if (!surname || !/^\d{4}-\d{2}-\d{2}$/.test(birth ?? '')) throw new ApiError(400, 'bad_name', 'Fill in your name and date of birth.');
  const t = now();
  run(`INSERT INTO tax_details (user_id, surname, given_names, birth_date, street, postcode, city, country, tin_enc, tin_last3, tin_country, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET surname = excluded.surname, given_names = excluded.given_names, birth_date = excluded.birth_date, street = excluded.street,
         postcode = excluded.postcode, city = excluded.city, country = excluded.country, tin_enc = excluded.tin_enc, tin_last3 = excluded.tin_last3,
         tin_country = excluded.tin_country, updated_at = excluded.updated_at, forgotten_at = NULL`,
  user.id, surname, given || null, birth, street, postcode, city, country, seal(bsn), bsn.slice(-3), country, t, t);
  return { tax: own(user) };
});

// The account goes: the details stay for the reports already owed, without being used for anything else, then go (runTax).
export function forgetTax(userId) {
  run('UPDATE tax_details SET forgotten_at = COALESCE(forgotten_at, ?) WHERE user_id = ?', now(), userId);
}
export function runTax() {
  run('DELETE FROM tax_details WHERE forgotten_at IS NOT NULL AND forgotten_at < ?', now() - KEPT_AFTER);
}
