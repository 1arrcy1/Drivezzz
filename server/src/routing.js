// Roads, through an OSRM server (OSRM_URL). When it can't be reached everything still works on straight
// lines: a fair guess at the distance, no correction of where you tapped.
import { config } from './config.js';
import { encodePolyline, metres } from './geo.js';

const ROAD_FACTOR = 1.3;
const FALLBACK_KMH = 35;

// The public demo server asks for light use, so answers are remembered for a while, and after a failure it gets a
// rest instead of making every quote wait for a timeout.
const answers = new Map();
const KEEP = 15 * 60_000;
let restUntil = 0;

async function osrm(path) {
  if (!config.osrmUrl) return null;
  const hit = answers.get(path);
  if (hit && Date.now() - hit.at < KEEP) return hit.json;
  if (Date.now() < restUntil) return null;
  try {
    const r = await fetch(`${config.osrmUrl}${path}`, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'drivezzz-server' } });
    if (!r.ok) {
      restUntil = Date.now() + 30_000;
      return null;
    }
    const json = await r.json();
    if (json.code !== 'Ok') return null;
    if (answers.size > 3000) answers.clear();
    answers.set(path, { at: Date.now(), json });
    return json;
  } catch {
    restUntil = Date.now() + 30_000;
    return null;
  }
}

const pair = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

// The closest spot on a road a car can stop at. `movedM` says how far the tapped spot moved.
export async function snap(point) {
  const res = await osrm(`/nearest/v1/driving/${pair(point)}?number=1`);
  const w = res?.waypoints?.[0];
  if (!w) return { lat: point.lat, lng: point.lng, movedM: 0, road: null, snapped: false };
  const [lng, lat] = w.location;
  return { lat, lng, movedM: Math.round(metres(point.lat, point.lng, lat, lng)), road: w.name || null, snapped: true };
}

export async function route(from, to) {
  const res = await osrm(`/route/v1/driving/${pair(from)};${pair(to)}?overview=simplified&geometries=polyline&alternatives=false&steps=false`);
  const r = res?.routes?.[0];
  if (r) return { distanceM: Math.round(r.distance), durationS: Math.round(r.duration), polyline: r.geometry, estimated: false };
  const straight = metres(from.lat, from.lng, to.lat, to.lng);
  const distanceM = Math.round(straight * ROAD_FACTOR);
  return {
    distanceM,
    durationS: Math.round(distanceM / (FALLBACK_KMH / 3.6)),
    polyline: encodePolyline([[from.lat, from.lng], [to.lat, to.lng]]),
    estimated: true,
  };
}

// From many points to one: [{distanceM, durationS}] in the same order.
export async function manyToOne(froms, to) {
  if (!froms.length) return [];
  const coords = [...froms, to].map(pair).join(';');
  const sources = froms.map((_, i) => i).join(';');
  const res = await osrm(`/table/v1/driving/${coords}?sources=${sources}&destinations=${froms.length}&annotations=distance,duration`);
  return froms.map((f, i) => {
    const d = res?.distances?.[i]?.[0], s = res?.durations?.[i]?.[0];
    if (d != null && s != null) return { distanceM: Math.round(d), durationS: Math.round(s) };
    const m = Math.round(metres(f.lat, f.lng, to.lat, to.lng) * ROAD_FACTOR);
    return { distanceM: m, durationS: Math.round(m / (FALLBACK_KMH / 3.6)) };
  });
}
