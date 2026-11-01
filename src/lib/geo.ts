/**
 * Places on the earth and the distances between them. Pure: no provider, no network, no clock. Anything that needs a map
 * service (searching an address, road distance) goes through the geo port; this is the part that is the same everywhere.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_KM = 6371.0088;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** True for a latitude and longitude that exist on the earth. NaN and infinities are not places. */
export function isGeoPoint(value: unknown): value is GeoPoint {
  if (typeof value !== 'object' || value === null) return false;
  const { latitude, longitude } = value as Record<string, unknown>;
  return typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

/** A point from what a person typed or a browser reported, or the reason it is not one. Six decimals is about 10 cm. */
export function readGeoPoint(latitude: unknown, longitude: unknown): { ok: true; point: GeoPoint } | { ok: false; error: string } {
  const lat = typeof latitude === 'string' ? Number(latitude.trim()) : latitude;
  const lng = typeof longitude === 'string' ? Number(longitude.trim()) : longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number' || (typeof latitude === 'string' && latitude.trim() === '') || (typeof longitude === 'string' && longitude.trim() === '')) {
    return { ok: false, error: 'Give both the latitude and the longitude as numbers.' };
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: 'A latitude is between -90 and 90.' };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: 'A longitude is between -180 and 180.' };
  return { ok: true, point: { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lng * 1e6) / 1e6 } };
}

/** The straight-line (great circle) distance between two points, in kilometres. */
export function straightLineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = radians(b.latitude - a.latitude);
  const dLng = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A road distance estimated from the straight line. Roads are longer than the crow flies; the factor is the company's to set
 * (about 1.3 in towns). Rounded to 10 metres so the same two places always give the same number.
 */
export function estimatedRoadKm(a: GeoPoint, b: GeoPoint, roadFactor: number): number {
  const factor = Number.isFinite(roadFactor) && roadFactor >= 1 ? roadFactor : 1;
  return Math.round(straightLineKm(a, b) * factor * 100) / 100;
}

export interface Candidate<T> {
  item: T;
  point: GeoPoint | null;
}

export interface Ranked<T> {
  item: T;
  km: number;
}

/**
 * The candidates nearest first. A candidate with no point cannot be placed and is left out of the ranking (it is returned
 * separately so the caller can say so). Ties are broken by the order given, which the caller makes stable (for example by code),
 * so the same inputs always give the same answer.
 */
export function rankByDistance<T>(from: GeoPoint, candidates: readonly Candidate<T>[], distance: (a: GeoPoint, b: GeoPoint) => number = straightLineKm): { ranked: Ranked<T>[]; unplaced: T[] } {
  const ranked: (Ranked<T> & { order: number })[] = [];
  const unplaced: T[] = [];
  candidates.forEach((candidate, order) => {
    if (candidate.point === null) unplaced.push(candidate.item);
    else ranked.push({ item: candidate.item, km: distance(from, candidate.point), order });
  });
  ranked.sort((x, y) => (x.km === y.km ? x.order - y.order : x.km - y.km));
  return { ranked: ranked.map(({ item, km }) => ({ item, km })), unplaced };
}
