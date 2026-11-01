/**
 * Map and distance port (DI).
 *
 * Everything the platform needs from a map service is on this interface: suggest places as someone types, turn a pin into an
 * address and back, and say how far apart two places are. The delivery rules depend on this interface only; a provider
 * (OpenStreetMap, Google, Mapbox, a routing engine of your own) is an adapter under `server/adapters/geo`, registered by name
 * in the registry and chosen with `GEO_DRIVER`. Adding a provider means adding one adapter and one line in the registry.
 *
 * Adapters never throw for "nothing found": they answer with an empty list or `null`. They throw `GeoUnavailableError` when the
 * provider itself cannot be reached or refuses, so the caller can fall back to the built-in estimate instead of stopping a sale.
 */
import type { GeoPoint } from '@/lib/geo';

export type { GeoPoint } from '@/lib/geo';

/** What the browser needs to draw a map for this provider. Public values only: never a secret. */
export interface ClientMapDescriptor {
  /** The name of the client map driver that knows how to draw it (see the shop's map picker). */
  driver: string;
  options: Record<string, string>;
}

export interface GeoCapabilities {
  /** Suggests places for typed text. */
  placeSearch: boolean;
  /** Turns a pin into an address. */
  reverseGeocode: boolean;
  /** Distances follow roads, not the crow's flight. */
  roadDistance: boolean;
  /** Gives a travel time. */
  travelTime: boolean;
  /** How the browser draws a map, or null when this provider has none (then people type an address or use their location). */
  clientMap: ClientMapDescriptor | null;
}

export interface PlaceSuggestion {
  /** The provider's own handle, to be given back to `resolvePlace`. Opaque to everyone else. */
  id: string;
  label: string;
  /** A second line, for example the town or county. */
  secondary: string | null;
  /** Present when the provider already knows where it is; otherwise `resolvePlace` finds out. */
  point: GeoPoint | null;
}

/** A place with its address in the parts a Kenyan delivery address is made of. Any part may be unknown. */
export interface ResolvedPlace {
  point: GeoPoint;
  label: string;
  county: string | null;
  town: string | null;
  area: string | null;
  road: string | null;
  countryCode: string | null;
  /** How exact the provider says the place is, in metres, when it says. */
  accuracyM: number | null;
}

export interface RouteEstimate {
  km: number;
  minutes: number | null;
  /** `road` when a routing service worked it out; `estimated` when it is the straight line with a road factor. */
  basis: 'road' | 'estimated';
}

export interface SearchOptions {
  /** Prefer places near here. */
  near?: GeoPoint;
  /** Two-letter country code to keep results to, for example `ke`. */
  countryCode?: string;
  limit?: number;
}

export interface GeoPort {
  /** The name this adapter is registered under. */
  readonly provider: string;
  readonly capabilities: GeoCapabilities;
  searchPlaces(query: string, options?: SearchOptions): Promise<PlaceSuggestion[]>;
  resolvePlace(id: string): Promise<ResolvedPlace | null>;
  reverse(point: GeoPoint): Promise<ResolvedPlace | null>;
  /** From one place to several, in the order given. One call, so ranking many branches is not many round trips. */
  distancesFrom(from: GeoPoint, to: readonly GeoPoint[]): Promise<RouteEstimate[]>;
}

/** The provider could not be reached or refused. Callers fall back; they do not stop the sale. */
export class GeoUnavailableError extends Error {
  constructor(
    public readonly provider: string,
    message = 'The map service is not available right now.',
  ) {
    super(message);
    this.name = 'GeoUnavailableError';
  }
}
