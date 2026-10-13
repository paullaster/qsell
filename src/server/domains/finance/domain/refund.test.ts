import { describe, expect, it } from 'vitest';
import { availableToRefund, canMove, checkPayoutDetails, destinationChanged, isFinished, looksDuplicate, phoneKey, refundedState } from './refund';

describe('refund rules', () => {
  it('moves only along its lifecycle, and finished refunds stay finished', () => {
    expect(canMove('draft', 'pending_approval')).toBe(true);
    expect(canMove('draft', 'paid')).toBe(false);
    expect(canMove('approved', 'paid')).toBe(true);
    expect(canMove('pending_approval', 'paid')).toBe(false);
    expect(canMove('paid', 'cancelled')).toBe(false);
    expect(canMove('rejected', 'draft')).toBe(true);
    expect(isFinished('paid') && isFinished('cancelled') && !isFinished('approved')).toBe(true);
  });
  it('asks for what each way of paying needs', () => {
    expect(checkPayoutDetails('mobile_money', {})).toMatch(/phone/);
    expect(checkPayoutDetails('mobile_money', { phone: '0712' })).toMatch(/too short/);
    expect(checkPayoutDetails('mobile_money', { phone: '0712345678' })).toBeNull();
    expect(checkPayoutDetails('bank_transfer', { bankName: 'KCB' })).toMatch(/account number.*account name/);
    expect(checkPayoutDetails('cheque', { payeeName: 'A B' })).toBeNull();
    expect(checkPayoutDetails('cash', {})).toMatch(/collect/);
  });
  it('flags a payout to a phone that is not the customer\'s', () => {
    expect(phoneKey('+254 712 345 678')).toBe('712345678');
    expect(destinationChanged('mobile_money', { phone: '0712345678' }, '+254712345678')).toBe(false);
    expect(destinationChanged('mobile_money', { phone: '0799000111' }, '+254712345678')).toBe(true);
    expect(destinationChanged('bank_transfer', { accountNumber: '1' }, '+254712345678')).toBe(false);
  });
  it('never refunds more than is owed after what is already asked for', () => {
    expect(availableToRefund(10000, 4000)).toBe(6000);
    expect(availableToRefund(10000, 12000)).toBe(0);
  });
  it('spots the same refund asked for twice within a day', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const r = { customerId: 'c', amountCents: 5000, methodId: 'm', status: 'approved' as const, createdAt: new Date('2026-10-13T08:00:00Z') };
    expect(looksDuplicate([r], { customerId: 'c', amountCents: 5000, methodId: 'm' }, now)).toBe(r);
    expect(looksDuplicate([{ ...r, status: 'cancelled' }], { customerId: 'c', amountCents: 5000, methodId: 'm' }, now)).toBeNull();
    expect(looksDuplicate([{ ...r, createdAt: new Date('2026-10-11T08:00:00Z') }], { customerId: 'c', amountCents: 5000, methodId: 'm' }, now)).toBeNull();
    expect(looksDuplicate([r], { customerId: 'c', amountCents: 5001, methodId: 'm' }, now)).toBeNull();
  });
  it('an order is refunded only when the paid refunds cover everything it was paid', () => {
    expect(refundedState(10000, 0)).toBe('none');
    expect(refundedState(10000, 4000)).toBe('partially_refunded');
    expect(refundedState(10000, 10000)).toBe('refunded');
  });
});
