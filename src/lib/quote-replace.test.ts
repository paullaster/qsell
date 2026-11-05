import { describe, expect, it } from 'vitest';
import { canReplaceLine, replaceLineProduct } from './quote-replace';

const line = { productId: 'a', quantity: 3, discountPercent: 10, sectionId: 's1', unitPrice: 99, priceMode: 'manual' as const, unitId: 'crate', unitCode: 'CRT', fromTemplate: true, fromSectionTemplate: true };

describe('replaceLineProduct', () => {
  it('keeps the place and the deal: section, quantity and discount', () => {
    const out = replaceLineProduct(line, { id: 'b', price: 20 });
    expect(out).toMatchObject({ productId: 'b', quantity: 3, discountPercent: 10, sectionId: 's1' });
  });
  it('drops what belonged to the old item: typed price, unit and template marks', () => {
    const out = replaceLineProduct(line, { id: 'b', price: 20 });
    expect(out).toMatchObject({ unitPrice: 20, priceMode: 'catalog', unitId: null, unitCode: null, fromTemplate: false, fromSectionTemplate: false });
  });
  it('leaves no price at all when the new item has none, so the price lists (or a typed price) decide', () => {
    const out = replaceLineProduct(line, { id: 'b', price: undefined });
    expect(out).not.toHaveProperty('unitPrice');
    expect(out.priceMode).toBe('catalog');
  });
  it('does not change the line it was given', () => {
    replaceLineProduct(line, { id: 'b', price: 20 });
    expect(line.productId).toBe('a');
    expect(line.unitPrice).toBe(99);
  });
  it('refuses to treat a free gift as the person\'s line', () => {
    expect(canReplaceLine({ isGift: true })).toBe(false);
    expect(canReplaceLine({})).toBe(true);
  });
});
