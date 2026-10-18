import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  customerDetailedEntries,
  customerLedgerEntries,
  customers,
  financeSalesPostings,
  financeSettings,
  type CustomerLedgerEntryRow,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import {
  ageOpenItems,
  checkApplications,
  fromCents,
  planOldestFirst,
  toCents,
  type PlannedApplication,
} from '../domain/receivables';
import type { Tx } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';

import { has } from '@/lib/values';

export type Writer = DrizzleDb | Tx;

export interface NewLedgerEntry {
  companyId: string;
  customerId: string;
  documentType: 'invoice' | 'payment' | 'credit_note' | 'refund' | 'rebate_credit' | 'wallet_use';
  /** Give the entry this id (so a record made at the same moment can point at it). */
  id?: string;
  documentNo: string;
  documentId?: string | null;
  orderId?: string | null;
  description?: string | null;
  /** Signed: invoices positive, receipts and credit notes negative. */
  amountCents: number;
  currency: string;
  postingDate: string;
  dueDate?: Date | null;
  registerId?: string | null;
  createdBy?: string | null;
}

/**
 * The customer sub-ledger. A ledger entry is posted once and never edited; what is still open on
 * it changes only through detailed entries (apply, unapply, reverse), written in the same
 * transaction as the remaining amount they change.
 */
