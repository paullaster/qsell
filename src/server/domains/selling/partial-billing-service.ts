import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { billingSettings, invoiceDocuments, orderBillingLines, orderBillings, orderItems, orders, products, unitsOfMeasure } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { invoicePlanFor } from '@/server/domains/delivery/invoice-plan';
import { billingState, leftToInvoice, planBilling, type BillableLine, type BillingAsk, type PlannedBilling } from './domain/partial-billing';

export class BillingError extends Error {}

export interface BillingLineView {
  orderItemId: string;
  productId: string;
  description: string;
  ordered: number;
  invoiced: number;
  left: number;
  unitPrice: number;
  decimals: number;
}

export interface PartInvoiceRow {
  id: string;
  sequence: number;
  invoiceNumber: string;
  goods: number;
  remainder: number;
  tax: number;
  total: number;
  finishesOrder: boolean;
  kraStatus: string;
  createdAt: string;
}

export interface OrderBillingView {
  enabled: boolean;
  canPart: boolean;
  canRest: boolean;
  reason: string | null;
  lines: BillingLineView[];
  invoices: PartInvoiceRow[];
  /** Whether the order is invoiced in full by its part invoices. */
  complete: boolean;
}

const cents = (value: string | number): number => Math.round(Number(value) * 100);
const money = (value: number): string => (value / 100).toFixed(2);
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Invoicing part of an order, by quantity, as tax invoices of their own (docs/architecture/partial-billing.md). */
export class PartialBillingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly numbering: NumberSeriesService,
    /** After a part invoice exists: hand it to KRA signing (never holds up the invoice). */
    private readonly sign: (billingId: string) => Promise<unknown>,
  ) {}

  // ── The setting (its own permission) ───────────────────────────────────

  async settings(companyId: string): Promise<{ enabled: boolean; version: number; updatedBy: string | null; updatedAt: string | null }> {
    const [row] = await this.db.select().from(billingSettings).where(eq(billingSettings.companyId, companyId)).limit(1);
    return row === undefined ? { enabled: false, version: 0, updatedBy: null, updatedAt: null } : { enabled: row.partialBilling, version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
  }

  async setEnabled(companyId: string, actor: Actor, enabled: boolean, reason: ReasonInput): Promise<void> {
    const why = await this.reasons.require(companyId, reason, 'billing_configuration');
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(billingSettings).where(eq(billingSettings.companyId, companyId)).limit(1).for('update');
      if (before?.partialBilling === enabled || (before === undefined && !enabled)) throw new BillingError(enabled ? 'Invoicing in parts is already switched on.' : 'Invoicing in parts is already switched off.');
      const values = { partialBilling: enabled, updatedBy: actor.id ?? 'system', updatedAt: new Date() };
      if (before === undefined) await tx.insert(billingSettings).values({ companyId, ...values });
      else await tx.update(billingSettings).set({ ...values, version: before.version + 1 }).where(eq(billingSettings.companyId, companyId));
      await this.decisions.record({ companyId, actor, subject: { type: 'billing_settings', id: companyId }, action: 'billing_settings.changed', reason: why, inputs: { partialBilling: before?.partialBilling ?? false }, outcome: { partialBilling: enabled } }, tx);
    });
  }

  // ── What an order has, and what is left ────────────────────────────────

  private async billable(db: Pick<DrizzleDb, 'select'>, orderId: string): Promise<{ lines: BillableLine[]; unitPrice: Map<string, number> }> {
    const items = await db
      .select({ item: orderItems, decimals: unitsOfMeasure.decimals })
      .from(orderItems)
      .leftJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.baseUnitId))
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.id);
    const taken = items.length === 0 ? [] : await db
      .select({ itemId: orderBillingLines.orderItemId, quantity: sql<string>`SUM(${orderBillingLines.quantity})::text`, amount: sql<string>`SUM(${orderBillingLines.amount})::text` })
      .from(orderBillingLines)
      .where(inArray(orderBillingLines.orderItemId, items.map((i) => i.item.id)))
      .groupBy(orderBillingLines.orderItemId);
    const byItem = new Map(taken.map((t) => [t.itemId, t]));
    const unitPrice = new Map<string, number>();
    const lines = items.map(({ item, decimals }): BillableLine => {
      const t = byItem.get(item.id);
      unitPrice.set(item.id, Number(item.unitPrice));
      return { orderItemId: item.id, productId: item.productId, description: item.productName, quantity: item.quantity, invoicedQuantity: round3(Number(t?.quantity ?? 0)), amountCents: cents(item.totalPrice), invoicedCents: cents(t?.amount ?? 0), decimals: decimals ?? 3 };
    });
    return { lines, unitPrice };
  }

  /** The order as the billing screen shows it: lines with what is invoiced and left, the part invoices, and what may be done next. */
  async view(companyId: string, orderId: string): Promise<OrderBillingView | null> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (order === undefined) return null;
    const enabled = (await this.settings(companyId)).enabled;
    const { lines, unitPrice } = await this.billable(this.db, orderId);
    const invoices = await this.db.select().from(orderBillings).where(eq(orderBillings.orderId, orderId)).orderBy(orderBillings.sequence);
    const [whole] = await this.db.select({ id: invoiceDocuments.id }).from(invoiceDocuments).where(and(eq(invoiceDocuments.orderId, orderId), eq(invoiceDocuments.documentType, 'tax_invoice'))).limit(1);
    const apart = await invoicePlanFor(this.db, companyId, orderId, 'tax_invoice').then((p) => p.plan.deliveryInvoice !== null, () => false);
    const state = billingState({ enabled, salesModule: order.salesModule, invoicedInWhole: whole !== undefined, partInvoices: invoices.length, approved: !['pending', 'rejected', 'draft'].includes(order.approvalStatus), cancelled: ['cancelled', 'failed'].includes(order.status), deliveryBilledApart: apart });
    const left = new Map(leftToInvoice(lines).map((l) => [l.orderItemId, l]));
    const complete = invoices.some((i) => i.finishesOrder);
    return {
      enabled,
      canPart: state.canPart && !complete,
      canRest: state.canRest && !complete,
      reason: complete ? 'This order is invoiced in full.' : state.reason,
      lines: lines.map((l) => ({ orderItemId: l.orderItemId, productId: l.productId, description: l.description, ordered: l.quantity, invoiced: l.invoicedQuantity, left: left.get(l.orderItemId)?.quantity ?? 0, unitPrice: unitPrice.get(l.orderItemId) ?? 0, decimals: l.decimals })),
      invoices: invoices.map((i) => ({ id: i.id, sequence: i.sequence, invoiceNumber: i.invoiceNumber, goods: Number(i.goodsAmount), remainder: Number(i.remainderAmount), tax: Number(i.taxAmount), total: Number(i.totalAmount), finishesOrder: i.finishesOrder, kraStatus: i.kraStatus, createdAt: i.createdAt.toISOString() })),
      complete,
    };
  }

  // ── Raising a part invoice ─────────────────────────────────────────────

  /** What a part invoice with these asks would be, worked out the way issuing works it out (nothing is saved). */
  async preview(companyId: string, orderId: string, input: { asks: BillingAsk[]; rest: boolean }): Promise<{ ok: true; plan: PlannedBilling } | { ok: false; error: string }> {
    const view = await this.view(companyId, orderId);
    if (view === null) return { ok: false, error: 'That order could not be found.' };
    if (input.rest ? !view.canRest : !view.canPart) return { ok: false, error: view.reason ?? 'This order cannot be invoiced in parts.' };
    const made = await this.facts(this.db, orderId);
    if (made === null) return { ok: false, error: 'That order could not be found.' };
    const planned = planBilling({ lines: made.lines, asks: input.asks, order: made.order, rest: input.rest });
    if (!planned.ok) return planned;
    if (planned.plan.remainderCents > 0 && !(await this.hasDeliveryLine(companyId, orderId))) return { ok: false, error: 'This order is worth more than its lines (a delivery charge or an adjustment that is not a line), so it is invoiced in one piece.' };
    return planned;
  }

  private async facts(db: Pick<DrizzleDb, 'select'>, orderId: string) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (order === undefined) return null;
    const { lines } = await this.billable(db, orderId);
    const [sums] = await db
      .select({ total: sql<string>`COALESCE(SUM(${orderBillings.totalAmount}), 0)::text`, tax: sql<string>`COALESCE(SUM(${orderBillings.taxAmount}), 0)::text` })
      .from(orderBillings)
      .where(eq(orderBillings.orderId, orderId));
    return { lines, order: { totalCents: cents(order.totalAmount), taxCents: cents(order.tax), invoicedTotalCents: cents(sums?.total ?? 0), invoicedTaxCents: cents(sums?.tax ?? 0), goodsCents: lines.reduce((n, l) => n + l.amountCents, 0) }, orderRow: order };
  }

  /** The finishing invoice's extra amount is the delivery charge: it needs the delivery to be a line of the invoice (billed with the goods). */
  private async hasDeliveryLine(companyId: string, orderId: string): Promise<boolean> {
    try {
      return (await invoicePlanFor(this.db, companyId, orderId, 'tax_invoice')).figures.deliveryLine !== null;
    } catch {
      return false;
    }
  }

  async issue(companyId: string, who: { userId: string }, orderId: string, input: { asks: BillingAsk[]; rest: boolean }): Promise<{ ok: true; billingId: string; invoiceNumber: string; sequence: number; finishesOrder: boolean } | { ok: false; error: string }> {
    const checked = await this.preview(companyId, orderId, input);
    if (!checked.ok) return checked;
    try {
      const made = await this.db.transaction(async (tx) => {
        // The order is locked while its invoiced quantities are read again and the invoice is made, so two people cannot invoice the same units.
        await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`);
        const facts = await this.facts(tx, orderId);
        if (facts === null) throw new BillingError('That order could not be found.');
        const planned = planBilling({ lines: facts.lines, asks: input.asks, order: facts.order, rest: input.rest });
        if (!planned.ok) throw new BillingError(planned.error);
        const plan = planned.plan;
        const [seq] = await tx.select({ n: sql<string>`COALESCE(MAX(${orderBillings.sequence}), 0)::text` }).from(orderBillings).where(eq(orderBillings.orderId, orderId));
        const sequence = Number(seq?.n ?? 0) + 1;
        const billingId = crypto.randomUUID();
        const { number } = await this.numbering.assign('tax_invoice', { companyId, branchId: facts.orderRow.branchId ?? null, date: businessDate(), document: { kind: 'tax_invoice', id: billingId }, actor: { type: 'user', id: who.userId } }, tx);
        await tx.insert(orderBillings).values({ id: billingId, companyId, orderId, sequence, invoiceNumber: number, goodsAmount: money(plan.goodsCents), remainderAmount: money(plan.remainderCents), taxAmount: money(plan.taxCents), totalAmount: money(plan.totalCents), finishesOrder: plan.finishesOrder, createdBy: who.userId });
        await tx.insert(orderBillingLines).values(plan.lines.map((l) => ({ billingId, orderItemId: l.orderItemId, productId: l.productId, description: l.description, quantity: l.quantity, amount: money(l.amountCents) })));
        await tx.insert(invoiceDocuments).values({ orderId, orderNumber: facts.orderRow.orderNumber, invoiceNumber: number, documentType: 'tax_invoice_part', customerEmail: facts.orderRow.customerEmail, customerName: facts.orderRow.customerName, currency: facts.orderRow.currency, subtotal: money(plan.totalCents - plan.taxCents), tax: money(plan.taxCents), shippingFee: money(plan.remainderCents), totalAmount: money(plan.totalCents), meta: { billingId, sequence, finishesOrder: plan.finishesOrder } });
        await this.decisions.record({ companyId, actor: { type: 'user', id: who.userId }, subject: { type: 'order', id: orderId }, action: 'order.part_invoiced', inputs: { rest: input.rest }, outcome: { invoiceNumber: number, sequence, total: plan.totalCents / 100, finishesOrder: plan.finishesOrder, lines: plan.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) } }, tx);
        return { billingId, invoiceNumber: number, sequence, finishesOrder: plan.finishesOrder };
      });
      // Signing follows the invoice and never holds it up.
      void this.sign(made.billingId).catch((error: unknown) => console.error('[partial billing] signing hook failed', made.billingId, error));
      return { ok: true, ...made };
    } catch (error) {
      if (error instanceof BillingError) return { ok: false, error: error.message };
      throw error;
    }
  }

  /** Whether the order has any part invoice (then it is finished with its remaining part, never with a whole-order invoice). */
  async hasPartInvoices(orderId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: orderBillings.id }).from(orderBillings).where(eq(orderBillings.orderId, orderId)).limit(1);
    return row !== undefined;
  }

  /** One part invoice with its lines, for the PDF and for credit notes. */
  async detail(billingId: string) {
    const [billing] = await this.db.select().from(orderBillings).where(eq(orderBillings.id, billingId)).limit(1);
    if (billing === undefined) return null;
    const lines = await this.db.select().from(orderBillingLines).where(eq(orderBillingLines.billingId, billingId));
    return { billing, lines };
  }
}
