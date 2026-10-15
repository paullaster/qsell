import { describe, expect, it } from 'vitest';
import type { TaxCategory } from '@/types/index';
import { breakdown, isPricingModel, isTaxType, labelOfTaxType, taxFormFrom, taxLabel, taxPayload } from './tax-forms';

const tax: TaxCategory = { id: 't1', name: 'Standard VAT', code: 'VAT16', rate: 16, timsCode: 'A', etimsCode: 'B', type: 'vat', countryCode: 'KE', countryName: 'Kenya', description: 'Standard', isInclusive: true, isDefault: false, isActive: true, createdAt: '', updatedAt: '' };

describe('tax forms', () => {
  it('starts a new rule as an ordinary one, and fills an edited rule from what is saved', () => {
    expect(taxFormFrom(null).isDefault).toBe(false);
    expect(taxFormFrom(null)).toMatchObject({ isInclusive: true, isActive: true, rate: '' });
    expect(taxFormFrom(tax)).toMatchObject({ name: 'Standard VAT', rate: '16', type: 'vat', isInclusive: true });
  });
  it('needs a name and a rate of zero or more', () => {
    const base = taxFormFrom(tax);
    expect(taxPayload({ ...base, name: ' ' })).toMatchObject({ ok: false });
    expect(taxPayload({ ...base, code: ' ' })).toMatchObject({ ok: false });
    expect(taxPayload({ ...base, rate: '' })).toMatchObject({ ok: false });
    expect(taxPayload({ ...base, rate: '-1' })).toMatchObject({ ok: false });
    expect(taxPayload({ ...base, rate: 'abc' })).toMatchObject({ ok: false });
    expect(taxPayload({ ...base, rate: '0' })).toMatchObject({ ok: true });
  });
  it('trims, upper-cases the country code and turns the rate into a number', () => {
    const out = taxPayload({ ...taxFormFrom(tax), name: ' VAT ', countryCode: ' ke ', rate: '8.5' });
    expect(out).toMatchObject({ ok: true, payload: { name: 'VAT', countryCode: 'KE', rate: 8.5 } });
  });
  it('works out an amount both ways', () => {
    const inc = breakdown(116, 16, true);
    expect(inc.net).toBeCloseTo(100);
    expect(inc.tax).toBeCloseTo(16);
    expect(inc.gross).toBe(116);
    const exc = breakdown(100, 16, false);
    expect(exc).toEqual({ net: 100, tax: 16, gross: 116 });
    expect(breakdown(50, 0, true)).toEqual({ net: 50, tax: 0, gross: 50 });
    expect(breakdown(Number.NaN, 16, false)).toEqual({ net: 0, tax: 0, gross: 0 });
  });
  it('words and recognises the choices', () => {
    expect(labelOfTaxType('exempt')).toBe('Zero Rated / Exempt');
    expect(labelOfTaxType('mystery')).toBe('mystery');
    expect(isTaxType('vat')).toBe(true);
    expect(isTaxType('nope')).toBe(false);
    expect(isPricingModel('inclusive')).toBe(true);
    expect(isPricingModel('x')).toBe(false);
    expect(taxLabel(tax)).toBe('Standard VAT (16%) - Inclusive');
  });
});
