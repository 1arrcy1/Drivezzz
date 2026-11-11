// The End User Licence Agreement: one text for the website and the app, and an account that keeps which version was accepted.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { client, startServer } from './helpers.js';

let srv, admin;

before(async () => {
  srv = await startServer();
  admin = client(srv.base);
  assert.equal((await admin.post('/admin/api/login', { email: 'admin@test.local', password: 'admin' })).status, 200);
  assert.equal((await admin.post('/admin/api/password', { current: 'admin', password: 'test-admin-new' })).status, 200);
});
after(() => srv.stop());

const fresh = async () => (await client(srv.base).get('/api/eula'));

test('the app gets the website\'s words, as text it can show', async () => {
  const eula = await fresh();
  const page = await (await fetch(`${srv.base}/eula`)).text();
  assert.ok(Number.isInteger(eula.version) && eula.version >= 1);
  assert.match(eula.updated, /\d{4}$/);
  assert.ok(eula.short.length >= 5);
  assert.equal(eula.sections.length, (page.match(/<section id=/g)).length);
  for (const s of eula.sections) {
    assert.ok(page.includes(`id="${s.id}"`), s.id);
    assert.ok(s.title && s.blocks.length, s.id);
  }
  const words = JSON.stringify(eula);
  assert.doesNotMatch(words, /<\/?[a-z]/i, 'no HTML left');
  assert.doesNotMatch(words, /\]\(\//, 'every link works from the app');
  assert.doesNotMatch(words, /\]\(#/, 'no link to a place in the page');
  assert.match(words, /no tolerance for objectionable content or abusive users/i);
});

test('Apple\'s minimum terms are all there', async () => {
  const words = JSON.stringify((await fresh()).sections);
  for (const needed of [
    /between you and us only, not Apple/, /non-transferable licence/, /Usage Rules/, /Maintenance and support/, /refund the purchase price/,
    /product liability claims/, /Intellectual property/, /US Government embargo/, /support#reach/, /third-party beneficiaries/,
  ]) assert.match(words, needed);
  // The postal address is on the support page, not in the EULA (Pieter, 6 November 2026).
  assert.doesNotMatch(words, /\b\d{4} ?[A-Z]{2}\b/, 'no postcode, so no postal address');
});

test('Continue with the EULA accepted keeps the version and when, also for a phone that comes back', async () => {
  const { version } = await fresh();
  const started = Date.now();
  const phone = client(srv.base);
  const first = await phone.post('/api/auth/continue', { deviceId: phone.deviceId, eula: version });
  assert.equal(first.isNew, true);
  const shown = await admin.get(`/admin/api/users/${first.user.id}`);
  assert.equal(shown.eula.version, version);
  assert.ok(shown.eula.at >= started);

  const older = client(srv.base);
  const account = await older.start();
  assert.equal((await admin.get(`/admin/api/users/${account.user.id}`)).eula, null);
  const back = await older.post('/api/auth/continue', { deviceId: older.deviceId, eula: version });
  assert.equal(back.isNew, false);
  assert.equal(back.user.id, account.user.id);
  assert.equal((await admin.get(`/admin/api/users/${account.user.id}`)).eula.version, version);
});

test('an older version of the EULA makes no account', async () => {
  const { version } = await fresh();
  const phone = client(srv.base);
  const stale = await phone.call('POST', '/api/auth/continue', { deviceId: phone.deviceId, eula: version + 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.token, undefined);
});
