import { describe, expect, it } from 'vitest';
import { productSellability } from './product-sellability';

describe('whether a product is offered for sale', () => {
  it('follows the classification for goods, whatever the price', () => {
    expect(productSellability({ classificationSellable: true, kind: 'inventory', price: undefined })).toBe(true);
    expect(productSellability({ classificationSellable: true, kind: 'non_inventory', price: null })).toBe(true);
    expect(productSellability({ classificationSellable: false, kind: 'inventory', price: 50 })).toBe(false);
  });

  it('keeps a service out of the shop until it has a selling price', () => {
    for (const price of [undefined, null, 0, -1, Number.NaN]) {
      expect(productSellability({ classificationSellable: true, kind: 'service', price }), String(price)).toBe(false);
    }
    expect(productSellability({ classificationSellable: true, kind: 'service', price: 1500 })).toBe(true);
  });

  it('never sells a service whose classification is not sold from the shop, price or not', () => {
    expect(productSellability({ classificationSellable: false, kind: 'service', price: 1500 })).toBe(false);
  });
});
