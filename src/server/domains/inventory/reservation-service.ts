import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { inventoryMovements, orderDeliveries, orders, orderItems, products, stockLocations, stockReservations } from '@/server/db/drizzle/schema';
import { heldAtPayment } from '@/lib/stock-issue';
import { isDeliveryMethod } from '@/lib/delivery-methods';
import { roundQty } from '@/lib/decimal';
import { getContainer } from '@/server/di/container';
import { OrderStages } from '@/server/domains/orders/stages';
import { broadcastRealtime } from '@/server/realtime';
import { isSalesChannel, type SalesChannel } from '@/lib/stock';

/** Payment methods where the shopper pays at once: an unpaid order of these holds stock only for the hold time. */
export const ONLINE_PAYMENT_METHODS = ['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni', 'card_direct'] as const;

/** The code a release is filed under on the timeline, from the words callers give. */
export function releaseReasonCode(reason: string): string {
  const text = reason.toLowerCase();
  if (text.includes('expire') || text.includes('ran out')) return 'hold_expired';
  if (text.includes('cancel')) return 'cancelled';
  if (text.includes('fail')) return 'payment_failed';
  return 'released';
}

export interface ReserveOptions {
  channel?: SalesChannel;
  branchId?: string | null;
  /** The shopper pays now, so the hold lapses if they do not (when the company sets a hold time). */
  payNow?: boolean;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Postgres raises unique_violation (23505) when a settlement movement for the
 * same order/product/change-type already exists. That is the signal that a
 * concurrent or retried webhook beat us to it, so the correct response is to
 * treat the operation as already applied rather than surface an error.
 */
function isSettlementConflict(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const constraint = (err as { constraint_name?: string } | null)?.constraint_name;
  return code === '23505' && constraint === 'inventory_movements_settlement_uidx';
}

type Tx = Parameters<Parameters<typeof drizzleDb.transaction>[0]>[0];

/**
 * Order-driven stock lifecycle: reserve at checkout, fulfil on payment, release
 * on failure or cancellation.
 *
 * Every mutation is idempotent and guarded by the `inventory_movements` journal
 * rather than an in-process `Set`, so a webhook that is retried — or two
 * instances racing — cannot double-deduct stock. This is the durable
 * replacement for the old `inventorySettled` Map field on `PostgresStore`.
 */
export class InventoryReservationService {
  /**
   * Hold stock for a pending order. Validates every line before mutating any of
   * them, so a short line on item 3 leaves items 1-2 untouched.
   */
  static async reserveForOrder(
    items: { productId: string; quantity: number }[],
    orderId: string,
    actor = 'customer_checkout',
    options: ReserveOptions = {},
  ): Promise<{ success: boolean; error?: string }> {
    if (items.length === 0) return { success: true };
    const kinds = await drizzleDb
      .select({ id: products.id, name: products.name, inventoryKind: products.inventoryKind })
      .from(products)
      .where(inArray(products.id, [...new Set(items.map((item) => item.productId))]));
    const kindById = new Map(kinds.map((product) => [product.id, product]));
    const nonInventory = items.find((item) => kindById.get(item.productId)?.inventoryKind !== 'inventory');
    if (nonInventory !== undefined) {
      const product = kindById.get(nonInventory.productId);
      return {
        success: false,
        error: `${product?.name ?? 'This product'} is not inventory-managed and cannot be reserved.`,
      };
    }

    // With the per-location ledger as the truth, the hold is placed there (choosing the location); the counters follow it.
    const container = getContainer();
    const mode = await container.stockSettings.get();
    if (mode.ledgerMode) {
      const company = await container.companySettings.ensureSeeded();
      const expiresAt = options.payNow === true && mode.unpaidHoldMinutes > 0 ? new Date(Date.now() + mode.unpaidHoldMinutes * 60_000) : null;
      const result = await container.stockReservations.reserve({
        companyId: company.id,
        refType: 'order',
        refId: orderId,
        lines: items,
        channel: options.channel ?? 'ecommerce',
        branchId: options.branchId ?? null,
        expiresAt,
        actor,
      });
      if (result.ok) void broadcastRealtime('inventory_update', { type: 'reservation', orderId });
      return result.ok ? { success: true } : { success: false, error: result.error };
    }

    const outcome = await drizzleDb.transaction(async (tx) => {
      const existingReservations = await tx
        .select({
          productId: inventoryMovements.productId,
          quantity: inventoryMovements.changeAmount,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.referenceId, orderId),
            eq(inventoryMovements.changeType, 'order_reservation'),
          ),
        );
      const reservedByProduct = new Map(
        existingReservations.map((row) => [row.productId, Math.abs(row.quantity)]),
      );
      const remainingItems = items
        .map((item) => ({
          ...item,
          quantity: Math.max(0, roundQty(item.quantity - (reservedByProduct.get(item.productId) ?? 0))),
        }))
        .filter((item) => item.quantity > 0);
      if (remainingItems.length === 0) return { success: true as const };

      // 1. Validate availability with every candidate row locked, in a stable
      //    order, so concurrent checkouts queue instead of interleaving.
      const ids = [...new Set(remainingItems.map((i) => i.productId))].sort();
      const locked = await tx
        .select()
        .from(products)
        // A deleted product can no longer be sold, but settling/releasing an
        // existing order below still resolves it.
        .where(and(inArray(products.id, ids), isNull(products.deletedAt)))
        .orderBy(products.id)
        .for('update');

      const byId = new Map(locked.map((row) => [row.id, row]));

      for (const item of remainingItems) {
        const product = byId.get(item.productId);
        if (!product) {
          return {
            success: false as const,
            error: `Product ID ${item.productId} was not found in catalog.`,
          };
        }
        const available = roundQty(product.stockQuantity - product.reservedQuantity);
        if (available < item.quantity) {
          return {
            success: false as const,
            error: `Insufficient inventory for "${product.name}". Available: ${available}, Requested: ${item.quantity}.`,
          };
        }
      }

      // 2. Apply the holds.
      for (const item of remainingItems) {
        const product = byId.get(item.productId)!;
        await tx
          .update(products)
          .set({
            reservedQuantity: roundQty(product.reservedQuantity + item.quantity),
            updatedAt: new Date(),
          })
          .where(eq(products.id, item.productId));

        await tx.insert(inventoryMovements).values({
          id: newId('ledger'),
          productId: product.id,
          productName: product.name,
          changeAmount: -item.quantity,
          previousStock: product.stockQuantity,
          newStock: roundQty(product.stockQuantity - (product.reservedQuantity + item.quantity)),
          changeType: 'order_reservation',
          referenceId: orderId,
          actor,
          note: `Reserved ${item.quantity} units for pending order ${orderId}`,
        });
      }

      return { success: true as const };
    });

