import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { roundQty } from '@/lib/decimal';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { inventoryMovements, products, unitsOfMeasure } from '@/server/db/drizzle/schema';
import { quantityProblem } from '@/lib/unit-rules';
import { broadcastRealtime } from '@/server/realtime';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { afterCommit, withAfterCommit } from '@/server/kernel/after-commit';
import type { GateResult } from '@/server/kernel/approvals/parked-actions';
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
    await tx.select().from(products).where(eq(products.id, params.productId)).for('update').limit(1)
  ).at(0);

  if (locked === undefined || (locked.deletedAt !== null && params.allowDeleted !== true)) {
    throw new Error(`Product ${params.productId} not found`);
  }

  const previousStock = locked.stockQuantity;
  const nextStock =
    params.setTo ??
    roundQty(params.clampAtZero === true ? Math.max(0, previousStock + params.delta) : previousStock + params.delta);

  // Stock is counted in the product's unit: 2.5 pieces cannot be on a shelf, 2.5 kg can.
  const unit = (await tx.select({ name: unitsOfMeasure.name, decimals: unitsOfMeasure.decimals }).from(unitsOfMeasure).where(eq(unitsOfMeasure.id, locked.baseUnitId)).limit(1)).at(0);
  if (unit !== undefined) {
    const problem = quantityProblem(nextStock, unit.decimals, unit.name, `Stock of "${locked.name}"`) ?? quantityProblem(roundQty(nextStock - previousStock), unit.decimals, unit.name, `The change in stock of "${locked.name}"`);
    if (problem !== null) throw new Error(problem);
  }

  const patch: Partial<typeof products.$inferInsert> = {
    stockQuantity: nextStock,
    updatedAt: new Date(),
  };
  if (params.reservedDelta) {
    patch.reservedQuantity = Math.max(0, roundQty(locked.reservedQuantity + params.reservedDelta));
  }
  if (params.costPrice !== undefined && params.costPrice > 0) {
    patch.costPrice = String(params.costPrice);
  }
  await tx.update(products).set(patch).where(eq(products.id, params.productId));

  await tx.insert(inventoryMovements).values({
    id: newId('ledger'),
    productId: params.productId,
    productName: locked.name,
    changeAmount: roundQty(nextStock - previousStock),
    previousStock,
    newStock: nextStock,
    changeType: params.changeType,
    referenceId: params.referenceId,
    actor: params.actor,
    note: params.note,
  });

  return roundQty(nextStock - previousStock);
}

type StockDocumentKind = 'stock_adjustment' | 'stock_receipt' | 'stock_write_off' | 'stock_count';

/**
 * The reference for one stock document, from its number series, assigned inside the same
 * transaction that moves the stock. (It used to be `ADJ-${Date.now()}`: two adjustments in the
 * same millisecond collided, and nothing said who had used which number.)
 *
 * `companyId` must be looked up BEFORE the transaction opens: fetching it inside would need a
 * second pooled connection while this one is held.
 */
async function stockReference(tx: Tx, companyId: string, kind: StockDocumentKind): Promise<string> {
  const { number } = await getContainer().numbering.assign(
    kind,
    { companyId, date: businessDate(), document: { kind, id: randomUUID() } },
    tx,
  );
  return number;
}

async function stockCompanyId(): Promise<string> {
  return (await getContainer().companySettings.ensureSeeded()).id;
}

function toProducts(rows: ProductJoined[]): Product[] {
  return rows.map(toProduct);
}

/** An order waiting for, or refused, approval cannot be moved along (it can still be cancelled). */
export function assertNotHeldForApproval(order: Order, next: OrderStatus): void {
  if (next === 'cancelled') return;
  const held = order.approvalStatus;
  if (held === 'pending') {
    throw new Error('This order is waiting for approval. It can move on once it is approved.');
  }
  if (held === 'rejected' || held === 'draft') {
    throw new Error(
      'Approval for this order was refused. Reopen it and send it for approval again, or cancel it.',
    );
  }
}

