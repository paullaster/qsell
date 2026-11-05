import { describe, expect, it } from 'vitest';
import { approverProblem, collectedProblem, custodyBalance, custodySign, custodyWrites, doorAmount, fromCents, handInCheck, handInLines, handInProblem, markProblem, promptProblem, promptState, toCents, MAX_DOOR_PROMPTS, type HandInFacts, type MarkFacts, type PromptFacts } from './door-payment';

const ok: MarkFacts = { method: 'own_fleet', status: 'ready', orderPaymentStatus: 'unpaid', orderPaymentMethod: 'mpesa_daraja', orderStatus: 'processing', orderCurrency: 'KES', baseCurrency: 'KES', tendered: 0, unplanned: 0, carriedElsewhere: 0, methodChosen: true, alreadyMarked: false };

describe('marking a delivery to be paid at the door', () => {
  it('can be done for an unpaid order carried whole by the shop\'s own rider before it goes out', () => {
    expect(markProblem(ok)).toBeNull();
    for (const status of ['draft', 'released', 'picking', 'packed', 'ready']) expect(markProblem({ ...ok, status })).toBeNull();
  });

  it('says why not, one reason at a time', () => {
    expect(markProblem({ ...ok, methodChosen: false })).toMatch(/Door payments/);
    expect(markProblem({ ...ok, alreadyMarked: true })).toMatch(/already marked/);
    expect(markProblem({ ...ok, method: 'courier' })).toMatch(/own riders/);
    for (const status of ['out_for_delivery', 'delivered', 'failed_attempt', 'returned', 'cancelled']) expect(markProblem({ ...ok, status })).toMatch(/before it goes out/);
    expect(markProblem({ ...ok, orderStatus: 'cancelled' })).toMatch(/cancelled/);
    expect(markProblem({ ...ok, orderPaymentMethod: 'on_account' })).toMatch(/on account/);
    expect(markProblem({ ...ok, orderPaymentStatus: 'paid' })).toMatch(/already has a payment/);
    expect(markProblem({ ...ok, orderPaymentStatus: 'partially_paid' })).toMatch(/already has a payment/);
    expect(markProblem({ ...ok, tendered: 100 })).toMatch(/gift card/);
    expect(markProblem({ ...ok, orderCurrency: 'USD' })).toMatch(/KES only/);
    expect(markProblem({ ...ok, carriedElsewhere: 1 })).toMatch(/whole order/);
    expect(markProblem({ ...ok, unplanned: 2 })).toMatch(/whole order/);
  });
});

describe('the amount at the door', () => {
  it('is the order total as exact money', () => {
    expect(doorAmount('1234.5')).toBe('1234.50');
    expect(doorAmount(99.999)).toBe('100.00');
    expect(toCents('10.10')).toBe(1010);
    expect(fromCents(1010)).toBe('10.10');
  });

  it('must be collected exactly', () => {
    expect(collectedProblem('1234.50', 1234.5)).toEqual({ ok: true });
    expect(collectedProblem('0.30', 0.1 + 0.2)).toEqual({ ok: true });
    for (const said of [1234, 1234.51, 0, -5, Number.NaN, '1234.50', null, undefined]) expect(collectedProblem('1234.50', said)).toMatchObject({ ok: false });
    expect(collectedProblem('1234.50', 1000)).toMatchObject({ ok: false, error: expect.stringContaining('1234.50') as string });
  });
});

describe('what a rider holds', () => {
  it('is collected less handed in, with adjustments', () => {
    expect(custodyBalance([])).toBe(0);
    expect(custodyBalance([{ kind: 'collected', cents: 123450 }, { kind: 'collected', cents: 50000 }, { kind: 'handed_in', cents: -100000 }, { kind: 'adjusted', cents: -50 }])).toBe(73400);
    expect(custodySign('collected')).toBe(1);
    expect(custodySign('handed_in')).toBe(-1);
  });
});

const facts: HandInFacts = { expectedCents: 100000, counted: 1000, note: null, hasVarianceAccount: true, recorderId: 'cashier', witnessId: 'witness', riderUserId: 'rider', sameAccount: false };

