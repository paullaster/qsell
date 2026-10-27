import { and, eq, isNull } from 'drizzle-orm';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { inventoryMovements, products } from '@/server/db/drizzle/schema';
import { randomUUID } from 'node:crypto';
import { broadcastRealtime } from '@/server/realtime';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type {
  Product,
  ProductPatch,
  ProductWrite,
  PublicProduct,
  Category,
  ItemType,
} from '@/types/index';
import { SettingsError } from '@/server/domains/settings/errors';
import { quantityProblem } from '@/lib/unit-rules';
import { limitsProblem } from '@/lib/quantity-limits';
import { optionalAmount, standardPriceProblem } from './commercial-rules';
import { toCategory, toItemType, toProduct, toPublicProduct, productToRow } from './mappers';
import type { CatalogRepository } from './repository';
import { inTreeOrder, parentProblem } from './category-tree';

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

/** Slugs are URL keys; a title-derived slug can collide, so suffix -2, -3… until free. */
async function resolveUniqueSlug(base: string, excludeProductId?: string): Promise<string> {
  const stem = slugify(base) || 'product';
  for (let attempt = 1; attempt < 10000; attempt += 1) {
    const candidate = attempt === 1 ? stem : `${stem}-${attempt}`;
    const match = await repo().getProductBySlug(candidate);
    if (!match || match.id === excludeProductId) return candidate;
  }
  throw new Error('Could not generate a unique URL slug for this product.');
}

export class CatalogService {
  // ── Products ──────────────────────────────────────────────────────────────

  static async getAllProducts(): Promise<Product[]> {
    const rows = await repo().listProducts();
    return rows.map(toProduct);
  }

  static async getSellableProducts(): Promise<PublicProduct[]> {
    const rows = await repo().listActiveSellableProducts();
    return rows.map((row) => toPublicProduct(toProduct(row)));
  }

  /** A single product as the storefront may see it: published and sellable only. */
  static async getPublicProduct(id: string): Promise<PublicProduct | undefined> {
    const row = await repo().getProductById(id);
    if (!row || !row.isActive || !row.isSellable) return undefined;
    return toPublicProduct(toProduct(row));
  }

  /** A product for sale by its readable address (slug) or, for older links, its id. */
  static async getPublicProductByKey(key: string): Promise<PublicProduct | undefined> {
    const row = (await repo().getProductBySlug(key)) ?? (await repo().getProductById(key));
    if (!row || !row.isActive || !row.isSellable) return undefined;
    return toPublicProduct(toProduct(row));
  }

  static async getProductById(id: string): Promise<Product | undefined> {
    const row = await repo().getProductById(id);
    return row ? toProduct(row) : undefined;
  }

  /** Staff single-product read: includes the ordered media gallery for the product form. */
  static async getProductWithMedia(id: string): Promise<Product | undefined> {
    const row = await repo().getProductById(id);
    if (!row) return undefined;
    return { ...toProduct(row), media: await getContainer().media.getProductGallery(id) };
  }

  static async getProductBySlug(slug: string): Promise<Product | undefined> {
    const row = await repo().getProductBySlug(slug);
    return row ? toProduct(row) : undefined;
  }

  static async getProductsByIds(ids: string[]): Promise<Product[]> {
    const rows = await repo().getProductsByIds(ids);
    return rows.map(toProduct);
  }