export class CustomerLedgerService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  /** Adds a ledger entry and its opening detailed entry. Returns the entry id. */
  async addEntry(tx: Writer, e: NewLedgerEntry): Promise<string> {
    const id = e.id ?? randomUUID();
    await tx.insert(customerLedgerEntries).values({
      id,
      companyId: e.companyId,
      customerId: e.customerId,
      orderId: e.orderId ?? null,
      documentType: e.documentType,
      documentNo: e.documentNo,
      documentId: e.documentId ?? null,
      description: e.description ?? null,
      amount: fromCents(e.amountCents),
      remainingAmount: fromCents(e.amountCents),
      dueDate: e.dueDate ?? null,
      kraTransmissionStatus: 'not_applicable',
      postingDate: e.postingDate,
      currency: e.currency,
      registerId: e.registerId ?? null,
    });
    await tx.insert(customerDetailedEntries).values({
      companyId: e.companyId,
      customerId: e.customerId,
      ledgerEntryId: id,
      entryType: 'initial',
      amount: fromCents(e.amountCents),
      postingDate: e.postingDate,
      registerId: e.registerId ?? null,
      createdBy: e.createdBy ?? null,
    });
    return id;
  }

  /** Locks rows in a fixed order so two applications touching the same entries cannot deadlock. */
  private async lockEntries(tx: Tx, ids: string[]): Promise<Map<string, CustomerLedgerEntryRow>> {
    const rows = await tx
      .select()
      .from(customerLedgerEntries)
      .where(inArray(customerLedgerEntries.id, ids))
      .orderBy(asc(customerLedgerEntries.id))
      .for('update');
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * A payment applied to (or taken back from) an invoice in a foreign currency may have been at a different rate from the
   * invoice: the difference is the business's gain or loss, posted to the books shortly after by the sales-posting queue.
   * Nothing is queued before the books are live, or for the books' own currency.
   */
  private async queueFx(tx: Tx, companyId: string, kind: 'fx_application' | 'fx_unapplication', subjectId: string, date: string, currency: string | null): Promise<void> {
    if (currency === null) return;
    const [s] = await tx.select({ base: financeSettings.baseCurrency, live: financeSettings.salesGlGoLive }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (s === undefined) return;
    if (s.live === null || currency.toUpperCase() === s.base) return;
    await tx.insert(financeSalesPostings).values({ companyId, kind, subjectId, eventDate: date < s.live ? s.live : date }).onConflictDoNothing({ target: [financeSalesPostings.companyId, financeSalesPostings.kind, financeSalesPostings.subjectId] });
  }

  /** Moves `remaining_amount` by the given signed cents, per entry, in one statement. */
  private async shiftRemaining(tx: Tx, deltas: Map<string, number>): Promise<void> {
    const rows = [...deltas.entries()].filter(([, c]) => c !== 0);
    if (rows.length === 0) return;
    const values = sql.join(
      rows.map(([id, c]) => sql`(${id}::uuid, ${fromCents(c)}::numeric)`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE customer_ledger_entries e SET remaining_amount = e.remaining_amount + v.delta
      FROM (VALUES ${values}) AS v(id, delta) WHERE e.id = v.id`);
  }

  /**
   * Applies a credit entry (an unapplied receipt) to open invoices of the same customer and
   * currency. Everything is checked against the locked rows, so two people applying the same
   * money at once cannot over-apply it.
   */
  async applyIn(
    tx: Tx,
    ctx: FinanceContext,
    input: {
      customerId: string;
      creditEntryId: string;
      applications: PlannedApplication[] | 'oldest_first';
      postingDate: string;
      createdBy: string | null;
      registerId?: string | null;
    },
  ): Promise<{ applicationId: string; appliedCents: number; applications: PlannedApplication[] }> {
    const idsFromInput =
      input.applications === 'oldest_first' ? [] : input.applications.map((a) => a.entryId);

    let planned: PlannedApplication[];
    let locked: Map<string, CustomerLedgerEntryRow>;
    if (input.applications === 'oldest_first') {
      // Lock the credit first, then every open invoice of the customer in id order.
      const open = await tx
        .select({ id: customerLedgerEntries.id })
        .from(customerLedgerEntries)
        .where(
          and(
            eq(customerLedgerEntries.companyId, ctx.companyId),
            eq(customerLedgerEntries.customerId, input.customerId),
            sql`${customerLedgerEntries.remainingAmount} > 0`,
          ),
        );
      locked = await this.lockEntries(tx, [input.creditEntryId, ...open.map((o) => o.id)]);
      const credit = locked.get(input.creditEntryId);
      const creditAvail = credit ? -toCents(credit.remainingAmount) : 0;
      planned = planOldestFirst(
        [...locked.values()]
          .filter((r) => r.id !== input.creditEntryId && toCents(r.remainingAmount) > 0)
          .filter((r) => r.currency === credit?.currency)
          .map((r) => ({
            id: r.id,
            remainingCents: toCents(r.remainingAmount),
            dueDate: r.dueDate,
            createdAt: r.createdAt,
            documentNo: r.documentNo,
          })),
        Math.max(creditAvail, 0),
      );
      if (planned.length === 0) {
        throw new FinanceError('NOTHING_TO_APPLY', 'There is nothing open to apply this to.');
      }
    } else {
      planned = input.applications;
      locked = await this.lockEntries(tx, [input.creditEntryId, ...idsFromInput]);
    }

    const credit = locked.get(input.creditEntryId);
    if (credit?.companyId !== ctx.companyId || credit.customerId !== input.customerId) {
      throw new FinanceError('NOT_FOUND', 'That receipt was not found for this customer.');
    }
    const creditAvail = -toCents(credit.remainingAmount);
    if (creditAvail <= 0) {
      throw new FinanceError('NOTHING_TO_APPLY', 'This receipt has nothing left to apply.');
    }
    const invoiceOpen = new Map<string, number>();
    for (const a of planned) {
      const inv = locked.get(a.entryId);
      if (inv?.companyId !== ctx.companyId || inv.customerId !== input.customerId) {
        throw new FinanceError('NOT_FOUND', 'One of the invoices was not found for this customer.');
      }
      if (inv.documentType !== 'invoice') {
        throw new FinanceError('NOT_AN_INVOICE', `${inv.documentNo} is not an invoice, so a payment cannot be applied to it.`);
      }
      if (inv.currency !== credit.currency) {
        throw new FinanceError(
          'CURRENCY_MISMATCH',
          `${inv.documentNo} is in ${inv.currency ?? ''} and the receipt is in ${credit.currency ?? ''}. Applying across currencies is not supported yet.`,
        );
      }
      invoiceOpen.set(a.entryId, toCents(inv.remainingAmount));
    }
    const issues = checkApplications(creditAvail, invoiceOpen, planned);
    if (issues.length > 0) {
      throw new FinanceError(
        issues[0].code,
        issues.map((i) => i.message).join(' '),
        issues.map((i) => ({ code: i.code, message: i.message })),
      );
    }

    const applicationId = randomUUID();
    const total = planned.reduce((n, a) => n + a.amountCents, 0);
    const base = {
      companyId: ctx.companyId,
      customerId: input.customerId,
      entryType: 'application' as const,
      applicationId,
      postingDate: input.postingDate,
      registerId: input.registerId ?? null,
      createdBy: input.createdBy,
    };
    await tx.insert(customerDetailedEntries).values(
      planned.flatMap((a) => [
        { ...base, ledgerEntryId: a.entryId, amount: fromCents(-a.amountCents), appliedToEntryId: input.creditEntryId },
        { ...base, ledgerEntryId: input.creditEntryId, amount: fromCents(a.amountCents), appliedToEntryId: a.entryId },
      ]),
    );
    const deltas = new Map<string, number>(planned.map((a) => [a.entryId, -a.amountCents]));
    deltas.set(input.creditEntryId, total);
    await this.shiftRemaining(tx, deltas);
    await this.moveBalance(tx, input.customerId, -total);
    await this.queueFx(tx, ctx.companyId, 'fx_application', applicationId, input.postingDate, credit.currency);

    await this.decisions.record(
      {
        companyId: ctx.companyId,
        subject: { type: 'customer_application', id: applicationId },
        action: 'finance.receipt_applied',
        actor: ctx.actor,
        inputs: { origin: ctx.origin, creditEntryId: input.creditEntryId, customerId: input.customerId },
        outcome: { total: fromCents(total), invoices: planned.map((a) => ({ entry: a.entryId, amount: fromCents(a.amountCents) })) },
      },
      tx,
    );
    return { applicationId, appliedCents: total, applications: planned };
  }

  /** Undoes one application exactly (each can be undone once); the invoices become open again. */
  async unapplyIn(
    tx: Tx,
    ctx: FinanceContext,
    input: { applicationId: string; reasonCode: string; reasonText?: string | null; postingDate: string; createdBy: string | null },
  ): Promise<{ restoredCents: number }> {
    const original = await tx
      .select()
      .from(customerDetailedEntries)
      .where(
        and(
          eq(customerDetailedEntries.companyId, ctx.companyId),
          eq(customerDetailedEntries.applicationId, input.applicationId),
          eq(customerDetailedEntries.entryType, 'application'),
        ),
      );
    if (original.length === 0) throw new FinanceError('NOT_FOUND', 'That application does not exist.');
    const already = await tx
      .select({ id: customerDetailedEntries.id })
      .from(customerDetailedEntries)
      .where(eq(customerDetailedEntries.unappliesApplicationId, input.applicationId))
      .limit(1);
    if (already.length > 0) throw new FinanceError('ALREADY_UNAPPLIED', 'That application has already been undone.');

    const entryIds = [...new Set(original.map((r) => r.ledgerEntryId))];
    await this.lockEntries(tx, entryIds);
    const newApplication = randomUUID();
    await tx.insert(customerDetailedEntries).values(
      original.map((r) => ({
        companyId: r.companyId,
        customerId: r.customerId,
        ledgerEntryId: r.ledgerEntryId,
        entryType: 'unapplication' as const,
        amount: fromCents(-toCents(r.amount)),
        appliedToEntryId: r.appliedToEntryId,
        applicationId: newApplication,
        unappliesApplicationId: input.applicationId,
        postingDate: input.postingDate,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        createdBy: input.createdBy,
      })),
    );
    const deltas = new Map<string, number>();
    let restoredToInvoices = 0;
    for (const r of original) {
      const c = -toCents(r.amount);
      deltas.set(r.ledgerEntryId, (deltas.get(r.ledgerEntryId) ?? 0) + c);
      if (c > 0) restoredToInvoices += c;
    }
    await this.shiftRemaining(tx, deltas);
    await this.moveBalance(tx, original[0].customerId, restoredToInvoices);
    const [first] = await tx.select({ currency: customerLedgerEntries.currency }).from(customerLedgerEntries).where(eq(customerLedgerEntries.id, original[0].ledgerEntryId));
    await this.queueFx(tx, ctx.companyId, 'fx_unapplication', newApplication, input.postingDate, first?.currency ?? null);
    await this.decisions.record(
      {
        companyId: ctx.companyId,
        subject: { type: 'customer_application', id: input.applicationId },
        action: 'finance.receipt_unapplied',
        actor: ctx.actor,
        reason: { code: input.reasonCode, text: input.reasonText },
        inputs: { origin: ctx.origin },
        outcome: { restored: fromCents(restoredToInvoices), undoneBy: newApplication },
      },
      tx,
    );
    return { restoredCents: restoredToInvoices };
  }

  /** Writes off what is left of a credit entry (a reversed receipt): zero it with a reversal row. */
  async closeCreditIn(tx: Tx, ctx: FinanceContext, entryId: string, input: { postingDate: string; reasonCode: string; reasonText?: string | null; createdBy: string | null }) {
    const locked = await this.lockEntries(tx, [entryId]);
    const e = locked.get(entryId);
    if (!e) throw new FinanceError('NOT_FOUND', 'Ledger entry not found.');
    const remaining = toCents(e.remainingAmount);
    if (remaining >= 0) return;
    await tx.insert(customerDetailedEntries).values({
      companyId: e.companyId,
      customerId: e.customerId,
      ledgerEntryId: e.id,
      entryType: 'reversal',
      amount: fromCents(-remaining),
      postingDate: input.postingDate,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? null,
      createdBy: input.createdBy,
    });
    await this.shiftRemaining(tx, new Map([[e.id, -remaining]]));
  }

  /** Application ids on an entry that are still in force (applied and not yet undone). */
  async activeApplicationIds(tx: Writer, ledgerEntryId: string): Promise<string[]> {
    const res = await tx.execute<{ application_id: string }>(sql`
      SELECT DISTINCT d.application_id FROM customer_detailed_entries d
      WHERE d.ledger_entry_id = ${ledgerEntryId}::uuid AND d.entry_type = 'application'
        AND NOT EXISTS (SELECT 1 FROM customer_detailed_entries u WHERE u.unapplies_application_id = d.application_id)`);
    return [...res].map((r) => r.application_id);
  }

  /**
   * Moves part of an unapplied credit out of the customer's account (into the wallet), or back.
   * Positive `cents` shrinks the credit; negative restores it. Locks the entry first.
   */
  async transferCreditIn(
    tx: Tx,
    ctx: FinanceContext,
    entryId: string,
    cents: number,
    p: { postingDate: string; createdBy: string | null; registerId?: string | null; reasonCode?: string | null; reasonText?: string | null; type?: 'wallet_transfer' | 'refund_transfer' | 'write_off' },
  ): Promise<void> {
    const locked = await this.lockEntries(tx, [entryId]);
    const e = locked.get(entryId);
    if (e?.companyId !== ctx.companyId) throw new FinanceError('NOT_FOUND', 'Ledger entry not found.');
    const remaining = toCents(e.remainingAmount);
    if (cents > 0 && -remaining < cents) {
      throw new FinanceError('OVER_CREDIT', `Only ${fromCents(Math.max(-remaining, 0))} is unapplied on that receipt.`);
    }
    await tx.insert(customerDetailedEntries).values({
      companyId: e.companyId,
      customerId: e.customerId,
      ledgerEntryId: e.id,
      entryType: p.type ?? 'wallet_transfer',
      amount: fromCents(cents),
      postingDate: p.postingDate,
      registerId: p.registerId ?? null,
      reasonCode: p.reasonCode ?? null,
      reasonText: p.reasonText ?? null,
      createdBy: p.createdBy,
    });
    await this.shiftRemaining(tx, new Map([[e.id, cents]]));
  }

  /** Customers' open receivable follows their open invoices; never below zero. */
  private async moveBalance(tx: Tx, customerId: string, deltaCents: number): Promise<void> {
    if (deltaCents === 0) return;
    await tx
      .update(customers)
      .set({ balance: sql`GREATEST(${customers.balance} + ${fromCents(deltaCents)}::numeric, 0)`, updatedAt: new Date() })
      .where(eq(customers.id, customerId));
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Open invoices (positive) and unapplied credits (negative) for one customer. */
  async openItems(companyId: string, customerId: string) {
    return await this.db
      .select()
      .from(customerLedgerEntries)
      .where(
        and(
          eq(customerLedgerEntries.companyId, companyId),
          eq(customerLedgerEntries.customerId, customerId),
          sql`${customerLedgerEntries.remainingAmount} <> 0`,
        ),
      )
      .orderBy(asc(customerLedgerEntries.dueDate), asc(customerLedgerEntries.createdAt));
  }

  async statement(companyId: string, customerId: string, from: string | null, to: string | null) {
    const conds = [eq(customerLedgerEntries.companyId, companyId), eq(customerLedgerEntries.customerId, customerId)];
    if (has(from)) conds.push(gte(customerLedgerEntries.postingDate, from));
    if (has(to)) conds.push(lte(customerLedgerEntries.postingDate, to));
    const [lines, open] = await Promise.all([
      this.db
        .select()
        .from(customerLedgerEntries)
        .where(and(...conds))
        .orderBy(desc(customerLedgerEntries.postingDate), desc(customerLedgerEntries.createdAt))
        .limit(500),
      this.openItems(companyId, customerId),
    ]);
    const asOf = new Date();
    const aged = ageOpenItems(
      open.map((o) => ({ remainingCents: toCents(o.remainingAmount), dueDate: o.dueDate, createdAt: o.createdAt })),
      asOf,
    );
    const openInvoices = open.filter((o) => toCents(o.remainingAmount) > 0);
    const credits = open.filter((o) => toCents(o.remainingAmount) < 0);
    const owed = openInvoices.reduce((n, o) => n + toCents(o.remainingAmount), 0);
    return {
      lines,
      openInvoices,
      credits,
      owedCents: owed,
      unappliedCents: aged.creditsCents,
      netCents: owed - aged.creditsCents,
      ageing: aged.buckets,
    };
  }

  /** Detailed history of one ledger entry (what happened to it, in order). */
  async history(companyId: string, ledgerEntryId: string) {
    return await this.db
      .select()
      .from(customerDetailedEntries)
      .where(and(eq(customerDetailedEntries.companyId, companyId), eq(customerDetailedEntries.ledgerEntryId, ledgerEntryId)))
      .orderBy(asc(customerDetailedEntries.id));
  }

  /** Receivables ageing for the company (or one customer) as of now. */
  async ageing(companyId: string, customerId?: string) {
    const rows = await this.db
      .select({
        remaining: customerLedgerEntries.remainingAmount,
        dueDate: customerLedgerEntries.dueDate,
        createdAt: customerLedgerEntries.createdAt,
        customerId: customerLedgerEntries.customerId,
      })
      .from(customerLedgerEntries)
      .where(
        and(
          eq(customerLedgerEntries.companyId, companyId),
          has(customerId) ? eq(customerLedgerEntries.customerId, customerId) : undefined,
          sql`${customerLedgerEntries.remainingAmount} <> 0`,
        ),
      );
    return ageOpenItems(
      rows.map((r) => ({ remainingCents: toCents(r.remaining), dueDate: r.dueDate, createdAt: r.createdAt })),
      new Date(),
    );
  }

  /**
   * Who owes what, by age, for the whole company: computed in the database so it stays fast with
   * many customers. Credits (unapplied receipts) are shown apart, never netted against old debt.
   */
  async ageingByCustomer(companyId: string, limit = 100) {
    const bucketSql = (lo: number, hi: number | null) =>
      sql.raw(
        `COALESCE(SUM(CASE WHEN e.remaining_amount > 0 AND x.d >= ${lo}${hi === null ? '' : ` AND x.d <= ${hi}`} THEN e.remaining_amount END), 0)`,
      );
    const rows = await this.db.execute<{
      id: string; number: string; name: string; owed: string; credits: string;
      current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string;
    }>(sql`
      SELECT c.id, c.number, c.name,
        COALESCE(SUM(CASE WHEN e.remaining_amount > 0 THEN e.remaining_amount END), 0) AS owed,
        COALESCE(SUM(CASE WHEN e.remaining_amount < 0 THEN -e.remaining_amount END), 0) AS credits,
        COALESCE(SUM(CASE WHEN e.remaining_amount > 0 AND x.d <= 0 THEN e.remaining_amount END), 0) AS current,
        ${bucketSql(1, 30)} AS d1_30,
        ${bucketSql(31, 60)} AS d31_60,
        ${bucketSql(61, 90)} AS d61_90,
        ${bucketSql(91, null)} AS d90_plus
      FROM customer_ledger_entries e
      JOIN customers c ON c.id = e.customer_id
      CROSS JOIN LATERAL (
        SELECT ((now() AT TIME ZONE 'Africa/Nairobi')::date - (COALESCE(e.due_date, e.created_at) AT TIME ZONE 'Africa/Nairobi')::date) AS d
      ) x
      WHERE e.company_id = ${companyId}::uuid AND e.remaining_amount <> 0
      GROUP BY c.id, c.number, c.name
      ORDER BY owed DESC, c.name
      LIMIT ${limit}`);
    const list = [...rows];
    const sum = (k: keyof (typeof list)[number]) => list.reduce((n, r) => n + toCents(r[k]), 0);
    return {
      rows: list,
      totals: {
        owed: fromCents(sum('owed')),
        credits: fromCents(sum('credits')),
        current: fromCents(sum('current')),
        d1_30: fromCents(sum('d1_30')),
        d31_60: fromCents(sum('d31_60')),
        d61_90: fromCents(sum('d61_90')),
        d90_plus: fromCents(sum('d90_plus')),
      },
      truncated: list.length === limit,
    };
  }

  /**
   * Entries whose remaining amount is not the sum of their detailed entries: the integrity check
   * for the one denormalised figure. Empty means the books agree with their history.
   */
  async drift(companyId: string) {
    const rows = await this.db.execute<{ id: string; document_no: string; remaining: string; detail_sum: string }>(sql`
      SELECT e.id, e.document_no, e.remaining_amount AS remaining, COALESCE(SUM(d.amount), 0) AS detail_sum
      FROM customer_ledger_entries e
      LEFT JOIN customer_detailed_entries d ON d.ledger_entry_id = e.id
      WHERE e.company_id = ${companyId}
      GROUP BY e.id, e.document_no, e.remaining_amount
      HAVING e.remaining_amount <> COALESCE(SUM(d.amount), 0)
      LIMIT 200`);
    return [...rows];
  }
}
