import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vendorLedgerEntries, vendors } from '@/server/db/drizzle/schema';
import { has } from '@/lib/values';
import { AGE_BUCKETS, toCents, type AgeBucket } from '@/lib/vendor-payment';

/**
 * What we owe, from the vendor ledger (design doc §12.8): payables ageing by due date, and a vendor's statement. The ledger is the
 * only source, so these figures agree with what was booked and paid. Amounts are cents in the base currency; other currencies
 * are not booked yet.
 */
export class PayablesReportService {
  constructor(private readonly db: DrizzleDb) {}

  async ageing(companyId: string, asOf: string) {
    const days = sql`(${asOf}::date - COALESCE(${vendorLedgerEntries.dueDate}, ${vendorLedgerEntries.postingDate}))`;
    const amount = (cond: ReturnType<typeof sql>) => sql<string>`COALESCE(SUM(CASE WHEN ${vendorLedgerEntries.documentType} = 'invoice' AND ${vendorLedgerEntries.remainingAmount} > 0 AND ${cond} THEN ${vendorLedgerEntries.remainingAmount} ELSE 0 END), 0)::text`;
    const rows = await this.db
      .select({
        vendorId: vendors.id,
        name: vendors.legalName,
        number: vendors.number,
        currency: vendorLedgerEntries.currency,
        not_due: amount(sql`${days} <= 0`),
        d1_30: amount(sql`${days} BETWEEN 1 AND 30`),
        d31_60: amount(sql`${days} BETWEEN 31 AND 60`),
        d61_90: amount(sql`${days} BETWEEN 61 AND 90`),
        d90_plus: amount(sql`${days} > 90`),
        unapplied: sql<string>`COALESCE(SUM(CASE WHEN ${vendorLedgerEntries.remainingAmount} < 0 THEN ${vendorLedgerEntries.remainingAmount} ELSE 0 END), 0)::text`,
      })
      .from(vendorLedgerEntries)
      .innerJoin(vendors, eq(vendors.id, vendorLedgerEntries.vendorId))
      .where(and(eq(vendorLedgerEntries.companyId, companyId), sql`${vendorLedgerEntries.remainingAmount} <> 0`))
      .groupBy(vendors.id, vendors.legalName, vendors.number, vendorLedgerEntries.currency)
      .orderBy(asc(vendors.legalName));
    const lines = rows.map((r) => {
      const buckets = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, toCents(r[b.key])])) as Record<AgeBucket, number>;
      const owed = Object.values(buckets).reduce((s, c) => s + c, 0);
      const unapplied = toCents(r.unapplied);
      return { vendorId: r.vendorId, name: r.name, number: r.number, currency: r.currency, buckets, owedCents: owed, unappliedCents: unapplied, netCents: owed + unapplied };
    });
    const totals = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, lines.reduce((s, l) => s + l.buckets[b.key], 0)])) as Record<AgeBucket, number>;
    return { asOf, lines, totals, owedCents: lines.reduce((s, l) => s + l.owedCents, 0), unappliedCents: lines.reduce((s, l) => s + l.unappliedCents, 0) };
  }

  /** A vendor's entries, newest first, with what is still open on each. */
  async statement(companyId: string, vendorId: string, range: { from?: string; to?: string } = {}, limit = 200) {
    const [v] = await this.db.select({ id: vendors.id, name: vendors.legalName, number: vendors.number }).from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, vendorId)));
    if (v === undefined) return null;
    const conds = [eq(vendorLedgerEntries.companyId, companyId), eq(vendorLedgerEntries.vendorId, vendorId)];
    if (has(range.from)) conds.push(gte(vendorLedgerEntries.postingDate, range.from));
    if (has(range.to)) conds.push(lte(vendorLedgerEntries.postingDate, range.to));
    const entries = await this.db
      .select()
      .from(vendorLedgerEntries)
      .where(and(...conds))
      .orderBy(desc(vendorLedgerEntries.postingDate), desc(vendorLedgerEntries.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    const [open] = await this.db
      .select({ owed: sql<string>`COALESCE(SUM(${vendorLedgerEntries.remainingAmount}), 0)::text` })
      .from(vendorLedgerEntries)
      .where(and(eq(vendorLedgerEntries.companyId, companyId), eq(vendorLedgerEntries.vendorId, vendorId)));
    return {
      vendor: v,
      balance: open?.owed ?? '0',
      entries: entries.map((e) => ({ id: e.id, documentType: e.documentType, documentNo: e.documentNo, externalNo: e.externalDocumentNo, postingDate: e.postingDate, dueDate: e.dueDate, amount: e.amount, remaining: e.remainingAmount, currency: e.currency })),
    };
  }
}
