import type { Candidate } from '@/lib/geo';
import type { GeoPoint, GeoPort, PlaceSuggestion, ResolvedPlace, RouteEstimate, SearchOptions } from '@/server/ports/geo';
import type { GeoPortRegistry } from '@/server/adapters/geo/registry';

/** How long a map provider gets before the built-in estimate is used instead. A shopper is waiting. */
const PROVIDER_TIMEOUT_MS = 2500;

/**
 * How long a road distance the provider really measured is remembered. The price a shopper is shown and the price checked when they
 * pay are worked out separately; without this, a slow answer in between sends the second one to the shorter straight-line estimate and
 * the order is refused for a price that "changed". An estimate made because the provider failed is never remembered.
 */
const ROUTE_MEMORY_MS = 15 * 60_000;
const ROUTE_MEMORY_MAX = 2000;

const routeKey = (provider: string, from: GeoPoint, to: GeoPoint): string => `${provider}|${from.latitude.toFixed(6)},${from.longitude.toFixed(6)}|${to.latitude.toFixed(6)},${to.longitude.toFixed(6)}`;

export interface Answer<T> {
  value: T;
  /** True when the chosen provider could not answer in time and the built-in estimate was used. Say so on the trace. */
  degraded: boolean;
  provider: string;
}

export type GeoOp = 'search' | 'resolve' | 'reverse' | 'distance';

/** One call to a map service, as it went: what the administrator weighs a provider by. */
export interface GeoCallEvent {
  provider: string;
  op: GeoOp;
  ms: number;
  ok: boolean;
  /** The provider failed and the built-in estimate answered instead. */
  fellBack: boolean;
}

export type GeoRecorder = (event: GeoCallEvent) => void;

export interface NearestResult<T> {
  /** Nearest first, each with the distance to it. */
  ranked: { item: T; route: RouteEstimate }[];
  /** Candidates that have no place on the map yet and so could not be ranked. */
  unplaced: T[];
  degraded: boolean;
  provider: string;
}

/**
 * The only way the rules ask for a map answer. It picks the provider chosen for the company, gives it a short time, and when
 * the provider is down or slow it answers from the built-in estimate and says so. A map outage must never stop a sale.
 */
export class GeoService {
  private readonly routes = new Map<string, { at: number; route: RouteEstimate }>();

  constructor(
    private readonly registry: GeoPortRegistry,
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS,
    private readonly record: GeoRecorder = () => undefined,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** What the provider in use can do, for the screens that decide what to show (a search box, a map). */
  async capabilities() {
    return (await this.registry.current()).capabilities;
  }

  async searchPlaces(query: string, options?: SearchOptions): Promise<Answer<PlaceSuggestion[]>> {
    const text = query.trim();
    if (text.length < 2) return { value: [], degraded: false, provider: (await this.registry.current()).provider };
    return await this.ask('search', (port) => port.searchPlaces(text, options), []);
  }

  resolvePlace(id: string): Promise<Answer<ResolvedPlace | null>> {
    return this.ask('resolve', (port) => port.resolvePlace(id), null);
  }

  reverse(point: GeoPoint): Promise<Answer<ResolvedPlace | null>> {
    return this.ask('reverse', (port) => port.reverse(point), null);
  }

  async distancesFrom(from: GeoPoint, to: readonly GeoPoint[]): Promise<Answer<RouteEstimate[]>> {
    const port = await this.registry.current();
    if (to.length === 0) return { value: [], degraded: false, provider: port.provider };
    const now = this.clock();
    const keys = to.map((point) => routeKey(port.provider, from, point));
    const known = keys.map((key) => this.remembered(key, now));
    const missing = to.filter((_, i) => known[i] === undefined);
    if (missing.length === 0) return { value: known.filter((r): r is RouteEstimate => r !== undefined), degraded: false, provider: port.provider };
    const answer = await this.askWithEstimate((p) => p.distancesFrom(from, missing), (p) => p.distancesFrom(from, missing));
    const fresh = answer.value;
    if (!answer.degraded) fresh.forEach((route, i) => this.remember(routeKey(answer.provider, from, missing[i] ?? from), route, now));
    let next = 0;
    const value = known.map((r) => r ?? fresh[next++]).filter((r): r is RouteEstimate => r !== undefined);
    return { value, degraded: answer.degraded, provider: answer.provider };
  }

  private remembered(key: string, now: number): RouteEstimate | undefined {
    const hit = this.routes.get(key);
    if (hit === undefined) return undefined;
    if (now - hit.at > ROUTE_MEMORY_MS) {
      this.routes.delete(key);
      return undefined;
    }
    return hit.route;
  }

  private remember(key: string, route: RouteEstimate, now: number): void {
    this.routes.delete(key);
    this.routes.set(key, { at: now, route });
    // The oldest go first, so the memory stays small however many places are asked about.
    while (this.routes.size > ROUTE_MEMORY_MAX) {
      const oldest = this.routes.keys().next();
      if (oldest.done === true) break;
      this.routes.delete(oldest.value);
    }
  }

  /** The candidates nearest first by the distance the provider gives (road when it can), one call however many there are. */
  async nearest<T>(from: GeoPoint, candidates: readonly Candidate<T>[]): Promise<NearestResult<T>> {
    const placed = candidates.filter((c): c is Candidate<T> & { point: GeoPoint } => c.point !== null);
    const unplaced = candidates.filter((c) => c.point === null).map((c) => c.item);
    const answer = await this.distancesFrom(from, placed.map((c) => c.point));
    const ranked = placed
      .map((c, order) => ({ item: c.item, order, route: answer.value.at(order) }))
      .filter((r): r is { item: T; order: number; route: RouteEstimate } => r.route !== undefined)
      .sort((x, y) => (x.route.km === y.route.km ? x.order - y.order : x.route.km - y.route.km))
      .map(({ item, route }) => ({ item, route }));
    return { ranked, unplaced, degraded: answer.degraded, provider: answer.provider };
  }

  private async ask<T>(op: GeoOp, call: (port: GeoPort) => Promise<T>, empty: T): Promise<Answer<T>> {
    const port = await this.registry.current();
    const started = this.clock();
    try {
      const value = await this.within(call(port));
      this.record({ provider: port.provider, op, ms: this.clock() - started, ok: true, fellBack: false });
      return { value, degraded: false, provider: port.provider };
    } catch {
      this.record({ provider: port.provider, op, ms: this.clock() - started, ok: false, fellBack: false });
      return { value: empty, degraded: port.provider !== 'builtin', provider: port.provider };
    }
  }

  private async askWithEstimate<T>(call: (port: GeoPort) => Promise<T>, estimate: (port: GeoPort) => Promise<T>): Promise<Answer<T>> {
    const port = await this.registry.current();
    const started = this.clock();
    try {
      const value = await this.within(call(port));
      this.record({ provider: port.provider, op: 'distance', ms: this.clock() - started, ok: true, fellBack: false });
      return { value, degraded: false, provider: port.provider };
    } catch {
      this.record({ provider: port.provider, op: 'distance', ms: this.clock() - started, ok: false, fellBack: port.provider !== 'builtin' });
      const fallback = this.registry.fallback();
      return { value: await estimate(fallback), degraded: true, provider: fallback.provider };
    }
  }

  private within<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The map service took too long.')), this.timeoutMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error('The map service failed.'));
        },
      );
    });
  }
}
