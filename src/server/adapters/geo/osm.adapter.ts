import { estimatedRoadKm } from '@/lib/geo';
import { OSM_DEFAULTS, PUBLIC_OSM_HOSTS, type OsmConfig } from '@/lib/geo-config';
import { GeoUnavailableError, type GeoCapabilities, type GeoPoint, type GeoPort, type PlaceSuggestion, type ResolvedPlace, type RouteEstimate, type SearchOptions } from '@/server/ports/geo';

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface OsmDeps {
  fetch: Fetcher;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Longest a single request may take. */
  timeoutMs: number;
  /** The product name sent to the servers, with the contact email. */
  appName: string;
}

const defaultDeps = (): OsmDeps => ({
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs: 8000,
  appName: 'qsell',
});

const AVERAGE_KMH = 30;
/** The free servers allow one request a second. A little over, so two requests never land inside one second. */
const PUBLIC_GAP_MS = 1100;
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
/** The public routing server takes up to 100 places a request. */
const MATRIX_CHUNK = 90;

interface NominatimItem {
  osm_type?: string;
  osm_id?: number | string;
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  address?: Record<string, string>;
  importance?: number;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const handleOf = (item: NominatimItem): string | null => {
  const kind = (item.osm_type ?? '').charAt(0).toUpperCase();
  return 'NWR'.includes(kind) && kind !== '' && item.osm_id !== undefined ? `osm:${kind}${String(item.osm_id)}` : null;
};

const pointOf = (item: NominatimItem): GeoPoint | null => {
  const latitude = Number(item.lat);
  const longitude = Number(item.lon);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
};

const first = (a: Record<string, string>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = a[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

/** A Kenyan address in the parts a delivery is zoned by. "Nairobi County" is Nairobi. */
function placeOf(item: NominatimItem): ResolvedPlace | null {
  const point = pointOf(item);
  if (point === null) return null;
  const a = item.address ?? {};
  const county = first(a, ['county', 'state', 'state_district'])?.replace(/\s+county$/i, '') ?? null;
  return {
    point,
    label: item.display_name ?? `${String(point.latitude)}, ${String(point.longitude)}`,
    county,
    town: first(a, ['city', 'town', 'village', 'municipality']),
    area: first(a, ['suburb', 'neighbourhood', 'quarter', 'city_district', 'hamlet']),
    road: first(a, ['road', 'pedestrian', 'footway']),
    countryCode: a.country_code?.toLowerCase() ?? null,
    accuracyM: null,
  };
}

/**
 * OpenStreetMap through Nominatim (places), OSRM (road distances and times) and Leaflet in the browser. The public servers are
 * free but ask for care, and this adapter keeps their rules: it identifies the business, spaces requests a little over a second
 * apart, remembers answers for a day, and never searches as people type. Pointed at a server of your own or a paid host
 * (the same software), it drops the spacing and allows typing-time search. A failure is `GeoUnavailableError`, never a guess.
 */
export class OsmGeoAdapter implements GeoPort {
  readonly provider = 'osm';
  readonly capabilities: GeoCapabilities;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly lastCall = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deps: OsmDeps;

  constructor(
    private readonly config: OsmConfig,
    private readonly roadFactor = 1.3,
    deps: Partial<OsmDeps> = {},
  ) {
    this.deps = { ...defaultDeps(), ...deps };
    const ownSearch = !PUBLIC_OSM_HOSTS.includes(hostOf(config.nominatimUrl));
    this.capabilities = {
      placeSearch: true,
      typeahead: ownSearch,
      reverseGeocode: true,
      roadDistance: true,
      travelTime: true,
      clientMap: { driver: 'leaflet', options: { tileUrl: config.tileUrl, attribution: '© OpenStreetMap contributors' } },
    };
  }

  async searchPlaces(query: string, options: SearchOptions = {}): Promise<PlaceSuggestion[]> {
    const q = query.trim();
    if (q === '') return [];
    const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: String(Math.min(Math.max(options.limit ?? 5, 1), 10)) });
    const countries = options.countryCode === undefined ? this.config.countryCodes : [options.countryCode.toLowerCase()];
    if (countries.length > 0) params.set('countrycodes', countries.join(','));
    if (options.near !== undefined) params.set('viewbox', viewbox(options.near));
    const items = await this.getJson<NominatimItem[]>(this.config.nominatimUrl, `/search?${params.toString()}`, true);
    return (Array.isArray(items) ? items : []).flatMap((item) => {
      const id = handleOf(item);
      const point = pointOf(item);
      if (id === null || point === null) return [];
      const label = item.name !== undefined && item.name !== '' ? item.name : (item.display_name ?? '').split(',')[0]?.trim() ?? '';
      const rest = (item.display_name ?? '').split(',').slice(1).map((p) => p.trim()).filter((p) => p !== '');
      return [{ id, label: label === '' ? (item.display_name ?? id) : label, secondary: rest.length === 0 ? null : rest.slice(0, 3).join(', '), point }];
    });
  }

  async resolvePlace(id: string): Promise<ResolvedPlace | null> {
    const match = /^osm:([NWR]\d{1,15})$/.exec(id);
    if (match === null) return null;
    const params = new URLSearchParams({ osm_ids: match[1] ?? '', format: 'jsonv2', addressdetails: '1' });
    const items = await this.getJson<NominatimItem[]>(this.config.nominatimUrl, `/lookup?${params.toString()}`, true);
    const item = Array.isArray(items) ? items[0] : undefined;
    return item === undefined ? null : placeOf(item);
  }

  async reverse(point: GeoPoint): Promise<ResolvedPlace | null> {
    const params = new URLSearchParams({ lat: String(point.latitude), lon: String(point.longitude), format: 'jsonv2', addressdetails: '1', zoom: '18' });
    const item = await this.getJson<(NominatimItem & { error?: string }) | null>(this.config.nominatimUrl, `/reverse?${params.toString()}`, true);
    if (item === null || typeof item !== 'object' || 'error' in item) return null;
    return placeOf(item);
  }

  async distancesFrom(from: GeoPoint, to: readonly GeoPoint[]): Promise<RouteEstimate[]> {
    const out: RouteEstimate[] = [];
    for (let start = 0; start < to.length; start += MATRIX_CHUNK) out.push(...(await this.matrix(from, to.slice(start, start + MATRIX_CHUNK))));
    return out;
  }

  private async matrix(from: GeoPoint, to: readonly GeoPoint[]): Promise<RouteEstimate[]> {
    const coordinates = [from, ...to].map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';');
    const destinations = to.map((_, i) => i + 1).join(';');
    const body = await this.getJson<{ code?: string; durations?: (number | null)[][]; distances?: (number | null)[][] }>(this.config.osrmUrl, `/table/v1/driving/${coordinates}?sources=0&destinations=${destinations}&annotations=duration,distance`, false);
    if (body.code !== 'Ok') throw new GeoUnavailableError(this.provider, 'The routing server did not give distances.');
    const metres = body.distances?.[0];
    const seconds = body.durations?.[0];
    return to.map((point, i) => {
      const m = metres?.[i];
      const s = seconds?.[i];
      if (typeof m === 'number' && Number.isFinite(m)) return { km: Math.round(m / 10) / 100, minutes: typeof s === 'number' ? Math.round(s / 60) : null, basis: 'road' as const };
      // The place cannot be reached by road on the map: say so with the straight-line estimate, which is marked as one.
      const km = estimatedRoadKm(from, point, this.roadFactor);
      return { km, minutes: Math.round((km / AVERAGE_KMH) * 60), basis: 'estimated' as const };
    });
  }

