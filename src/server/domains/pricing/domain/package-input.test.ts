import { describe, expect, it } from 'vitest';
import { parsePackageInput } from './package-input';

const good = () => ({
  productId: 'p1',
  pricingMode: 'base_plus_differences',
  allocation: 'list_price',
  shortStockMode: 'hide',
  slots: [{ name: ' Fish ', minPicks: 1, maxPicks: 1, options: [{ productId: 'f1', quantity: 1, difference: 100 }] }],
});

describe('parsePackageInput', () => {
  it('reads a good package, trimming text and filling the defaults', () => {
    const r = parsePackageInput(good());
    expect(r).toMatchObject({ ok: true, input: { productId: 'p1', isActive: true, slots: [{ name: 'Fish', allowRepeats: false, included: false, options: [{ productId: 'f1', quantity: 1, difference: 100, ownPrice: null, isDefault: false }] }] } });
  });
  it('refuses anything that is not the shape asked for, in plain words', () => {
    expect(parsePackageInput(null)).toMatchObject({ ok: false });
    expect(parsePackageInput({ ...good(), productId: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/product/) });
    expect(parsePackageInput({ ...good(), pricingMode: 'free' })).toMatchObject({ ok: false, error: expect.stringMatching(/priced/) });
    expect(parsePackageInput({ ...good(), allocation: 'x' })).toMatchObject({ ok: false });
    expect(parsePackageInput({ ...good(), shortStockMode: 'x' })).toMatchObject({ ok: false });
  });
  it('refuses numbers that are not numbers, including NaN and strings', () => {
    const bad = (option: Record<string, unknown>) => parsePackageInput({ ...good(), slots: [{ name: 'A', minPicks: 1, maxPicks: 1, options: [{ productId: 'f', quantity: 1, ...option }] }] });
    expect(bad({ quantity: '1' })).toMatchObject({ ok: false });
    expect(bad({ difference: Number.NaN })).toMatchObject({ ok: false });
    expect(bad({ ownPrice: 'free' })).toMatchObject({ ok: false });
    expect(parsePackageInput({ ...good(), slots: [{ name: 'A', minPicks: '1', maxPicks: 1, options: [] }] })).toMatchObject({ ok: false });
  });
  it('bounds the lists', () => {
    expect(parsePackageInput({ ...good(), slots: Array.from({ length: 21 }, () => ({ name: 'A', minPicks: 1, maxPicks: 1, options: [] })) })).toMatchObject({ ok: false });
    expect(parsePackageInput({ ...good(), slots: [{ name: 'A', minPicks: 1, maxPicks: 1, options: Array.from({ length: 51 }, () => ({ productId: 'x', quantity: 1 })) }] })).toMatchObject({ ok: false });
  });

  describe('category slots and the note setting', () => {
    const base = { productId: 'p', pricingMode: 'base_plus_differences', allocation: 'list_price', shortStockMode: 'hide' };
    it('reads a slot filled from a category, with what each product adds, and drops the hand-made options', () => {
      const result = parsePackageInput({ ...base, allowNote: true, slots: [{ name: 'Vegetables', minPicks: 1, maxPicks: 2, source: 'category', categoryId: 'cat-veg', categoryDifference: 10, categoryOwnPrice: null, categoryQuantity: 0.5, options: [{ productId: 'x', quantity: 1 }] }] });
      expect(result.ok && result.input.allowNote).toBe(true);
      expect(result.ok && result.input.slots[0]).toMatchObject({ source: 'category', categoryId: 'cat-veg', categoryDifference: 10, categoryOwnPrice: null, categoryQuantity: 0.5, options: [] });
    });
    it('refuses a number that is not a number in a category slot', () => {
      expect(parsePackageInput({ ...base, slots: [{ name: 'V', minPicks: 1, maxPicks: 1, source: 'category', categoryId: 'c', categoryDifference: 'abc' }] }).ok).toBe(false);
    });
    it('leaves an ordinary slot as it was, and the note setting out when it is not a yes or no', () => {
      const result = parsePackageInput({ ...base, allowNote: 'yes', slots: [{ name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: 'a', quantity: 1 }] }] });
      expect(result.ok && 'allowNote' in result.input).toBe(false);
      expect(result.ok && result.input.slots[0]?.source).toBeUndefined();
    });
  });
});
