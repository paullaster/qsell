'use server';

import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveryZoneAreas, deliveryZones, type DeliveryZoneRow } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { readAreaInput, readAreaLines, readZoneInput, areaWords } from '@/lib/delivery-zones';
import { DELIVERY_METHODS, isDeliveryMethod, readMethodSettings, type DeliveryMethod } from '@/lib/delivery-methods';
import { afterCursor, matching, pageOf, searchText, PAGE_SIZE } from '@/server/domains/settings/paging';
import { idOf, objectOf, runDelivery, versionOf } from './action-support';
import { DeliveryError } from './errors';

const ZONE_PATHS = ['/admin/delivery/zones'];
const METHOD_PATHS = ['/admin/delivery/methods'];
const AREA_PAGE = 25;

export interface ZoneView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  centre: { latitude: number; longitude: number } | null;
  radiusKm: number | null;
  isActive: boolean;
  version: number;
  areaCount: number;
}

const toView = (z: DeliveryZoneRow, areaCount: number): ZoneView => ({
  id: z.id,
  code: z.code,
  name: z.name,
  description: z.description,
  centre: z.centreLatitude === null || z.centreLongitude === null ? null : { latitude: z.centreLatitude, longitude: z.centreLongitude },
  radiusKm: z.radiusKm === null ? null : Number(z.radiusKm),
  isActive: z.isActive,
  version: z.version,
  areaCount,
});

const zoneInput = (raw: unknown) => {
  const read = readZoneInput(objectOf(raw));
  if (!read.ok) throw new DeliveryError(read.error, 'BAD_INPUT');
  return read.value;
};

/** The zones a page at a time with how many places each has (one grouped query for the page, not one per zone). */
export async function deliveryZonesPageAction(input: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const i = objectOf(input);
    const query = searchText({ query: typeof i.query === 'string' ? i.query : '' });
    const status = i.status === 'all' ? 'all' : 'active';
    const conditions: (SQL | undefined)[] = [
      eq(deliveryZones.companyId, ctx.companyId),
      status === 'all' ? undefined : eq(deliveryZones.isActive, true),
      matching(query, [deliveryZones.code, deliveryZones.name]),
      afterCursor(typeof i.cursor === 'string' ? i.cursor : null, deliveryZones.code, deliveryZones.id),
    ];
    const rows = await drizzleDb.select().from(deliveryZones).where(and(...conditions)).orderBy(asc(deliveryZones.code), asc(deliveryZones.id)).limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (z) => ({ k: z.code, id: z.id }));
    const ids = page.rows.map((z) => z.id);
    const counts = ids.length === 0 ? [] : await drizzleDb.select({ zoneId: deliveryZoneAreas.zoneId, n: sql<number>`count(*)::int` }).from(deliveryZoneAreas).where(inArray(deliveryZoneAreas.zoneId, ids)).groupBy(deliveryZoneAreas.zoneId);
    const countOf = new Map(counts.map((c) => [c.zoneId, c.n]));
    return { rows: page.rows.map((z) => toView(z, countOf.get(z.id) ?? 0)), nextCursor: page.nextCursor };
  });
}

export async function createDeliveryZoneAction(input: unknown) {
  return await runDelivery('deliveries:manage', async (ctx) => {
    const row = await getContainer().deliveryZones.create(ctx.companyId, { id: ctx.userId }, zoneInput(input));
    return toView(row, 0);
  }, ZONE_PATHS);
}

export async function updateDeliveryZoneAction(id: unknown, input: unknown, version: unknown) {
  return await runDelivery('deliveries:manage', async (ctx) => {
    const row = await getContainer().deliveryZones.update(ctx.companyId, { id: ctx.userId }, idOf(id, 'zone'), zoneInput(input), versionOf(version));
    const [count] = await drizzleDb.select({ n: sql<number>`count(*)::int` }).from(deliveryZoneAreas).where(eq(deliveryZoneAreas.zoneId, row.id));
    return toView(row, count?.n ?? 0);
  }, ZONE_PATHS);
}

export async function setDeliveryZoneActiveAction(id: unknown, active: unknown) {
  return await runDelivery('deliveries:manage', async (ctx) => {
    if (typeof active !== 'boolean') throw new DeliveryError('Say whether to stop or restart the zone.', 'BAD_INPUT');
    const row = await getContainer().deliveryZones.setActive(ctx.companyId, { id: ctx.userId }, idOf(id, 'zone'), active);
    return { id: row.id, isActive: row.isActive };
  }, ZONE_PATHS);
}

