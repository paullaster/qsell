import { describe, expect, it } from 'vitest';
import { canRecallCredit, checkCreditHeader, checkCreditLine, creditAmounts, creditTotals, takeBackFromLinks, type OriginalLine } from './vendor-credit-memo';

const original = (over: Partial<OriginalLine> = {}): OriginalLine => ({ id: 'l1', description: 'Panel', quantity: 10, unitPriceCents: 10_000, taxRate: 16, netCents: 100_000, creditedQuantity: 0, creditedNetCents: 0, ...over });

describe('the header', () => {
  const h = { vendorCreditNo: 'CN-1', creditDate: '2026-10-01', reason: 'Billed twice', notes: '' };
  it('is checked in plain words', () => {
    expect(checkCreditHeader(h, '2026-10-25')).toEqual({});
    expect(Object.keys(checkCreditHeader({ ...h, vendorCreditNo: ' ', reason: ' ', creditDate: '2026-12-01' }, '2026-10-25')).sort()).toEqual(['creditDate', 'reason', 'vendorCreditNo']);
  });
});

describe('what a credit line is worth', () => {
  it('credits some of the goods at the price billed', () => {
    expect(creditAmounts({ invoiceLineId: 'l1', mode: 'quantity', quantity: '3', unitPrice: '' }, original())).toEqual({ quantity: 3, unitPrice: '100.00', netCents: 30_000, taxCents: 4_800 });
  });
  it('credits a price difference on all of the goods', () => {
    expect(creditAmounts({ invoiceLineId: 'l1', mode: 'price', quantity: '', unitPrice: '5.50' }, original())).toEqual({ quantity: 10, unitPrice: '5.50', netCents: 5_500, taxCents: 880 });
  });
  it('adds up lines', () => {
    expect(creditTotals([{ quantity: 1, unitPrice: '1', netCents: 1000, taxCents: 160 }, { quantity: 1, unitPrice: '1', netCents: 500, taxCents: 0 }])).toEqual({ subtotal: 1500, tax: 160, total: 1660 });
  });
});

describe('what may be credited', () => {
  it('accepts a quantity within what is left and refuses more', () => {
    expect(checkCreditLine({ invoiceLineId: 'l1', mode: 'quantity', quantity: '4', unitPrice: '' }, original({ creditedQuantity: 6, creditedNetCents: 60_000 }))).toEqual({});
    expect(checkCreditLine({ invoiceLineId: 'l1', mode: 'quantity', quantity: '4.001', unitPrice: '' }, original({ creditedQuantity: 6, creditedNetCents: 60_000 })).quantity).toMatch(/Only 4 of this line/);
    expect(checkCreditLine({ invoiceLineId: 'l1', mode: 'quantity', quantity: '0', unitPrice: '' }, original()).quantity).toMatch(/quantity/);
  });
  it('refuses a price difference above the price, and a total above what was billed', () => {
    expect(checkCreditLine({ invoiceLineId: 'l1', mode: 'price', quantity: '', unitPrice: '100.01' }, original()).unitPrice).toMatch(/more than the price billed/);
    expect(checkCreditLine({ invoiceLineId: 'l1', mode: 'price', quantity: '', unitPrice: '20' }, original({ creditedNetCents: 90_000 })).invoiceLineId).toMatch(/more than was billed/);
    expect(checkCreditLine({ invoiceLineId: 'l1', mode: 'price', quantity: '', unitPrice: '20' }, original())).toEqual({});
  });
  it('knows a line that is not on the invoice', () => {
    expect(checkCreditLine({ invoiceLineId: 'x', mode: 'price', quantity: '', unitPrice: '1' }, undefined).invoiceLineId).toMatch(/not on the invoice/);
  });
});

describe('putting goods back to uninvoiced', () => {
  it('takes from the last link first, never more than is counted as invoiced', () => {
    const links = [{ rgnLineId: 'a', linked: 6, invoiced: 6 }, { rgnLineId: 'b', linked: 4, invoiced: 4 }];
    expect(takeBackFromLinks(5, links)).toEqual({ takes: [{ rgnLineId: 'b', quantity: 4 }, { rgnLineId: 'a', quantity: 1 }], short: 0 });
    expect(takeBackFromLinks(3, [{ rgnLineId: 'a', linked: 6, invoiced: 2 }])).toEqual({ takes: [{ rgnLineId: 'a', quantity: 2 }], short: 1 });
  });
});

describe('taking a credit memo back', () => {
  it('is possible only while submitted and untouched', () => {
    expect(canRecallCredit('submitted', null)).toBe(true);
    expect(canRecallCredit('submitted', '2026-10-25T10:00:00Z')).toBe(false);
    expect(canRecallCredit('received', null)).toBe(false);
  });
});
