'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { InventoryDomainService } from './service';
import type { Product, InventoryLedgerEntry, Order, OrderStatus } from '@/types/index';

export async function listInventoryLedgerAction(limit = 100): Promise<InventoryLedgerEntry[]> {
  await requirePermission('inventory:read');
  return InventoryDomainService.getLedger(limit);
}

export async function listLowStockAction(): Promise<Product[]> {
  await requirePermission('inventory:read');
  return InventoryDomainService.getLowStock();
}

/** A change that a workflow wants approved first: nothing has changed yet. */
export type StockPendingApproval = { pendingApproval: true; message: string };

export async function adjustStockAction(
  productId: string,
  newQuantity: number,
  reason: string,
): Promise<Product | StockPendingApproval> {
  const userId = await requirePermission('inventory:adjust');
  const outcome = await InventoryDomainService.gatedOp(
    { kind: 'adjust', productId, newQuantity, reason, actor: userId },
    userId,
  );
  if (outcome.parked) return { pendingApproval: true, message: outcome.message };
  revalidatePath('/admin/inventory');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return InventoryDomainService.getProduct(productId);
}

export async function updateProductStockAction(
  productId: string,
  newQuantity: number,
  reason: string,
): Promise<Product | StockPendingApproval> {
  await requirePermission('inventory:adjust');
  return adjustStockAction(productId, newQuantity, reason);
}

export async function receiveStockAction(payload: {
  productId: string;
  quantity: number;
  supplier: string;
  poNumber: string;
  unitCost?: number;
  notes?: string;
}): Promise<Product> {
  await requirePermission('inventory:adjust');
  const product = await InventoryDomainService.receive(
    payload.productId,
    payload.quantity,
    payload.supplier,
    payload.poNumber,
    payload.unitCost,
    payload.notes,
  );
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return product;
}

export async function writeOffStockAction(payload: {
  productId: string;
  quantity: number;
  reasonCode:
    | 'damage_transit'
    | 'defective_return'
    | 'warehouse_damage'
    | 'shrinkage_loss'
    | 'sample_marketing';
  notes?: string;
}): Promise<Product | StockPendingApproval> {
  const userId = await requirePermission('inventory:adjust');
  const outcome = await InventoryDomainService.gatedOp(
    {
      kind: 'write_off',
      productId: payload.productId,
      quantity: payload.quantity,
      reasonCode: payload.reasonCode,
      notes: payload.notes,
      actor: userId,
    },
    userId,
  );
  if (outcome.parked) return { pendingApproval: true, message: outcome.message };
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return InventoryDomainService.getProduct(payload.productId);
}

export async function auditStockCountAction(payload: {
  productId: string;
  countedQuantity: number;
  notes?: string;
}): Promise<{ product: Product; discrepancy: number } | StockPendingApproval> {
  const userId = await requirePermission('inventory:adjust');
  const outcome = await InventoryDomainService.gatedOp(
    {
      kind: 'count',
      productId: payload.productId,
      countedQuantity: payload.countedQuantity,
      notes: payload.notes,
      actor: userId,
    },
    userId,
  );
  if (outcome.parked) return { pendingApproval: true, message: outcome.message };
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return {
    product: await InventoryDomainService.getProduct(payload.productId),
    discrepancy: outcome.value.discrepancy ?? 0,
  };
}

export async function batchAdjustStockAction(
  adjustments: { productId: string; newQuantity: number; reason: string }[],
): Promise<Product[] | StockPendingApproval> {
  const userId = await requirePermission('inventory:adjust');
  if (adjustments.length === 0) return [];
  const outcome = await InventoryDomainService.gatedOp(
    { kind: 'batch', adjustments, actor: userId },
    userId,
  );
  if (outcome.parked) return { pendingApproval: true, message: outcome.message };
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return InventoryDomainService.getProducts(adjustments.map((a) => a.productId));
}

export type OrderActionResult = { ok: true; data: Order } | { ok: false; error: string };

/** Server-action errors are masked in production, so a refusal (held for approval, not found) comes back as data. */
async function orderOutcome(work: () => Promise<Order>, fallback: string): Promise<OrderActionResult> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    console.error('[orders] action', error);
    return { ok: false, error: error instanceof Error && error.message.length > 0 && error.message.length < 200 ? error.message : fallback };
  }
}

export async function updateOrderStatusAction(
  orderId: string,
  payload: {
    status: OrderStatus;
    shippingCourier?: string;
    trackingNumber?: string;
    internalNotes?: string;
  },
): Promise<OrderActionResult> {
  await requirePermission('orders:update');
  const result = await orderOutcome(
    () =>
      InventoryDomainService.updateOrderStatus(
        orderId,
        payload.status,
        payload.shippingCourier,
        payload.trackingNumber,
        payload.internalNotes,
      ),
    'The order could not be updated. Please try again.',
  );
  revalidatePath('/admin/orders');
  return result;
}

export async function cancelOrderAction(orderId: string, reason: string): Promise<OrderActionResult> {
  await requirePermission('orders:cancel');
  const result = await orderOutcome(() => InventoryDomainService.cancelOrder(orderId, reason), 'The order could not be cancelled. Please try again.');
  revalidatePath('/admin/orders');
  revalidatePath('/admin/inventory');
  return result;
}
