import { describe, expect, it } from 'vitest';
import { checkLandedCost, costAfter, spread } from './landed-cost';

describe('landed costs', () => {
  it('spreads a charge in whole cents that always add up', () => {
    expect(spread(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(spread(10000, [500, 300, 200])).toEqual([5000, 3000, 2000]);
    expect(spread(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(spread(5, [])).toEqual([]);
    expect(spread(5, [0, 0])).toEqual([0, 0]);
    for (const [total, w] of [[99999, [7, 11, 13, 17]], [12345, [1, 2, 3]], [100, [0.5, 0.25, 0.25]]] as const) expect(spread(total, w).reduce((s, x) => s + x, 0)).toBe(total);
  });
  it('adds a share to the cost of one unit', () => {
    expect(costAfter(10000, 5000, 10)).toBe(10500);
    expect(costAfter(10000, 1, 3)).toBe(10000);
  });
  it('checks the form', () => {
    expect(checkLandedCost({ kind: 'freight', description: 'Sea freight', reference: 'INV-1', amount: '830.50', method: 'value' })).toEqual({});
    expect(Object.keys(checkLandedCost({ kind: 'x', description: '', reference: '', amount: '0', method: 'value' })).sort()).toEqual(['amount', 'description', 'kind', 'reference']);
  });
});
