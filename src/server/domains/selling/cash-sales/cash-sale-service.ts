import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, invoiceDocuments, orderItems, orders, orderTenders, paymentMethods, shifts } from '@/server/db/drizzle/schema';
import { OrderStages } from '@/server/domains/orders/stages';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { PlaceExtra, SalesOrderService } from '../sales-order-service';
import type { SalesOrderLineInput } from '../domain/sales-order-input';
import type { ShiftService } from '../shifts/shift-service';
import { lineDiscount } from './till-rules';
import { planTenders, TENDER_KINDS, type TenderKind, type TenderPlan, type TenderRequest } from './tender-rules';
import { lineOrder } from '@/server/domains/orders/line-order';

export class CashSaleError extends Error {}

export interface CashSaleInput {
  /** Empty: the company's walk-in customer. */
  customerId: string | null;
  lines: SalesOrderLineInput[];
  tenders: { methodId: string; amount: number; reference: string }[];
  /** One key for one attempt at one sale: a retry of the same sale (the connection dropped, the button pressed twice) finds the order it made. */
  saleKey: string;
  /** A sale rung up offline: the prices the customer paid (accepted as they are), and that it was sold already. */
  offline?: { quotedItems: NonNullable<PlaceExtra['quotedItems']>; quotedTotals: NonNullable<PlaceExtra['quotedTotals']> };
  /** A sale made from a quote: the quote's prices stand and the order keeps the quote it came from. */
  fromQuote?: { quoteId: string; quotedItems: NonNullable<PlaceExtra['quotedItems']>; quotedTotals: NonNullable<PlaceExtra['quotedTotals']> };
}

export interface SaleSummary {
  orderId: string;
  orderNumber: string;
  /** The till receipt: the sale's signed tax invoice, numbered from the POS receipt series. Null until it has been made. */
  receiptNumber: string | null;
  total: number;
  changeDue: number;
  customerName: string;
  /** When the sale was made (ISO), and what was sold: the lines of the printed receipt. */
  at: string;
  /** Each line as charged, and what it was discounted by (0 when it was not): a discount typed at the counter or one a rule gave. */
  lines: { name: string; quantity: number; unitPrice: number; total: number; discount: number }[];
  /** What the whole sale was discounted by (the lines' discounts added up; 0 when there was none). */
  discount: number;
  tenders: { label: string; kind: TenderKind; applied: number; handedOver: number | null; reference: string | null }[];
  /** Set when the sale is paid but something after that could not be finished (the books are posted again by the next attempt). */
  warning?: string;
}

export type CashSaleResult = { ok: true; sale: SaleSummary } | { ok: false; error: string; /** The sale was rung up but its payment was not recorded: it can be finished with the same key. */ unfinished?: { orderId: string; orderNumber: string } };

