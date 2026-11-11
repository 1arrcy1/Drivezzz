import fs from 'node:fs';
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function metres(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export const validPoint = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// Google's polyline format, precision 5: what OSRM answers with and the app draws.
export function decodePolyline(text) {
  const points = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do { b = text.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length) {
    lat += next();
    lng += next();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}
export function encodePolyline(points) {
  let out = '', pLat = 0, pLng = 0;
  const put = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    out += String.fromCharCode(n + 63);
  };
  for (const [lat, lng] of points) {
    const a = Math.round(lat * 1e5), b = Math.round(lng * 1e5);
    put(a - pLat);
    put(b - pLng);
    pLat = a;
    pLng = b;
  }
  return out;
}

// How far a point is from a line of points, on a flat approximation (fine for a kilometre or so).
export function metresToLine(lat, lng, points) {
  if (!points.length) return Infinity;
  if (points.length === 1) return metres(lat, lng, points[0][0], points[0][1]);
  const kx = Math.cos(rad(lat)) * 111320, ky = 110540;
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const ax = (points[i - 1][1] - lng) * kx, ay = (points[i - 1][0] - lat) * ky;
    const bx = (points[i][1] - lng) * kx, by = (points[i][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// The square around a spot, as lowest and highest latitude and longitude: for finding what's near with an index, before measuring.
export function squareAround(lat, lng, radiusM) {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
}

// Inside European Netherlands, or within 2 km of its edge (a ferry, a beach, the border's last street). The border is Natural
// Earth's, simplified to about 300 m (nl-border.json): good enough to tell the Netherlands from Belgium and Germany, not for a
// street on the border itself. The Caribbean Netherlands have their own transport law and aren't in it.
const NL = JSON.parse(fs.readFileSync(new URL('./nl-border.json', import.meta.url), 'utf8')).polygons.map((ring) => {
  const lats = ring.map((p) => p[1]), lngs = ring.map((p) => p[0]);
  return { ring, latLng: ring.map(([x, y]) => [y, x]), minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
});
const NL_MARGIN_M = 2000;
function insideRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function inNetherlands(lat, lng) {
  if (!validPoint(lat, lng)) return false;
  const pad = 0.03;   // about 2 km, in degrees, for the quick test
  for (const p of NL) {
    if (lat < p.minLat - pad || lat > p.maxLat + pad || lng < p.minLng - pad * 1.6 || lng > p.maxLng + pad * 1.6) continue;
    if (insideRing(lat, lng, p.ring) || metresToLine(lat, lng, p.latLng) <= NL_MARGIN_M) return true;
  }
  return false;
}
