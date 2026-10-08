import { describe, expect, it } from 'vitest';
import {
  lineBenefit,
  localParts,
  orderBenefit,
  resolveLineDiscounts,
  resolveOrderDiscounts,
  rewardValue,
  targetMatches,
  windowProblem,
  type DiscountInputs,
  type DiscountLine,
  type DiscountRule,
} from './discounts';

const NOW = new Date('2026-10-07T09:00:00Z'); // 12:00 in Nairobi, a Wednesday

const rule = (over: Partial<DiscountRule> = {}): DiscountRule => ({
  id: over.id ?? over.code ?? 'r1',
  code: over.code ?? 'R1',
  name: 'Rule',
  kind: 'line',
  priority: 0,
  stacking: 'exclusive',
  validFrom: new Date('2026-01-01T00:00:00Z'),
  validTo: null,
  schedule: {},
  scopes: {},
  target: {},
  conditions: {},
  reward: { type: 'percent', value: 10 },
  requiresCoupon: false,
  limits: {},
  appliesToContract: false,
  version: 1,
  ...over,
});

const line = (over: Partial<DiscountLine> = {}): DiscountLine => ({
  index: 0,
  id: 'p1',
  brand: 'Acme',
  categoryChain: ['shoes'],
  groupIds: [],
  quantity: 1,
  unitPrice: 100,
  lineTotal: 100,
  minLineTotal: null,
  contractPriced: false,
  ...over,
});

const inputs = (rules: DiscountRule[], over: Partial<DiscountInputs> = {}): DiscountInputs => ({
  rules,
  unlockedByCoupon: new Map(),
  availability: new Map(),
  ctx: { at: NOW },
  ...over,
});

const one = (rules: DiscountRule[], l = line(), over: Partial<DiscountInputs> = {}) =>
  resolveLineDiscounts([l], inputs(rules, over))[0]!;

describe('rewards', () => {
  it('works out each kind of line reward', () => {
    const l = line({ quantity: 4, unitPrice: 50, lineTotal: 200 });
    expect(lineBenefit(rule({ reward: { type: 'percent', value: 10 } }), l)).toBe(20);
    expect(lineBenefit(rule({ reward: { type: 'amount_per_unit', value: 5 } }), l)).toBe(20);
    expect(lineBenefit(rule({ reward: { type: 'amount_per_line', value: 30 } }), l)).toBe(30);
    expect(lineBenefit(rule({ reward: { type: 'set_price', value: 40 } }), l)).toBe(40);
  });

  it('never gives more than the line, nor a negative amount', () => {
    const l = line({ lineTotal: 100 });
    expect(lineBenefit(rule({ reward: { type: 'amount_per_line', value: 500 } }), l)).toBe(100);
    expect(lineBenefit(rule({ reward: { type: 'set_price', value: 150 } }), l)).toBe(0);
  });

  it("a set price only reduces, and the rule's own cap holds", () => {
    const l = line({ lineTotal: 100 });
    expect(
      lineBenefit(
        rule({ reward: { type: 'percent', value: 50 }, limits: { maxDiscountPercent: 20 } }),
        l,
      ),
    ).toBe(20);
  });

  it('the highest tier reached replaces the base value', () => {
    const r = rule({
      reward: {
        type: 'percent',
        value: 5,
        tiers: [
          { from: 50, value: 8 },
          { from: 10, value: 6 },
        ],
      },
    });
    expect(rewardValue(r.reward, 1)).toBe(5);
    expect(rewardValue(r.reward, 10)).toBe(6);
    expect(rewardValue(r.reward, 49)).toBe(6);
    expect(rewardValue(r.reward, 50)).toBe(8);
  });
});

