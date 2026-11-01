'use server';

import { and, asc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { products, stockLocations } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import { matching, PAGE_SIZE, searchText } from '@/server/domains/settings/paging';
import { objectOf, runStock } from './action-support';

function sourceOf(mode: { ledgerMode: boolean; shadowWrite: boolean }): 'ledger' | 'shadow' | 'off' {
  if (mode.ledgerMode) return 'ledger';
  return mode.shadowWrite ? 'shadow' : 'off';
}

/** Columns shown at once: more than this and the person narrows to one location. */
const MAX_COLUMNS = 8;

export interface MatrixColumn {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}

export interface MatrixRow {
  productId: string;
  name: string;
  sku: string;
  /** Over every location, not only the columns shown. */
  total: number;
  totalReserved: number;
  /** By location id. A place with nothing is not in the map. */
  cells: Record<string, { onHand: number; reserved: number }>;
}

export interface StockMatrix {
  columns: MatrixColumn[];
  /** There are more places than columns; choose one to see it. */
  moreLocations: boolean;
  rows: MatrixRow[];
  nextCursor: string | null;
  /** Whether the per-location figures are the truth (ledger), a copy of the old counts (shadow), or not kept yet (off). */
  source: 'ledger' | 'shadow' | 'off';
}

/**
 * Products against locations: how much is where. A page of products at a time, the places as columns (all of them up to eight, or
 * the one chosen). One query for the page's figures, one for its totals. The figures are what the ledger says; the screen says how far
 * to trust them.
 */
export async function stockMatrixAction(input: unknown) {
  return await runStock('stock:read', async (ctx): Promise<StockMatrix> => {
    const i = objectOf(input);
    const query = searchText({ query: typeof i.query === 'string' ? i.query : '' });
    const only = typeof i.locationId === 'string' && /^[0-9a-f-]{36}$/i.test(i.locationId) ? i.locationId : null;
    const withStock = i.withStock === true;
    const after = typeof i.cursor === 'string' && i.cursor !== '' ? decodeCursor(i.cursor) : null;

    const places = await drizzleDb
      .select({ id: stockLocations.id, code: stockLocations.code, name: stockLocations.name, isDefault: stockLocations.isDefault })
      .from(stockLocations)
      .where(and(eq(stockLocations.companyId, ctx.companyId), eq(stockLocations.isActive, true), ne(stockLocations.kind, 'transit'), only === null ? undefined : eq(stockLocations.id, only)))
      .orderBy(sql`${stockLocations.isDefault} DESC`, asc(stockLocations.code))
      .limit(MAX_COLUMNS + 1);
    const columns = places.slice(0, MAX_COLUMNS);
    const ids = columns.map((c) => c.id);
    const inColumns = ids.length === 0 ? sql`FALSE` : sql`b.location_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;

    const conditions: (SQL | undefined)[] = [
      isNull(products.deletedAt),
      matching(query, [products.name, products.sku, products.stockCode]),
      withStock ? sql`EXISTS (SELECT 1 FROM stock_balances b WHERE b.product_id = ${products.id} AND ${inColumns} AND b.on_hand <> 0)` : undefined,
      after === null ? undefined : sql`(${products.name}, ${products.id}) > (${after.k}, ${after.id})`,
    ];
    const rows = await drizzleDb
      .select({ id: products.id, name: products.name, sku: products.sku })
      .from(products)
      .where(and(...conditions))
      .orderBy(asc(products.name), asc(products.id))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const pageIds = page.map((p) => p.id);

    const cells = new Map<string, Record<string, { onHand: number; reserved: number }>>();
    const totals = new Map<string, { onHand: number; reserved: number }>();
    if (pageIds.length > 0) {
      const productList = sql.join(pageIds.map((id) => sql`${id}`), sql`, `);
      const shown = [...(await drizzleDb.execute<{ product_id: string; location_id: string; on_hand: string; reserved: string }>(sql`
        SELECT b.product_id, b.location_id, sum(b.on_hand) AS on_hand, sum(b.reserved) AS reserved
        FROM stock_balances b WHERE b.product_id IN (${productList}) AND ${inColumns}
        GROUP BY b.product_id, b.location_id HAVING sum(b.on_hand) <> 0 OR sum(b.reserved) <> 0`))];
      for (const r of shown) {
        const row = cells.get(r.product_id) ?? {};
        row[r.location_id] = { onHand: Number(r.on_hand), reserved: Number(r.reserved) };
        cells.set(r.product_id, row);
      }
      const sums = [...(await drizzleDb.execute<{ product_id: string; on_hand: string; reserved: string }>(sql`
        SELECT b.product_id, sum(b.on_hand) AS on_hand, sum(b.reserved) AS reserved FROM stock_balances b WHERE b.product_id IN (${productList}) GROUP BY b.product_id`))];
      for (const r of sums) totals.set(r.product_id, { onHand: Number(r.on_hand), reserved: Number(r.reserved) });
    }

    const mode = await getContainer().stockSettings.get();
    return {
      columns,
      moreLocations: places.length > MAX_COLUMNS,
      rows: page.map((p) => ({ productId: p.id, name: p.name, sku: p.sku, total: totals.get(p.id)?.onHand ?? 0, totalReserved: totals.get(p.id)?.reserved ?? 0, cells: cells.get(p.id) ?? {} })),
      nextCursor: rows.length > PAGE_SIZE && last !== undefined ? encodeCursor({ k: last.name, id: last.id }) : null,
      source: sourceOf(mode),
    };
  });
}
