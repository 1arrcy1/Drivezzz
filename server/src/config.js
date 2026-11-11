// The rules of Drivezzz in one place. Times in ms, distances in metres unless the name says otherwise.
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  baseUrl: process.env.BASE_URL || 'https://drivezzz.s3rver.nl',
  dev: process.env.DEV === '1',            // adds /dev routes; never on the live server
  // No chain and no contract: paying is pretended and no money moves. For tests (with DEV), and with PRETEND_CHAIN=1 for trying
  // the whole app on the live server before the contract is deployed. It refuses to run next to a real contract (escrow.js).
  pretendChain: (process.env.DEV === '1' && process.env.ESCROW_FAKE === '1') || process.env.PRETEND_CHAIN === '1',
  jobs: process.env.JOBS !== '0',          // background timers; tests call them by hand
  osrmUrl: process.env.OSRM_URL ?? 'https://router.project-osrm.org',
  rdwUrl: process.env.RDW_URL ?? 'https://opendata.rdw.nl/resource/m9d7-ebf2.json',
  apns: { keyFile: process.env.APNS_KEY_FILE || '', keyId: process.env.APNS_KEY_ID || '', teamId: process.env.APNS_TEAM_ID || '', topic: 'eu.drivezzz.app' },
  // Android push: a Firebase service account key file (push.js). FCM_URL only for tests, which answer as Google would.
  fcm: { keyFile: process.env.FCM_KEY_FILE || '', url: process.env.FCM_URL || '' },
  // The ride escrow on Solana (contract/): its address, the key that picks outcomes (a Solana CLI key file, never
  // printed), and where Drivezzz's €0.10 goes. The network (devnet or mainnet) is the admin's switch, as before.
  // Driver checks in the Netherlands (checks.js). Tests turn them off unless they test them (test/helpers.js).
  checks: {
    // Only in the Netherlands at launch (Pieter's decision, 5 November 2026): going online and ordering need a spot there.
    onlyNetherlands: process.env.ONLY_NETHERLANDS !== '0',
    // A car in the Netherlands needs the checks before it goes online.
    required: process.env.NL_CHECKS !== '0',
    // A pretend pass for anyone, on the test server and in tests: POST /api/checks/fake, and pretend plates count.
    fake: process.env.CHECKS_FAKE === '1' || (process.env.CHECKS_FAKE !== '0' && process.env.DEV === '1' && process.env.ESCROW_FAKE === '1'),
    // The live server on a pretend chain does the real checks (Pieter, 5 November 2026: "i want to move to live"). Only its own
    // pretend drivers, on this machine, still pass pretend; on the real network nobody does.
    fakeLocal: process.env.CHECKS_FAKE !== '0' && process.env.PRETEND_CHAIN === '1',
    // KvK's API (https://developers.kvk.nl). Without a key the number is only kept, and a person can look it up.
    kvkUrl: process.env.KVK_URL || 'https://api.kvk.nl/api/v1/basisprofielen',
    kvkKey: process.env.KVK_API_KEY || '',
  },
  escrow: {
    programId: process.env.ESCROW_PROGRAM_ID || '',
    keyFile: process.env.ESCROW_KEY_FILE || (process.env.CREDENTIALS_DIRECTORY ? `${process.env.CREDENTIALS_DIRECTORY}/escrow` : '/root/drivezzz-escrow-key.json'),
    feeAddress: process.env.ESCROW_FEE_ADDRESS || '6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN',
    // The contract's settings admin, for changing the fee address from the panel. It has no right to update the program.
    adminKeyFile: process.env.ESCROW_ADMIN_KEY_FILE || (process.env.CREDENTIALS_DIRECTORY ? `${process.env.CREDENTIALS_DIRECTORY}/escrow-admin` : '/root/drivezzz-deploy-key.json'),
  },
};

