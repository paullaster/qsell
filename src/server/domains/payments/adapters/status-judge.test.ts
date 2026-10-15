import { describe, expect, it } from 'vitest';
import type { VerifyAttemptInput } from '../engine/types';
import { judgeAnswer, stateOf, unusableAnswer, type PlatformAnswer } from './status-judge';

const input: VerifyAttemptInput = {
  attemptId: 'a', orderNumber: 'ORD-1', amountCents: 10000, currency: 'KES', customerPhone: null,
  providerReference: null, externalReference: null, createdAt: new Date(), claim: null, mode: 'standard', evidence: [],
};
const paid = (over: Partial<PlatformAnswer> = {}): PlatformAnswer => ({ state: 'paid', reference: 'R1', amount: '100.00', currency: 'KES', orderReference: 'ORD1', reason: 'Paid.', evidence: {}, ...over });

describe('judging a platform\'s answer', () => {
  it('confirms only when amount, currency and our reference all agree', () => {
    expect(judgeAnswer('x', paid(), input, ['ORD1'])).toMatchObject({ status: 'confirmed', platformReference: 'R1', amountCents: 10000 });
    expect(judgeAnswer('x', paid({ currency: null, orderReference: null }), input, ['ORD1'])).toMatchObject({ status: 'confirmed' });
  });
  it('refuses a different amount, a missing amount, another currency or another payment', () => {
    expect(judgeAnswer('x', paid({ amount: 99 }), input, ['ORD1'])).toMatchObject({ status: 'mismatch', code: 'AMOUNT_MISMATCH' });
    expect(judgeAnswer('x', paid({ amount: undefined }), input, ['ORD1'])).toMatchObject({ status: 'mismatch', code: 'AMOUNT_MISMATCH' });
    expect(judgeAnswer('x', paid({ currency: 'usd' }), input, ['ORD1'])).toMatchObject({ status: 'mismatch', code: 'CURRENCY_MISMATCH' });
    expect(judgeAnswer('x', paid({ orderReference: 'OTHER' }), input, ['ORD1'])).toMatchObject({ status: 'mismatch', code: 'REFERENCE_MISMATCH' });
  });
  it('passes a decline or a wait through', () => {
    expect(judgeAnswer('x', paid({ state: 'failed', reason: 'No funds' }), input, [])).toMatchObject({ status: 'failed', reason: 'No funds' });
    expect(judgeAnswer('x', paid({ state: 'pending' }), input, [])).toMatchObject({ status: 'pending' });
  });
  it('turns calls without a usable answer into outcomes, retrying only what may change', () => {
    const res = (over: Partial<Parameters<typeof unusableAnswer>[2]>) => ({ reached: true, status: 200, networkError: null, text: '', ...over });
    expect(unusableAnswer('x', 'P', res({}))).toBeNull();
    expect(unusableAnswer('x', 'P', res({ reached: false, networkError: 'timeout' }))).toMatchObject({ status: 'error', retryable: true, reason: 'timeout' });
    expect(unusableAnswer('x', 'P', res({ status: 503 }))).toMatchObject({ retryable: true });
    expect(unusableAnswer('x', 'P', res({ status: 429 }))).toMatchObject({ retryable: true });
    expect(unusableAnswer('x', 'P', res({ status: 404, text: 'gone' }))).toMatchObject({ retryable: false });
    expect(unusableAnswer('x', 'P', res({ status: 401 }))).toMatchObject({ retryable: true });
  });
  it('names the state from the two flags', () => {
    expect([stateOf(true, false), stateOf(false, true), stateOf(false, false)]).toEqual(['paid', 'failed', 'pending']);
  });
});
