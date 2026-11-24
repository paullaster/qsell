import { describe, expect, it } from 'vitest';
import type { CustomerMix, CutRow, OrderTotals, ReturnRow } from './sales-queries';
import {
  buildCustomerMixReport,
  buildCutReport,
  buildReturnsReport,
  buildTimeReport,
  changePct,
  dateOfInstant,
  linkFor,
  pair,
} from './sales-reports';
import type { ReportFacts } from './types';

const facts: ReportFacts = {
  preset: 'this_month',
  compare: 'previous_period',
  fromDate: '2026-03-01',
  toDate: '2026-03-03',
  previousFromDate: '2026-02-26',
  previousToDate: '2026-02-28',
  timeZone: 'Africa/Nairobi',
  baseCurrency: 'KES',
  scopeLabel: 'All branches',
  branchId: null,
  canPickBranch: true,
  notice: null,
};

const row = (key: string, label: string, over: Partial<CutRow> = {}): CutRow => ({
  key,
  label,
  sales: 0,
  units: 0,
  orders: 0,
  cost: 0,
  knownSales: 0,
  tax: 0,
  lastAt: null,
  firstAt: null,
  ...over,
});

const totals: OrderTotals = { items: 1000, tax: 160, delivery: 40, total: 1200, orders: 4 };

describe('change against the comparison', () => {
  it('is a percentage with one decimal, and nothing when there was nothing before', () => {
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(80, 100)).toBe(-20);
    expect(changePct(100, 0)).toBeNull();
    expect(changePct(33.33, 100)).toBe(-66.7);
  });
});

describe('lining the periods up', () => {
  it('keeps the current rows in order and finds each one in the comparison by key', () => {
    const p = pair(
      [row('a', 'A', { sales: 5 }), row('b', 'B')],
      [row('b', 'B', { sales: 9 }), row('z', 'Z')],
    );
    expect(p.map((x) => x.key)).toEqual(['a', 'b']);
    expect(p[0]?.prev).toBeUndefined();
    expect(p[1]?.prev?.sales).toBe(9);
  });
});

describe('where a row leads', () => {
  it('opens a product, and a customer or supplier only when it is a real record', () => {
    expect(linkFor('product', 'prod_1')).toBe('/admin/products/prod_1');
    expect(linkFor('customer', '0711')).toBeNull();
    expect(linkFor('customer', '4bde6e2c-3ad0-4a4d-9d8e-2f6b1d3a0e11')).toBe(
      '/admin/customers/4bde6e2c-3ad0-4a4d-9d8e-2f6b1d3a0e11',
    );
    expect(linkFor('vendor', 'none')).toBeNull();
    expect(linkFor('branch', 'x')).toBeNull();
  });

  it('writes the local day of an instant, not the day in Greenwich', () => {
    // 23:30 in Greenwich is already the next day in Nairobi.
    expect(dateOfInstant('2026-03-10T23:30:00Z', 'Africa/Nairobi')).toBe('11 Mar 2026');
  });
});

