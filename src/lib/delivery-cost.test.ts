import { describe, expect, it } from 'vitest';
import { byKind, courierChargeProblem, dayPayKey, deliveryPayKey, isCostKind, money, readPayRules, reversalKey, totalCents } from './delivery-cost';

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
    expect(isCostKind('fuel')).toBe(false);
    expect(deliveryPayKey('d1')).toBe(deliveryPayKey('d1'));
    expect(dayPayKey('r1', '2026-11-05')).not.toBe(dayPayKey('r1', '2026-11-06'));
    expect(reversalKey('c1')).toBe('reverse:c1');
  });

  it('add up with reversals as the opposite sign', () => {
    const lines = [{ kind: 'rider_delivery' as const, cents: 5000 }, { kind: 'rider_delivery' as const, cents: 5000 }, { kind: 'rider_delivery' as const, cents: -5000 }, { kind: 'courier' as const, cents: 30000 }];
    expect(totalCents(lines)).toBe(35000);
    expect(byKind(lines)).toEqual({ rider_delivery: 5000, rider_day: 0, courier: 30000, other: 0 });
    expect(money(35000)).toBe('350.00');
  });

  it('a courier charge is more than nothing', () => {
    expect(courierChargeProblem(300.5)).toEqual({ cents: 30050 });
    for (const bad of [0, -5, Number.NaN, '300', undefined]) expect(courierChargeProblem(bad)).toMatchObject({ error: expect.any(String) as string });
  });
});
