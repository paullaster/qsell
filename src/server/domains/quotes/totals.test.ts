import { describe, expect, it } from 'vitest';
import type { KitTaxShape } from '@/server/domains/pricing/domain/kits';
import { computeQuoteTotals, type TotalsProduct } from './totals';

const product = (over: Partial<TotalsProduct> = {}): TotalsProduct => ({
  price: 100,
  costPrice: 60,
  taxRate: 0,
  isTaxInclusive: true,
  ...over,
});
const none = new Map<string, KitTaxShape>();
const compute = (
  lines: { productId: string; quantity: number; unitPrice?: number; discountPercent?: number }[],
  products: Record<string, TotalsProduct>,
  over: {
    discountPercent?: number;
    shippingFee?: number;
    floor?: number;
    kits?: Map<string, KitTaxShape>;
  } = {},
) =>
  computeQuoteTotals(
    {
      lines: lines.map((l) => ({ discountPercent: 0, ...l })),
      discountPercent: over.discountPercent ?? 0,
      shippingFee: over.shippingFee ?? 0,
    },
    new Map(Object.entries(products)),
    over.kits ?? none,
    over.floor ?? 10,
  );

describe('what a quote comes to', () => {
  it('prices a line at the product’s price when none is given, and at the given price when it is', () => {
    expect(compute([{ productId: 'a', quantity: 2 }], { a: product() }).subtotal).toBe(200);
    expect(
      compute([{ productId: 'a', quantity: 2, unitPrice: 150 }], { a: product() }).subtotal,
    ).toBe(300);
  });

  it('takes tax out of a tax-inclusive price, and adds it to an exclusive one', () => {
    const inclusive = compute([{ productId: 'a', quantity: 1 }], { a: product({ taxRate: 16 }) });
    expect(inclusive.lines[0]?.net).toBeCloseTo(86.2069, 3);
    expect(inclusive.lines[0]?.tax).toBeCloseTo(13.7931, 3);
    expect(inclusive.total).toBeCloseTo(100, 6);
    const exclusive = compute([{ productId: 'a', quantity: 1 }], {
      a: product({ taxRate: 16, isTaxInclusive: false }),
    });
    expect(exclusive.subtotal).toBe(100);
    expect(exclusive.tax).toBeCloseTo(16, 6);
    expect(exclusive.total).toBeCloseTo(116, 6);
  });

  it('applies the line discount and the quote discount together', () => {
    const totals = compute(
      [{ productId: 'a', quantity: 1, discountPercent: 10 }],
      { a: product() },
      {
        discountPercent: 10,
      },
    );
    expect(totals.subtotal).toBeCloseTo(81, 6);
  });

  it('adds shipping to the total but not to the subtotal or the margin', () => {
    const totals = compute(
      [{ productId: 'a', quantity: 1 }],
      { a: product() },
      { shippingFee: 25 },
    );
    expect(totals.subtotal).toBe(100);
    expect(totals.total).toBe(125);
    expect(totals.marginPercent).toBeCloseTo(40, 6);
  });

  it('works out cost, profit and margin per line and in all', () => {
    const totals = compute(
      [
        { productId: 'a', quantity: 1 },
        { productId: 'b', quantity: 2, unitPrice: 50 },
      ],
      { a: product(), b: product({ costPrice: 20 }) },
    );
    expect(totals.lines[0]).toMatchObject({ cost: 60, grossProfit: 40 });
    expect(totals.lines[0]?.grossMarginPercent).toBeCloseTo(40, 6);
    expect(totals.lines[1]).toMatchObject({ cost: 40, grossProfit: 60 });
    expect(totals).toMatchObject({ subtotal: 200, cost: 100, grossProfit: 100 });
    expect(totals.marginPercent).toBeCloseTo(50, 6);
  });

  it('says when the margin is below the floor, and not when it is on it', () => {
    const low = compute(
      [{ productId: 'a', quantity: 1, unitPrice: 62 }],
      { a: product() },
      { floor: 10 },
    );
    expect(low.marginPercent).toBeCloseTo(3.2258, 3);
    expect(low.belowFloor).toBe(true);
    const on = compute(
      [{ productId: 'a', quantity: 1, unitPrice: 100 / 0.9 }],
      { a: product() },
      { floor: 40 },
    );
    expect(on.marginPercent).toBeGreaterThanOrEqual(40 - 1e-9);
    expect(on.belowFloor).toBe(false);
  });

  it('flags each line against the floor too, and reports the floor it used', () => {
    const totals = compute(
      [
        { productId: 'a', quantity: 1, unitPrice: 62 },
        { productId: 'a', quantity: 1, unitPrice: 100 },
      ],
      { a: product() },
      { floor: 10 },
    );
    expect(totals.lines.map((l) => l.belowFloor)).toEqual([true, false]);
    expect(totals.minimumMarginPercent).toBe(10);
  });

  it('has a margin of zero when nothing is sold, and treats an unknown product as free', () => {
    const empty = compute([], {});
    expect(empty).toMatchObject({ subtotal: 0, total: 0, marginPercent: 0 });
    const unknown = compute([{ productId: 'ghost', quantity: 3 }], {});
    expect(unknown.subtotal).toBe(0);
    expect(unknown.lines[0]?.grossMarginPercent).toBe(0);
  });

  it('taxes and costs a kit from what is in it', () => {
    const kit: KitTaxShape = {
      allocation: 'list_price',
      components: [
        { productId: 'x', quantity: 1, price: 100, cost: 30, weight: null, taxRate: 16 },
        { productId: 'y', quantity: 1, price: 100, cost: 20, weight: null, taxRate: 0 },
      ],
    };
    const totals = compute(
      [{ productId: 'kit', quantity: 1, unitPrice: 200 }],
      { kit: product({ costPrice: 1 }) },
      {
        kits: new Map([['kit', kit]]),
      },
    );
    // The kit's cost is its components' cost (50), not the product's own; tax is split per part.
    expect(totals.cost).toBe(50);
    expect(totals.tax).toBeCloseTo(13.7931, 3);
    expect(totals.subtotal).toBeCloseTo(186.2069, 3);
  });

  it('gives what each section comes to, counting only lines that sit in one', () => {
    const totals = computeQuoteTotals(
      {
        lines: [
          { productId: 'a', quantity: 1, discountPercent: 0, sectionId: 's1' },
          { productId: 'a', quantity: 2, discountPercent: 0, sectionId: 's1' },
          { productId: 'a', quantity: 1, discountPercent: 0, sectionId: 's2' },
          { productId: 'a', quantity: 1, discountPercent: 0, sectionId: null },
          { productId: 'a', quantity: 1, discountPercent: 0 },
        ],
        discountPercent: 0,
        shippingFee: 0,
      },
      new Map([['a', product()]]),
      none,
      10,
    );
    expect(totals.sectionTotals).toEqual({ s1: 300, s2: 100 });
  });

  it('ignores a shipping figure that is not a number', () => {
    const totals = compute(
      [{ productId: 'a', quantity: 1 }],
      { a: product() },
      { shippingFee: Number.NaN },
    );
    expect(totals.total).toBe(100);
  });

  it('uses the exact amount of a line typed per crate, not the price per kilogram rounded', () => {
    const totals = computeQuoteTotals(
      { lines: [{ productId: 'a', quantity: 1200, unitPrice: 83.3333, exactAmount: 100000, discountPercent: 0 }], discountPercent: 0, shippingFee: 0 },
      new Map(Object.entries({ a: product() })),
      none,
      0,
    );
    expect(totals.total).toBe(100000);
  });
});
