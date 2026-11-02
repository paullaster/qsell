import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { roundQty } from '@/lib/decimal';
import type { SalesChannel } from '@/lib/stock';

export interface Availability {
  onHand: number;
  reserved: number;
  /** What can still be promised: on hand minus reserved, over the places this channel may sell from. */
  available: number;
}

const NONE: Availability = { onHand: 0, reserved: 0, available: 0 };

/**
 * The one definition of "available": the sum over the active, sellable locations that sell to this channel of on hand minus
 * reserved. Many products in one query. Design: docs/architecture/stock-locations.md §6.1.
 */
export class StockAvailability {
  constructor(private readonly db: DrizzleDb) {}

  async forProducts(productIds: readonly string[], channel: SalesChannel): Promise<Map<string, Availability>> {
    const out = new Map<string, Availability>();
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return out;
    const rows = await this.db.execute<{ product_id: string; on_hand: string; reserved: string }>(sql`
      SELECT b.product_id, sum(b.on_hand) AS on_hand, sum(b.reserved) AS reserved
      FROM stock_balances b
      JOIN stock_locations l ON l.id = b.location_id
      WHERE b.product_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND EXISTS (SELECT 1 FROM products p WHERE p.id = b.product_id AND p.inventory_kind = 'inventory')
        AND l.is_active AND l.is_sellable AND ${channel} = ANY (l.sells_channels)
      GROUP BY b.product_id`);
    for (const r of rows) {
      const onHand = Number(r.on_hand);
      const reserved = Number(r.reserved);
      out.set(r.product_id, { onHand, reserved, available: roundQty(onHand - reserved) });
    }
    for (const id of ids) if (!out.has(id)) out.set(id, NONE);
    return out;
  }

  async forProduct(productId: string, channel: SalesChannel): Promise<Availability> {
    return (await this.forProducts([productId], channel)).get(productId) ?? NONE;
  }

  /**
   * What each of these branches can deliver of these products: the free stock in all of its own locations that sell to the channel and may dispatch deliveries (a branch can have several), plus the locations that
   * belong to no branch (a central store serves every branch). Another branch's locations are not counted; moving stock between
   * branches is a transfer, not a sale. One query however many branches and products.
   */
  async byBranch(companyId: string, branchIds: readonly string[], productIds: readonly string[], channel: SalesChannel): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>(branchIds.map((id) => [id, new Map<string, number>()]));
    const ids = [...new Set(productIds)];
    if (ids.length === 0 || branchIds.length === 0) return out;
    const rows = await this.db.execute<{ branch_id: string | null; product_id: string; free: string }>(sql`
      SELECT l.branch_id, b.product_id, sum(greatest(b.on_hand - b.reserved, 0)) AS free
      FROM stock_balances b
      JOIN stock_locations l ON l.id = b.location_id
      JOIN products p ON p.id = b.product_id AND p.inventory_kind = 'inventory'
      WHERE l.company_id = ${companyId}
        AND b.product_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND l.is_active AND l.is_sellable AND l.fulfils_delivery AND ${channel} = ANY (l.sells_channels)
        AND (l.branch_id IS NULL OR l.branch_id IN (${sql.join(branchIds.map((id) => sql`${id}::uuid`), sql`, `)}))
      GROUP BY l.branch_id, b.product_id`);
    const shared = new Map<string, number>();
    for (const r of rows) if (r.branch_id === null) shared.set(r.product_id, roundQty(Number(r.free)));
    for (const [branchId, grid] of out) {
      for (const id of ids) grid.set(id, shared.get(id) ?? 0);
      for (const r of rows) if (r.branch_id === branchId) grid.set(r.product_id, roundQty((grid.get(r.product_id) ?? 0) + Number(r.free)));
    }
    return out;
  }
}
