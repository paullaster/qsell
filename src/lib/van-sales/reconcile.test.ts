import { describe, expect, it } from 'vitest';
import { decide, decisionWords, expectedOnVan, varianceOf } from './reconcile';

describe('what should be on the van', () => {
  it('is what it started with and was loaded with, less what went out and back', () => {
    expect(expectedOnVan({ opening: 5, loaded: 100, sold: 60, delivered: 15, returnedGood: 3, unloaded: 20 })).toBe(13);
    expect(expectedOnVan({ opening: 0, loaded: 0.3, sold: 0.1, delivered: 0, returnedGood: 0, unloaded: 0 })).toBe(0.2);
  });
});

describe('a count against the ledger', () => {
  it('is short, over or exact, with its worth at cost', () => {
    expect(varianceOf({ productId: 'a', expected: 10, counted: 8, unitCost: 25.5 })).toMatchObject({ difference: -2, kind: 'short', value: 51 });
    expect(varianceOf({ productId: 'a', expected: 10, counted: 11, unitCost: 25.5 })).toMatchObject({ difference: 1, kind: 'over', value: 25.5 });
    expect(varianceOf({ productId: 'a', expected: 10, counted: 10, unitCost: 25.5 })).toMatchObject({ difference: 0, kind: 'none', value: 0 });
  });
});

describe('deciding a van count', () => {
  const rule = { shortage: 'charge_rep' as const, shortageApprovalAbove: 1000 };
  it('has nothing to decide when the van is exact', () => {
    const d = decide([{ productId: 'a', expected: 4, counted: 4, unitCost: 100 }], rule);
    expect(d).toMatchObject({ rows: [], shortValue: 0, overValue: 0, needsApproval: false, bearer: null });
    expect(decisionWords(d)).toBe('The van is exactly as it should be.');
  });
  it('lets a small shortage through on the rule and asks a second person about a big one', () => {
    const small = decide([{ productId: 'a', expected: 10, counted: 9, unitCost: 100 }], rule);
    expect(small).toMatchObject({ shortValue: 100, needsApproval: false, bearer: 'charge_rep' });
    const big = decide([{ productId: 'a', expected: 10, counted: 0, unitCost: 150 }], rule);
    expect(big).toMatchObject({ shortValue: 1500, needsApproval: true });
    expect(decisionWords(big)).toBe('The van is short by KES 1500.00 at cost. A second person must decide this.');
  });
  it('asks about every shortage when the limit is 0, and never about an overage alone', () => {
    expect(decide([{ productId: 'a', expected: 10, counted: 9, unitCost: 1 }], { ...rule, shortageApprovalAbove: 0 }).needsApproval).toBe(true);
    const over = decide([{ productId: 'a', expected: 1, counted: 5, unitCost: 1000 }], rule);
    expect(over).toMatchObject({ shortValue: 0, overValue: 4000, needsApproval: false, bearer: null });
  });
  it('follows the company rule for who bears a shortage, and nets nothing off between products', () => {
    const d = decide([{ productId: 'a', expected: 10, counted: 9, unitCost: 100 }, { productId: 'b', expected: 1, counted: 3, unitCost: 100 }], { shortage: 'write_off', shortageApprovalAbove: 50 });
    expect(d).toMatchObject({ shortValue: 100, overValue: 200, needsApproval: true, bearer: 'write_off' });
    expect(decisionWords(d)).toBe('The van is short by KES 100.00 and over by KES 200.00 at cost. A second person must decide this.');
  });
});
