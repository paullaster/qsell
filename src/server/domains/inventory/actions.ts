'use server';

import { revalidatePath } from 'next/cache';
import { InventoryDomainService } from './service';
import type { Product, InventoryLedgerEntry, Order, OrderStatus } from '@/types/index';

export async function listInventoryLedgerAction(limit = 100): Promise<InventoryLedgerEntry[]> {
  return InventoryDomainService.getLedger(limit);
}

export async function listLowStockAction(): Promise<Product[]> {
  return InventoryDomainService.getLowStock();
}

export async function adjustStockAction(
  productId: string,
  newQuantity: number,
  reason: string,
): Promise<Product> {
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
  const order = await InventoryDomainService.cancelOrder(orderId, reason);
  revalidatePath('/admin/orders');
  revalidatePath('/admin/inventory');
  return order;
}
