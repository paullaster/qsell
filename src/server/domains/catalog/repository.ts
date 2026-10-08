import { and, asc, count, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  categories,
  currencies,
  inventoryMovements,
  itemTypes,
  paymentGatewayConfigs,
  paymentTransactions,
  products,
  reconciliationLogs,
  taxCategories,
  integrationAuditLog,
  type IntegrationAuditLogRow,
  type CategoryRow,
  type CurrencyRow,
  type InventoryMovementRow,
  type ItemTypeRow,
  type PaymentGatewayConfigRow,
  type PaymentTransactionRow,
  type ProductRow,
  type ReconciliationLogRow,
  type TaxCategoryRow,
} from '@/server/db/drizzle/schema';

/** Extra columns pulled in by the product joins, beyond `products` itself. */
const productRelations = {
  itemTypeName: itemTypes.name,
  itemTypeCode: itemTypes.code,
  taxCategoryName: taxCategories.name,
  categoryLabel: categories.name,
};

/**
 * A product row joined with its item type, tax category and category label.
 *
 * The joined columns are nullable because they come from `leftJoin`. In
 * practice `itemTypeId` is NOT NULL with a RESTRICT foreign key so the item
 * type always resolves; the mapper still defends against a null rather than
 * trusting the constraint.
 */
type ProductJoined = ProductRow & {
  itemTypeName: string | null;
  itemTypeCode: number | null;
  taxCategoryName: string | null;
  categoryLabel: string | null;
};

export class CatalogRepository {
  constructor(private readonly db: DrizzleDb) {}

  // ── Categories ────────────────────────────────────────────────────────────

  async listCategories(): Promise<(CategoryRow & { productCount: number })[]> {
    const rows = await this.db
      .select({
        row: categories,
        // Both sides must be explicitly qualified: inside the subquery an
        // unqualified "id" would resolve against `products`, not the outer
        // `categories` row, and every category would report zero.
        productCount: sql<number>`(
          select count(*)::int from ${products} as p
          where p.category_id = ${categories}.id
        )`,
      })
      .from(categories)
      .orderBy(asc(categories.displayOrder), asc(categories.name));

    return rows.map((entry) => ({ ...entry.row, productCount: Number(entry.productCount) }));
  }

