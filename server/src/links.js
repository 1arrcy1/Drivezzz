// Short links on the website: drivezzz.s3rver.nl/<name> sends a visitor on to wherever the admin panel's Links tab points it (a 302,
// so changing it works at once), an Android phone to its own address if the link has one, and counts the click. Counted per day, kind of phone and country (Cloudflare's CF-IPCountry): no
// address, no cookie, nothing about a person (privacy.html, This website). A preview a chat app or a bot fetches is counted apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, getMeta, now, run, setMeta, tx } from './db.js';
import { ApiError, clientIp } from './http.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Taken by the site itself, now or likely later.
const RESERVED = new Set(['api', 'admin', 'cdn-cgi', 'index', 'nl', 'en', 'dev', 'well-known']);

// The first one, which Pieter asked for (10 November 2026): the App Store, and Android phones to the website's Android part, as the
// app is still in testing there. Made once: if it's removed on the panel, it stays gone.
if (!getMeta('links:seeded')) {
  run('INSERT OR IGNORE INTO short_links (slug, target, android_target, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'shortlink',
    'https://apps.apple.com/nl/app/drivezzz/id6829689681', 'https://drivezzz.s3rver.nl/#android', now(), now());
  setMeta('links:seeded', '1');
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayOf = (t) => dayFormat.format(new Date(t));

const PREVIEW = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebot|whatsapp|telegram|slack|discord|linkedin|skype|pinterest|embedly|preview|curl\/|wget|python|go-http|okhttp|headless|lighthouse/i;
export function phoneOf(ua = '') {
  if (!ua || PREVIEW.test(ua)) return 'preview';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iphone';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

// A tap that loads twice, or a reload, is one click: the same address and browser within a minute. Only in memory, and only that long.
const recent = new Map();
setInterval(() => { const t = Date.now(); for (const [k, at] of recent) if (t - at > 60_000) recent.delete(k); }, 300_000).unref();

function count(slug, req) {
  const ua = String(req.headers['user-agent'] ?? '');
  const key = `${slug}|${clientIp(req)}|${ua}`;
  const t = Date.now();
  if (t - (recent.get(key) ?? 0) < 60_000) return;
  recent.set(key, t);
  const phone = phoneOf(ua);
  const country = /^[A-Z][A-Z0-9]$/.test(req.headers['cf-ipcountry'] ?? '') && req.headers['cf-ipcountry'] !== 'XX' ? req.headers['cf-ipcountry'] : '';
  run(`INSERT INTO short_link_clicks (slug, day, phone, country, n) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(slug, day, phone, country) DO UPDATE SET n = n + 1`, slug, dayOf(now()), phone, country);
  if (phone !== 'preview') run('UPDATE short_links SET last_click_at = ? WHERE slug = ?', now(), slug);
}

// For http.js, once nothing else had this path: true when it was a short link and the visitor is on their way.
export function followLink(req, res, pathname) {
  const slug = pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!SLUG.test(slug)) return false;
  const link = get('SELECT target, android_target FROM short_links WHERE slug = ?', slug);
  if (!link) return false;
  if (req.method === 'GET') count(slug, req);
  const android = link.android_target && phoneOf(String(req.headers['user-agent'] ?? '')) === 'android';
  res.writeHead(302, { Location: android ? link.android_target : link.target, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end();
  return true;
}

// ---------- the admin panel's Links tab (admin.js) ----------

export function linkList() {
  const today = dayOf(now());
  const days = [...Array(30)].map((_, i) => dayOf(now() - (29 - i) * 86400_000));
  const week = new Set(days.slice(-7));
  return all('SELECT * FROM short_links ORDER BY created_at').map((l) => {
    const rows = all('SELECT day, phone, country, n FROM short_link_clicks WHERE slug = ?', l.slug);
    const clicks = rows.filter((r) => r.phone !== 'preview');
    const sum = (list) => list.reduce((s, r) => s + r.n, 0);
    const perDay = new Map(days.map((d) => [d, 0]));
    const phones = { iphone: 0, android: 0, other: 0 };
    const countries = new Map();
    for (const r of clicks) {
      if (perDay.has(r.day)) perDay.set(r.day, perDay.get(r.day) + r.n);
      phones[r.phone] += r.n;
      countries.set(r.country, (countries.get(r.country) ?? 0) + r.n);
    }
    return {
      slug: l.slug,
      target: l.target,
      androidTarget: l.android_target,
      createdAt: l.created_at,
      updatedAt: l.updated_at,
      lastClickAt: l.last_click_at,
      total: sum(clicks),
      today: sum(clicks.filter((r) => r.day === today)),
      week: sum(clicks.filter((r) => week.has(r.day))),
      month: [...perDay.values()].reduce((s, n) => s + n, 0),
      previews: sum(rows.filter((r) => r.phone === 'preview')),
      days: [...perDay].map(([day, n]) => ({ day, n })),
      phones,
      countries: [...countries].sort((a, b) => b[1] - a[1]).map(([country, n]) => ({ country, n })),
    };
  });
}

function checkTarget(value) {
  const target = typeof value === 'string' ? value.trim() : '';
  let url;
  try { url = new URL(target); } catch { throw new ApiError(400, 'bad_target', 'Where it goes has to be a whole web address, starting with https://.'); }
  if (!['https:', 'http:'].includes(url.protocol) || target.length > 2000) throw new ApiError(400, 'bad_target', 'Where it goes has to be a whole web address, starting with https://.');
  return url.href;
}
function checkSlug(value) {
  const slug = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '').toLowerCase() : '';
  if (!SLUG.test(slug)) throw new ApiError(400, 'bad_slug', 'A name is up to 40 letters, digits and dashes, starting with a letter or digit.');
  if (RESERVED.has(slug) || fs.existsSync(path.join(PUBLIC, slug)) || fs.existsSync(path.join(PUBLIC, `${slug}.html`))) throw new ApiError(409, 'slug_taken', `The website already uses /${slug} itself.`);
  return slug;
}

// New, or a change to one: `was` is the name it had, so it can be renamed and keep its clicks. An empty `androidTarget` sends Android
// phones where the rest go. Returns what changed, for the log.
export function saveLink({ was, slug, target, androidTarget }) {
  const name = checkSlug(slug);
  const href = checkTarget(target);
  const android = typeof androidTarget === 'string' && androidTarget.trim() ? checkTarget(androidTarget) : null;
  return tx(() => {
    const old = was ? get('SELECT * FROM short_links WHERE slug = ?', String(was)) : null;
    if (was && !old) throw new ApiError(404, 'not_found', 'That link isn’t there any more.');
    if (name !== old?.slug && get('SELECT 1 FROM short_links WHERE slug = ?', name)) throw new ApiError(409, 'slug_taken', `There's already a link /${name}.`);
    if (!old) {
      run('INSERT INTO short_links (slug, target, android_target, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', name, href, android, now(), now());
      return { action: 'link_added', detail: `/${name} → ${href}${android ? `, Android → ${android}` : ''}` };
    }
    run('UPDATE short_links SET slug = ?, target = ?, android_target = ?, updated_at = ? WHERE slug = ?', name, href, android, now(), old.slug);
    if (name !== old.slug) run('UPDATE short_link_clicks SET slug = ? WHERE slug = ?', name, old.slug);
    const parts = [name !== old.slug && `/${old.slug} → /${name}`, href !== old.target && `${old.target} → ${href}`,
      android !== old.android_target && `Android: ${old.android_target ?? 'same'} → ${android ?? 'same'}`].filter(Boolean);
    return { action: 'link_changed', detail: parts.join(', ') || `/${name}` };
  });
}

export function removeLink(slug) {
  const link = get('SELECT * FROM short_links WHERE slug = ?', slug);
  if (!link) throw new ApiError(404, 'not_found', 'That link isn’t there any more.');
  tx(() => {
    run('DELETE FROM short_links WHERE slug = ?', slug);
    run('DELETE FROM short_link_clicks WHERE slug = ?', slug);
  });
  return link;
}
