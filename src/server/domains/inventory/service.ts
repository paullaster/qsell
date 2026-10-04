import { eq } from 'drizzle-orm';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { inventoryMovements, products } from '@/server/db/drizzle/schema';
import { broadcastRealtime } from '@/server/realtime';
import type { Product, InventoryLedgerEntry, Order, OrderStatus } from '@/types/index';
import { InventoryReservationService } from './reservation-service';
import { toLedgerEntry, toProduct } from '@/server/domains/catalog/mappers';
import type { ProductJoined } from '@/server/domains/catalog/repository';

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const WRITE_OFF_LABELS: Record<string, string> = {
  damage_transit: 'Damaged in Courier Transit',
  defective_return: 'Defective Customer Return',
  warehouse_damage: 'Damaged in Warehouse Storage',
  shrinkage_loss: 'Inventory Shrinkage / Missing Item',
  sample_marketing: 'Promotional / Demo Unit',
};

export type WriteOffReason = keyof typeof WRITE_OFF_LABELS;

/** Transaction handle — the only Drizzle surface these helpers need. */
export type Tx = Parameters<Parameters<typeof drizzleDb.transaction>[0]>[0];

interface StockDelta {
  productId: string;
  /** Signed change to `stock_quantity`. Ignored when `setTo` is given. */
  delta: number;
  /** Signed change to `reserved_quantity`. */
  reservedDelta?: number;
  /** Order settlement may still touch a product deleted after the order was placed. */
  allowDeleted?: boolean;
  /** Clamp stock at zero rather than allowing a negative. */
  clampAtZero?: boolean;
  /** Set stock to an exact value (physical count / absolute correction). */
  setTo?: number;
  costPrice?: number;
  changeType: string;
  referenceId: string;
  actor: string;
  note: string;
}

/**
 * Applies a stock delta to one product and appends the matching journal row.
 *
 * MUST be called inside a transaction. The `SELECT ... FOR UPDATE` is what makes
 * this safe: the old in-memory version relied on Node being single-threaded,
 * which does not hold across multiple server instances. The lock serialises
 * concurrent checkouts so two buyers cannot both pass the availability check
 * and oversell the same units.
 */
export async function applyStockDelta(tx: Tx, params: StockDelta): Promise<number> {
  const locked = (
    await tx
      .select()
      .from(products)
      .where(eq(products.id, params.productId))
      .for('update')
      .limit(1)
  ).at(0);

  if (locked === undefined || (locked.deletedAt !== null && params.allowDeleted !== true)) {
    throw new Error(`Product ${params.productId} not found`);
  }

  const previousStock = locked.stockQuantity;
  const nextStock =
    params.setTo ??
    (params.clampAtZero
      ? Math.max(0, previousStock + params.delta)
      : previousStock + params.delta);

  const patch: Partial<typeof products.$inferInsert> = {
    stockQuantity: nextStock,
    updatedAt: new Date(),
  };
  if (params.reservedDelta) {
    patch.reservedQuantity = Math.max(0, locked.reservedQuantity + params.reservedDelta);
  }
  if (params.costPrice !== undefined && params.costPrice > 0) {
    patch.costPrice = String(params.costPrice);
  }
  await tx.update(products).set(patch).where(eq(products.id, params.productId));

  await tx.insert(inventoryMovements).values({
    id: newId('ledger'),
    productId: params.productId,
    productName: locked.name,
    changeAmount: nextStock - previousStock,
    previousStock,
    newStock: nextStock,
    changeType: params.changeType,
    referenceId: params.referenceId,
    actor: params.actor,
    note: params.note,
  });

  return nextStock - previousStock;
}

function toProducts(rows: ProductJoined[]): Product[] {
  return rows.map(toProduct);
}

export class InventoryDomainService {
  static async getLedger(limit = 100): Promise<InventoryLedgerEntry[]> {
    const rows = await getContainer().catalog.listMovements(limit);
    return rows.map(toLedgerEntry);
  }

  /** On-hand minus reserved, at or below the reorder threshold. */
  static async getLowStock(): Promise<Product[]> {
    const rows = await getContainer().catalog.listProducts();
    return rows
      .map(toProduct)
      .filter((p) => p.stockQuantity - p.reservedQuantity <= p.lowStockThreshold);
  }

  /** Query-side variant — one round trip instead of loading the whole catalog. */
  static async getLowStockRows(): Promise<Product[]> {
    return toProducts(await getContainer().catalog.listLowStock());
  }

  // ── Adjustments ───────────────────────────────────────────────────────────

