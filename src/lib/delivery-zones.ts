import { has } from '@/lib/values';
import { isGeoPoint, straightLineKm, type GeoPoint } from '@/lib/geo';

/**
 * Delivery zones: named areas a delivery charge can depend on. Pure rules only. A written address reaches a zone through the
 * zone's areas; a pin reaches it through the zone's coverage circle. Either way the answer is one zone or none, never two.
 */

/**
 * A place name reduced to what it means, so "  Westlands, " and "WESTLANDS" are the same area: lower case, no accents, no
 * punctuation, single spaces. A trailing or leading "county" is dropped ("Nairobi County" is Nairobi).
 */
export function placeKey(text: string | null | undefined): string {
  if (!has(text)) return '';
  const plain = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return plain;
}

/** A county name as a key: as `placeKey`, without the word "county" around it. */
export function countyKey(text: string | null | undefined): string {
  return placeKey(text)
    .replace(/^county of /, '')
    .replace(/ county$/, '')
    .trim();
}

export interface AddressWords {
  county?: string | null;
  town?: string | null;
  area?: string | null;
}

export interface AddressKeys {
  countyKey: string;
  townKey: string;
  areaKey: string;
}

export const keysOf = (address: AddressWords): AddressKeys => ({ countyKey: countyKey(address.county), townKey: placeKey(address.town), areaKey: placeKey(address.area) });

export const hasAnyKey = (keys: AddressKeys): boolean => keys.countyKey !== '' || keys.townKey !== '' || keys.areaKey !== '';

export interface ZoneAreaRow extends AddressKeys {
  id: string;
  zoneId: string;
}

/**
 * How specific an area row is. The weights are powers of two, so an area always beats a town and a town beats a county, and no two
 * different combinations of words can score the same: with one area per set of words, a written address has one best answer.
 */
export function areaSpecificity(row: AddressKeys): number {
  return (row.areaKey === '' ? 0 : 4) + (row.townKey === '' ? 0 : 2) + (row.countyKey === '' ? 0 : 1);
}

/** The most specific area that covers the address. An empty word in a row covers anything; a word that is there must match. */
export function matchArea<Row extends ZoneAreaRow>(rows: readonly Row[], address: AddressWords): Row | null {
  const want = keysOf(address);
  if (!hasAnyKey(want)) return null;
  let best: Row | null = null;
  for (const row of rows) {
    const covers = (row.countyKey === '' || row.countyKey === want.countyKey) && (row.townKey === '' || row.townKey === want.townKey) && (row.areaKey === '' || row.areaKey === want.areaKey);
    if (!covers || !hasAnyKey(row)) continue;
    if (best === null || areaSpecificity(row) > areaSpecificity(best)) best = row;
  }
  return best;
}

export interface ZoneCircle {
  id: string;
  code: string;
  centre: GeoPoint | null;
  radiusKm: number | null;
}

/**
 * The zone whose coverage circle holds the pin. When circles overlap the nearest centre wins, then the smaller circle, then the
 * code, so a pin never has two answers and the same pin always gets the same one.
 */
export function zoneForPin<Zone extends ZoneCircle>(zones: readonly Zone[], pin: GeoPoint): { zone: Zone; distanceKm: number } | null {
  let best: { zone: Zone; distanceKm: number } | null = null;
  for (const zone of zones) {
    if (zone.centre === null || zone.radiusKm === null) continue;
    const distanceKm = straightLineKm(zone.centre, pin);
    if (distanceKm > zone.radiusKm) continue;
    if (best === null || beats({ distanceKm, zone }, best)) best = { zone, distanceKm };
  }
  return best;
}

function beats(a: { zone: ZoneCircle; distanceKm: number }, b: { zone: ZoneCircle; distanceKm: number }): boolean {
  if (a.distanceKm !== b.distanceKm) return a.distanceKm < b.distanceKm;
  const ra = a.zone.radiusKm ?? Number.POSITIVE_INFINITY;
  const rb = b.zone.radiusKm ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra < rb;
  return a.zone.code < b.zone.code;
}

export type ZoneMatch<Zone> = { by: 'pin'; zone: Zone; distanceKm: number } | { by: 'address'; zone: Zone; areaId: string } | null;

/**
 * Where a delivery goes. A pin that falls in a coverage circle decides (it is the more exact of the two); otherwise the written
 * address decides through its area. Neither gives `null`, and the caller says so in words.
 */
