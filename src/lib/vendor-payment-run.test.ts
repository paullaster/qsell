import { describe, expect, it } from 'vitest';
import { applyLimits, buildChequeSchedule, chequeNumbers, confirmRefusal, dueOnOrBefore } from './vendor-payment-run';

describe('payment runs', () => {
  it('decides what is due by the due date, or the invoice date when there is none', () => {
    expect(dueOnOrBefore('2026-10-25', '2026-09-01', '2026-10-25')).toBe(true);
    expect(dueOnOrBefore('2026-10-26', '2026-09-01', '2026-10-25')).toBe(false);
    expect(dueOnOrBefore(null, '2026-10-01', '2026-10-25')).toBe(true);
  });
  it('counts cheque numbers on, keeping the zeros, and refuses a start that is not a number', () => {
    expect(chequeNumbers('000120', 3)).toEqual(['000120', '000121', '000122']);
    expect(chequeNumbers('99', 3)).toEqual(['99', '100', '101']);
    expect(chequeNumbers('12a', 2)).toBeNull();
    expect(chequeNumbers('', 2)).toBeNull();
    expect(chequeNumbers('5', 0)).toBeNull();
  });
  it('writes the cheque list, making spreadsheet formulas harmless', () => {
    const csv = buildChequeSchedule([{ chequeNo: '0001', payee: '=HYPERLINK("x")', amountCents: 12345, voucherNo: 'VPV-1' }], 'KES', '2026-10-25');
    expect(csv.split('\r\n')[0]).toBe('Cheque number,Payee,Amount,Currency,Date,Voucher');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('123.45,KES,2026-10-25,VPV-1');
  });
  it('keeps the releaser from confirming', () => {
    expect(confirmRefusal('u1', 'u1')).toMatch(/cannot be the one/);
    expect(confirmRefusal('u2', 'u1')).toBeNull();
    expect(confirmRefusal('u2', null)).toBeNull();
  });
  it('leaves out vendors below the minimum or above the maximum, with the reason', () => {
    const s = [
      { vendorId: 'a', vendorName: 'A', items: [{ purchaseInvoiceId: 'x', availableCents: 500 }] },
      { vendorId: 'b', vendorName: 'B', items: [{ purchaseInvoiceId: 'y', availableCents: 5000 }, { purchaseInvoiceId: 'z', availableCents: 5000 }] },
      { vendorId: 'c', vendorName: 'C', items: [{ purchaseInvoiceId: 'w', availableCents: 2000 }] },
    ];
    const out = applyLimits(s, 1000, 9000);
    expect(out.kept.map((k) => k.vendorId)).toEqual(['c']);
    expect(out.left.map((l) => l.vendorId)).toEqual(['a', 'b']);
    expect(applyLimits(s, null, null).kept).toHaveLength(3);
  });
});