describe('when a rule is in force', () => {
  it('respects start and end', () => {
    expect(windowProblem(rule({ validFrom: new Date('2026-11-01T00:00:00Z') }), NOW)).toBe(
      'Has not started yet',
    );
    expect(windowProblem(rule({ validTo: new Date('2026-10-07T09:00:00Z') }), NOW)).toBe(
      'Has ended',
    );
    expect(windowProblem(rule(), NOW)).toBeNull();
  });

  it('reads days and times in the business time zone, not UTC', () => {
    expect(localParts(NOW)).toEqual({ day: 3, minutes: 720 });
    // 23:30 UTC on Wednesday is 02:30 on Thursday in Nairobi.
    expect(localParts(new Date('2026-10-07T23:30:00Z'))).toEqual({ day: 4, minutes: 150 });
    expect(windowProblem(rule({ schedule: { days: [3] } }), NOW)).toBeNull();
    expect(windowProblem(rule({ schedule: { days: [3] } }), new Date('2026-10-07T23:30:00Z'))).toBe(
      'Not on this day of the week',
    );
  });

  it('a daily window, including one that runs past midnight', () => {
    const lunch = rule({ schedule: { from: '11:00', to: '13:00' } });
    expect(windowProblem(lunch, NOW)).toBeNull();
    expect(windowProblem(lunch, new Date('2026-10-07T12:00:00Z'))).toBe(
      'Only between 11:00 and 13:00',
    );
    const night = rule({ schedule: { from: '22:00', to: '02:00' } });
    // 22:30 and 01:30 in Nairobi are inside; 02:30 is not.
    expect(windowProblem(night, new Date('2026-10-07T19:30:00Z'))).toBeNull();
    expect(windowProblem(night, new Date('2026-10-07T22:30:00Z'))).toBeNull();
    expect(windowProblem(night, new Date('2026-10-07T23:30:00Z'))).toBe(
      'Only between 22:00 and 02:00',
    );
  });
});

describe('what a rule applies to', () => {
  const p = { id: 'p1', brand: 'Acme', categoryChain: ['running', 'shoes'], groupIds: ['g1'] };
  it('everything when nothing is chosen', () => {
    expect(targetMatches({}, p)).toBe(true);
    expect(targetMatches({ all: true, brands: ['Other'] }, p)).toBe(true);
  });
  it('a product, group, brand (any case) or category (including the ones above)', () => {
    expect(targetMatches({ productIds: ['p1'] }, p)).toBe(true);
    expect(targetMatches({ productGroupIds: ['g1'] }, p)).toBe(true);
    expect(targetMatches({ brands: [' acme '] }, p)).toBe(true);
    expect(targetMatches({ categoryIds: ['shoes'] }, p)).toBe(true);
    expect(targetMatches({ categoryIds: ['bags'], brands: ['Other'] }, p)).toBe(false);
  });
});

