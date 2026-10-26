import { describe, expect, it } from 'vitest';
import { checkRefundReceipt, checkRefundRequest, refundCents } from './vendor-refund';

describe('vendor refunds', () => {
  it('reads amounts in cents and refuses anything else', () => {
    expect(refundCents('250.5')).toBe(25_050);
    expect(refundCents('0')).toBeNull();
    expect(refundCents('-3')).toBeNull();
    expect(refundCents('1e3')).toBeNull();
  });
  it('asks for a credit, a way in, and no more than is open', () => {
    expect(checkRefundRequest({ creditEntryId: 'a', methodId: 'm', amount: '', note: '' }, 1000)).toEqual({});
    expect(Object.keys(checkRefundRequest({ creditEntryId: '', methodId: '', amount: 'x', note: '' }, 1000)).sort()).toEqual(['amount', 'creditEntryId', 'methodId']);
    expect(checkRefundRequest({ creditEntryId: 'a', methodId: 'm', amount: '10.01', note: '' }, 1000).amount).toMatch(/Only 10.00/);
  });
  it('asks for a reference and a real date that is not in the future', () => {
    expect(checkRefundReceipt({ reference: 'TT-1', receivedOn: '2026-10-25' }, '2026-10-25')).toEqual({});
    expect(Object.keys(checkRefundReceipt({ reference: ' ', receivedOn: '2026-10-26' }, '2026-10-25')).sort()).toEqual(['receivedOn', 'reference']);
    expect(checkRefundReceipt({ reference: 'x', receivedOn: '2026-02-30' }, '2026-10-25').receivedOn).toMatch(/date/);
  });
});
