import { describe, expect, it } from 'vitest';
import { CLAIM_WORDS, canCompletePayment, canLookUpByCode, checkCode, normaliseCode, payerMatches, stageOfOutcome } from './payment-claim';

describe('the code a shopper types', () => {
  it('is written the way the provider writes it', () => {
    expect(normaliseCode(' qgh7 rt61-sv ')).toBe('QGH7RT61SV');
    expect(normaliseCode(null)).toBe('');
    expect(normaliseCode(12345)).toBe('');
  });
  it('must be ten letters and numbers for M-Pesa, with a way to put it right in words', () => {
    expect(checkCode('mpesa_daraja', 'qgh7rt61sv')).toEqual({ ok: true, code: 'QGH7RT61SV' });
    for (const bad of ['', '   ', 'QGH7RT61S', 'QGH7RT61SVX', 'QGH7RT61S!']) {
      const r = checkCode('mpesa_daraja', bad);
      expect(r.ok).toBe(false);
    }
    expect(checkCode('mpesa_daraja', '')).toMatchObject({ error: 'Enter the transaction code from your payment message.' });
    const short = checkCode('mpesa_daraja', 'ABC');
    expect(short.ok).toBe(false);
    expect(short.ok ? '' : short.error).toContain('10 letters and numbers');
  });
  it('is looser for other providers, but never empty or absurd', () => {
    expect(checkCode('pesapal_v3', 'ab-12 cd34')).toEqual({ ok: true, code: 'AB12CD34' });
    expect(checkCode('jenga_hq', 'ab12').ok).toBe(false);
    expect(checkCode('kcb_buni', 'A'.repeat(41)).ok).toBe(false);
  });
  it('can be looked up by its code only where the provider has a way to', () => {
    expect(canLookUpByCode('mpesa_daraja')).toBe(true);
    expect(canLookUpByCode('pesapal_v3')).toBe(false);
    expect(canLookUpByCode('jenga_hq')).toBe(false);
    expect(canLookUpByCode('kcb_buni')).toBe(false);
  });
});

describe('whether an order can still be paid for', () => {
  const unpaid = { status: 'pending', paymentStatus: 'unpaid', paymentMethod: 'mpesa_daraja', amountDue: 500 };
  it('can, when it is waiting for a payment or the payment failed', () => {
    expect(canCompletePayment(unpaid)).toEqual({ ok: true });
    expect(canCompletePayment({ ...unpaid, paymentStatus: 'pending_verification' })).toEqual({ ok: true });
    expect(canCompletePayment({ ...unpaid, status: 'failed', paymentStatus: 'failed' })).toEqual({ ok: true });
  });
  it('cannot, once it is paid, cancelled, refunded, moved on, paid another way or has nothing due', () => {
    expect(canCompletePayment({ ...unpaid, status: 'processing', paymentStatus: 'paid' })).toMatchObject({ ok: false, reason: 'This order is already paid.' });
    expect(canCompletePayment({ ...unpaid, paymentStatus: 'reconciled' })).toMatchObject({ ok: false });
    const cancelled = canCompletePayment({ ...unpaid, status: 'cancelled' });
    expect(cancelled.ok).toBe(false);
    expect(cancelled.ok ? '' : cancelled.reason).toContain('cancelled');
    expect(canCompletePayment({ ...unpaid, status: 'refunded' })).toMatchObject({ ok: false });
    expect(canCompletePayment({ ...unpaid, status: 'shipped' })).toMatchObject({ ok: false });
    for (const method of ['on_account', 'pay_on_delivery', 'counter']) expect(canCompletePayment({ ...unpaid, paymentMethod: method })).toMatchObject({ ok: false });
    expect(canCompletePayment({ ...unpaid, amountDue: 0 })).toMatchObject({ ok: false });
    expect(canCompletePayment({ ...unpaid, paymentStatus: 'discrepancy' })).toMatchObject({ ok: false });
    expect(canCompletePayment({ ...unpaid, paymentStatus: 'partially_paid' })).toMatchObject({ ok: false });
  });
});

describe('whether the phone that paid is a phone the order knows', () => {
  const phones = ['0722123456', '+254 733 987 654'];
  it('matches a full or a hidden number in any common form', () => {
    expect(payerMatches('254722123456 - JANE DOE', phones)).toBe(true);
    expect(payerMatches('2547*****456 - JANE DOE', phones)).toBe(true);
    expect(payerMatches('2547******56', phones)).toBe(true);
    expect(payerMatches('0733987654', phones)).toBe(true);
    expect(payerMatches('2547*****654', phones)).toBe(true);
  });
  it('does not match another number', () => {
    expect(payerMatches('254711999888 - JOHN', phones)).toBe(false);
    expect(payerMatches('2547*****999', phones)).toBe(false);
  });
  it('says nothing when it cannot tell, so nothing is held back on a guess', () => {
    expect(payerMatches(null, phones)).toBeNull();
    expect(payerMatches('JANE DOE', phones)).toBeNull();
    expect(payerMatches('254722123456', [null, undefined, ''])).toBeNull();
    expect(payerMatches('254722123456', ['12'])).toBeNull();
  });
});

describe('what a shopper is told', () => {
  it('has words for every stage, none with a provider code or a stack in them', () => {
    for (const words of Object.values(CLAIM_WORDS)) expect(words).not.toMatch(/STATUS_|MISMATCH|ResultCode|Error|undefined/);
  });
  it('maps what the provider said to the right stage', () => {
    expect(stageOfOutcome('PAYER_DIFFERS')).toBe('held');
    expect(stageOfOutcome('STATUS_AMOUNT_MISMATCH')).toBe('amount_differs');
    expect(stageOfOutcome('REFERENCE_ALREADY_USED')).toBe('used');
    expect(stageOfOutcome('BEFORE_ORDER')).toBe('too_early');
    expect(stageOfOutcome('STATUS_NOT_COMPLETED')).toBe('not_found');
    expect(stageOfOutcome('SOMETHING_NEW')).toBe('not_found');
    expect(stageOfOutcome(null)).toBe('not_found');
  });
});
