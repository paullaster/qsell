import { describe, expect, it } from 'vitest';
import { billingState, leftToInvoice, planBilling, type BillableLine } from './partial-billing';

const chairs: BillableLine = { orderItemId: 'a', productId: 'p1', description: 'Chair', quantity: 100, invoicedQuantity: 0, amountCents: 1_000_000, invoicedCents: 0, decimals: 0 };
const desks: BillableLine = { orderItemId: 'b', productId: 'p2', description: 'Desk', quantity: 5, invoicedQuantity: 0, amountCents: 500_000, invoicedCents: 0, decimals: 0 };
// Goods 15,000.00 of which tax 2,068.97; delivery 1,000.00 on top: the order is worth 16,000.00.
const order = { totalCents: 1_600_000, taxCents: 206_897, invoicedTotalCents: 0, invoicedTaxCents: 0, goodsCents: 1_500_000 };

describe('invoicing part of an order', () => {
  it('invoices a quantity of a line at the order\'s own price, and the order is not finished', () => {
    const r = planBilling({ lines: [chairs, desks], asks: [{ orderItemId: 'a', quantity: 40 }], order });
    expect(r.ok && r.plan.goodsCents).toBe(400_000);
    expect(r.ok && r.plan.finishesOrder).toBe(false);
    expect(r.ok && r.plan.remainderCents).toBe(0);
    expect(r.ok && r.plan.totalCents).toBe(400_000);
  });
  it('refuses more than is left, a line twice, nothing, decimals a piece does not allow, and a line that is not on the order', () => {
    expect(planBilling({ lines: [chairs], asks: [{ orderItemId: 'a', quantity: 101 }], order }).ok).toBe(false);
    expect(planBilling({ lines: [chairs], asks: [{ orderItemId: 'a', quantity: 1 }, { orderItemId: 'a', quantity: 1 }], order }).ok).toBe(false);
    expect(planBilling({ lines: [chairs], asks: [], order })).toEqual({ ok: false, error: 'Choose what to invoice.' });
    expect(planBilling({ lines: [chairs], asks: [{ orderItemId: 'a', quantity: 1.5 }], order }).ok).toBe(false);
    expect(planBilling({ lines: [chairs], asks: [{ orderItemId: 'zzz', quantity: 1 }], order }).ok).toBe(false);
    expect(planBilling({ lines: [chairs], asks: [{ orderItemId: 'a', quantity: Number.NaN }], order }).ok).toBe(false);
  });
  it('makes the invoices of an order add up to the order to the cent, the last taking the delivery and the rounding', () => {
    const odd: BillableLine = { orderItemId: 'c', productId: 'p3', description: 'Odd', quantity: 3, invoicedQuantity: 0, amountCents: 1000, invoicedCents: 0, decimals: 0 };
    const whole = { totalCents: 1500, taxCents: 207, invoicedTotalCents: 0, invoicedTaxCents: 0, goodsCents: 1000 };
    const first = planBilling({ lines: [odd], asks: [{ orderItemId: 'c', quantity: 1 }], order: whole });
    expect(first.ok && first.plan.goodsCents).toBe(333);
    const second = planBilling({ lines: [{ ...odd, invoicedQuantity: 1, invoicedCents: 333 }], asks: [{ orderItemId: 'c', quantity: 1 }], order: { ...whole, invoicedTotalCents: 333, invoicedTaxCents: first.ok ? first.plan.taxCents : 0 } });
    expect(second.ok && second.plan.goodsCents).toBe(333);
    const third = planBilling({ lines: [{ ...odd, invoicedQuantity: 2, invoicedCents: 666 }], asks: [{ orderItemId: 'c', quantity: 1 }], order: { ...whole, invoicedTotalCents: 666, invoicedTaxCents: (first.ok ? first.plan.taxCents : 0) + (second.ok ? second.plan.taxCents : 0) } });
    expect(third.ok && third.plan.goodsCents).toBe(334);
    expect(third.ok && third.plan.remainderCents).toBe(500);
    expect(third.ok && third.plan.finishesOrder).toBe(true);
    const sum = (first.ok ? first.plan.totalCents : 0) + (second.ok ? second.plan.totalCents : 0) + (third.ok ? third.plan.totalCents : 0);
    expect(sum).toBe(1500);
    const tax = (first.ok ? first.plan.taxCents : 0) + (second.ok ? second.plan.taxCents : 0) + (third.ok ? third.plan.taxCents : 0);
    expect(tax).toBe(207);
  });
  it('Invoice what is left takes every line\'s rest and finishes the order', () => {
    const part = { ...chairs, invoicedQuantity: 40, invoicedCents: 400_000 };
    const r = planBilling({ lines: [part, desks], asks: [], order: { ...order, invoicedTotalCents: 400_000, invoicedTaxCents: 55_172 }, rest: true });
    expect(r.ok && r.plan.lines.map((l) => [l.orderItemId, l.quantity, l.amountCents])).toEqual([['a', 60, 600_000], ['b', 5, 500_000]]);
    expect(r.ok && r.plan.remainderCents).toBe(100_000);
    expect(r.ok && r.plan.finishesOrder).toBe(true);
    expect(planBilling({ lines: [{ ...chairs, invoicedQuantity: 100, invoicedCents: 1_000_000 }], asks: [], order, rest: true })).toEqual({ ok: false, error: 'Everything on this order has already been invoiced.' });
  });
  it('shows what is left to invoice on each line', () => {
    expect(leftToInvoice([{ ...chairs, invoicedQuantity: 40, invoicedCents: 400_000 }, desks])).toEqual([{ orderItemId: 'a', quantity: 60, amountCents: 600_000 }, { orderItemId: 'b', quantity: 5, amountCents: 500_000 }]);
  });
  it('allows a part invoice only on an approved sales order not invoiced in whole, with the setting on (or to finish one already started)', () => {
    const base = { enabled: true, salesModule: 'sales_order', invoicedInWhole: false, partInvoices: 0, approved: true, cancelled: false, deliveryBilledApart: false };
    expect(billingState(base)).toEqual({ canPart: true, canRest: false, reason: null });
    expect(billingState({ ...base, partInvoices: 2 })).toMatchObject({ canPart: true, canRest: true });
    expect(billingState({ ...base, enabled: false })).toMatchObject({ canPart: false, canRest: false });
    expect(billingState({ ...base, enabled: false, partInvoices: 1 })).toMatchObject({ canPart: false, canRest: true });
    expect(billingState({ ...base, invoicedInWhole: true }).canPart).toBe(false);
    expect(billingState({ ...base, approved: false }).reason).toContain('waiting for approval');
    expect(billingState({ ...base, salesModule: 'ecommerce' }).canPart).toBe(false);
    expect(billingState({ ...base, deliveryBilledApart: true }).canPart).toBe(false);
    expect(billingState({ ...base, cancelled: true }).canPart).toBe(false);
  });
});
