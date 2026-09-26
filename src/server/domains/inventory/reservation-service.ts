import { and, eq, inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { inventoryMovements, orders, orderItems, products } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';

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
  ): Promise<{ success: boolean; error?: string }> {
    if (items.length === 0) return { success: true };

    const outcome = await drizzleDb.transaction(async (tx) => {
      // 1. Validate availability with every candidate row locked, in a stable
      //    order, so concurrent checkouts queue instead of interleaving.
      const ids = [...new Set(items.map((i) => i.productId))].sort();
      const locked = await tx
        .select()
        .from(products)
        .where(inArray(products.id, ids))
        .orderBy(products.id)
        .for('update');

      const byId = new Map(locked.map((row) => [row.id, row]));

      for (const item of items) {
        const product = byId.get(item.productId);
        if (!product) {
          return { success: false as const, error: `Product ID ${item.productId} was not found in catalog.` };
        }
        const available = product.stockQuantity - product.reservedQuantity;
        if (available < item.quantity) {
          return {
            success: false as const,
            error: `Insufficient inventory for "${product.name}". Available: ${available}, Requested: ${item.quantity}.`,
          };
        }
      }

      // 2. Apply the holds.
      for (const item of items) {
        const product = byId.get(item.productId)!;
        await tx
          .update(products)
          .set({
            reservedQuantity: product.reservedQuantity + item.quantity,
            updatedAt: new Date(),
          })
          .where(eq(products.id, item.productId));

        await tx.insert(inventoryMovements).values({
          id: newId('ledger'),
          productId: product.id,
          productName: product.name,
          changeAmount: -item.quantity,
          previousStock: product.stockQuantity,
          newStock: product.stockQuantity - (product.reservedQuantity + item.quantity),
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
  ): Promise<void> {
    const items = await this.orderLines(orderId);
    if (items.length === 0) return;

    // Cheap pre-check to skip the common already-settled case. The unique index
    // below is what actually makes this safe: two concurrent webhooks can both
    // pass this probe, but only one can write the settlement movement.
    const settled = await getContainer().catalog.hasSettlementMovement(orderId, [
      'order_fulfillment',
      'order_cancellation_release',
    ]);
    if (settled) return;

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
      if (isSettlementConflict(err)) return;
      throw err;
    }
  }

  /**
   * Convert a reservation into a real deduction once payment succeeds.
   * No-op if the order was already fulfilled or released.
   */
  static async fulfilOrder(orderId: string): Promise<void> {
    await this.settleLines(orderId, 'payment_reconciliation_engine', async (product, quantity) => {
      const nextStock = Math.max(0, product.stockQuantity - quantity);
      return {
        stockQuantity: nextStock,
        reservedQuantity: Math.max(0, product.reservedQuantity - quantity),
        changeType: 'order_fulfillment' as const,
        changeAmount: -quantity,
        note: `Fulfilled and finalized stock deduction of ${quantity} units for order ${orderId}`,
      };
    });

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
  ): Promise<void> {
    await this.settleLines(orderId, actor, async (product, quantity) => ({
      // A release returns held units to available stock; on-hand is unchanged.
      stockQuantity: product.stockQuantity,
      reservedQuantity: Math.max(0, product.reservedQuantity - quantity),
      changeType: 'order_cancellation_release' as const,
      changeAmount: quantity,
      note: `Released reservation of ${quantity} units for order ${orderId}. ${reason}`.trim(),
    }));

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
          inArray(orders.paymentMethod, ['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni', 'card_direct']),
        ),
      );

    for (const order of failed) {
      await this.releaseOrder(order.id, 'payment failed');
    }
  }

  /** Order lines as { productId, quantity } straight from Postgres. */
  private static async orderLines(
    orderId: string,
  ): Promise<{ productId: string; quantity: number }[]> {
    return drizzleDb
      .select({ productId: orderItems.productId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
  }
}
