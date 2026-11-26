import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { counterReturns, creditNotes, orders, paymentMethods, refundRequests, returnReceiptLines } from '@/server/db/drizzle/schema';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { withAfterCommit } from '@/server/kernel/after-commit';
import { FinanceError } from '@/server/domains/finance/errors';
import { CreditNoteError } from '@/server/domains/credit-notes/service';
import { ReturnError } from '@/server/domains/returns/return-receipt-service';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import type { ShiftService } from '../shifts/shift-service';
import type { getContainer } from '@/server/di/container';

export interface CounterReturnInput {
  orderId: string;
  lines: { productId: string; quantity: number }[];
  /** A general reason (the company's list) and what the person says about it. */
  reason: { code: string; text: string };
  /** The goods are in a state to be sold again and go back into stock. */
  restock: boolean;
  /** Where they are counted back, when it is not the default place (a sale made from a van goes back on that van). */
  backTo?: string;
  /** How the customer is paid back: a method that can pay refunds. Cash is handed over at the till; M-Pesa needs the number. */
  refund: { methodId: string; phone: string; /** Cash: who takes the money (the customer's name when left empty). */ recipient?: string };
  /** One key for one return, made when the screen starts it: a repeat finds the return and finishes what is left. */
  key: string;
}

export interface ReturnSummary {
  returnId: string;
  orderNumber: string;
  creditNoteNo: string;
  amount: number;
  restock: boolean;
  stockBack: boolean;
  status: 'credited' | 'refund_pending' | 'refund_approved' | 'completed';
  refundNumber: string | null;
  refundStatus: string | null;
  cashPaid: number;
  /** What is left to do, in words, when the return is not finished. */
  next: string | null;
}