  /** Correct stock to an absolute count (quick ±1/±5, edit-modal override). */
  static async adjust(
    productId: string,
    newQuantity: number,
    reason = 'Manual Adjustment',
    actor = 'admin',
  ): Promise<Product> {
    if (newQuantity < 0) throw new Error('Stock quantity cannot be negative');

    await drizzleDb.transaction(async (tx) => {
      await applyStockDelta(tx, {
        productId,
        delta: 0,
        setTo: newQuantity,
        changeType: 'manual_adjustment',
        referenceId: `ADJ-${Date.now()}`,
        actor,
        note: reason,
      });
    });

    void broadcastRealtime('inventory_update', { type: 'stock_adjusted', productId });
    return this.requireProduct(productId);
  }

  /** Stock in from a purchase order. Optionally re-bases the unit cost. */
  static async receive(
    productId: string,
    quantity: number,
    supplier: string,
    poNumber: string,
    unitCost?: number,
    notes?: string,
    actor = 'admin',
  ): Promise<Product> {
    if (quantity <= 0) throw new Error('Received quantity must be greater than 0');

    await drizzleDb.transaction(async (tx) => {
      await applyStockDelta(tx, {
        productId,
        delta: quantity,
        costPrice: unitCost,
        changeType: 'purchase_order_receipt',
        referenceId: poNumber || `PO-${Date.now()}`,
        actor,
        note: `Received ${quantity} units from supplier "${supplier || 'Standard Supplier'}". ${notes || ''}`.trim(),
      });
    });

    void broadcastRealtime('inventory_update', { type: 'stock_received', productId });
    return this.requireProduct(productId);
  }

  /** Damage / loss / shrinkage. Rejects over-writing off. */
  static async writeOff(
    productId: string,
    quantity: number,
    reasonCode: WriteOffReason,
    notes?: string,
    actor = 'admin',
  ): Promise<Product> {
    if (quantity <= 0) throw new Error('Write-off quantity must be greater than 0');

    await drizzleDb.transaction(async (tx) => {
      const locked = (
        await tx
          .select({ onHand: products.stockQuantity, deletedAt: products.deletedAt })
          .from(products)
          .where(eq(products.id, productId))
          .for('update')
          .limit(1)
      ).at(0);
      if (locked === undefined || locked.deletedAt !== null) {
        throw new Error(`Product ${productId} not found`);
      }
      if (quantity > locked.onHand) {
        throw new Error(
          `Cannot write off ${quantity} units; only ${locked.onHand} currently on hand.`,
        );
      }

      await applyStockDelta(tx, {
        productId,
        delta: -quantity,
        changeType: 'damage_writeoff',
        referenceId: `WRITEOFF-${Date.now()}`,
        actor,
        note: `Stock Write-off (${WRITE_OFF_LABELS[reasonCode] || reasonCode}). ${notes || ''}`.trim(),
      });
    });

    void broadcastRealtime('inventory_update', { type: 'stock_writeoff', productId });
    return this.requireProduct(productId);
  }

  /** Physical shelf count — journals the discrepancy, not the raw delta. */
  static async audit(
    productId: string,
    countedQuantity: number,
    notes?: string,
    actor = 'inventory_auditor',
  ): Promise<{ product: Product; discrepancy: number }> {
    if (countedQuantity < 0) throw new Error('Physical count cannot be negative');

    const discrepancy = await drizzleDb.transaction(async (tx) => {
      const locked = (
        await tx
          .select({ onHand: products.stockQuantity, deletedAt: products.deletedAt })
          .from(products)
          .where(eq(products.id, productId))
          .for('update')
          .limit(1)
      ).at(0);
      if (locked === undefined || locked.deletedAt !== null) {
        throw new Error(`Product ${productId} not found`);
      }
      const diff = countedQuantity - locked.onHand;

      await applyStockDelta(tx, {
        productId,
        delta: 0,
        setTo: countedQuantity,
        changeType: 'physical_audit',
        referenceId: `AUDIT-${Date.now()}`,
        actor,
        note: `Physical Shelf Count Audit: Counted ${countedQuantity} (Discrepancy: ${diff >= 0 ? '+' : ''}${diff}). ${notes || ''}`.trim(),
      });
      return diff;
    });

    void broadcastRealtime('inventory_update', { type: 'audit_completed', productId });
    return { product: await this.requireProduct(productId), discrepancy };
  }