describe('line rules', () => {
  it('the best exclusive rule applies alone', () => {
    const a = rule({ code: 'A', reward: { type: 'percent', value: 10 } });
    const b = rule({ code: 'B', reward: { type: 'percent', value: 15 } });
    const r = one([a, b]);
    expect(r.applied.map((x) => x.code)).toEqual(['B']);
    expect(r.total).toBe(15);
    expect(r.considered.find((c) => c.code === 'A')).toMatchObject({ outcome: 'lost' });
  });

  it('ties go to higher priority, then to the lower code', () => {
    const a = rule({ code: 'A', priority: 1 });
    const b = rule({ code: 'B', priority: 2 });
    expect(one([a, b]).applied[0]!.code).toBe('B');
    expect(one([rule({ code: 'Z' }), rule({ code: 'M' })]).applied[0]!.code).toBe('M');
  });

  it('stackable rules combine, each on what is left', () => {
    const a = rule({
      code: 'A',
      stacking: 'stackable',
      priority: 2,
      reward: { type: 'percent', value: 10 },
    });
    const b = rule({
      code: 'B',
      stacking: 'stackable',
      priority: 1,
      reward: { type: 'percent', value: 10 },
    });
    const r = one([a, b]);
    expect(r.applied.map((x) => [x.code, x.amount])).toEqual([
      ['A', 10],
      ['B', 9],
    ]);
    expect(r.total).toBe(19);
  });

  it('an exclusive rule and a stackable set are compared, never added together', () => {
    const ex = rule({ code: 'EX', reward: { type: 'percent', value: 15 } });
    const s1 = rule({ code: 'S1', stacking: 'stackable', reward: { type: 'percent', value: 10 } });
    const s2 = rule({ code: 'S2', stacking: 'stackable', reward: { type: 'percent', value: 10 } });
    // 15 beats 19? No: the stackable pair is worth 19, so it wins.
    expect(one([ex, s1, s2]).total).toBe(19);
    expect(
      one([ex, s1, s2])
        .applied.map((a) => a.code)
        .sort(),
    ).toEqual(['S1', 'S2']);
    // With a bigger exclusive rule, it wins alone.
    const big = rule({ code: 'BIG', reward: { type: 'percent', value: 25 } });
    const r = one([big, s1, s2]);
    expect(r.applied.map((a) => a.code)).toEqual(['BIG']);
    expect(r.considered.filter((c) => c.outcome === 'lost')).toHaveLength(2);
  });

  it('explains why a rule did not apply', () => {
    const rules = [
      rule({ code: 'QTY', conditions: { minQuantity: 5 } }),
      rule({ code: 'CPN', requiresCoupon: true }),
      rule({ code: 'OTHER', target: { brands: ['Nope'] } }),
      rule({ code: 'CUST', scopes: { customer: { op: 'in', values: ['c9'] } } }),
      rule({ code: 'PAY', conditions: { paymentMethods: ['mpesa'] } }),
    ];
    const r = one(rules);
    const why = Object.fromEntries(r.considered.map((c) => [c.code, c.why]));
    expect(why.QTY).toBe('Needs at least 5 units');
    expect(why.CPN).toBe('Needs a coupon code');
    expect(why.OTHER).toBe('Not for this product');
    expect(why.CUST).toContain('different customer');
    expect(why.PAY).toBe('Only for other payment methods');
    expect(r.applied).toHaveLength(0);
  });

  it('a coupon unlocks its rule, and the application carries the code', () => {
    const r = one([rule({ code: 'CPN', requiresCoupon: true })], line(), {
      unlockedByCoupon: new Map([['CPN', 'WELCOME10']]),
    });
    expect(r.applied[0]).toMatchObject({ code: 'CPN', couponCode: 'WELCOME10', amount: 10 });
  });

  it('promotions do not reduce a contract price unless the rule says so', () => {
    const contract = line({ contractPriced: true });
    expect(one([rule()], contract).applied).toHaveLength(0);
    expect(one([rule({ appliesToContract: true })], contract).applied).toHaveLength(1);
  });

  it('a quantity tier changes the reward', () => {
    const r = rule({
      reward: { type: 'percent', value: 5, tiers: [{ from: 10, value: 12 }] },
    });
    expect(one([r], line({ quantity: 9, lineTotal: 900, unitPrice: 100 })).total).toBe(45);
    expect(one([r], line({ quantity: 10, lineTotal: 1000, unitPrice: 100 })).total).toBe(120);
  });

  it('never takes a line below its floor, and says it cut the discount back', () => {
    const r = one([rule({ reward: { type: 'percent', value: 30 } })], line({ minLineTotal: 85 }));
    expect(r.total).toBe(15);
    expect(r.trimmed).toBe(15);
    expect(r.considered.find((c) => c.outcome === 'applied')!.why).toContain('floor');
    expect(one([rule()], line({ minLineTotal: 100 })).total).toBe(0);
  });

  it('a budget is shared by all the lines of the document, and runs out', () => {
    const r = rule({ limits: { budget: 15 } });
    const out = resolveLineDiscounts(
      [line({ index: 0 }), line({ index: 1 }), line({ index: 2 })],
      inputs([r], { availability: new Map([[r.id, { remainingBudget: 15 }]]) }),
    );
    expect(out.map((o) => o.total)).toEqual([10, 5, 0]);
    expect(out[2]!.considered[0]).toMatchObject({ outcome: 'blocked' });
  });

  it('a rule used up elsewhere is blocked, and says why', () => {
    const r = one([rule()], line(), {
      availability: new Map([
        ['r1', { blocked: 'Used up: all 100 uses are taken', remainingBudget: null }],
      ]),
    });
    expect(r.applied).toHaveLength(0);
    expect(r.considered[0]).toMatchObject({ outcome: 'blocked' });
  });

  it('ignores order rules', () => {
    expect(one([rule({ kind: 'order' })]).applied).toHaveLength(0);
  });
});

