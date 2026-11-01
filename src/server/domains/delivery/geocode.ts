import { has } from '@/lib/values';
import type { GeoPoint } from '@/lib/geo';
import type { AddressWords } from '@/lib/delivery-zones';
import type { GeoService } from '@/server/domains/geo/service';

/** A written address placed on the map, as an approximate point; null when the map service cannot place it. */
export async function placeAddress(geo: GeoService, address: AddressWords): Promise<GeoPoint | null> {
  const query = [address.area, address.town, address.county].filter((p): p is string => has(p)).join(', ');
  if (query === '') return null;
  const found = await geo.searchPlaces(query, { limit: 1 });
  const first = found.value.at(0);
  if (first === undefined) return null;
  if (first.point !== null) return first.point;
  return (await geo.resolvePlace(first.id)).value?.point ?? null;
}
