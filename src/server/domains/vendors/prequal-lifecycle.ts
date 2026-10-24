import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { categoryDocuments, prequalEntries, procurementCategories, vendorDocumentTypes, vendorEvents } from '@/server/db/drizzle/schema';
import type { VendorNotifier } from './notifier';
import { heldDocumentTypes } from './prequal-service';

const BATCH = 500;
const DOC_PREFIX = 'document: ';

export interface Qualification {
  entryId: string;
  vendorId: string;
  categoryId: string;
  validUntil: string;
  maxOrderValue: string | null;
  conditionsNote: string | null;
}

/**
 * What keeps qualifications honest and what other modules ask (design doc §7.4–7.5): qualifications that pass their date
 * expire; one whose blocking document has expired is suspended until the vendor holds a good one again, with no staff action;
 * and `qualified` answers "may this vendor be invited or ordered from for this category?".
 */
export class PrequalLifecycle {
  constructor(
    private readonly db: DrizzleDb,
    private readonly notify?: VendorNotifier,
  ) {}

  private async log(vendorId: string, event: string, from: string, to: string, data: Record<string, unknown>): Promise<void> {
    await this.db.insert(vendorEvents).values({ vendorId, event, fromStatus: from, toStatus: to, data, actorType: 'job', actorId: null, origin: { job: 'prequalification-lifecycle' } });
  }

  async run(today: string): Promise<{ expired: number; suspended: number; restored: number }> {
    const expired = await this.expireDue(today);
    const { suspended, restored } = await this.syncDocumentBlocks(today);
    return { expired, suspended, restored };
  }

  private async expireDue(today: string): Promise<number> {
    let total = 0;
    for (;;) {
      const due = await this.db
        .update(prequalEntries)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(inArray(prequalEntries.id, sql`(SELECT id FROM prequal_entries WHERE status IN ('approved','suspended') AND valid_until < ${today}::date ORDER BY valid_until LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)`))
        .returning({ id: prequalEntries.id, vendorId: prequalEntries.vendorId, categoryId: prequalEntries.categoryId });
      for (const d of due) {
        const [c] = await this.db.select({ name: procurementCategories.name }).from(procurementCategories).where(eq(procurementCategories.id, d.categoryId));
        await this.log(d.vendorId, 'prequalification_expired', 'approved', 'expired', { entryId: d.id, category: c?.name });
        await this.notify?.prequalDecided(d.vendorId, c?.name ?? '', 'expired', null, null);
      }
      total += due.length;
      if (due.length < BATCH) return total;
    }
  }