describe('order rules', () => {
  const orderRule = (over: Partial<DiscountRule> = {}) =>
    rule({
      kind: 'order',
      conditions: { minOrderValue: 1000 },
      reward: { type: 'percent', value: 5 },
      ...over,
    });
  const basket = (...totals: number[]) =>
    totals.map((t, i) => line({ index: i, id: `p${i}`, lineTotal: t, unitPrice: t }));

  it('needs the order value, and says how far off it is', () => {
    const r = resolveOrderDiscounts(basket(400, 500), inputs([orderRule()]));
    expect(r.total).toBe(0);
    expect(r.considered[0]!.why).toContain('Needs 1000');
    expect(resolveOrderDiscounts(basket(600, 600), inputs([orderRule()])).total).toBe(60);
  });

  it("spreads the discount over the lines in proportion, so each line's tax stays right", () => {
    const r = resolveOrderDiscounts(
      basket(600, 400),
      inputs([orderRule({ reward: { type: 'amount', value: 100 } })]),
    );
    expect(r.total).toBe(100);
    expect(r.linePercent.get(0)).toBeCloseTo(10, 4);
    expect(r.linePercent.get(1)).toBeCloseTo(10, 4);
  });

  it('only counts and discounts the lines it targets', () => {
    const lines = [
      line({ index: 0, id: 'a', brand: 'Acme', lineTotal: 800, unitPrice: 800 }),
      line({ index: 1, id: 'b', brand: 'Other', lineTotal: 800, unitPrice: 800 }),
    ];
    const r = resolveOrderDiscounts(
      lines,
      inputs([orderRule({ target: { brands: ['Acme'] }, conditions: { minOrderValue: 1000 } })]),
    );
    expect(r.total).toBe(0); // only 800 of Acme goods
    const r2 = resolveOrderDiscounts(
      lines,
      inputs([orderRule({ target: { brands: ['Acme'] }, conditions: { minOrderValue: 500 } })]),
    );
    expect(r2.total).toBe(40);
    expect(r2.linePercent.has(1)).toBe(false);
  });

  it('tiers on order value', () => {
    const r = orderRule({
      conditions: { minOrderValue: 1000 },
      reward: {
        type: 'percent',
        value: 5,
        tiers: [{ from: 5000, value: 8 }],
      },
    });
    expect(orderBenefit(r, 2000)).toBe(100);
    expect(orderBenefit(r, 6000)).toBe(480);
  });

  it('moves the discount onto lines that have room, and never takes any below its floor', () => {
    const lines = [
      line({ index: 0, id: 'a', lineTotal: 600, unitPrice: 600, minLineTotal: 600 }),
      line({ index: 1, id: 'b', lineTotal: 600, unitPrice: 600, minLineTotal: null }),
    ];
    const r = resolveOrderDiscounts(
      lines,
      inputs([orderRule({ reward: { type: 'percent', value: 10 } })]),
    );
    expect(r.linePercent.has(0)).toBe(false);
    expect(r.total).toBe(120);
    expect(r.linePercent.get(1)).toBeCloseTo(20, 4);
  });

  it('when every line is at its floor nothing comes off, and it says so', () => {
    const lines = [
      line({ index: 0, id: 'a', lineTotal: 600, unitPrice: 600, minLineTotal: 600 }),
      line({ index: 1, id: 'b', lineTotal: 600, unitPrice: 600, minLineTotal: 600 }),
    ];
    const r = resolveOrderDiscounts(lines, inputs([orderRule()]));
    expect(r.total).toBe(0);
    expect(r.trimmed).toBeGreaterThan(0);
    expect(r.considered.find((c) => c.code === 'R1')!.outcome).toBe('lost');
  });

  it('exclusive order rules compete, and a coupon rule needs its code', () => {
    const a = orderRule({ code: 'A', reward: { type: 'percent', value: 5 } });
    const b = orderRule({ code: 'B', requiresCoupon: true, reward: { type: 'percent', value: 9 } });
    const without = resolveOrderDiscounts(basket(2000), inputs([a, b]));
    expect(without.applied.map((x) => x.code)).toEqual(['A']);
    const withCode = resolveOrderDiscounts(
      basket(2000),
      inputs([a, b], { unlockedByCoupon: new Map([['B', 'BIG9']]) }),
    );
    expect(withCode.applied.map((x) => x.code)).toEqual(['B']);
    expect(withCode.applied[0]!.couponCode).toBe('BIG9');
  });
});

