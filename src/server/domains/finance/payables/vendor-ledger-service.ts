import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vendorDetailedEntries, vendorLedgerEntries, type VendorLedgerDocumentType } from '@/server/db/drizzle/schema';
import { has } from '@/lib/values';
import { fromCents, toCents } from '../domain/receivables';
import type { Tx } from '../engine';
import { FinanceError } from '../errors';

export type Writer = DrizzleDb | Tx;

export interface NewVendorEntry {
  companyId: string;
  vendorId: string;
  documentType: VendorLedgerDocumentType;
  /** Give the entry this id so a record made at the same moment can point at it. */
  id?: string;
  documentNo: string;
  /** The vendor's own number (their invoice number): one invoice number can be booked once per vendor. */
  externalDocumentNo?: string | null;
  documentId?: string | null;
  description?: string | null;
  /** Signed: positive when we owe the vendor (invoices, refunds received), negative for payments, credits and advances paid. */
  amountCents: number;
  currency: string;
  postingDate: string;
  documentDate?: string | null;
  dueDate?: string | null;
  registerId?: string | null;
  idempotencyKey?: string | null;
  createdBy?: string | null;
}

/**
 * The vendor sub-ledger (docs/architecture/vendor-management-module.md §12.2). An entry is posted once and never edited:
 * what is still open on it changes only through detailed entries, written in the same transaction as the remaining
 * amount they change. Both tables refuse updates and deletes in the database (apart from the remaining amount).
 * Applications, unapplications, discounts and exchange differences are added with the payment slice (V-7).
 */
export class VendorLedgerService {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Adds a ledger entry and its opening detailed entry; returns the entry id. A second call with the same idempotency
   * key returns the first entry's id and writes nothing, so a retried posting cannot double a liability.
   */
  async addEntry(tx: Writer, e: NewVendorEntry): Promise<{ id: string; replayed: boolean }> {
    if (e.amountCents === 0) throw new FinanceError('AMOUNT_INVALID', 'A vendor ledger entry needs an amount.');
    if (has(e.idempotencyKey)) {
      const [existing] = await tx
        .select({ id: vendorLedgerEntries.id })
        .from(vendorLedgerEntries)
        .where(and(eq(vendorLedgerEntries.companyId, e.companyId), eq(vendorLedgerEntries.idempotencyKey, e.idempotencyKey)));
      if (existing !== undefined) return { id: existing.id, replayed: true };
    }
    const id = e.id ?? randomUUID();
    await tx.insert(vendorLedgerEntries).values({
      id,
      companyId: e.companyId,
      vendorId: e.vendorId,
      documentType: e.documentType,
      documentNo: e.documentNo,
      externalDocumentNo: e.externalDocumentNo ?? null,
      documentId: e.documentId ?? null,
      description: e.description ?? null,
      amount: fromCents(e.amountCents),
      remainingAmount: fromCents(e.amountCents),
      currency: e.currency,
      postingDate: e.postingDate,
      documentDate: e.documentDate ?? null,
      dueDate: e.dueDate ?? null,
      registerId: e.registerId ?? null,
      idempotencyKey: e.idempotencyKey ?? null,
      createdBy: e.createdBy ?? null,
    });
    await tx.insert(vendorDetailedEntries).values({
      companyId: e.companyId,
      vendorId: e.vendorId,
      ledgerEntryId: id,
      entryType: 'initial',
      amount: fromCents(e.amountCents),
      postingDate: e.postingDate,
      registerId: e.registerId ?? null,
      createdBy: e.createdBy ?? null,
    });
    return { id, replayed: false };
  }

  /** What is owed to the vendor, per currency, in cents: the sum of what is still open. */
  async balances(companyId: string, vendorId: string): Promise<{ currency: string; cents: number }[]> {
    const rows = await this.db
      .select({ currency: vendorLedgerEntries.currency, total: sql<string>`COALESCE(SUM(${vendorLedgerEntries.remainingAmount}), 0)::text` })
      .from(vendorLedgerEntries)
      .where(and(eq(vendorLedgerEntries.companyId, companyId), eq(vendorLedgerEntries.vendorId, vendorId)))
      .groupBy(vendorLedgerEntries.currency)
      .orderBy(asc(vendorLedgerEntries.currency));
    return rows.map((r) => ({ currency: r.currency, cents: toCents(Number(r.total).toFixed(2)) }));
  }

  /** The entries of a vendor, newest first, optionally within a date range. */
  async statement(companyId: string, vendorId: string, from: string | null, to: string | null, limit = 200) {
    const conds = [eq(vendorLedgerEntries.companyId, companyId), eq(vendorLedgerEntries.vendorId, vendorId)];
    if (has(from)) conds.push(gte(vendorLedgerEntries.postingDate, from));
    if (has(to)) conds.push(lte(vendorLedgerEntries.postingDate, to));
    return await this.db
      .select()
      .from(vendorLedgerEntries)
      .where(and(...conds))
      .orderBy(desc(vendorLedgerEntries.postingDate), desc(vendorLedgerEntries.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /** Entries whose remaining amount does not equal the sum of their detailed entries: each one is a defect to investigate. */
  async drift(companyId: string): Promise<{ id: string; documentNo: string; remaining: string; detailed: string }[]> {
    const rows = await this.db.execute<{ id: string; document_no: string; remaining: string; detailed: string }>(sql`
      SELECT e.id, e.document_no, e.remaining_amount::text AS remaining, COALESCE(SUM(d.amount), 0)::text AS detailed
      FROM vendor_ledger_entries e
      LEFT JOIN vendor_detailed_entries d ON d.ledger_entry_id = e.id
      WHERE e.company_id = ${companyId}::uuid
      GROUP BY e.id, e.document_no, e.remaining_amount
      HAVING e.remaining_amount <> COALESCE(SUM(d.amount), 0)`);
    return [...rows].map((r) => ({ id: r.id, documentNo: r.document_no, remaining: r.remaining, detailed: r.detailed }));
  }
}
