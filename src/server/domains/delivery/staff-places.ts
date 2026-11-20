import { getContainer } from '@/server/di/container';
import { waitMessage } from '@/lib/rate-limit';
import type { GeoPoint } from '@/lib/geo';
import { SettingsError } from '@/server/domains/settings/errors';

export interface StaffPlace {
  id: string;
  label: string;
  secondary: string | null;
  point: GeoPoint;
}

/**
 * Staff: the places that match a name they typed, to fill a map pin without typing coordinates. Only on request (the free map servers do
 * not allow search as people type), limited for each person because a paid map service charges for each search, and only places that have
 * a point on the map are offered. The caller has already checked the person's permission for the screen they are on.
 */
export async function findPlacesForStaff(userId: string, raw: unknown): Promise<StaffPlace[]> {
  const q = typeof raw === 'string' ? raw.trim().slice(0, 120) : '';
  if (q.length < 3) throw new SettingsError('Type at least three letters of the place.');
  const verdict = await getContainer().rateLimits.hit('staff_map_search_user', userId);
  if (!verdict.allowed) throw new SettingsError(waitMessage(verdict.retryAfterSeconds), 'RATE_LIMITED');
  const found = await getContainer().geo.searchPlaces(q, { limit: 6 });
  return found.value.flatMap((p) => (p.point === null ? [] : [{ id: p.id, label: p.label, secondary: p.secondary, point: p.point }]));
}
