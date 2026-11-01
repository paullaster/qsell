import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as Actions from './actions';
import type * as Sources from './lookup-sources';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Delivery zones, their places and the methods each branch offers, against a real database: the rules the database keeps, two
 * people at once, finding the zone of an address or a pin, one company never seeing another's, and the actions' permissions.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('delivery zones and methods (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof Actions;
  let sources: typeof Sources;
  let companyId: string;
  let otherCompany: string;
  let spy: { mockRestore: () => void };
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const actor = { id: 'user-1' };
  const madeZones: string[] = [];
  const madeBranches: string[] = [];
  let n = 0;
  const code = () => `${tag}${String((n += 1)).padStart(3, '0')}`;
  const place = (s: string) => `${s} ${tag}`;
  const zoneRow = async (over: Record<string, unknown> = {}) => {
    const r = await actions.createDeliveryZoneAction({ code: code(), name: 'Test zone', ...over });
    if (!r.ok) throw new Error(r.error);
    madeZones.push(r.data.id);
    return r.data;
  };
  const history = async (id: string) => (await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id)).orderBy(schema.decisionLog.occurredAt)).map((r) => [r.action, r.fromState, r.toState]);
  const branch = async (company = companyId) => {
    const id = (await db.insert(schema.branches).values({ companyId: company, code: code(), name: 'Delivery branch' }).returning())[0]?.id ?? '';
    madeBranches.push(id);
    return id;
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./actions');
    sources = await import('./lookup-sources');
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    // A database with two companies does not say which is "the" company; the actions are run as ours.
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    const o = await db.insert(schema.companySettings).values({ legalName: `Other ${tag}`, tradingName: `Other ${tag}`, email: `o-${tag}@example.test`, phone: '0', streetAddress: '1', city: 'N', countyOrState: 'N', postalCode: '0', kraPin: `P${tag}` }).returning();
    otherCompany = o[0]?.id ?? '';
  });
  afterAll(async () => {
    spy.mockRestore();
    // Areas first (a zone with places cannot be removed), then the zones and branches the tests made.
    if (madeZones.length > 0) {
      await db.delete(schema.deliveryZoneAreas).where(inArray(schema.deliveryZoneAreas.zoneId, madeZones));
      await db.delete(schema.deliveryZones).where(inArray(schema.deliveryZones.id, madeZones));
    }
    if (madeBranches.length > 0) await db.delete(schema.branches).where(inArray(schema.branches.id, madeBranches));
    await db.delete(schema.companySettings).where(eq(schema.companySettings.id, otherCompany));
  });
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('user-1');
  });

  describe('zones', () => {
    it('are made with a capital code, and a second one with the same code is refused in words', async () => {
      const made = await zoneRow({ code: ` ${code().toLowerCase()} `, name: ' Westlands ', description: 'Offices and malls' });
      expect(made).toMatchObject({ name: 'Westlands', description: 'Offices and malls', isActive: true, version: 1, areaCount: 0, centre: null, radiusKm: null });
      expect(made.code).toBe(made.code.toUpperCase());
      const again = await actions.createDeliveryZoneAction({ code: made.code.toLowerCase(), name: 'Again' });
      expect(again).toEqual({ ok: false, error: `A zone with the code ${made.code} already exists.`, code: 'DUPLICATE' });
      expect(await history(made.id)).toEqual([['delivery.zone_created', null, made.code]]);
    });

    it('refuse what is not a zone before touching the database', async () => {
      expect(await actions.createDeliveryZoneAction({ code: '', name: 'x' })).toMatchObject({ ok: false, error: 'Give the zone a code.' });
      expect(await actions.createDeliveryZoneAction({ code: code(), name: '' })).toMatchObject({ ok: false, error: 'Give the zone a name.' });
      expect(await actions.createDeliveryZoneAction({ code: code(), name: 'x', centreLatitude: '1' })).toMatchObject({ ok: false });
      expect(await actions.createDeliveryZoneAction('nonsense')).toMatchObject({ ok: false });
    });

    it('keep a coverage circle whole: all of it or none, and a real place', async () => {
      const z = await zoneRow({ centreLatitude: '-1.2864', centreLongitude: '36.8172', radiusKm: '3.5' });
      expect(z).toMatchObject({ centre: { latitude: -1.2864, longitude: 36.8172 }, radiusKm: 3.5 });
      for (const bad of [sql`UPDATE delivery_zones SET radius_km = NULL WHERE id = ${z.id}`, sql`UPDATE delivery_zones SET centre_latitude = 95 WHERE id = ${z.id}`, sql`UPDATE delivery_zones SET radius_km = 0 WHERE id = ${z.id}`, sql`UPDATE delivery_zones SET radius_km = 2500 WHERE id = ${z.id}`]) {
        await expect(db.execute(bad)).rejects.toThrow();
      }
    });

    it('change only if still the version the person saw, and say so when someone else got there first', async () => {
      const z = await zoneRow();
      const first = await actions.updateDeliveryZoneAction(z.id, { code: z.code, name: 'Renamed' }, z.version);
      expect(first).toMatchObject({ ok: true, data: { name: 'Renamed', version: 2 } });
      const stale = await actions.updateDeliveryZoneAction(z.id, { code: z.code, name: 'Mine' }, z.version);
      expect(stale).toEqual({ ok: false, error: 'Someone else changed this zone while you were editing. Reload it and make your change again.', code: 'CONFLICT' });
      expect((await db.select().from(schema.deliveryZones).where(eq(schema.deliveryZones.id, z.id)))[0]?.name).toBe('Renamed');
      expect((await history(z.id)).at(-1)).toEqual(['delivery.zone_changed', `${z.code} v1`, `${z.code} v2`]);
    });

    it('two people saving at once: exactly one wins, the other is told', async () => {
      const z = await zoneRow();
      const results = await Promise.all([actions.updateDeliveryZoneAction(z.id, { code: z.code, name: 'A' }, 1), actions.updateDeliveryZoneAction(z.id, { code: z.code, name: 'B' }, 1)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: 'CONFLICT' });
    });

    it('are stopped and restarted, never deleted, and the log says so', async () => {
      const z = await zoneRow();
      expect(await actions.setDeliveryZoneActiveAction(z.id, false)).toMatchObject({ ok: true, data: { isActive: false } });
      expect(await actions.setDeliveryZoneActiveAction(z.id, false)).toMatchObject({ ok: true });
      expect(await actions.setDeliveryZoneActiveAction(z.id, true)).toMatchObject({ ok: true, data: { isActive: true } });
      expect((await history(z.id)).map((h) => h[0])).toEqual(['delivery.zone_created', 'delivery.zone_stopped', 'delivery.zone_restarted']);
      expect(await actions.setDeliveryZoneActiveAction(z.id, 'no')).toMatchObject({ ok: false });
    });

    it('are listed a page at a time with their places counted, searched by code or name, and stopped ones only on request', async () => {
      const a = await zoneRow({ name: `Alpha ${tag}` });
      const b = await zoneRow({ name: `Beta ${tag}` });
      await c.deliveryZones.addAreas(companyId, actor, a.id, [{ county: place('Nairobi'), town: null, area: null, countyKey: `nairobi ${tag.toLowerCase()}`, townKey: '', areaKey: '' }]);
      await actions.setDeliveryZoneActiveAction(b.id, false);
      const live = await actions.deliveryZonesPageAction({ query: `alpha ${tag}` });
      expect(live.ok && live.data.rows.map((r) => [r.code, r.areaCount])).toEqual([[a.code, 1]]);
      const liveBoth = await actions.deliveryZonesPageAction({ query: `a ${tag}` });
      expect(liveBoth.ok && liveBoth.data.rows.map((r) => r.code)).toEqual(expect.not.arrayContaining([b.code]));
      const all = await actions.deliveryZonesPageAction({ query: tag, status: 'all' });
      expect(all.ok && all.data.rows.map((r) => r.code)).toEqual(expect.arrayContaining([a.code, b.code]));
      expect(all.ok && all.data.rows.map((r) => r.code)).toEqual([...(all.ok ? all.data.rows.map((r) => r.code) : [])].sort());
      const byName = await actions.deliveryZonesPageAction({ query: `beta ${tag}`, status: 'all' });
      expect(byName.ok && byName.data.rows).toHaveLength(1);
    });

    it('page with a keyset and no repeats', async () => {
      for (let i = 0; i < 27; i += 1) await db.insert(schema.deliveryZones).values({ companyId, code: `PG${tag}${String(i).padStart(2, '0')}`, name: `Paged ${tag}` }).then(() => undefined);
      const rows = await db.select({ id: schema.deliveryZones.id }).from(schema.deliveryZones).where(sql`code LIKE ${`PG${tag}%`}`);
      madeZones.push(...rows.map((r) => r.id));
      const first = await actions.deliveryZonesPageAction({ query: `PG${tag}` });
      expect(first.ok && first.data.rows).toHaveLength(25);
      const next = first.ok ? first.data.nextCursor : null;
      expect(next).not.toBeNull();
      const second = await actions.deliveryZonesPageAction({ query: `PG${tag}`, cursor: next });
      expect(second.ok && second.data.rows).toHaveLength(2);
      expect(second.ok && second.data.nextCursor).toBeNull();
      const ids = new Set([...(first.ok ? first.data.rows : []), ...(second.ok ? second.data.rows : [])].map((r) => r.id));
      expect(ids.size).toBe(27);
    });
  });

  describe('places', () => {
    it('are added one at a time and many at once, and shown in words a page at a time', async () => {
      const z = await zoneRow();
      const one = await actions.addDeliveryZoneAreasAction(z.id, { county: place('Nairobi'), town: 'Westlands', area: '' });
      expect(one).toMatchObject({ ok: true, data: { added: 1, skipped: [], problems: [] } });
      const many = await actions.addDeliveryZoneAreasAction(z.id, { lines: `${place('Nairobi')}, Kilimani\n${place('Mombasa')}\n,, \n` });
      expect(many).toMatchObject({ ok: true, data: { added: 2, problems: [{ line: 3, error: 'Give at least a county, a town or an area.' }] } });
      const page = await actions.deliveryZoneAreasPageAction(z.id, null);
      expect(page.ok && page.data.rows.map((r) => r.words).sort()).toEqual([`Kilimani, ${place('Nairobi')}`, place('Mombasa'), `Westlands, ${place('Nairobi')}`].sort());
      expect((await history(z.id)).filter((h) => h[0] === 'delivery.zone_areas_added')).toHaveLength(2);
    });

    it('belong to one zone only: a place already in a zone is skipped and the zone is named', async () => {
      const a = await zoneRow();
      const b = await zoneRow();
      await actions.addDeliveryZoneAreasAction(a.id, { county: place('Kisumu'), town: 'Milimani' });
      const r = await actions.addDeliveryZoneAreasAction(b.id, { lines: `${place('Kisumu')}, milimani\n${place('Kisumu')}, Nyalenda` });
      expect(r).toMatchObject({ ok: true, data: { added: 1, skipped: [{ words: `milimani, ${place('Kisumu')}`, zoneCode: a.code, reason: `It is already in zone ${a.code}.` }] } });
      const same = await actions.addDeliveryZoneAreasAction(a.id, { county: place('KISUMU'), town: 'MILIMANI' });
      expect(same).toMatchObject({ ok: true, data: { added: 0, skipped: [{ reason: 'It is already in this zone.' }] } });
    });

    it('two zones adding the same place at once: exactly one gets it', async () => {
      const a = await zoneRow();
      const b = await zoneRow();
      const input = { county: place('Nakuru'), town: 'Section 58' };
      const results = await Promise.all([actions.addDeliveryZoneAreasAction(a.id, input), actions.addDeliveryZoneAreasAction(b.id, input)]);
      const added = results.reduce((sum, r) => sum + (r.ok ? r.data.added : 0), 0);
      expect(added).toBe(1);
      const rows = await db.select().from(schema.deliveryZoneAreas).where(inArray(schema.deliveryZoneAreas.zoneId, [a.id, b.id]));
      expect(rows).toHaveLength(1);
    });

    it('cannot be added to a stopped zone, or one that is not this company’s, or past 200 at a time', async () => {
      const z = await zoneRow();
      await actions.setDeliveryZoneActiveAction(z.id, false);
      expect(await actions.addDeliveryZoneAreasAction(z.id, { county: place('X') })).toMatchObject({ ok: false, error: 'This zone is stopped. Restart it to add places.' });
      const foreign = (await db.insert(schema.deliveryZones).values({ companyId: otherCompany, code: code(), name: 'Foreign' }).returning())[0]?.id ?? '';
      madeZones.push(foreign);
      expect(await actions.addDeliveryZoneAreasAction(foreign, { county: place('X') })).toMatchObject({ ok: false, error: 'That zone could not be found.' });
      const live = await zoneRow();
      const lines = Array.from({ length: 201 }, (_, i) => `${place('Big')}, Town ${String(i)}`).join('\n');
      expect(await actions.addDeliveryZoneAreasAction(live.id, { lines })).toMatchObject({ ok: false, error: 'Add at most 200 places at a time.' });
      expect(await actions.addDeliveryZoneAreasAction(live.id, { lines: '' })).toMatchObject({ ok: false });
    });

    it('are removed, once, and the log remembers which', async () => {
      const z = await zoneRow();
      await actions.addDeliveryZoneAreasAction(z.id, { county: place('Eldoret'), town: 'Langas' });
      const page = await actions.deliveryZoneAreasPageAction(z.id, null);
      const id = page.ok ? (page.data.rows[0]?.id ?? '') : '';
      expect(await actions.removeDeliveryZoneAreaAction(id)).toMatchObject({ ok: true });
      expect(await actions.removeDeliveryZoneAreaAction(id)).toMatchObject({ ok: false, error: 'That area could not be found.' });
      expect((await history(z.id)).at(-1)).toEqual(['delivery.zone_area_removed', `Langas, ${place('Eldoret')}`, null]);
      expect(await actions.removeDeliveryZoneAreaAction('not-an-id')).toMatchObject({ ok: false });
    });

    it('page by keyset and never repeat', async () => {
      const z = await zoneRow();
      const lines = Array.from({ length: 30 }, (_, i) => `${place('Pg')}, Town ${String(i).padStart(2, '0')}`).join('\n');
      await actions.addDeliveryZoneAreasAction(z.id, { lines });
      const first = await actions.deliveryZoneAreasPageAction(z.id, null);
      expect(first.ok && first.data.rows).toHaveLength(25);
      const second = await actions.deliveryZoneAreasPageAction(z.id, first.ok ? first.data.nextCursor : null);
      expect(second.ok && second.data.rows).toHaveLength(5);
      expect(new Set([...(first.ok ? first.data.rows : []), ...(second.ok ? second.data.rows : [])].map((r) => r.id)).size).toBe(30);
    });

    it('can not be left with no words at all, even by a direct write', async () => {
      const z = await zoneRow();
      await expect(db.insert(schema.deliveryZoneAreas).values({ companyId, zoneId: z.id })).rejects.toThrow();
    });
  });

  describe('finding the zone of a delivery', () => {
    it('matches a written address through the most specific place, ignoring case and spacing, and a stopped zone is not found', async () => {
      const county = await zoneRow();
      const town = await zoneRow();
      const estate = await zoneRow();
      await actions.addDeliveryZoneAreasAction(county.id, { county: place('Kiambu') });
      await actions.addDeliveryZoneAreasAction(town.id, { county: place('Kiambu'), town: 'Thika' });
      await actions.addDeliveryZoneAreasAction(estate.id, { county: place('Kiambu'), town: 'Thika', area: 'Makongeni' });
      const at = async (address: Record<string, string>) => {
        const m = await c.deliveryZones.resolve(companyId, { address });
        return m === null ? null : m.zone.code;
      };
      expect(await at({ county: `${place('KIAMBU')} County`, town: ' thika ', area: 'MAKONGENI' })).toBe(estate.code);
      expect(await at({ county: place('Kiambu'), town: 'Thika', area: 'Section 9' })).toBe(town.code);
      expect(await at({ county: place('Kiambu'), town: 'Ruiru' })).toBe(county.code);
      expect(await at({ county: place('Machakos') })).toBeNull();
      await actions.setDeliveryZoneActiveAction(estate.id, false);
      expect(await at({ county: place('Kiambu'), town: 'Thika', area: 'Makongeni' })).toBe(town.code);
    });

    it('matches a pin through a coverage circle, which beats the written address, and falls back to the address outside it', async () => {
      const circle = await zoneRow({ centreLatitude: '-1.2640', centreLongitude: '36.8070', radiusKm: '4' });
      const byWords = await zoneRow();
      await actions.addDeliveryZoneAreasAction(byWords.id, { county: place('Nairobi'), town: 'Karen' });
      const inside = await c.deliveryZones.resolve(companyId, { address: { county: place('Nairobi'), town: 'Karen' }, pin: { latitude: -1.265, longitude: 36.808 } });
      expect(inside).toMatchObject({ by: 'pin', zone: { code: circle.code } });
      const outside = await c.deliveryZones.resolve(companyId, { address: { county: place('Nairobi'), town: 'Karen' }, pin: { latitude: -1.35, longitude: 36.7 } });
      expect(outside).toMatchObject({ by: 'address', zone: { code: byWords.code } });
      expect(await c.deliveryZones.resolve(companyId, { pin: { latitude: 10, longitude: 10 } })).toBeNull();
      expect(await c.deliveryZones.resolve(companyId, {})).toBeNull();
    });

    it('never finds another company’s zone', async () => {
      const z = await zoneRow();
      await actions.addDeliveryZoneAreasAction(z.id, { county: place('Garissa') });
      expect(await c.deliveryZones.resolve(otherCompany, { address: { county: place('Garissa') } })).toBeNull();
      expect(await c.deliveryZones.resolve(companyId, { address: { county: place('Garissa') } })).toMatchObject({ zone: { code: z.code } });
    });
  });

  describe('methods', () => {
    it('are listed for every branch with all four methods, off until set', async () => {
      const b = await branch();
      const first = await actions.deliveryMethodsPageAction({ query: (await db.select().from(schema.branches).where(eq(schema.branches.id, b)))[0]?.code });
      expect(first.ok && first.data.rows[0]?.methods.map((m) => [m.method, m.isActive])).toEqual([['own_fleet', false], ['courier', false], ['pickup', false], ['scheduled_visit', false]]);
    });

    it('are set per branch, kept as one row each, and a repeat of the same setting leaves no new note in the log', async () => {
      const b = await branch();
      const on = { isActive: true, leadTimeMinutes: 90, note: 'Call first' };
      expect(await actions.setDeliveryMethodAction(b, 'pickup', on)).toMatchObject({ ok: true, data: { method: 'pickup', isActive: true, leadTimeMinutes: 90, note: 'Call first' } });
      await actions.setDeliveryMethodAction(b, 'pickup', on);
      await actions.setDeliveryMethodAction(b, 'pickup', { ...on, leadTimeMinutes: 30 });
      await actions.setDeliveryMethodAction(b, 'own_fleet', { isActive: true, leadTimeMinutes: 0, note: '' });
      expect((await c.deliveryMethods.offered(companyId, b)).map((m) => m.method).sort()).toEqual(['own_fleet', 'pickup']);
      expect(await db.select().from(schema.deliveryMethods).where(eq(schema.deliveryMethods.branchId, b))).toHaveLength(2);
      expect((await history(b)).filter((h) => h[0] === 'delivery.method_changed')).toEqual([['delivery.method_changed', 'not offered', 'pickup on'], ['delivery.method_changed', 'pickup on', 'pickup on'], ['delivery.method_changed', 'not offered', 'own_fleet on']]);
      await actions.setDeliveryMethodAction(b, 'pickup', { isActive: false, leadTimeMinutes: 30, note: 'Call first' });
      expect((await c.deliveryMethods.offered(companyId, b)).map((m) => m.method)).toEqual(['own_fleet']);
    });

    it('refuse a method that does not exist, a bad time, another company’s branch, and a bad id', async () => {
      const b = await branch();
      expect(await actions.setDeliveryMethodAction(b, 'drone', { isActive: true, leadTimeMinutes: 0 })).toMatchObject({ ok: false, error: 'That is not a delivery method.' });
      expect(await actions.setDeliveryMethodAction(b, 'pickup', { isActive: true, leadTimeMinutes: -5 })).toMatchObject({ ok: false });
      const foreign = await branch(otherCompany);
      expect(await actions.setDeliveryMethodAction(foreign, 'pickup', { isActive: true, leadTimeMinutes: 0 })).toMatchObject({ ok: false, error: 'That branch does not exist.' });
      expect(await actions.setDeliveryMethodAction('nope', 'pickup', { isActive: true, leadTimeMinutes: 0 })).toMatchObject({ ok: false });
      await expect(db.execute(sql`INSERT INTO delivery_methods (company_id, branch_id, method) VALUES (${companyId}, ${b}, 'teleport')`)).rejects.toThrow();
      await expect(db.execute(sql`INSERT INTO delivery_methods (company_id, branch_id, method, lead_time_minutes) VALUES (${companyId}, ${b}, 'courier', -1)`)).rejects.toThrow();
    });
  });

  describe('permissions', () => {
    it('reading asks for deliveries:read and every change asks for deliveries:manage', async () => {
      const z = await zoneRow();
      const b = await branch();
      requirePermission.mockClear();
      await actions.deliveryZonesPageAction({});
      await actions.deliveryZoneAreasPageAction(z.id, null);
      await actions.deliveryMethodsPageAction({});
      await actions.createDeliveryZoneAction({ code: code(), name: 'p' });
      await actions.updateDeliveryZoneAction(z.id, { code: z.code, name: 'p2' }, 1);
      await actions.setDeliveryZoneActiveAction(z.id, true);
      await actions.addDeliveryZoneAreasAction(z.id, { county: place('Perm') });
      await actions.removeDeliveryZoneAreaAction(randomUUID());
      await actions.setDeliveryMethodAction(b, 'courier', { isActive: true, leadTimeMinutes: 0 });
      expect(requirePermission.mock.calls.map((call: unknown[]) => call.at(0))).toEqual(['deliveries:read', 'deliveries:read', 'deliveries:read', 'deliveries:manage', 'deliveries:manage', 'deliveries:manage', 'deliveries:manage', 'deliveries:manage', 'deliveries:manage']);
    });

    it('nobody without the permission changes or sees anything', async () => {
      const z = await zoneRow();
      requirePermission.mockRejectedValue(new Error('Forbidden'));
      for (const call of [actions.deliveryZonesPageAction({}), actions.createDeliveryZoneAction({ code: code(), name: 'x' }), actions.updateDeliveryZoneAction(z.id, { code: z.code, name: 'x' }, 1), actions.setDeliveryZoneActiveAction(z.id, false), actions.addDeliveryZoneAreasAction(z.id, { county: place('No') }), actions.deliveryMethodsPageAction({})]) {
        expect((await call).ok).toBe(false);
      }
      expect((await db.select().from(schema.deliveryZones).where(eq(schema.deliveryZones.id, z.id)))[0]).toMatchObject({ name: 'Test zone', isActive: true });
    });
  });

  describe('the zone picker', () => {
    it('offers this company’s active zones by code or name, and nothing else', async () => {
      const live = await zoneRow({ name: `Pickable ${tag}` });
      const stopped = await zoneRow({ name: `Pickable stopped ${tag}` });
      await actions.setDeliveryZoneActiveAction(stopped.id, false);
      const foreign = (await db.insert(schema.deliveryZones).values({ companyId: otherCompany, code: code(), name: `Pickable foreign ${tag}` }).returning())[0]?.id ?? '';
      madeZones.push(foreign);
      const source = sources.DELIVERY_LOOKUP_SOURCES[0];
      const page = await source?.search({ companyId, query: `pickable ${tag}`, limit: 20, after: null, filters: {} });
      expect(page?.options.map((o) => o.id)).toEqual([live.id]);
      expect(source?.key).toBe('delivery-zones');
      expect(source?.permission).toBe('deliveries:read');
      await expect(source?.search({ companyId, query: '', limit: 5, after: null, filters: { status: 'x' } })).rejects.toThrow();
    });
  });
});
