// SQLite through Node's own module. Times are ms since 1970.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tellEdges } from './fanout.js';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'drivezzz.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32000; PRAGMA mmap_size = 268435456;');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                 -- dz-xxxxxx, given on Continue and never changed
  name TEXT NOT NULL,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  is_driver INTEGER NOT NULL DEFAULT 0,
  lat REAL, lng REAL, loc_at INTEGER,
  push_token TEXT, push_env TEXT,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS user_devices (
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS user_devices_device ON user_devices(device_id);

CREATE TABLE IF NOT EXISTS strikes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  given_by TEXT,
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  removed_why TEXT
);
CREATE INDEX IF NOT EXISTS strikes_user ON strikes(user_id);
CREATE TABLE IF NOT EXISTS bans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                  -- week | permanent
  reason TEXT NOT NULL,
  strike_id TEXT,
  given_by TEXT,
  created_at INTEGER NOT NULL,
  ends_at INTEGER,                     -- NULL: permanent
  lifted_at INTEGER,
  lifted_why TEXT
);
CREATE INDEX IF NOT EXISTS bans_user ON bans(user_id);
-- A ban covers the phones its account used: their account or any other on them.
CREATE TABLE IF NOT EXISTS banned_devices (
  device_id TEXT NOT NULL,
  ban_id TEXT NOT NULL REFERENCES bans(id),
  PRIMARY KEY (device_id, ban_id)
);
CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  ban_id TEXT NOT NULL REFERENCES bans(id),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | lifted | upheld | superseded
  answer TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS appeals_ban ON appeals(ban_id);