describe('an item report', () => {
  const current = [
    row('p1', 'Soap', { sales: 400, units: 4, orders: 2, cost: 200, knownSales: 400 }),
    row('p2', 'Milk', { sales: 250, units: 3, orders: 2, cost: 20, knownSales: 50 }),
  ];
  const previous = [row('p1', 'Soap', { sales: 200, units: 2 })];
  const build = (seesCost: boolean, rows = current) =>
    buildCutReport({
      facts,
      seesCost,
      entity: 'Product',
      cut: 'product',
      basis: 'items',
      current: rows,
      previous,
      totals,
      truncated: false,
      title: 'Sales by product',
    });

  it('shares sales out, compares with the period before and totals the table', () => {
    const r = build(true);
    const names = r.table.columns.map((c) => c.label);
    const share = names.indexOf('Share of sales');
    const change = names.indexOf('Change on comparison');
    expect(r.table.rows[0]?.[share]).toBe(61.5);
    expect(r.table.rows[0]?.[change]).toBe(100);
    expect(r.table.rows[1]?.[change]).toBeNull();
    expect(r.table.totals?.[names.indexOf('Sales (KES)')]).toBe(650);
  });

  it('adds margin only where cost is known and leaves out what is not known', () => {
    const r = build(true);
    const names = r.table.columns.map((c) => c.label);
    expect(r.table.rows[0]?.[names.indexOf('Margin (KES)')]).toBe(200);
    expect(r.table.rows[1]?.[names.indexOf('Margin (KES)')]).toBe(30);
    // 600 of known sales and 220 of cost: 63.3% overall.
    expect(r.kpis.find((k) => k.key === 'margin')?.value).toBe(51.1);
  });

  it('shows no cost, margin or margin percent to someone without the cost permission', () => {
    const r = build(false);
    expect(r.table.columns.map((c) => c.label).filter((l) => /Cost|Margin/.test(l))).toEqual([]);
    expect(r.kpis.map((k) => k.key)).not.toContain('margin');
  });

  it('adds up to the overview through the adjustments, tax and delivery', () => {
    const r = build(false);
    expect(r.reconciliation.map((l) => l.value)).toEqual([650, 350, 160, 40, 1200]);
    expect(r.reconciliation.slice(0, 4).reduce((a, l) => a + l.value, 0)).toBe(1200);
    expect(r.reconciliation.at(-1)?.strong).toBe(true);
  });

  it('gives every row a link to its product and a chart of the biggest', () => {
    const r = build(false);
    expect(r.rowLinks).toEqual(['/admin/products/p1', '/admin/products/p2']);
    const chart = r.charts[0];
    expect(chart?.kind).toBe('ranked');
    expect(chart?.kind === 'ranked' ? chart.items[0]?.label : '').toBe('Soap');
  });

  it('copes with no sales at all', () => {
    const r = build(true, []);
    expect(r.table.rows).toEqual([]);
    expect(r.kpis.find((k) => k.key === 'sales')?.value).toBe(0);
    expect(r.kpis.find((k) => k.key === 'margin')?.value).toBeNull();
  });
});

describe('an order report', () => {
  it('has no reconciliation, because its total is the overview', () => {
    const r = buildCutReport({
      facts,
      seesCost: false,
      entity: 'Branch',
      cut: 'branch',
      basis: 'orders',
      current: [row('b1', 'Nairobi', { sales: 1200, orders: 4 })],
      previous: [],
      totals,
      truncated: false,
      donut: true,
      title: 'Sales by branch',
    });
    expect(r.reconciliation).toEqual([]);
    expect(r.table.totals?.[r.table.columns.map((c) => c.label).indexOf('Sales (KES)')]).toBe(1200);
    expect(r.rowLinks).toEqual([null]);
  });

  it('says so when it was cut at the limit', () => {
    const r = buildCutReport({
      facts,
      seesCost: false,
      entity: 'Customer',
      cut: 'customer',
      basis: 'orders',
      current: [row('c1', 'A', { sales: 5, orders: 1 })],
      previous: [],
      totals,
      truncated: true,
      title: 'Sales by customer',
    });
    expect(r.truncated).toBe(true);
    expect(r.notes.some((n) => n.includes('Only the biggest rows'))).toBe(true);
  });
});

