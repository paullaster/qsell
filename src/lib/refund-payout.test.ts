import { describe, expect, it } from 'vitest';
import { attemptTone, closedNext, doubtfulAdvice, payoutState, reasonLongEnough, type PayoutAttempt } from './refund-payout';

const at = (status: string, when: string, reference: string | null = null): PayoutAttempt => ({ id: `${status}-${when}`, status, reference, failure: null, at: when });

describe('the state of a refund payout', () => {
  it('has nothing to say when there were no attempts, or the only one was paid', () => {
    expect(payoutState([])).toEqual({ kind: 'none' });
    expect(payoutState([at('succeeded', '2026-01-02')])).toEqual({ kind: 'none' });
  });

  it('follows the newest attempt', () => {
    expect(payoutState([at('failed', '2026-01-01'), at('accepted', '2026-01-02')]).kind).toBe('in_flight');
    expect(payoutState([at('accepted', '2026-01-01'), at('failed', '2026-01-02')]).kind).toBe('failed');
  });

  it('holds a doubtful payout for a person, and offers a second look only when Safaricom gave a receipt', () => {
    expect(payoutState([at('in_doubt', '2026-01-02', 'RK12345678')])).toMatchObject({ kind: 'doubtful', canRecheck: true });
    expect(payoutState([at('timed_out', '2026-01-02')])).toMatchObject({ kind: 'doubtful', canRecheck: false });
    expect(payoutState([at('in_doubt', '2026-01-02', '')])).toMatchObject({ canRecheck: false });
  });

  it('does not change the list it is given', () => {
    const list = [at('failed', '2026-01-02'), at('accepted', '2026-01-01')];
    payoutState(list);
    expect(list.map((a) => a.at)).toEqual(['2026-01-02', '2026-01-01']);
  });
});

describe('the words for a doubtful payout', () => {
  it('says what to do next, which depends on whether the money left', () => {
    expect(doubtfulAdvice(true)).toContain('Check it again');
    expect(doubtfulAdvice(false)).toContain('do not send it again');
    expect(closedNext(true)).toContain('by hand');
    expect(closedNext(false)).toContain('sent again');
  });

  it('wants a sentence of explanation', () => {
    expect(reasonLongEnough('short')).toBe(false);
    expect(reasonLongEnough('  statement shows no debit  ')).toBe(true);
  });
});

describe('the colour of an attempt', () => {
  it('is green when paid, amber when held, red when failed, and blue while on its way', () => {
    expect(attemptTone('succeeded')).toBe('green');
    expect(attemptTone('in_doubt')).toBe('amber');
    expect(attemptTone('timed_out')).toBe('amber');
    expect(attemptTone('failed')).toBe('red');
    expect(attemptTone('accepted')).toBe('sky');
  });
});
