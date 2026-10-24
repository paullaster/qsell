import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vendorDocumentTypes, vendorDocuments, vendorEvents, vendors } from '@/server/db/drizzle/schema';
import { has } from '@/lib/values';
import { daysUntil, reminderDue } from '@/lib/vendor-schedule';
import type { VendorNotifier } from './notifier';

const BATCH = 500;

export interface ExpiryRun {
  expired: number;
  reminded: number;
}

export interface ExpiringFilter {
  /** Only documents that expire within this many days (already expired ones are always included). */
  withinDays?: number;
  before?: { expiresOn: string; id: string } | null;
  limit?: number;
}

/**
 * Keeps documents honest (design doc §6.5): the day after a document's expiry date it is marked expired, and the vendor (and,
 * close to the date, the buyer) is reminded at the days the document type asks for, each reminder once. An expired document never
 * silently stays valid, and an approved vendor is never silently dropped: the buyer sees it in the expiring-documents list.
 */
export class VendorExpiryService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly notify?: VendorNotifier,
  ) {}

  /** `today` is the business date (YYYY-MM-DD), passed in so a run is repeatable. */
  async run(today: string): Promise<ExpiryRun> {
    const expired = await this.markExpired(today);
    const reminded = await this.sendReminders(today);
    return { expired, reminded };
  }

  private async markExpired(today: string): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.db.transaction(async (tx) => {
        const due = await tx
          .select({ id: vendorDocuments.id, vendorId: vendorDocuments.vendorId, expiresOn: vendorDocuments.expiresOn, typeName: vendorDocumentTypes.name })
          .from(vendorDocuments)
          .innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, vendorDocuments.documentTypeId))
          .where(and(inArray(vendorDocuments.status, ['submitted', 'valid']), lt(vendorDocuments.expiresOn, today)))
          .orderBy(asc(vendorDocuments.expiresOn))
          .limit(BATCH)
          .for('update', { of: vendorDocuments, skipLocked: true });
        if (due.length === 0) return [];
        await tx.update(vendorDocuments).set({ status: 'expired' }).where(inArray(vendorDocuments.id, due.map((d) => d.id)));
        await tx.insert(vendorEvents).values(due.map((d) => ({ vendorId: d.vendorId, event: 'document_expired', data: { documentId: d.id, type: d.typeName, expiresOn: d.expiresOn }, actorType: 'job', actorId: null, origin: { job: 'vendor-document-expiry' } })));
        return due;
      });
      for (const d of batch) await this.notify?.documentExpired(d.vendorId, d.typeName, d.expiresOn ?? '');
      total += batch.length;
      if (batch.length < BATCH) return total;
    }
  }

  private async sendReminders(today: string): Promise<number> {
    const rows = await this.db
      .select({ id: vendorDocuments.id, vendorId: vendorDocuments.vendorId, expiresOn: vendorDocuments.expiresOn, last: vendorDocuments.lastReminderDay, typeName: vendorDocumentTypes.name, days: vendorDocumentTypes.reminderDays })
      .from(vendorDocuments)
      .innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, vendorDocuments.documentTypeId))
      .innerJoin(vendors, eq(vendors.id, vendorDocuments.vendorId))
      .where(and(inArray(vendorDocuments.status, ['submitted', 'valid']), sql`${vendorDocuments.expiresOn} IS NOT NULL`, inArray(vendors.status, ['active', 'suspended']), sql`${vendorDocuments.expiresOn} <= (${today}::date + 90)`))
      .orderBy(asc(vendorDocuments.expiresOn))
      .limit(5000);
    let sent = 0;
    for (const r of rows) {
      if (r.expiresOn === null) continue;
      const left = daysUntil(today, r.expiresOn);
      const due = reminderDue(left, r.days, r.last);
      if (due === null) continue;
      const claimed = await this.db
        .update(vendorDocuments)
        .set({ lastReminderDay: due })
        .where(and(eq(vendorDocuments.id, r.id), r.last === null ? sql`${vendorDocuments.lastReminderDay} IS NULL` : eq(vendorDocuments.lastReminderDay, r.last)))
        .returning({ id: vendorDocuments.id });
      if (claimed.length === 0) continue;
      await this.db.insert(vendorEvents).values({ vendorId: r.vendorId, event: 'document_expiry_reminder', data: { documentId: r.id, type: r.typeName, expiresOn: r.expiresOn, daysLeft: left }, actorType: 'job', actorId: null, origin: { job: 'vendor-document-expiry' } });
      await this.notify?.documentExpiring(r.vendorId, r.typeName, r.expiresOn, left);
      sent += 1;
    }
    return sent;
  }

  /** Documents that are expired or expire soon, soonest first, a page at a time. Replaced documents are never listed. */
  async expiring(companyId: string, f: ExpiringFilter = {}, today: string) {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
    const within = Math.min(Math.max(f.withinDays ?? 60, 0), 365);
    const conds = [eq(vendors.companyId, companyId), inArray(vendorDocuments.status, ['submitted', 'valid', 'expired']), sql`${vendorDocuments.expiresOn} IS NOT NULL`, sql`${vendorDocuments.expiresOn} <= (${today}::date + ${within}::int)`, inArray(vendors.status, ['active', 'suspended'])];
    if (f.before) conds.push(sql`(${vendorDocuments.expiresOn}::text, ${vendorDocuments.id}::text) > (${f.before.expiresOn}, ${f.before.id})`);
    const found = await this.db
      .select({ id: vendorDocuments.id, vendorId: vendors.id, vendorName: vendors.legalName, vendorNumber: vendors.number, typeName: vendorDocumentTypes.name, blocking: vendorDocumentTypes.blocking, expiresOn: vendorDocuments.expiresOn, status: vendorDocuments.status })
      .from(vendorDocuments)
      .innerJoin(vendors, eq(vendors.id, vendorDocuments.vendorId))
      .innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, vendorDocuments.documentTypeId))
      .where(and(...conds))
      .orderBy(asc(vendorDocuments.expiresOn), asc(vendorDocuments.id))
      .limit(limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map((r) => ({ ...r, expiresOn: r.expiresOn ?? '', daysLeft: has(r.expiresOn) ? daysUntil(today, r.expiresOn) : 0 })),
      next: found.length > limit && last?.expiresOn != null ? { expiresOn: last.expiresOn, id: last.id } : null,
    };
  }
}
