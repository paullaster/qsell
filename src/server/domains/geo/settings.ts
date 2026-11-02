import { and, eq, gte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { geoSettings, geoUsage, type GeoSettingsRow } from '@/server/db/drizzle/schema';
import { readGeoConfig } from '@/lib/geo-config';
import { GEO_PROVIDERS, isGeoProviderId, type GeoProviderId } from '@/lib/geo-providers';
import { hourOf, speedBuckets, summariseUsage, type ProviderMetrics } from '@/lib/geo-metrics';
import { straightLineKm } from '@/lib/geo';
import { GEO_ADAPTERS, type GeoDriverConfig, type GeoEnv, type GeoSelection } from '@/server/adapters/geo/registry';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { DeliveryError } from '@/server/domains/delivery/errors';
import type { GeoCallEvent } from './service';

/** How long a chosen provider is remembered before the database is asked again. A save clears it at once. */
const SELECTION_TTL_MS = 30_000;

export interface GeoChoice {
  driver: GeoProviderId;
  config: Record<string, unknown>;
  /** 0 when nothing has been chosen yet. */
  version: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface ProbeStep {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const NAIROBI = { latitude: -1.2921, longitude: 36.8219 };
const NAKURU = { latitude: -0.3031, longitude: 36.08 };

/**
 * Which map service the company uses, how it is set up, and how each has behaved. The choice is version-checked, needs a reason,
 * and goes to the decision log; the services read it through `selection`, which is remembered for half a minute.
 */
export class GeoSettingsService {
  private remembered: { at: number; value: Awaited<ReturnType<GeoSelection>> } | null = null;

  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly companyId: () => Promise<string>,
    private readonly env: GeoEnv = process.env,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** What the registry asks. Null means nothing is chosen. */
  readonly selection: GeoSelection = async () => {
    if (this.remembered !== null && this.now() - this.remembered.at < SELECTION_TTL_MS) return this.remembered.value;
    const row = await this.row(await this.companyId());
    const value = row === null ? null : { driver: row.driver, config: row.config as GeoDriverConfig };
    this.remembered = { at: this.now(), value };
    return value;
  };

  async get(companyId: string): Promise<GeoChoice> {
    const row = await this.row(companyId);
    if (row === null || !isGeoProviderId(row.driver)) return { driver: 'builtin', config: {}, version: 0, updatedBy: null, updatedAt: null };
    return { driver: row.driver, config: row.config, version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
  }

  async save(companyId: string, actorId: string, input: { driver: unknown; config: unknown; expectedVersion: unknown; reason: unknown }): Promise<GeoChoice> {
    if (!isGeoProviderId(input.driver)) throw new DeliveryError('Choose one of the map services listed.', 'BAD_INPUT');
    const driver = input.driver;
    if (!GEO_PROVIDERS[driver].adapterReady) throw new DeliveryError(`${GEO_PROVIDERS[driver].name} cannot be chosen yet: its connection is not installed in this system.`, 'BAD_INPUT');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 5) throw new DeliveryError('Say why, in a few words. It is kept with the change.', 'BAD_INPUT');
    const expected = input.expectedVersion;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) throw new DeliveryError('Reload the page and try again.', 'BAD_INPUT');
    const config = readGeoConfig(driver, input.config);
    if (!config.ok) throw new DeliveryError(config.error, 'BAD_INPUT');

    const saved = await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(geoSettings).where(eq(geoSettings.companyId, companyId)).for('update');
      if ((before?.version ?? 0) !== expected) throw new DeliveryError('Someone else changed the map service while you were looking. Reload the page to see their choice.', 'CONFLICT');
      const [row] = await tx
        .insert(geoSettings)
        .values({ companyId, driver, config: config.value, version: 1, updatedBy: actorId })
        .onConflictDoUpdate({ target: geoSettings.companyId, set: { driver, config: config.value, version: sql`${geoSettings.version} + 1`, updatedBy: actorId, updatedAt: sql`now()` } })
        .returning();
      if (row === undefined) throw new DeliveryError('The map service could not be saved.', 'CONFLICT');
      await this.decisions.record(
        { companyId, subject: { type: 'geo_settings', id: companyId }, action: 'geo.provider_changed', actor: { type: 'user', id: actorId }, from: before?.driver ?? 'builtin', to: driver, reason: { text: reason }, inputs: { configured: Object.keys(config.value).filter((k) => config.value[k] !== '' && !(Array.isArray(config.value[k]) && (config.value[k] as unknown[]).length === 0)) } },
        tx,
      );
      return row;
    });
    this.remembered = null;
    return { driver, config: saved.config, version: saved.version, updatedBy: saved.updatedBy, updatedAt: saved.updatedAt };
  }

  /** Adds one call to the hour it happened in. Never throws: counting must not hurt a sale. */
  async record(companyId: string, event: GeoCallEvent): Promise<void> {
    const speed = speedBuckets(event.ms);
    const ms = Math.max(0, Math.round(event.ms));
    try {
      await this.db
        .insert(geoUsage)
        .values({ companyId, provider: event.provider, op: event.op, bucket: hourOf(new Date(this.now())), calls: 1, failures: event.ok ? 0 : 1, fallbacks: event.fellBack ? 1 : 0, totalMs: ms, maxMs: ms, ...speed })
        .onConflictDoUpdate({
          target: [geoUsage.companyId, geoUsage.provider, geoUsage.op, geoUsage.bucket],
          set: {
            calls: sql`${geoUsage.calls} + 1`,
            failures: sql`${geoUsage.failures} + ${event.ok ? 0 : 1}`,
            fallbacks: sql`${geoUsage.fallbacks} + ${event.fellBack ? 1 : 0}`,
            totalMs: sql`${geoUsage.totalMs} + ${ms}`,
            maxMs: sql`greatest(${geoUsage.maxMs}, ${ms})`,
            under500: sql`${geoUsage.under500} + ${speed.under500}`,
            under1000: sql`${geoUsage.under1000} + ${speed.under1000}`,
            under2500: sql`${geoUsage.under2500} + ${speed.under2500}`,
          },
        });
    } catch {
      /* a lost count is better than a lost sale */
    }
  }

  /** How each provider has behaved for this company over the last `days` days. */
  async metrics(companyId: string, days: number): Promise<ProviderMetrics[]> {
    const since = new Date(this.now() - Math.max(1, Math.min(days, 365)) * 86_400_000);
    const rows = await this.db
      .select({
        provider: geoUsage.provider,
        calls: sql<number>`coalesce(sum(${geoUsage.calls}), 0)::int`,
        failures: sql<number>`coalesce(sum(${geoUsage.failures}), 0)::int`,
        fallbacks: sql<number>`coalesce(sum(${geoUsage.fallbacks}), 0)::int`,
        totalMs: sql<number>`coalesce(sum(${geoUsage.totalMs}), 0)::float8`,
        maxMs: sql<number>`coalesce(max(${geoUsage.maxMs}), 0)::int`,
        under500: sql<number>`coalesce(sum(${geoUsage.under500}), 0)::int`,
        under1000: sql<number>`coalesce(sum(${geoUsage.under1000}), 0)::int`,
        under2500: sql<number>`coalesce(sum(${geoUsage.under2500}), 0)::int`,
      })
      .from(geoUsage)
      .where(and(eq(geoUsage.companyId, companyId), gte(geoUsage.bucket, since)))
      .groupBy(geoUsage.provider);
    return summariseUsage(rows);
  }

  /**
   * Tries a provider as it would be set up, without saving it: find a place, name a pin, measure a road. Each step is timed and
   * says what it found, so an administrator sees it work (or why not) before relying on it.
   */
  async probe(driver: unknown, rawConfig: unknown): Promise<ProbeStep[]> {
    if (!isGeoProviderId(driver) || !GEO_PROVIDERS[driver].adapterReady) throw new DeliveryError('Choose one of the map services listed.', 'BAD_INPUT');
    const config = readGeoConfig(driver, rawConfig);
    if (!config.ok) throw new DeliveryError(config.error, 'BAD_INPUT');
    const port = GEO_ADAPTERS[driver]?.(this.env, config.value);
    if (port === undefined) throw new DeliveryError('That map service is not installed.', 'BAD_INPUT');
    const step = async (name: string, run: () => Promise<string>): Promise<ProbeStep> => {
      const started = this.now();
      try {
        return { name, ok: true, ms: this.now() - started, detail: await run() };
      } catch (error) {
        return { name, ok: false, ms: this.now() - started, detail: error instanceof Error ? error.message : 'It failed.' };
      }
    };
    const steps: ProbeStep[] = [];
    if (port.capabilities.placeSearch) {
      steps.push(
        await step('Find a place by name', async () => {
          const found = await port.searchPlaces('Westlands, Nairobi', { limit: 3 });
          if (found.length === 0) throw new Error('Nothing was found for “Westlands, Nairobi”.');
          return `Found ${String(found.length)}: ${found[0]?.label ?? ''}`;
        }),
      );
    } else {
      steps.push({ name: 'Find a place by name', ok: true, ms: 0, detail: 'Not offered by this service: customers write an address or drop a pin.' });
    }
    if (port.capabilities.reverseGeocode) {
      steps.push(
        await step('Name a pin on the map', async () => {
          const place = await port.reverse(NAIROBI);
          if (place === null) throw new Error('No address was found for a pin in central Nairobi.');
          return place.label;
        }),
      );
    } else {
      steps.push({ name: 'Name a pin on the map', ok: true, ms: 0, detail: 'Not offered by this service.' });
    }
    steps.push(
      await step('Measure a road (Nairobi to Nakuru)', async () => {
        const [route] = await port.distancesFrom(NAIROBI, [NAKURU]);
        if (route === undefined) throw new Error('No distance came back.');
        const line = straightLineKm(NAIROBI, NAKURU);
        if (route.km < line - 1 || route.km > line * 3) throw new Error(`${String(route.km)} km is not believable for two towns ${String(Math.round(line))} km apart.`);
        return `${String(route.km)} km${route.minutes === null ? '' : `, about ${String(route.minutes)} minutes`} (${route.basis === 'road' ? 'by road' : 'estimated'})`;
      }),
    );
    return steps;
  }

  private async row(companyId: string): Promise<GeoSettingsRow | null> {
    const [row] = await this.db.select().from(geoSettings).where(eq(geoSettings.companyId, companyId));
    return row ?? null;
  }
}