export interface AreaView {
  id: string;
  words: string;
}

/** A zone's places a page at a time. */
export async function deliveryZoneAreasPageAction(zoneId: unknown, cursor: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const page = await getContainer().deliveryZones.areasPage(ctx.companyId, idOf(zoneId, 'zone'), typeof cursor === 'string' && cursor !== '' ? idOf(cursor, 'page') : null, AREA_PAGE);
    return { rows: page.rows.map((a): AreaView => ({ id: a.id, words: areaWords(a) })), nextCursor: page.next };
  });
}

/** Adds places to a zone: one (county, town, area) or many pasted lines. Places already in a zone are skipped and listed. */
export async function addDeliveryZoneAreasAction(zoneId: unknown, input: unknown) {
  return await runDelivery('deliveries:manage', async (ctx) => {
    const i = objectOf(input);
    let areas;
    let problems: { line: number; text: string; error: string }[] = [];
    if (typeof i.lines === 'string') {
      const read = readAreaLines(i.lines);
      if (read.tooMany) throw new DeliveryError('Add at most 200 places at a time.', 'BAD_INPUT');
      areas = read.areas;
      problems = read.problems;
    } else {
      const read = readAreaInput(i);
      if (!read.ok) throw new DeliveryError(read.error, 'BAD_INPUT');
      areas = [read.value];
    }
    if (areas.length === 0) throw new DeliveryError(problems[0]?.error ?? 'There is nothing to add.', 'BAD_INPUT');
    const result = await getContainer().deliveryZones.addAreas(ctx.companyId, { id: ctx.userId }, idOf(zoneId, 'zone'), areas);
    return { added: result.added, skipped: result.skipped, problems };
  }, ZONE_PATHS);
}

export async function removeDeliveryZoneAreaAction(areaId: unknown) {
  return await runDelivery('deliveries:manage', async (ctx) => {
    await getContainer().deliveryZones.removeArea(ctx.companyId, { id: ctx.userId }, idOf(areaId, 'area'));
    return { removed: true };
  }, ZONE_PATHS);
}

export interface BranchMethodsView {
  branchId: string;
  code: string;
  name: string;
  isActive: boolean;
  methods: { method: DeliveryMethod; isActive: boolean; leadTimeMinutes: number; note: string | null }[];
}

/** The branches a page at a time, each with all four methods (the ones never set show as off). */
export async function deliveryMethodsPageAction(input: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const i = objectOf(input);
    const query = searchText({ query: typeof i.query === 'string' ? i.query : '' });
    const rows = await drizzleDb
      .select({ id: branches.id, code: branches.code, name: branches.name, isActive: branches.isActive })
      .from(branches)
      .where(and(eq(branches.companyId, ctx.companyId), matching(query, [branches.code, branches.name]), afterCursor(typeof i.cursor === 'string' ? i.cursor : null, branches.code, branches.id)))
      .orderBy(asc(branches.code), asc(branches.id))
      .limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (b) => ({ k: b.code, id: b.id }));
    const set = await getContainer().deliveryMethods.forBranches(ctx.companyId, page.rows.map((b) => b.id));
    const out: BranchMethodsView[] = page.rows.map((b) => ({
      branchId: b.id,
      code: b.code,
      name: b.name,
      isActive: b.isActive,
      methods: DELIVERY_METHODS.map((method) => {
        const found = set.get(b.id)?.find((m) => m.method === method);
        return { method, isActive: found?.isActive ?? false, leadTimeMinutes: found?.leadTimeMinutes ?? 0, note: found?.note ?? null };
      }),
    }));
    return { rows: out, nextCursor: page.nextCursor };
  });
}

export async function setDeliveryMethodAction(branchId: unknown, method: unknown, input: unknown) {
  return await runDelivery('deliveries:manage', async (ctx) => {
    if (!isDeliveryMethod(method)) throw new DeliveryError('That is not a delivery method.', 'BAD_INPUT');
    const read = readMethodSettings(objectOf(input));
    if (!read.ok) throw new DeliveryError(read.error, 'BAD_INPUT');
    const row = await getContainer().deliveryMethods.set(ctx.companyId, { id: ctx.userId }, idOf(branchId, 'branch'), method, read.value);
    return { method: row.method, isActive: row.isActive, leadTimeMinutes: row.leadTimeMinutes, note: row.note };
  }, METHOD_PATHS);
}