  /** Every category's parent, for walking up the tree. Categories are few, so this is one cheap read. */
  async categoryParents(): Promise<Map<string, string | null>> {
    const rows = await this.db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories);
    return new Map(rows.map((r) => [r.id, r.parentId]));
  }

  async countChildCategories(id: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(categories)
      .where(eq(categories.parentId, id));
    return Number(row?.value ?? 0);
  }

  async getCategoryById(id: string): Promise<CategoryRow | null> {
    const rows = await this.db.select().from(categories).where(eq(categories.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getCategoryBySlug(slug: string): Promise<CategoryRow | null> {
    const rows = await this.db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
    return rows[0] ?? null;
  }

  async getCategoryByName(name: string): Promise<CategoryRow | null> {
    const rows = await this.db
      .select()
      .from(categories)
      .where(sql`lower(${categories.name}) = lower(${name})`)
      .limit(1);
    return rows[0] ?? null;
  }

  async insertCategory(values: typeof categories.$inferInsert): Promise<CategoryRow> {
    const [row] = await this.db.insert(categories).values(values).returning();
    return row!;
  }

  async updateCategory(id: string, patch: Partial<CategoryRow>): Promise<CategoryRow | null> {
    const [row] = await this.db
      .update(categories)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(categories.id, id))
      .returning();
    return row ?? null;
  }

  async deleteCategory(id: string): Promise<boolean> {
    const rows = await this.db.delete(categories).where(eq(categories.id, id)).returning();
    return rows.length > 0;
  }

  /** Categories that still hold products — blocks deletion until they are moved. */
  async countProductsInCategory(id: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(products)
      .where(and(eq(products.categoryId, id), isNull(products.deletedAt)));
    return Number(row?.value ?? 0);
  }

  /** Detach products from a category, keeping their stored display name. */
  async nullifyCategoryForProducts(id: string): Promise<number> {
    const rows = await this.db
      .update(products)
      .set({ categoryId: null, updatedAt: new Date() })
      .where(eq(products.categoryId, id))
      .returning({ id: products.id });
    return rows.length;
  }

  async renameCategoryLabel(oldName: string, newName: string): Promise<number> {
    const rows = await this.db
      .update(products)
      .set({ categoryName: newName, updatedAt: new Date() })
      .where(sql`lower(${products.categoryName}) = lower(${oldName})`)
      .returning({ id: products.id });
    return rows.length;
  }

  // ── Item types ────────────────────────────────────────────────────────────

  async listItemTypes(): Promise<(ItemTypeRow & { productCount: number })[]> {
    const rows = await this.db
      .select({
        row: itemTypes,
        productCount: sql<number>`(
          select count(*)::int from ${products} as p
          where p.item_type_id = ${itemTypes}.id
        )`,
      })
      .from(itemTypes)
      .orderBy(asc(itemTypes.code));

    return rows.map((entry) => ({ ...entry.row, productCount: Number(entry.productCount) }));
  }

  async getItemTypeById(id: string): Promise<ItemTypeRow | null> {
    const rows = await this.db.select().from(itemTypes).where(eq(itemTypes.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getDefaultItemType(): Promise<ItemTypeRow | null> {
    const rows = await this.db
      .select()
      .from(itemTypes)
      .where(eq(itemTypes.isDefault, true))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertItemType(values: typeof itemTypes.$inferInsert): Promise<ItemTypeRow> {
    const [row] = await this.db.insert(itemTypes).values(values).returning();
    return row!;
  }

  async updateItemType(id: string, patch: Partial<ItemTypeRow>): Promise<ItemTypeRow | null> {
    const [row] = await this.db
      .update(itemTypes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(itemTypes.id, id))
      .returning();
    return row ?? null;
  }

  async clearDefaultItemType(exceptId: string): Promise<void> {
    await this.db
      .update(itemTypes)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(itemTypes.isDefault, true), sql`${itemTypes.id} <> ${exceptId}`));
  }

  async deleteItemType(id: string): Promise<boolean> {
    const rows = await this.db.delete(itemTypes).where(eq(itemTypes.id, id)).returning();
    return rows.length > 0;
  }

  async countProductsInItemType(id: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(products)
      .where(eq(products.itemTypeId, id));
    return Number(row?.value ?? 0);
  }

  // ── Tax categories ────────────────────────────────────────────────────────

  async listTaxCategories(): Promise<(TaxCategoryRow & { productCount: number })[]> {
    const rows = await this.db
      .select({
        row: taxCategories,
        productCount: sql<number>`(
          select count(*)::int from ${products} as p
          where p.tax_category_id = ${taxCategories}.id
        )`,
      })
      .from(taxCategories)
      .orderBy(asc(taxCategories.name));

    return rows.map((entry) => ({ ...entry.row, productCount: Number(entry.productCount) }));
  }

  async getTaxCategoryById(id: string): Promise<TaxCategoryRow | null> {
    const rows = await this.db.select().from(taxCategories).where(eq(taxCategories.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async insertTaxCategory(values: typeof taxCategories.$inferInsert): Promise<TaxCategoryRow> {
    const [row] = await this.db.insert(taxCategories).values(values).returning();
    return row!;
  }

  async updateTaxCategory(id: string, patch: Partial<TaxCategoryRow>): Promise<TaxCategoryRow | null> {
    const [row] = await this.db
      .update(taxCategories)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(taxCategories.id, id))
      .returning();
    return row ?? null;
  }

  async clearDefaultTaxCategory(exceptId: string): Promise<void> {
    await this.db
      .update(taxCategories)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(taxCategories.isDefault, true), sql`${taxCategories.id} <> ${exceptId}`));
  }

  async deleteTaxCategory(id: string): Promise<boolean> {
    const rows = await this.db.delete(taxCategories).where(eq(taxCategories.id, id)).returning();
    return rows.length > 0;
  }

  async deleteAllTaxCategories(): Promise<void> {
    await this.db.delete(taxCategories);
  }

  // ── Currencies ────────────────────────────────────────────────────────────

  async listCurrencies(): Promise<CurrencyRow[]> {
    return this.db.select().from(currencies).orderBy(asc(currencies.code));
  }

  async getCurrencyByCode(code: string): Promise<CurrencyRow | null> {
    const rows = await this.db
      .select()
      .from(currencies)
      .where(eq(currencies.code, code.toUpperCase().trim()))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertCurrency(values: typeof currencies.$inferInsert): Promise<CurrencyRow> {
    const [row] = await this.db
      .insert(currencies)
      .values(values)
      .onConflictDoUpdate({ target: currencies.code, set: { ...values, updatedAt: new Date() } })
      .returning();
    return row!;
  }

  async updateCurrency(code: string, patch: Partial<CurrencyRow>): Promise<CurrencyRow | null> {
    const [row] = await this.db
      .update(currencies)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(currencies.code, code))
      .returning();
    return row ?? null;
  }

  async deleteCurrency(code: string): Promise<boolean> {
    const rows = await this.db
      .delete(currencies)
      .where(eq(currencies.code, code.toUpperCase().trim()))
      .returning();
    return rows.length > 0;
  }

  async setBaseCurrency(code: string): Promise<void> {
    const upper = code.toUpperCase().trim();
    await this.db
      .update(currencies)
      .set({ isBaseCurrency: false, updatedAt: new Date() })
      .where(sql`${currencies.code} <> ${upper}`);
    await this.db
      .update(currencies)
      .set({ isBaseCurrency: true, updatedAt: new Date() })
      .where(eq(currencies.code, upper));
  }

  // ── Products ──────────────────────────────────────────────────────────────

  private productQuery() {
    return this.db
      .select({ ...getTableColumns(products), ...productRelations })
      .from(products)
      .leftJoin(itemTypes, eq(products.itemTypeId, itemTypes.id))
      .leftJoin(taxCategories, eq(products.taxCategoryId, taxCategories.id))
      .leftJoin(categories, eq(products.categoryId, categories.id));
  }

  async listProducts(): Promise<ProductJoined[]> {
    return this.productQuery().where(isNull(products.deletedAt)).orderBy(asc(products.name));
  }

  async listActiveSellableProducts(): Promise<ProductJoined[]> {
    return this.productQuery()
      .where(
        and(eq(products.isActive, true), eq(products.isSellable, true), isNull(products.deletedAt)),
      )
      .orderBy(asc(products.name));
  }

  async listLowStock(): Promise<ProductJoined[]> {
    return this.productQuery()
      .where(
        and(
          isNull(products.deletedAt),
          sql`${products.stockQuantity} - ${products.reservedQuantity} <= ${products.lowStockThreshold}`,
        ),
      )
      .orderBy(asc(products.name));
  }

  async getProductById(id: string): Promise<ProductJoined | null> {
    const rows = await this.productQuery()
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getProductBySlug(slug: string): Promise<ProductJoined | null> {
    const rows = await this.productQuery()
      .where(and(eq(products.slug, slug), isNull(products.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getProductsByIds(ids: string[]): Promise<ProductJoined[]> {
    if (ids.length === 0) return [];
    return this.productQuery().where(and(inArray(products.id, ids), isNull(products.deletedAt)));
  }

  async getProductBySku(sku: string): Promise<ProductJoined | null> {
    const rows = await this.productQuery()
      .where(and(eq(products.sku, sku), isNull(products.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getProductByStockCode(stockCode: string): Promise<ProductJoined | null> {
    const rows = await this.productQuery()
      .where(and(eq(products.stockCode, stockCode), isNull(products.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertProduct(values: typeof products.$inferInsert): Promise<ProductRow> {
    const [row] = await this.db.insert(products).values(values).returning();
    return row!;
  }

  async updateProduct(id: string, patch: Partial<ProductRow>): Promise<ProductJoined | null> {
    await this.db
      .update(products)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(products.id, id));
    return this.getProductById(id);
  }


  // ── Inventory movements ───────────────────────────────────────────────────

  async listMovements(limit = 100): Promise<InventoryMovementRow[]> {
    return this.db
      .select()
      .from(inventoryMovements)
      .orderBy(sql`${inventoryMovements.createdAt} desc`)
      .limit(limit);
  }

  async insertMovement(values: typeof inventoryMovements.$inferInsert): Promise<InventoryMovementRow> {
    const [row] = await this.db.insert(inventoryMovements).values(values).returning();
    return row!;
  }

  /** Idempotency probe: has this order's reservation already been settled? */
  async hasSettlementMovement(
    referenceId: string,
    changeTypes: string[],
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.referenceId, referenceId),
          inArray(inventoryMovements.changeType, changeTypes),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async countMovementsForReference(referenceId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.referenceId, referenceId));
    return Number(row?.value ?? 0);
  }
}

/**
 * Gateway transaction records, reconciliation outcomes and gateway toggles.
 *
 * Grouped here rather than split across three repositories because they are all
 * part of the same legacy payment surface and are always read together by the
 * reconciliation screen.
 */
export class PaymentRecordsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listTransactions(): Promise<PaymentTransactionRow[]> {
    return this.db
      .select()
      .from(paymentTransactions)
      .orderBy(sql`${paymentTransactions.createdAt} desc`);
  }

  async getTransactionById(id: string): Promise<PaymentTransactionRow | null> {
    const rows = await this.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** First match by provider reference, then by our own id — mirrors the old
   *  `Array.from(db.transactions.values()).find(...)` lookups. */
  async findTransaction(
    match: { id?: string; transactionReference?: string; externalReference?: string },
  ): Promise<PaymentTransactionRow | null> {
    if (match.id) {
      const byId = await this.getTransactionById(match.id);
      if (byId) return byId;
    }
    if (match.externalReference) {
      const byExternal = await this.db
        .select()
        .from(paymentTransactions)
        .where(eq(paymentTransactions.externalReference, match.externalReference))
        .orderBy(sql`${paymentTransactions.createdAt} desc`)
        .limit(1);
      if (byExternal[0]) return byExternal[0];
    }
    if (match.transactionReference) {
      const rows = await this.db
        .select()
        .from(paymentTransactions)
        .where(eq(paymentTransactions.transactionReference, match.transactionReference))
        .orderBy(sql`${paymentTransactions.createdAt} desc`)
        .limit(1);
      return rows[0] ?? null;
    }
    return null;
  }

  async upsertTransaction(
    values: typeof paymentTransactions.$inferInsert,
  ): Promise<PaymentTransactionRow> {
    const [row] = await this.db
      .insert(paymentTransactions)
      .values(values)
      .onConflictDoUpdate({
        target: paymentTransactions.id,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async updateTransaction(
    id: string,
    patch: Partial<PaymentTransactionRow>,
  ): Promise<PaymentTransactionRow | null> {
    const [row] = await this.db
      .update(paymentTransactions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(paymentTransactions.id, id))
      .returning();
    return row ?? null;
  }

  async listReconciliationLogs(): Promise<ReconciliationLogRow[]> {
    return this.db
      .select()
      .from(reconciliationLogs)
      .orderBy(sql`${reconciliationLogs.createdAt} desc`);
  }

  async insertReconciliationLog(
    values: typeof reconciliationLogs.$inferInsert,
  ): Promise<ReconciliationLogRow> {
    const [row] = await this.db.insert(reconciliationLogs).values(values).returning();
    return row!;
  }

  async getReconciliationLogById(id: string): Promise<ReconciliationLogRow | null> {
    const rows = await this.db
      .select()
      .from(reconciliationLogs)
      .where(eq(reconciliationLogs.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateReconciliationLog(
    id: string,
    patch: Partial<ReconciliationLogRow>,
  ): Promise<ReconciliationLogRow | null> {
    const [row] = await this.db
      .update(reconciliationLogs)
      .set(patch)
      .where(eq(reconciliationLogs.id, id))
      .returning();
    return row ?? null;
  }

  async listGatewayConfigs(): Promise<PaymentGatewayConfigRow[]> {
    return this.db.select().from(paymentGatewayConfigs).orderBy(asc(paymentGatewayConfigs.name));
  }

  async getGatewayConfig(id: string): Promise<PaymentGatewayConfigRow | null> {
    const rows = await this.db
      .select()
      .from(paymentGatewayConfigs)
      .where(eq(paymentGatewayConfigs.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Insert a new integration audit log entry. */
  async insertAuditLog(
    values: typeof integrationAuditLog.$inferInsert,
  ): Promise<IntegrationAuditLogRow> {
    const [row] = await this.db.insert(integrationAuditLog).values(values).returning();
    return row!;
  }

  /** Update an integration audit log entry (partial). */
  async updateAuditLog(
    id: string,
    patch: Partial<IntegrationAuditLogRow>,
  ): Promise<IntegrationAuditLogRow | null> {
    const [row] = await this.db
      .update(integrationAuditLog)
      .set(patch)
      .where(eq(integrationAuditLog.id, id))
      .returning();
    return row ?? null;
  }

  /** Fetch an audit log by ID. */
  async getAuditLogById(id: string): Promise<IntegrationAuditLogRow | null> {
    const rows = await this.db
      .select()
      .from(integrationAuditLog)
      .where(eq(integrationAuditLog.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertGatewayConfig(
    values: typeof paymentGatewayConfigs.$inferInsert,
  ): Promise<PaymentGatewayConfigRow> {
    const [row] = await this.db
      .insert(paymentGatewayConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: paymentGatewayConfigs.id,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }
}

export type { ProductJoined };
