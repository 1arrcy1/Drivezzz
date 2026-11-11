// What a Dutch number plate says about a car, from the RDW's open register: make, model, colour, body and
// seats. This is what the app draws the generated pictures from, and it shows the plate is real. In the Netherlands a car must
// also be registered as a taxi, insured and through its APK to drive (`register`, checks.js).
import { config } from './config.js';

const COLOURS = {
  ZWART: ['Black', '#1C1C1E'], WIT: ['White', '#F4F4F2'], GRIJS: ['Grey', '#8A8D91'], BLAUW: ['Blue', '#1F4E9E'],
  ROOD: ['Red', '#B3202A'], GROEN: ['Green', '#2C6B47'], GEEL: ['Yellow', '#E6B422'], ORANJE: ['Orange', '#D9711C'],
  BRUIN: ['Brown', '#6B4A32'], BEIGE: ['Beige', '#C8B898'], PAARS: ['Purple', '#5C3A82'], ROSE: ['Pink', '#D98BA6'],
  CREME: ['Cream', '#E8E0C8'], DIVERSEN: ['Silver', '#B8BBBF'], 'N.V.T.': ['Silver', '#B8BBBF'],
};

export function bodyFrom(inrichting = '', seats = 5) {
  const s = inrichting.toLowerCase();
  if (s.includes('hatchback')) return 'hatchback';
  if (s.includes('sedan') || s.includes('coach') || s.includes('cabrio')) return 'sedan';
  if (s.includes('stationwagen') || s.includes('combi')) return 'estate';
  if (s.includes('terrein') || s.includes('suv')) return 'suv';
  if (s.includes('mpv')) return 'mpv';
  if (s.includes('gesloten') || s.includes('bestel') || s.includes('bus')) return 'van';
  return seats > 5 ? 'mpv' : 'hatchback';
}

export const VEHICLES = ['car', 'motor', 'scooter'];
// A motor or scooter takes one passenger, whatever the register says or an older app sends.
export const seatsOn = (vehicle, seats) => (vehicle === 'car' ? seats : 1);
export function vehicleFrom(soort = '') {
  const s = soort.toLowerCase();
  if (s.includes('motorfiets')) return 'motor';
  if (s.includes('bromfiets') || s.includes('snorfiets')) return 'scooter';
  return 'car';
}

export const cleanPlate = (raw) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

// Sidecode with dashes, the way plates read: 12-ABC-3. Only for showing.
export function prettyPlate(plate) {
  const groups = plate.match(/[A-Z]+|[0-9]+/g) ?? [plate];
  if (groups.length >= 3 || plate.length !== 6) return groups.join('-');
  return `${plate.slice(0, 2)}-${plate.slice(2, 4)}-${plate.slice(4)}`;
}

// Text read from a photo, against a plate: letters a camera mixes up with digits count as the same. Dutch plates have no vowels.
const SAME = { O: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8' };
const looseText = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[OQILZSB]/g, (c) => SAME[c]);
export const plateInText = (plate, read) => Boolean(plate) && looseText(read).includes(looseText(plate));

const titleCase = (s) => String(s ?? '').toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());

export async function lookupPlate(raw) {
  return (await lookupRegister(raw)).found;
}

// The same, telling "not in the register" (reached, found null) from "the register didn't answer" (reached false).
export async function lookupRegister(raw) {
  const plate = cleanPlate(raw);
  if (plate.length < 4 || !config.rdwUrl) return { reached: Boolean(config.rdwUrl), found: null };
  let v;
  try {
    const r = await fetch(`${config.rdwUrl}?kenteken=${encodeURIComponent(plate)}&$limit=1`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { reached: false, found: null };
    v = (await r.json())?.[0];
  } catch {
    return { reached: false, found: null };
  }
  if (!v) return { reached: true, found: null };
  return { reached: true, found: fromRegister(plate, v) };
}

function fromRegister(plate, v) {
  const vehicle = vehicleFrom(v.voertuigsoort);
  const seatsTotal = Number(v.aantal_zitplaatsen) || (vehicle === 'car' ? 5 : 2);
  const colour = COLOURS[v.eerste_kleur] ?? COLOURS.DIVERSEN;
  return {
    plate,
    vehicle,
    make: titleCase(v.merk),
    model: titleCase(v.handelsbenaming),
    colorName: colour[0],
    colorHex: colour[1],
    body: bodyFrom(v.inrichting, seatsTotal),
    seats: seatsOn(vehicle, Math.max(1, seatsTotal - 1)),
    year: Number(String(v.datum_eerste_toelating ?? '').slice(0, 4)) || null,
    verified: true,
    // For the taxi check in the Netherlands (checks.js): what the register says today.
    register: {
      kind: v.voertuigsoort ?? null,
      passengerCar: v.voertuigsoort === 'Personenauto',
      taxi: v.taxi_indicator === 'Ja',
      insured: v.wam_verzekerd === 'Ja',
      apkUntil: /^\d{8}$/.test(v.vervaldatum_apk ?? '') ? `${v.vervaldatum_apk.slice(0, 4)}-${v.vervaldatum_apk.slice(4, 6)}-${v.vervaldatum_apk.slice(6, 8)}` : null,
      exported: v.export_indicator === 'Ja',
      recall: v.openstaande_terugroepactie_indicator === 'Ja',
      seats: Number(v.aantal_zitplaatsen) || null,
    },
  };
}
