import { describe, expect, it } from 'vitest';
import { cashSaleLines, creditInvoiceLines, rebateLines, saleCredits, splitSale } from './sales-posting';

const accts = { sales: 'S', outputTax: 'T', serviceCharge: 'C', receivables: 'R' };
const sum = (l: { debitCents: number; creditCents: number }[]) => [l.reduce((n, x) => n + x.debitCents, 0), l.reduce((n, x) => n + x.creditCents, 0)];

describe('sales posting lines', () => {
  it('a credit invoice debits receivables with the total and credits sales, tax and shipping', () => {
    const lines = creditInvoiceLines({ totalCents: 11600, taxCents: 1600, shippingCents: 500 }, accts, 'INV-1');
    expect(lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      ['R', 11600, 0], ['S', 0, 9500], ['T', 0, 1600], ['C', 0, 500],
    ]);
    const [d, c] = sum(lines);
    expect(d).toBe(c);
  });
  it('leaves out zero lines and needs no tax account when no tax was charged', () => {
    const lines = saleCredits({ totalCents: 5000, taxCents: 0, shippingCents: 0 }, { sales: 'S', outputTax: null, serviceCharge: null }, 'x');
    expect(lines).toHaveLength(1);
  });
  it('refuses when tax or shipping was charged but has no account, or the shape is impossible', () => {
    expect(() => saleCredits({ totalCents: 1160, taxCents: 160, shippingCents: 0 }, { sales: 'S', outputTax: null, serviceCharge: null }, 'x')).toThrow(/tax owed/);
    expect(() => saleCredits({ totalCents: 1000, taxCents: 0, shippingCents: 100 }, { sales: 'S', outputTax: null, serviceCharge: null }, 'x')).toThrow(/service-charge/);
    expect(() => splitSale({ totalCents: 100, taxCents: 80, shippingCents: 40 })).toThrow();
    expect(() => splitSale({ totalCents: 0, taxCents: 0, shippingCents: 0 })).toThrow();
  });
  it('a cash sale debits however it was paid, and the parts must add up to the total', () => {
    const f = { totalCents: 10000, taxCents: 1379, shippingCents: 0 };
    const lines = cashSaleLines(f, accts, [{ accountId: 'B', cents: 7000, description: 'M-Pesa' }, { accountId: 'G', cents: 3000, description: 'Gift card' }], 'O-1');
    const [d, c] = sum(lines);
    expect(d).toBe(10000);
    expect(c).toBe(10000);
    expect(() => cashSaleLines(f, accts, [{ accountId: 'B', cents: 9000, description: 'x' }], 'O-1')).toThrow(/adds up/);
  });
  it('a rebate costs the business and reduces what the customer owes', () => {
    const [d, c] = sum(rebateLines(60000, 'E', 'R', 'Q1'));
    expect(d).toBe(60000);
    expect(c).toBe(60000);
  });
});
