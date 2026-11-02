import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as Actions from './actions';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * The company's choice of map service against a real database: it needs a reason, valid settings and the current version; two
 * people saving at once get one winner; the choice is what the services use; usage is counted by the hour and summed into the
 * evidence the choosing screen shows; and only people with the delivery permissions can see or change any of it.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('map service settings (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof Actions;
  let companyId: string;
  let spy: { mockRestore: () => void };
  const osm = { contactEmail: 'maps@shop.co.ke', countryCodes: 'ke' };
  const version = async () => (await c.geoSettings.get(companyId)).version;
  const save = async (over: Record<string, unknown> = {}) => await actions.saveGeoSettingsAction({ driver: 'osm', config: osm, expectedVersion: await version(), reason: 'Trying the free maps', ...over });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./actions');
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await db.delete(schema.geoSettings).where(eq(schema.geoSettings.companyId, companyId));
    await db.delete(schema.geoUsage).where(eq(schema.geoUsage.companyId, companyId));
  });
  afterAll(async () => {
    spy.mockRestore();
    await db.delete(schema.geoSettings).where(eq(schema.geoSettings.companyId, companyId));
    await db.delete(schema.geoUsage).where(eq(schema.geoUsage.companyId, companyId));
  });
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('user-1');
  });

  describe('choosing', () => {
    it('is the built-in estimate until someone chooses, at version 0', async () => {
      expect(await c.geoSettings.get(companyId)).toMatchObject({ driver: 'builtin', version: 0, updatedBy: null });
      expect(await c.geoSettings.selection()).toBeNull();
    });

    it('saves a choice with a reason, checks the settings, and is what the services then use', async () => {
      const r = await save();
      expect(r).toMatchObject({ ok: true, data: { driver: 'osm', version: 1, updatedBy: 'user-1' } });
      expect(await c.geoSettings.selection()).toMatchObject({ driver: 'osm', config: { contactEmail: 'maps@shop.co.ke', countryCodes: ['ke'] } });
      expect((await c.geo.capabilities()).clientMap?.driver).toBe('leaflet');
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, companyId));
      expect(log.find((l) => l.action === 'geo.provider_changed')).toMatchObject({ fromState: 'builtin', toState: 'osm', reasonText: 'Trying the free maps' });
    });

    it('refuses without a reason, with a bad setting, a service not installed, or an unknown one, and changes nothing', async () => {
      const before = await c.geoSettings.get(companyId);
      expect(await save({ reason: 'no' })).toMatchObject({ ok: false, error: expect.stringContaining('Say why') as string });
      expect(await save({ config: { contactEmail: 'bad' } })).toMatchObject({ ok: false });
      expect(await save({ config: { ...osm, nominatimUrl: 'http://insecure.example' } })).toMatchObject({ ok: false });
      expect(await save({ driver: 'google', config: {} })).toMatchObject({ ok: false, error: expect.stringContaining('cannot be chosen yet') as string });
      expect(await save({ driver: 'nonsense' })).toMatchObject({ ok: false });
      expect(await save({ expectedVersion: 'x' })).toMatchObject({ ok: false });
      expect(await c.geoSettings.get(companyId)).toEqual(before);
    });

    it('lets only one of two people saving from the same version win', async () => {
      const v = await version();
      const [a, b] = await Promise.all([
        actions.saveGeoSettingsAction({ driver: 'osm', config: { ...osm, countryCodes: 'ke,ug' }, expectedVersion: v, reason: 'First person' }),
        actions.saveGeoSettingsAction({ driver: 'builtin', config: {}, expectedVersion: v, reason: 'Second person' }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      expect(loser).toMatchObject({ ok: false, code: 'CONFLICT' });
      expect(await version()).toBe(v + 1);
    });

    it('can go back to the built-in estimate', async () => {
      expect(await save({ driver: 'builtin', config: {}, reason: 'Back to the estimate' })).toMatchObject({ ok: true, data: { driver: 'builtin' } });
      expect((await c.geo.capabilities()).clientMap).toBeNull();
    });
  });

  describe('counting use', () => {
    it('adds calls to the hour they happened in and sums them into shares and times', async () => {
      await c.geoSettings.record(companyId, { provider: 'osm', op: 'search', ms: 300, ok: true, fellBack: false });
      await c.geoSettings.record(companyId, { provider: 'osm', op: 'search', ms: 1800, ok: true, fellBack: false });
      await c.geoSettings.record(companyId, { provider: 'osm', op: 'distance', ms: 2600, ok: false, fellBack: true });
      await c.geoSettings.record(companyId, { provider: 'builtin', op: 'distance', ms: 1, ok: true, fellBack: false });
      const rows = await db.select().from(schema.geoUsage).where(eq(schema.geoUsage.companyId, companyId));
      expect(rows.filter((r) => r.provider === 'osm')).toHaveLength(2);
      const metrics = await c.geoSettings.metrics(companyId, 30);
      expect(metrics.find((m) => m.provider === 'osm')).toEqual({ provider: 'osm', calls: 3, successPercent: 66.7, fallbackPercent: 33.3, averageMs: 1567, maxMs: 2600, within500Percent: 33.3, within1000Percent: 33.3, within2500Percent: 66.7 });
      expect(metrics.find((m) => m.provider === 'builtin')).toMatchObject({ calls: 1, successPercent: 100 });
    });

    it('counts what the service does by itself, without the caller doing anything', async () => {
      const before = (await c.geoSettings.metrics(companyId, 30)).find((m) => m.provider === 'builtin')?.calls ?? 0;
      await c.geo.distancesFrom({ latitude: -1.29, longitude: 36.82 }, [{ latitude: -1.0, longitude: 37.0 }]);
      await vi.waitFor(async () => expect((await c.geoSettings.metrics(companyId, 30)).find((m) => m.provider === 'builtin')?.calls).toBe(before + 1));
    });

    it('does not count what is older than the period asked about', async () => {
      await db.insert(schema.geoUsage).values({ companyId, provider: 'old', op: 'search', bucket: new Date(Date.now() - 90 * 86_400_000), calls: 50 });
      expect((await c.geoSettings.metrics(companyId, 30)).some((m) => m.provider === 'old')).toBe(false);
      expect((await c.geoSettings.metrics(companyId, 365)).some((m) => m.provider === 'old')).toBe(true);
    });
  });

  describe('trying a service', () => {
    it('runs each step and says what it found, without saving anything', async () => {
      const before = await c.geoSettings.get(companyId);
      const steps = await c.geoSettings.probe('builtin', {});
      expect(steps.map((s) => s.name)).toEqual(['Find a place by name', 'Name a pin on the map', 'Measure a road (Nairobi to Nakuru)']);
      expect(steps.every((s) => s.ok)).toBe(true);
      expect(steps[2]?.detail).toMatch(/km, about \d+ minutes \(estimated\)/);
      expect(await c.geoSettings.get(companyId)).toEqual(before);
    });
    it('refuses a service or settings it cannot try', async () => {
      await expect(c.geoSettings.probe('osm', {})).rejects.toThrow(/contact email/);
      await expect(c.geoSettings.probe('google', {})).rejects.toThrow(/Choose one/);
    });
    it('is spaced out, because it calls a real server', async () => {
      requirePermission.mockResolvedValue('user-1');
      expect(await actions.tryGeoSettingsAction({ driver: 'builtin', config: {} })).toMatchObject({ ok: true });
      expect(await actions.tryGeoSettingsAction({ driver: 'builtin', config: {} })).toMatchObject({ ok: false, code: 'CONFLICT' });
    });
  });

  describe('who may', () => {
    it('reading asks for deliveries:read, changing and trying ask for deliveries:manage', async () => {
      requirePermission.mockClear();
      await actions.geoSettingsPageAction();
      await save({ reason: 'x' });
      await actions.tryGeoSettingsAction({ driver: 'osm', config: {} });
      expect(requirePermission.mock.calls.map((call: unknown[]) => call.at(0))).toEqual(['deliveries:read', 'deliveries:manage', 'deliveries:manage']);
    });
    it('nobody without them sees or changes anything', async () => {
      const before = await c.geoSettings.get(companyId);
      requirePermission.mockRejectedValue(new Error('Forbidden'));
      for (const call of [actions.geoSettingsPageAction(), save(), actions.tryGeoSettingsAction({ driver: 'builtin', config: {} })]) expect((await call).ok).toBe(false);
      expect(await c.geoSettings.get(companyId)).toEqual(before);
    });
    it('the page gives the choice, the evidence and the shop’s own volume', async () => {
      const page = await actions.geoSettingsPageAction();
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.data.choice).toMatchObject({ driver: 'builtin' });
      expect(page.data.metrics.length).toBeGreaterThan(0);
      expect(typeof page.data.shop.ordersLast30Days).toBe('number');
      expect(page.data.shop.branches).toBeGreaterThanOrEqual(0);
    });
  });
});
