import { describe, expect, it } from 'vitest';
import { allocateKit, checkKit, kitCost, kitTax, splitTax, type KitComponentDef } from './kits';

const c = (
  productId: string,
  quantity: number,
  price: number,
  cost = 0,
  weight: number | null = null,
): KitComponentDef => ({
  productId,
  quantity,
  price,
  cost,
  weight,
});

describe("splitting a kit's price", () => {
  it("in proportion to the components' own prices, adding up to the cent", () => {
    const parts = allocateKit(
      2000,
      1,
      [c('wine', 1, 1500), c('cheese', 2, 400), c('card', 1, 100)],
      'list_price',
    );
    expect(parts.reduce((n, p) => n + p.amount, 0)).toBeCloseTo(2000, 10);
    // 1500 : 800 : 100 of 2400.
    expect(parts[0]!.amount).toBe(1250);
    expect(parts[1]!.amount).toBe(666.67);
    expect(parts[2]!.amount).toBe(83.33);
  });

  it('always adds up exactly, whatever the numbers', () => {
    for (let seed = 1; seed <= 300; seed++) {
      let x = seed;
      const r = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
      const comps = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, i) =>
        c(
          `p${i}`,
          1 + Math.floor(r() * 4),
          Math.floor(r() * 500),
          Math.floor(r() * 300),
          1 + Math.floor(r() * 5),
        ),
      );
      const total = Math.round(r() * 1_000_000) / 100;
      for (const m of ['list_price', 'cost', 'explicit'] as const) {
        const parts = allocateKit(total, 1 + Math.floor(r() * 3), comps, m);
        expect(Math.abs(parts.reduce((n, p) => n + p.amount, 0) - total)).toBeLessThan(0.0001);
        expect(parts.every((p) => p.amount >= 0)).toBe(true);
      }
    }
  });

  it('by cost, and by shares you set', () => {
    const byCost = allocateKit(100, 1, [c('a', 1, 0, 30), c('b', 1, 0, 70)], 'cost');
    expect(byCost.map((p) => p.amount)).toEqual([30, 70]);
    const explicit = allocateKit(
      100,
      1,
      [c('a', 1, 999, 999, 1), c('b', 1, 999, 999, 3)],
      'explicit',
    );
    expect(explicit.map((p) => p.amount)).toEqual([25, 75]);
  });

  it('multiplies units by the number of kits sold', () => {
    const parts = allocateKit(900, 3, [c('a', 2, 10), c('b', 1, 10)], 'list_price');
    expect(parts.map((p) => p.quantity)).toEqual([6, 3]);
    expect(parts.reduce((n, p) => n + p.amount, 0)).toBe(900);
  });

  it('falls back to units when the basis is all zero, so no component is left out', () => {
    const parts = allocateKit(90, 1, [c('a', 1, 0), c('b', 2, 0)], 'list_price');
    expect(parts.map((p) => p.amount)).toEqual([30, 60]);
  });

  it('a free kit has free components', () => {
    expect(
      allocateKit(0, 1, [c('a', 1, 10), c('b', 1, 10)], 'list_price').map((p) => p.amount),
    ).toEqual([0, 0]);
  });
});

describe('tax on a part', () => {
  it("works out net and tax in the kit line's basis", () => {
    expect(splitTax(116, 16, true)).toEqual({ net: 100, tax: 16 });
    expect(splitTax(100, 16, false)).toEqual({ net: 100, tax: 16 });
    expect(splitTax(100, 0, true)).toEqual({ net: 100, tax: 0 });
  });
});

describe('checking a kit', () => {
  const ok = [
    { productId: 'a', quantity: 1, weight: null },
    { productId: 'b', quantity: 2, weight: null },
  ];
  it('accepts a sensible kit', () => {
    expect(checkKit('kit', 'list_price', ok)).toEqual([]);
  });
  it('refuses an empty kit, itself, another kit, a repeat and a bad quantity', () => {
    expect(checkKit('kit', 'list_price', []).map((p) => p.path)).toContain('components');
    expect(
      checkKit('kit', 'list_price', [{ productId: 'kit', quantity: 1, weight: null }])[0]!.message,
    ).toContain('itself');
    expect(
      checkKit('kit', 'list_price', ok, new Set(['b'])).some((p) =>
        p.message.includes('another kit'),
      ),
    ).toBe(true);
    expect(
      checkKit('kit', 'list_price', [...ok, { productId: 'a', quantity: 1, weight: null }]).some(
        (p) => p.message.includes('twice'),
      ),
    ).toBe(true);
    expect(
      checkKit('kit', 'list_price', [{ productId: 'a', quantity: 0, weight: null }]),
    ).toHaveLength(1);
    expect(
      checkKit('kit', 'list_price', [{ productId: 'a', quantity: 1.5, weight: null }]),
    ).toHaveLength(1);
  });
  it('explicit shares must be above zero', () => {
    expect(checkKit('kit', 'explicit', ok).length).toBe(2);
    expect(
      checkKit('kit', 'explicit', [
        { productId: 'a', quantity: 1, weight: 1 },
        { productId: 'b', quantity: 1, weight: 2 },
      ]),
    ).toEqual([]);
  });
});

describe('what a kit line is taxed and costs', () => {
  const kit = {
    allocation: 'list_price' as const,
    components: [
      { productId: 'wine', quantity: 1, price: 1500, cost: 900, weight: null, taxRate: 16 },
      { productId: 'cheese', quantity: 2, price: 400, cost: 150, weight: null, taxRate: 0 },
    ],
  };
  it('splits the kit price and taxes each share at its own rate', () => {
    // 2000 split 1500:800 -> wine 1304.35 at 16% inclusive, cheese 695.65 untaxed.
    const { net, tax } = kitTax(2000, 1, kit, true);
    expect(tax).toBeCloseTo((1304.35 * 16) / 116, 2);
    expect(net + tax).toBeCloseTo(2000, 2);
  });
  it('costs what everything in it costs', () => {
    expect(kitCost(kit)).toBe(1200);
  });
});
