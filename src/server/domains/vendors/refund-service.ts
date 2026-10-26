import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankLedgerEntries,
  financeSettings,
  paymentMethods,
  users,
  vendorLedgerEntries,
  vendorPaymentVouchers,
  vendorPostingGroups,
  vendorRefundEvents,
  vendorRefunds,
  vendors,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkRefundReceipt, checkRefundRequest, refundCents, type RefundReceipt, type RefundRequestForm } from '@/lib/vendor-refund';
import { fromCents, toCents } from '@/lib/vendor-payment';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { PostingEngine } from '@/server/domains/finance/engine';
import type { VendorLedgerService } from '@/server/domains/finance/payables/vendor-ledger-service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
const ENGINE = { canPostSoftClosed: false, canPostControlAccounts: true };
type CreditKind = 'payment' | 'advance' | 'credit_memo';

/**
 * Money a vendor pays back to us (design doc §12.4 and §12.5). It is set against the credit it returns in the vendor ledger and
 * books Dr bank / Cr payables, or prepayments for an advance. One person asks, another books it with the bank reference.
 */
export class VendorRefundService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly engine: PostingEngine,
    private readonly ledger: VendorLedgerService,
  ) {}

  private async event(tx: Tx | DrizzleDb, ctx: FinanceContext, refundId: string, event: string, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(vendorRefundEvents).values({ refundId, event, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id });
  }

  /** What a vendor has paid or been credited that is still open, and could be paid back: payments on account, advances and credit memos. */
  async refundable(companyId: string, vendorId: string) {
    const rows = await this.db
      .select({ e: vendorLedgerEntries })
      .from(vendorLedgerEntries)
      .where(and(eq(vendorLedgerEntries.companyId, companyId), eq(vendorLedgerEntries.vendorId, vendorId), inArray(vendorLedgerEntries.documentType, ['payment', 'advance', 'credit_memo']), sql`${vendorLedgerEntries.remainingAmount} < 0`))
      .orderBy(asc(vendorLedgerEntries.postingDate), asc(vendorLedgerEntries.createdAt));
    const voucherIds = rows.flatMap((r) => (r.e.documentType !== 'credit_memo' && r.e.documentId !== null ? [r.e.documentId] : []));
    const live = new Set((voucherIds.length === 0 ? [] : await this.db.select({ id: vendorPaymentVouchers.id }).from(vendorPaymentVouchers).where(and(inArray(vendorPaymentVouchers.id, voucherIds), eq(vendorPaymentVouchers.status, 'paid')))).map((v) => v.id));
    const asked = await this.db
      .select({ creditEntryId: vendorRefunds.creditEntryId, amount: sql<string>`SUM(${vendorRefunds.amount})::text` })
      .from(vendorRefunds)
      .where(and(eq(vendorRefunds.vendorId, vendorId), eq(vendorRefunds.status, 'pending')))
      .groupBy(vendorRefunds.creditEntryId);
    return rows
      .filter((r) => r.e.documentType === 'credit_memo' || (r.e.documentId !== null && live.has(r.e.documentId)))
      .map((r) => {
        const open = -toCents(r.e.remainingAmount);
        const waiting = toCents(asked.find((a) => a.creditEntryId === r.e.id)?.amount ?? '0');
        return { entryId: r.e.id, kind: r.e.documentType as CreditKind, documentNo: r.e.documentNo, postingDate: r.e.postingDate, currency: r.e.currency, openCents: open, askedCents: waiting, availableCents: Math.max(0, open - waiting) };
      })
      .filter((r) => r.availableCents > 0);
  }

  private async methodFor(db: Tx | DrizzleDb, companyId: string, methodId: string, currency: string) {
    const [m] = await db.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.id, methodId)));
    if (m?.enabled !== true) throw new FinanceError('METHOD_INVALID', 'Choose a way of paying that is in use.');
    const [bank] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, m.balancingBankAccountId));
    if (bank === undefined || bank.blocked) throw new FinanceError('METHOD_INVALID', 'The bank account behind that way of paying is blocked.');
    if (bank.currency !== currency) throw new FinanceError('CURRENCY', `That way of paying is in ${bank.currency}, the refund is in ${currency}.`);
    return m;
  }

  async request(ctx: FinanceContext, form: RefundRequestForm): Promise<{ id: string; amount: string }> {
    return await this.db.transaction(async (tx) => {
      const [credit] = await tx.select().from(vendorLedgerEntries).where(and(eq(vendorLedgerEntries.companyId, ctx.companyId), eq(vendorLedgerEntries.id, form.creditEntryId))).for('update');
      if (credit === undefined || toCents(credit.remainingAmount) >= 0) throw new FinanceError('NOT_FOUND', 'That payment or credit has nothing open to refund.');
      const available = (await this.refundable(ctx.companyId, credit.vendorId)).find((r) => r.entryId === credit.id);
      if (available === undefined) throw new FinanceError('NOT_REFUNDABLE', 'That payment or credit cannot be refunded: it is reversed, used up, or already asked for in full.');
      const problems = checkRefundRequest(form, available.availableCents);
      const first = Object.values(problems)[0];
      if (has(first)) throw new FinanceError('INVALID', first);
      const cents = form.amount.trim() === '' ? available.availableCents : (refundCents(form.amount) ?? 0);
      await this.methodFor(tx, ctx.companyId, form.methodId, credit.currency);
      const [vendor] = await tx.select({ block: vendors.block }).from(vendors).where(eq(vendors.id, credit.vendorId));
      if (vendor === undefined) throw new FinanceError('NOT_FOUND', 'The vendor does not exist.');
      const [made] = await tx
        .insert(vendorRefunds)
        .values({ companyId: ctx.companyId, vendorId: credit.vendorId, creditEntryId: credit.id, creditKind: available.kind, creditNo: credit.documentNo, amount: fromCents(cents), currency: credit.currency, methodId: form.methodId, note: trimToNull(form.note), createdBy: ctx.actor.id })
        .returning({ id: vendorRefunds.id });
      const id = made?.id ?? '';
      await this.event(tx, ctx, id, 'requested', { data: { amount: fromCents(cents), credit: credit.documentNo } });
      return { id, amount: fromCents(cents) };
    });
  }

  async cancel(ctx: FinanceContext, id: string, reason: string): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the refund is cancelled.');
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(vendorRefunds).where(and(eq(vendorRefunds.companyId, ctx.companyId), eq(vendorRefunds.id, id))).for('update');
      if (r === undefined) throw new FinanceError('NOT_FOUND', 'That refund does not exist.');
      if (r.status !== 'pending') throw new FinanceError('WRONG_STATE', 'Only a refund that is waiting can be cancelled.');
      await tx.update(vendorRefunds).set({ status: 'cancelled', cancelReason: text.slice(0, 500), updatedAt: new Date() }).where(eq(vendorRefunds.id, id));
      await this.event(tx, ctx, id, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  /** The money has arrived: book it, and set it against the credit it returns. Another person than the one who asked. */
  async post(ctx: FinanceContext, id: string, receipt: RefundReceipt, now: Date = new Date()): Promise<{ number: string; registerId: string }> {
    const today = businessDate(now);
    const first = Object.values(checkRefundReceipt(receipt, today))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    return await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(vendorRefunds).where(and(eq(vendorRefunds.companyId, ctx.companyId), eq(vendorRefunds.id, id))).for('update');
      if (r === undefined) throw new FinanceError('NOT_FOUND', 'That refund does not exist.');
      if (r.status !== 'pending') throw new FinanceError('WRONG_STATE', r.status === 'posted' ? 'This refund has already been booked.' : 'Only a refund that is waiting can be booked.');
      if (r.createdBy !== null && r.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'Another person has to book this refund: you asked for it.');
      const method = await this.methodFor(tx, ctx.companyId, r.methodId, r.currency);
      const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, r.vendorId));
      if (vendor === undefined) throw new FinanceError('NOT_FOUND', 'The vendor does not exist.');
      if (vendor.postingGroupId === null) throw new FinanceError('POSTING_GROUP', `${vendor.legalName} has no posting group.`);
      const [group] = await tx.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, vendor.postingGroupId));
      const credited = r.creditKind === 'advance' ? group?.prepaymentsAccountId : group?.payablesAccountId;
      if (credited === null || credited === undefined) throw new FinanceError('POSTING_GROUP', r.creditKind === 'advance' ? 'The vendor’s posting group has no prepayments account.' : 'The vendor’s posting group has no payables account.');
      const [fs] = await tx.select({ base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId));
      if (fs?.base !== r.currency) throw new FinanceError('FOREIGN_CURRENCY', 'Refunds in another currency than the books’ own are not supported yet.');
      const cents = toCents(r.amount);
      const number = (await this.numbering.assign('vendor_refund', { companyId: ctx.companyId, branchId: null, date: today, document: { kind: 'vendor_refund', id } }, tx)).number;
      const description = `Refund from ${vendor.legalName}: ${r.creditNo}, ${receipt.reference.trim()}`.slice(0, 200);
      const { registerId } = await this.engine.post(
        {
          companyId: ctx.companyId,
          idempotencyKey: `vendor-refund:${id}`,
          postingDate: receipt.receivedOn,
          documentType: 'vendor_refund',
          documentNo: number,
          description,
          currency: r.currency,
          rate: '1',
          rateSource: 'base',
          lines: [
            { accountId: method.glAccountId, debit: r.amount, credit: '0', description, sourceLedger: 'bank', sourceEntryId: method.balancingBankAccountId },
            { accountId: credited, debit: '0', credit: r.amount, description, sourceLedger: 'vendor', sourceEntryId: r.vendorId },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'vendor_refund', id },
          postedBy: 'engine',
        },
        ENGINE,
        tx,
      );
      const entryId = randomUUID();
      await this.ledger.addEntry(tx, { id: entryId, companyId: ctx.companyId, vendorId: r.vendorId, documentType: 'refund', documentNo: number, documentId: id, description, amountCents: cents, currency: r.currency, postingDate: receipt.receivedOn, registerId, idempotencyKey: `vendor-refund:${id}`, createdBy: ctx.actor.id });
      await this.ledger.apply(tx, { companyId: ctx.companyId, vendorId: r.vendorId, creditEntryId: r.creditEntryId, invoiceEntryId: entryId, amountCents: cents, postingDate: receipt.receivedOn, registerId, createdBy: ctx.actor.id });
      const [bank] = await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: method.balancingBankAccountId, glAccountId: method.glAccountId, postingDate: receipt.receivedOn, documentType: 'vendor_refund', documentNo: number, documentId: id, description, amount: r.amount, currency: r.currency, registerId, createdBy: ctx.actor.id }).returning({ id: bankLedgerEntries.id });
      await tx.update(vendorRefunds).set({ status: 'posted', number, reference: receipt.reference.trim().slice(0, 120), receivedOn: receipt.receivedOn, postedBy: ctx.actor.id, postedAt: now, registerId, ledgerEntryId: entryId, bankLedgerEntryId: bank?.id ?? null, updatedAt: now }).where(eq(vendorRefunds.id, id));
      await this.event(tx, ctx, id, 'posted', { data: { number, reference: receipt.reference.trim(), registerId } });
      return { number, registerId };
    });
  }

  /** Takes a booked refund back: the credit it returned is open again and the money is out of the bank's ledger. */
  async reverse(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the refund is reversed.');
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(vendorRefunds).where(and(eq(vendorRefunds.companyId, ctx.companyId), eq(vendorRefunds.id, id))).for('update');
      if (r === undefined) throw new FinanceError('NOT_FOUND', 'That refund does not exist.');
      if (r.status !== 'posted' || r.registerId === null || r.ledgerEntryId === null) throw new FinanceError('NOT_POSTED', 'Only a booked refund can be reversed.');
      const today = businessDate(now);
      await this.ledger.unapplyAll(tx, { companyId: ctx.companyId, entryId: r.ledgerEntryId, postingDate: today, reasonText: text.slice(0, 500), createdBy: ctx.actor.id });
      const reversal = await this.engine.reverse({ companyId: ctx.companyId, registerId: r.registerId, postingDate: today, reasonCode: 'vendor_refund_reversed', reasonText: text.slice(0, 500), origin: ctx.origin, permissions: ENGINE, tx });
      await this.ledger.reverseEntry(tx, { companyId: ctx.companyId, entryId: r.ledgerEntryId, postingDate: today, reasonText: text.slice(0, 500), registerId: reversal.registerId, createdBy: ctx.actor.id });
      const [orig] = await tx.select().from(bankLedgerEntries).where(eq(bankLedgerEntries.id, r.bankLedgerEntryId ?? -1));
      if (orig !== undefined) {
        await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: orig.bankAccountId, glAccountId: orig.glAccountId, postingDate: today, documentType: 'vendor_refund_reversal', documentNo: orig.documentNo, documentId: id, description: `Reversed: ${orig.description ?? ''}`.slice(0, 200), amount: fromCents(-toCents(orig.amount)), currency: orig.currency, registerId: reversal.registerId, reversesEntryId: orig.id, createdBy: ctx.actor.id });
      }
      await tx.update(vendorRefunds).set({ status: 'reversed', reversedBy: ctx.actor.id, reversedAt: now, reverseReason: text.slice(0, 500), reversalRegisterId: reversal.registerId, updatedAt: now }).where(eq(vendorRefunds.id, id));
      await this.event(tx, ctx, id, 'reversed', { reason: text.slice(0, 500) });
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async list(companyId: string, f: { vendorId?: string; status?: string } = {}, limit = 100) {
    const rows = await this.db
      .select({ r: vendorRefunds, vendor: vendors.legalName })
      .from(vendorRefunds)
      .innerJoin(vendors, eq(vendors.id, vendorRefunds.vendorId))
      .where(and(eq(vendorRefunds.companyId, companyId), has(f.vendorId) ? eq(vendorRefunds.vendorId, f.vendorId) : undefined, has(f.status) ? eq(vendorRefunds.status, f.status as 'pending') : undefined))
      .orderBy(desc(vendorRefunds.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(({ r, vendor }) => ({ id: r.id, number: r.number, status: r.status, vendorId: r.vendorId, vendor, creditNo: r.creditNo, creditKind: r.creditKind, amount: r.amount, currency: r.currency, reference: r.reference, receivedOn: r.receivedOn, createdAt: r.createdAt.toISOString() }));
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ r: vendorRefunds, vendor: vendors.legalName, method: paymentMethods.name })
      .from(vendorRefunds)
      .innerJoin(vendors, eq(vendors.id, vendorRefunds.vendorId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, vendorRefunds.methodId))
      .where(and(eq(vendorRefunds.companyId, companyId), eq(vendorRefunds.id, id)));
    if (head === undefined) return null;
    const events = await this.db.select().from(vendorRefundEvents).where(eq(vendorRefundEvents.refundId, id)).orderBy(desc(vendorRefundEvents.id)).limit(100);
    const ids = [...new Set([head.r.createdBy, head.r.postedBy, ...events.map((e) => e.actorId)].filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    const names = new Map((ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? 'Someone'));
    const { r } = head;
    return {
      refund: { id: r.id, number: r.number, status: r.status, vendorId: r.vendorId, creditNo: r.creditNo, creditKind: r.creditKind, amount: r.amount, currency: r.currency, note: r.note, reference: r.reference, receivedOn: r.receivedOn, cancelReason: r.cancelReason, reverseReason: r.reverseReason, createdBy: r.createdBy, createdAt: r.createdAt.toISOString() },
      vendor: head.vendor,
      method: head.method,
      createdName: who(r.createdBy),
      postedName: who(r.postedBy),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }
}

