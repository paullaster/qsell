import { describe, expect, it } from 'vitest';
import { payoutPlan, wholeShillings } from './vendor-payout';

describe('vendor M-Pesa payouts', () => {
  it('pays whole shillings only', () => {
    expect(wholeShillings('1500.00')).toBe('1500');
    expect(wholeShillings('1500')).toBe('1500');
    expect(wholeShillings('1500.0000')).toBe('1500');
    expect(wholeShillings('1500.50')).toBeNull();
    expect(wholeShillings('0.00')).toBeNull();
    expect(wholeShillings('-5')).toBeNull();
    expect(wholeShillings('abc')).toBeNull();
  });
  it('chooses the operation and fields for each kind of destination', () => {
    expect(payoutPlan('mpesa_phone', '254712345678', null, '1500', 'VPV-1')).toEqual({ operation: 'b2c', input: { phone: '254712345678', amount: '1500', commandId: 'BusinessPayment', remarks: 'Payment VPV-1' } });
    expect(payoutPlan('mpesa_paybill', '400200', 'ACC-77', '900', 'VPV-2')).toEqual({ operation: 'b2b_paybill', input: { partyB: '400200', amount: '900', accountReference: 'ACC-77', remarks: 'Payment VPV-2' } });
    expect(payoutPlan('mpesa_till', '123456', null, '900', 'VPV-2026-00003')?.input.accountReference).toBe('VPV-2026-0000');
    expect(payoutPlan('bank', '0123', null, '900', 'VPV-3')).toBeNull();
  });
});
