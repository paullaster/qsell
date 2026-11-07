import { describe, expect, it } from 'vitest';
import { canReplaceLine, replaceLineProduct, replaceTemplateLineProduct } from './quote-replace';

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

describe('replaceTemplateLineProduct', () => {
  const line = { sectionId: 's1', productId: 'prod_old', quantity: 4, priceMode: 'fixed' as const, unitPrice: 900, discountPercent: 5 };

  it('puts the new product in the same place with the same quantity and discount', () => {
    const next = replaceTemplateLineProduct(line, { id: 'prod_new' });
    expect(next).toMatchObject({ sectionId: 's1', productId: 'prod_new', quantity: 4, discountPercent: 5 });
  });

  it('drops a fixed price that was set for the old item, so the line follows the catalogue again', () => {
    expect(replaceTemplateLineProduct(line, { id: 'prod_new' })).toMatchObject({ priceMode: 'catalog', unitPrice: null });
  });

  it('leaves the original line as it was', () => {
    replaceTemplateLineProduct(line, { id: 'prod_new' });
    expect(line).toMatchObject({ productId: 'prod_old', priceMode: 'fixed', unitPrice: 900 });
  });
});
