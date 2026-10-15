import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { has, required } from '@/lib/values';
import { afterCursor, matching, pageOf, PAGE_SIZE, searchText, type PageInput } from '@/server/domains/settings/paging';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  dimensions,
  dimensionValues,
  dimensionSetEntries,
  type DimensionRow,
  type DimensionValueRow,
} from '@/server/db/drizzle/schema';


export class DimensionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByCompany(companyId: string): Promise<DimensionRow[]> {
    return await this.db
      .select()
      .from(dimensions)
      .where(eq(dimensions.companyId, companyId))
      .orderBy(asc(dimensions.dimensionNo), asc(dimensions.code));
  }

  /** One page of the company's dimensions in code order, optionally narrowed by text. */
  async pageByCompany(companyId: string, input: PageInput) {
    const rows = await this.db
      .select()
      .from(dimensions)
      .where(and(eq(dimensions.companyId, companyId), matching(searchText(input), [dimensions.code, dimensions.name]), afterCursor(input.cursor, dimensions.code, dimensions.id)))
      .orderBy(asc(dimensions.code), asc(dimensions.id))
      .limit(PAGE_SIZE + 1);
    return pageOf(rows, PAGE_SIZE, (r) => ({ k: r.code, id: r.id }));
  }

  /** The codes of these dimensions, by id (for showing a parent's name without loading the list). */
  async codesOf(ids: string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const rows = await this.db.select({ id: dimensions.id, code: dimensions.code }).from(dimensions).where(inArray(dimensions.id, ids));
    return Object.fromEntries(rows.map((r) => [r.id, r.code]));
  }

  async getById(id: string): Promise<DimensionRow | null> {
    const rows = await this.db.select().from(dimensions).where(eq(dimensions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getByCode(companyId: string, code: string): Promise<DimensionRow | null> {
    const rows = await this.db
      .select()
      .from(dimensions)
      .where(and(eq(dimensions.companyId, companyId), eq(dimensions.code, code)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getByOptionString(
    companyId: string,
    optionString: string,
  ): Promise<DimensionRow | null> {
    const rows = await this.db
      .select()
      .from(dimensions)
      .where(
        and(eq(dimensions.companyId, companyId), eq(dimensions.optionString, optionString)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getByDimensionNo(
    companyId: string,
    dimensionNo: number,
  ): Promise<DimensionRow | null> {
    const rows = await this.db
      .select()
      .from(dimensions)
      .where(
        and(eq(dimensions.companyId, companyId), eq(dimensions.dimensionNo, dimensionNo)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(values: typeof dimensions.$inferInsert): Promise<DimensionRow> {
    const [row] = await this.db.insert(dimensions).values(values).returning();
    return required(row, 'the saved dimension');
  }

  async update(
    id: string,
    patch: Partial<typeof dimensions.$inferInsert>,
  ): Promise<DimensionRow | null> {
    const [row] = await this.db
      .update(dimensions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(dimensions.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(dimensions).where(eq(dimensions.id, id));
  }

  async listValues(dimensionId: string): Promise<DimensionValueRow[]> {
    return await this.db
      .select()
      .from(dimensionValues)
      .where(eq(dimensionValues.dimensionId, dimensionId))
      .orderBy(asc(dimensionValues.code));
  }

  /** One page of a dimension's values in code order, optionally narrowed by text. */
  async pageValues(dimensionId: string, input: PageInput) {
    const rows = await this.db
      .select()
      .from(dimensionValues)
      .where(and(eq(dimensionValues.dimensionId, dimensionId), matching(searchText(input), [dimensionValues.code, dimensionValues.name]), afterCursor(input.cursor, dimensionValues.code, dimensionValues.id)))
      .orderBy(asc(dimensionValues.code), asc(dimensionValues.id))
      .limit(PAGE_SIZE + 1);
    return pageOf(rows, PAGE_SIZE, (r) => ({ k: r.code, id: r.id }));
  }

  /** The code and name of these values, by id. */
  async valueLabels(ids: string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const rows = await this.db.select({ id: dimensionValues.id, code: dimensionValues.code, name: dimensionValues.name }).from(dimensionValues).where(inArray(dimensionValues.id, ids));
    return Object.fromEntries(rows.map((r) => [r.id, `${r.code} — ${r.name}`]));
  }

  async getValueById(id: string): Promise<DimensionValueRow | null> {
    const rows = await this.db
      .select()
      .from(dimensionValues)
      .where(eq(dimensionValues.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertValue(values: typeof dimensionValues.$inferInsert): Promise<DimensionValueRow> {
    const [row] = await this.db.insert(dimensionValues).values(values).returning();
    return required(row, 'the saved dimension');
  }

  async updateValue(
    id: string,
    patch: Partial<typeof dimensionValues.$inferInsert>,
  ): Promise<DimensionValueRow | null> {
    const [row] = await this.db
      .update(dimensionValues)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(dimensionValues.id, id))
      .returning();
    return row ?? null;
  }

  async deleteValue(id: string): Promise<void> {
    await this.db.delete(dimensionValues).where(eq(dimensionValues.id, id));
  }

  async syncDimensionCodeOnValues(dimensionId: string, dimensionCode: string): Promise<void> {
    await this.db
      .update(dimensionValues)
      .set({ dimensionCode, updatedAt: new Date() })
      .where(eq(dimensionValues.dimensionId, dimensionId));
  }

  async countSetEntriesForDimension(dimensionId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(dimensionSetEntries)
      .where(eq(dimensionSetEntries.dimensionId, dimensionId));
    return rows[0]?.n ?? 0;
  }

  async countSetEntriesForValue(dimensionValueId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(dimensionSetEntries)
      .where(eq(dimensionSetEntries.dimensionValueId, dimensionValueId));
    return rows[0]?.n ?? 0;
  }

  async countChildDimensions(parentId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(dimensions)
      .where(eq(dimensions.parentId, parentId));
    return rows[0]?.n ?? 0;
  }

  async countChildValues(parentValueId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(dimensionValues)
      .where(eq(dimensionValues.parentId, parentValueId));
    return rows[0]?.n ?? 0;
  }

  async wouldCreateDimensionCycle(
    companyId: string,
    dimensionId: string,
    parentId: string | null,
  ): Promise<boolean> {
    if (!has(parentId)) return false;
    if (parentId === dimensionId) return true;
    let current: string | null = parentId;
    const seen = new Set<string>([dimensionId]);
    while (has(current)) {
      if (seen.has(current)) return true;
      seen.add(current);
      const row = await this.getById(current);
      if (row?.companyId !== companyId) return true;
      current = row.parentId;
    }
    return false;
  }

  async wouldCreateValueCycle(valueId: string, parentId: string | null): Promise<boolean> {
    if (!has(parentId)) return false;
    if (parentId === valueId) return true;
    let current: string | null = parentId;
    const seen = new Set<string>([valueId]);
    while (has(current)) {
      if (seen.has(current)) return true;
      seen.add(current);
      const row = await this.getValueById(current);
      if (!row) return true;
      current = row.parentId;
    }
    return false;
  }
}