    if (outcome.success) {
      void broadcastRealtime('inventory_update', { type: 'reservation', orderId });
    }
    return outcome;
  }

  /**
   * Apply a settlement for every order line in one transaction.
   *
   * `settle` receives the locked product row plus the tx, and returns the new
   * stock/reserved pair plus the movement to journal. The caller supplies the
   * business meaning; this owns locking, journalling and idempotency.
   */
  private static async settleLines(
    orderId: string,
    actor: string,
    settle: (
      product: typeof products.$inferSelect,
      quantity: number,
    ) => Promise<{
      stockQuantity: number;
      reservedQuantity: number;
      changeType: 'order_fulfillment' | 'order_cancellation_release';
      changeAmount: number;
      note: string;
    }>,
    /** For an order that was never saved: the lines that were reserved for it. */
    knownItems?: { productId: string; quantity: number }[],
  ): Promise<boolean> {
    const items = knownItems ?? (await this.orderLines(orderId));
    if (items.length === 0) return false;

    // Cheap pre-check to skip the common already-settled case. The unique index
    // below is what actually makes this safe: two concurrent webhooks can both
    // pass this probe, but only one can write the settlement movement.
    const settled = await getContainer().catalog.hasSettlementMovement(orderId, [
      'order_fulfillment',
      'order_cancellation_release',
    ]);
    if (settled) return false;

    try {
      await drizzleDb.transaction(async (tx) => {
        for (const item of items) {
          const [product] = await tx
            .select()
            .from(products)
            .where(eq(products.id, item.productId))
            .for('update')
            .limit(1);
          if (!product) continue;
          if (product.inventoryKind !== 'inventory') continue;

          const next = await settle(product, item.quantity);

          await tx
            .update(products)
            .set({
              stockQuantity: next.stockQuantity,
              reservedQuantity: next.reservedQuantity,
              updatedAt: new Date(),
            })
            .where(eq(products.id, item.productId));

          await tx.insert(inventoryMovements).values({
            id: newId('ledger'),
            productId: product.id,
            productName: product.name,
            changeAmount: next.changeAmount,
            previousStock: product.stockQuantity,
            newStock: next.stockQuantity,
            changeType: next.changeType,
            referenceId: orderId,
            actor,
            note: next.note,
          });
        }
      });
    } catch (err) {
      // A concurrent/retried webhook already journalled this settlement.
      if (isSettlementConflict(err)) return false;
      throw err;
    }
    return true;
  }

