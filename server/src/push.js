// Apple push over HTTP/2 with a .p8 key, without packages. Set APNS_KEY_FILE, APNS_KEY_ID and APNS_TEAM_ID;
// without them nothing is sent and the app hears everything through /api/sync.
// Android phones are pushed through Firebase Cloud Messaging (FCM_KEY_FILE, below): a phone's token says which (`push_env`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import { config } from './config.js';
import { get, run } from './db.js';
import { bump } from './sync.js';

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
let key = null;
const { keyFile, keyId, teamId, topic } = config.apns;
if (keyFile && keyId && teamId) {
  try { key = crypto.createPrivateKey(fs.readFileSync(keyFile)); } catch (e) { console.error(`[drivezzz] Push off: can't read ${keyFile}: ${e.message}`); }
}

let jwt = null, jwtAt = 0;
function bearer() {
  if (jwt && Date.now() - jwtAt < 40 * 60_000) return jwt;
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${part({ alg: 'ES256', kid: keyId })}.${part({ iss: teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwt = `${unsigned}.${sig}`;
  jwtAt = Date.now();
  return jwt;
}

const sessions = {};
function session(env) {
  const s = sessions[env];
  if (s && !s.closed && !s.destroyed) return s;
  const fresh = http2.connect(HOSTS[env]);
  fresh.on('error', () => { sessions[env] = null; });
  fresh.unref();
  sessions[env] = fresh;
  return fresh;
}

// ---------- Android: Firebase Cloud Messaging, its HTTP v1 API ----------
// FCM_KEY_FILE is the Firebase project's service account key (a JSON file from the Firebase console: Project settings, Service
// accounts), root only, never printed. Without it Android phones aren't pushed and the app says things itself while it runs.
let fcm = null;
if (config.fcm.keyFile) {
  try {
    const k = JSON.parse(fs.readFileSync(config.fcm.keyFile, 'utf8'));
    fcm = {
      email: k.client_email, key: crypto.createPrivateKey(k.private_key),
      tokenUri: k.token_uri || 'https://oauth2.googleapis.com/token',
      sendUrl: `${config.fcm.url || 'https://fcm.googleapis.com'}/v1/projects/${k.project_id}/messages:send`,
    };
  } catch (e) { console.error(`[drivezzz] Android push off: can't read ${config.fcm.keyFile}: ${e.message}`); }
}

// A Google access token for FCM, from a JWT signed with the service account's key; kept until five minutes before it ends.
let fcmAccess = null, fcmAccessUntil = 0, fcmAsking = null;
function fcmBearer() {
  if (fcmAccess && Date.now() < fcmAccessUntil) return Promise.resolve(fcmAccess);
  fcmAsking ??= (async () => {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: fcm.email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: fcm.tokenUri, iat, exp: iat + 3600 })}`;
    const sig = crypto.sign('sha256', Buffer.from(unsigned), fcm.key).toString('base64url');
    const r = await fetch(fcm.tokenUri, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(10_000),
    });
    const answer = await r.json().catch(() => ({}));
    if (!r.ok || !answer.access_token) throw new Error(`no access token: ${r.status} ${answer.error ?? ''}`);
    fcmAccess = answer.access_token;
    fcmAccessUntil = Date.now() + Math.max(60, (answer.expires_in ?? 3600) - 300) * 1000;
    return fcmAccess;
  })().finally(() => { fcmAsking = null; });
  return fcmAsking;
}

async function sendFcm(user, title, body, data) {
  try {
    // FCM only carries text in `data`. The channel is the app's own "Rides and messages" (Notifier.RIDES).
    const message = {
      token: user.push_token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
      android: { priority: 'HIGH', notification: { channel_id: 'rides', sound: 'default' } },
    };
    const r = await fetch(fcm.sendUrl, {
      method: 'POST', headers: { authorization: `Bearer ${await fcmBearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }), signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return;
    const answer = await r.text();
    console.error(`[drivezzz] Android push refused: ${r.status} ${answer.slice(0, 300)}`);
    if (r.status === 401) fcmAccess = null;
    // This phone is gone (uninstalled, or a token FCM doesn't know): it registers again the next time the app opens.
    if (r.status === 404 || answer.includes('UNREGISTERED') || (r.status === 400 && /registration token/i.test(answer))) {
      run('UPDATE users SET push_token = NULL, push_env = NULL WHERE id = ? AND push_token = ?', user.id, user.push_token);
    }
  } catch (e) {
    console.error('[drivezzz] Android push:', e.message);
  }
}

function send(user, title, body, data) {
  if (!user?.push_token) return;
  // An Android phone's token never goes to Apple.
  if (user.push_env === 'fcm') { if (fcm) sendFcm(user, title, body, data); return; }
  if (!key) return;
  const env = user.push_env === 'sandbox' ? 'sandbox' : 'production';
  try {
    const req = session(env).request({
      ':method': 'POST', ':path': `/3/device/${user.push_token}`,
      authorization: `bearer ${bearer()}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10',
    });
    let status, answer = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (d) => { answer += d; });
    req.on('end', () => {
      if (status === 200) return;
      console.error(`[drivezzz] push refused: ${status} ${answer}`);
      // This phone is gone: it registers again the next time the app opens.
      if (status === 410 || answer.includes('BadDeviceToken')) run('UPDATE users SET push_token = NULL, push_env = NULL WHERE id = ? AND push_token = ?', user.id, user.push_token);
    });
    req.on('error', (e) => console.error('[drivezzz] push:', e.message));
    req.end(JSON.stringify({ aps: { alert: { title, body }, sound: 'default' }, ...data }));
  } catch (e) {
    console.error('[drivezzz] push:', e.message);
  }
}

// Whether this server can push a phone of this kind ('fcm' is Android, anything else Apple). Without it the app says things itself.
export const pushOn = (env) => Boolean(env === 'fcm' ? fcm : key);

// Tells someone something: their app wakes through /api/sync, and a push reaches a closed one.
export function notify(userId, title, body, data = {}) {
  if (!userId) return;
  bump(userId);
  send(get('SELECT id, push_token, push_env FROM users WHERE id = ?', userId), title, body, data);
}
