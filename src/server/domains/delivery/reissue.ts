import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliveryLines, orderItems, orders, products, stockReservations } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { StockReservations } from '@/server/domains/stock/reservations';
import { StockError } from '@/server/domains/stock/errors';
import type { IssueMoment } from '@/lib/stock-issue';
import { roundQty } from '@/lib/decimal';
import type { DeliveryStatus } from '@/lib/delivery-document';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const BATCH = 50;
const PREVIEW_LIMIT = 1000;

/** The states of a delivery whose goods have left, by when the shop issues stock. */
const SHIPPED: Record<Exclude<IssueMoment, 'payment'>, readonly DeliveryStatus[]> = {
  dispatch: ['out_for_delivery', 'failed_attempt', 'delivered'],
  delivery: ['delivered'],
};

export interface ReissuePreview {
  moment: IssueMoment;
  /** Orders paid before the change, with stock taken off the shelf for goods that have not left yet. */
  orders: number;
  /** Units of those goods. */
  quantity: number;
  /** True when there are more than the preview looks at. */
  atLeast: boolean;
}

export interface ReissueResult {
  orders: number;
  quantity: number;
  /** Orders still to do after this batch (not counting those skipped). */
  remaining: number;
  /** Orders that could not be done, with why, so the rest are not held up by them. Pass their ids as `skip` on the next call. */
  skipped: { orderId: string; orderNumber: string; message: string }[];
}

/**
 * Applies the shop's "when stock leaves" choice to orders that were paid before it was made. Those orders had their stock taken off
 * the shelf when they were paid; for the goods that have not left yet, the stock is counted back and held for the order again, so
 * that the deliveries issue it from now on, the same as for an order paid today. Goods that have gone (by the chosen moment) stay issued.
 * An order that has any delivery issued under the new rule, or any return receipt, is left alone, since its books already tell a mixed
 * story. Once for each order and product: a second run finds nothing to do. Done in batches, each order in its own transaction.
 */
