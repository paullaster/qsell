import { estimatedRoadKm } from '@/lib/geo';
import type { GeoCapabilities, GeoPoint, GeoPort, PlaceSuggestion, ResolvedPlace, RouteEstimate } from '@/server/ports/geo';

/** Road speed used for the time estimate when only the straight line is known, in km an hour. */
const AVERAGE_KMH = 30;

/**
 * The adapter that needs no key and no network. It cannot search addresses (people pick from the company's own areas, or drop
 * a pin or use their location), and it estimates a road distance as the straight line times a road factor. It is always
 * available, so delivery quotes work with no map provider set up, and it is what the system falls back to when a provider is down.
 */
export class BuiltinGeoAdapter implements GeoPort {
  readonly provider = 'builtin';
  readonly capabilities: GeoCapabilities = { placeSearch: false, reverseGeocode: false, roadDistance: false, travelTime: true, clientMap: null };

  constructor(private readonly roadFactor = 1.3) {}

  searchPlaces(): Promise<PlaceSuggestion[]> {
    return Promise.resolve([]);
  }

  resolvePlace(): Promise<ResolvedPlace | null> {
    return Promise.resolve(null);
  }

  reverse(): Promise<ResolvedPlace | null> {
    return Promise.resolve(null);
  }

  distancesFrom(from: GeoPoint, to: readonly GeoPoint[]): Promise<RouteEstimate[]> {
    return Promise.resolve(
      to.map((point) => {
        const km = estimatedRoadKm(from, point, this.roadFactor);
        return { km, minutes: Math.round((km / AVERAGE_KMH) * 60), basis: 'estimated' as const };
      }),
    );
  }
}
