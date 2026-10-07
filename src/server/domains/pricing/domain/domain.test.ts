import { describe, expect, it } from 'vitest';
import { chooseGroup, priceFromTiers, resolvePrice, specificityOf } from './resolve';
import { scopesCanOverlap, validateScopes, validateTiers, wouldTie } from './rules';
import {
  DEFAULT_WEIGHTS,
  type PriceContext,
  type PriceItemInput,
  type PriceListHeader,
  type PriceListLine,
} from './types';

const at = new Date('2026-10-07T10:00:00Z');
const ctx = (over: Partial<PriceContext> = {}): PriceContext => ({
  at,
  currency: 'KES',
  baseCurrency: 'KES',
  rateFromBase: 1,
  decimals: 2,
  ...over,
});
const item = (over: Partial<PriceItemInput> = {}): PriceItemInput => ({
  productId: 'p1',
  quantity: 1,
  standardPrice: 1000,
  taxRate: 16,
  lineTaxInclusive: true,
  standardTaxInclusive: true,
  ...over,
});
let n = 0;
const list = (over: Partial<PriceListHeader> = {}): PriceListHeader => ({
  id: `l${String(++n).padStart(3, '0')}`,
  code: `L${n}`,
  name: `List ${n}`,
  kind: 'list',
  currency: 'KES',
  taxInclusive: true,
  quantityMode: 'all_units',
  priority: 0,
  validFrom: new Date('2026-01-01T00:00:00Z'),
  validTo: null,
  scopes: {},
  version: 1,
  ...over,
});
const line = (header: PriceListHeader, price: number, over: Partial<PriceListLine> = {}) => ({
  header,
  line: {
    id: `ln${String(++n).padStart(3, '0')}`,
    priceListId: header.id,
    productId: 'p1',
    price,
    tiers: [],
    floorPrice: null,
    lockedUntil: null,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    ...over,
  } as PriceListLine,
});

