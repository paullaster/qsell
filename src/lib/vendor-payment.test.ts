import { describe, expect, it } from 'vitest';
import { ageBucket, approvalRefusal, checkAllocations, checkVoucherHeader, needsThreePeople, releaseRefusal } from './vendor-payment';

describe('voucher forms', () => {
  it('names what is missing', () => {
    expect(checkVoucherHeader({ kind: 'invoices', vendorId: 'v', methodId: 'm', narration: '', advanceId: '' })).toEqual({});
    expect(Object.keys(checkVoucherHeader({ kind: 'advance', vendorId: '', methodId: '', narration: '', advanceId: '' })).sort()).toEqual(['advanceId', 'methodId', 'vendorId']);
  });
  it('allocates within what is open, once per invoice', () => {
    const items = [{ purchaseInvoiceId: 'a', availableCents: 10_000 }, { purchaseInvoiceId: 'b', availableCents: 500 }];
    expect(checkAllocations(items, [{ purchaseInvoiceId: 'a', amount: '60.50' }, { purchaseInvoiceId: 'b', amount: '5' }])).toEqual({ problems: {}, totalCents: 6550 });
    const bad = checkAllocations(items, [{ purchaseInvoiceId: 'a', amount: '100.01' }, { purchaseInvoiceId: 'a', amount: '1' }, { purchaseInvoiceId: 'z', amount: '1' }, { purchaseInvoiceId: 'b', amount: '0' }]);
    expect(Object.keys(bad.problems).sort()).toEqual(['allocation.0', 'allocation.1', 'allocation.2', 'allocation.3']);
    expect(checkAllocations(items, []).problems.allocations).toMatch(/at least one/);
  });
});

describe('who may do what', () => {
  it('needs three people only from the threshold up, and 0 turns it off', () => {
    expect(needsThreePeople(9_999_999, 10_000_000)).toBe(false);
    expect(needsThreePeople(10_000_000, 10_000_000)).toBe(true);
    expect(needsThreePeople(99_999_999, 0)).toBe(false);
  });
  it('keeps the approver from the preparer, and the payer from both when the sum is large', () => {
    expect(approvalRefusal('u1', 'u1')).toMatch(/another person/);
    expect(approvalRefusal('u2', 'u1')).toBeNull();
    expect(releaseRefusal('u1', 'u1', 'u2', true)).toMatch(/third person/);
    expect(releaseRefusal('u2', 'u1', 'u2', true)).toMatch(/third person/);
    expect(releaseRefusal('u3', 'u1', 'u2', true)).toBeNull();
    expect(releaseRefusal('u1', 'u1', 'u2', false)).toBeNull();
  });
});

describe('ageing', () => {
  it('puts an open invoice in its column by due date, using the invoice date when there is none', () => {
    expect(ageBucket('2026-11-01', '2026-10-01', '2026-10-25')).toBe('not_due');
    expect(ageBucket('2026-10-25', '2026-10-01', '2026-10-25')).toBe('not_due');
    expect(ageBucket('2026-10-24', '2026-10-01', '2026-10-25')).toBe('d1_30');
    expect(ageBucket('2026-09-24', '2026-08-01', '2026-10-25')).toBe('d31_60');
    expect(ageBucket('2026-08-25', '2026-08-01', '2026-10-25')).toBe('d61_90');
    expect(ageBucket(null, '2026-06-01', '2026-10-25')).toBe('d90_plus');
  });
});