CREATE TABLE IF NOT EXISTS drivers (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  per_km_cents INTEGER NOT NULL,
  per_min_cents INTEGER NOT NULL,
  pickup_per_km_cents INTEGER NOT NULL,
  pets_allowed INTEGER NOT NULL DEFAULT 0,
  bio TEXT,
  active_car_id TEXT,
  online_since INTEGER,                -- set while online
  heartbeat_at INTEGER,
  last_online_at INTEGER,
  lat REAL, lng REAL, heading REAL, loc_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drivers_online ON drivers(online_since);
CREATE INDEX IF NOT EXISTS drivers_online_near ON drivers(lat, lng) WHERE online_since IS NOT NULL;
CREATE TABLE IF NOT EXISTS online_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS online_log_user ON online_log(user_id, started_at);
CREATE TABLE IF NOT EXISTS cars (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plate TEXT NOT NULL,
  make TEXT, model TEXT,
  color_name TEXT, color_hex TEXT,
  body TEXT,                           -- hatchback | sedan | estate | suv | mpv | van
  seats INTEGER NOT NULL DEFAULT 4,    -- passengers, the driver not counted
  year INTEGER,
  verified INTEGER NOT NULL DEFAULT 0, -- the plate was found in the RDW register
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS cars_user ON cars(user_id);
CREATE TABLE IF NOT EXISTS car_photos (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES cars(id),
  kind TEXT NOT NULL,                  -- outside | inside
  file TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS car_photos_car ON car_photos(car_id);

CREATE TABLE IF NOT EXISTS rides (
  id TEXT PRIMARY KEY,
  rider_id TEXT NOT NULL REFERENCES users(id),
  driver_id TEXT REFERENCES users(id),
  car_id TEXT REFERENCES cars(id),
  -- awaiting_payment | offered | open | scheduled | accepted | arrived | riding | completed | cancelled
  status TEXT NOT NULL,
  mode TEXT NOT NULL,                  -- auto | driver | bid
  scheduled_at INTEGER,                -- NULL: now
  pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL, pickup_label TEXT, pickup_moved_m INTEGER,
  dropoff_lat REAL NOT NULL, dropoff_lng REAL NOT NULL, dropoff_label TEXT, dropoff_moved_m INTEGER,
  polyline TEXT, distance_m INTEGER NOT NULL, duration_s INTEGER NOT NULL,
  passengers INTEGER NOT NULL DEFAULT 1,
  pets INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER,                 -- what the rider pays; set when a driver takes it
  max_cents INTEGER NOT NULL,          -- the most a rider said they'd pay
  coin TEXT NOT NULL,
  coin_units INTEGER NOT NULL,         -- held from the rider
  eur_per_coin REAL NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  queue TEXT,                          -- drivers still to offer it to: [{driverId, priceCents, ...}]
  offered_to TEXT,
  offered_until INTEGER,
  pickup_eta_at INTEGER,               -- promised arrival at the pickup
  pickup_m INTEGER,                    -- the driver's way to the pickup, in the price
  accepted_at INTEGER,
  arrived_at INTEGER,
  arrival_late_s INTEGER,
  checked_in_at INTEGER,
  checkout_tried_at INTEGER,
  checked_out_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by TEXT,                   -- rider | driver | admin | system
  cancel_reason TEXT,
  sync_ok INTEGER NOT NULL DEFAULT 0,
  sync_off INTEGER NOT NULL DEFAULT 0,
  sync_streak INTEGER NOT NULL DEFAULT 0,
  route_off_streak INTEGER NOT NULL DEFAULT 0,
  closest_m INTEGER,                   -- how close the driver came to the drop-off
  safety_asked_at INTEGER,
  safety_answer TEXT,
  review_required INTEGER NOT NULL DEFAULT 0,
  plan_notice_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rides_rider ON rides(rider_id, created_at);
CREATE INDEX IF NOT EXISTS rides_driver ON rides(driver_id, created_at);
CREATE INDEX IF NOT EXISTS rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS rides_driver_status ON rides(driver_id, status);
CREATE INDEX IF NOT EXISTS rides_rider_status ON rides(rider_id, status);
CREATE TABLE IF NOT EXISTS ride_points (
  ride_id TEXT NOT NULL REFERENCES rides(id),
  who TEXT NOT NULL,                   -- rider | driver
  at INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ride_points_ride ON ride_points(ride_id, who, at);
CREATE TABLE IF NOT EXISTS ride_events (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id),
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ride_events_ride ON ride_events(ride_id, at);
CREATE INDEX IF NOT EXISTS ride_events_detail ON ride_events(detail, kind);
CREATE TABLE IF NOT EXISTS reviews (
  ride_id TEXT PRIMARY KEY REFERENCES rides(id),
  rider_id TEXT NOT NULL REFERENCES users(id),
  driver_id TEXT NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL,
  text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_driver ON reviews(driver_id, created_at);
-- An appeal about a ride's money (bans have their own appeals).
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id),
  opened_by TEXT,                      -- a user, or NULL when Drivezzz opened it
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | pay_driver | refund_rider
  answer TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS disputes_ride ON disputes(ride_id);

-- A driver's money on its way, for the Wallet screen and earnings. The money itself is in the ride's escrow.
-- A database from before the escrow also has ledger, deposits and chain_seen: history that nothing reads, left as it is.
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  ride_id TEXT,
  kind TEXT NOT NULL,                  -- payout
  coin TEXT NOT NULL,
  units INTEGER NOT NULL,
  eur_cents INTEGER,
  -- held (until due_at) | confirmed | cancelled, or demo for the review account
  status TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  address TEXT, tag INTEGER,
  txid TEXT, sent_units INTEGER, last_valid INTEGER, sent_at INTEGER, confirmed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payouts_status ON payouts(status, due_at);
CREATE INDEX IF NOT EXISTS payouts_user ON payouts(user_id, created_at);
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT NOT NULL REFERENCES users(id),
  coin TEXT NOT NULL,
  address TEXT NOT NULL,
  tag INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,  -- for drivers: wants to be paid in this coin
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, coin)
);
CREATE TABLE IF NOT EXISTS admin_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
`);

// New columns on a database that already exists.
function addColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// A car is a price profile: its own rates and whether pets may come. Cars from before that get their driver's.
if (!db.prepare('PRAGMA table_info(cars)').all().some((c) => c.name === 'per_km_cents')) {
  addColumn('cars', 'per_km_cents', 'INTEGER');
  addColumn('cars', 'per_min_cents', 'INTEGER');
  addColumn('cars', 'pickup_per_km_cents', 'INTEGER');
  addColumn('cars', 'pets_allowed', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`UPDATE cars SET
    per_km_cents = (SELECT per_km_cents FROM drivers d WHERE d.user_id = cars.user_id),
    per_min_cents = (SELECT per_min_cents FROM drivers d WHERE d.user_id = cars.user_id),
    pickup_per_km_cents = (SELECT pickup_per_km_cents FROM drivers d WHERE d.user_id = cars.user_id),
    pets_allowed = COALESCE((SELECT pets_allowed FROM drivers d WHERE d.user_id = cars.user_id), 0)`);
}

// A vehicle can be a car, a motor or a scooter; a rider can ask for one of them.
addColumn('cars', 'vehicle', "TEXT NOT NULL DEFAULT 'car'");
addColumn('rides', 'vehicle', 'TEXT');
// A motor or scooter takes one passenger (Pieter's decision, 5 November 2026). They could say two before that.
if (process.env.DRIVEZZZ_ROLE !== 'edge') db.exec("UPDATE cars SET seats = 1 WHERE vehicle <> 'car' AND seats > 1");

// The App Review account and its simulated people (demo.js).
addColumn('users', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
// Which version of the EULA was accepted, and when.
addColumn('users', 'eula_version', 'INTEGER');
addColumn('users', 'eula_accepted_at', 'INTEGER');
// An admin looked at a large payment.
addColumn('payouts', 'approved', 'INTEGER NOT NULL DEFAULT 0');
// The rider pays the payout's network fee: held with the ride (at most this much), carried to the payout, and what
// the network didn't take goes back to the rider once it's confirmed.
addColumn('rides', 'fee_units', 'INTEGER NOT NULL DEFAULT 0');
addColumn('payouts', 'fee_units', 'INTEGER NOT NULL DEFAULT 0');
addColumn('payouts', 'fee_paid', 'INTEGER');
// Which wallet app shared an address (Trust Wallet, MetaMask…), to show it.
addColumn('wallets', 'via', 'TEXT');
// A driver takes cash unless they turn it off (Wallet).
addColumn('drivers', 'takes_cash', 'INTEGER NOT NULL DEFAULT 1');
// Never paid twice, whatever the code above does: one payout per ride.
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS payouts_one_per_ride ON payouts(ride_id) WHERE kind = 'payout';
`);
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES users(id),
  ride_id TEXT,
  reason TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed
  note TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS reports_status ON reports(status, created_at);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  rider_id TEXT NOT NULL REFERENCES users(id),   -- whoever started it
  driver_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_rider ON conversations(rider_id, last_at);
CREATE INDEX IF NOT EXISTS conversations_driver ON conversations(driver_id, last_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,                  -- nonce | ciphertext | tag, base64: only the two phones can open it
  sender_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL REFERENCES users(id),
  blocked_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_other ON blocks(blocked_id);
CREATE TABLE IF NOT EXISTS support_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  topic TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed
  created_at INTEGER NOT NULL
);
`);
// A connected wallet is locked. Changing it takes a request and an admin's yes, good for one change (wallet.js).
db.exec(`
CREATE TABLE IF NOT EXISTS wallet_change_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | allowed | declined | used
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  used_at INTEGER,
  old_address TEXT,
  new_address TEXT
);
CREATE INDEX IF NOT EXISTS wallet_change_requests_user ON wallet_change_requests(user_id, created_at);
`);
addColumn('users', 'e2e_key', 'TEXT');
addColumn('reports', 'chat', 'TEXT');   // the chat, readable, when the reporter's phone handed over its keys

// A driver has to allow planning, and says how far ahead.
addColumn('drivers', 'allows_planning', 'INTEGER NOT NULL DEFAULT 0');
addColumn('drivers', 'plan_days', 'INTEGER NOT NULL DEFAULT 7');
// When the driver was told that the licence, permits and insurance the law may ask where they drive are up to them.
addColumn('drivers', 'rules_seen_at', 'INTEGER');

// A ride's money on Solana: one escrow (contract/) per payment attempt; the first paid one counts, any other is refunded.
//   requested  the rider's wallet was given the payment to sign
//   paid       the chain has it; settle_after says when the server may pick the outcome
//   settling   the outcome's transaction is sent (settle_sig, known before sending, so a retry can't go twice)
//   settled    done: outcome is payout, split, refund or expired
db.exec(`
CREATE TABLE IF NOT EXISTS escrows (
  id TEXT PRIMARY KEY,                 -- the 16-byte id in hex; the escrow's address comes from it
  ride_id TEXT NOT NULL REFERENCES rides(id),
  coin TEXT NOT NULL,
  address TEXT NOT NULL,
  payer TEXT NOT NULL, driver_address TEXT NOT NULL,
  units INTEGER NOT NULL, fee_units INTEGER NOT NULL, eur_per_coin REAL NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT, settle_after INTEGER, settle_sig TEXT, last_valid INTEGER, error TEXT,
  created_at INTEGER NOT NULL, paid_at INTEGER, settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS escrows_ride ON escrows(ride_id);
CREATE INDEX IF NOT EXISTS escrows_status ON escrows(status);
`);
// Paying for a ride: until when, and the token in the Solana Pay link that builds the payment.
addColumn('rides', 'pay_by', 'INTEGER');
addColumn('rides', 'pay_token', 'TEXT');
// The check-out warning: the rider's phone wasn't near the drop-off.
addColumn('rides', 'checkout_warning', 'INTEGER NOT NULL DEFAULT 0');
// An admin holding a ride's money: nothing is sent until it's released or decided, except the refund after 30 days.
addColumn('escrows', 'manual_hold', 'INTEGER NOT NULL DEFAULT 0');
addColumn('escrows', 'leftover', 'INTEGER NOT NULL DEFAULT 0');       // settled, but the rider's part still waits on the chain
addColumn('rides', 'pickup_deadline_at', 'INTEGER');     // after this a rider cancels for free, unless the driver reached the pickup
addColumn('rides', 'late_notice_sent', 'INTEGER NOT NULL DEFAULT 0');
addColumn('rides', 'waiting_since', 'INTEGER');          // the driver came to a stop at the pickup: their 10 minutes run from here
addColumn('drivers', 'inactive_at', 'INTEGER');          // put offline for not answering a ride; they come back by themselves
addColumn('conversations', 'rider_cleared_at', 'INTEGER');   // removed by the one who started it: nothing from before this shows for them
addColumn('conversations', 'driver_cleared_at', 'INTEGER');  // the same for the other person
// Bans also cover wallet addresses (DeviceCheck covers the phone).
db.exec(`
CREATE TABLE IF NOT EXISTS banned_wallets (
  address TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Driving a taxi in the Netherlands (checks.js, docs/driver-checks-nl.md): who the driver is, from their ID's chip; that the face
// matches it, worked out on the phone; their chauffeurskaart, taxi permit and KvK. One row per driver.
//   started   something is in, not everything
//   review    everything is in, and something needs a person (review_reasons)
//   approved  by itself when everything checked out (auto = 1), or by a person
//   declined  by a person, with a note the driver sees; sending something again starts over
// No photo of the face, no chip photo, no BSN and no full document number is ever kept. The photos of the chauffeurskaart and
// the permit go 30 days after the decision (files_delete_after).
db.exec(`
CREATE TABLE IF NOT EXISTS driver_checks (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'started',
  consent_at INTEGER,
  consent_version INTEGER,
  face_by_person INTEGER NOT NULL DEFAULT 0,  -- the driver chose a person over the automatic face match
  doc_type TEXT, doc_country TEXT, surname TEXT, given_names TEXT, nationality TEXT, birth_date TEXT, sex TEXT, doc_expires TEXT,
  doc_last4 TEXT, doc_hash TEXT,              -- the end of the document number, and a keyed hash of all of it, to know it again
  chip_signed INTEGER, chip_live INTEGER, chip_problems TEXT, chip_dg1_hash TEXT, chip_at INTEGER,
  face_score REAL, face_live INTEGER, face_attested INTEGER, face_model TEXT, face_at INTEGER, face_file TEXT,
  ck_number TEXT, ck_expires TEXT, ck_text TEXT, ck_file TEXT, ck_at INTEGER,
  permit_number TEXT, permit_expires TEXT, permit_text TEXT, permit_file TEXT, permit_at INTEGER,
  kvk_number TEXT, kvk_name TEXT, kvk_found INTEGER, kvk_active INTEGER, kvk_taxi INTEGER, kvk_checked_at INTEGER,
  review_reasons TEXT,
  submitted_at INTEGER, decided_at INTEGER, decided_by TEXT, decision_note TEXT, auto INTEGER,
  warned_at INTEGER,
  files_delete_after INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS driver_checks_status ON driver_checks(status, submitted_at);
CREATE INDEX IF NOT EXISTS driver_checks_doc ON driver_checks(doc_hash);
CREATE INDEX IF NOT EXISTS driver_checks_card ON driver_checks(ck_number);
CREATE INDEX IF NOT EXISTS driver_checks_permit ON driver_checks(permit_number);
-- App Attest keys (attest.js): one per phone and account.
CREATE TABLE IF NOT EXISTS attest_keys (
  key_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  environment TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attest_keys_user ON attest_keys(user_id);
`);
// Who someone is, from their ID's chip: a keyed hash of their name and date of birth (checks.js, personHash). A ban follows it.
addColumn('driver_checks', 'person_hash', 'TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS driver_checks_person ON driver_checks(person_hash)`);
addColumn('drivers', 'verified_at', 'INTEGER');    // checks approved and still valid: riders see "Verified"
// What the RDW said about a car, for the taxi check in the Netherlands; asked again after a day.
addColumn('cars', 'rdw_taxi', 'INTEGER');
addColumn('cars', 'rdw_insured', 'INTEGER');
addColumn('cars', 'rdw_apk_until', 'TEXT');
addColumn('cars', 'rdw_kind', 'TEXT');
addColumn('cars', 'rdw_found', 'INTEGER');
addColumn('cars', 'rdw_checked_at', 'INTEGER');
addColumn('cars', 'rdw_exported', 'INTEGER');
// The plate read from the car's back photo by the real app (anyone can type a taxi's plate), or a person who looked instead.
addColumn('cars', 'plate_seen', 'INTEGER');
addColumn('cars', 'plate_ok_by', 'TEXT');
// How a document got here: signed by the real app (App Attest), and taken with the camera rather than picked from the library.
addColumn('driver_checks', 'ck_attested', 'INTEGER');
addColumn('driver_checks', 'ck_camera', 'INTEGER');
addColumn('driver_checks', 'permit_attested', 'INTEGER');
addColumn('driver_checks', 'permit_camera', 'INTEGER');
addColumn('driver_checks', 'kvk_names', 'TEXT');      // every name KvK has for the business, as JSON
addColumn('driver_checks', 'asked_again', 'TEXT');    // what a person asked to have sent again (id, face, …), until it's all in again
// The live database also has ck_sent, permit_sent and kvk_sent, from a first try at asking for a document again by itself (8 November
// 2026): unused, as only a person asks again.
// Short links on the website (links.js): where each goes, and its clicks counted per day, kind of phone and country. Nothing about a
// person: no address, no cookie, no time of day.
db.exec(`
CREATE TABLE IF NOT EXISTS short_links (
  slug TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_click_at INTEGER
);
CREATE TABLE IF NOT EXISTS short_link_clicks (
  slug TEXT NOT NULL,
  day TEXT NOT NULL,       -- YYYY-MM-DD, Amsterdam time
  phone TEXT NOT NULL,     -- iphone | android | other | preview (a chat app making a preview, or a bot)
  country TEXT NOT NULL,   -- Cloudflare's two letters, or '' when it didn't say
  n INTEGER NOT NULL,
  PRIMARY KEY (slug, day, phone, country)
);
`);
addColumn('short_links', 'android_target', 'TEXT');   // where an Android phone goes instead, if anywhere else

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
export const get = (sql, ...args) => stmt(sql).get(...args);
export const all = (sql, ...args) => stmt(sql).all(...args);
export const run = (sql, ...args) => stmt(sql).run(...args);

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomId(length) {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
export const uid = (prefix = '') => `${prefix}${randomId(14)}`;

// The clock, so tests can move time.
let offset = 0;
export const now = () => Date.now() + offset;
export const moveClock = (ms) => { offset += ms; tellEdges('clock', offset); };
export const setClock = (to) => { offset = to; };

export function getMeta(key) { return get('SELECT value FROM meta WHERE key = ?', key)?.value ?? ''; }
export function setMeta(key, value) {
  if (value) run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  else run('DELETE FROM meta WHERE key = ?', key);
}

// A helper process (edge.js) only reads: anything that tries to write there is a mistake, and should say so.
if (process.env.DRIVEZZZ_ROLE === 'edge') db.exec('PRAGMA query_only = ON');
