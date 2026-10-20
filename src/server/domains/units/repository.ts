import { and, asc, count, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { required } from '@/lib/values';
import { NO_USAGE, type UnitUsage } from '@/lib/unit-rules';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  inventoryMovements,
  orderItems,
  creditNoteLines,
  returnReceiptLines,
  priceListLines,
  productKitComponents,
  products,
  productUnits,
  salesQuoteLines,
  unitsOfMeasure,
  type ProductUnitRow,
  type UnitOfMeasureRow,
} from '@/server/db/drizzle/schema';
import {
  afterCursor,
  matching,
  pageOf,
  PAGE_SIZE,
  searchText,
  type PageInput,
} from '@/server/domains/settings/paging';

export interface UnitPageInput extends PageInput {
  kind?: string;
  status?: 'active' | 'inactive';
}

export interface ProductUnitWithUnit extends ProductUnitRow {
  unitCode: string;
  unitName: string;
  unitDecimals: number;
}

type Tx = Pick<DrizzleDb, 'select' | 'insert' | 'update' | 'delete'>;

export type PackagingRow = Omit<typeof productUnits.$inferInsert, 'productId' | 'id'>;

export class UnitRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** One page of units in code order, narrowed by text, family and whether they are switched on. */
  async page(input: UnitPageInput) {
    const conditions: (SQL | undefined)[] = [
      matching(searchText(input), [
        unitsOfMeasure.code,
        unitsOfMeasure.name,
        unitsOfMeasure.symbol,
      ]),
      input.kind === undefined ? undefined : eq(unitsOfMeasure.kind, input.kind),
      input.status === undefined
        ? undefined
        : eq(unitsOfMeasure.isActive, input.status === 'active'),
      afterCursor(input.cursor, unitsOfMeasure.code, unitsOfMeasure.id),
    ];
    const rows = await this.db
      .select()
      .from(unitsOfMeasure)
      .where(and(...conditions))
      .orderBy(asc(unitsOfMeasure.code), asc(unitsOfMeasure.id))
      .limit(PAGE_SIZE + 1);
    return pageOf(rows, PAGE_SIZE, (r) => ({ k: r.code, id: r.id }));
  }

  async getById(id: string, db: Tx = this.db): Promise<UnitOfMeasureRow | null> {
    const rows = await db.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getByIds(ids: string[]): Promise<UnitOfMeasureRow[]> {
    if (ids.length === 0) return [];
    return await this.db.select().from(unitsOfMeasure).where(inArray(unitsOfMeasure.id, ids));
  }

  async getDefault(): Promise<UnitOfMeasureRow | null> {
    const rows = await this.db
      .select()
      .from(unitsOfMeasure)
      .where(eq(unitsOfMeasure.isDefault, true))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(values: typeof unitsOfMeasure.$inferInsert): Promise<UnitOfMeasureRow> {
    const [row] = await this.db.insert(unitsOfMeasure).values(values).returning();
    return required(row, 'the saved unit');
  }

  /** Saves only when the unit is still at the version the person saw; null when it is gone or has moved on. */
  async update(
    id: string,
    version: number,
    patch: Partial<typeof unitsOfMeasure.$inferInsert>,
    db: Tx = this.db,
  ): Promise<UnitOfMeasureRow | null> {
    const [row] = await db
      .update(unitsOfMeasure)
      .set({ ...patch, version: version + 1, updatedAt: new Date() })
      .where(and(eq(unitsOfMeasure.id, id), eq(unitsOfMeasure.version, version)))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(unitsOfMeasure)
      .where(eq(unitsOfMeasure.id, id))
      .returning({ id: unitsOfMeasure.id });
    return rows.length > 0;
  }

  /** Makes this unit the one new products start with (and no other), as one step. */
  async makeDefault(id: string): Promise<UnitOfMeasureRow | null> {
    return await this.db.transaction(async (tx) => {
      await tx
        .update(unitsOfMeasure)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(unitsOfMeasure.isDefault, true), ne(unitsOfMeasure.id, id)));
      const [row] = await tx
        .update(unitsOfMeasure)
        .set({
          isDefault: true,
          updatedAt: new Date(),
          version: sql`${unitsOfMeasure.version} + 1`,
        })
        .where(and(eq(unitsOfMeasure.id, id), eq(unitsOfMeasure.isActive, true)))
        .returning();
      if (row === undefined) tx.rollback();
      return row ?? null;
    });
  }

  /** Where each of these units is used, for the whole page in a few queries (never one per row). */
  async usageOf(ids: string[]): Promise<Record<string, UnitUsage>> {
    const usage: Record<string, UnitUsage> = Object.fromEntries(
      ids.map((id) => [id, { ...NO_USAGE }]),
    );
    if (ids.length === 0) return usage;
    const [byProducts, byPackagings, byUnits, byQuoteLines, byOrderLines, byCreditLines, byReturnLines] = await Promise.all([
      this.db
        .select({ id: products.baseUnitId, n: count() })
        .from(products)
        .where(inArray(products.baseUnitId, ids))
        .groupBy(products.baseUnitId),
      this.db
        .select({ id: productUnits.unitId, n: count() })
        .from(productUnits)
        .where(inArray(productUnits.unitId, ids))
        .groupBy(productUnits.unitId),
      this.db
        .select({ id: unitsOfMeasure.baseUnitId, n: count() })
        .from(unitsOfMeasure)
        .where(inArray(unitsOfMeasure.baseUnitId, ids))
        .groupBy(unitsOfMeasure.baseUnitId),
      this.db
        .select({ id: salesQuoteLines.unitId, n: count() })
        .from(salesQuoteLines)
        .where(inArray(salesQuoteLines.unitId, ids))
        .groupBy(salesQuoteLines.unitId),
      this.db
        .select({ id: orderItems.unitId, n: count() })
        .from(orderItems)
        .where(inArray(orderItems.unitId, ids))
        .groupBy(orderItems.unitId),
      this.db
        .select({ id: creditNoteLines.unitId, n: count() })
        .from(creditNoteLines)
        .where(inArray(creditNoteLines.unitId, ids))
        .groupBy(creditNoteLines.unitId),
      this.db
        .select({ id: returnReceiptLines.unitId, n: count() })
        .from(returnReceiptLines)
        .where(inArray(returnReceiptLines.unitId, ids))
        .groupBy(returnReceiptLines.unitId),
    ]);
    const add = (id: string | null, change: Partial<UnitUsage>) => {
      if (id === null) return;
      const current = usage[id] ?? NO_USAGE;
      usage[id] = {
        products: current.products + (change.products ?? 0),
        packagings: current.packagings + (change.packagings ?? 0),
        derivedUnits: current.derivedUnits + (change.derivedUnits ?? 0),
        documentLines: current.documentLines + (change.documentLines ?? 0),
      };
    };
    for (const r of byProducts) add(r.id, { products: r.n });
    for (const r of byPackagings) add(r.id, { packagings: r.n });
    for (const r of byUnits) add(r.id, { derivedUnits: r.n });
    for (const r of [...byQuoteLines, ...byOrderLines, ...byCreditLines, ...byReturnLines]) add(r.id, { documentLines: r.n });
    return usage;
  }

  // ── Per product ───────────────────────────────────────────────────────────

  async packagingOf(productId: string): Promise<ProductUnitWithUnit[]> {
    const rows = await this.db
      .select({
        row: productUnits,
        unitCode: unitsOfMeasure.code,
        unitName: unitsOfMeasure.name,
        unitDecimals: unitsOfMeasure.decimals,
      })
      .from(productUnits)
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, productUnits.unitId))
      .where(eq(productUnits.productId, productId))
      .orderBy(asc(unitsOfMeasure.code));
    return rows.map((r) => ({
      ...r.row,
      unitCode: r.unitCode,
      unitName: r.unitName,
      unitDecimals: r.unitDecimals,
    }));
  }

  /** The alternate units of several products at once (never one query per product). */
  async packagingForProducts(productIds: string[]): Promise<ProductUnitWithUnit[]> {
    if (productIds.length === 0) return [];
    const rows = await this.db
      .select({
        row: productUnits,
        unitCode: unitsOfMeasure.code,
        unitName: unitsOfMeasure.name,
        unitDecimals: unitsOfMeasure.decimals,
      })
      .from(productUnits)
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, productUnits.unitId))
      .where(inArray(productUnits.productId, productIds));
    return rows.map((r) => ({
      ...r.row,
      unitCode: r.unitCode,
      unitName: r.unitName,
      unitDecimals: r.unitDecimals,
    }));
  }

  /** Replaces a product's packaging units inside the caller's transaction, so a product save is all or nothing. */
  async replacePackagingIn(tx: Tx, productId: string, rows: PackagingRow[]): Promise<void> {
    await tx.delete(productUnits).where(eq(productUnits.productId, productId));
    if (rows.length > 0)
      await tx.insert(productUnits).values(rows.map((r) => ({ ...r, productId })));
  }

  /** Whether quantities of this product were already recorded against its base unit, which would change meaning if the unit changed. */
  async hasQuantityHistory(productId: string): Promise<boolean> {
    const [moves, quoteLines, priceLines, kitParts, orderLines] = await Promise.all([
      this.db
        .select({ n: count() })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.productId, productId),
            sql`${inventoryMovements.referenceId} IS DISTINCT FROM 'PRODUCT_CREATION'`,
          ),
        ),
      this.db
        .select({ n: count() })
        .from(salesQuoteLines)
        .where(eq(salesQuoteLines.productId, productId)),
      this.db
        .select({ n: count() })
        .from(priceListLines)
        .where(eq(priceListLines.productId, productId)),
      this.db
        .select({ n: count() })
        .from(productKitComponents)
        .where(eq(productKitComponents.productId, productId)),
      this.db.select({ n: count() }).from(orderItems).where(eq(orderItems.productId, productId)),
    ]);
    return [moves, quoteLines, priceLines, kitParts, orderLines].some((r) => (r[0]?.n ?? 0) > 0);
  }
}
