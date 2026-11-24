import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  buildLowStock,
  buildSlowStock,
  buildStockMovement,
  buildStockValuation,
  daysOfCover,
} from './inventory-reports';
import type { MovementRow, StockRow } from './inventory-queries';
import type { ReportFacts } from './types';

const facts: ReportFacts = {
  preset: 'this_month',
  compare: 'previous_period',
  fromDate: '2026-03-01',
  toDate: '2026-03-31',
  previousFromDate: '2026-02-01',
  previousToDate: '2026-02-28',
  timeZone: 'Africa/Nairobi',
  baseCurrency: 'KES',
  scopeLabel: 'All locations',
  branchId: null,
  canPickBranch: false,
  asAtNow: true,
  notice: null,
};

const NOW = new Date('2026-03-10T12:00:00Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const stock = (over: Partial<StockRow>): StockRow => ({
  id: 'p',
  name: 'Product',
  category: 'Groceries',
  onHand: 10,
  reserved: 0,
  available: 10,
  reorderLevel: 5,
  cost: 20,
  soldRecently: 0,
  unitsSold90: 0,
  lastSoldAt: null,
  ...over,
});

describe('days of cover', () => {
  it('divides what is available by the daily sales of the last 30 days', () => {
    expect(daysOfCover(stock({ available: 3, soldRecently: 5 }))).toBe(18);
  });
  it('is zero when nothing is available, and unknown when nothing has sold', () => {
    expect(daysOfCover(stock({ available: 0, soldRecently: 9 }))).toBe(0);
    expect(daysOfCover(stock({ available: -2, soldRecently: 0 }))).toBe(0);
    expect(daysOfCover(stock({ available: 8, soldRecently: 0 }))).toBeNull();
  });
});

describe('stock valuation', () => {
  const rows = [
    stock({ id: 'a', name: 'A', onHand: 10, cost: 20 }),
    stock({ id: 'b', name: 'B', onHand: 5, cost: null, category: 'Other' }),
    stock({ id: 'c', name: 'C', onHand: -3, cost: 10 }),
  ];
  const r = buildStockValuation({
    facts,
    rows,
    overviewValue: 250,
    locations: [],
    truncated: false,
    title: 'Stock valuation',
  });

  it('values stock at cost, counts a negative balance as nothing, and never values an unknown cost at zero', () => {
    expect(r.table.rows[0]?.[4]).toBe(200);
    expect(r.table.rows[1]?.[4]).toBeNull();
    expect(r.table.rows[2]?.[4]).toBe(0);
    expect(r.kpis.find((k) => k.key === 'nocost')?.value).toBe(1);
  });

  it('proves the list against the overview and names what is not listed', () => {
    expect(r.reconciliation.map((l) => l.value)).toEqual([200, 50, 250]);
  });

  it('offers a donut by category and no chart of locations when there are none', () => {
    expect(r.charts.map((c) => c.kind)).toEqual(['donut']);
  });
});

describe('low and out of stock', () => {
  const rows = [
    stock({ id: 'low', name: 'Low slow', available: 4, soldRecently: 0 }),
    stock({ id: 'low-fast', name: 'Low fast', available: 2, soldRecently: 30 }),
    stock({ id: 'out', name: 'Out', available: 0, onHand: 0, soldRecently: 6 }),
  ];
  const r = buildLowStock({ facts, rows, truncated: false, title: 'Low and out of stock' });

  it('puts what is out first, then what will run out soonest, with what is not selling last', () => {
    expect(r.table.rows.map((x) => x[0])).toEqual(['Out', 'Low fast', 'Low slow']);
    expect(r.table.rows.map((x) => x[2])).toEqual(['Out of stock', 'Low', 'Low']);
    expect(r.table.rows.map((x) => x[8])).toEqual([0, 2, null]);
  });

  it('counts how many are out, low and still selling', () => {
    expect(r.kpis.map((k) => [k.key, k.value])).toEqual([
      ['out', 1],
      ['low', 2],
      ['selling', 2],
    ]);
  });
});

describe('slow and dead stock', () => {
  it('sorts stock into how long it has not sold', () => {
    expect(bucketOf(stock({ lastSoldAt: daysAgo(45) }), NOW).bucket).toBe('slow');
    expect(bucketOf(stock({ lastSoldAt: daysAgo(75) }), NOW).bucket).toBe('stale');
    expect(bucketOf(stock({ lastSoldAt: daysAgo(120) }), NOW).bucket).toBe('dead');
    expect(bucketOf(stock({ lastSoldAt: null }), NOW)).toEqual({ bucket: 'dead', days: null });
  });

  it('adds up the cash tied up and keeps an unknown cost apart from zero', () => {
    const rows = [
      stock({ id: 'a', onHand: 10, cost: 20, lastSoldAt: daysAgo(45) }),
      stock({ id: 'b', onHand: 5, cost: 10, lastSoldAt: null }),
      stock({ id: 'c', onHand: 7, cost: null, lastSoldAt: daysAgo(100) }),
      stock({ id: 'd', onHand: 0, cost: 99, lastSoldAt: null }),
    ];
    const r = buildSlowStock({
      facts,
      rows,
      now: NOW,
      totalStockValue: 1000,
      truncated: false,
      title: 'Slow and dead stock',
    });
    expect(r.table.rows).toHaveLength(3);
    expect(r.kpis.find((k) => k.key === 'tied')?.value).toBe(250);
    expect(r.kpis.find((k) => k.key === 'dead')?.value).toBe(50);
    expect(r.kpis.find((k) => k.key === 'share')?.value).toBe(25);
    expect(r.table.rows[2]?.[5]).toBeNull();
    expect(r.table.rows[1]?.[6]).toBe('Never');
  });
});

describe('stock movement', () => {
  const rows: MovementRow[] = [
    {
      id: 'a',
      name: 'A',
      received: 20,
      returnedToSupplier: -2,
      sold: -12,
      returnedByCustomers: 1,
      adjusted: -3,
      netChange: 4,
      onHandNow: 9,
    },
    {
      id: 'b',
      name: 'B',
      received: 0,
      returnedToSupplier: 0,
      sold: -5,
      returnedByCustomers: 0,
      adjusted: 0,
      netChange: -5,
      onHandNow: 0,
    },
  ];
  const r = buildStockMovement({ facts, rows, truncated: false, title: 'Stock movement' });

  it('writes units out as positive numbers and keeps adjustments signed', () => {
    expect(r.table.rows[0]).toEqual(['A', 20, 12, 1, 2, -3, 4, 9]);
  });

  it('totals the period and ranks what sold most', () => {
    expect(r.kpis.map((k) => [k.key, k.value])).toEqual([
      ['received', 20],
      ['sold', 17],
      ['adjusted', -3],
      ['net', -1],
    ]);
    const chart = r.charts[0];
    expect(chart?.kind === 'ranked' ? chart.items.map((i) => i.label) : []).toEqual(['A', 'B']);
  });
});
