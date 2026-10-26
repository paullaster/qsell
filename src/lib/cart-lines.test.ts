import { describe, expect, it } from 'vitest';
import type { PublicProduct } from '@/types/index';
import { addToCart, reconcileCart, savedLines, setCartQuantity } from './cart-lines';

const product = (over: Partial<PublicProduct> = {}): PublicProduct =>
  ({ id: 'p1', name: 'Rice', price: 100, stockQuantity: 5, reservedQuantity: 0, baseUnitDecimals: 0, baseUnitCode: 'pc', ...over }) as PublicProduct;
const money = (n: number) => `KES ${String(n)}`;

describe('addToCart', () => {
  it('adds a new line and more of an existing one', () => {
    const first = addToCart([], product(), 2);
    expect(first).toMatchObject({ outcome: 'added', quantity: 2 });
    expect(addToCart(first.lines, product(), 1).lines).toEqual([{ product: product(), quantity: 3 }]);
  });

  it('never goes past what is in stock, and says so', () => {
    const lines = addToCart([], product(), 4).lines;
    expect(addToCart(lines, product(), 4)).toMatchObject({ outcome: 'capped', quantity: 5 });
  });

  it('refuses a sold-out product and leaves the cart alone', () => {
    const out = product({ stockQuantity: 2, reservedQuantity: 2 });
    expect(addToCart([], out, 1)).toEqual({ lines: [], outcome: 'sold_out', quantity: 0 });
  });

  it('respects a unit that is sold by weight', () => {
    const fish = product({ baseUnitDecimals: 3, baseUnitCode: 'kg', stockQuantity: 2 });
    expect(addToCart([], fish, 0.25).lines[0]?.quantity).toBe(0.25);
  });
});

describe('setCartQuantity', () => {
  it('clamps to the stock and removes a line set to nothing', () => {
    const lines = addToCart([], product(), 1).lines;
    expect(setCartQuantity(lines, 'p1', 99)[0]?.quantity).toBe(5);
    expect(setCartQuantity(lines, 'p1', 0)).toEqual([]);
    expect(setCartQuantity(lines, 'other', 3)).toEqual(lines);
  });
});

describe('reconcileCart', () => {
  it('takes current price and stock and keeps a line that did not change', () => {
    const saved = savedLines([{ product: product(), quantity: 2 }]);
    const result = reconcileCart(saved, [product()], money);
    expect(result.notices).toEqual([]);
    expect(result.lines).toEqual([{ product: product(), quantity: 2 }]);
  });

  it('tells the shopper when a price moved, and uses the new one', () => {
    const saved = [{ productId: 'p1', quantity: 1, price: 100 }];
    const result = reconcileCart(saved, [product({ price: 120 })], money);
    expect(result.lines[0]?.product.price).toBe(120);
    expect(result.notices).toEqual([{ productId: 'p1', kind: 'price', message: 'The price of Rice changed from KES 100 to KES 120.' }]);
  });

  it('cuts the quantity to what is left', () => {
    const result = reconcileCart([{ productId: 'p1', quantity: 4, price: 100 }], [product({ stockQuantity: 2 })], money);
    expect(result.lines[0]?.quantity).toBe(2);
    expect(result.notices[0]).toMatchObject({ kind: 'reduced', message: 'Only 2 of Rice are left, so the quantity was reduced.' });
  });

  it('removes sold-out and withdrawn products with a reason', () => {
    const result = reconcileCart(
      [{ productId: 'p1', quantity: 1, price: 100 }, { productId: 'gone', quantity: 1, price: 5 }],
      [product({ stockQuantity: 1, reservedQuantity: 1 })],
      money,
    );
    expect(result.lines).toEqual([]);
    expect(result.notices.map((n) => n.kind)).toEqual(['removed', 'removed']);
  });

  it('does not report a price change for a legacy line with no recorded price', () => {
    expect(reconcileCart([{ productId: 'p1', quantity: 1, price: null }], [product()], money).notices).toEqual([]);
  });
});