export const rules = {
  maxRadiusKm: 40,                 // the furthest a rider or driver can look, and a driver can be sent from
  defaultRadiusKm: 10,             // what they see until they choose
  driversShown: 50,                // how many drivers a rider can choose from, in the list and in a quote; the app's map shows the 5 cheapest
  maxDriversShown: 200,            // the most they can choose: a phone has to draw each one
  riderCancelShare: 0.5,           // a rider cancelling a ride a driver took: the driver gets this part of the price
  planCancelFree: 3 * HOUR,        // a planned ride with a driver can be cancelled for free until this long before
  onlineTimeout: 3 * MIN,          // no heartbeat for this long and a driver is offline
  bookableWindow: DAY,             // a driver can be planned when last online within this
  // Pieter, 8 November 2026: drivers should be seen moving on riders' maps, and a rider waiting should see their driver come.
  locationEverySec: 15,            // online and moving, waiting for rides: riders' maps show them move (about 500 KB an hour)
  locationOnlineStillEverySec: 45, // online and standing: only to say they're still there (onlineTimeout is 4 of these)
  locationIdleEverySec: 300,       // someone just looking, not online and without a ride: nothing needs their position, and thousands add up
  locationRideEverySec: 5,         // coming to the pickup or on a ride, and moving: the rider sees the car come (about 1 MB an hour)
  locationStillEverySec: 15,       // on a ride but standing: at a light, or waiting at the pickup, and it can still be compared with the other phone
  sameSpotWithin: 15,              // GPS wobbles, also standing still: a phone this close to its last position hasn't moved
  sameSpotRefresh: 30_000,         // it's still noted that it's there this often, so it doesn't count as gone
  checkInRadius: 100,              // rider and driver both within this to check in
  arrivedRadius: 100,              // driver this close to the pickup has arrived: from then on a rider cancelling pays half
  leftPickupRadius: 150,           // and has only left it again beyond this: GPS wobbles, and a car may move up a little
  checkOutRadius: 200,             // the driver this close to the drop-off to check out (Pieter, 8 November 2026: 200 m; was 250, then 150 for a moment)
  claimRadius: 300,                // a driver who never came this close can't be paid
  locationFresh: 2 * MIN,          // older positions don't count for check-in or check-out
  offerTime: 5 * MIN,              // a driver has this long to accept; not answering puts them offline
  autoCushion: 1.25,               // "cheapest" holds up to this much, so the next driver can take it
  minFareCents: 50,
  feeCents: 10,                    // Drivezzz's part of a ride paid out in full, from the driver's payout
  payNow: 5 * MIN,                 // a rider pays a ride-now within this of a driver taking it
  pickupSlack: 1.3,                // a driver's time to the pickup: the time it takes times this, plus payNow
  riderNoShow: 10 * MIN,           // stopped at the pickup this long, a driver can cancel for half the price
  stoppedBelowMps: 1,              // the phone's speed under which a car counts as stopped
  payPlannedBefore: 30 * MIN,      // a planned ride is paid at the latest this long before its time
  noCheckOut: DAY,                 // no check-out this long after the expected arrival: refunded, unless the driver appeals
  driverDefault: 0.6,              // a driver's appeal where this share of the route was driven pays the driver by default
  checkOutWarn: 500,               // the rider's phone further from the drop-off than this at check-out: both get a heads-up
  planBuffer: 5 * MIN,             // spare time between two planned drives
  planFirstLook: 30 * MIN,         // a driver the rider chose has a planned order to themselves this long, then any driver can claim it
  planNoticeBefore: 30 * MIN,      // the driver is reminded of a planned drive
  planStart: 20 * MIN,             // a planned drive becomes a live one this long before its time
  planNoShow: 10 * MIN,            // driver still not there this long after the planned time: passed on
  maxPlanDays: 7,                  // the furthest ahead any ride can be planned; each driver can set less
  openExpiry: 2 * HOUR,            // a ride-now order nobody claims
  arrivalGrace: 3 * MIN,           // on time when within this of the promised time
  syncPair: 60_000,                // two positions this close in time can be compared
  syncDistance: 300,               // rider and driver further apart than this are out of sync
  syncFastestMps: 35,              // plus how far a car can get since the other phone's last position
  syncAlertAfter: 8,               // this many samples in a row out of sync (about 2 minutes): ask the rider
  offRouteDistance: 1000,
  offRouteAlertAfter: 12,
  payoutAfter: DAY,                // after check-out: then the escrow pays out, unless someone appealed
  // The escrow refunds the rider by itself after this, whatever happened (the contract's own timeout; 10 minutes on devnet).
  escrowTimeout: Number(process.env.ESCROW_TIMEOUT_MS) || 30 * DAY,
  disputeAutoAfter: 3 * DAY,       // a driver's undecided appeal after most of the way pays the driver after this
  // The face match on the phone (SFace, cosine similarity of 128 numbers). Two photos of one person usually score 0.4 to 0.8 on it,
  // two people under 0.3 (OpenCV's own line is 0.363). At or above this it passes by itself; below, a person compares.
  faceAutoMatch: 0.40,
  cardYears: 5,                    // how long a chauffeurskaart lasts: a date further away isn't one
  kvkRecheck: 30 * DAY,            // an ended KvK registration ends the taxi permit with it
  checksFilesKept: 30 * DAY,       // photos of the chauffeurskaart and permit, after the decision
  checksWarnBefore: 30 * DAY,      // a driver hears this long before their ID, chauffeurskaart or permit runs out
  rdwFresh: DAY,                   // what the RDW said about a car counts this long
  maxStrikes: 3,
  messagesInARow: 3,               // to a driver, before they can reply; and at most this many before a reply
  banWeek: 7 * DAY,
  appealEvery: DAY,
  keepPointsDays: 90,               // ride positions are deleted after this
  keepOnlineDays: 30,               // when a driver was online: only the last two weeks are used
  keepSupportDays: 365,             // answered messages from the support page
};

export const DRIVER_DEFAULTS = { perKmCents: 90, perMinCents: 20, pickupPerKmCents: 50 };
export const RATE_LIMITS = { perKmCents: 2000, perMinCents: 500, pickupPerKmCents: 2000 };
