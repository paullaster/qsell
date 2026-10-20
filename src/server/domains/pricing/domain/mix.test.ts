import { describe, expect, it } from 'vitest';
import type { DiscountInputs, DiscountLine, DiscountRule } from './discounts';
import { resolveGifts, resolveMixDiscounts, type MixConfig } from './mix';

const NOW = new Date('2026-10-07T09:00:00Z');

const rule = (mix: MixConfig, over: Partial<DiscountRule> = {}): DiscountRule => ({
  id: over.id ?? over.code ?? 'm1',
  code: over.code ?? 'M1',
  name: 'Deal',
  kind: mix.type === 'gift' ? 'gift' : 'mix',
  priority: 0,
  stacking: 'exclusive',
  validFrom: new Date('2026-01-01T00:00:00Z'),
  validTo: null,
  schedule: {},
  scopes: {},
  target: {},
  conditions: {},
  reward: { type: 'percent', value: 0 },
  requiresCoupon: false,
  limits: {},
  appliesToContract: false,
  mix,
  version: 1,
  ...over,
});

const line = (
  index: number,
  qty: number,
  unit: number,
  over: Partial<DiscountLine> = {},
): DiscountLine => ({
  index,
  id: `p${index}`,
  brand: null,
  categoryChain: [],
  groupIds: [],
  quantity: qty,
  unitPrice: unit,
  lineTotal: qty * unit,
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

const totalOff = (r: ReturnType<typeof resolveMixDiscounts>) =>
  Math.round([...r.lines.values()].reduce((n, l) => n + l.total, 0) * 100) / 100;

const ALL = {};
const only = (...ids: string[]) => ({ productIds: ids });

describe('buy and get', () => {
  const buy2get1 = (extra: Partial<Extract<MixConfig, { type: 'buy_get' }>> = {}): MixConfig => ({
    type: 'buy_get',
    sameSet: true,
    buy: { target: ALL, quantity: 2 },
    get: { target: ALL, quantity: 1, reward: { kind: 'free' } },
    ...extra,
  });

  it('buy 2 get 1 free: one unit in each group of three is free', () => {
    const r = resolveMixDiscounts([line(0, 3, 100)], inputs([rule(buy2get1())]));
    expect(totalOff(r)).toBe(100);
    expect(
      resolveMixDiscounts([line(0, 6, 100)], inputs([rule(buy2get1())])).lines.get(0)!.total,
    ).toBe(200);
    expect(
      resolveMixDiscounts([line(0, 5, 100)], inputs([rule(buy2get1())])).lines.get(0)!.total,
    ).toBe(100);
    expect(resolveMixDiscounts([line(0, 2, 100)], inputs([rule(buy2get1())])).lines.size).toBe(0);
  });

  it('a part unit is priced as usual and the deal says so', () => {
    const r = resolveMixDiscounts([line(0, 3.5, 100)], inputs([rule(buy2get1())]));
    // Three whole units make one set; the half unit is neither bought-for nor free.
    expect(totalOff(r)).toBe(100);
    expect(r.considered[0]?.why).toContain('part unit is priced as usual');
    const whole = resolveMixDiscounts([line(0, 3, 100)], inputs([rule(buy2get1())]));
    expect(whole.considered[0]?.why).not.toContain('part unit');
  });

  it('the cheapest unit of the group is the free one, across lines', () => {
    const r = resolveMixDiscounts([line(0, 2, 100), line(1, 1, 40)], inputs([rule(buy2get1())]));
    expect(r.lines.get(1)!.total).toBe(40);
    expect(r.lines.has(0)).toBe(false);
  });

  it('a percentage or a set price instead of free', () => {
    const half = rule(
      buy2get1({ get: { target: ALL, quantity: 1, reward: { kind: 'percent', value: 50 } } }),
    );
    expect(totalOff(resolveMixDiscounts([line(0, 3, 100)], inputs([half])))).toBe(50);
    const price = rule(
      buy2get1({ get: { target: ALL, quantity: 1, reward: { kind: 'price', value: 30 } } }),
    );
    expect(totalOff(resolveMixDiscounts([line(0, 3, 100)], inputs([price])))).toBe(70);
  });

  it('a different set earns the reward: buy a phone, accessories half price', () => {
    const deal: MixConfig = {
      type: 'buy_get',
      buy: { target: only('p0'), quantity: 1 },
      get: { target: only('p1'), quantity: 1, reward: { kind: 'percent', value: 50 } },
    };
    const r = resolveMixDiscounts([line(0, 1, 1000), line(1, 2, 100)], inputs([rule(deal)]));
    // One phone earns one accessory at half price, not both.
    expect(r.lines.get(1)!.total).toBe(50);
    expect(r.lines.has(0)).toBe(false);
    expect(
      totalOff(resolveMixDiscounts([line(0, 2, 1000), line(1, 2, 100)], inputs([rule(deal)]))),
    ).toBe(100);
    expect(resolveMixDiscounts([line(1, 2, 100)], inputs([rule(deal)])).lines.size).toBe(0);
  });

  it('a limit on sets', () => {
    const r = resolveMixDiscounts([line(0, 9, 100)], inputs([rule(buy2get1({ maxSets: 2 }))]));
    expect(r.lines.get(0)!.total).toBe(200);
  });
});

describe('mix and match', () => {
  const deal = (
    reward: { kind: 'price' | 'percent'; value: number },
    over: object = {},
  ): MixConfig => ({
    type: 'mix_match',
    set: ALL,
    quantity: 3,
    reward,
    ...over,
  });

  it('any 3 for a set price, across different products', () => {
    const r = resolveMixDiscounts(
      [line(0, 1, 100), line(1, 1, 100), line(2, 1, 100)],
      inputs([rule(deal({ kind: 'price', value: 250 }))]),
    );
    expect(totalOff(r)).toBe(50);
    // Spread over the units in proportion, so each line's tax stays right.
    expect([...r.lines.values()].map((l) => l.total)).toEqual([16.67, 16.67, 16.66]);
  });

  it('forms as many groups as there are units, and ignores the leftover', () => {
    const r = resolveMixDiscounts(
      [line(0, 7, 100)],
      inputs([rule(deal({ kind: 'price', value: 250 }))]),
    );
    expect(r.lines.get(0)!.total).toBe(100);
  });

  it('a percentage off each group', () => {
    const r = resolveMixDiscounts(
      [line(0, 3, 100)],
      inputs([rule(deal({ kind: 'percent', value: 20 }))]),
    );
    expect(totalOff(r)).toBe(60);
  });

  it('a price higher than the units are worth gives nothing', () => {
    expect(
      resolveMixDiscounts([line(0, 3, 100)], inputs([rule(deal({ kind: 'price', value: 400 }))]))
        .lines.size,
    ).toBe(0);
  });
});

describe('bundle deals', () => {
  const combo: MixConfig = {
    type: 'bundle_deal',
    price: 450,
    slots: [
      { target: only('p0'), quantity: 1 },
      { target: only('p1'), quantity: 1 },
      { target: only('p2'), quantity: 1 },
    ],
  };
  it('burger, fries and a drink for a fixed price', () => {
    const r = resolveMixDiscounts(
      [line(0, 1, 300), line(1, 1, 150), line(2, 1, 100)],
      inputs([rule(combo)]),
    );
    expect(totalOff(r)).toBe(100);
    expect(r.lines.get(0)!.total).toBeCloseTo(54.55, 2);
  });
  it('two sets when the basket has two of everything, none when a slot is empty', () => {
    expect(
      totalOff(
        resolveMixDiscounts(
          [line(0, 2, 300), line(1, 2, 150), line(2, 2, 100)],
          inputs([rule(combo)]),
        ),
      ),
    ).toBe(200);
    expect(
      resolveMixDiscounts([line(0, 1, 300), line(1, 1, 150)], inputs([rule(combo)])).lines.size,
    ).toBe(0);
  });
});

describe('unit allocation', () => {
  it('a unit earns one promotion only: the better deal takes the units, the other gets none', () => {
    const bogo = rule(
      {
        type: 'buy_get',
        sameSet: true,
        buy: { target: ALL, quantity: 2 },
        get: { target: ALL, quantity: 1, reward: { kind: 'free' } },
      },
      { code: 'BOGO' },
    );
    const three = rule(
      { type: 'mix_match', set: ALL, quantity: 3, reward: { kind: 'price', value: 220 } },
      { code: 'THREE' },
    );
    const r = resolveMixDiscounts([line(0, 3, 100)], inputs([bogo, three]));
    // BOGO gives 100, "3 for 220" gives 80: BOGO wins and uses all three units.
    expect(totalOff(r)).toBe(100);
    expect([...r.lines.get(0)!.applied.map((a) => a.code)]).toEqual(['BOGO']);
    expect(r.considered.find((c) => c.code === 'THREE')!.outcome).toBe('not_applicable');
  });

  it('a second deal gets the units the first left over', () => {
    const bogo = rule(
      {
        type: 'buy_get',
        sameSet: true,
        maxSets: 1,
        buy: { target: ALL, quantity: 2 },
        get: { target: ALL, quantity: 1, reward: { kind: 'free' } },
      },
      { code: 'BOGO' },
    );
    const three = rule(
      { type: 'mix_match', set: ALL, quantity: 3, reward: { kind: 'price', value: 270 } },
      { code: 'THREE' },
    );
    // Six units: BOGO takes three (100 off), THREE takes the other three (30 off).
    const r = resolveMixDiscounts([line(0, 6, 100)], inputs([bogo, three]));
    expect(
      r.lines
        .get(0)!
        .applied.map((a) => a.code)
        .sort(),
    ).toEqual(['BOGO', 'THREE']);
    expect(totalOff(r)).toBe(130);
  });
});

describe('guards', () => {
  const free: MixConfig = {
    type: 'buy_get',
    sameSet: true,
    buy: { target: ALL, quantity: 1 },
    get: { target: ALL, quantity: 1, reward: { kind: 'free' } },
  };
  it('never takes a line below its floor, and says it was cut back', () => {
    const r = resolveMixDiscounts([line(0, 2, 100, { minLineTotal: 150 })], inputs([rule(free)]));
    expect(r.lines.get(0)!.total).toBe(50);
    expect(r.lines.get(0)!.trimmed).toBe(50);
  });

  it('a budget caps what the deal gives', () => {
    const r = rule(free, { limits: { budget: 30 } });
    const out = resolveMixDiscounts(
      [line(0, 2, 100)],
      inputs([r], { availability: new Map([[r.id, { remainingBudget: 30 }]]) }),
    );
    expect(out.lines.get(0)!.total).toBe(30);
  });

  it('a coupon-only deal needs its code; scope and validity are respected', () => {
    const c = rule(free, { requiresCoupon: true });
    expect(resolveMixDiscounts([line(0, 2, 100)], inputs([c])).lines.size).toBe(0);
    expect(
      resolveMixDiscounts(
        [line(0, 2, 100)],
        inputs([c], { unlockedByCoupon: new Map([[c.id, 'X']]) }),
      ).lines.size,
    ).toBe(1);
    const old = rule(free, { validTo: new Date('2026-01-02T00:00:00Z') });
    expect(resolveMixDiscounts([line(0, 2, 100)], inputs([old])).considered[0]!.why).toBe(
      'Has ended',
    );
  });

  it('a basket too big to match is left alone, and says so', () => {
    const r = resolveMixDiscounts([line(0, 6000, 1)], inputs([rule(free)]));
    expect(r.lines.size).toBe(0);
    expect(r.considered[0]!.why).toContain('too many');
  });
});

describe('gifts', () => {
  const gift = (trigger: object, over: Partial<DiscountRule> = {}) =>
    rule({ type: 'gift', trigger, gifts: [{ productId: 'pen', quantity: 1 }] } as MixConfig, over);

  it('is earned when the goods come to enough, judged after discounts', () => {
    const g = gift({ minOrderValue: 1000 });
    expect(resolveGifts([line(0, 1, 900)], inputs([g])).gifts).toHaveLength(0);
    const earned = resolveGifts([line(0, 1, 1200)], inputs([g]));
    expect(earned.gifts[0]).toMatchObject({
      code: 'M1',
      gifts: [{ productId: 'pen', quantity: 1 }],
    });
    expect(resolveGifts([line(0, 1, 900)], inputs([g])).considered[0]!.why).toContain('Needs 1000');
  });

  it('can be earned by the number of units of certain products', () => {
    const g = gift({ minQuantity: 3, target: only('p0') });
    expect(resolveGifts([line(0, 2, 100), line(1, 5, 100)], inputs([g])).gifts).toHaveLength(0);
    expect(resolveGifts([line(0, 3, 100)], inputs([g])).gifts).toHaveLength(1);
  });

  it('counts weight exactly: 2.5 kg satisfies "at least 2" and the words say 2.5', () => {
    const g = gift({ minQuantity: 2.5, target: only('p0') });
    expect(resolveGifts([line(0, 2.4, 100)], inputs([g])).gifts).toHaveLength(0);
    expect(resolveGifts([line(0, 2.4, 100)], inputs([g])).considered[0]?.why).toContain('has 2.4');
    expect(resolveGifts([line(0, 2.5, 100)], inputs([g])).gifts).toHaveLength(1);
  });

  it('respects coupons and used-up limits', () => {
    const c = gift({}, { requiresCoupon: true, id: 'c', code: 'C' });
    expect(resolveGifts([line(0, 1, 100)], inputs([c])).gifts).toHaveLength(0);
    const blocked = gift({}, { id: 'b', code: 'B' });
    expect(
      resolveGifts(
        [line(0, 1, 100)],
        inputs([blocked], {
          availability: new Map([
            ['b', { blocked: 'Used up: all 5 uses are taken', remainingBudget: null }],
          ]),
        }),
      ).considered[0]!.outcome,
    ).toBe('blocked');
  });
});

describe('properties', () => {
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const randomRules = (r: () => number): DiscountRule[] =>
    Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => {
      const kind = Math.floor(r() * 3);
      const mix: MixConfig =
        kind === 0
          ? {
              type: 'buy_get',
              sameSet: r() < 0.5,
              buy: {
                target: r() < 0.5 ? ALL : only(`p${Math.floor(r() * 3)}`),
                quantity: 1 + Math.floor(r() * 3),
              },
              get: {
                target: r() < 0.5 ? ALL : only(`p${Math.floor(r() * 3)}`),
                quantity: 1 + Math.floor(r() * 2),
                reward: [
                  { kind: 'free' },
                  { kind: 'percent', value: 10 + Math.floor(r() * 60) },
                  { kind: 'price', value: Math.floor(r() * 80) },
                ][Math.floor(r() * 3)] as never,
              },
            }
          : kind === 1
            ? {
                type: 'mix_match',
                set: ALL,
                quantity: 2 + Math.floor(r() * 3),
                reward:
                  r() < 0.5
                    ? { kind: 'price', value: 50 + Math.floor(r() * 200) }
                    : { kind: 'percent', value: 5 + Math.floor(r() * 40) },
              }
            : {
                type: 'bundle_deal',
                price: 50 + Math.floor(r() * 250),
                slots: [
                  { target: only('p0'), quantity: 1 },
                  { target: only('p1'), quantity: 1 },
                ],
              };
      return rule(mix, { id: `r${i}`, code: `R${i}`, priority: Math.floor(r() * 3) });
    });
  const randomLines = (r: () => number): DiscountLine[] =>
    Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => {
      const qty = 1 + Math.floor(r() * 7);
      const unit = 20 + Math.floor(r() * 150);
      return line(i, qty, unit, {
        minLineTotal: r() < 0.4 ? Math.round(qty * unit * (0.3 + r() * 0.7)) : null,
      });
    });

  it('never takes more than a line is worth, below its floor, or gives the same unit twice', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const lines = randomLines(r);
      const out = resolveMixDiscounts(lines, inputs(randomRules(r)));
      for (const l of lines) {
        const got = out.lines.get(l.index);
        if (!got) continue;
        expect(got.total).toBeGreaterThanOrEqual(0);
        expect(l.lineTotal - got.total).toBeGreaterThanOrEqual((l.minLineTotal ?? 0) - 0.011);
        expect(Math.abs(got.applied.reduce((n, a) => n + a.amount, 0) - got.total)).toBeLessThan(
          0.011,
        );
        // A line's units can each be discounted once: the total never passes the line itself.
        expect(got.total).toBeLessThanOrEqual(l.lineTotal + 0.011);
      }
    }
  });

  it('gives the same answer whatever order the rules come in', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      const lines = randomLines(r);
      const rules = randomRules(r);
      const a = resolveMixDiscounts(lines, inputs(rules));
      const b = resolveMixDiscounts(lines, inputs([...rules].reverse()));
      const flat = (x: typeof a) =>
        [...x.lines.entries()]
          .sort((m, n) => m[0] - n[0])
          .map(([i, l]) => [i, l.total, l.applied.map((y) => y.code)]);
      expect(flat(b)).toEqual(flat(a));
    }
  });
});