export type StockOp =
  | { kind: 'adjust'; productId: string; newQuantity: number; reason: string; actor: string }
  | {
      kind: 'write_off';
      productId: string;
      quantity: number;
      reasonCode: WriteOffReason;
      notes?: string;
      actor: string;
    }
  | { kind: 'count'; productId: string; countedQuantity: number; notes?: string; actor: string }
  | {
      kind: 'batch';
      adjustments: { productId: string; newQuantity: number; reason: string }[];
      actor: string;
    };

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
    await this.runOp({ kind: 'adjust', productId, newQuantity, reason, actor });
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
    const companyId = await stockCompanyId();

    await drizzleDb.transaction(async (tx) => {
      await applyStockDelta(tx, {
        productId,
        delta: quantity,
        costPrice: unitCost,
        changeType: 'purchase_order_receipt',
        // A purchase order number typed in by the user is kept; otherwise the receipt is numbered.
        referenceId: poNumber || (await stockReference(tx, companyId, 'stock_receipt')),
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
    await this.runOp({ kind: 'write_off', productId, quantity, reasonCode, notes, actor });
    return this.requireProduct(productId);
  }

  /** Physical shelf count — journals the discrepancy, not the raw delta. */
  static async audit(
    productId: string,
    countedQuantity: number,
    notes?: string,
    actor = 'inventory_auditor',
  ): Promise<{ product: Product; discrepancy: number }> {
    const { discrepancy } = await this.runOp({
      kind: 'count',
      productId,
      countedQuantity,
      notes,
      actor,
    });
    return { product: await this.requireProduct(productId), discrepancy: discrepancy ?? 0 };
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
    await this.runOp({ kind: 'batch', adjustments, actor });
    return toProducts(
      await getContainer().catalog.getProductsByIds(adjustments.map((a) => a.productId)),
    );
  }

  // ── Approval gate ─────────────────────────────────────────────────────────

  /** Runs a stock operation now: one transaction, with its realtime events sent after commit. */
  static async runOp(op: StockOp): Promise<{ discrepancy?: number }> {
    const companyId = await stockCompanyId();
    return withAfterCommit(drizzleDb, (tx) => this.applyOp(tx, companyId, op));
  }

  /**
   * The stock operation itself, inside the caller's transaction. Used directly, and by an
   * approval when the last approver says yes.
   */
  static async applyOp(tx: Tx, companyId: string, op: StockOp): Promise<{ discrepancy?: number }> {
    const lock = async (productId: string) => {
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
      return locked;
    };
    const announce = (type: string, productId: string) =>
      afterCommit(tx, () => void broadcastRealtime('inventory_update', { type, productId }));

    switch (op.kind) {
      case 'adjust': {
        if (op.newQuantity < 0) throw new Error('Stock quantity cannot be negative');
        await applyStockDelta(tx, {
          productId: op.productId,
          delta: 0,
          setTo: op.newQuantity,
          changeType: 'manual_adjustment',
          referenceId: await stockReference(tx, companyId, 'stock_adjustment'),
          actor: op.actor,
          note: op.reason,
        });
        announce('stock_adjusted', op.productId);
        return {};
      }
      case 'write_off': {
        if (op.quantity <= 0) throw new Error('Write-off quantity must be greater than 0');
        const locked = await lock(op.productId);
        if (op.quantity > locked.onHand) {
          throw new Error(
            `Cannot write off ${op.quantity} units; only ${locked.onHand} currently on hand.`,
          );
        }
        await applyStockDelta(tx, {
          productId: op.productId,
          delta: -op.quantity,
          changeType: 'damage_writeoff',
          referenceId: await stockReference(tx, companyId, 'stock_write_off'),
          actor: op.actor,
          note: `Stock Write-off (${WRITE_OFF_LABELS[op.reasonCode] || op.reasonCode}). ${op.notes || ''}`.trim(),
        });
        announce('stock_writeoff', op.productId);
        return {};
      }
      case 'count': {
        if (op.countedQuantity < 0) throw new Error('Physical count cannot be negative');
        const locked = await lock(op.productId);
        const diff = op.countedQuantity - locked.onHand;
        await applyStockDelta(tx, {
          productId: op.productId,
          delta: 0,
          setTo: op.countedQuantity,
          changeType: 'physical_audit',
          referenceId: await stockReference(tx, companyId, 'stock_count'),
          actor: op.actor,
          note: `Physical Shelf Count Audit: Counted ${op.countedQuantity} (Discrepancy: ${diff >= 0 ? '+' : ''}${diff}). ${op.notes || ''}`.trim(),
        });
        announce('audit_completed', op.productId);
        return { discrepancy: diff };
      }
      case 'batch': {
        // One batch is one document: every line carries the same reference.
        const referenceId = await stockReference(tx, companyId, 'stock_adjustment');
        for (const adj of op.adjustments) {
          if (adj.newQuantity < 0) throw new Error('Stock quantity cannot be negative');
          await applyStockDelta(tx, {
            productId: adj.productId,
            delta: 0,
            setTo: adj.newQuantity,
            changeType: 'manual_adjustment',
            referenceId,
            actor: op.actor,
            note: adj.reason,
          });
          announce('stock_adjusted', adj.productId);
        }
        return {};
      }
    }
  }

  /**
   * Runs a stock operation, or parks it for approval when a workflow says a change this size needs
   * one. With no workflow configured it runs straight away, as it always did.
   */
  static async gatedOp(
    op: StockOp,
    requestedBy: string,
  ): Promise<GateResult<{ discrepancy?: number }>> {
    const companyId = await stockCompanyId();
    const lines =
      op.kind === 'batch'
        ? op.adjustments.map((a) => ({
            productId: a.productId,
            target: a.newQuantity as number | null,
            delta: null as number | null,
          }))
        : op.kind === 'write_off'
          ? [{ productId: op.productId, target: null, delta: -op.quantity }]
          : [
              {
                productId: op.productId,
                target: (op.kind === 'adjust' ? op.newQuantity : op.countedQuantity) as
                  number | null,
                delta: null,
              },
            ];
    const rows = await getContainer().catalog.getProductsByIds([
      ...new Set(lines.map((l) => l.productId)),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));

    let quantity = 0;
    let amount = 0;
    let percent = 0;
    const described: string[] = [];
    for (const l of lines) {
      const p = byId.get(l.productId);
      if (!p) throw new Error(`Product ${l.productId} not found`);
      const onHand = p.stockQuantity;
      const change = l.delta ?? (l.target ?? onHand) - onHand;
      quantity += Math.abs(change);
      amount += Math.abs(change) * Number(p.costPrice ?? 0);
      percent = Math.max(percent, (Math.abs(change) / Math.max(onHand, 1)) * 100);
      described.push(`${change >= 0 ? '+' : '−'}${Math.abs(change)} × ${p.sku}`);
    }
    const reasonCode =
      op.kind === 'write_off' ? op.reasonCode : op.kind === 'count' ? 'stock_count' : 'adjustment';
    const verb = {
      adjust: 'Adjust stock',
      write_off: 'Write off stock',
      count: 'Record a stock count',
      batch: 'Adjust stock in bulk',
    }[op.kind];
    const summary = `${verb}: ${described.slice(0, 4).join(', ')}${described.length > 4 ? `, and ${described.length - 4} more` : ''}. Worth KES ${Math.round(amount).toLocaleString('en-KE')} at cost.`;

    return getContainer().approvalGate.gate(
      {
        trigger: 'stock_adjustment.submitted',
        companyId,
        requestedBy,
        amount: Math.round(amount * 100) / 100,
        facts: { quantity, percentOfOnHand: Math.round(percent * 100) / 100, reasonCode },
        action: 'stock_operation',
        payload: { ...op, actor: requestedBy } as unknown as Record<string, unknown>,
        summary,
      },
      () => this.runOp(op),
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
    assertNotHeldForApproval(existing, status);

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

  static async getProduct(productId: string): Promise<Product> {
    return this.requireProduct(productId);
  }

  static async getProducts(ids: string[]): Promise<Product[]> {
    return toProducts(await getContainer().catalog.getProductsByIds(ids));
  }

  private static async requireProduct(productId: string): Promise<Product> {
    const row = await getContainer().catalog.getProductById(productId);
    if (!row) throw new Error(`Product ${productId} not found`);
    return toProduct(row);
  }
}