  static async createProduct(productData: ProductWrite): Promise<Product> {
    const catalog = repo();
    const { media: galleryInput, packagings: packagingInput, baseUnitId: requestedUnit, ...fields } = productData;
    const itemType =
      (productData.itemTypeId ? await catalog.getItemTypeById(productData.itemTypeId) : null) ??
      (await catalog.getDefaultItemType());
    if (!itemType) {
      throw new SettingsError('Create an item type first, then assign it to this product');
    }
    // A blank SKU or stock code is numbered by its series when the product is saved (below).
    const { unit, packagings: preparedPackagings } = await getContainer().unitWriter.planForProduct({
      productId: null,
      requestedUnitId: requestedUnit,
      current: null,
      packagings: packagingInput ?? [],
    });
    const packagings = preparedPackagings ?? [];
    for (const [value, what] of [
      [productData.stockQuantity, 'Stock quantity'],
      [productData.lowStockThreshold, 'The low stock threshold'],
    ] as const) {
      const problem = quantityProblem(value, unit.decimals, unit.name, what);
      if (problem !== null) throw new SettingsError(problem);
      if (value < 0) throw new SettingsError(`${what} must be 0 or more`);
    }

    const isSellable = itemType.isSellable;
    let price: number | undefined;

    if (isSellable) {
      if (
        productData.price == null ||
        !Number.isFinite(Number(productData.price)) ||
        Number(productData.price) <= 0
      ) {
        throw new SettingsError('Selling price is required for sellable item types');
      }
      price = Number(productData.price);
    } else if (productData.price != null) {
      price = Number(productData.price);
      if (!Number.isFinite(price) || price < 0) {
        throw new SettingsError('Selling price must be 0 or greater when provided');
      }
    }

    if (
      productData.costPrice == null ||
      !Number.isFinite(Number(productData.costPrice)) ||
      Number(productData.costPrice) < 0
    ) {
      throw new SettingsError('Cost of goods is required');
    }

    // The least and most that may be bought at once, and the price the pricing engine starts from. All three may be empty.
    const minOrderQty = optionalAmount(productData.minOrderQty);
    const maxOrderQty = optionalAmount(productData.maxOrderQty);
    const standardPrice = optionalAmount(productData.standardPrice);
    const limitIssue = limitsProblem(minOrderQty, maxOrderQty, unit.decimals, unit.name);
    if (limitIssue !== null) throw new SettingsError(limitIssue);
    const standardIssue = standardPriceProblem(standardPrice, isSellable);
    if (standardIssue !== null) throw new SettingsError(standardIssue);

    const id = newId('prod');
    // Resolve the category by display name — the modal posts a free-text name.
    const category = await catalog.getCategoryByName(productData.category ?? '');

    const now = new Date().toISOString();
    const newProduct: Product = {
      ...fields,
      id,
      slug: await resolveUniqueSlug(productData.slug || productData.name),
      sku: (productData.sku ?? '').trim().toUpperCase(),
      stockCode: (productData.stockCode ?? '').trim().toUpperCase(),
      price,
      standardPrice,
      minOrderQty,
      maxOrderQty,
      costPrice: Number(productData.costPrice),
      itemTypeId: itemType.id,
      itemTypeName: itemType.name,
      itemTypeCode: itemType.code,
      isSellable,
      baseUnitId: unit.id,
      baseUnitCode: unit.code,
      baseUnitName: unit.name,
      baseUnitDecimals: unit.decimals,
      reservedQuantity: 0,
      createdAt: now,
      updatedAt: now,
    };

    const row = productToRow(newProduct);
    row.categoryId = category?.id ?? null;

    // One transaction: a product must never exist with stock the ledger can't explain.
    const mediaService = getContainer().media;
    // Looked up before the transaction opens: needing it inside would take a second connection.
    const companyId =
      row.sku === '' || row.stockCode === ''
        ? (await getContainer().companySettings.ensureSeeded()).id
        : '';
    await drizzleDb.transaction(async (tx) => {
      for (const [field, kind] of [
        ['sku', 'product_sku'],
        ['stockCode', 'product_stock_code'],
      ] as const) {
        if (row[field] !== '') continue;
        const { number } = await getContainer().numbering.assign(
          kind,
          { companyId, date: businessDate(), document: { kind, id } },
          tx,
        );
        row[field] = number.toUpperCase();
        newProduct[field] = row[field];
      }
      await tx.insert(products).values(row);
      await getContainer().units.replacePackagingIn(tx, id, packagings);
      // The gallery commits with the product. Callers that only know image links
      // (API, CSV-style input) still get proper assets so the model stays consistent.
      let gallery: { imageUrl: string; additionalImages: string[] } | null = null;
      if (galleryInput !== undefined) {
        gallery = await mediaService.setProductGallery(tx, id, galleryInput);
      } else {
        const links = [newProduct.imageUrl, ...(newProduct.additionalImages ?? [])].filter(
          (url) => url.trim() !== '',
        );
        if (links.length > 0) {
          gallery = await mediaService.setProductGalleryFromUrls(tx, id, links, 'api');
        }
      }
      if (gallery !== null) {
        newProduct.imageUrl = gallery.imageUrl;
        newProduct.additionalImages = gallery.additionalImages;
      }
      await tx.insert(inventoryMovements).values({
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
    });

    void broadcastRealtime('inventory_update', {
      type: 'product_created',
      productId: id,
    });

    return newProduct;
  }

  static async updateProduct(id: string, patchInput: ProductPatch): Promise<Product> {
    const catalog = repo();
    const { media: galleryUpdate, packagings: packagingUpdate, ...updates } = patchInput;
    const existingRow = await catalog.getProductById(id);
    if (!existingRow) throw new SettingsError(`Product ${id} not found`);
    const existing = toProduct(existingRow);

    if (updates.sku !== undefined) {
      if (updates.sku.trim() === '') throw new SettingsError('SKU code is required');
      updates.sku = updates.sku.trim().toUpperCase();
    }
    if (updates.stockCode !== undefined) {
      if (updates.stockCode.trim() === '') throw new SettingsError('Stock code is required');
      updates.stockCode = updates.stockCode.trim().toUpperCase();
    }
    if (updates.sku !== undefined && updates.sku !== existing.sku) {
      const clash = await catalog.getProductBySku(updates.sku);
      if (clash && clash.id !== id) {
        throw new SettingsError(`SKU ${updates.sku} is already used by "${clash.name}"`);
      }
    }
    if (updates.stockCode !== undefined && updates.stockCode !== existing.stockCode) {
      const clash = await catalog.getProductByStockCode(updates.stockCode);
      if (clash && clash.id !== id) {
        throw new SettingsError(`Stock code ${updates.stockCode} is already used by "${clash.name}"`);
      }
    }
    if (updates.slug !== undefined && updates.slug !== existing.slug) {
      updates.slug = await resolveUniqueSlug(updates.slug || existing.name, id);
    }

    const plan = await getContainer().unitWriter.planForProduct({
      productId: id,
      requestedUnitId: updates.baseUnitId,
      current: existing,
      packagings: packagingUpdate,
    });
    updates.baseUnitId = plan.unit.id;
    const packagings = plan.packagings;

    if (updates.itemTypeId) {
      const itemType = await catalog.getItemTypeById(updates.itemTypeId);
      if (!itemType) throw new SettingsError('Selected item type was not found');
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
        throw new SettingsError('Selling price is required for sellable item types');
      }
      if (updates.price !== undefined) updates.price = Number(nextPrice);
    } else if (updates.price !== undefined) {
      if (updates.price == null) {
        updates.price = undefined;
      } else {
        const p = Number(updates.price);
        if (!Number.isFinite(p) || p < 0) {
          throw new SettingsError('Selling price must be 0 or greater when provided');
        }
        updates.price = p;
      }
    }

    if (nextCost == null || !Number.isFinite(Number(nextCost)) || Number(nextCost) < 0) {
      throw new SettingsError('Cost of goods is required');
    }
    if (updates.costPrice !== undefined) updates.costPrice = Number(nextCost);

    // Quantity limits are checked together and in the unit the product will be counted in after this save.
    const nextMin = updates.minOrderQty !== undefined ? optionalAmount(updates.minOrderQty) : (existing.minOrderQty ?? null);
    const nextMax = updates.maxOrderQty !== undefined ? optionalAmount(updates.maxOrderQty) : (existing.maxOrderQty ?? null);
    const limitIssue = limitsProblem(nextMin, nextMax, plan.unit.decimals, plan.unit.name);
    if (limitIssue !== null) throw new SettingsError(limitIssue);
    if (updates.minOrderQty !== undefined) updates.minOrderQty = nextMin;
    if (updates.maxOrderQty !== undefined) updates.maxOrderQty = nextMax;
    if (updates.standardPrice !== undefined) {
      updates.standardPrice = optionalAmount(updates.standardPrice);
      const standardIssue = standardPriceProblem(updates.standardPrice, nextSellable);
      if (standardIssue !== null) throw new SettingsError(standardIssue);
    } else if (existing.standardPrice != null && nextSellable && !existing.isSellable) {
      // An item that becomes sellable keeps a standard price only if it is a usable one.
      const standardIssue = standardPriceProblem(existing.standardPrice, true);
      if (standardIssue !== null) throw new SettingsError(standardIssue);
    }

    // Stock and reservations are owned by the inventory ledger, never by this patch:
    // writing them from the snapshot read above would revert an adjustment made in the
    // same save and clobber reservations placed since the read.
    const stockChange =
      updates.stockQuantity !== undefined && updates.stockQuantity !== existing.stockQuantity
        ? updates.stockQuantity
        : undefined;
    if (stockChange !== undefined && stockChange < 0) throw new SettingsError('Stock quantity must be 0 or more');
    // Counted in the product's unit (the new one, when this save changes it).
    for (const [value, what] of [
      [stockChange, 'Stock quantity'],
      [updates.lowStockThreshold, 'The low stock threshold'],
    ] as const) {
      const problem = value === undefined ? null : quantityProblem(value, plan.unit.decimals, plan.unit.name, what);
      if (problem !== null) throw new SettingsError(problem);
    }

    const merged: Product = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    const patch = productToRow(merged);
    // categoryId is managed by categoryId resolution, not by the merged blob.
    delete (patch as Partial<typeof patch>).categoryId;
    if (updates.category !== undefined) {
      const category = await catalog.getCategoryByName(updates.category);
      patch.categoryId = category?.id ?? null;
    }
    const fieldPatch: Partial<typeof patch> = { ...patch };
    delete fieldPatch.id;
    delete fieldPatch.stockQuantity;
    delete fieldPatch.reservedQuantity;
    delete fieldPatch.createdAt;

    // One transaction: the field update and the stock movement succeed or fail together.
    const { applyStockDelta } = await import('@/server/domains/inventory/service');
    const mediaService = getContainer().media;
    // Looked up before the transaction opens: needing it inside would take a second connection.
    const stockCompanyId =
      stockChange !== undefined ? (await getContainer().companySettings.ensureSeeded()).id : '';
    await drizzleDb.transaction(async (tx) => {
      await tx
        .update(products)
        .set({ ...fieldPatch, updatedAt: new Date() })
        .where(eq(products.id, id));
      if (packagings !== undefined) await getContainer().units.replacePackagingIn(tx, id, packagings);
      // After the field update: the gallery refreshes image_url / additional_images itself.
      if (galleryUpdate !== undefined) {
        await mediaService.setProductGallery(tx, id, galleryUpdate);
      }
      if (stockChange !== undefined) {
        await applyStockDelta(tx, {
          productId: id,
          delta: 0,
          setTo: stockChange,
          changeType: 'manual_adjustment',
          referenceId: (
            await getContainer().numbering.assign(
              'stock_adjustment',
              {
                companyId: stockCompanyId,
                date: businessDate(),
                document: { kind: 'stock_adjustment', id: randomUUID() },
              },
              tx,
            )
          ).number,
          actor: 'admin',
          note: 'Updated via Product Edit Modal',
        });
      }
    });

    void broadcastRealtime('inventory_update', { type: 'product_updated', productId: id });
    const updated = await catalog.getProductById(id);
    return updated ? toProduct(updated) : merged;
  }

  /**
   * Soft delete: the row stays so the stock ledger (and order/quote history)
   * keeps resolving, but it drops out of every catalog read and releases its
   * SKU, stock code and slug for reuse.
   */
  static async deleteProduct(id: string): Promise<boolean> {
    const deleted = await drizzleDb.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(products)
          .where(and(eq(products.id, id), isNull(products.deletedAt)))
          .for('update')
          .limit(1)
      ).at(0);
      if (locked === undefined) return false;

      const now = new Date();
      await tx
        .update(products)
        .set({ deletedAt: now, isActive: false, updatedAt: now })
        .where(eq(products.id, id));
      await tx.insert(inventoryMovements).values({
        id: newId('ledger'),
        productId: id,
        productName: locked.name,
        changeAmount: 0,
        previousStock: locked.stockQuantity,
        newStock: locked.stockQuantity,
        changeType: 'product_deleted',
        referenceId: `DELETE-${locked.sku}`,
        actor: 'admin',
        note: `Product ${locked.sku} deleted with ${locked.stockQuantity} units on hand`,
      });
      return true;
    });
    if (deleted) {
      void broadcastRealtime('inventory_update', { type: 'product_deleted', productId: id });
    }
    return deleted;
  }

  // ── Categories ────────────────────────────────────────────────────────────

  static async getAllCategories(): Promise<Category[]> {
    const rows = await repo().listCategories();
    // Shown as a tree: each sub-category under its parent, with its full path.
    return inTreeOrder(rows).map((row) => ({
      ...toCategory(row, row.productCount),
      path: row.path,
      depth: row.depth,
    }));
  }

  /** Category names are how products and CSV imports refer to a category, so each must be unique. */
  private static async assertCategoryNameFree(name: string, exceptId: string | null) {
    const clash = await repo().getCategoryByName(name);
    if (clash && clash.id !== exceptId)
      throw new Error(
        `A category called "${clash.name}" already exists. Names must be different, even under different parents.`,
      );
  }

  private static async assertParent(id: string | null, parentId: string | null) {
    const problem = parentProblem(id, parentId, await repo().categoryParents());
    if (problem) throw new Error(problem);
  }

  static async getCategoryById(id: string): Promise<Category | undefined> {
    const row = await repo().getCategoryById(id);
    return row ? toCategory(row) : undefined;
  }

  static async createCategory(
    data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
  ): Promise<Category> {
    await CatalogService.assertCategoryNameFree(data.name, null);
    await CatalogService.assertParent(null, data.parentId ?? null);
    const row = await repo().insertCategory({
      id: newId('cat'),
      parentId: data.parentId ?? null,
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

    if (updates.name !== undefined && updates.name !== existing.name)
      await CatalogService.assertCategoryNameFree(updates.name, id);
    if (updates.parentId !== undefined && (updates.parentId ?? null) !== existing.parentId)
      await CatalogService.assertParent(id, updates.parentId ?? null);

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
      ...(updates.parentId !== undefined ? { parentId: updates.parentId ?? null } : {}),
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

    const children = await catalog.countChildCategories(id);
    if (children > 0) {
      throw new Error(
        `Cannot delete "${existing.name}" — it has ${children} sub-categor${children === 1 ? 'y' : 'ies'}. Move or delete them first.`,
      );
    }
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