  /**
   * Bulk correction. One transaction for the whole batch — a stock count that
   * half-applies is worse than one that does not apply at all.
   */
  static async batchAdjust(
    adjustments: { productId: string; newQuantity: number; reason: string }[],
    actor = 'admin',
  ): Promise<Product[]> {
    if (adjustments.length === 0) return [];

    await drizzleDb.transaction(async (tx) => {
      for (const adj of adjustments) {
        if (adj.newQuantity < 0) throw new Error('Stock quantity cannot be negative');
        await applyStockDelta(tx, {
          productId: adj.productId,
          delta: 0,
          setTo: adj.newQuantity,
          changeType: 'manual_adjustment',
          referenceId: `ADJ-${Date.now()}`,
          actor,
          note: adj.reason,
        });
      }
    });

    for (const adj of adjustments) {
      void broadcastRealtime('inventory_update', {
        type: 'stock_adjusted',
        productId: adj.productId,
      });
    }
    return toProducts(
      await getContainer().catalog.getProductsByIds(adjustments.map((a) => a.productId)),
    );
  }

  /**
   * Put reserved units back on the shelf when an order is cancelled or its
   * payment failed. Idempotent — a journal row for this order in either
   * settlement state means it has already run.
   */
  static async restockCancelledOrder(
    items: { productId: string; quantity: number }[],
    orderId: string,
    reason: string,
    actor = 'admin',
  ): Promise<void> {
    if (items.length === 0) return;

    const alreadySettled = await getContainer().catalog.hasSettlementMovement(orderId, [
      'order_cancellation_release',
      'order_fulfillment',
    ]);
    if (alreadySettled) return;

    await drizzleDb.transaction(async (tx) => {
      for (const item of items) {
        const [exists] = await tx
          .select({ id: products.id })
          .from(products)
          .where(eq(products.id, item.productId))
          .limit(1);
        if (!exists) continue;

        await applyStockDelta(tx, {
          productId: item.productId,
          delta: item.quantity,
          reservedDelta: -item.quantity,
          allowDeleted: true,
          changeType: 'order_cancellation_release',
          referenceId: orderId,
          actor,
          note: `Released reservation of ${item.quantity} units for order ${orderId}. ${reason}`.trim(),
        });
      }
    });

    void broadcastRealtime('inventory_update', { type: 'release', orderId });
  }

  // ── Order lifecycle ───────────────────────────────────────────────────────

  /**
   * Move an order through its fulfilment states. Timestamps are stamped here
   * rather than trusted from the caller, and every field lands in Postgres —
   * the old version mutated the in-memory `orders` Map and lost it on restart.
   */
  static async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    shippingCourier?: string,
    trackingNumber?: string,
    internalNotes?: string,
  ): Promise<Order> {
    const { orders } = getContainer();
    const existing = await orders.getById(orderId);
    if (!existing) throw new Error(`Order ${orderId} not found`);

    const now = new Date();
    const patch: Parameters<typeof orders.update>[1] = { status };

    if (shippingCourier) patch.shippingCourier = shippingCourier;
    if (trackingNumber) patch.trackingNumber = trackingNumber;
    if (internalNotes !== undefined) patch.internalNotes = internalNotes;
    if (status === 'shipped' && !existing.shippedAt) patch.shippedAt = now;
    if ((status === 'delivered' || status === 'completed') && !existing.deliveredAt) {
      patch.deliveredAt = now;
    }

    const updated = await orders.update(orderId, patch);
    if (!updated) throw new Error(`Order ${orderId} not found`);

    void broadcastRealtime('order_updated', updated);
    return updated;
  }

  /**
   * Cancel an order and return its units to the shelf. Idempotent on the stock
   * side: the journal guard in the reservation service means a retried cancel
   * cannot restock twice.
   */
  static async cancelOrder(orderId: string, reason: string, actor = 'admin'): Promise<Order> {
    const { orders } = getContainer();
    const existing = await orders.getById(orderId);
    if (!existing) throw new Error(`Order ${orderId} not found`);
    if (existing.status === 'cancelled') throw new Error('Order is already cancelled');

    const updated = await orders.update(orderId, {
      status: 'cancelled',
      internalNotes: `${existing.internalNotes ?? ''}\n[cancelled] ${reason}`.trim(),
    });
    if (!updated) throw new Error(`Order ${orderId} not found`);

    await InventoryReservationService.releaseOrder(orderId, `order cancelled: ${reason}`, actor);

    void broadcastRealtime('order_updated', updated);
    return updated;
  }

  private static async requireProduct(productId: string): Promise<Product> {
    const row = await getContainer().catalog.getProductById(productId);
    if (!row) throw new Error(`Product ${productId} not found`);
    return toProduct(row);
  }
}