export type CounterReturnResult = { ok: true; ret: ReturnSummary } | { ok: false; error: string; /** The return exists and can be finished with the same key. */ unfinished?: { returnId: string } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const duplicate = (error: unknown): boolean => `${error instanceof Error ? error.message : ''} ${String((error as { cause?: unknown }).cause)}`.includes('duplicate key');
const wordsOf = (error: unknown): string | null => (error instanceof FinanceError || error instanceof CreditNoteError || error instanceof ReturnError || error instanceof ReasonError ? error.message : null);

/**
 * A return at the till (a void is a return, never an edit): a credit note corrects the tax invoice, the goods go back into stock when
 * they are fit to be sold, and the money goes back to the customer through the refund flow (so its approvals, limits and books apply):
 * cash is handed over at the till, out of the person's open shift. Every step is safe to run again with the same key, so a return that
 * stopped part way is finished from where it was and nothing is credited, restocked or paid twice.
 */
export class CounterReturnService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly shifts: ShiftService,
    private readonly lazy: () => Promise<ReturnType<typeof getContainer>>,
  ) {}

  /** What a sale still lets be returned (lines not yet credited) and whether it can be returned at all. */
  async returnable(_companyId: string, orderId: string): Promise<{ ok: true; orderNumber: string; customerName: string; lines: { productId: string; description: string; unitPrice: number; soldQuantity: number; remainingQuantity: number }[] } | { ok: false; error: string }> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (order?.salesModule !== 'pos_cash_sale') return { ok: false, error: 'That counter sale could not be found.' };
    if (!['paid', 'reconciled', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) return { ok: false, error: 'Only a counter sale that was paid can be returned.' };
    const c = await this.lazy();
    try {
      const creditable = await c.creditNotes.creditableForOrder(orderId);
      if (!creditable.hasTaxInvoice) return { ok: false, error: 'This sale has no receipt yet, so it cannot be returned. Finish its payment first.' };
      const lines = creditable.lines.filter((l) => l.remainingQuantity > 0).map((l) => ({ productId: l.productId, description: l.description, unitPrice: l.unitPrice, soldQuantity: l.soldQuantity, remainingQuantity: l.remainingQuantity }));
      if (lines.length === 0) return { ok: false, error: 'Everything on this sale has already been returned.' };
      return { ok: true, orderNumber: order.orderNumber, customerName: order.customerName, lines };
    } catch (error) {
      const words = wordsOf(error);
      if (words !== null) return { ok: false, error: words };
      throw error;
    }
  }

  /** The ways of paying a customer back at the till: cash, or M-Pesa to a number. */
  private async refundMethod(companyId: string, methodId: string) {
    const [m] = await this.db.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.id, methodId), eq(paymentMethods.enabled, true))).limit(1);
    if (m === undefined || !m.usableFor.includes('customer_refund') || m.refundDestination === 'none') return null;
    if (m.kind !== 'cash' && m.kind !== 'mobile_money') return null;
    return m;
  }

  async run(companyId: string, who: { userId: string }, input: CounterReturnInput): Promise<CounterReturnResult> {
    if (!UUID.test(input.key)) return { ok: false, error: 'This return could not be told apart from another. Start it again.' };
    const c = await this.lazy();
    const [order] = await this.db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
    if (order?.salesModule !== 'pos_cash_sale') return { ok: false, error: 'That counter sale could not be found.' };
    const method = await this.refundMethod(companyId, input.refund.methodId);
    if (method === null) return { ok: false, error: 'Choose how the customer is paid back: cash, or M-Pesa to their number.' };
    const phone = input.refund.phone.trim();
    if (method.kind === 'mobile_money' && phone === '') return { ok: false, error: 'Enter the M-Pesa number the refund is sent to.' };

    let [row] = await this.db.select().from(counterReturns).where(eq(counterReturns.idempotencyKey, input.key)).limit(1);
    if (row !== undefined && (row.requestedBy !== who.userId || row.companyId !== companyId)) return { ok: false, error: 'This return could not be told apart from another. Start it again.' };

    if (row === undefined) {
      // A cash refund comes out of the person's own open shift: check that first, so nothing is credited that cannot be paid.
      if (method.kind === 'cash') {
        const shift = await this.shifts.openForSale(companyId, who.userId);
        if (!shift.ok) return { ok: false, error: shift.error };
      }
      const returnable = await this.returnable(companyId, input.orderId);
      if (!returnable.ok) return returnable;
      if (input.lines.length === 0) return { ok: false, error: 'Choose what is being returned.' };
      for (const line of input.lines) {
        const have = returnable.lines.find((l) => l.productId === line.productId);
        if (have === undefined) return { ok: false, error: 'One of the lines is not on this sale, or has already been returned.' };
        if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > have.remainingQuantity) return { ok: false, error: `${have.description}: at most ${String(have.remainingQuantity)} can still be returned.` };
      }
      try {
        const reason = await c.reasonCodes.require(companyId, { code: input.reason.code, text: input.reason.text }, 'refund');
        row = await withAfterCommit(this.db, async (tx) => {
          const cn = await c.creditNotes.issueForOrder({ orderId: input.orderId, lines: input.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), reason: { code: input.restock ? 'returned_goods' : 'damaged_goods', note: reason.text ?? reason.code }, issuedBy: who.userId, restock: input.restock }, tx);
          const [made] = await tx.insert(counterReturns).values({ companyId, orderId: input.orderId, idempotencyKey: input.key, creditNoteId: cn.id, requestedBy: who.userId, reasonCode: reason.code, reasonText: reason.text, restock: input.restock, restockLocationId: input.backTo ?? null, refundMethodId: method.id, payoutDetails: method.kind === 'mobile_money' ? { phone } : { recipientName: (input.refund.recipient ?? '').trim() === '' ? order.customerName : (input.refund.recipient ?? '').trim().slice(0, 80) }, amount: cn.totalAmount, lines: input.lines }).returning();
          if (made === undefined) throw new CreditNoteError('NOT_FOUND', 'The return could not be recorded.');
          return made;
        });
      } catch (error) {
        if (duplicate(error)) {
          [row] = await this.db.select().from(counterReturns).where(eq(counterReturns.idempotencyKey, input.key)).limit(1);
        } else {
          const words = wordsOf(error);
          if (words !== null) return { ok: false, error: words };
          console.error('[counter return] the credit note was not made', error);
          return { ok: false, error: 'The return could not be made just now. Nothing was credited. Please try again.' };
        }
      }
    }
    if (row === undefined) return { ok: false, error: 'The return could not be found.' };
    return await this.finish(companyId, who.userId, row.id);
  }

  /** Runs what is left of a return: goods back into stock, the refund asked for and approved, and (cash) handed over from the open shift. */
  async finish(companyId: string, userId: string, returnId: string): Promise<CounterReturnResult> {
    const c = await this.lazy();
    const [row] = await this.db.select().from(counterReturns).where(and(eq(counterReturns.id, returnId), eq(counterReturns.companyId, companyId))).limit(1);
    if (row === undefined) return { ok: false, error: 'That return could not be found.' };
    const stop = (error: unknown, what: string): CounterReturnResult => {
      const words = wordsOf(error);
      if (words === null) console.error(`[counter return] ${what}`, returnId, error);
      return { ok: false, error: words ?? `The return was credited, but ${what} could not be finished just now. Press Finish return to try again: nothing will be done twice.`, unfinished: { returnId } };
    };
    const ctx = { companyId, actor: { type: 'user' as const, id: userId }, origin: { surface: 'sales/counter-return', action: 'finish' } };
    const [cn] = await this.db.select().from(creditNotes).where(eq(creditNotes.id, row.creditNoteId ?? '')).limit(1);
    if (cn === undefined) return { ok: false, error: 'The credit note of this return could not be found.' };

    // Goods back into stock: counted in as they were sold, in good condition.
    if (row.restock && !row.stockBack) {
      try {
        const receipt = (await c.returns.forCreditNotes([cn.id])).get(cn.id);
        if (receipt !== undefined) {
          const lines = await this.db.select().from(returnReceiptLines).where(eq(returnReceiptLines.receiptId, receipt.id));
          const open = lines.filter((l) => l.expectedQty - l.receivedQty > 0);
          if (open.length > 0) await c.returns.confirm({ companyId, actorId: userId, origin: ctx.origin }, receipt.id, open.map((l) => ({ lineId: l.id, quantity: l.expectedQty - l.receivedQty, condition: 'good' as const, disposition: 'return_to_stock' as const, ...(row.restockLocationId === null ? {} : { locationId: row.restockLocationId }) })));
        }
        await this.db.update(counterReturns).set({ stockBack: true, updatedAt: new Date() }).where(eq(counterReturns.id, row.id));
      } catch (error) {
        return stop(error, 'putting the goods back into stock');
      }
    }

    // The refund asked for and sent on: it is approved at once, or waits for the approvers the company set up.
    let refundId = row.refundId;
    const method = row.refundMethodId === null ? null : await this.refundMethod(companyId, row.refundMethodId);
    if (method === null) return { ok: false, error: 'The way of paying the customer back is no longer available. Ask finance to refund this credit note.', unfinished: { returnId } };
    if (refundId === null) {
      try {
        const [order] = await this.db.select({ customerId: orders.tradeCustomerId, isWalkIn: sql<boolean>`COALESCE((SELECT c.is_walk_in FROM customers c WHERE c.id = ${orders.tradeCustomerId}), false)` }).from(orders).where(eq(orders.id, row.orderId)).limit(1);
        if (order?.customerId === null || order === undefined) return { ok: false, error: 'This sale has no customer record to refund.', unfinished: { returnId } };
        const made = await c.finance.refunds.create(ctx, { customerId: order.customerId, sourceKind: 'credit_note_excess', sourceId: cn.id, amount: row.amount, paymentMethodId: method.id, payoutDetails: row.payoutDetails, reasonCode: row.reasonCode, reasonText: row.reasonText, idempotencyKey: `counter-return:${row.idempotencyKey}`, sharedCustomer: order.isWalkIn });
        refundId = made.id;
        await this.db.update(counterReturns).set({ refundId, updatedAt: new Date() }).where(eq(counterReturns.id, row.id));
        await c.finance.refunds.submit(ctx, made.id);
      } catch (error) {
        return stop(error, 'asking for the refund');
      }
    }
    const [refund] = await this.db.select().from(refundRequests).where(eq(refundRequests.id, refundId)).limit(1);
    if (refund?.status === 'draft') {
      try {
        await c.finance.refunds.submit(ctx, refundId);
      } catch (error) {
        return stop(error, 'sending the refund on');
      }
    }

    // Approved, and cash: handed over now, out of the person's open shift, with the till's record in the same transaction.
    const current = (await this.db.select().from(refundRequests).where(eq(refundRequests.id, refundId)).limit(1))[0];
    if (current?.status === 'approved' && method.kind === 'cash' && Number(row.cashPaid) === 0) {
      const shift = await this.shifts.openForSale(companyId, userId);
      if (!shift.ok) return { ok: false, error: `${shift.error} The cash is handed back from an open shift.`, unfinished: { returnId } };
      try {
        await this.db.transaction(async (tx) => {
          await c.finance.refunds.recordPayoutIn(tx, ctx, current.id, { paidFromMethodId: method.id, payoutDate: businessDate(), reference: cn.creditNoteNo, evidenceSatisfied: true });
          await tx.update(counterReturns).set({ cashPaid: row.amount, shiftId: shift.shiftId, status: 'completed', updatedAt: new Date() }).where(eq(counterReturns.id, row.id));
        });
      } catch (error) {
        return stop(error, 'handing the cash back');
      }
    } else {
      const status = current?.status === 'approved' ? 'refund_approved' : 'refund_pending';
      if (row.status !== status && row.status !== 'completed') await this.db.update(counterReturns).set({ status, updatedAt: new Date() }).where(eq(counterReturns.id, row.id));
    }
    return { ok: true, ret: await this.summary(returnId) };
  }

  async summary(returnId: string): Promise<ReturnSummary> {
    const [row] = await this.db.select().from(counterReturns).where(eq(counterReturns.id, returnId)).limit(1);
    if (row === undefined) throw new ReturnError('NOT_FOUND', 'That return could not be found.');
    const [[order], [cn], [refund]] = await Promise.all([
      this.db.select({ number: orders.orderNumber }).from(orders).where(eq(orders.id, row.orderId)).limit(1),
      this.db.select({ no: creditNotes.creditNoteNo }).from(creditNotes).where(eq(creditNotes.id, row.creditNoteId ?? '')).limit(1),
      this.db.select({ number: refundRequests.number, status: refundRequests.status }).from(refundRequests).where(eq(refundRequests.id, row.refundId ?? '')).limit(1),
    ]);
    let next: string | null = null;
    if (row.status === 'refund_pending') next = 'The refund is waiting for approval. Once it is approved, press Finish return to hand over the money.';
    else if (row.status === 'refund_approved') next = refund === undefined || row.cashPaid !== '0.00' ? null : 'The refund is approved and still to be paid: finance pays it, or press Finish return to hand the cash over from your open shift.';
    return { returnId: row.id, orderNumber: order?.number ?? '', creditNoteNo: cn?.no ?? '', amount: Number(row.amount), restock: row.restock, stockBack: row.stockBack, status: row.status, refundNumber: refund?.number ?? null, refundStatus: refund?.status ?? null, cashPaid: Number(row.cashPaid), next };
  }

  /** The returns of one counter sale, newest first (for the sale's receipt screen). */
  async ofSale(companyId: string, orderId: string): Promise<ReturnSummary[]> {
    const rows = await this.db.select({ id: counterReturns.id }).from(counterReturns).where(and(eq(counterReturns.companyId, companyId), eq(counterReturns.orderId, orderId))).orderBy(desc(counterReturns.createdAt));
    return await Promise.all(rows.map(async (r) => await this.summary(r.id)));
  }

  /** Returns not yet finished, for the person (or everyone, with the right): refund pending approval, or approved and waiting for the cash to go. */
  async unfinished(companyId: string, input: { userId?: string }): Promise<{ returnId: string; orderNumber: string; amount: number; status: string }[]> {
    const rows = await this.db
      .select({ id: counterReturns.id, orderId: counterReturns.orderId, amount: counterReturns.amount, status: counterReturns.status })
      .from(counterReturns)
      .where(and(eq(counterReturns.companyId, companyId), inArray(counterReturns.status, ['credited', 'refund_pending', 'refund_approved']), input.userId === undefined ? undefined : eq(counterReturns.requestedBy, input.userId)))
      .orderBy(desc(counterReturns.createdAt))
      .limit(50);
    if (rows.length === 0) return [];
    const numbers = await this.db.select({ id: orders.id, number: orders.orderNumber }).from(orders).where(inArray(orders.id, rows.map((r) => r.orderId)));
    return rows.map((r) => ({ returnId: r.id, orderNumber: numbers.find((n) => n.id === r.orderId)?.number ?? '', amount: Number(r.amount), status: r.status }));
  }
}
