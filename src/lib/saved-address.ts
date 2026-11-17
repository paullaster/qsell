import type { GeoPoint } from '@/lib/geo';

/** The parts of a saved address that say where it is. */
interface Located {
  street: string;
  city: string;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
}

const words = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** The place on the map saved with an address, or null when it was only written (or only half of it is there). */
export function pinOfAddress(address: Pick<Located, 'latitude' | 'longitude'>): GeoPoint | null {
  const { latitude, longitude } = address;
  return typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : null;
}

/** Whether two addresses are written the same way (street and town, ignoring case and spacing). */
export function sameAddress(a: Pick<Located, 'street' | 'city'>, b: Pick<Located, 'street' | 'city'>): boolean {
  return words(a.street) === words(b.street) && words(a.city) === words(b.city);
}

/** Whether a saved address already holds exactly this place (to the 6 places that are kept). */
export function holdsPlace(address: Pick<Located, 'latitude' | 'longitude'>, pin: GeoPoint): boolean {
  const saved = pinOfAddress(address);
  return saved !== null && saved.latitude.toFixed(6) === pin.latitude.toFixed(6) && saved.longitude.toFixed(6) === pin.longitude.toFixed(6);
}

/**
 * What to do with the address the shopper delivered to, among those they have saved: nothing when it is already there with this
 * place, give an address written the same way its place, or save it as a new one.
 */
export function saveDecision(saved: readonly (Located & { id: string })[], now: Located, pin: GeoPoint | null): { kind: 'none' } | { kind: 'attach'; id: string } | { kind: 'add' } {
  const match = saved.find((a) => sameAddress(a, now));
  if (pin === null) return match === undefined ? { kind: 'add' } : { kind: 'none' };
  if (match === undefined) return { kind: 'add' };
  return holdsPlace(match, pin) ? { kind: 'none' } : { kind: 'attach', id: match.id };
}
