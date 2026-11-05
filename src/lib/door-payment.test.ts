import { describe, expect, it } from 'vitest';
import { collectedProblem, custodyBalance, custodySign, doorAmount, fromCents, markProblem, toCents, type MarkFacts } from './door-payment';

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
