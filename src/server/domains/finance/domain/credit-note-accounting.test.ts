import { describe, expect, it } from 'vitest';
import { checkDisposition, creditNoteLines, planCredit, splitCredit, suggestedDisposition } from './credit-note-accounting';

describe('credit note accounting', () => {
  it('splits a credit like the sale, and the parts add up to the cent', () => {
    // sale: net 10,000, tax 1,600 (16%)
    const s = splitCredit(5800, 1_000_000, 160_000);
    expect(s).toEqual({ netCents: 5000, taxCents: 800 });
    for (const g of [1, 33, 777, 11599, 116000]) {
      const x = splitCredit(g, 1_000_000, 160_000);
      expect(x.netCents + x.taxCents).toBe(g);
    }
    expect(splitCredit(1000, 5000, 0)).toEqual({ netCents: 1000, taxCents: 0 });
    expect(() => splitCredit(0, 1, 1)).toThrow();
  });
  it('the invoice absorbs what it owes and the rest is excess', () => {
    expect(planCredit(10000, 4000)).toEqual({ appliedCents: 4000, excessCents: 0 });
    expect(planCredit(1500, 4000)).toEqual({ appliedCents: 1500, excessCents: 2500 });
    expect(planCredit(0, 4000)).toEqual({ appliedCents: 0, excessCents: 4000 });
  });
  it('debits returns and tax, credits trade debtors, and balances', () => {
    const lines = creditNoteLines({ netCents: 5000, taxCents: 800 }, { salesReturns: 'R', outputTax: 'T', receivables: 'A' }, 'CN-1');
    expect(lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual([['R', 5000, 0], ['T', 800, 0], ['A', 0, 5800]]);
    expect(() => creditNoteLines({ netCents: 5000, taxCents: 800 }, { salesReturns: 'R', outputTax: null, receivables: 'A' }, 'x')).toThrow(/tax owed/);
  });
  it('only good goods go back on the shelf', () => {
    expect(checkDisposition('good', 'return_to_stock')).toBeNull();
    expect(checkDisposition('damaged', 'return_to_stock')).toMatch(/good condition/);
    expect(checkDisposition('damaged', 'scrap')).toBeNull();
    expect(suggestedDisposition('damaged_goods')).toBe('scrap');
    expect(suggestedDisposition('returned_goods')).toBe('return_to_stock');
  });
});
