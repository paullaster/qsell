import { describe, expect, it } from 'vitest';
import { computeCheckoutTotals, exactTotals } from './checkoutPricing';

describe('exactTotals', () => {
  it('keeps the cents that the order totals round away', () => {
    const lines = [
      { productId: 'a', quantity: 2, unitPrice: 634.12, taxRate: 16, isTaxInclusive: true },
      { productId: 'b', quantity: 2, unitPrice: 75.49, taxRate: 0, isTaxInclusive: true },
    ];
    expect(exactTotals(lines)).toEqual({ subtotal: 1244.29, tax: 174.93 });
    expect(computeCheckoutTotals(lines).tax).toBe(175);
  });
  it('adds tax on top for a line that does not include it', () => {
    expect(exactTotals([{ productId: 'a', quantity: 1, unitPrice: 100, taxRate: 16, isTaxInclusive: false }])).toEqual({ subtotal: 100, tax: 16 });
  });
});
