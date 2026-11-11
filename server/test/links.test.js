// Short links on the website (links.js) and the website in Dutch for visitors from the Netherlands (http.js, siteLanguage).
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

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; POCO X8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const WHATSAPP = 'WhatsApp/2.24.20.89 i';
const open = (path, headers = {}, method = 'GET') => fetch(`${srv.base}${path}`, { method, redirect: 'manual', headers });
const link = async (slug) => (await admin.get('/admin/api/links')).links.find((l) => l.slug === slug);

test('/shortlink goes to the App Store, and counts each phone once a minute', async () => {
  const r = await open('/shortlink', { 'User-Agent': IPHONE, 'CF-IPCountry': 'NL' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://apps.apple.com/nl/app/drivezzz/id6829689681');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  // An Android phone goes to the website's Android part, as the app is still in testing on Google Play.
  assert.equal((await open('/shortlink', { 'User-Agent': ANDROID, 'CF-IPCountry': 'BE' })).headers.get('location'), 'https://drivezzz.s3rver.nl/#android');
  // The same phone again at once (a reload, a double tap) is the same click; a capital or a slash at the end is the same link.
  assert.equal((await open('/ShortLink/', { 'User-Agent': IPHONE, 'CF-IPCountry': 'NL' })).status, 302);
  // A chat app making a preview, and a HEAD, aren't clicks.
  await open('/shortlink', { 'User-Agent': WHATSAPP });
  await open('/shortlink', { 'User-Agent': 'Mozilla/5.0 (Macintosh)' }, 'HEAD');
  const l = await link('shortlink');
  assert.equal(l.total, 2);
  assert.equal(l.today, 2);
  assert.equal(l.week, 2);
  assert.equal(l.month, 2);
  assert.equal(l.previews, 1);
  assert.deepEqual(l.phones, { iphone: 1, android: 1, other: 0 });
  assert.deepEqual(l.countries.map((c) => c.country).sort(), ['BE', 'NL']);
  assert.equal(l.days.length, 30);
  assert.equal(l.days.at(-1).n, 2);
  assert.ok(l.lastClickAt > 0);
});

test('the panel changes where a link goes, renames it with its clicks, and deletes it', async () => {
  assert.equal((await admin.post('/admin/api/links', { was: 'shortlink', slug: 'shortlink', target: 'https://example.com/ios', androidTarget: 'https://play.google.com/store/apps/details?id=eu.drivezzz.app' })).status, 200);
  assert.equal((await open('/shortlink', { 'User-Agent': IPHONE })).headers.get('location'), 'https://example.com/ios');
  assert.equal((await open('/shortlink', { 'User-Agent': ANDROID })).headers.get('location'), 'https://play.google.com/store/apps/details?id=eu.drivezzz.app');
  assert.equal((await link('shortlink')).androidTarget, 'https://play.google.com/store/apps/details?id=eu.drivezzz.app');
  // Empty: Android goes where the rest go.
  assert.equal((await admin.post('/admin/api/links', { was: 'shortlink', slug: 'shortlink', target: 'https://example.com/ios', androidTarget: '' })).status, 200);
  assert.equal((await open('/shortlink', { 'User-Agent': ANDROID + ' again' })).headers.get('location'), 'https://example.com/ios');
  assert.equal((await admin.post('/admin/api/links', { was: 'shortlink', slug: 'shortlink', target: 'https://example.com/ios', androidTarget: 'ftp://x' })).code, 'bad_target');

  assert.equal((await admin.post('/admin/api/links', { was: 'shortlink', slug: 'get', target: 'https://apps.apple.com/nl/app/drivezzz/id6829689681' })).status, 200);
  assert.equal((await open('/shortlink')).status, 404);
  assert.equal((await open('/get')).headers.get('location'), 'https://apps.apple.com/nl/app/drivezzz/id6829689681');
  assert.ok((await link('get')).total >= 2);

  // What the site has itself, a name already used, and an address that isn't one are refused.
  assert.equal((await admin.post('/admin/api/links', { slug: 'support', target: 'https://example.com' })).code, 'slug_taken');
  assert.equal((await admin.post('/admin/api/links', { slug: 'api', target: 'https://example.com' })).code, 'slug_taken');
  assert.equal((await admin.post('/admin/api/links', { slug: 'get', target: 'https://example.com' })).code, 'slug_taken');
  assert.equal((await admin.post('/admin/api/links', { slug: 'x', target: 'javascript:alert(1)' })).code, 'bad_target');
  assert.equal((await admin.post('/admin/api/links', { slug: 'no spaces', target: 'https://example.com' })).code, 'bad_slug');
  assert.equal((await admin.post('/admin/api/links', { slug: 'insta', target: 'https://example.com/a' })).status, 200);
  assert.equal((await open('/insta')).headers.get('location'), 'https://example.com/a');

  const log = (await admin.get('/admin/api/log')).log.map((l) => l.action);
  assert.ok(log.includes('link_changed') && log.includes('link_added'));
  assert.equal((await admin.post('/admin/api/links/insta/remove')).status, 200);
  assert.equal((await open('/insta')).status, 404);
  assert.equal(await link('insta'), undefined);

  // Only for the admin.
  assert.equal((await client(srv.base).get('/admin/api/links')).status, 401);
  assert.equal((await client(srv.base).post('/admin/api/links', { slug: 'evil', target: 'https://example.com' })).status, 401);
});

test('the website is Dutch for visitors from the Netherlands and English for everyone else', async () => {
  const lang = async (path, headers) => {
    const r = await open(path, headers);
    assert.equal(r.status, 200);
    const html = await r.text();
    const of = /<html lang="(\w+)"/.exec(html)[1];
    assert.equal(r.headers.get('content-language'), of);
    assert.equal(r.headers.get('set-cookie'), null);
    return of;
  };
  assert.equal(await lang('/', {}), 'en');
  assert.equal(await lang('/', { 'CF-IPCountry': 'NL' }), 'nl');
  assert.equal(await lang('/', { 'CF-IPCountry': 'BE', 'Accept-Language': 'nl-BE,nl;q=0.9' }), 'en');
  for (const page of ['/support', '/terms', '/privacy', '/eula']) assert.equal(await lang(page, { 'CF-IPCountry': 'NL' }), 'nl', page);
  // A link can ask for either.
  assert.equal(await lang('/?lang=en', { 'CF-IPCountry': 'NL' }), 'en');
  assert.equal(await lang('/support?lang=nl', {}), 'nl');
  // Dutch pages also have their own address, and what isn't a page is the same for both.
  assert.equal(await lang('/nl/terms', {}), 'nl');
  assert.equal((await open('/style.css', { 'CF-IPCountry': 'NL' })).headers.get('content-language'), null);
});