describe('properties', () => {
  // A small deterministic generator, so a failure can be reproduced.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const randomRules = (r: () => number, n: number, kind: 'line' | 'order'): DiscountRule[] =>
    Array.from({ length: n }, (_, i) =>
      rule({
        id: `r${i}`,
        code: `R${i}`,
        kind,
        priority: Math.floor(r() * 5),
        stacking: r() < 0.5 ? 'exclusive' : 'stackable',
        conditions: kind === 'order' ? { minOrderValue: Math.floor(r() * 300) } : {},
        reward:
          kind === 'order'
            ? r() < 0.5
              ? { type: 'percent', value: Math.floor(r() * 40) }
              : { type: 'amount', value: Math.floor(r() * 200) }
            : ([
                { type: 'percent', value: Math.floor(r() * 60) },
                { type: 'amount_per_unit', value: Math.floor(r() * 30) },
                { type: 'amount_per_line', value: Math.floor(r() * 120) },
              ][Math.floor(r() * 3)]! as DiscountRule['reward']),
        limits: r() < 0.3 ? { maxDiscountPercent: Math.floor(r() * 50) } : {},
      }),
    );

  const randomLines = (r: () => number, n: number): DiscountLine[] =>
    Array.from({ length: n }, (_, i) => {
      const qty = 1 + Math.floor(r() * 9);
      const unit = 10 + Math.floor(r() * 200);
      const total = qty * unit;
      return line({
        index: i,
        id: `p${i}`,
        quantity: qty,
        unitPrice: unit,
        lineTotal: total,
        minLineTotal: r() < 0.5 ? Math.round(total * (0.4 + r() * 0.6)) : null,
      });
    });

  it('no stack of line rules ever takes a line below its floor or makes it negative', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const lines = randomLines(r, 1 + Math.floor(r() * 5));
      const out = resolveLineDiscounts(
        lines,
        inputs(randomRules(r, 1 + Math.floor(r() * 6), 'line')),
      );
      out.forEach((o, i) => {
        const l = lines[i]!;
        expect(o.total).toBeGreaterThanOrEqual(0);
        expect(l.lineTotal - o.total).toBeGreaterThanOrEqual((l.minLineTotal ?? 0) - 0.011);
        const sum = o.applied.reduce((n, a) => n + a.amount, 0);
        expect(Math.abs(sum - o.total)).toBeLessThan(0.011);
      });
    }
  });

  it('the same inputs always give the same answer, whatever order the rules come in', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed);
      const lines = randomLines(r, 3);
      const rules = randomRules(r, 5, 'line');
      const a = resolveLineDiscounts(lines, inputs(rules));
      const b = resolveLineDiscounts(lines, inputs([...rules].reverse()));
      expect(b.map((x) => x.applied.map((y) => [y.code, y.amount]))).toEqual(
        a.map((x) => x.applied.map((y) => [y.code, y.amount])),
      );
    }
  });

  it('order rules never take more than the order, nor any line below its floor', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const lines = randomLines(r, 1 + Math.floor(r() * 5));
      const out = resolveOrderDiscounts(
        lines,
        inputs(randomRules(r, 1 + Math.floor(r() * 5), 'order')),
      );
      const orderTotal = lines.reduce((n, l) => n + l.lineTotal, 0);
      expect(out.total).toBeLessThanOrEqual(orderTotal + 0.011);
      for (const l of lines) {
        const pct = out.linePercent.get(l.index) ?? 0;
        const after = l.lineTotal * (1 - pct / 100);
        expect(after).toBeGreaterThanOrEqual((l.minLineTotal ?? 0) - 0.02);
      }
    }
  });

  it('a budget is never overspent', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const budget = 1 + Math.floor(r() * 80);
      const rules = [
        rule({
          code: 'B',
          limits: { budget },
          reward: { type: 'percent', value: 10 + Math.floor(r() * 40) },
        }),
      ];
      const out = resolveLineDiscounts(
        randomLines(r, 4),
        inputs(rules, {
          availability: new Map([
            ['r1', { remainingBudget: budget }],
            ['B', { remainingBudget: budget }],
          ]),
        }),
      );
      const given = out.reduce((n, o) => n + o.total, 0);
      expect(given).toBeLessThanOrEqual(budget + 0.011);
    }
  });
});