describe('choosing the base price', () => {
  it('uses the standard price when the product is in no list', () => {
    const r = resolvePrice(item(), ctx(), [], DEFAULT_WEIGHTS);
    expect(r.unitPrice).toBe(1000);
    expect(r.trace.source).toBe('standard');
    expect(r.trace.steps.join(' ')).toMatch(/no price list/i);
  });

  it('never prices at zero: no list and no standard price is "no price"', () => {
    const r = resolvePrice(item({ standardPrice: null }), ctx(), [], DEFAULT_WEIGHTS);
    expect(r.unitPrice).toBeNull();
    expect(r.lineTotal).toBeNull();
    expect(r.trace.source).toBe('none');
    const zero = resolvePrice(item({ standardPrice: 0 }), ctx(), [], DEFAULT_WEIGHTS);
    expect(zero.unitPrice).toBeNull();
  });

  it('prefers the more specific list: customer beats group beats branch beats channel', () => {
    const channel = line(list({ scopes: { channel: { op: 'in', values: ['sales_order'] } } }), 900);
    const branch = line(list({ scopes: { branch: { op: 'in', values: ['b1'] } } }), 880);
    const group = line(list({ scopes: { customer_group: { op: 'in', values: ['g1'] } } }), 850);
    const customer = line(list({ scopes: { customer: { op: 'in', values: ['c1'] } } }), 800);
    const c = ctx({
      channel: 'sales_order',
      branchId: 'b1',
      customerGroupId: 'g1',
      customerId: 'c1',
    });
    const pairs = [channel, branch, group, customer];
    expect(resolvePrice(item(), c, pairs, DEFAULT_WEIGHTS).unitPrice).toBe(800);
    expect(
      resolvePrice(item(), { ...c, customerId: 'other' }, pairs, DEFAULT_WEIGHTS).unitPrice,
    ).toBe(850);
    expect(
      resolvePrice(item(), { ...c, customerId: 'x', customerGroupId: 'y' }, pairs, DEFAULT_WEIGHTS)
        .unitPrice,
    ).toBe(880);
    expect(
      resolvePrice(
        item(),
        { ...c, customerId: 'x', customerGroupId: 'y', branchId: 'z' },
        pairs,
        DEFAULT_WEIGHTS,
      ).unitPrice,
    ).toBe(900);
  });

  it('a more constrained list outranks a less constrained one (sum of weights)', () => {
    const one = line(list({ scopes: { branch: { op: 'in', values: ['b1'] } } }), 900);
    const two = line(
      list({
        scopes: {
          branch: { op: 'in', values: ['b1'] },
          channel: { op: 'in', values: ['sales_order'] },
        },
      }),
      870,
    );
    const r = resolvePrice(
      item(),
      ctx({ branchId: 'b1', channel: 'sales_order' }),
      [one, two],
      DEFAULT_WEIGHTS,
    );
    expect(r.unitPrice).toBe(870);
  });

  it('a contract beats any ordinary list', () => {
    const cust = line(list({ scopes: { customer: { op: 'in', values: ['c1'] } } }), 800);
    const contract = line(list({ kind: 'contract' }), 950);
    const r = resolvePrice(item(), ctx({ customerId: 'c1' }), [cust, contract], DEFAULT_WEIGHTS);
    expect(r.unitPrice).toBe(950);
    expect(r.trace.winner?.listCode).toBe(contract.header.code);
  });

  it('breaks ties by priority, then newest, then id, and always the same way', () => {
    const a = line(list({ priority: 1 }), 900);
    const b = line(list({ priority: 5 }), 880);
    expect(resolvePrice(item(), ctx(), [a, b], DEFAULT_WEIGHTS).unitPrice).toBe(880);

    const old = line(list(), 900, { validFrom: new Date('2026-02-01T00:00:00Z') });
    const fresh = line(list(), 870, { validFrom: new Date('2026-06-01T00:00:00Z') });
    expect(resolvePrice(item(), ctx(), [old, fresh], DEFAULT_WEIGHTS).unitPrice).toBe(870);

    const x = line(list({ id: 'aaa' }), 900, { id: 'z1', validFrom: fresh.line.validFrom });
    const y = line(list({ id: 'bbb' }), 860, { id: 'z2', validFrom: fresh.line.validFrom });
    const first = resolvePrice(item(), ctx(), [x, y], DEFAULT_WEIGHTS).unitPrice;
    const second = resolvePrice(item(), ctx(), [y, x], DEFAULT_WEIGHTS).unitPrice;
    expect(first).toBe(second);
  });

  it('ignores lists out of date, out of scope or excluding the sale, and says why', () => {
    const expired = line(list({ validTo: new Date('2026-06-01T00:00:00Z') }), 500);
    const future = line(list(), 500, { validFrom: new Date('2027-01-01T00:00:00Z') });
    const other = line(list({ scopes: { branch: { op: 'in', values: ['b9'] } } }), 500);
    const excluded = line(list({ scopes: { customer: { op: 'not_in', values: ['c1'] } } }), 500);
    const r = resolvePrice(
      item(),
      ctx({ customerId: 'c1', branchId: 'b1' }),
      [expired, future, other, excluded],
      DEFAULT_WEIGHTS,
    );
    expect(r.unitPrice).toBe(1000);
    expect(
      r.trace.candidates.every((c) => c.outcome === 'not_applicable' || c.source === 'standard'),
    ).toBe(true);
    expect(r.trace.candidates.map((c) => c.why).join('|')).toMatch(/not in force.*|branch/i);
  });

  it('a not_in rule does not add specificity', () => {
    const h = list({ scopes: { customer: { op: 'not_in', values: ['c1'] } } });
    expect(specificityOf(h, DEFAULT_WEIGHTS)).toBe(0);
  });

  it('respects configured weights (route above customer group)', () => {
    const group = line(list({ scopes: { customer_group: { op: 'in', values: ['g1'] } } }), 850);
    const route = line(list({ scopes: { route: { op: 'in', values: ['r1'] } } }), 820);
    const c = ctx({ customerGroupId: 'g1', route: 'r1' });
    expect(resolvePrice(item(), c, [group, route], DEFAULT_WEIGHTS).unitPrice).toBe(850);
    expect(
      resolvePrice(item(), c, [group, route], { ...DEFAULT_WEIGHTS, route: 40 }).unitPrice,
    ).toBe(820);
  });
});

