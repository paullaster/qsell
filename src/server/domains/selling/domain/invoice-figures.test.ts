import { describe, expect, it } from 'vitest';
import { balanceOf, invoiceLine, partLine } from './invoice-figures';

const line = { name: 'Solar panel', sku: 'SP-1', quantity: 3, unitCode: null, unitPrice: 900, total: 2700, taxRate: 16, trace: null };

describe('invoiceLine', () => {
  it('keeps what the order kept: the unit price, the quantity and the line total', () => {
    expect(invoiceLine(line)).toEqual({ name: 'Solar panel', sku: 'SP-1', quantity: 3, unitCode: null, unitPrice: 900, listUnitPrice: null, discount: 0, taxRate: 16, total: 2700 });
  });
  it('shows what a discount took off and the price it came from, as the receipt does', () => {
    const typed = invoiceLine({ ...line, trace: { counterDiscount: { kind: 'percent', value: 10, before: 1000, perUnit: 100 } } as never });
    expect(typed).toMatchObject({ discount: 300, listUnitPrice: 1000, unitPrice: 900, total: 2700 });
  });
  it('shows no discount for a price that was only changed', () => {
    expect(invoiceLine({ ...line, trace: {} as never })).toMatchObject({ discount: 0, listUnitPrice: null });
  });
});

describe('partLine', () => {
  it('works one unit\'s price out of the amount', () => {
    expect(partLine({ name: 'Deposit', quantity: 4, amount: 1000 })).toMatchObject({ unitPrice: 250, total: 1000, discount: 0, taxRate: null });
    expect(partLine({ name: 'Fee', quantity: 0, amount: 50 })).toMatchObject({ unitPrice: 50 });
  });
});

describe('balanceOf', () => {
  it('is what is owed after credit notes and payments, never below nothing', () => {
    expect(balanceOf(1000, 0, 0)).toBe(1000);
    expect(balanceOf(1000, 200, 300)).toBe(500);
    expect(balanceOf(1000, 0, 1200)).toBe(0);
  });
});