  /**
   * Once the order is saved: its stock was set aside, and where. In the new ledger that is the places and quantities of its holds; the
   * old way keeps only a count, and says so. The hold was placed before the order existed, so the order's own timeline is told now.
   * Never stops the order: a failure to write it is logged.
   */
  static async recordReserved(orderId: string, lines: { productId: string; quantity: number }[]): Promise<void> {
    try {
      const ledger = await getContainer().stockSettings.isLedgerMode();
      const places = ledger
        ? await drizzleDb
            .select({ code: stockLocations.code, quantity: sql<number>`sum(${stockReservations.quantity})::float8` })
            .from(stockReservations)
            .innerJoin(stockLocations, eq(stockLocations.id, stockReservations.locationId))
            .where(and(eq(stockReservations.refType, 'order'), eq(stockReservations.refId, orderId)))
            .groupBy(stockLocations.code)
            .orderBy(stockLocations.code)
        : [];
      await OrderStages.move(drizzleDb, orderId, 'stock_reserved', 'succeeded', {
        ref: { type: 'stock_hold', id: orderId },
        detail: { kept: ledger ? 'ledger' : 'counters', products: lines.length, ...(places.length > 0 ? { places } : {}) },
      });
    } catch (error) {
      console.error('[inventory] could not record the stock stage', orderId, 'stock_reserved', error);
    }
  }

  /**
   * What happened to an order's stock, on the order's own timeline with its time and reason. It is a record beside the settlement and
   * never stops it: a failure to write it is logged. An order that was never saved has no timeline. Said once per order and kind, so a
   * retried payment message adds nothing.
   */
  private static async recordStockStage(orderId: string, stage: 'stock_issued' | 'stock_released', options: { reasonCode?: string; message?: string; detail?: Record<string, unknown> } = {}): Promise<void> {
    try {
      await OrderStages.move(drizzleDb, orderId, stage, 'succeeded', { ref: { type: 'stock_settlement', id: orderId }, ...options });
    } catch (error) {
      console.error('[inventory] could not record the stock stage', orderId, stage, error);
    }
  }

  /**
   * Convert a reservation into a real deduction once payment succeeds.
   * No-op if the order was already fulfilled or released.
   */
  static async fulfilOrder(orderId: string): Promise<void> {
    const container = getContainer();
    if (await container.stockSettings.isLedgerMode()) {
      const company = await container.companySettings.ensureSeeded();
      // A shop that issues stock as deliveries go out or arrive leaves a delivered order's stock held; the deliveries issue it.
      const { issueMoment } = await container.stockSettings.get();
      if (issueMoment !== 'payment') {
        const [delivery] = await drizzleDb.select({ method: orderDeliveries.method }).from(orderDeliveries).where(eq(orderDeliveries.orderId, orderId)).limit(1);
        if (heldAtPayment(issueMoment, isDeliveryMethod(delivery?.method) ? delivery.method : null)) {
          await container.stockReservations.keepHeld({ companyId: company.id, refType: 'order', refId: orderId, actor: 'payment_reconciliation_engine' });
          return;
        }
      }
      const done = await container.stockReservations.consume({ companyId: company.id, refType: 'order', refId: orderId, actor: 'payment_reconciliation_engine' });
      if (done.holds > 0) await this.recordStockStage(orderId, 'stock_issued', { detail: { kept: 'ledger', issued: done.issued, holds: done.holds } });
      void broadcastRealtime('inventory_update', { type: 'fulfillment', orderId });
      return;
    }
    const applied = await this.settleLines(orderId, 'payment_reconciliation_engine', async (product, quantity) => {
      const nextStock = Math.max(0, roundQty(product.stockQuantity - quantity));
      return {
        stockQuantity: nextStock,
        reservedQuantity: Math.max(0, roundQty(product.reservedQuantity - quantity)),
        changeType: 'order_fulfillment' as const,
        changeAmount: -quantity,
        note: `Fulfilled and finalized stock deduction of ${quantity} units for order ${orderId}`,
      };
    });
    if (applied) await this.recordStockStage(orderId, 'stock_issued', { detail: { kept: 'counters' } });

    void broadcastRealtime('inventory_update', { type: 'fulfillment', orderId });
  }

