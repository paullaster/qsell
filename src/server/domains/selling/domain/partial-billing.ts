/**
 * Invoicing part of an order, by quantity (docs/architecture/partial-billing.md). Pure: no clock, no database. Money in cents.
 * A line's amount is the order's own (its total price, as credit notes also read it); the part invoices of an order add up to the
 * order's total to the cent, because the invoice that finishes the order takes whatever is left, including the delivery charge.
 */

export interface BillableLine {
  orderItemId: string;
  productId: string;
  description: string;
  /** What was ordered, in the product's base unit. */
  quantity: number;
  /** What earlier part invoices already took. */
  invoicedQuantity: number;
  /** The line's total on the order, in cents. */
  amountCents: number;
  /** What earlier part invoices already took of the amount, in cents. */
  invoicedCents: number;
  /** Decimals the product's unit allows (0 for pieces). */
  decimals: number;
}

export interface BillingAsk {
  orderItemId: string;
  quantity: number;
}

export interface PlannedBillingLine {
  orderItemId: string;
  productId: string;
  description: string;
  quantity: number;
  amountCents: number;
}

export interface PlannedBilling {
  lines: PlannedBillingLine[];
  /** The goods on this invoice, in cents. */
  goodsCents: number;
  /** What this invoice takes beyond its goods: the delivery charge and any rounding, on the invoice that finishes the order. */
  remainderCents: number;
  totalCents: number;
  /** True when, with this invoice, every line is fully invoiced and nothing of the order's total is left. */
  finishesOrder: boolean;
  /** Tax in this invoice, in cents: the order's tax share of the goods, and on the last invoice whatever tax is left. */
  taxCents: number;
}

export type BillingPlan = { ok: true; plan: PlannedBilling } | { ok: false; error: string };

const round = (value: number, decimals: number): number => Math.round(value * 10 ** decimals) / 10 ** decimals;
const left = (l: BillableLine): number => round(l.quantity - l.invoicedQuantity, 3);

/** What is left to invoice on each line (ordered less invoiced), for the screen. */
export const leftToInvoice = (lines: readonly BillableLine[]): { orderItemId: string; quantity: number; amountCents: number }[] =>
  lines.map((l) => ({ orderItemId: l.orderItemId, quantity: left(l), amountCents: l.amountCents - l.invoicedCents }));

/**
 * Works out a part invoice: what is asked of each line, checked against what is left, with amounts that cannot drift (a line finished
 * by this invoice takes what is left of its amount). `order` carries the order's total and tax in cents and what its earlier part
 * invoices took of both, so the invoice that finishes the order can take the remainder (delivery, rounding) and the last of the tax.
 */
export function planBilling(input: {
  lines: readonly BillableLine[];
  asks: readonly BillingAsk[];
  order: { totalCents: number; taxCents: number; invoicedTotalCents: number; invoicedTaxCents: number; goodsCents: number };
  /** Take everything that is left (Invoice what is left): the asks are then ignored. */
  rest?: boolean;
}): BillingPlan {
  const byId = new Map(input.lines.map((l) => [l.orderItemId, l]));
  const asks: BillingAsk[] = input.rest === true ? input.lines.filter((l) => left(l) > 0).map((l) => ({ orderItemId: l.orderItemId, quantity: left(l) })) : input.asks.filter((a) => a.quantity > 0);
  if (asks.length === 0) return { ok: false, error: input.rest === true ? 'Everything on this order has already been invoiced.' : 'Choose what to invoice.' };
  const seen = new Set<string>();
  const planned: PlannedBillingLine[] = [];
  for (const ask of asks) {
    const line = byId.get(ask.orderItemId);
    if (line === undefined) return { ok: false, error: 'One of the lines is not on this order.' };
    if (seen.has(ask.orderItemId)) return { ok: false, error: 'Each line can be on an invoice once.' };
    seen.add(ask.orderItemId);
    if (!Number.isFinite(ask.quantity) || ask.quantity <= 0) return { ok: false, error: `${line.description}: give a quantity of more than nothing.` };
    if (round(ask.quantity, line.decimals) !== ask.quantity) return { ok: false, error: `${line.description}: the quantity can have at most ${String(line.decimals)} decimals.` };
    if (ask.quantity > left(line) + 1e-9) return { ok: false, error: `${line.description}: at most ${String(left(line))} is left to invoice.` };
    const finishesLine = round(line.invoicedQuantity + ask.quantity, 3) >= line.quantity;
    const amountCents = finishesLine ? line.amountCents - line.invoicedCents : Math.round((line.amountCents * ask.quantity) / line.quantity);
    planned.push({ orderItemId: line.orderItemId, productId: line.productId, description: line.description, quantity: ask.quantity, amountCents });
  }
  const goodsCents = planned.reduce((sum, l) => sum + l.amountCents, 0);
  const finishesGoods = input.lines.every((l) => (seen.has(l.orderItemId) ? round(l.invoicedQuantity + (asks.find((a) => a.orderItemId === l.orderItemId)?.quantity ?? 0), 3) >= l.quantity : left(l) <= 0));
  const remainingOfOrder = input.order.totalCents - input.order.invoicedTotalCents;
  // The invoice that finishes the goods also takes the rest of the order's total (the delivery charge, rounding).
  const remainderCents = finishesGoods ? remainingOfOrder - goodsCents : 0;
  if (finishesGoods && remainderCents < 0) return { ok: false, error: 'The invoice would be more than the order is worth. Check the order.' };
  const totalCents = goodsCents + remainderCents;
  const taxCents = finishesGoods ? input.order.taxCents - input.order.invoicedTaxCents : Math.round((goodsCents * input.order.taxCents) / Math.max(input.order.goodsCents + (input.order.totalCents - input.order.goodsCents), 1));
  return { ok: true, plan: { lines: planned, goodsCents, remainderCents, totalCents, finishesOrder: finishesGoods, taxCents } };
}

/** Whether the order may take a part invoice at all, and what it may do next, from the facts on the order. */
export function billingState(facts: { enabled: boolean; salesModule: string; invoicedInWhole: boolean; partInvoices: number; approved: boolean; cancelled: boolean; deliveryBilledApart: boolean }): { canPart: boolean; canRest: boolean; reason: string | null } {
  if (facts.salesModule !== 'sales_order') return { canPart: false, canRest: false, reason: 'Only sales orders can be invoiced in parts.' };
  if (facts.cancelled) return { canPart: false, canRest: false, reason: 'This order is cancelled.' };
  if (!facts.approved) return { canPart: false, canRest: false, reason: 'A tax invoice cannot be issued while this order is waiting for approval.' };
  if (facts.invoicedInWhole) return { canPart: false, canRest: false, reason: 'This order already has a tax invoice for the whole order.' };
  if (facts.deliveryBilledApart) return { canPart: false, canRest: false, reason: 'This order bills its delivery on an invoice of its own, so it is invoiced in one piece.' };
  // Turned off, an order already invoiced in parts can still be finished, so nothing is stranded.
  if (!facts.enabled) return facts.partInvoices > 0 ? { canPart: false, canRest: true, reason: 'Invoicing in parts is switched off: only what is left can be invoiced.' } : { canPart: false, canRest: false, reason: 'Invoicing in parts is switched off.' };
  return { canPart: true, canRest: facts.partInvoices > 0, reason: null };
}
