import { describe, expect, it } from 'vitest';
import {
  firstUnpricedFixed,
  priceOnModeChange,
  readPriceInput,
  unpricedFixedMessage,
} from './template-line-price';

describe('priceOnModeChange', () => {
  it('keeps no price for the catalogue', () => {
    expect(priceOnModeChange('catalog', 50, 80)).toBeNull();
  });
  it('keeps the price already typed, then the standard price', () => {
    expect(priceOnModeChange('fixed', 50, 80)).toBe(50);
    expect(priceOnModeChange('fixed', null, 80)).toBe(80);
  });
  it('leaves the price empty when nothing is known, never 0', () => {
    expect(priceOnModeChange('fixed', null, null)).toBeNull();
    expect(priceOnModeChange('fixed', null, undefined)).toBeNull();
  });
  it('keeps a typed 0', () => {
    expect(priceOnModeChange('fixed', 0, 80)).toBe(0);
  });
});

describe('readPriceInput', () => {
  it('treats empty as no price', () => {
    expect(readPriceInput('')).toBeNull();
    expect(readPriceInput('  ')).toBeNull();
  });
  it('reads numbers, including 0', () => {
    expect(readPriceInput('12.5')).toBe(12.5);
    expect(readPriceInput('0')).toBe(0);
  });
  it('treats junk as no price', () => {
    expect(readPriceInput('abc')).toBeNull();
  });
});

describe('firstUnpricedFixed', () => {
  it('finds a fixed item without a price', () => {
    expect(
      firstUnpricedFixed([
        { priceMode: 'catalog', unitPrice: null },
        { priceMode: 'fixed', unitPrice: 0 },
        { priceMode: 'fixed', unitPrice: null },
      ]),
    ).toBe(2);
  });
  it('is -1 when every fixed item has a price', () => {
    expect(firstUnpricedFixed([{ priceMode: 'catalog', unitPrice: null }])).toBe(-1);
  });
  it('names the item in the message', () => {
    expect(unpricedFixedMessage('Cable')).toContain('Cable is set to a fixed price');
  });
});

describe('missing prices', () => {
  it('counts an absent price as no price', () => {
    expect(firstUnpricedFixed([{ priceMode: 'fixed' }])).toBe(0);
    expect(priceOnModeChange('fixed', undefined, 9)).toBe(9);
  });
});
