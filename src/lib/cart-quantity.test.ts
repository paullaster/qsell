import { describe, expect, it } from 'vitest';
import {
  availableOf,
  cartBadgeCount,
  cartQuantityWords,
  cartStep,
  clampCartQuantity,
  decimalsOf,
  minCartQuantity,
  parseCartQuantity,
  perUnitSuffix,
  stepCartQuantity,
} from './cart-quantity';

describe('cart quantities', () => {
  it('steps whole goods by 1 and goods sold by weight by half', () => {
    expect(cartStep(0)).toBe(1);
    expect(cartStep(3)).toBe(0.5);
    expect(stepCartQuantity(2, 1, 0, 10)).toBe(3);
    expect(stepCartQuantity(1, 1, 3, 10)).toBe(1.5);
    expect(stepCartQuantity(1.5, -1, 3, 10)).toBe(1);
  });

  it('never goes below the least or above what is available', () => {
    expect(stepCartQuantity(1, -1, 0, 10)).toBe(1);
    expect(stepCartQuantity(0.5, -1, 3, 10)).toBe(0.001);
    expect(stepCartQuantity(2.5, 1, 3, 2.7)).toBe(2.7);
    expect(clampCartQuantity(9, 3, 2.7)).toBe(2.7);
    expect(clampCartQuantity(4, 0, 2.7)).toBe(2);
  });

  it('rounds to what the unit allows', () => {
    expect(clampCartQuantity(0.25, 1, 10)).toBe(0.3);
    expect(clampCartQuantity(0.2504, 3, 10)).toBe(0.25);
    expect(clampCartQuantity(2.6, 0, 10)).toBe(3);
    expect(minCartQuantity(0)).toBe(1);
    expect(minCartQuantity(2)).toBe(0.01);
  });

  it('gives 0 when not even the least is available', () => {
    expect(clampCartQuantity(1, 0, 0.4)).toBe(0);
    expect(clampCartQuantity(1, 3, 0)).toBe(0);
  });

  it('reads what a person types', () => {
    expect(parseCartQuantity('0.5')).toBe(0.5);
    expect(parseCartQuantity(' 1,5 ')).toBe(1.5);
    expect(parseCartQuantity('')).toBeNull();
    expect(parseCartQuantity('0')).toBeNull();
    expect(parseCartQuantity('abc')).toBeNull();
  });

  it('works out what is available without floating point noise', () => {
    expect(availableOf({ stockQuantity: 0.3, reservedQuantity: 0.1 })).toBe(0.2);
    expect(availableOf({ stockQuantity: 1, reservedQuantity: 3 })).toBe(0);
  });

  it('says the unit for goods sold by weight and nothing for pieces', () => {
    const fish = { baseUnitCode: 'KG', baseUnitDecimals: 3 };
    const pen = { baseUnitCode: 'PCS', baseUnitDecimals: 0 };
    expect(cartQuantityWords(2.5, fish)).toBe('2.5 KG');
    expect(cartQuantityWords(3, pen)).toBe('3');
    expect(perUnitSuffix(fish)).toBe(' / KG');
    expect(perUnitSuffix(pen)).toBe('');
    expect(decimalsOf({})).toBe(0);
  });

  it('counts the badge by piece, and once for each line sold by weight', () => {
    expect(
      cartBadgeCount([
        { quantity: 3, product: { baseUnitDecimals: 0 } },
        { quantity: 0.5, product: { baseUnitDecimals: 3 } },
        { quantity: 2, product: {} },
      ]),
    ).toBe(6);
  });
});
