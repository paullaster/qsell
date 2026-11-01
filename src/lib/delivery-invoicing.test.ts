import { describe, expect, it } from 'vitest';
import { DELIVERY_BILLING_MODES, isDeliveryBillingMode, planInvoices, planProblem } from './delivery-invoicing';

// Products 1,000 before tax with 16% tax (160); delivery 300 before tax with 16% tax (48); total 1,508.
const order = { subtotal: 1000, tax: 208, shippingFee: 300, totalAmount: 1508 };
const delivery = { net: 300, tax: 48, gross: 348, taxRate: 16 };

describe('on the same invoice', () => {
  const p = planInvoices(order, delivery, 'with_goods');
  it('makes delivery a line and shows the tax on the products, on the delivery and in all', () => {
    expect(p.deliveryInvoice).toBeNull();
    expect(p.main.deliveryLine).toEqual({ name: 'Delivery', net: 300, tax: 48, gross: 348, taxRate: 16 });
    expect(p.main.subtotal).toBe(1300);
    expect(p.main.shippingFee).toBe(0);
    expect(p.main.taxRows).toEqual([
      { label: 'VAT on products', amount: 160 },
      { label: 'VAT on delivery (16%)', amount: 48 },
      { label: 'Total VAT', amount: 208 },
    ]);
    expect(p.main.totalTax).toBe(208);
    expect(p.main.totalAmount).toBe(1508);
  });
  it('adds up: the parts of the tax are the whole, and the subtotal and the tax are the total', () => {
    const [products, onDelivery, total] = p.main.taxRows.map((r) => r.amount);
    expect(Math.round(((products ?? 0) + (onDelivery ?? 0)) * 100) / 100).toBe(total);
    expect(p.main.subtotal + p.main.totalTax).toBe(p.main.totalAmount);
    expect(planProblem(order, p)).toBeNull();
  });
});

describe('on its own invoice', () => {
  const p = planInvoices(order, delivery, 'separate');
  it('invoices the products with their own tax only, and the delivery service with its own', () => {
    expect(p.main).toMatchObject({ subtotal: 1000, totalTax: 160, totalAmount: 1160, deliveryLine: null, shippingFee: 0, taxRows: [{ label: 'VAT', amount: 160 }] });
    expect(p.deliveryInvoice).toMatchObject({ subtotal: 300, totalTax: 48, totalAmount: 348, taxRows: [{ label: 'VAT on delivery (16%)', amount: 48 }] });
    expect(p.deliveryInvoice?.deliveryLine?.gross).toBe(348);
  });
  it('the two invoices together are the order, to the cent', () => {
    expect(Math.round((p.main.totalAmount + (p.deliveryInvoice?.totalAmount ?? 0)) * 100) / 100).toBe(1508);
    expect(planProblem(order, p)).toBeNull();
  });
});

describe('delivery with no tax, or free, or none', () => {
  it('shows the delivery line with no tax on it when the rate is nothing', () => {
    const o = { subtotal: 1000, tax: 160, shippingFee: 300, totalAmount: 1460 };
    const p = planInvoices(o, { net: 300, tax: 0, gross: 300, taxRate: 0 }, 'with_goods');
    expect(p.main.taxRows).toEqual([{ label: 'VAT on products', amount: 160 }, { label: 'VAT on delivery', amount: 0 }, { label: 'Total VAT', amount: 160 }]);
    expect(planProblem(o, p)).toBeNull();
  });
  it('leaves an order with free delivery, or none, exactly as it was, in either mode', () => {
    const free = { subtotal: 1000, tax: 160, shippingFee: 0, totalAmount: 1160 };
    for (const mode of DELIVERY_BILLING_MODES) {
      for (const d of [null, { net: 0, tax: 0, gross: 0, taxRate: 16 }]) {
        const p = planInvoices(free, d, mode);
        expect(p.deliveryInvoice).toBeNull();
        expect(p.main).toMatchObject({ subtotal: 1000, shippingFee: 0, totalTax: 160, totalAmount: 1160, deliveryLine: null, taxRows: [{ label: 'VAT', amount: 160 }] });
      }
    }
  });
  it('keeps the shipping row for an old order with a shipping fee but no delivery record', () => {
    const old = { subtotal: 1000, tax: 160, shippingFee: 200, totalAmount: 1360 };
    const p = planInvoices(old, null, 'with_goods');
    expect(p.main).toMatchObject({ shippingFee: 200, deliveryLine: null, totalAmount: 1360 });
    expect(planProblem(old, p)).toBeNull();
  });
});

describe('planProblem', () => {
  it('refuses a plan that does not add up to the order', () => {
    const p = planInvoices(order, delivery, 'separate');
    expect(planProblem({ ...order, totalAmount: 1600 }, p)).toMatch(/do not add up/);
  });
  it('knows the modes', () => {
    expect(isDeliveryBillingMode('separate')).toBe(true);
    expect(isDeliveryBillingMode('both')).toBe(false);
  });
});

describe('rounding', () => {
  it('keeps every figure to the cent', () => {
    const o = { subtotal: 1000.01, tax: 191.66, shippingFee: 301.72, totalAmount: 1493.39 };
    const p = planInvoices(o, { net: 301.72, tax: 48.28, gross: 350, taxRate: 16 }, 'separate');
    for (const f of [p.main, p.deliveryInvoice]) for (const n of [f?.subtotal, f?.totalTax, f?.totalAmount]) expect(Math.round((n ?? 0) * 100) / 100).toBe(n);
    expect(planProblem(o, p)).toBeNull();
  });
});
