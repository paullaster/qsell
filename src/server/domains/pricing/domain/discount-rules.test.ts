import { describe, expect, it } from 'vitest';
import { checkDiscountRule, summariseDiscount, type DiscountRuleInput } from './discount-rules';

const base = (over: Partial<DiscountRuleInput> = {}): DiscountRuleInput => ({
  code: 'SPRING10',
  name: 'Spring 10%',
  kind: 'line',
  priority: 0,
  stacking: 'exclusive',
  validFrom: new Date('2026-10-01T00:00:00Z'),
  validTo: new Date('2026-12-01T00:00:00Z'),
  schedule: {},
  scopes: {},
  target: {},
  conditions: {},
  reward: { type: 'percent', value: 10 },
  requiresCoupon: false,
  limits: {},
  ...over,
});

const errorPaths = (r: DiscountRuleInput) => checkDiscountRule(r).errors.map((e) => e.path);
const warnPaths = (r: DiscountRuleInput) => checkDiscountRule(r).warnings.map((e) => e.path);

describe('checking a discount rule', () => {
  it('accepts a plain percentage rule', () => {
    expect(checkDiscountRule(base())).toEqual({ errors: [], warnings: [] });
  });

  it('rejects rewards that do not fit the kind', () => {
    expect(errorPaths(base({ reward: { type: 'amount', value: 5 } }))).toContain('reward.type');
    expect(errorPaths(base({ kind: 'order', reward: { type: 'set_price', value: 5 } }))).toContain(
      'reward.type',
    );
  });

  it('rejects impossible values', () => {
    expect(errorPaths(base({ reward: { type: 'percent', value: 0 } }))).toContain('reward.value');
    expect(errorPaths(base({ reward: { type: 'percent', value: 101 } }))).toContain('reward.value');
    expect(errorPaths(base({ reward: { type: 'amount_per_unit', value: -1 } }))).toContain(
      'reward.value',
    );
    expect(errorPaths(base({ reward: { type: 'set_price', value: 0 } }))).not.toContain(
      'reward.value',
    );
  });

  it('checks tiers', () => {
    const paths = errorPaths(
      base({
        reward: {
          type: 'percent',
          value: 5,
          tiers: [
            { from: 10, value: 8 },
            { from: 10, value: 9 },
            { from: 0, value: 120 },
          ],
        },
      }),
    );
    expect(paths).toEqual(expect.arrayContaining(['reward.tiers', 'reward.tiers.2']));
  });

  it('a set price cannot be stacked', () => {
    expect(
      errorPaths(base({ stacking: 'stackable', reward: { type: 'set_price', value: 50 } })),
    ).toContain('stacking');
  });

  it('conditions belong to one kind each', () => {
    expect(errorPaths(base({ conditions: { minOrderValue: 100 } }))).toContain(
      'conditions.minOrderValue',
    );
    expect(
      errorPaths(
        base({
          kind: 'order',
          reward: { type: 'percent', value: 5 },
          conditions: { minQuantity: 2 },
        }),
      ),
    ).toContain('conditions.minQuantity');
  });

  it('checks the dates, days and times', () => {
    expect(errorPaths(base({ validTo: new Date('2026-09-01T00:00:00Z') }))).toContain('validTo');
    expect(errorPaths(base({ schedule: { days: [7] } }))).toContain('schedule.days');
    expect(errorPaths(base({ schedule: { days: [1, 1] } }))).toContain('schedule.days');
    expect(errorPaths(base({ schedule: { from: '16:00' } }))).toContain('schedule');
    expect(errorPaths(base({ schedule: { from: '25:00', to: '26:00' } }))).toContain('schedule');
    expect(errorPaths(base({ schedule: { from: '16:00', to: '18:00', days: [6, 0] } }))).toEqual(
      [],
    );
  });

  it('checks the limits and the product list', () => {
    expect(errorPaths(base({ limits: { maxUses: 0 } }))).toContain('limits.maxUses');
    expect(errorPaths(base({ limits: { budget: -5 } }))).toContain('limits.budget');
    expect(errorPaths(base({ limits: { maxDiscountPercent: 150 } }))).toContain(
      'limits.maxDiscountPercent',
    );
    expect(
      errorPaths(base({ target: { productIds: Array.from({ length: 201 }, (_, i) => `p${i}`) } })),
    ).toContain('target.productIds');
  });

  it('warns, without refusing, about open-ended or unbounded rules', () => {
    expect(warnPaths(base({ validTo: null }))).toContain('validTo');
    expect(warnPaths(base({ reward: { type: 'percent', value: 60 } }))).toContain('reward.value');
    expect(warnPaths(base({ kind: 'order', reward: { type: 'percent', value: 5 } }))).toContain(
      'conditions',
    );
    expect(warnPaths(base({ reward: { type: 'amount_per_unit', value: 5 } }))).toContain('limits');
    expect(checkDiscountRule(base({ validTo: null })).errors).toEqual([]);
  });
});

describe('summarising a rule', () => {
  it('says what it does in one sentence', () => {
    const text = summariseDiscount(
      base({
        target: { brands: ['Acme'] },
        scopes: { customer_group: { op: 'in', values: ['g1'] } },
        schedule: { days: [6, 0] },
        conditions: { minQuantity: 3 },
        limits: { maxUses: 500 },
      }),
      { customer_group: { g1: 'Wholesale A' } },
    );
    expect(text).toContain('10% off on brands Acme');
    expect(text).toContain('when buying 3 or more');
    expect(text).toContain('for customer group Wholesale A');
    expect(text).toContain('on Sunday, Saturday');
    expect(text).toContain('at most 500 uses');
    expect(text.endsWith('Applies alone.')).toBe(true);
  });

  it('describes an order rule with a coupon', () => {
    const text = summariseDiscount(
      base({
        kind: 'order',
        reward: { type: 'amount', value: 2000 },
        conditions: { minOrderValue: 50000 },
        requiresCoupon: true,
        stacking: 'stackable',
        validTo: null,
      }),
    );
    expect(text).toContain('2,000 off on the whole order');
    expect(text).toContain('with a coupon code');
    expect(text).toContain('no end date');
    expect(text).toContain('Can combine');
  });
});
