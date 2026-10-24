import { describe, expect, it } from 'vitest';
import { advanceCeiling, amendmentNeedsApproval, checkAdvance, checkPoHeader, checkPoLine, describeChanges, emptyPoHeader, emptyPoLine, lineAmounts, orderTotals, type Snapshot, type SnapshotLine } from './purchase-order';

describe('amounts', () => {
  it('applies the discount and then the tax, in cents', () => {
    expect(lineAmounts({ quantity: '4', unitPrice: '1250.50', discountPercent: '10', taxRate: '16' })).toEqual({ net: 450180, tax: 72029, total: 522209 });
  });
  it('adds the lines up', () => {
    const t = orderTotals([{ quantity: '2', unitPrice: '100', discountPercent: '0', taxRate: '16' }, { quantity: '1', unitPrice: '50.50', discountPercent: '', taxRate: '' }]);
    expect(t).toEqual({ subtotal: 25050, tax: 3200, total: 28250 });
  });
});

describe('forms', () => {
  it('names what is missing', () => {
    expect(Object.keys(checkPoHeader(emptyPoHeader('2026-10-24'))).sort()).toEqual(['categoryId', 'currency', 'vendorId']);
    expect(Object.keys(checkPoLine({ ...emptyPoLine(), description: 'x' })).sort()).toEqual(['description', 'unitPrice']);
    expect(checkPoLine({ ...emptyPoLine(), description: 'Cable 6mm', unitPrice: '2.25' })).toEqual({});
  });
});

describe('amendments', () => {
  const line0: SnapshotLine = { description: 'Inverter', quantity: '4', unit: 'each', unitPrice: '250.00', discountPercent: '0', taxRate: '0', expectedDate: null };
  const base: Snapshot = { total: '1000.00', expectedDate: '2026-12-01', paymentTerms: '30 days', deliveryTerms: null, requiresAdvancePayment: false, lines: [line0] };
  it('describes a change in words', () => {
    const next: Snapshot = { ...base, total: '750.00', expectedDate: '2026-12-15', lines: [{ ...line0, quantity: '3' }, { description: 'Cable', quantity: '10', unit: 'm', unitPrice: '1.00', discountPercent: '0', taxRate: '0', expectedDate: null }] };
    const out = describeChanges(base, next);
    expect(out).toEqual(expect.arrayContaining(['The order total changed from 1000.00 to 750.00.', 'Expected delivery changed from 2026-12-01 to 2026-12-15.', 'Inverter: quantity 4 to 3.', 'Added: Cable, 10 m at 1.00.']));
    expect(describeChanges(base, base)).toEqual([]);
  });
  it('needs approval for any price change or a rise beyond the tolerance, not for a smaller or later order', () => {
    expect(amendmentNeedsApproval(base, { ...base, lines: [{ ...line0, unitPrice: '240.00' }] }, 0)).toBe(true);
    expect(amendmentNeedsApproval(base, { ...base, total: '1100.00', lines: [{ ...line0, quantity: '4.4' }] }, 5)).toBe(true);
    expect(amendmentNeedsApproval(base, { ...base, total: '1040.00', lines: [{ ...line0, quantity: '4.16' }] }, 5)).toBe(false);
    expect(amendmentNeedsApproval(base, { ...base, total: '750.00', lines: [{ ...line0, quantity: '3' }] }, 0)).toBe(false);
    expect(amendmentNeedsApproval(base, { ...base, expectedDate: '2027-01-01' }, 0)).toBe(false);
    expect(amendmentNeedsApproval(base, { ...base, requiresAdvancePayment: true }, 0)).toBe(true);
  });
});

describe('advance', () => {
  it('cannot exceed the order total less other live advances', () => {
    expect(advanceCeiling(100000, 30000)).toBe(70000);
    expect(advanceCeiling(100000, 200000)).toBe(0);
    expect(checkAdvance('800', 70000, '', 'Deposit to start').amount).toBeDefined();
    expect(checkAdvance('500', 70000, '', 'x').reason).toBeDefined();
    expect(checkAdvance('500', 70000, '2026-12-01', 'Deposit to start')).toEqual({});
  });
});
