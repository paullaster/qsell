import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { billInvoicePayments, billInvoices, customers, type BillInvoiceRow, type BillInvoiceStatus, type ProviderOperationRow, type ProviderTransactionRow } from '@/server/db/drizzle/schema';
import { OperationRefused, type DarajaOperations } from '../daraja/operations';
import { maskPhone } from './redact';

import { has } from '@/lib/values';

export interface InvoiceToRecord {
  reference: string;
  accountReference: string;
  billedName: string;
  phone: string;
  invoiceName: string;
  period: string;
  amount: string;
  dueDate: string;
}

/** Cents in a stored two-place amount. */
const centsOf = (amount: string): number => Math.round(Number(amount) * 100);
const fromCents = (cents: number): string => (cents / 100).toFixed(2);

/**
 * Which open invoice a confirmed payment settles, among those with the account number it was paid to: the one for exactly that
 * much, else the one with the earliest due date. A payment that fits no open invoice settles none. Pure.
 */
export function invoiceFor(open: readonly { id: string; amountCents: number; paidCents: number; dueDate: string }[], paidCents: number): string | null {
  const left = (i: (typeof open)[number]) => i.amountCents - i.paidCents;
  const exact = open.filter((i) => left(i) === paidCents).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  if (exact.length > 0) return exact[0].id;
  const any = open.filter((i) => left(i) > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return any[0]?.id ?? null;
}

/**
 * Invoices sent through Bill Manager, followed from the request to the receipt. The invoice is written down when it is asked for,
 * becomes "sent" or "failed" with the answer, and is paid by a payment that Safaricom itself confirmed for the same account
 * number (never by a notice alone); when it is paid, Bill Manager is told so the customer gets a receipt.
 */
export class BillInvoiceService {
  /** Set by the engine: how to ask Safaricom to acknowledge a payment. */
  daraja: DarajaOperations | null = null;

  constructor(private readonly db: DrizzleDb) {}

  /** The invoices that are already out, so the same invoice number is not sent twice. */
  async existing(providerId: string, references: readonly string[]): Promise<Map<string, BillInvoiceStatus>> {
    if (references.length === 0) return new Map();
    const rows = await this.db.select({ r: billInvoices.reference, s: billInvoices.status }).from(billInvoices).where(and(eq(billInvoices.providerId, providerId), inArray(billInvoices.reference, [...references])));
    return new Map(rows.map((r) => [r.r, r.s]));
  }

  /** Writes the invoices down as asked for. A failed one may be sent again; any other with the same number is refused. */
  async record(input: { companyId: string; providerId: string; methodId: string; invoices: readonly InvoiceToRecord[]; requestedBy: string }): Promise<void> {
    if (input.invoices.length === 0) return;
    const numbers = [...new Set(input.invoices.map((i) => i.accountReference.toLowerCase()))];
    const owners = await this.db.select({ id: customers.id, n: customers.number }).from(customers).where(and(eq(customers.companyId, input.companyId), inArray(sql`lower(${customers.number})`, numbers)));
    const byNumber = new Map(owners.map((o) => [o.n.toLowerCase(), o.id]));
    for (let i = 0; i < input.invoices.length; i += 500) {
      const chunk = input.invoices.slice(i, i + 500);
      await this.db
        .insert(billInvoices)
        .values(
          chunk.map((inv) => ({
            companyId: input.companyId,
            providerId: input.providerId,
            methodId: input.methodId,
            reference: inv.reference,
            accountReference: inv.accountReference,
            customerId: byNumber.get(inv.accountReference.toLowerCase()) ?? null,
            billedName: inv.billedName,
            phoneMasked: maskPhone(inv.phone),
            invoiceName: inv.invoiceName,
            period: inv.period,
            amount: inv.amount,
            dueDate: inv.dueDate,
            createdBy: input.requestedBy,
          })),
        )
        .onConflictDoUpdate({
          target: [billInvoices.providerId, billInvoices.reference],
          // Only an invoice that failed is made again; the rest keep what they are.
          set: { status: 'requested', failureReason: null, updatedAt: new Date() },
          setWhere: eq(billInvoices.status, 'failed'),
        });
    }
  }

  /** The send answered: the invoices it carried are sent, or failed with the reason. */
  async sent(providerId: string, references: readonly string[], op: { id: string | null; status: string; failureReason: string | null }): Promise<void> {
    if (references.length === 0) return;
    const ok = op.status === 'succeeded';
    for (let i = 0; i < references.length; i += 500) {
      await this.db
        .update(billInvoices)
        .set({ status: ok ? 'sent' : 'failed', failureReason: ok ? null : (op.failureReason ?? 'Bill Manager did not accept the invoice.'), sendOperationId: op.id, updatedAt: new Date() })
        .where(and(eq(billInvoices.providerId, providerId), inArray(billInvoices.reference, references.slice(i, i + 500)), inArray(billInvoices.status, ['requested', 'failed'])));
    }
  }

  /** The cancel answered: invoices that were sent and not paid are cancelled. Paid ones are left as they were. */
  async cancelled(providerId: string, references: readonly string[], op: Pick<ProviderOperationRow, 'id' | 'status'>): Promise<number> {
    if (op.status !== 'succeeded' || references.length === 0) return 0;
    const done = await this.db
      .update(billInvoices)
      .set({ status: 'cancelled', cancelOperationId: op.id, updatedAt: new Date() })
      .where(and(eq(billInvoices.providerId, providerId), inArray(billInvoices.reference, [...references]), inArray(billInvoices.status, ['sent', 'part_paid', 'requested', 'failed'])))
      .returning({ id: billInvoices.id });
    return done.length;
  }

  /** Invoices that were paid in full cannot be cancelled: the references among these that can be. */
  async cancellable(providerId: string, references: readonly string[]): Promise<{ ok: string[]; refused: { reference: string; why: string }[] }> {
    const known = await this.existing(providerId, references);
    const ok: string[] = [];
    const refused: { reference: string; why: string }[] = [];
    for (const r of references) {
      const status = known.get(r);
      if (status === 'paid') refused.push({ reference: r, why: 'was already paid' });
      else if (status === 'cancelled') refused.push({ reference: r, why: 'was already cancelled' });
      else ok.push(r);
    }
    return { ok, refused };
  }

  /**
   * A payment Safaricom confirmed has been put on a customer: if it was paid to the account number of an open invoice, that
   * invoice is paid (or part paid), and Bill Manager is told, so the customer gets a receipt. Never throws into the payment.
   */
  async paymentPlaced(tx: ProviderTransactionRow): Promise<{ invoiceId: string | null }> {
    if (!has(tx.accountReference)) return { invoiceId: null };
    const paidCents = centsOf(tx.amount);
    const settled = await this.db.transaction(async (db) => {
      // This payment has settled an invoice already? Then it is told the same answer and nothing changes.
      const [already] = await db.select({ invoiceId: billInvoicePayments.invoiceId }).from(billInvoicePayments).where(eq(billInvoicePayments.transactionId, tx.id));
      if (already) return { invoiceId: already.invoiceId, fresh: null };
      const open = await db
        .select()
        .from(billInvoices)
        .where(and(eq(billInvoices.providerId, tx.providerId), sql`lower(${billInvoices.accountReference}) = lower(${tx.accountReference})`, inArray(billInvoices.status, ['sent', 'part_paid'])))
        .orderBy(asc(billInvoices.dueDate), asc(billInvoices.id))
        .for('update');
      const pick = invoiceFor(open.map((o) => ({ id: o.id, amountCents: centsOf(o.amount), paidCents: centsOf(o.paidAmount), dueDate: o.dueDate })), paidCents);
      const invoice = open.find((o) => o.id === pick);
      if (invoice === undefined) return { invoiceId: null, fresh: null };
      const applied = Math.min(paidCents, centsOf(invoice.amount) - centsOf(invoice.paidAmount));
      const [claimed] = await db.insert(billInvoicePayments).values({ transactionId: tx.id, invoiceId: invoice.id, amount: fromCents(applied) }).onConflictDoNothing().returning({ id: billInvoicePayments.transactionId });
      if (!claimed) return { invoiceId: invoice.id, fresh: null };
      const paid = centsOf(invoice.paidAmount) + applied;
      const full = paid >= centsOf(invoice.amount);
      await db.update(billInvoices).set({ paidAmount: fromCents(paid), status: full ? 'paid' : 'part_paid', paidAt: full ? new Date() : null, lastTransactionId: tx.id, updatedAt: new Date() }).where(eq(billInvoices.id, invoice.id));
      return { invoiceId: invoice.id, fresh: invoice };
    });
    if (settled.fresh !== null) await this.acknowledge(settled.fresh, tx);
    return { invoiceId: settled.invoiceId };
  }

  private async acknowledge(invoice: BillInvoiceRow, tx: ProviderTransactionRow): Promise<void> {
    if (this.daraja === null) return;
    try {
      const { op } = await this.daraja.start({
        providerId: invoice.providerId,
        methodId: invoice.methodId,
        operation: 'bill_acknowledge',
        input: {
          paymentDate: (tx.occurredAt ?? tx.createdAt).toISOString().slice(0, 10),
          paidAmount: Number(tx.amount).toFixed(2),
          accountReference: invoice.accountReference,
          transactionId: tx.platformReference,
          phoneNumber: '',
          fullName: invoice.billedName,
          invoiceName: invoice.invoiceName,
          externalReference: invoice.reference,
        },
        idempotencyKey: `bill-ack:${tx.id}`,
        subject: { type: 'provider_transaction', id: tx.id },
      });
      if (op.status === 'succeeded') await this.db.update(billInvoices).set({ acknowledgedAt: new Date(), ackError: null, updatedAt: new Date() }).where(eq(billInvoices.id, invoice.id));
      else await this.db.update(billInvoices).set({ ackError: (op.failureReason ?? `The acknowledgement is ${op.status}.`).slice(0, 300), updatedAt: new Date() }).where(eq(billInvoices.id, invoice.id));
    } catch (error) {
      const why = error instanceof OperationRefused ? error.message : 'The acknowledgement could not be sent.';
      await this.db.update(billInvoices).set({ ackError: why.slice(0, 300), updatedAt: new Date() }).where(eq(billInvoices.id, invoice.id));
    }
  }

  // ── what people see ──────────────────────────────────────────────────────

  /** One page of invoices, newest first, optionally of one state or matching a word in the number, name or account. */
  async list(companyId: string, f: { status?: BillInvoiceStatus; q?: string; before?: string; limit?: number } = {}) {
    const limit = Math.min(f.limit ?? 50, 200);
    const q = f.q?.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
    // Invoices made together share a moment, so the place to carry on from is the moment (to the microsecond) and the invoice.
    const [stamp = '', cursorId = ''] = (f.before ?? '').split('|');
    const before = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/.test(stamp) && /^[0-9a-f-]{36}$/i.test(cursorId) ? { at: stamp, id: cursorId } : null;
    const found = await this.db
      .select({ i: billInvoices, cursor: sql<string>`${billInvoices.createdAt}::text` })
      .from(billInvoices)
      .where(
        and(
          eq(billInvoices.companyId, companyId),
          f.status === undefined ? undefined : eq(billInvoices.status, f.status),
          before === null ? undefined : sql`(${billInvoices.createdAt}, ${billInvoices.id}) < (${before.at}::timestamptz, ${before.id}::uuid)`,
          has(q) ? sql`(${billInvoices.reference} ILIKE ${`%${q}%`} OR ${billInvoices.billedName} ILIKE ${`%${q}%`} OR ${billInvoices.accountReference} ILIKE ${`%${q}%`})` : undefined,
        ),
      )
      .orderBy(desc(billInvoices.createdAt), desc(billInvoices.id))
      .limit(limit + 1);
    const more = found.length > limit;
    const page = more ? found.slice(0, limit) : found;
    const last = page[page.length - 1];
    return { rows: page.map((p) => p.i), nextBefore: more ? `${last.cursor}|${last.i.id}` : null };
  }

  async counts(companyId: string): Promise<Record<string, number>> {
    const rows = await this.db.select({ s: billInvoices.status, n: sql<number>`count(*)::int` }).from(billInvoices).where(eq(billInvoices.companyId, companyId)).groupBy(billInvoices.status);
    return Object.fromEntries(rows.map((r) => [r.s, r.n]));
  }

  /** Invoices sent and now overdue and unpaid, oldest due first, so someone can chase them. */
  async overdue(companyId: string, today: string, limit = 50) {
    return await this.db
      .select()
      .from(billInvoices)
      .where(and(eq(billInvoices.companyId, companyId), inArray(billInvoices.status, ['sent', 'part_paid']), lt(billInvoices.dueDate, today)))
      .orderBy(asc(billInvoices.dueDate))
      .limit(limit);
  }
}
