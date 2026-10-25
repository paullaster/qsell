import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
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

  /**
   * Sets a payment (or an advance) against an invoice for `amountCents`: two detailed entries sharing one application id, and the
   * remaining amount of both entries changed in the same transaction. Refuses more than either entry has open, and entries of
   * different vendors.
   */
  async apply(
    tx: Writer,
    e: { companyId: string; vendorId: string; creditEntryId: string; invoiceEntryId: string; amountCents: number; postingDate: string; entryType?: 'application' | 'advance_application'; registerId?: string | null; createdBy?: string | null },
  ): Promise<{ applicationId: string }> {
    if (e.amountCents <= 0) throw new FinanceError('AMOUNT_INVALID', 'The amount to apply must be above zero.');
    const rows = await tx
      .select()
      .from(vendorLedgerEntries)
      .where(and(eq(vendorLedgerEntries.companyId, e.companyId), inArray(vendorLedgerEntries.id, [e.creditEntryId, e.invoiceEntryId])))
      .orderBy(asc(vendorLedgerEntries.id))
      .for('update');
    const credit = rows.find((r) => r.id === e.creditEntryId);
    const invoice = rows.find((r) => r.id === e.invoiceEntryId);
    if (credit === undefined || invoice === undefined || credit.vendorId !== e.vendorId || invoice.vendorId !== e.vendorId) throw new FinanceError('NOT_FOUND', 'Those ledger entries do not belong to this vendor.');
    if (credit.currency !== invoice.currency) throw new FinanceError('CURRENCY_MISMATCH', 'A payment can only be applied to an invoice in the same currency.');
    const creditOpen = -toCents(Number(credit.remainingAmount).toFixed(2));
    const invoiceOpen = toCents(Number(invoice.remainingAmount).toFixed(2));
    if (e.amountCents > creditOpen) throw new FinanceError('NOT_ENOUGH_PAYMENT', 'The payment has less left to apply than that.');
    if (e.amountCents > invoiceOpen) throw new FinanceError('INVOICE_NOT_OPEN', 'The invoice has less left to pay than that.');
    const applicationId = randomUUID();
    const type = e.entryType ?? 'application';
    await tx.insert(vendorDetailedEntries).values([
      { companyId: e.companyId, vendorId: e.vendorId, ledgerEntryId: credit.id, entryType: type, amount: fromCents(e.amountCents), appliedToEntryId: invoice.id, applicationId, postingDate: e.postingDate, registerId: e.registerId ?? null, createdBy: e.createdBy ?? null },
      { companyId: e.companyId, vendorId: e.vendorId, ledgerEntryId: invoice.id, entryType: type, amount: fromCents(-e.amountCents), appliedToEntryId: credit.id, applicationId, postingDate: e.postingDate, registerId: e.registerId ?? null, createdBy: e.createdBy ?? null },
    ]);
    await tx.update(vendorLedgerEntries).set({ remainingAmount: fromCents(-(creditOpen - e.amountCents)) }).where(eq(vendorLedgerEntries.id, credit.id));
    await tx.update(vendorLedgerEntries).set({ remainingAmount: fromCents(invoiceOpen - e.amountCents) }).where(eq(vendorLedgerEntries.id, invoice.id));
    return { applicationId };
  }

  /** Undoes every application that is still in force on one entry, writing the opposite detailed entries and restoring what was open. */
  async unapplyAll(tx: Writer, e: { companyId: string; entryId: string; postingDate: string; reasonText: string; createdBy?: string | null }): Promise<number> {
    const applied = await tx
      .select()
      .from(vendorDetailedEntries)
      .where(and(eq(vendorDetailedEntries.companyId, e.companyId), eq(vendorDetailedEntries.ledgerEntryId, e.entryId), inArray(vendorDetailedEntries.entryType, ['application', 'advance_application'])));
    let undone = 0;
    for (const a of applied) {
      if (a.applicationId === null || a.appliedToEntryId === null) continue;
      const [already] = await tx.select({ id: vendorDetailedEntries.id }).from(vendorDetailedEntries).where(and(eq(vendorDetailedEntries.unappliesApplicationId, a.applicationId), eq(vendorDetailedEntries.ledgerEntryId, e.entryId)));
      if (already !== undefined) continue;
      const mine = toCents(a.amount);
      const entries = await tx.select().from(vendorLedgerEntries).where(inArray(vendorLedgerEntries.id, [e.entryId, a.appliedToEntryId])).orderBy(asc(vendorLedgerEntries.id)).for('update');
      const own = entries.find((r) => r.id === e.entryId);
      const other = entries.find((r) => r.id === a.appliedToEntryId);
      if (own === undefined || other === undefined) continue;
      await tx.insert(vendorDetailedEntries).values([
        { companyId: e.companyId, vendorId: own.vendorId, ledgerEntryId: own.id, entryType: 'unapplication', amount: fromCents(-mine), appliedToEntryId: other.id, applicationId: a.applicationId, unappliesApplicationId: a.applicationId, postingDate: e.postingDate, reasonText: e.reasonText, createdBy: e.createdBy ?? null },
        { companyId: e.companyId, vendorId: own.vendorId, ledgerEntryId: other.id, entryType: 'unapplication', amount: fromCents(mine), appliedToEntryId: own.id, applicationId: a.applicationId, unappliesApplicationId: a.applicationId, postingDate: e.postingDate, reasonText: e.reasonText, createdBy: e.createdBy ?? null },
      ]);
      await tx.update(vendorLedgerEntries).set({ remainingAmount: fromCents(toCents(Number(own.remainingAmount).toFixed(2)) - mine) }).where(eq(vendorLedgerEntries.id, own.id));
      await tx.update(vendorLedgerEntries).set({ remainingAmount: fromCents(toCents(Number(other.remainingAmount).toFixed(2)) + mine) }).where(eq(vendorLedgerEntries.id, other.id));
      undone += 1;
    }
    return undone;
  }

  /** Closes what is left open on an entry whose document was reversed: a detailed entry of the opposite amount. */
  async reverseEntry(tx: Writer, e: { companyId: string; entryId: string; postingDate: string; reasonText: string; registerId?: string | null; createdBy?: string | null }): Promise<void> {
    const [row] = await tx.select().from(vendorLedgerEntries).where(and(eq(vendorLedgerEntries.companyId, e.companyId), eq(vendorLedgerEntries.id, e.entryId))).for('update');
    if (row === undefined) throw new FinanceError('NOT_FOUND', 'That ledger entry does not exist.');
    const open = toCents(Number(row.remainingAmount).toFixed(2));
    if (open === 0) return;
    await tx.insert(vendorDetailedEntries).values({ companyId: e.companyId, vendorId: row.vendorId, ledgerEntryId: row.id, entryType: 'reversal', amount: fromCents(-open), postingDate: e.postingDate, reasonText: e.reasonText, registerId: e.registerId ?? null, createdBy: e.createdBy ?? null });
    await tx.update(vendorLedgerEntries).set({ remainingAmount: '0.00' }).where(eq(vendorLedgerEntries.id, row.id));
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