  /** Suspends approved entries whose blocking documents are no longer held; restores those suspended for that reason once they are. */
  private async syncDocumentBlocks(today: string): Promise<{ suspended: number; restored: number }> {
    const rows = await this.db
      .select({ id: prequalEntries.id, vendorId: prequalEntries.vendorId, categoryId: prequalEntries.categoryId, status: prequalEntries.status, because: prequalEntries.suspendedBecause, categoryName: procurementCategories.name })
      .from(prequalEntries)
      .innerJoin(procurementCategories, eq(procurementCategories.id, prequalEntries.categoryId))
      .where(and(inArray(prequalEntries.status, ['approved', 'suspended']), sql`${prequalEntries.validUntil} >= ${today}::date`))
      .limit(5000);
    if (rows.length === 0) return { suspended: 0, restored: 0 };
    const blocking = await this.db
      .select({ categoryId: categoryDocuments.categoryId, typeId: vendorDocumentTypes.id, name: vendorDocumentTypes.name })
      .from(categoryDocuments)
      .innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, categoryDocuments.documentTypeId))
      .where(and(eq(vendorDocumentTypes.blocking, true), inArray(categoryDocuments.categoryId, [...new Set(rows.map((r) => r.categoryId))])));
    if (blocking.length === 0) return { suspended: 0, restored: 0 };
    const heldByVendor = new Map<string, Awaited<ReturnType<typeof heldDocumentTypes>>>();
    let suspended = 0;
    let restored = 0;
    for (const r of rows) {
      const needs = blocking.filter((b) => b.categoryId === r.categoryId);
      if (needs.length === 0) continue;
      if (!heldByVendor.has(r.vendorId)) heldByVendor.set(r.vendorId, await heldDocumentTypes(this.db, r.vendorId));
      const held = heldByVendor.get(r.vendorId);
      const lacking = needs.filter((n) => held?.has(n.typeId) !== true);
      if (r.status === 'approved' && lacking.length > 0) {
        const why = `${DOC_PREFIX}${lacking.map((l) => l.name).join(', ')}`;
        const done = await this.db.update(prequalEntries).set({ status: 'suspended', suspendedBecause: why, updatedAt: new Date() }).where(and(eq(prequalEntries.id, r.id), eq(prequalEntries.status, 'approved'))).returning({ id: prequalEntries.id });
        if (done.length > 0) {
          suspended += 1;
          await this.log(r.vendorId, 'prequalification_suspended', 'approved', 'suspended', { entryId: r.id, category: r.categoryName, because: why });
          await this.notify?.prequalDecided(r.vendorId, r.categoryName, 'suspended', why, null);
        }
      } else if (r.status === 'suspended' && (r.because ?? '').startsWith(DOC_PREFIX) && lacking.length === 0) {
        const done = await this.db.update(prequalEntries).set({ status: 'approved', suspendedBecause: null, updatedAt: new Date() }).where(and(eq(prequalEntries.id, r.id), eq(prequalEntries.status, 'suspended'))).returning({ id: prequalEntries.id });
        if (done.length > 0) {
          restored += 1;
          await this.log(r.vendorId, 'prequalification_reinstated', 'suspended', 'approved', { entryId: r.id, category: r.categoryName });
          await this.notify?.prequalDecided(r.vendorId, r.categoryName, 'reinstated', null, null);
        }
      }
    }
    return { suspended, restored };
  }

  /**
   * Vendors that may be invited for a category: qualified in it or in any category inside it, unexpired, and neither suspended,
   * archived nor blocked from new documents.
   */
  async qualifiedVendorIds(companyId: string, categoryId: string, today: string): Promise<string[]> {
    const rows = await this.db.execute<{ vendor_id: string }>(sql`
      WITH RECURSIVE tree AS (
        SELECT id FROM procurement_categories WHERE id = ${categoryId}::uuid AND company_id = ${companyId}::uuid
        UNION SELECT c.id FROM procurement_categories c JOIN tree t ON c.parent_id = t.id
      )
      SELECT DISTINCT e.vendor_id FROM prequal_entries e
      JOIN vendors v ON v.id = e.vendor_id
      WHERE e.company_id = ${companyId}::uuid AND e.category_id IN (SELECT id FROM tree)
        AND e.status = 'approved' AND e.valid_from <= ${today}::date AND e.valid_until >= ${today}::date
        AND v.status = 'active' AND v.block <> 'all'`);
    return [...rows].map((r) => r.vendor_id);
  }

  /** The vendor's standing qualification for a category (or one inside it), with its conditions, or null. */
  async qualificationOf(companyId: string, vendorId: string, categoryId: string, today: string): Promise<Qualification | null> {
    const rows = await this.db.execute<{ id: string; category_id: string; valid_until: string; max_order_value: string | null; conditions_note: string | null }>(sql`
      WITH RECURSIVE tree AS (
        SELECT id FROM procurement_categories WHERE id = ${categoryId}::uuid AND company_id = ${companyId}::uuid
        UNION SELECT c.id FROM procurement_categories c JOIN tree t ON c.parent_id = t.id
      )
      SELECT e.id, e.category_id, e.valid_until::text, e.max_order_value::text, e.conditions_note FROM prequal_entries e
      JOIN vendors v ON v.id = e.vendor_id
      WHERE e.company_id = ${companyId}::uuid AND e.vendor_id = ${vendorId}::uuid AND e.category_id IN (SELECT id FROM tree)
        AND e.status = 'approved' AND e.valid_from <= ${today}::date AND e.valid_until >= ${today}::date
        AND v.status = 'active' AND v.block <> 'all'
      ORDER BY e.valid_until DESC LIMIT 1`);
    const r = [...rows][0];
    return r === undefined ? null : { entryId: r.id, vendorId, categoryId: r.category_id, validUntil: r.valid_until, maxOrderValue: r.max_order_value, conditionsNote: r.conditions_note };
  }
}
