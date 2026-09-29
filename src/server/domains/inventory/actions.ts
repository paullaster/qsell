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

export async function adjustStockAction(
  productId: string,
  newQuantity: number,
  reason: string,
): Promise<Product> {
  await requirePermission('inventory:adjust');
  const product = await InventoryDomainService.adjust(productId, newQuantity, reason);
  revalidatePath('/admin/inventory');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return product;
}

export async function updateProductStockAction(
  productId: string,
  newQuantity: number,
  reason: string,
): Promise<Product> {
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
}): Promise<Product> {
  await requirePermission('inventory:adjust');
  const product = await InventoryDomainService.writeOff(
    payload.productId,
    payload.quantity,
    payload.reasonCode,
    payload.notes,
  );
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return product;
}

export async function auditStockCountAction(payload: {
  productId: string;
  countedQuantity: number;
  notes?: string;
}): Promise<{ product: Product; discrepancy: number }> {
  await requirePermission('inventory:adjust');
  const result = await InventoryDomainService.audit(
    payload.productId,
    payload.countedQuantity,
    payload.notes,
  );
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return result;
}

export async function batchAdjustStockAction(
  adjustments: { productId: string; newQuantity: number; reason: string }[],
): Promise<Product[]> {
  await requirePermission('inventory:adjust');
  const products = await InventoryDomainService.batchAdjust(adjustments);
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return products;
}

export async function updateOrderStatusAction(
  orderId: string,
  payload: {
    status: OrderStatus;
    shippingCourier?: string;
    trackingNumber?: string;
    internalNotes?: string;
  },
): Promise<Order> {
  await requirePermission('orders:update');
  const order = await InventoryDomainService.updateOrderStatus(
    orderId,
    payload.status,
    payload.shippingCourier,
    payload.trackingNumber,
    payload.internalNotes,
  );
  revalidatePath('/admin/orders');
  return order;
}

export async function cancelOrderAction(orderId: string, reason: string): Promise<Order> {
  await requirePermission('orders:cancel');
  const order = await InventoryDomainService.cancelOrder(orderId, reason);
  revalidatePath('/admin/orders');
  revalidatePath('/admin/inventory');
  return order;
}
