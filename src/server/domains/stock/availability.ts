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
}