export class StockReissue {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly stock: Pick<StockReservations, 'receiveGoodsBackIn'>,
  ) {}

  /** The orders in question: delivered by a document, still open, paid for, all of their stock issued, and nothing issued by a delivery or received back yet. */
  private async candidates(db: Tx | DrizzleDb, companyId: string, limit: number): Promise<string[]> {
    const rows = await db.execute<{ id: string }>(sql`
      SELECT o.id FROM orders o
      JOIN order_deliveries od ON od.order_id = o.id
      WHERE od.company_id = ${companyId}::uuid AND od.method IN ('own_fleet','courier')
        AND o.status IN ('pending','processing','shipped')
        AND (o.payment_status = 'paid' OR o.payment_method = 'on_account')
        AND COALESCE(o.approval_status, 'approved') NOT IN ('pending','rejected','draft')
        AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.ref_type = 'order' AND r.ref_id = o.id AND r.state = 'consumed' AND r.consumed > 0)
        AND NOT EXISTS (SELECT 1 FROM stock_reservations r WHERE r.ref_type = 'order' AND r.ref_id = o.id AND r.state IN ('held','partly_consumed'))
        AND NOT EXISTS (SELECT 1 FROM delivery_returns dr JOIN deliveries d ON d.id = dr.delivery_id WHERE d.order_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_lines dl JOIN deliveries d ON d.id = dl.delivery_id WHERE d.order_id = o.id AND dl.issued > 0)
      ORDER BY o.created_at, o.id
      LIMIT ${limit}`);
    return [...rows].map((r) => r.id);
  }

  /** What has not left, per product, for these orders: ordered, less what the deliveries that count as gone carried. One read for all of them. */
  private async unshipped(db: Tx | DrizzleDb, moment: Exclude<IssueMoment, 'payment'>, orderIds: string[]): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>(orderIds.map((id) => [id, new Map()]));
    if (orderIds.length === 0) return out;
    const [items, gone] = await Promise.all([
      db.select({ orderId: orderItems.orderId, productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems).where(inArray(orderItems.orderId, orderIds)),
      db
        .select({ orderId: deliveries.orderId, productId: deliveryLines.productId, quantity: deliveryLines.quantity, picked: deliveryLines.picked })
        .from(deliveries)
        .innerJoin(deliveryLines, eq(deliveryLines.deliveryId, deliveries.id))
        .where(and(inArray(deliveries.orderId, orderIds), inArray(deliveries.status, [...SHIPPED[moment]]))),
    ]);
    for (const i of items) {
      const per = out.get(i.orderId);
      if (per !== undefined) per.set(i.productId, roundQty((per.get(i.productId) ?? 0) + i.quantity));
    }
    for (const g of gone) {
      const per = out.get(g.orderId);
      if (per !== undefined) per.set(g.productId, roundQty((per.get(g.productId) ?? 0) - Number(g.picked ?? g.quantity)));
    }
    return out;
  }

  async preview(companyId: string, moment: IssueMoment): Promise<ReissuePreview> {
    if (moment === 'payment') return { moment, orders: 0, quantity: 0, atLeast: false };
    const ids = await this.candidates(this.db, companyId, PREVIEW_LIMIT + 1);
    const seen = ids.slice(0, PREVIEW_LIMIT);
    const per = await this.unshipped(this.db, moment, seen);
    let count = 0;
    let quantity = 0;
    for (const m of per.values()) {
      const open = [...m.values()].filter((q) => q > 0);
      if (open.length > 0) count += 1;
      quantity = roundQty(quantity + open.reduce((n, q) => n + q, 0));
    }
    return { moment, orders: count, quantity, atLeast: ids.length > PREVIEW_LIMIT };
  }

  /** Does one batch. Call again while `remaining` is above zero. */
  async apply(actor: { companyId: string; userId: string }, moment: IssueMoment, skip: readonly string[] = []): Promise<ReissueResult> {
    if (moment === 'payment') return { orders: 0, quantity: 0, remaining: 0, skipped: [] };
    // The orders that have something to move, in order; this call does a batch of them and says how many are left.
    const found = await this.candidates(this.db, actor.companyId, PREVIEW_LIMIT);
    const owed = await this.unshipped(this.db, moment, found);
    const left = new Set(skip);
    const movable = found.filter((id) => !left.has(id) && [...(owed.get(id)?.values() ?? [])].some((q) => q > 0));
    const ids = movable.slice(0, BATCH);
    let done = 0;
    let quantity = 0;
    const skipped: ReissueResult['skipped'] = [];
    for (const orderId of ids) {
      const moved = await this.db.transaction(async (tx) => {
        // The order and its holds are looked at again under lock: a delivery may have issued some of it since.
        const [o] = await tx.select({ id: orders.id, number: orders.orderNumber }).from(orders).where(eq(orders.id, orderId)).for('update');
        if (o === undefined) return 0;
        const holds = await tx.select({ state: stockReservations.state }).from(stockReservations).where(and(eq(stockReservations.refType, 'order'), eq(stockReservations.refId, orderId))).orderBy(asc(stockReservations.productId)).for('update');
        if (holds.some((h) => h.state === 'held' || h.state === 'partly_consumed') || !(await this.candidates(tx, actor.companyId, PREVIEW_LIMIT)).includes(orderId)) return 0;
        const open = [...((await this.unshipped(tx, moment, [orderId])).get(orderId) ?? new Map<string, number>())].filter(([, q]) => q > 0);
        const inventory = open.length === 0 ? [] : await tx.select({ id: products.id }).from(products).where(and(inArray(products.id, open.map(([p]) => p)), eq(products.inventoryKind, 'inventory')));
        const keep = new Set(inventory.map((p) => p.id));
        let total = 0;
        for (const [productId, q] of open) {
          if (!keep.has(productId)) continue;
          await this.stock.receiveGoodsBackIn(tx, { companyId: actor.companyId, orderId, productId, quantity: q, key: `reissue:${orderId}`, disposition: 'return_to_stock', issuedHere: true, actor: actor.userId, note: `Order ${o.number}: stock held for its deliveries, as the shop now issues it when ${moment === 'dispatch' ? 'a delivery goes out' : 'a delivery arrives'}` });
          total = roundQty(total + q);
        }
        if (total > 0) await this.decisions.record({ companyId: actor.companyId, subject: { type: 'order', id: orderId }, action: 'stock.reissued_for_deliveries', actor: { type: 'user', id: actor.userId }, to: moment, reason: { text: `${String(total)} counted back and held for the order's deliveries.` } }, tx);
        return total;
      }).catch(async (error: unknown) => {
        // One order that cannot be done (its stock place was stopped, say) does not hold up the others.
        if (!(error instanceof StockError)) throw error;
        const [o] = await this.db.select({ number: orders.orderNumber }).from(orders).where(eq(orders.id, orderId));
        skipped.push({ orderId, orderNumber: o?.number ?? orderId, message: error.message });
        return 0;
      });
      if (moved > 0) {
        done += 1;
        quantity = roundQty(quantity + moved);
      }
    }
    return { orders: done, quantity, remaining: movable.length - ids.length, skipped };
  }
}
