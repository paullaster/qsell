import { describe, expect, it } from 'vitest';
import { refreshLinesForProduct } from './quote-product-refresh';

const money = (v: number) => `KES ${v.toFixed(2)}`;
const line = (productId: string, priceMode: string, unitPrice: number | null) => ({ productId, priceMode, unitPrice, quantity: 2 });

describe('refreshLinesForProduct', () => {
  it('moves catalogue-priced lines of that product to the new price and leaves other products alone', () => {
    const lines = [line('a', 'catalog', 10), line('b', 'catalog', 10)];
    const out = refreshLinesForProduct(lines, { price: 10, name: 'A' }, { id: 'a', price: 12, name: 'A' }, money);
    expect(out.lines[0]?.unitPrice).toBe(12);
    expect(out.lines[1]).toBe(lines[1]);
    expect(out.notes).toEqual([]);
  });

  it('keeps a price the person set and says the catalogue moved', () => {
    const lines = [line('a', 'manual', 9)];
    const out = refreshLinesForProduct(lines, { price: 10, name: 'A' }, { id: 'a', price: 12, name: 'A' }, money);
    expect(out.lines[0]).toBe(lines[0]);
    expect(out.notes).toEqual([{ productId: 'a', line: 0, message: 'A: the catalogue price is now KES 12.00. This line keeps the price you set.' }]);
  });

  it('says nothing when the price did not change, and never touches quantity', () => {
    const lines = [line('a', 'manual', 9), line('a', 'catalog', 10)];
    const out = refreshLinesForProduct(lines, { price: 10, name: 'A' }, { id: 'a', price: 10, name: 'A2' }, money);
    expect(out.notes).toEqual([]);
    expect(out.lines.map((l) => l.quantity)).toEqual([2, 2]);
    expect(out.lines[1]).toBe(lines[1]);
  });

  it('gives no note when the earlier product is unknown', () => {
    const out = refreshLinesForProduct([line('a', 'manual', 9)], undefined, { id: 'a', price: 12, name: 'A' }, money);
    expect(out.notes).toEqual([]);
  });
});
