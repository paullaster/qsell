import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { purchaseOrders, vendorAdvancePayments, vendorBankAccounts, type VendorAdvancePaymentRow } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { advanceCeiling, checkAdvance } from '@/lib/purchase-order';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorNotifier } from './notifier';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const LIVE = ['draft', 'pending_approval', 'approved', 'paid'] as const;
/** The statuses of an order in which an advance may be asked for: it has been released. */
const RELEASED = ['approved', 'sent', 'confirmed'] as const;

/**
 * The advance payment document (design doc §9.4). An order that requires an advance has one document, written by one person,
 * approved by another, with the vendor's bank account fixed at approval. It is the only thing that lets an advance be paid (the
 * payment voucher must reference it, V-7), and its being approved or paid is what lets a supplier invoice without a delivery note
 * be accepted (V-6, `hasCover`).
 */
export class AdvancePaymentService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly notify?: VendorNotifier,
  ) {}

  private async lock(tx: Tx, companyId: string, id: string): Promise<VendorAdvancePaymentRow> {
    const [a] = await tx.select().from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.companyId, companyId), eq(vendorAdvancePayments.id, id))).for('update');
    if (a === undefined) throw new FinanceError('NOT_FOUND', 'That advance payment does not exist.');
    return a;
  }

  async create(ctx: FinanceContext, poId: string, input: { amount: string; dueDate: string; reason: string }): Promise<{ id: string }> {
    return await this.db.transaction(async (tx) => {
      const [po] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, ctx.companyId), eq(purchaseOrders.id, poId))).for('update');
      if (po === undefined) throw new FinanceError('NOT_FOUND', 'That purchase order does not exist.');
      if (!po.requiresAdvancePayment) throw new FinanceError('NOT_FLAGGED', 'This order is not flagged as requiring an advance payment. Someone allowed to flag it must do that first.');
      if (!(RELEASED as readonly string[]).includes(po.status)) throw new FinanceError('NOT_RELEASED', 'An advance is asked for once the order is approved.');
      const [live] = await tx.select({ id: vendorAdvancePayments.id }).from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.poId, poId), inArray(vendorAdvancePayments.status, [...LIVE])));
      if (live !== undefined) throw new FinanceError('ALREADY', 'This order already has an advance payment document.');
      const problems = checkAdvance(input.amount, advanceCeiling(Math.round(Number(po.total) * 100), 0), input.dueDate, input.reason);
      const first = Object.values(problems)[0];
      if (has(first)) throw new FinanceError('INVALID', first);
      const [made] = await tx.insert(vendorAdvancePayments).values({ companyId: ctx.companyId, poId, vendorId: po.vendorId, amount: Number(input.amount).toFixed(2), currency: po.currency, dueDate: trimToNull(input.dueDate), reason: input.reason.trim().slice(0, 500), createdBy: ctx.actor.id }).returning({ id: vendorAdvancePayments.id });
      if (made === undefined) throw new FinanceError('NOT_SAVED', 'The advance payment could not be saved.');
      return made;
    });
  }

  async submit(ctx: FinanceContext, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const a = await this.lock(tx, ctx.companyId, id);
      if (a.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'This advance payment was already sent for approval.');
      if (a.createdBy !== ctx.actor.id) throw new FinanceError('NOT_YOURS', 'Only the person who wrote it sends it for approval.');
      await tx.update(vendorAdvancePayments).set({ status: 'pending_approval', updatedAt: new Date() }).where(eq(vendorAdvancePayments.id, id));
    });
  }

  /** A person other than the writer approves; the vendor's bank account that will be paid is fixed here. */
  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    const d = await this.db.transaction(async (tx) => {
      const a = await this.lock(tx, ctx.companyId, id);
      if (a.status !== 'pending_approval') throw new FinanceError('NOT_PENDING', 'This advance payment is not waiting for approval.');
      if (a.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'You wrote this advance payment, so someone else must approve it.');
      const [bank] = await tx.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, a.vendorId), eq(vendorBankAccounts.status, 'active'))).orderBy(asc(vendorBankAccounts.createdAt)).limit(1);
      if (bank === undefined) throw new FinanceError('NO_BANK_ACCOUNT', 'The vendor has no bank account in use to be paid into.');
      const [po] = await tx.select({ number: purchaseOrders.number, status: purchaseOrders.status, total: purchaseOrders.total }).from(purchaseOrders).where(eq(purchaseOrders.id, a.poId));
      if (po === undefined || !(RELEASED as readonly string[]).includes(po.status)) throw new FinanceError('NOT_RELEASED', 'The order is no longer open for an advance.');
      if (Number(a.amount) > Number(po.total)) throw new FinanceError('INVALID', 'The advance is now more than the order total.');
      await tx.update(vendorAdvancePayments).set({ status: 'approved', approvedBy: ctx.actor.id, approvedAt: now, bankAccountId: bank.id, updatedAt: now }).where(eq(vendorAdvancePayments.id, id));
      return { vendorId: a.vendorId, number: po.number ?? '', amount: a.amount, currency: a.currency };
    });
    await this.notify?.advanceApproved(d.vendorId, d.number, d.amount, d.currency);
  }

  async reject(ctx: FinanceContext, id: string, reason: string): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why it is sent back.');
    await this.db.transaction(async (tx) => {
      const a = await this.lock(tx, ctx.companyId, id);
      if (a.status !== 'pending_approval') throw new FinanceError('NOT_PENDING', 'This advance payment is not waiting for approval.');
      if (a.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'You wrote this advance payment; withdraw it instead.');
      await tx.update(vendorAdvancePayments).set({ status: 'draft', decisionNote: text.slice(0, 500), updatedAt: new Date() }).where(eq(vendorAdvancePayments.id, id));
    });
  }

  async cancel(ctx: FinanceContext, id: string, reason: string): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why it is cancelled.');
    await this.db.transaction(async (tx) => {
      const a = await this.lock(tx, ctx.companyId, id);
      if (a.status === 'paid') throw new FinanceError('ALREADY_PAID', 'It was paid. Ask the vendor to refund it, or apply it to an invoice.');
      if (!(['draft', 'pending_approval', 'approved'] as string[]).includes(a.status)) throw new FinanceError('NOT_ALLOWED', 'This advance payment cannot be cancelled.');
      await tx.update(vendorAdvancePayments).set({ status: 'cancelled', decisionNote: text.slice(0, 500), updatedAt: new Date() }).where(eq(vendorAdvancePayments.id, id));
    });
  }

  /**
   * The payment voucher that paid it calls this (V-7), naming itself. Only an approved document can be paid, and only once: a second
   * voucher is refused here, so the document cannot be paid twice.
   */
  async recordPayment(companyId: string, id: string, voucherId: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const a = await this.lock(tx, companyId, id);
      if (a.status !== 'approved') throw new FinanceError('NOT_APPROVED', a.status === 'paid' ? 'This advance payment was already paid by another voucher.' : 'Only an approved advance payment can be paid.');
      await tx.update(vendorAdvancePayments).set({ status: 'paid', voucherId, paidAt: now, updatedAt: now }).where(eq(vendorAdvancePayments.id, id));
    });
  }

  /**
   * Is an invoice for this order without any delivery note allowed? Only when the order is flagged and an advance document for it is
   * approved or paid. The answer carries the reason, so the vendor portal can say exactly what is missing.
   */
  async hasCover(poId: string): Promise<{ ok: boolean; reason: string }> {
    const [po] = await this.db.select({ flagged: purchaseOrders.requiresAdvancePayment }).from(purchaseOrders).where(eq(purchaseOrders.id, poId));
    if (po === undefined) return { ok: false, reason: 'That order does not exist.' };
    if (!po.flagged) return { ok: false, reason: 'This order was not set up to require an advance payment, so an invoice needs a delivery note.' };
    const [doc] = await this.db.select({ status: vendorAdvancePayments.status }).from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.poId, poId), inArray(vendorAdvancePayments.status, ['approved', 'paid'])));
    if (doc === undefined) return { ok: false, reason: 'No approved advance payment exists for this order yet, so an invoice needs a delivery note.' };
    return { ok: true, reason: `An advance payment of the order is ${doc.status}.` };
  }

  async list(companyId: string, status?: string) {
    return await this.db
      .select({ a: vendorAdvancePayments, number: purchaseOrders.number })
      .from(vendorAdvancePayments)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, vendorAdvancePayments.poId))
      .where(and(eq(vendorAdvancePayments.companyId, companyId), status === undefined ? inArray(vendorAdvancePayments.status, ['pending_approval', 'approved']) : eq(vendorAdvancePayments.status, status as VendorAdvancePaymentRow['status'])))
      .orderBy(desc(vendorAdvancePayments.createdAt))
      .limit(100);
  }
}
