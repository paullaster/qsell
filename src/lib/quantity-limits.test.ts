import { describe, expect, it } from 'vitest';
import { effectiveStandardPrice, hasOwnStandardPrice } from './standard-price';
import { basketQuantityProblems, clampToLimits, hasLimits, limitsHint, limitsOf, limitsProblem, purchaseQuantityProblem, startingQuantity, stepQuantity } from './quantity-limits';

const item = (over: Record<string, unknown> = {}) => ({ name: 'Rice', baseUnitName: 'Kilogram', baseUnitDecimals: 0, minOrderQty: null, maxOrderQty: null, ...over });

describe('limits are empty by default', () => {
  it('reads nothing, zero or rubbish as no limit', () => {
    expect(limitsOf(item())).toEqual({ minQty: null, maxQty: null });
    expect(limitsOf(item({ minOrderQty: 0, maxOrderQty: -2 }))).toEqual({ minQty: null, maxQty: null });
    expect(hasLimits(limitsOf(item({ minOrderQty: 2 })))).toBe(true);
    expect(purchaseQuantityProblem(1, item())).toBeNull();
    expect(purchaseQuantityProblem(1_000_000, item())).toBeNull();
  });
});

describe('saving limits on an item', () => {
  it('accepts empty, and a range that fits the unit', () => {
    expect(limitsProblem(null, null, 0, 'Piece')).toBeNull();
    expect(limitsProblem(3, 10, 0, 'Piece')).toBeNull();
    expect(limitsProblem(3, null, 0, 'Piece')).toBeNull();
    expect(limitsProblem(null, 10, 0, 'Piece')).toBeNull();
    expect(limitsProblem(0.5, 5, 3, 'Kilogram')).toBeNull();
  });
  it('says in words what is wrong', () => {
    expect(limitsProblem(0, null, 0, 'Piece')).toContain('must be above zero');
    expect(limitsProblem(-1, null, 0, 'Piece')).toContain('must be above zero');
    expect(limitsProblem(Number.NaN, null, 0, 'Piece')).toContain('must be above zero');
    expect(limitsProblem(2.5, null, 0, 'Piece')).toBe('The minimum quantity must be a whole number: it is counted in Piece.');
    expect(limitsProblem(null, 1.2345, 3, 'Kilogram')).toContain('at most 3 decimals');
    expect(limitsProblem(10, 3, 0, 'Piece')).toBe('The minimum quantity (10 Piece) cannot be above the maximum (3 Piece).');
  });
});

describe('buying a quantity', () => {
  const limited = item({ minOrderQty: 3, maxOrderQty: 10 });
  it('is refused outside the limits, in words for the buyer', () => {
    expect(purchaseQuantityProblem(2, limited)).toBe('The least you can buy of "Rice" is 3 Kilogram.');
    expect(purchaseQuantityProblem(11, limited)).toBe('The most you can buy of "Rice" is 10 Kilogram.');
  });
  it('is allowed on the limits themselves', () => {
    expect(purchaseQuantityProblem(3, limited)).toBeNull();
    expect(purchaseQuantityProblem(10, limited)).toBeNull();
    expect(purchaseQuantityProblem(7, limited)).toBeNull();
  });
  it('is measured over the whole document, so splitting lines does not get round a limit', () => {
    const lines = (...quantities: number[]) => quantities.map((quantity) => ({ productId: 'p1', quantity, item: limited }));
    expect(basketQuantityProblems(lines(6, 6))).toEqual(['The most you can buy of "Rice" is 10 Kilogram.']);
    expect(basketQuantityProblems(lines(1, 1))).toEqual(['The least you can buy of "Rice" is 3 Kilogram.']);
    expect(basketQuantityProblems(lines(2, 2))).toEqual([]);
    expect(basketQuantityProblems([...lines(4), { productId: 'p2', quantity: 1, item: item() }])).toEqual([]);
  });
  it('keeps decimals exact when adding lines', () => {
    const kg = item({ baseUnitDecimals: 3, minOrderQty: 0.3 });
    expect(basketQuantityProblems([{ productId: 'p', quantity: 0.1, item: kg }, { productId: 'p', quantity: 0.2, item: kg }])).toEqual([]);
  });
});

describe('what a basket does with the limits', () => {
  const limits = { minQty: 3, maxQty: 10 };
  it('starts at the minimum, else one', () => {
    expect(startingQuantity(limits)).toBe(3);
    expect(startingQuantity({ minQty: null, maxQty: null })).toBe(1);
    expect(startingQuantity({ minQty: null, maxQty: 0.5 })).toBe(0.5);
  });
  it('clamps to the nearest allowed quantity', () => {
    expect(clampToLimits(1, limits)).toBe(3);
    expect(clampToLimits(50, limits)).toBe(10);
    expect(clampToLimits(5, limits)).toBe(5);
    expect(clampToLimits(5, { minQty: null, maxQty: null })).toBe(5);
  });
  it('steps by one but never below the minimum (it removes instead) or above the maximum', () => {
    expect(stepQuantity(4, -1, 1, limits)).toBe(3);
    expect(stepQuantity(3, -1, 1, limits)).toBe(0);
    expect(stepQuantity(10, 1, 1, limits)).toBe(10);
    expect(stepQuantity(9.5, 1, 1, limits)).toBe(10);
    expect(stepQuantity(1, -1, 1, { minQty: null, maxQty: null })).toBe(0);
  });
  it('says the limits in words', () => {
    expect(limitsHint({ minQty: 3, maxQty: 10 }, 'Piece')).toBe('Buy 3 to 10 Piece at a time.');
    expect(limitsHint({ minQty: 3, maxQty: null }, 'Piece')).toBe('Minimum 3 Piece per order.');
    expect(limitsHint({ minQty: null, maxQty: 10 }, 'Piece')).toBe('Maximum 10 Piece per order.');
    expect(limitsHint({ minQty: null, maxQty: null }, 'Piece')).toBe('');
  });
});

describe('the standard price', () => {
  it('follows the selling price until it is set', () => {
    expect(effectiveStandardPrice({ price: 1000 })).toBe(1000);
    expect(effectiveStandardPrice({ price: 1000, standardPrice: null })).toBe(1000);
    expect(hasOwnStandardPrice({ standardPrice: null })).toBe(false);
  });
  it('stands on its own once set, even when lower or zero', () => {
    expect(effectiveStandardPrice({ price: 1000, standardPrice: 900 })).toBe(900);
    expect(effectiveStandardPrice({ price: 1000, standardPrice: 0 })).toBe(0);
    expect(hasOwnStandardPrice({ standardPrice: 900 })).toBe(true);
  });
  it('is nothing when there is neither', () => {
    expect(effectiveStandardPrice({})).toBeNull();
    expect(effectiveStandardPrice({ price: null, standardPrice: null })).toBeNull();
    expect(effectiveStandardPrice({ price: 1000, standardPrice: -5 })).toBe(1000);
  });
});
