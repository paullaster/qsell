import { describe, expect, it } from 'vitest';
import { byKind, costPostingLines, courierChargeProblem, dayPayKey, deliveryPayKey, isCostKind, isPayoutMethodKind, isRiderPay, money, marginCents, payoutPostingLines, payoutProblem, readPayRules, readPeriod, retryAfterSeconds, runningCostProblem, sharePercent, reversalKey, totalCents } from './delivery-cost';

describe('rider pay rules', () => {
  it('are two amounts, each nothing or more, kept to the cent', () => {
    expect(readPayRules(50, 200)).toEqual({ ok: true, rules: { perDelivery: 50, perDay: 200 } });
    expect(readPayRules(0, 0)).toMatchObject({ ok: true });
    expect(readPayRules(12.345, 0.1 + 0.2)).toEqual({ ok: true, rules: { perDelivery: 12.35, perDay: 0.3 } });
    for (const bad of [-1, Number.NaN, '50', null, 2_000_000]) {
      expect(readPayRules(bad, 0)).toMatchObject({ ok: false, error: expect.stringContaining('each delivery') as string });
      expect(readPayRules(0, bad)).toMatchObject({ ok: false, error: expect.stringContaining('each day') as string });
    }
  });
});

describe('costs', () => {
  it('know their kinds, make a key that is the same every time, and take back what was counted', () => {
    expect(isCostKind('courier')).toBe(true);
    expect(isCostKind('petrol')).toBe(false);
    expect(deliveryPayKey('d1')).toBe(deliveryPayKey('d1'));
    expect(dayPayKey('r1', '2026-11-05')).not.toBe(dayPayKey('r1', '2026-11-06'));
    expect(reversalKey('c1')).toBe('reverse:c1');
  });

  it('add up with reversals as the opposite sign', () => {
    const lines = [{ kind: 'rider_delivery' as const, cents: 5000 }, { kind: 'rider_delivery' as const, cents: 5000 }, { kind: 'rider_delivery' as const, cents: -5000 }, { kind: 'courier' as const, cents: 30000 }];
    expect(totalCents(lines)).toBe(35000);
    expect(byKind(lines)).toEqual({ rider_delivery: 5000, rider_day: 0, courier: 30000, fuel: 0, vehicle: 0, other: 0 });
    expect(money(35000)).toBe('350.00');
  });

  it('a courier charge is more than nothing', () => {
    expect(courierChargeProblem(300.5)).toEqual({ cents: 30050 });
    for (const bad of [0, -5, Number.NaN, '300', undefined]) expect(courierChargeProblem(bad)).toMatchObject({ error: expect.any(String) as string });
  });
});

describe('the books for rider pay', () => {
  it('only rider pay is posted and paid out here', () => {
    expect(isRiderPay('rider_delivery')).toBe(true);
    expect(isRiderPay('rider_day')).toBe(true);
    expect(isRiderPay('courier')).toBe(false);
    expect(isRiderPay('other')).toBe(false);
  });

  it('earned pay is a cost owed to the rider, and taking it back goes the other way; always balanced', () => {
    expect(costPostingLines(5000)).toEqual([{ side: 'debit', account: 'expense', cents: 5000 }, { side: 'credit', account: 'payable', cents: 5000 }]);
    expect(costPostingLines(-5000)).toEqual([{ side: 'debit', account: 'payable', cents: 5000 }, { side: 'credit', account: 'expense', cents: 5000 }]);
    for (const c of [1, 5000, -1, -7777]) {
      const lines = costPostingLines(c);
      expect(lines.filter((l) => l.side === 'debit').reduce((n, l) => n + l.cents, 0)).toBe(lines.filter((l) => l.side === 'credit').reduce((n, l) => n + l.cents, 0));
    }
    expect(payoutPostingLines(12000)).toEqual([{ side: 'debit', account: 'payable', cents: 12000 }, { side: 'credit', account: 'bank', cents: 12000 }]);
  });

  it('a payout needs something owed', () => {
    expect(payoutProblem(0, 0)).toMatch(/Nothing is owed/);
    expect(payoutProblem(0, 2)).toMatch(/come to nothing/);
    expect(payoutProblem(-500, 1)).toMatch(/set against their next pay/);
    expect(payoutProblem(500, 1)).toBeNull();
  });

  it('knows the ways to pay and waits longer after each failed posting', () => {
    expect(['cash', 'mobile_money', 'bank_transfer', 'bank_deposit', 'cheque', 'card'].map(isPayoutMethodKind)).toEqual([true, true, true, true, false, false]);
    expect([0, 1, 2, 3, 20].map(retryAfterSeconds)).toEqual([60, 60, 120, 240, 3600]);
  });
});

