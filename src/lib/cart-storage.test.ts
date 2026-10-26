import { describe, expect, it } from 'vitest';
import { parseSavedCart, serializeCart } from './cart-storage';

describe('parseSavedCart', () => {
  it('reads what it wrote', () => {
    const lines = [{ productId: 'a', quantity: 2, price: 10 }, { productId: 'b', quantity: 0.5, price: null }];
    expect(parseSavedCart(serializeCart(lines))).toEqual(lines);
  });

  it('reads the first shop\'s saved cart, which carried the whole product', () => {
    const old = JSON.stringify([{ product: { id: 'p1', name: 'Rice', price: 120, costPrice: 1 }, quantity: 3 }]);
    expect(parseSavedCart(old)).toEqual([{ productId: 'p1', quantity: 3, price: 120 }]);
  });

  it('gives an empty cart for nothing, damage or the wrong shape', () => {
    for (const raw of [null, undefined, '', '{', 'null', '{"a":1}', '"x"']) expect(parseSavedCart(raw)).toEqual([]);
  });

  it('drops lines that make no sense and repeated products', () => {
    const raw = JSON.stringify([
      { productId: '', quantity: 1 },
      { productId: 'a', quantity: 0 },
      { productId: 'a', quantity: -2 },
      { productId: 'a', quantity: 'many' },
      { productId: 7, quantity: 1 },
      { productId: 'ok', quantity: 1, price: 'free' },
      { productId: 'ok', quantity: 9 },
      null,
    ]);
    expect(parseSavedCart(raw)).toEqual([{ productId: 'ok', quantity: 1, price: null }]);
  });

  it('keeps at most 100 lines', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ productId: `p${String(i)}`, quantity: 1 }));
    expect(parseSavedCart(JSON.stringify(many))).toHaveLength(100);
  });
});
