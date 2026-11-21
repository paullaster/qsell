import type { GeoPoint } from '@/lib/geo';

/** A point as the latitude and longitude boxes hold it: six decimals, about ten centimetres. */
export function boxesOf(point: GeoPoint): { latitude: string; longitude: string } {
  return { latitude: point.latitude.toFixed(6), longitude: point.longitude.toFixed(6) };
}

/** What to call a pinned place: what the person already wrote, else the name of the place found (kept to the 120 characters a label may be). */
export function pinLabelFor(current: string, found: string): string {
  return current.trim() === '' ? found.trim().slice(0, 120) : current;
}
