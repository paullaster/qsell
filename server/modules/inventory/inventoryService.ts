import { db } from '../../db/postgresStore.js';
import { Product, InventoryLedgerEntry } from '../../../src/types/index.js';

export class InventoryService {
  public static getAllProducts(): Product[] {
    return Array.from(db.products.values());
  }

  public static getProductById(id: string): Product | undefined {
    return db.products.get(id);
  }

  public static getProductBySlug(slug: string): Product | undefined {
    return Array.from(db.products.values()).find(p => p.slug === slug);
  }

  public static getInventoryLedger(limit: number = 100): InventoryLedgerEntry[] {
    return [...db.inventoryLedger].reverse().slice(0, limit);
  }

  public static getLowStockProducts(): Product[] {
    return Array.from(db.products.values()).filter(p => {
      const available = p.stockQuantity - p.reservedQuantity;
      return available <= p.lowStockThreshold;
    });
  }

  public static updateStock(productId: string, newStock: number, reason: string, actor: string = 'admin'): Product {
    const product = db.manualAdjustStock(productId, newStock, reason, actor);
    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }
    return product;
  }

  public static createProduct(productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'reservedQuantity'>): Product {
    const id = `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newProduct: Product = {
      ...productData,
      id,
      reservedQuantity: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.products.set(id, newProduct);

    // Add initial ledger entry
    db.inventoryLedger.push({
      id: `ledger_${id}_init`,
      productId: id,
      productName: newProduct.name,
      changeAmount: newProduct.stockQuantity,
      previousStock: 0,
      newStock: newProduct.stockQuantity,
      changeType: 'restock',
      referenceId: 'PRODUCT_CREATION',
      actor: 'admin',
      note: `Created new product ${newProduct.sku} with initial inventory of ${newProduct.stockQuantity} units`,
      timestamp: new Date().toISOString()
    });

    db.broadcast('inventory_update', {
      type: 'product_created',
      productId: id,
      products: Array.from(db.products.values())
    });

    return newProduct;
  }

  public static updateProduct(id: string, updates: Partial<Product>): Product {
    const existing = db.products.get(id);
    if (!existing) {
      throw new Error(`Product ${id} not found`);
    }

    if (updates.stockQuantity !== undefined && updates.stockQuantity !== existing.stockQuantity) {
      db.manualAdjustStock(id, updates.stockQuantity, 'Updated via Product Edit Modal', 'admin');
    }

    const updated: Product = {
      ...existing,
      ...updates,
      id, // protect id
      updatedAt: new Date().toISOString()
    };

    db.products.set(id, updated);

    db.broadcast('inventory_update', {
      type: 'product_updated',
      productId: id,
      products: Array.from(db.products.values())
    });

    return updated;
  }

  public static deleteProduct(id: string): boolean {
    const deleted = db.products.delete(id);
    if (deleted) {
      db.broadcast('inventory_update', {
        type: 'product_deleted',
        productId: id,
        products: Array.from(db.products.values())
      });
    }
    return deleted;
  }
}
