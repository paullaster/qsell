import { describe, expect, it } from 'vitest';
import { branchOfScope, canRegister, emptyRegisterForm, registerFormFor, registerPayload, scopeKey, stockChanged, STATUS_TONE } from './etims-forms';

const product = { id: 'p1', label: 'Rice (SKU1)', meta: { stock: '12', taxCode: '1', qtyUnitCode: 'U', pkgUnitCode: 'CT', itemClassCode: '99000000' } };

describe('eTIMS forms', () => {
  it('keys the company and branches', () => {
    expect(scopeKey({ scope: 'company', branchId: null })).toBe('company');
    expect(scopeKey({ scope: 'branch', branchId: 'b1' })).toBe('b1');
    expect(branchOfScope('company')).toBeNull();
    expect(branchOfScope('b1')).toBe('b1');
    expect(branchOfScope('')).toBeNull();
  });
  it('fills the form from the product chosen, and empties it with none', () => {
    expect(registerFormFor(product)).toEqual({ qtyUnitCode: 'U', pkgUnitCode: 'CT', itemClassCode: '99000000', stock: '12' });
    expect(registerFormFor(null)).toEqual(emptyRegisterForm());
    expect(registerFormFor({ id: 'x', label: 'x' })).toEqual(emptyRegisterForm());
  });
  it('allows only products that have an eTIMS tax code', () => {
    expect(canRegister(product)).toBe(true);
    expect(canRegister({ ...product, meta: { ...product.meta, taxCode: '' } })).toBe(false);
    expect(canRegister(null)).toBe(false);
  });
  it('builds what is sent, or says what is wrong', () => {
    expect(registerPayload(null, product, registerFormFor(product))).toEqual({ ok: true, payload: { branchId: null, productId: 'p1', qtyUnitCode: 'U', pkgUnitCode: 'CT', itemClassCode: '99000000', initialStock: 12 } });
    expect(registerPayload('b1', product, { ...registerFormFor(product), stock: '-1' })).toMatchObject({ ok: false });
    expect(registerPayload('b1', product, { ...registerFormFor(product), stock: '1.5555' })).toMatchObject({ ok: false });
    expect(registerPayload('b1', product, { ...registerFormFor(product), stock: '1.5' })).toMatchObject({ ok: true });
    expect(registerPayload('b1', product, { ...registerFormFor(product), qtyUnitCode: ' ' })).toMatchObject({ ok: false });
  });
  it('knows when a stock figure changed', () => {
    expect(stockChanged('5', 3)).toBe(true);
    expect(stockChanged('3', 3)).toBe(false);
    expect(stockChanged('', 3)).toBe(false);
    expect(stockChanged('2.5', 3)).toBe(true);
    expect(stockChanged('2.5555', 3)).toBe(false);
  });
  it('has a tone for every status', () => {
    expect(Object.keys(STATUS_TONE).sort()).toEqual(['deleted', 'failed', 'pending', 'registered', 'unconfirmed']);
  });
});
