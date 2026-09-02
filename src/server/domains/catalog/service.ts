import { db } from '@/server/db/store';
import type { Product, Category, InventoryLedgerEntry } from '@/types/index';

export class CatalogService {
  static getAllProducts(): Product[] {
    return Array.from(db.products.values());
  }

  static getProductById(id: string): Product | undefined {
    return db.products.get(id);
  }

  static getProductBySlug(slug: string): Product | undefined {
    return Array.from(db.products.values()).find((p) => p.slug === slug);
  }

  static createProduct(
    productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'reservedQuantity'>
  ): Product {
    const id = `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newProduct: Product = {
      ...productData,
      id,
      reservedQuantity: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.products.set(id, newProduct);
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
      timestamp: new Date().toISOString(),
    });

    db.broadcast('inventory_update', {
      type: 'product_created',
      productId: id,
      products: Array.from(db.products.values()),
    });

    return newProduct;
  }

  static updateProduct(id: string, updates: Partial<Product>): Product {
    const existing = db.products.get(id);
    if (!existing) throw new Error(`Product ${id} not found`);

    if (updates.stockQuantity !== undefined && updates.stockQuantity !== existing.stockQuantity) {
      db.manualAdjustStock(id, updates.stockQuantity, 'Updated via Product Edit Modal', 'admin');
    }

    const updated: Product = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString(),
    };
    db.products.set(id, updated);
    db.broadcast('inventory_update', {
      type: 'product_updated',
      productId: id,
      products: Array.from(db.products.values()),
    });
    return updated;
  }

  static deleteProduct(id: string): boolean {
    const deleted = db.products.delete(id);
    if (deleted) {
      db.broadcast('inventory_update', {
        type: 'product_deleted',
        productId: id,
        products: Array.from(db.products.values()),
      });
    }
    return deleted;
  }

  static getAllCategories(): Category[] {
    return db.getAllCategories();
  }

  static getCategoryById(id: string): Category | undefined {
    return db.getCategoryById(id);
  }

  static createCategory(
    data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>
  ): Category {
    return db.createCategory(data);
  }

  static updateCategory(id: string, updates: Partial<Category>): Category {
    return db.updateCategory(id, updates);
  }

  static deleteCategory(id: string): boolean {
    return db.deleteCategory(id);
  }
}