export function resolveZone<Zone extends ZoneCircle>(input: { zones: readonly Zone[]; areas: readonly (ZoneAreaRow & { zone: Zone })[]; address?: AddressWords; pin?: GeoPoint | null }): ZoneMatch<Zone> {
  if (input.pin !== undefined && input.pin !== null && isGeoPoint(input.pin)) {
    const hit = zoneForPin(input.zones, input.pin);
    if (hit !== null) return { by: 'pin', zone: hit.zone, distanceKm: hit.distanceKm };
  }
  if (input.address !== undefined) {
    const area = matchArea(input.areas, input.address);
    if (area !== null) return { by: 'address', zone: area.zone, areaId: area.id };
  }
  return null;
}

export interface ZoneInput {
  code: string;
  name: string;
  description: string | null;
  centre: GeoPoint | null;
  radiusKm: number | null;
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A zone as typed, or the first thing wrong with it in plain words. */
export function readZoneInput(raw: Record<string, unknown>): Read<ZoneInput> {
  const code = text(raw.code).toUpperCase();
  const name = text(raw.name);
  if (code === '') return { ok: false, error: 'Give the zone a code.' };
  if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(code)) return { ok: false, error: 'A code is up to 20 letters, numbers, dots, dashes or underscores.' };
  if (name === '') return { ok: false, error: 'Give the zone a name.' };
  if (name.length > 80) return { ok: false, error: 'A zone name is at most 80 characters.' };
  const description = text(raw.description).slice(0, 300);
  const lat = raw.centreLatitude;
  const lng = raw.centreLongitude;
  const radius = raw.radiusKm;
  const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  const none = blank(lat) && blank(lng) && blank(radius);
  if (none) return { ok: true, value: { code, name, description: description === '' ? null : description, centre: null, radiusKm: null } };
  if (blank(lat) || blank(lng) || blank(radius)) return { ok: false, error: 'A coverage circle needs a latitude, a longitude and a radius, or none of them.' };
  const latitude = Number(typeof lat === 'string' ? lat.trim() : lat);
  const longitude = Number(typeof lng === 'string' ? lng.trim() : lng);
  const km = Number(typeof radius === 'string' ? radius.trim() : radius);
  const point = { latitude, longitude };
  if (!isGeoPoint(point)) return { ok: false, error: 'The centre must be a real place: a latitude between -90 and 90 and a longitude between -180 and 180.' };
  if (!Number.isFinite(km) || km <= 0 || km > 2000) return { ok: false, error: 'The radius is more than 0 and at most 2000 km.' };
  return { ok: true, value: { code, name, description: description === '' ? null : description, centre: { latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6 }, radiusKm: Math.round(km * 100) / 100 } };
}

export interface AreaInput extends AddressKeys {
  county: string | null;
  town: string | null;
  area: string | null;
}

/** An area as typed (county, town, area; at least one), with the keys it is matched by. An area name alone is allowed: estates are known by name. */
export function readAreaInput(raw: Record<string, unknown>): Read<AreaInput> {
  const county = text(raw.county).slice(0, 80);
  const town = text(raw.town).slice(0, 80);
  const area = text(raw.area).slice(0, 80);
  const keys = keysOf({ county, town, area });
  if (!hasAnyKey(keys)) return { ok: false, error: 'Give at least a county, a town or an area.' };
  return { ok: true, value: { county: county === '' ? null : county, town: town === '' ? null : town, area: area === '' ? null : area, ...keys } };
}

/** Many areas pasted at once, one per line as "county, town, area" (a missing part is left empty: ", Westlands"). */
export function readAreaLines(lines: string, limit = 200): { areas: AreaInput[]; problems: { line: number; text: string; error: string }[]; tooMany: boolean } {
  const rows = lines.split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t })).filter((r) => r.text.trim() !== '');
  const areas: AreaInput[] = [];
  const problems: { line: number; text: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const { line, text: raw } of rows.slice(0, limit)) {
    const [county = '', town = '', area = ''] = raw.split(/[,\t|]/).map((p) => p.trim());
    const read = readAreaInput({ county, town, area });
    if (!read.ok) {
      problems.push({ line, text: raw.trim(), error: read.error });
      continue;
    }
    const key = `${read.value.countyKey}|${read.value.townKey}|${read.value.areaKey}`;
    if (seen.has(key)) {
      problems.push({ line, text: raw.trim(), error: 'The same area is on an earlier line.' });
      continue;
    }
    seen.add(key);
    areas.push(read.value);
  }
  return { areas, problems, tooMany: rows.length > limit };
}

/** An area in words, from the widest to the narrowest part given: "Westlands, Nairobi". */
export function areaWords(area: { county: string | null; town: string | null; area: string | null }): string {
  return [area.area, area.town, area.county].filter((p): p is string => has(p)).join(', ');
}
