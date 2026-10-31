'use server';

import { and, asc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { branches, stockBalances, stockLocations } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { LOCATION_KINDS, isLocationKind, type LocationInput } from '@/lib/stock';
import { afterCursor, matching, pageOf, searchText, PAGE_SIZE } from '@/server/domains/settings/paging';
import { idOf, objectOf, runStock } from './action-support';
import { StockError } from './errors';

const PATHS = ['/admin/inventory/locations'];

export interface LocationView {
  id: string;
  code: string;
  name: string;
  kind: string;
  branchId: string | null;
  branchName: string | null;
  address: string;
  isSellable: boolean;
  sellsChannels: string[];
  fulfilsDelivery: boolean;
  allowNegative: boolean;
  isDefault: boolean;
  isActive: boolean;
  /** Products with stock here, and with stock promised here. */
  productsWithStock: number;
  /** Why it cannot be stopped, in words; null when it can. */
  stopBlocker: string | null;
}

const fieldsOf = (raw: unknown): LocationInput => {
  const i = objectOf(raw);
  return { code: i.code, name: i.name, kind: i.kind, branchId: i.branchId, address: i.address, isSellable: i.isSellable, sellsChannels: i.sellsChannels, fulfilsDelivery: i.fulfilsDelivery, allowNegative: i.allowNegative };
};

/** The locations a page at a time, each with whether it holds stock, so the screen can say why one cannot be stopped. One query for the page, not one per row. */
export async function stockLocationsPageAction(input: unknown) {
  return await runStock('stock:read', async (ctx) => {
    // Every company has a default location. A company set up after the migration has none until something makes it, so the list does.
    await getContainer().stockLocations.ensureDefault(ctx.companyId);
    const i = objectOf(input);
    const query = searchText({ query: typeof i.query === 'string' ? i.query : '' });
    const status = i.status === 'stopped' || i.status === 'all' ? i.status : 'active';
    const kind = isLocationKind(i.kind) ? i.kind : null;
    const conditions: (SQL | undefined)[] = [
      eq(stockLocations.companyId, ctx.companyId),
      kind === null ? undefined : eq(stockLocations.kind, kind),
      // Transit places belong to a transfer on its way and are never listed here.
      ne(stockLocations.kind, 'transit'),
      status === 'all' ? undefined : eq(stockLocations.isActive, status === 'active'),
      matching(query, [stockLocations.code, stockLocations.name]),
      afterCursor(typeof i.cursor === 'string' ? i.cursor : null, stockLocations.code, stockLocations.id),
    ];
    const rows = await drizzleDb
      .select({ l: stockLocations, branchName: branches.name })
      .from(stockLocations)
      .leftJoin(branches, eq(branches.id, stockLocations.branchId))
      .where(and(...conditions))
      .orderBy(asc(stockLocations.code), asc(stockLocations.id))
      .limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (r) => ({ k: r.l.code, id: r.l.id }));
    const ids = page.rows.map((r) => r.l.id);
    const held = ids.length === 0 ? [] : await drizzleDb
      .select({ locationId: stockBalances.locationId, n: sql<number>`count(DISTINCT ${stockBalances.productId})::int` })
      .from(stockBalances)
      .where(and(sql`${stockBalances.locationId} IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`, sql`(${stockBalances.onHand} <> 0 OR ${stockBalances.reserved} <> 0)`))
      .groupBy(stockBalances.locationId);
    const heldBy = new Map(held.map((h) => [h.locationId, h.n]));
    const rowsOut: LocationView[] = page.rows.map(({ l, branchName }) => {
      const n = heldBy.get(l.id) ?? 0;
      let blocker: string | null = null;
      if (l.isDefault) blocker = 'This is the default location. Make another location the default first.';
      else if (n > 0) blocker = `It holds or has promised stock of ${String(n)} product${n === 1 ? '' : 's'}. Move or sell that first.`;
      return {
        id: l.id, code: l.code, name: l.name, kind: l.kind, branchId: l.branchId, branchName, address: l.address, isSellable: l.isSellable, sellsChannels: l.sellsChannels,
        fulfilsDelivery: l.fulfilsDelivery, allowNegative: l.allowNegative, isDefault: l.isDefault, isActive: l.isActive, productsWithStock: n, stopBlocker: l.isActive ? blocker : null,
      };
    });
    return { rows: rowsOut, nextCursor: page.nextCursor, kinds: [...LOCATION_KINDS].filter((k) => k !== 'transit') };
  });
}

export async function createStockLocationAction(input: unknown) {
  return await runStock('stock:locations_manage', async (ctx) => {
    const made = await getContainer().stockLocations.create(ctx.companyId, fieldsOf(input));
    return { id: made.id, code: made.code, name: made.name };
  }, PATHS);
}

export async function updateStockLocationAction(id: unknown, input: unknown) {
  return await runStock('stock:locations_manage', async (ctx) => {
    const done = await getContainer().stockLocations.update(ctx.companyId, idOf(id, 'location'), fieldsOf(input));
    return { id: done.id };
  }, PATHS);
}

export async function makeDefaultStockLocationAction(id: unknown) {
  return await runStock('stock:locations_manage', async (ctx) => {
    await getContainer().stockLocations.makeDefault(ctx.companyId, idOf(id, 'location'));
    return { done: true };
  }, PATHS);
}

export async function setStockLocationActiveAction(id: unknown, active: unknown) {
  return await runStock('stock:locations_manage', async (ctx) => {
    if (typeof active !== 'boolean') throw new StockError('Say whether to stop or restart the location.', 'BAD_INPUT');
    const location = idOf(id, 'location');
    if (active) await getContainer().stockLocations.reactivate(ctx.companyId, location);
    else await getContainer().stockLocations.deactivate(ctx.companyId, location);
    return { active };
  }, PATHS);
}