  /** One GET with identification, spacing, a time limit and (for places) a day's memory. */
  private async getJson<T>(base: string, path: string, cacheable: boolean): Promise<T> {
    const url = `${base}${path}`;
    if (cacheable) {
      const hit = this.cache.get(url);
      if (hit !== undefined && this.deps.now() - hit.at < CACHE_MS) return hit.value as T;
    }
    const value = await this.spaced(hostOf(base), async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
      try {
        const response = await this.deps.fetch(url, { headers: { 'User-Agent': `${this.deps.appName} (${this.config.contactEmail})`, Accept: 'application/json', 'Accept-Language': 'en' }, signal: controller.signal });
        if (!response.ok) throw new GeoUnavailableError(this.provider, `The map server answered ${String(response.status)}.`);
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof GeoUnavailableError) throw error;
        throw new GeoUnavailableError(this.provider, 'The map server could not be reached.');
      } finally {
        clearTimeout(timer);
      }
    });
    if (cacheable) {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value ?? '');
      this.cache.set(url, { at: this.deps.now(), value });
    }
    return value;
  }

  /** The public servers are called one at a time, a little over a second apart. Servers of your own are not held back. */
  private spaced<T>(host: string, work: () => Promise<T>): Promise<T> {
    if (!PUBLIC_OSM_HOSTS.includes(host)) return work();
    const run = async (): Promise<T> => {
      const wait = (this.lastCall.get(host) ?? Number.NEGATIVE_INFINITY) + PUBLIC_GAP_MS - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      this.lastCall.set(host, this.deps.now());
      return await work();
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

const viewbox = (p: GeoPoint): string => `${(p.longitude - 0.5).toFixed(4)},${(p.latitude + 0.5).toFixed(4)},${(p.longitude + 0.5).toFixed(4)},${(p.latitude - 0.5).toFixed(4)}`;

export const osmFromConfig = (config: Partial<OsmConfig> & { contactEmail: string }, roadFactor = 1.3): OsmGeoAdapter =>
  new OsmGeoAdapter({ countryCodes: [], nominatimUrl: OSM_DEFAULTS.nominatimUrl, osrmUrl: OSM_DEFAULTS.osrmUrl, tileUrl: OSM_DEFAULTS.tileUrl, ...config }, roadFactor);
