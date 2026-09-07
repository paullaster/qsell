import { db } from '@/server/db/store';
import type { Product, Category, ItemType } from '@/types/index';

export class CatalogService {
  static getAllProducts(): Product[] {
    return Array.from(db.products.values());
  }

  static getSellableProducts(): Product[] {
    return Array.from(db.products.values()).filter((p) => p.isActive && p.isSellable !== false);
  }

  static getProductById(id: string): Product | undefined {
    return db.products.get(id);
  }

  static getProductBySlug(slug: string): Product | undefined {
    return Array.from(db.products.values()).find((p) => p.slug === slug);
  }

  static createProduct(
    productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'reservedQuantity'>,
  ): Product {
    const itemType =
      (productData.itemTypeId ? db.getItemTypeById(productData.itemTypeId) : undefined) ||
      db.getDefaultItemType();
    if (!itemType) {
      throw new Error('Create an item type first, then assign it to this product');
    }

    const isSellable = itemType.isSellable;
    let price: number | undefined;

    if (isSellable) {
      if (productData.price == null || !Number.isFinite(Number(productData.price)) || Number(productData.price) <= 0) {
        throw new Error('Selling price is required for sellable item types');
      }
      price = Number(productData.price);
    } else if (productData.price != null) {
      price = Number(productData.price);
      if (!Number.isFinite(price) || price < 0) {
        throw new Error('Selling price must be 0 or greater when provided');
      }
    }

    if (productData.costPrice == null || !Number.isFinite(Number(productData.costPrice)) || Number(productData.costPrice) < 0) {
      throw new Error('Cost of goods is required');
    }
    const costPrice = Number(productData.costPrice);

    const id = `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newProduct: Product = {
      ...productData,
      id,
      price,
      costPrice,
      itemTypeId: itemType.id,
      itemTypeName: itemType.name,
      itemTypeCode: itemType.code,
      isSellable,
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

    if (updates.itemTypeId) {
      const itemType = db.getItemTypeById(updates.itemTypeId);
      if (!itemType) throw new Error('Selected item type was not found');
      updates.itemTypeName = itemType.name;
      updates.itemTypeCode = itemType.code;
      updates.isSellable = itemType.isSellable;
    }

    const nextSellable =
      updates.isSellable !== undefined ? updates.isSellable : existing.isSellable;
    const nextPrice = updates.price !== undefined ? updates.price : existing.price;
    const nextCost = updates.costPrice !== undefined ? updates.costPrice : existing.costPrice;

    if (nextSellable) {
      if (nextPrice == null || !Number.isFinite(Number(nextPrice)) || Number(nextPrice) <= 0) {
        throw new Error('Selling price is required for sellable item types');
      }
      if (updates.price !== undefined) updates.price = Number(nextPrice);
    } else if (updates.price !== undefined) {
      if (updates.price == null) {
        updates.price = undefined;
      } else {
        const p = Number(updates.price);
        if (!Number.isFinite(p) || p < 0) {
          throw new Error('Selling price must be 0 or greater when provided');
        }
        updates.price = p;
      }
    }

    if (nextCost == null || !Number.isFinite(Number(nextCost)) || Number(nextCost) < 0) {
      throw new Error('Cost of goods is required');
    }
    if (updates.costPrice !== undefined) updates.costPrice = Number(nextCost);

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
    data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
  ): Category {
    return db.createCategory(data);
  }

  static updateCategory(id: string, updates: Partial<Category>): Category {
    return db.updateCategory(id, updates);
  }

  static deleteCategory(id: string): {
    deleted: boolean;
    reassignedCount: number;
    fallbackName: string | null;
  } {
    return db.deleteCategory(id);
  }

  static getAllItemTypes(): ItemType[] {
    return db.getAllItemTypes();
  }

  static getItemTypeById(id: string): ItemType | undefined {
    return db.getItemTypeById(id);
  }

  static createItemType(data: {
    name: string;
    code: number;
    isSellable: boolean;
    isDefault?: boolean;
    isActive?: boolean;
  }): ItemType {
    return db.createItemType(data);
  }

  static updateItemType(
    id: string,
    updates: Partial<Pick<ItemType, 'name' | 'code' | 'isSellable' | 'isDefault' | 'isActive'>>,
  ): ItemType {
    return db.updateItemType(id, updates);
  }

  static setDefaultItemType(id: string): ItemType {
    return db.setDefaultItemType(id);
  }

  static deleteItemType(id: string): boolean {
    return db.deleteItemType(id);
  }
}
