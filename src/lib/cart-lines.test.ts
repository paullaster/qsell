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

describe('an item that has a least and most to buy', () => {
  const lot = product({ minOrderQty: 3, maxOrderQty: 8, stockQuantity: 20 });

  it('starts a cart at the minimum even when one is asked for', () => {
    expect(addToCart([], lot, 1)).toMatchObject({ outcome: 'added', quantity: 3 });
    expect(addToCart([], lot, 5).lines[0]?.quantity).toBe(5);
  });

  it('never goes past the maximum, and says it is the maximum and not the stock', () => {
    const lines = addToCart([], lot, 6).lines;
    expect(addToCart(lines, lot, 6)).toMatchObject({ outcome: 'at_maximum', quantity: 8 });
  });

  it('says when the stock is below the least that may be bought', () => {
    const short = product({ minOrderQty: 3, stockQuantity: 2 });
    expect(addToCart([], short, 1)).toEqual({ lines: [], outcome: 'short_of_minimum', quantity: 0 });
  });

  it('sets a typed quantity within the limits', () => {
    const lines = addToCart([], lot, 4).lines;
    expect(setCartQuantity(lines, 'p1', 1)[0]?.quantity).toBe(3);
    expect(setCartQuantity(lines, 'p1', 50)[0]?.quantity).toBe(8);
    expect(setCartQuantity(lines, 'p1', 0)).toEqual([]);
  });

  it('raises or cuts a saved cart to the limits and tells the shopper', () => {
    const raised = reconcileCart([{ productId: 'p1', quantity: 1, price: 100 }], [lot], money);
    expect(raised.lines[0]?.quantity).toBe(3);
    expect(raised.notices).toEqual([expect.objectContaining({ kind: 'raised', message: 'The least you can buy of Rice is 3, so the quantity was raised.' })]);
    const cut = reconcileCart([{ productId: 'p1', quantity: 12, price: 100 }], [lot], money);
    expect(cut.lines[0]?.quantity).toBe(8);
    expect(cut.notices).toEqual([expect.objectContaining({ kind: 'limited' })]);
  });

  it('removes a line when there is less in stock than the minimum, with the reason', () => {
    const short = product({ minOrderQty: 3, stockQuantity: 2 });
    const out = reconcileCart([{ productId: 'p1', quantity: 3, price: 100 }], [short], money);
    expect(out.lines).toEqual([]);
    expect(out.notices[0]?.message).toContain('less in stock than the least that can be bought');
  });

  it('leaves an item with no limits exactly as before', () => {
    const plain = product({ minOrderQty: null, maxOrderQty: null });
    expect(addToCart([], plain, 1).lines[0]?.quantity).toBe(1);
    expect(reconcileCart([{ productId: 'p1', quantity: 2, price: 100 }], [plain], money).notices).toEqual([]);
  });
});
