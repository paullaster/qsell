import { describe, expect, it } from 'vitest';
import { emptyCard, money, projectionToSelected, selectedToProjection, withAccountType, withProfile, type CardField } from './customer-card';

const fields: CardField[] = [
  { fieldName: 'globalDimension1Code', dimensionId: 'd1', dimensionCode: 'DEPT', kind: 'global' },
  { fieldName: 'shortcutDimension3Code', dimensionId: 'd3', dimensionCode: 'AREA', kind: 'shortcut' },
];

describe('customer card', () => {
  it('turns stored dimension codes into choices and back, leaving empty ones out', () => {
    const selected = projectionToSelected({ global: { '1': 'SALES' }, shortcut: {} }, fields);
    expect(selected).toEqual({ globalDimension1Code: 'SALES', shortcutDimension3Code: '' });
    expect(selectedToProjection({ ...selected, shortcutDimension3Code: 'NORTH' }, fields)).toEqual({ global: { '1': 'SALES' }, shortcut: { '3': 'NORTH' } });
    expect(selectedToProjection({ globalDimension1Code: '', shortcutDimension3Code: '' }, fields)).toEqual({ global: {}, shortcut: {} });
  });

  it('brings a profile\'s type, terms, KRA setting and default dimensions along', () => {
    const profile = { id: 'p1', label: 'Wholesale', meta: { accountType: 'credit', creditLimit: '5000.00', paymentTermDays: '30', transmit: '1', dimensions: JSON.stringify({ global: { '1': 'SALES' }, shortcut: {} }) } };
    const form = withProfile(emptyCard(fields), profile, fields);
    expect(form).toMatchObject({ profileId: 'p1', profileLabel: 'Wholesale', accountType: 'credit', creditLimit: '5000.00', paymentTermDays: '30', transmitInvoicesToKra: true });
    expect(form.dimensions.globalDimension1Code).toBe('SALES');
  });

  it('keeps the chosen dimensions when the profile names none, and clears the profile when it is cleared', () => {
    const base = { ...emptyCard(fields), dimensions: { globalDimension1Code: 'MINE', shortcutDimension3Code: '' } };
    const cash = withProfile(base, { id: 'p2', label: 'Cash', meta: { accountType: 'cash', creditLimit: '9', paymentTermDays: '9', transmit: '', dimensions: 'not json' } }, fields);
    expect(cash).toMatchObject({ accountType: 'cash', creditLimit: '0', paymentTermDays: '0', transmitInvoicesToKra: false });
    expect(cash.dimensions.globalDimension1Code).toBe('MINE');
    expect(withProfile(cash, null, fields)).toMatchObject({ profileId: '', profileLabel: '' });
  });

  it('zeroes the limit and terms for cash and keeps them for credit', () => {
    const credit = { accountType: 'credit' as const, creditLimit: '100', paymentTermDays: '14' };
    expect(withAccountType(credit, 'cash')).toMatchObject({ accountType: 'cash', creditLimit: '0', paymentTermDays: '0' });
    expect(withAccountType(credit, 'credit')).toEqual(credit);
  });

  it('writes money with two decimals and zero for nonsense', () => {
    expect(money('1234.5')).toMatch(/1,?234\.50/);
    expect(money(null)).toBe('0.00');
    expect(money('x')).toBe('0.00');
  });
});