describe('quantity breaks', () => {
  const tiers = [
    { fromQty: 50, price: 95 },
    { fromQty: 100, price: 90 },
  ];
  it('all units: the tier reached prices every unit', () => {
    const l = { price: 100, tiers };
    expect(priceFromTiers(l, 'all_units', 10).total).toBe(1000);
    expect(priceFromTiers(l, 'all_units', 50).total).toBe(4750);
    expect(priceFromTiers(l, 'all_units', 120).total).toBe(10800);
  });
  it('incremental: each tier prices only the units from its start', () => {
    const l = {
      price: 100,
      tiers: [
        { fromQty: 51, price: 95 },
        { fromQty: 101, price: 90 },
      ],
    };
    expect(priceFromTiers(l, 'incremental', 50).total).toBe(5000);
    expect(priceFromTiers(l, 'incremental', 60).total).toBe(5000 + 10 * 95);
    expect(priceFromTiers(l, 'incremental', 120).total).toBe(5000 + 50 * 95 + 20 * 90);
  });
  it('reports the quantity break used on the trace', () => {
    const h = list();
    const r = resolvePrice(
      item({ quantity: 100 }),
      ctx(),
      [line(h, 100, { tiers })],
      DEFAULT_WEIGHTS,
    );
    expect(r.unitPrice).toBe(90);
    expect(r.lineTotal).toBe(9000);
    expect(r.trace.steps.join(' ')).toMatch(/100\+ unit tier/);
  });
  it('validates tiers', () => {
    expect(validateTiers(tiers, 100)).toEqual([]);
    expect(
      validateTiers(
        [
          { fromQty: 10, price: 1 },
          { fromQty: 10, price: 1 },
        ],
        5,
      ),
    ).toHaveLength(1);
    expect(validateTiers([{ fromQty: 0, price: 1 }], 5)).toHaveLength(1);
    expect(validateTiers([], -1)).toHaveLength(1);
  });
});

describe('tax basis and currency', () => {
  it('turns a tax-exclusive list price into the inclusive line basis', () => {
    const h = list({ taxInclusive: false });
    const r = resolvePrice(item(), ctx(), [line(h, 1000)], DEFAULT_WEIGHTS);
    expect(r.unitPrice).toBe(1160);
    expect(r.trace.steps.join(' ')).toMatch(/tax-exclusive/);
  });
  it('turns an inclusive price into an exclusive line basis', () => {
    const r = resolvePrice(
      item({ lineTaxInclusive: false }),
      ctx(),
      [line(list({ taxInclusive: true }), 1160)],
      DEFAULT_WEIGHTS,
    );
    expect(r.unitPrice).toBe(1000);
  });
  it('a list in the sale currency beats a conversion', () => {
    const usd = line(list({ currency: 'USD' }), 8);
    const kes = line(list({ currency: 'KES', priority: 9 }), 1100);
    const c = ctx({ currency: 'USD', rateFromBase: 0.0077, decimals: 2 });
    expect(resolvePrice(item(), c, [usd, kes], DEFAULT_WEIGHTS).unitPrice).toBe(8);
  });
  it('converts the base price at the rate, rounding to the currency', () => {
    const c = ctx({ currency: 'USD', rateFromBase: 0.0077, decimals: 2 });
    const r = resolvePrice(item({ quantity: 10 }), c, [line(list(), 1100)], DEFAULT_WEIGHTS);
    expect(r.lineTotal).toBe(84.7);
    expect(r.trace.steps.join(' ')).toMatch(/Converted from KES at 0.0077/);
  });
  it('a currency with no rate cannot be priced from the base', () => {
    const c = ctx({ currency: 'UGX', rateFromBase: 0 });
    const r = resolvePrice(item(), c, [line(list(), 1100)], DEFAULT_WEIGHTS);
    expect(r.unitPrice).toBeNull();
  });
});

