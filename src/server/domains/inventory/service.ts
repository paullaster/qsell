import { db } from '@/server/db/store';
import type { Product, InventoryLedgerEntry, Order, OrderStatus } from '@/types/index';

export class InventoryDomainService {
  static getLedger(limit = 100): InventoryLedgerEntry[] {
    return [...db.inventoryLedger].reverse().slice(0, limit);
  }

  static getLowStock(): Product[] {
    return Array.from(db.products.values()).filter((p) => {
      const available = p.stockQuantity - p.reservedQuantity;
      return available <= p.lowStockThreshold;
    });
  }

  static adjust(productId: string, newQuantity: number, reason: string, actor = 'admin'): Product {
    return db.manualAdjustStock(productId, newQuantity, reason, actor);
  }

  static receive(
    productId: string,
    quantity: number,
    supplier: string,
    poNumber: string,
    unitCost?: number,
    notes?: string,
    actor = 'admin',
  ): Product {
    return db.receiveStock(productId, quantity, supplier, poNumber, unitCost, notes, actor);
  }

  static writeOff(
    productId: string,
    quantity: number,
    reasonCode:
      | 'damage_transit'
      | 'defective_return'
      | 'warehouse_damage'
      | 'shrinkage_loss'
      | 'sample_marketing',
    notes?: string,
    actor = 'admin',
  ): Product {
    return db.writeOffStock(productId, quantity, reasonCode, notes, actor);
  }

  static audit(
    productId: string,
    countedQuantity: number,
    notes?: string,
    actor = 'inventory_auditor',
  ) {
    return db.physicalStockAudit(productId, countedQuantity, notes, actor);
  }

  static batchAdjust(
    adjustments: { productId: string; newQuantity: number; reason: string }[],
    actor = 'admin',
  ): Product[] {
    return db.batchStockAdjust(adjustments, actor);
  }

  static updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    shippingCourier?: string,
    trackingNumber?: string,
    internalNotes?: string,
  ): Order {
    return db.updateOrderStatus(orderId, status, shippingCourier, trackingNumber, internalNotes);
  }

  static cancelOrder(orderId: string, reason: string, actor = 'admin'): Order {
    return db.cancelOrderAndRestock(orderId, reason, actor);
  }
}