describe('handing the cash in', () => {
  it('is exact, within the limit, or needs a second person', () => {
    expect(handInCheck(100000, 100000, 0)).toMatchObject({ diffCents: 0, kind: 'exact' });
    expect(handInCheck(100000, 99500, 1000)).toMatchObject({ diffCents: -500, kind: 'within_limit' });
    expect(handInCheck(100000, 100500, 1000)).toMatchObject({ diffCents: 500, kind: 'within_limit' });
    expect(handInCheck(100000, 98000, 1000)).toMatchObject({ diffCents: -2000, kind: 'needs_approval' });
    expect(handInCheck(100000, 99999, 0)).toMatchObject({ kind: 'needs_approval' });
  });

  it('is refused for what cannot be right, one reason at a time', () => {
    expect(handInProblem({ ...facts, expectedCents: 0 }, 0)).toMatchObject({ error: expect.stringMatching(/holds no cash/) as string });
    for (const counted of ['10', -1, Number.NaN, null]) expect(handInProblem({ ...facts, counted }, 0)).toMatchObject({ error: expect.stringMatching(/how much cash/) as string });
    expect(handInProblem({ ...facts, sameAccount: true }, 0)).toMatchObject({ error: expect.stringMatching(/not the account riders/) as string });
    expect(handInProblem({ ...facts, witnessId: null }, 0)).toMatchObject({ error: expect.stringMatching(/witness/) as string });
    expect(handInProblem({ ...facts, witnessId: 'cashier' }, 0)).toMatchObject({ error: expect.stringMatching(/person recording/) as string });
    expect(handInProblem({ ...facts, witnessId: 'rider' }, 0)).toMatchObject({ error: expect.stringMatching(/rider handing in/) as string });
  });

  it('needs words and an account for a difference, but not for an exact count', () => {
    expect(handInProblem({ ...facts, counted: 1000 }, 0)).toMatchObject({ countedCents: 100000, check: { kind: 'exact' } });
    expect(handInProblem({ ...facts, counted: 990 }, 0)).toMatchObject({ error: expect.stringMatching(/short by KSh 10.00/) as string });
    expect(handInProblem({ ...facts, counted: 1010 }, 0)).toMatchObject({ error: expect.stringMatching(/over by KSh 10.00/) as string });
    expect(handInProblem({ ...facts, counted: 990, note: 'Dropped a note' }, 0)).toMatchObject({ countedCents: 99000, check: { diffCents: -1000 } });
    expect(handInProblem({ ...facts, counted: 990, note: 'Dropped a note', hasVarianceAccount: false }, 0)).toMatchObject({ error: expect.stringMatching(/Differences/) as string });
  });

  it('is approved by someone other than whoever recorded it', () => {
    expect(approverProblem('boss', 'cashier')).toBeNull();
    expect(approverProblem('cashier', 'cashier')).toMatch(/someone other/);
  });

  it('brings what the rider holds to nothing, however it comes out', () => {
    for (const counted of [100000, 98000, 101500, 0]) {
      const check = handInCheck(100000, counted, 0);
      const held = 100000 + custodyWrites(check, 'why').reduce((n, w) => n + w.cents, 0);
      expect(held).toBe(0);
    }
    expect(custodyWrites(handInCheck(100000, 100000, 0), null)).toEqual([{ kind: 'handed_in', cents: -100000, note: null }]);
    expect(custodyWrites(handInCheck(100000, 98000, 0), 'Lost a note')[1]).toEqual({ kind: 'adjusted', cents: -2000, note: 'Lost a note' });
  });

  it('books balanced lines: debits equal credits, for exact, short and over', () => {
    for (const counted of [100000, 98000, 101500, 0]) {
      const lines = handInLines(handInCheck(100000, counted, 0));
      const debit = lines.filter((l) => l.side === 'debit').reduce((n, l) => n + l.cents, 0);
      const credit = lines.filter((l) => l.side === 'credit').reduce((n, l) => n + l.cents, 0);
      expect(debit).toBe(credit);
    }
    expect(handInLines(handInCheck(100000, 98000, 0)).find((l) => l.account === 'variance')).toEqual({ side: 'debit', account: 'variance', cents: 2000 });
    expect(handInLines(handInCheck(100000, 101500, 0)).find((l) => l.account === 'variance')).toEqual({ side: 'credit', account: 'variance', cents: 1500 });
    expect(handInLines(handInCheck(100000, 100000, 0)).some((l) => l.account === 'variance')).toBe(false);
  });
});

const prompt: PromptFacts = { runOnTheRoad: true, deliveryStatus: 'out_for_delivery', doorAmount: '1234.50', amountDue: 1234.5, orderPaymentStatus: 'unpaid', phone: '254712345678', promptsSent: 0, lastAttempt: null };

describe('an M-Pesa prompt at the door', () => {
  it('can be sent for a stop that is out, to be paid at the door, unpaid, for exactly what was marked', () => {
    expect(promptProblem(prompt)).toBeNull();
    expect(promptProblem({ ...prompt, lastAttempt: { status: 'failed', ageSeconds: 5 } })).toBeNull();
    expect(promptProblem({ ...prompt, lastAttempt: { status: 'pending', ageSeconds: 200 } })).toBeNull();
  });

  it('says why not', () => {
    expect(promptProblem({ ...prompt, runOnTheRoad: false })).toMatch(/not on the road/);
    expect(promptProblem({ ...prompt, deliveryStatus: 'delivered' })).toMatch(/not out for delivery/);
    expect(promptProblem({ ...prompt, doorAmount: null })).toMatch(/not to be paid at the door/);
    expect(promptProblem({ ...prompt, orderPaymentStatus: 'paid' })).toMatch(/already been paid/);
    expect(promptProblem({ ...prompt, amountDue: 1000 })).toMatch(/amount due has changed/);
    expect(promptProblem({ ...prompt, phone: null })).toMatch(/number the customer will pay from/);
    expect(promptProblem({ ...prompt, promptsSent: MAX_DOOR_PROMPTS })).toMatch(/Take the cash instead/);
    expect(promptProblem({ ...prompt, lastAttempt: { status: 'pending', ageSeconds: 10 } })).toMatch(/just sent/);
  });

  it('is waiting, paid or failed from the order and the last prompt', () => {
    expect(promptState(false, null)).toBe('none');
    expect(promptState(false, { status: 'pending' })).toBe('waiting');
    expect(promptState(false, { status: 'initiated' })).toBe('waiting');
    expect(promptState(false, { status: 'failed' })).toBe('failed');
    expect(promptState(false, { status: 'expired' })).toBe('failed');
    expect(promptState(true, { status: 'successful' })).toBe('paid');
    expect(promptState(true, null)).toBe('paid');
    // Money confirmed by the provider but the order not yet marked paid: still waiting, never "failed".
    expect(promptState(false, { status: 'successful' })).toBe('waiting');
  });
});