describe('the trace and the floor', () => {
  it('lists the winner first and keeps a bounded number of candidates', () => {
    const pairs = Array.from({ length: 60 }, (_, i) =>
      line(list({ scopes: { branch: { op: 'in', values: [`x${i}`] } } }), 500),
    );
    const win = line(list({ priority: 1 }), 700);
    const r = resolvePrice(item(), ctx({ branchId: 'b1' }), [...pairs, win], DEFAULT_WEIGHTS);
    expect(r.trace.candidates[0]!.outcome).toBe('won');
    expect(r.trace.candidates.length).toBeLessThanOrEqual(25);
    expect(r.trace.steps.join(' ')).toMatch(/more price lists were considered/);
  });
  it('flags a price below the line floor', () => {
    const r = resolvePrice(
      item(),
      ctx(),
      [line(list(), 800, { floorPrice: 850 })],
      DEFAULT_WEIGHTS,
    );
    expect(r.trace.belowFloor).toBe(true);
    expect(r.trace.floorPrice).toBe(850);
  });
  it('is pure: the same inputs give the identical result', () => {
    const pairs = [line(list(), 900), line(list({ priority: 2 }), 880)];
    const a = resolvePrice(item({ quantity: 3 }), ctx(), pairs, DEFAULT_WEIGHTS);
    const b = resolvePrice(item({ quantity: 3 }), ctx(), [...pairs].reverse(), DEFAULT_WEIGHTS);
    expect(a).toEqual(b);
  });
  it('refuses a zero quantity', () => {
    expect(resolvePrice(item({ quantity: 0 }), ctx(), [], DEFAULT_WEIGHTS).unitPrice).toBeNull();
  });
});

describe('customers in several groups, scopes and conflicts', () => {
  it('chooses the highest-priority group, then the code', () => {
    expect(chooseGroup([])).toBeNull();
    expect(
      chooseGroup([
        { id: 'a', code: 'B', priority: 1 },
        { id: 'b', code: 'A', priority: 5 },
        { id: 'c', code: 'C', priority: 5 },
      ]),
    ).toBe('b');
  });
  it('validates scopes', () => {
    expect(validateScopes({ customer: { op: 'in', values: ['c1'] } })).toEqual([]);
    expect(validateScopes({ customer: { op: 'in', values: [] } })).toHaveLength(1);
    expect(validateScopes({ sales_type: { op: 'in', values: ['barter'] } })).toHaveLength(1);
    expect(validateScopes({ country: { op: 'in', values: ['KENYA'] } })).toHaveLength(1);
    expect(validateScopes({ galaxy: { op: 'in', values: ['x'] } } as never)).toHaveLength(1);
  });
  it('lists that cannot match the same sale do not conflict', () => {
    const a = { customer_group: { op: 'in' as const, values: ['g1'] } };
    const b = { customer_group: { op: 'in' as const, values: ['g2'] } };
    expect(scopesCanOverlap(a, b)).toBe(false);
    expect(scopesCanOverlap(a, {})).toBe(true);
    expect(scopesCanOverlap(a, { branch: { op: 'in', values: ['b1'] } })).toBe(true);
  });
  it('detects an equal-rank tie', () => {
    const a = list({ priority: 1 });
    const b = list({ priority: 1 });
    expect(wouldTie(a, b, DEFAULT_WEIGHTS)).toBe(true);
    expect(wouldTie(a, list({ priority: 2 }), DEFAULT_WEIGHTS)).toBe(false);
    expect(wouldTie(a, list({ priority: 1, currency: 'USD' }), DEFAULT_WEIGHTS)).toBe(false);
    expect(
      wouldTie(a, list({ priority: 1, validFrom: new Date('2030-01-01T00:00:00Z') }), {
        ...DEFAULT_WEIGHTS,
      }),
    ).toBe(true); // open-ended list overlaps the later one
    expect(
      wouldTie(
        list({ validTo: new Date('2026-03-01T00:00:00Z') }),
        list({ validFrom: new Date('2026-04-01T00:00:00Z') }),
        DEFAULT_WEIGHTS,
      ),
    ).toBe(false);
  });
});
