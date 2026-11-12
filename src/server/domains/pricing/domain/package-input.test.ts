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
});
