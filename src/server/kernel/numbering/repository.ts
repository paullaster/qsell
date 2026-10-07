import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  branches,
  numberSeries,
  numberSeriesAllocations,
  numberSeriesBindings,
  numberSeriesCounters,
  numberSeriesLines,
  numberSeriesRelationships,
  type NumberSeriesAllocationRow,
  type NumberSeriesBindingRow,
  type NumberSeriesCounterRow,
  type NumberSeriesLineRow,
  type NumberSeriesRow,
} from '@/server/db/drizzle/schema';

/** The database or a transaction on it: every method works in either. */
export type Executor = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface LineWithBranch {
  line: NumberSeriesLineRow;
  branchCode: string | null;
}

export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** All Drizzle access for number series. Contains no rules; the service decides. */
export interface BranchRef {
  id: string;
  code: string;
  companyId: string;
}

export const seriesRepo = {
  /** The company's default branch (else its oldest), for fiscal series that number per branch. */
  async defaultBranchRef(ex: Executor, companyId: string): Promise<BranchRef | null> {
    const [row] = await ex
      .select({ id: branches.id, code: branches.code, companyId: branches.companyId })
      .from(branches)
      .where(and(eq(branches.companyId, companyId), eq(branches.isActive, true)))
      .orderBy(desc(branches.isDefault), branches.createdAt)
      .limit(1);
    return row ?? null;
  },

  /** Reads the branch through the caller's own connection, so numbering never needs a second one. */
  async branchRef(ex: Executor, id: string): Promise<BranchRef | null> {
    const [row] = await ex
      .select({ id: branches.id, code: branches.code, companyId: branches.companyId })
      .from(branches)
      .where(eq(branches.id, id))
      .limit(1);
    return row ?? null;
  },

  async seriesByCode(
    ex: Executor,
    companyId: string,
    code: string,
  ): Promise<NumberSeriesRow | null> {
    const [row] = await ex
      .select()
      .from(numberSeries)
      .where(and(eq(numberSeries.companyId, companyId), eq(numberSeries.code, code)))
      .limit(1);
    return row ?? null;
  },

  async seriesById(ex: Executor, companyId: string, id: string): Promise<NumberSeriesRow | null> {
    const [row] = await ex
      .select()
      .from(numberSeries)
      .where(and(eq(numberSeries.companyId, companyId), eq(numberSeries.id, id)))
      .limit(1);
    return row ?? null;
  },

  async listSeries(ex: Executor, companyId: string): Promise<NumberSeriesRow[]> {
    return ex
      .select()
      .from(numberSeries)
      .where(eq(numberSeries.companyId, companyId))
      .orderBy(numberSeries.code);
  },

  async insertSeries(
    ex: Executor,
    values: typeof numberSeries.$inferInsert,
  ): Promise<NumberSeriesRow> {
    const [row] = await ex.insert(numberSeries).values(values).returning();
    return row!;
  },

  async updateSeries(
    ex: Executor,
    id: string,
    patch: Partial<NumberSeriesRow>,
  ): Promise<NumberSeriesRow> {
    const [row] = await ex
      .update(numberSeries)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(numberSeries.id, id))
      .returning();
    return row!;
  },

  async deleteSeries(ex: Executor, id: string): Promise<void> {
    await ex.delete(numberSeries).where(eq(numberSeries.id, id));
  },

  async lines(ex: Executor, seriesId: string): Promise<LineWithBranch[]> {
    const rows = await ex
      .select({ line: numberSeriesLines, branchCode: branches.code })
      .from(numberSeriesLines)
      .leftJoin(branches, eq(branches.id, numberSeriesLines.branchId))
      .where(eq(numberSeriesLines.seriesId, seriesId))
      .orderBy(numberSeriesLines.lineNo);
    return rows;
  },

  async lineById(ex: Executor, lineId: string): Promise<NumberSeriesLineRow | null> {
    const [row] = await ex
      .select()
      .from(numberSeriesLines)
      .where(eq(numberSeriesLines.id, lineId))
      .limit(1);
    return row ?? null;
  },

  async nextLineNo(ex: Executor, seriesId: string): Promise<number> {
    const [row] = await ex
      .select({ max: sql<number>`coalesce(max(${numberSeriesLines.lineNo}), 0)::int` })
      .from(numberSeriesLines)
      .where(eq(numberSeriesLines.seriesId, seriesId));
    return (row?.max ?? 0) + 10;
  },

  async insertLine(
    ex: Executor,
    values: typeof numberSeriesLines.$inferInsert,
  ): Promise<NumberSeriesLineRow> {
    const [row] = await ex.insert(numberSeriesLines).values(values).returning();
    return row!;
  },

  async updateLine(
    ex: Executor,
    id: string,
    patch: Partial<NumberSeriesLineRow>,
  ): Promise<NumberSeriesLineRow> {
    const [row] = await ex
      .update(numberSeriesLines)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(numberSeriesLines.id, id))
      .returning();
    return row!;
  },

  /** Has this line ever issued a number? Decides what may still be edited. */
  async lineHasIssued(ex: Executor, lineId: string): Promise<boolean> {
    const [row] = await ex
      .select({ id: numberSeriesAllocations.id })
      .from(numberSeriesAllocations)
      .where(eq(numberSeriesAllocations.lineId, lineId))
      .limit(1);
    if (row) return true;
    const [counter] = await ex
      .select({ id: numberSeriesCounters.id })
      .from(numberSeriesCounters)
      .where(eq(numberSeriesCounters.lineId, lineId))
      .limit(1);
    return Boolean(counter);
  },

  async seriesHasAllocations(ex: Executor, seriesId: string): Promise<boolean> {
    const [row] = await ex
      .select({ id: numberSeriesAllocations.id })
      .from(numberSeriesAllocations)
      .where(eq(numberSeriesAllocations.seriesId, seriesId))
      .limit(1);
    return Boolean(row);
  },

  // ── counters ──────────────────────────────────────────────────────────

  async ensureCounter(ex: Executor, lineId: string, periodKey: string): Promise<void> {
    await ex
      .insert(numberSeriesCounters)
      .values({ lineId, periodKey })
      .onConflictDoNothing({
        target: [numberSeriesCounters.lineId, numberSeriesCounters.periodKey],
      });
  },

  /** Takes the counter's row lock; held until the surrounding transaction ends. */
  async lockCounter(
    ex: Executor,
    lineId: string,
    periodKey: string,
  ): Promise<NumberSeriesCounterRow> {
    const [row] = await ex
      .select()
      .from(numberSeriesCounters)
      .where(
        and(eq(numberSeriesCounters.lineId, lineId), eq(numberSeriesCounters.periodKey, periodKey)),
      )
      .for('update')
      .limit(1);
    return row!;
  },

  async readCounter(
    ex: Executor,
    lineId: string,
    periodKey: string,
  ): Promise<NumberSeriesCounterRow | null> {
    const [row] = await ex
      .select()
      .from(numberSeriesCounters)
      .where(
        and(eq(numberSeriesCounters.lineId, lineId), eq(numberSeriesCounters.periodKey, periodKey)),
      )
      .limit(1);
    return row ?? null;
  },

  async countersForLines(ex: Executor, lineIds: string[]): Promise<NumberSeriesCounterRow[]> {
    if (lineIds.length === 0) return [];
    return ex
      .select()
      .from(numberSeriesCounters)
      .where(inArray(numberSeriesCounters.lineId, lineIds))
      .orderBy(desc(numberSeriesCounters.periodKey));
  },

  async updateCounter(
    ex: Executor,
    id: string,
    patch: Partial<NumberSeriesCounterRow>,
  ): Promise<void> {
    await ex
      .update(numberSeriesCounters)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(numberSeriesCounters.id, id));
  },

  // ── allocations ───────────────────────────────────────────────────────

  /** Inserts the allocation; returns null if the number (or the document) already has one. */
  async insertAllocation(
    ex: Executor,
    values: typeof numberSeriesAllocations.$inferInsert,
  ): Promise<NumberSeriesAllocationRow | null> {
    const [row] = await ex
      .insert(numberSeriesAllocations)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  },

  async allocationForDocument(
    ex: Executor,
    companyId: string,
    kind: string,
    id: string,
  ): Promise<NumberSeriesAllocationRow | null> {
    const [row] = await ex
      .select()
      .from(numberSeriesAllocations)
      .where(
        and(
          eq(numberSeriesAllocations.companyId, companyId),
          eq(numberSeriesAllocations.documentKind, kind),
          eq(numberSeriesAllocations.documentId, id),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async allocationByNumber(
    ex: Executor,
    seriesId: string,
    number: string,
  ): Promise<NumberSeriesAllocationRow | null> {
    const [row] = await ex
      .select()
      .from(numberSeriesAllocations)
      .where(
        and(
          eq(numberSeriesAllocations.seriesId, seriesId),
          eq(numberSeriesAllocations.number, number),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async recentAllocations(
    ex: Executor,
    seriesId: string,
    limit: number,
  ): Promise<NumberSeriesAllocationRow[]> {
    return ex
      .select()
      .from(numberSeriesAllocations)
      .where(eq(numberSeriesAllocations.seriesId, seriesId))
      .orderBy(desc(numberSeriesAllocations.allocatedAt))
      .limit(limit);
  },

  // ── bindings and relationships ────────────────────────────────────────

  async binding(
    ex: Executor,
    companyId: string,
    kind: string,
    branchId: string | null,
  ): Promise<NumberSeriesBindingRow | null> {
    const [row] = await ex
      .select()
      .from(numberSeriesBindings)
      .where(
        and(
          eq(numberSeriesBindings.companyId, companyId),
          eq(numberSeriesBindings.documentKind, kind),
          branchId === null
            ? isNull(numberSeriesBindings.branchId)
            : eq(numberSeriesBindings.branchId, branchId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async bindings(ex: Executor, companyId: string): Promise<NumberSeriesBindingRow[]> {
    return ex
      .select()
      .from(numberSeriesBindings)
      .where(eq(numberSeriesBindings.companyId, companyId));
  },

  async bindingsForSeries(ex: Executor, seriesId: string): Promise<NumberSeriesBindingRow[]> {
    return ex
      .select()
      .from(numberSeriesBindings)
      .where(eq(numberSeriesBindings.seriesId, seriesId));
  },

  async insertBinding(
    ex: Executor,
    values: typeof numberSeriesBindings.$inferInsert,
  ): Promise<void> {
    await ex.insert(numberSeriesBindings).values(values);
  },

  async updateBindingSeries(ex: Executor, id: string, seriesId: string): Promise<void> {
    await ex.update(numberSeriesBindings).set({ seriesId }).where(eq(numberSeriesBindings.id, id));
  },

  async deleteBinding(ex: Executor, id: string): Promise<void> {
    await ex.delete(numberSeriesBindings).where(eq(numberSeriesBindings.id, id));
  },

  async relationships(ex: Executor, seriesId: string) {
    return ex
      .select()
      .from(numberSeriesRelationships)
      .where(eq(numberSeriesRelationships.seriesId, seriesId));
  },

  async addRelationship(ex: Executor, seriesId: string, relatedSeriesId: string): Promise<void> {
    await ex
      .insert(numberSeriesRelationships)
      .values({ seriesId, relatedSeriesId })
      .onConflictDoNothing();
  },

  async removeRelationship(ex: Executor, seriesId: string, relatedSeriesId: string): Promise<void> {
    await ex
      .delete(numberSeriesRelationships)
      .where(
        and(
          eq(numberSeriesRelationships.seriesId, seriesId),
          eq(numberSeriesRelationships.relatedSeriesId, relatedSeriesId),
        ),
      );
  },
};
