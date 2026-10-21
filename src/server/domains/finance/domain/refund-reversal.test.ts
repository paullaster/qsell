import { describe, expect, it } from 'vitest';
import { decideReversal, type ReversalFacts } from './refund-reversal';

const facts = (over: Partial<ReversalFacts> = {}): ReversalFacts => ({
  status: 'approved',
  detailsChanged: false,
  amountCents: 150_000,
  method: { kind: 'mobile_money', providerId: 'p1', refundable: true },
  original: { transactionId: 'NLJ7RT61SV', amountCents: 150_000, providerId: 'p1', methodId: 'm1' },
  alreadyReversed: false,
  ...over,
});

describe("paying a refund by reversing the customer's payment", () => {
  it('can be done for an approved refund of exactly the payment, through the same M-Pesa connection', () => {
    expect(decideReversal(facts())).toEqual({
      ok: true,
      original: {
        transactionId: 'NLJ7RT61SV',
        amountCents: 150_000,
        providerId: 'p1',
        methodId: 'm1',
      },
    });
  });

  it.each([
    ['not approved yet', { status: 'draft' }, 'Only an approved refund'],
    ['no payment to reverse', { original: null }, 'nothing to reverse'],
    ['already reversed', { alreadyReversed: true }, 'already been reversed'],
    [
      'paid by hand',
      { method: { kind: 'cash', providerId: null, refundable: true } },
      'not set to be paid through M-Pesa',
    ],
    [
      'a method that cannot pay refunds',
      { method: { kind: 'mobile_money', providerId: 'p1', refundable: false } },
      'not set to be paid through M-Pesa',
    ],
    [
      'another connection',
      { method: { kind: 'mobile_money', providerId: 'p2', refundable: true } },
      'different M-Pesa connection',
    ],
    ['to another phone', { detailsChanged: true }, 'somewhere other than'],
    ['part of the payment', { amountCents: 100_000 }, 'whole payment'],
  ] as const)('is refused when it is %s, in words', (_name, over, words) => {
    const out = decideReversal(facts(over as Partial<ReversalFacts>));
    expect(out).toMatchObject({ ok: false });
    expect(out.ok ? '' : out.reason).toContain(words);
  });

  it('is for whole shillings', () => {
    const odd = {
      transactionId: 'NLJ7RT61SV',
      amountCents: 150_050,
      providerId: 'p1',
      methodId: 'm1',
    };
    expect(decideReversal(facts({ amountCents: 150_050, original: odd }))).toMatchObject({
      ok: false,
      reason: 'M-Pesa moves whole shillings only.',
    });
  });
});