describe('sales over time', () => {
  const days = ['2026-03-01', '2026-03-02', '2026-03-03'];
  const previousDays = ['2026-02-26', '2026-02-27', '2026-02-28'];
  const current = [
    row('2026-03-01', '', { sales: 100, orders: 1 }),
    row('2026-03-03', '', { sales: 300, orders: 3 }),
  ];
  const previous = [row('2026-02-26', '', { sales: 50, orders: 1 })];

  it('fills every day, lines each up with its counterpart and charts both periods', () => {
    const r = buildTimeReport({
      facts,
      seesCost: false,
      by: 'day',
      days,
      previousDays,
      current,
      previous,
      totals,
      title: 'Sales summary',
    });
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[1]?.[2]).toBe(0);
    expect(r.table.rows[0]?.[5]).toBe(100);
    const chart = r.charts[0];
    expect(chart?.kind === 'line' ? chart.series.map((s) => s.label) : []).toEqual([
      'This period',
      'Comparison',
    ]);
    expect(chart?.kind === 'line' ? chart.series[0]?.values : []).toEqual([100, 0, 300]);
  });

  it('shows the busiest hour and writes hours as clock times', () => {
    const r = buildTimeReport({
      facts,
      seesCost: false,
      by: 'hour',
      days,
      previousDays,
      current: [
        row('14', '14', { sales: 500, orders: 2 }),
        row('10', '10', { sales: 100, orders: 1 }),
      ],
      previous: [],
      totals,
      title: 'Sales by hour',
    });
    expect(r.table.rows).toHaveLength(24);
    expect(r.table.rows[14]?.[0]).toBe('14:00');
    expect(r.kpis.find((k) => k.key === 'best')?.note).toBe('14:00');
  });

  it('names the weekdays', () => {
    const r = buildTimeReport({
      facts,
      seesCost: false,
      by: 'weekday',
      days,
      previousDays,
      current: [row('2', '2', { sales: 10, orders: 1 })],
      previous: [],
      totals,
      title: 'Sales by weekday',
    });
    expect(r.table.rows.map((x) => x[0])).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
  });
});

describe('returning customers', () => {
  const mix = (over: Partial<CustomerMix>): CustomerMix => ({
    newCustomers: 0,
    returningCustomers: 0,
    newSales: 0,
    returningSales: 0,
    walkInOrders: 0,
    walkInSales: 0,
    repeatBuyers: 0,
    medianDaysBetween: null,
    ...over,
  });

  it('shares customers into new and returning and sets walk-ins apart', () => {
    const r = buildCustomerMixReport({
      facts,
      title: 'Returning customers',
      current: mix({
        newCustomers: 1,
        returningCustomers: 3,
        newSales: 100,
        returningSales: 600,
        walkInOrders: 2,
        walkInSales: 50,
        repeatBuyers: 2,
        medianDaysBetween: 4.25,
      }),
      previous: mix({ newCustomers: 2, returningCustomers: 2 }),
    });
    expect(r.kpis.find((k) => k.key === 'rate')?.value).toBe(75);
    expect(r.kpis.find((k) => k.key === 'rate')?.previous).toBe(50);
    expect(r.kpis.find((k) => k.key === 'gap')?.value).toBe(4.3);
    expect(r.table.rows.map((x) => x[0])).toEqual([
      'Returning customers',
      'New customers',
      'Walk-in orders (no customer named)',
    ]);
    expect(r.table.totals?.[2]).toBe(750);
  });

  it('has no rate when no one bought', () => {
    const r = buildCustomerMixReport({ facts, title: 't', current: mix({}), previous: mix({}) });
    expect(r.kpis.find((k) => k.key === 'rate')?.value).toBeNull();
    expect(r.kpis.map((k) => k.key)).not.toContain('gap');
  });
});

describe('sales returns', () => {
  it('shares the value returned by product and reason against sales', () => {
    const byProduct: ReturnRow[] = [
      { key: 'p1', label: 'Soap', amount: 300, quantity: 3, notes: 2 },
      { key: 'p2', label: 'Milk', amount: 100, quantity: 1, notes: 1 },
    ];
    const byReason: ReturnRow[] = [
      { key: 'damaged', label: 'damaged', amount: 300, quantity: 0, notes: 2 },
      { key: 'wrong_item', label: 'wrong_item', amount: 100, quantity: 0, notes: 1 },
    ];
    const r = buildReturnsReport({
      facts,
      byProduct,
      byReason,
      previousTotal: 200,
      sales: 4000,
      title: 'Sales returns',
    });
    expect(r.kpis.find((k) => k.key === 'value')?.value).toBe(400);
    expect(r.kpis.find((k) => k.key === 'rate')?.value).toBe(10);
    expect(r.table.rows[0]?.[4]).toBe(75);
    expect(r.rowLinks[0]).toBe('/admin/products/p1');
  });
});