  /**
   * Put a reservation back on the shelf — payment failed, expired, or the order
   * was cancelled. No-op if the order was already fulfilled or released.
   */
  static async releaseOrder(
    orderId: string,
    reason: string,
    actor = 'system_timeout_releaser',
    /** Pass the reserved lines when the order itself was never saved (creation failed). */
    knownItems?: { productId: string; quantity: number }[],
  ): Promise<void> {
    const container = getContainer();
    if (await container.stockSettings.isLedgerMode()) {
      const company = await container.companySettings.ensureSeeded();
      const done = await container.stockReservations.release({ companyId: company.id, refType: 'order', refId: orderId, actor, reason });
      if (done.holds > 0 && knownItems === undefined) await this.recordStockStage(orderId, 'stock_released', { reasonCode: releaseReasonCode(reason), message: reason, detail: { kept: 'ledger', released: done.released, holds: done.holds } });
    } else {
      const applied = await this.settleLines(
        orderId,
        actor,
        async (product, quantity) => ({
          // A release returns held units to available stock; on-hand is unchanged.
          stockQuantity: product.stockQuantity,
          reservedQuantity: Math.max(0, roundQty(product.reservedQuantity - quantity)),
          changeType: 'order_cancellation_release' as const,
          changeAmount: quantity,
          note: `Released reservation of ${quantity} units for order ${orderId}. ${reason}`.trim(),
        }),
        knownItems,
      );
      // An order that was never saved has no timeline; one whose stock was already settled has nothing new to say.
      if (applied && knownItems === undefined) await this.recordStockStage(orderId, 'stock_released', { reasonCode: releaseReasonCode(reason), message: reason, detail: { kept: 'counters' } });
    }

    // A discount the order had used goes back to its budget and limits. Never fails the release.
    try {
      const { getContainer } = await import('@/server/di/container');
      await drizzleDb.transaction((tx) =>
        getContainer().discounts.reverse(tx, { type: 'order', id: orderId }),
      );
    } catch (error) {
      console.error("[inventory] could not give back the order's discount use", orderId, error);
    }

    // Gift cards and points the order spent go back, points it earned are taken back, and its
    // purchases stop counting towards rebates. Never fails the release.
    try {
      const { getContainer } = await import('@/server/di/container');
      await drizzleDb.transaction((tx) => getContainer().tenders.reverseOrder(tx, orderId));
    } catch (error) {
      console.error('[inventory] could not reverse the order\'s tenders, points or rebates', orderId, error);
    }

    void broadcastRealtime('inventory_update', { type: 'release', orderId });
  }

  /**
   * Sweep orders whose payment definitively failed and hand their held units
   * back. Called before catalog reads; `pending_verification` is deliberately
   * left alone so an in-flight STK prompt keeps its hold.
   */
  static async releaseFailedPaymentReservations(): Promise<void> {
    const failed = await drizzleDb
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.paymentStatus, 'failed'),
          inArray(orders.paymentMethod, [
            'mpesa_daraja',
            'pesapal_v3',
            'jenga_hq',
            'kcb_buni',
            'card_direct',
          ]),
        ),
      );

    for (const order of failed) {
      await this.releaseOrder(order.id, 'payment failed');
    }
  }

  /**
   * Makes sure an order that is about to be paid (again) still has its stock held. A payment the provider reported as failed gives its
   * hold back, so paying again without holding first would take the money and leave the stock free to sell twice. With the per-location
   * ledger the hold is placed again (refused, in words, if the stock has gone). Without it, a hold that was given back cannot be taken
   * again (the journal settles an order once), so the order cannot be paid and the shopper places it again.
   */
  static async reholdOrder(orderId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const items = await this.orderLines(orderId);
    if (items.length === 0) return { ok: true };
    const container = getContainer();
    if (!(await container.stockSettings.isLedgerMode())) {
      const issued = await container.catalog.hasSettlementMovement(orderId, ['order_fulfillment']);
      const given = await container.catalog.hasSettlementMovement(orderId, ['order_cancellation_release']);
      return given && !issued
        ? { ok: false, error: 'The items held for this order were given back after the payment failed, so it cannot be paid now. Please place the order again.' }
        : { ok: true };
    }
    const held = await drizzleDb
      .select({ id: stockReservations.id })
      .from(stockReservations)
      .where(and(eq(stockReservations.refType, 'order'), eq(stockReservations.refId, orderId), inArray(stockReservations.state, ['held', 'partly_consumed', 'consumed'])))
      .limit(1);
    if (held.length > 0) return { ok: true };
    const company = await container.companySettings.ensureSeeded();
    const [order] = await drizzleDb.select({ branchId: orders.branchId, salesModule: orders.salesModule }).from(orders).where(eq(orders.id, orderId)).limit(1);
    const result = await container.stockReservations.reserve({
      companyId: company.id,
      refType: 'order',
      refId: orderId,
      lines: items,
      channel: order !== undefined && isSalesChannel(order.salesModule) ? order.salesModule : 'ecommerce',
      branchId: order?.branchId ?? null,
      expiresAt: null,
      actor: 'payment_retry',
    });
    if (!result.ok) return { ok: false, error: 'Some of the items in this order are no longer available, so it cannot be paid now. Please place the order again.' };
    await this.recordReserved(orderId, items);
    return { ok: true };
  }

  /** Order lines as { productId, quantity } straight from Postgres. */
  private static async orderLines(
    orderId: string,
  ): Promise<{ productId: string; quantity: number }[]> {
    return drizzleDb
      .select({ productId: orderItems.productId, quantity: orderItems.quantity })
      .from(orderItems)
      .innerJoin(products, eq(orderItems.productId, products.id))
      .where(and(eq(orderItems.orderId, orderId), eq(products.inventoryKind, 'inventory')));
  }
}
