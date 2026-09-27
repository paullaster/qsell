import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import type { Product, Category, ItemType } from '@/types/index';
import { toCategory, toItemType, toProduct, productToRow } from './mappers';
import type { CatalogRepository } from './repository';

function repo(): CatalogRepository {
  return getContainer().catalog;
}

/** Monotonic-ish id, same shape the old in-memory store used. */
function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class CatalogService {
  // ── Products ──────────────────────────────────────────────────────────────

  static async getAllProducts(): Promise<Product[]> {
    const rows = await repo().listProducts();
    return rows.map(toProduct);
  }

  static async getSellableProducts(): Promise<Product[]> {
    const rows = await repo().listActiveSellableProducts();
    return rows.map(toProduct);
  }

  static async getProductById(id: string): Promise<Product | undefined> {
    const row = await repo().getProductById(id);
    return row ? toProduct(row) : undefined;
  }

  static async getProductBySlug(slug: string): Promise<Product | undefined> {
    const row = await repo().getProductBySlug(slug);
    return row ? toProduct(row) : undefined;
  }

  static async getProductsByIds(ids: string[]): Promise<Product[]> {
    const rows = await repo().getProductsByIds(ids);
    return rows.map(toProduct);
  }

  static async createProduct(
    productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'reservedQuantity'>,
  ): Promise<Product> {
    const catalog = repo();
    const itemType =
      (productData.itemTypeId ? await catalog.getItemTypeById(productData.itemTypeId) : null) ??
      (await catalog.getDefaultItemType());
    if (!itemType) {
      throw new Error('Create an item type first, then assign it to this product');
    }
    if (!productData.sku.trim()) throw new Error('SKU code is required');
    if (!productData.stockCode.trim()) throw new Error('Stock code is required');

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

    const id = newId('prod');
    // Resolve the category by display name — the modal posts a free-text name.
    const category = await catalog.getCategoryByName(productData.category ?? '');

    const now = new Date().toISOString();
    const newProduct: Product = {
      ...productData,
      id,
      sku: productData.sku.trim().toUpperCase(),
      stockCode: productData.stockCode.trim().toUpperCase(),
      price,
      costPrice: Number(productData.costPrice),
      itemTypeId: itemType.id,
      itemTypeName: itemType.name,
      itemTypeCode: itemType.code,
      isSellable,
      reservedQuantity: 0,
      createdAt: now,
      updatedAt: now,
    };

    const row = productToRow(newProduct);
    row.categoryId = category?.id ?? null;
    await catalog.insertProduct(row);

    await catalog.insertMovement({
      id: newId('ledger'),
      productId: id,
      productName: newProduct.name,
      changeAmount: newProduct.stockQuantity,
      previousStock: 0,
      newStock: newProduct.stockQuantity,
      changeType: 'restock',
      referenceId: 'PRODUCT_CREATION',
      actor: 'admin',
      note: `Created new product ${newProduct.sku} with initial inventory of ${newProduct.stockQuantity} units`,
    });

    void broadcastRealtime('inventory_update', {
      type: 'product_created',
      productId: id,
    });

    return newProduct;
  }

  static async updateProduct(id: string, updates: Partial<Product>): Promise<Product> {
    const catalog = repo();
    const existingRow = await catalog.getProductById(id);
    if (!existingRow) throw new Error(`Product ${id} not found`);
    const existing = toProduct(existingRow);

    if (updates.sku !== undefined) {
      if (!updates.sku.trim()) throw new Error('SKU code is required');
      updates.sku = updates.sku.trim().toUpperCase();
    }
    if (updates.stockCode !== undefined) {
      if (!updates.stockCode.trim()) throw new Error('Stock code is required');
      updates.stockCode = updates.stockCode.trim().toUpperCase();
    }

    if (updates.itemTypeId) {
      const itemType = await catalog.getItemTypeById(updates.itemTypeId);
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

    // A stock change from the edit modal is a real inventory movement, so route
    // it through the inventory service rather than writing the column blind.
    if (updates.stockQuantity !== undefined && updates.stockQuantity !== existing.stockQuantity) {
      const { InventoryDomainService } = await import('@/server/domains/inventory/service');
      await InventoryDomainService.adjust(
        id,
        updates.stockQuantity,
        'Updated via Product Edit Modal',
        'admin',
      );
      delete updates.stockQuantity;
    }

    const merged: Product = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    const patch = productToRow(merged);
    // categoryId is managed by categoryId resolution, not by the merged blob.
    delete (patch as Partial<typeof patch>).categoryId;
    if (updates.category !== undefined) {
      const category = await catalog.getCategoryByName(updates.category);
      patch.categoryId = category?.id ?? null;
    }

    const updated = await catalog.updateProduct(id, patch);
    void broadcastRealtime('inventory_update', { type: 'product_updated', productId: id });
    return updated ? toProduct(updated) : merged;
  }

  static async deleteProduct(id: string): Promise<boolean> {
    const deleted = await repo().deleteProduct(id);
    if (deleted) {
      void broadcastRealtime('inventory_update', { type: 'product_deleted', productId: id });
    }
    return deleted;
  }

  // ── Categories ────────────────────────────────────────────────────────────

  static async getAllCategories(): Promise<Category[]> {
    const rows = await repo().listCategories();
    return rows.map((row) => toCategory(row, row.productCount));
  }

  static async getCategoryById(id: string): Promise<Category | undefined> {
    const row = await repo().getCategoryById(id);
    return row ? toCategory(row) : undefined;
  }

  static async createCategory(
    data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
  ): Promise<Category> {
    const row = await repo().insertCategory({
      id: newId('cat'),
      name: data.name,
      slug: data.slug || slugify(data.name),
      description: data.description ?? '',
      imageUrl: data.imageUrl ?? null,
      isActive: data.isActive ?? true,
      displayOrder: data.displayOrder ?? 0,
    });
    void broadcastRealtime('category_update', { type: 'created', category: toCategory(row) });
    return toCategory(row);
  }

  static async updateCategory(id: string, updates: Partial<Category>): Promise<Category> {
    const catalog = repo();
    const existing = await catalog.getCategoryById(id);
    if (!existing) throw new Error(`Category ${id} not found`);

    // Keep denormalized product labels in step with a rename.
    if (updates.name && updates.name !== existing.name) {
      await catalog.renameCategoryLabel(existing.name, updates.name);
    }

    const row = await catalog.updateCategory(id, {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.slug !== undefined ? { slug: updates.slug } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.imageUrl !== undefined ? { imageUrl: updates.imageUrl ?? null } : {}),
      ...(updates.isActive !== undefined ? { isActive: updates.isActive } : {}),
      ...(updates.displayOrder !== undefined ? { displayOrder: updates.displayOrder } : {}),
    });
    if (!row) throw new Error(`Category ${id} not found`);
    void broadcastRealtime('category_update', { type: 'updated', category: toCategory(row) });
    return toCategory(row);
  }

  static async deleteCategory(id: string): Promise<{
    deleted: boolean;
    reassignedCount: number;
    fallbackName: string | null;
  }> {
    const catalog = repo();
    const existing = await catalog.getCategoryById(id);
    if (!existing) return { deleted: false, reassignedCount: 0, fallbackName: null };

    const blocked = await catalog.countProductsInCategory(id);
    if (blocked > 0) {
      throw new Error(
        `Cannot delete "${existing.name}" — ${blocked} product${blocked === 1 ? '' : 's'} still assigned. Reassign them first.`,
      );
    }

    await catalog.deleteCategory(id);
    void broadcastRealtime('category_update', { type: 'deleted', categoryId: id });
    return { deleted: true, reassignedCount: 0, fallbackName: null };
  }

  // ── Item types ────────────────────────────────────────────────────────────

  static async getAllItemTypes(): Promise<ItemType[]> {
    const rows = await repo().listItemTypes();
    return rows.map((row) => toItemType(row, row.productCount));
  }

  static async getItemTypeById(id: string): Promise<ItemType | undefined> {
    const row = await repo().getItemTypeById(id);
    return row ? toItemType(row) : undefined;
  }

  static async createItemType(data: {
    name: string;
    code: number;
    isSellable: boolean;
    isDefault?: boolean;
    isActive?: boolean;
  }): Promise<ItemType> {
    const catalog = repo();
    if (data.isDefault) await catalog.clearDefaultItemType('__none__');
    const row = await catalog.insertItemType({
      id: newId('itype'),
      name: data.name,
      code: data.code,
      isSellable: data.isSellable,
      isDefault: data.isDefault ?? false,
      isActive: data.isActive ?? true,
    });
    void broadcastRealtime('item_type_update', { type: 'created', itemType: toItemType(row) });
    return toItemType(row);
  }

  static async updateItemType(
    id: string,
    updates: Partial<Pick<ItemType, 'name' | 'code' | 'isSellable' | 'isDefault' | 'isActive'>>,
  ): Promise<ItemType> {
    const catalog = repo();
    if (updates.isDefault) await catalog.clearDefaultItemType(id);
    const row = await catalog.updateItemType(id, updates);
    if (!row) throw new Error(`Item type ${id} not found`);
    void broadcastRealtime('item_type_update', { type: 'updated', itemType: toItemType(row) });
    return toItemType(row);
  }

  static async setDefaultItemType(id: string): Promise<ItemType> {
    const catalog = repo();
    const row = await catalog.updateItemType(id, { isDefault: true });
    if (!row) throw new Error(`Item type ${id} not found`);
    await catalog.clearDefaultItemType(id);
    void broadcastRealtime('item_type_update', { type: 'default_changed', itemTypeId: id });
    return toItemType(row);
  }

  static async deleteItemType(id: string): Promise<boolean> {
    const catalog = repo();
    const inUse = await catalog.countProductsInItemType(id);
    if (inUse > 0) {
      throw new Error(
        `Cannot delete this item type — ${inUse} product${inUse === 1 ? '' : 's'} still use it. Reassign them first.`,
      );
    }
    const deleted = await catalog.deleteItemType(id);
    if (deleted) {
      void broadcastRealtime('item_type_update', { type: 'deleted', itemTypeId: id });
    }
    return deleted;
  }
}
