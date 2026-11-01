import type { GeoPort } from '@/server/ports/geo';
import { BuiltinGeoAdapter } from './builtin.adapter';

/** The environment variables the map settings read. Narrow on purpose, so tests pass only what they mean. */
export type GeoEnv = Readonly<Record<string, string | undefined>>;

export type GeoAdapterFactory = (env: GeoEnv) => GeoPort;

/**
 * The map providers the platform knows, by name. To add one: write an adapter that implements `GeoPort`, pass the shared
 * contract tests, and add it here. Nothing else changes.
 */
export const GEO_ADAPTERS: Record<string, GeoAdapterFactory> = {
  builtin: (env) => new BuiltinGeoAdapter(roadFactorFrom(env)),
};

/** `GEO_ROAD_FACTOR`: how much longer a road is than the straight line. Between 1 and 3; 1.3 when unset or nonsense. */
export function roadFactorFrom(env: GeoEnv): number {
  const raw = Number(env.GEO_ROAD_FACTOR);
  return Number.isFinite(raw) && raw >= 1 && raw <= 3 ? raw : 1.3;
}

/** `GEO_DRIVER`: the provider in use. Unset means the built-in one. A name nobody registered is an error that names the choices. */
export function configuredGeoDriver(env: GeoEnv = process.env, adapters: Record<string, GeoAdapterFactory> = GEO_ADAPTERS): string {
  const raw = env.GEO_DRIVER?.trim().toLowerCase() ?? '';
  if (raw === '') return 'builtin';
  if (!Object.hasOwn(adapters, raw)) throw new Error(`Unknown GEO_DRIVER "${raw}". Use one of: ${Object.keys(adapters).join(', ')}.`);
  return raw;
}

/**
 * Builds a provider the first time it is asked for, so a missing key for a provider nobody uses never breaks the app, and
 * the built-in one is always there to fall back on.
 */
export class GeoPortRegistry {
  private readonly built = new Map<string, GeoPort>();

  constructor(
    private readonly env: GeoEnv = process.env,
    private readonly adapters: Record<string, GeoAdapterFactory> = GEO_ADAPTERS,
  ) {}

  active(): GeoPort {
    return this.named(configuredGeoDriver(this.env, this.adapters));
  }

  /** The always-available estimate, used when the chosen provider cannot be reached. */
  fallback(): GeoPort {
    return this.named('builtin');
  }

  named(name: string): GeoPort {
    let port = this.built.get(name);
    if (port === undefined) {
      const factory = Object.hasOwn(this.adapters, name) ? this.adapters[name] : undefined;
      if (factory === undefined) throw new Error(`Unknown map provider "${name}".`);
      port = factory(this.env);
      this.built.set(name, port);
    }
    return port;
  }
}