describe('report arithmetic and days', () => {
  it('margin is what was earned less what it cost, and a share needs a whole', () => {
    expect(marginCents(60000, 25000)).toBe(35000);
    expect(marginCents(10000, 25000)).toBe(-15000);
    expect(sharePercent(1, 3)).toBe(33);
    expect(sharePercent(5, 0)).toBeNull();
  });

  it('a report covers the days typed, or the last 30 days, and not more than a year', () => {
    expect(readPeriod('2026-11-01', '2026-11-05', '2026-11-06')).toEqual({ ok: true, period: { from: '2026-11-01', to: '2026-11-05' } });
    expect(readPeriod(undefined, undefined, '2026-11-06')).toEqual({ ok: true, period: { from: '2026-10-08', to: '2026-11-06' } });
    expect(readPeriod('2026-11-05', '2026-11-01', '2026-11-06')).toMatchObject({ ok: false });
    expect(readPeriod('2024-01-01', '2026-11-01', '2026-11-06')).toMatchObject({ ok: false, error: expect.stringMatching(/a year/) as string });
    expect(readPeriod('junk', 'junk', '2026-11-06')).toEqual({ ok: true, period: { from: '2026-10-08', to: '2026-11-06' } });
  });
});

describe('fuel and vehicle costs', () => {
  it('reads a running cost, to the cent, with the words of what it was for', () => {
    expect(runningCostProblem('fuel', 4500.555, '  KDA 123X, Thika road ')).toEqual({ kind: 'fuel', cents: 450056, note: 'KDA 123X, Thika road' });
    expect(runningCostProblem('vehicle', 800, 'Puncture repair')).toMatchObject({ kind: 'vehicle', cents: 80000 });
    expect(runningCostProblem('other', 10, 'Parking')).toMatchObject({ kind: 'other' });
  });

  it('refuses a kind that is not typed in, no or silly money, and no words', () => {
    expect(runningCostProblem('rider_day', 100, 'Pay')).toHaveProperty('error');
    expect(runningCostProblem('courier', 100, 'Waybill')).toHaveProperty('error');
    for (const bad of [0, -5, Number.NaN, 20_000_000, '300', null]) expect(runningCostProblem('fuel', bad, 'Diesel')).toHaveProperty('error');
    expect(runningCostProblem('fuel', 100, '  ')).toHaveProperty('error');
    expect(runningCostProblem('fuel', 100, 'ab')).toHaveProperty('error');
  });

  it('keeps the note to 300 characters, adds fuel and vehicle by kind, and does not pay riders', () => {
    const long = runningCostProblem('fuel', 1, 'x'.repeat(500));
    expect('note' in long && long.note.length).toBe(300);
    expect(byKind([{ kind: 'fuel', cents: 100 }, { kind: 'vehicle', cents: 250 }, { kind: 'fuel', cents: -100 }])).toMatchObject({ fuel: 0, vehicle: 250, other: 0 });
    expect(isRiderPay('fuel')).toBe(false);
    expect(isCostKind('vehicle')).toBe(true);
  });
});
