import { describe, expect, it } from 'vitest';
import { CHEQUE_COUNTS_CHOICES, CHEQUE_COUNTS_MODES, DEFAULT_CHEQUE_COUNTS, isChequeCountsMode, planPaymentMove, settledState } from './order-payment';

describe('settledState', () => {
  it('is unpaid with nothing settled, part paid below the total and paid at or above it', () => {
    expect(settledState(10000, 0)).toBe('unpaid');
    expect(settledState(10000, 2500)).toBe('partially_paid');
    expect(settledState(10000, 10000)).toBe('paid');
    expect(settledState(10000, 10001)).toBe('paid');
  });
  it('does not decide an order with nothing invoiced', () => {
    expect(settledState(0, 0)).toBeNull();
  });
});

describe('planPaymentMove', () => {
  it('confirms payment when fully settled, from unpaid or part paid', () => {
    expect(planPaymentMove('unpaid', 'paid')).toEqual({ stage: 'payment_confirmed', paymentStatus: 'paid' });
    expect(planPaymentMove('partially_paid', 'paid')).toEqual({ stage: 'payment_confirmed', paymentStatus: 'paid' });
  });
  it('records a part payment from unpaid', () => {
    expect(planPaymentMove('unpaid', 'partially_paid')).toEqual({ stage: 'payment_partial', paymentStatus: 'partially_paid' });
  });
  it('records a payment taken back, to part paid or to unpaid', () => {
    expect(planPaymentMove('paid', 'partially_paid')).toEqual({ stage: 'payment_reversed', paymentStatus: 'partially_paid' });
    expect(planPaymentMove('paid', 'unpaid')).toEqual({ stage: 'payment_reversed', paymentStatus: 'unpaid' });
    expect(planPaymentMove('partially_paid', 'unpaid')).toEqual({ stage: 'payment_reversed', paymentStatus: 'unpaid' });
  });
  it('changes nothing when already there', () => {
    expect(planPaymentMove('paid', 'paid')).toBeNull();
    expect(planPaymentMove('unpaid', 'unpaid')).toBeNull();
  });
  it('leaves payments in flight, reconciled, failed and refunded orders alone', () => {
    for (const s of ['pending_verification', 'reconciled', 'discrepancy', 'failed', 'refunded', 'partially_refunded']) {
      expect(planPaymentMove(s, 'paid'), s).toBeNull();
      expect(planPaymentMove(s, 'unpaid'), s).toBeNull();
    }
  });
});

describe('cheque rule', () => {
  it('defaults to counting a cheque when it clears', () => {
    expect(DEFAULT_CHEQUE_COUNTS).toBe('on_clearing');
    expect(CHEQUE_COUNTS_CHOICES.map((c) => c.id)).toEqual([...CHEQUE_COUNTS_MODES]);
  });
  it('accepts only known modes', () => {
    expect(isChequeCountsMode('on_receipt')).toBe(true);
    expect(isChequeCountsMode('whenever')).toBe(false);
    expect(isChequeCountsMode(undefined)).toBe(false);
  });
});