/** The walk-in customer's address: nobody's, so no mail can reach anyone, and the order writer finds this record (it looks customers up by address) instead of making another. */
export const WALK_IN_EMAIL = 'walk-in@walk-in.invalid';
const TENDER_ORDER: TenderKind[] = ['mobile_money', 'card', 'cash'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const duplicate = (error: unknown): boolean => `${error instanceof Error ? error.message : ''} ${String((error as { cause?: unknown }).cause)}`.includes('duplicate key');

/**
 * Counter sales: a sale rung up in the person's own open shift, paid at once in cash, M-Pesa or card (one or several), with change from
 * the cash, and a receipt that is the signed tax invoice on the POS series. The order and its stock are one transaction (the order
 * writer's); the payment is recorded after, in one transaction of its own, keyed so that repeating it changes nothing. A sale whose
 * payment could not be recorded is told as such and finished with the same key; the shift cannot be closed while one is waiting.
 */
export class CashSaleService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly shifts: ShiftService,
    private readonly salesOrders: SalesOrderService,
    private readonly lazy: () => Promise<{ customers: { saveCustomer: (companyId: string, input: never) => Promise<{ id: string }>; applyOrderPayment: (orderId: string) => Promise<void> }; invoices: { generatePdf: (orderId: string, kind: 'tax_invoice') => Promise<unknown> } }>,
  ) {}

  /** The company's walk-in customer, made the first time it is needed. */
  async walkIn(companyId: string): Promise<string> {
    const find = async () => (await this.db.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, companyId), eq(customers.isWalkIn, true))).limit(1))[0]?.id;
    const existing = await find();
    if (existing !== undefined) return existing;
    const { customers: master } = await this.lazy();
    try {
      const made = await master.saveCustomer(companyId, { name: 'Walk-in customer', email: WALK_IN_EMAIL, accountType: 'cash', creditLimit: 0, paymentTermDays: 0, transmitInvoicesToKra: true } as never);
      await this.db.update(customers).set({ isWalkIn: true }).where(eq(customers.id, made.id));
      return made.id;
    } catch (error) {
      if (!duplicate(error)) throw error;
      const raced = await find();
      if (raced === undefined) throw error;
      return raced;
    }
  }

  /** The ways of paying a till in this branch may use (for the offline till's snapshot): the same rule as completing a sale. */
  async tenderMethods(companyId: string, branchId: string): Promise<{ id: string; name: string; kind: TenderKind; requiresReference: boolean }[]> {
    const rows = await this.db
      .select({ id: paymentMethods.id, name: paymentMethods.name, kind: paymentMethods.kind, requiresReference: paymentMethods.requiresReference })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), inArray(paymentMethods.kind, [...TENDER_KINDS]), isNotNull(paymentMethods.balancingBankAccountId), or(isNull(paymentMethods.branchId), eq(paymentMethods.branchId, branchId)), sql`${paymentMethods.usableFor} @> '["customer_receipt"]'::jsonb`))
      .orderBy(paymentMethods.sortOrder, paymentMethods.name);
    return rows.map((r) => ({ ...r, kind: r.kind as TenderKind }));
  }

  /** The ways of paying this till may use: switched on, paying into a real cash or bank account, for cash, M-Pesa or card, in this branch or every branch. */
  private async methodsFor(companyId: string, branchId: string, ids: string[]) {
    if (ids.length === 0) return [];
    return await this.db
      .select({ id: paymentMethods.id, name: paymentMethods.name, kind: paymentMethods.kind, requiresReference: paymentMethods.requiresReference })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.companyId, companyId), inArray(paymentMethods.id, ids), eq(paymentMethods.enabled, true), inArray(paymentMethods.kind, [...TENDER_KINDS]), isNotNull(paymentMethods.balancingBankAccountId), or(isNull(paymentMethods.branchId), eq(paymentMethods.branchId, branchId)), sql`${paymentMethods.usableFor} @> '["customer_receipt"]'::jsonb`));
  }

  /** What these lines would total, priced as the sale will be. */
  async price(companyId: string, who: { userId: string; branchId: string | null }, input: { customerId: string | null; lines: SalesOrderLineInput[] }): Promise<{ ok: true; subtotal: number; tax: number; total: number; lines: { productId: string; quantity: number; unitPrice: number; lineTotal: number }[] } | { ok: false; error: string }> {
    if (input.lines.length === 0) return { ok: false, error: 'Add something to sell.' };
    const customerId = input.customerId ?? (await this.walkIn(companyId));
    return await this.salesOrders.price(companyId, who, { customerId, lines: input.lines, paymentMethod: 'counter', neededOn: '', holdUntilPaid: false }, 'pos_cash_sale');
  }

  async complete(companyId: string, who: { userId: string; branchId: string | null }, input: CashSaleInput): Promise<CashSaleResult> {
    if (!UUID.test(input.saleKey)) return { ok: false, error: 'This sale could not be told apart from another. Start the sale again.' };
    if (input.tenders.length === 0) return { ok: false, error: 'Choose how the customer pays.' };

    // A repeat of a sale already rung up finds it (and finishes its payment if that is all that is left).
    const [made] = await this.db.select({ order: orders, openedBy: shifts.openedBy }).from(orders).innerJoin(shifts, eq(shifts.id, orders.shiftId)).where(eq(orders.idempotencyKey, input.saleKey)).limit(1);
    const taken = made;
    if (taken !== undefined && taken.openedBy !== who.userId) return { ok: false, error: 'This sale could not be told apart from another. Start the sale again.' };

    const shift = await this.shifts.openForSale(companyId, who.userId);
    if (!shift.ok && taken === undefined) return { ok: false, error: shift.error };
    const branchId = shift.ok ? shift.branchId : (taken?.order.branchId ?? '');
    const found = await this.methodsFor(companyId, branchId, input.tenders.map((t) => t.methodId));
    const requests: TenderRequest[] = [];
    for (const t of input.tenders) {
      const method = found.find((m) => m.id === t.methodId);
      if (method === undefined) return { ok: false, error: 'One of the ways of paying is not available at this till.' };
      const reference = t.reference.trim().slice(0, 60);
      if (method.requiresReference && reference === '') return { ok: false, error: `Enter the reference for ${method.name} (the M-Pesa code or the card slip number).` };
      requests.push({ methodId: method.id, kind: method.kind as TenderKind, amount: t.amount, reference: reference === '' ? null : reference });
    }

    if (taken !== undefined) {
      const plan = planTenders(Number(taken.order.totalAmount), requests);
      if (!plan.ok) return { ok: false, error: plan.error, unfinished: { orderId: taken.order.id, orderNumber: taken.order.orderNumber } };
      return await this.record(companyId, who.userId, taken.order.id, plan, found);
    }
    if (!shift.ok) return { ok: false, error: shift.error };

    const customerId = input.customerId ?? (await this.walkIn(companyId));
    const planned: { plan: TenderPlan | null } = { plan: null };
    const placed = await this.salesOrders.place(
      companyId,
      who,
      { customerId, lines: input.lines, paymentMethod: 'counter', neededOn: '', holdUntilPaid: false },
      'pos_cash_sale',
      {
        shiftId: shift.shiftId,
        idempotencyKey: input.saleKey,
        ...(input.offline === undefined ? {} : { quotedItems: input.offline.quotedItems, quotedTotals: input.offline.quotedTotals, skipOfferedCheck: true }),
        ...(input.fromQuote === undefined ? {} : { quotedItems: input.fromQuote.quotedItems, quotedTotals: input.fromQuote.quotedTotals, skipOfferedCheck: true, sourceQuoteId: input.fromQuote.quoteId }),
        // The payment is checked against the priced total before anything is held or saved: a short payment never makes an unpaid sale.
        checkTotal: (totals) => {
          const worked = planTenders(totals.totalAmount, requests);
          planned.plan = worked;
          return worked.ok ? null : worked.error;
        },
      },
    );
    if (!placed.ok) {
      // Two presses of the same button race: the other one made the sale, so this one finds it.
      const [again] = await this.db.select({ id: orders.id }).from(orders).where(eq(orders.idempotencyKey, input.saleKey)).limit(1);
      if (again !== undefined) return await this.complete(companyId, who, input);
      return { ok: false, error: placed.error };
    }
    const worked = planned.plan;
    if (worked?.ok !== true) return { ok: false, error: 'The payment could not be worked out.', unfinished: { orderId: placed.orderId, orderNumber: placed.orderNumber } };
    return await this.record(companyId, who.userId, placed.orderId, worked, found);
  }

  /** Records the tenders, marks the sale paid and posts it, in one transaction; repeating it records nothing twice. */
  private async record(companyId: string, userId: string, orderId: string, plan: Extract<TenderPlan, { ok: true }>, methods: { id: string; name: string; kind: string }[]): Promise<CashSaleResult> {
    const label = (id: string) => methods.find((m) => m.id === id)?.name ?? 'Payment';
    try {
      await this.db.transaction(async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).for('update');
        if (order === undefined) throw new CashSaleError('That sale could not be found.');
        const [already] = await tx.select({ id: orderTenders.id }).from(orderTenders).where(and(eq(orderTenders.orderId, orderId), eq(orderTenders.kind, 'payment_method'))).limit(1);
        if (already !== undefined) return;
        if (Math.abs(Number(order.totalAmount) - plan.total) > 0.005) throw new CashSaleError('The sale total changed: start the sale again.');
        for (const t of plan.tenders) {
          await tx.insert(orderTenders).values({ orderId, kind: 'payment_method', reference: t.methodId, amount: t.applied.toFixed(2), methodKind: t.kind, handedOver: t.handedOver === null ? null : t.handedOver.toFixed(2), changeDue: t.changeDue === null ? null : t.changeDue.toFixed(2), externalReference: t.reference, actor: userId });
        }
        await tx.update(orders).set({ tenderedAmount: plan.total.toFixed(2), updatedAt: new Date() }).where(eq(orders.id, orderId));
        await OrderStages.moveIn(tx, orderId, 'payment_confirmed', 'succeeded', {
          ref: { type: 'counter_tender', id: orderId },
          source: 'pos',
          actor: { type: 'user', id: userId },
          fields: { transactionReference: `COUNTER-${order.orderNumber}` },
          detail: { tenders: plan.tenders.map((t) => ({ kind: t.kind, amount: t.applied })), changeDue: plan.changeDue },
        });
        await this.decisions.record({ companyId, actor: { type: 'user', id: userId }, subject: { type: 'order', id: orderId }, action: 'cash_sale.paid', from: order.paymentStatus, to: 'paid', outcome: { total: plan.total, changeDue: plan.changeDue, tenders: plan.tenders.map((t) => ({ kind: t.kind, applied: t.applied })) } }, tx);
      });
    } catch (error) {
      if (error instanceof CashSaleError) return { ok: false, error: error.message };
      const [order] = await this.db.select({ number: orders.orderNumber }).from(orders).where(eq(orders.id, orderId)).limit(1);
      console.error('[cash sale] the payment was not recorded', orderId, error);
      return { ok: false, error: 'The sale was rung up but its payment could not be recorded just now. Press Finish payment to try again: nothing will be counted twice.', unfinished: { orderId, orderNumber: order?.number ?? '' } };
    }

    // After the payment is recorded: the books (the cash sale is queued for posting, retried by the posting queue) and the receipt.
    let warning: string | undefined;
    try {
      const { customers: master, invoices } = await this.lazy();
      await master.applyOrderPayment(orderId);
      await invoices.generatePdf(orderId, 'tax_invoice');
    } catch (error) {
      console.error('[cash sale] paid, but the follow-up failed', orderId, error);
      warning = 'The sale is paid, but the receipt or the books could not be updated just now. Press Finish payment to try again.';
    }
    const sale = await this.summary(orderId, label);
    return { ok: true, sale: { ...sale, ...(warning === undefined ? {} : { warning }) } };
  }

  async summary(orderId: string, label?: (id: string) => string): Promise<SaleSummary> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (order === undefined) throw new CashSaleError('That sale could not be found.');
    const tenders = await this.db.select().from(orderTenders).where(and(eq(orderTenders.orderId, orderId), eq(orderTenders.kind, 'payment_method'))).orderBy(orderTenders.createdAt);
    const names = label === undefined && tenders.length > 0 ? await this.db.select({ id: paymentMethods.id, name: paymentMethods.name }).from(paymentMethods).where(inArray(paymentMethods.id, tenders.map((t) => t.reference))) : [];
    const nameOf = (id: string) => label?.(id) ?? names.find((n) => n.id === id)?.name ?? 'Payment';
    const items = await this.db.select({ name: orderItems.productName, quantity: orderItems.quantity, unitPrice: orderItems.unitPrice, total: orderItems.totalPrice, trace: orderItems.priceTrace }).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(...lineOrder);
    const lines = items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: Number(i.unitPrice), total: Number(i.total), discount: lineDiscount(i.quantity, Number(i.total), i.trace) }));
    const [receipt] = await this.db.select({ number: invoiceDocuments.invoiceNumber }).from(invoiceDocuments).where(and(eq(invoiceDocuments.orderId, orderId), eq(invoiceDocuments.documentType, 'tax_invoice'))).limit(1);
    return {
      orderId,
      orderNumber: order.orderNumber,
      receiptNumber: receipt?.number ?? null,
      total: Number(order.totalAmount),
      changeDue: tenders.reduce((n, t) => n + Number(t.changeDue ?? 0), 0),
      customerName: order.customerName,
      at: order.createdAt.toISOString(),
      lines: lines.map(({ name, quantity, unitPrice, total, discount }) => ({ name, quantity, unitPrice, total, discount })),
      discount: Math.round(lines.reduce((n, l) => n + l.discount, 0) * 100) / 100,
      // The exact ways first, the cash (which covers the rest and gives change) last: the order they are read out at the till.
      tenders: [...tenders].sort((x, y) => TENDER_ORDER.indexOf((x.methodKind ?? 'cash') as TenderKind) - TENDER_ORDER.indexOf((y.methodKind ?? 'cash') as TenderKind)).map((t) => ({ label: nameOf(t.reference), kind: t.methodKind as TenderKind, applied: Number(t.amount), handedOver: t.handedOver === null ? null : Number(t.handedOver), reference: t.externalReference })),
    };
  }

  /** Counter sales in a shift (or all of this person's), newest first, 25 a page. */
  async list(companyId: string, input: { shiftId?: string; userId?: string; orderId?: string; cursor?: { k: string; id: string } | null }): Promise<{ rows: { orderId: string; orderNumber: string; receiptNumber: string | null; total: number; customerName: string; at: string; paid: boolean }[]; next: { k: string; id: string } | null }> {
    const rows = await this.db
      .select({ id: orders.id, number: orders.orderNumber, total: orders.totalAmount, customer: orders.customerName, paid: orders.paymentStatus, at: orders.createdAt, key: sql<string>`${orders.createdAt}::text`, receipt: invoiceDocuments.invoiceNumber })
      .from(orders)
      .innerJoin(shifts, eq(shifts.id, orders.shiftId))
      .leftJoin(invoiceDocuments, and(eq(invoiceDocuments.orderId, orders.id), eq(invoiceDocuments.documentType, 'tax_invoice')))
      .where(and(eq(shifts.companyId, companyId), eq(orders.salesModule, 'pos_cash_sale'), input.shiftId === undefined ? undefined : eq(orders.shiftId, input.shiftId), input.userId === undefined ? undefined : eq(shifts.openedBy, input.userId), input.orderId === undefined ? undefined : eq(orders.id, input.orderId), input.cursor === undefined || input.cursor === null ? undefined : sql`(${orders.createdAt}, ${orders.id}) < (${input.cursor.k}::timestamptz, ${input.cursor.id})`))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(26);
    const more = rows.length > 25;
    const page = more ? rows.slice(0, 25) : rows;
    const last = page.at(-1);
    return { rows: page.map((r) => ({ orderId: r.id, orderNumber: r.number, receiptNumber: r.receipt, total: Number(r.total), customerName: r.customer, at: r.at.toISOString(), paid: r.paid === 'paid' || r.paid === 'reconciled' })), next: more && last !== undefined ? { k: last.key, id: last.id } : null };
  }
}
