import { formatLocalDate } from '@/lib/reports/format';
import type { Unit } from '@/lib/reports/units';
import type { ExportColumn, ExportTable } from '../export/table';
import type { CustomerMix, CutRow, OrderTotals, ReturnRow } from './sales-queries';
import type { AnalysisReport, ChartSpec, Kpi, ReportFacts, RowLinks } from './types';

/**
 * Pure builders: rows from the database in, a report out. No reads, no clock, no permissions here (the executor decided
 * those), so every rule below is tested with plain numbers.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function changePct(current: number, previous: number): number | null {
  return previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : null;
}

const share = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);

const money = (currency: string): Unit => ({ kind: 'money', currency });
const COUNT: Unit = { kind: 'count' };
const PERCENT: Unit = { kind: 'percent' };

/** The local calendar day of an instant, written for people (15 Oct 2026). */
export function dateOfInstant(iso: string, timeZone: string): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return formatLocalDate(ymd);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a row of a cut leads: the thing it names, when it names one that has a page. */
export function linkFor(cut: string, key: string): string | null {
  if (cut === 'product' && key !== '') return `/admin/products/${encodeURIComponent(key)}`;
  if ((cut === 'customer' || cut === 'vendor') && UUID.test(key)) {
    return cut === 'customer' ? `/admin/customers/${key}` : `/admin/vendors/${key}`;
  }
  return null;
}

interface Pair {
  key: string;
  cur: CutRow;
  prev: CutRow | undefined;
}

/** The current and the comparison rows of one cut lined up by key; a key present in either appears. */
export function pair(current: readonly CutRow[], previous: readonly CutRow[]): Pair[] {
  const prev = new Map(previous.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const out: Pair[] = [];
  for (const cur of current) {
    seen.add(cur.key);
    out.push({ key: cur.key, cur, prev: prev.get(cur.key) });
  }
  return out;
}

const sum = (rows: readonly CutRow[], pick: (r: CutRow) => number): number =>
  rows.reduce((a, r) => a + pick(r), 0);

/** The ranked, tabled and charted view of one item or order cut (product, category, vendor, branch, customer). */
export interface CutReportInput {
  facts: ReportFacts;
  seesCost: boolean;
  /** What a row is called in the headings: "Product", "Category", ... */
  entity: string;
  cut: 'product' | 'category' | 'vendor' | 'branch' | 'customer';
  basis: 'items' | 'orders';
  current: readonly CutRow[];
  previous: readonly CutRow[];
  totals: OrderTotals;
  /** Whether the lists were cut at the limit. */
  truncated: boolean;
  /** Draw a donut of shares as well (for a short list of parts of a whole). */
  donut?: boolean;
  /** Sort the table by margin instead of by sales. */
  byMargin?: boolean;
  title: string;
}

function marginOf(r: CutRow): number | null {
  return r.knownSales > 0 ? round2(r.knownSales - r.cost) : null;
}

function marginPct(r: CutRow): number | null {
  return r.knownSales > 0
    ? Number((((r.knownSales - r.cost) / r.knownSales) * 100).toFixed(1))
    : null;
}

export function buildCutReport(input: CutReportInput): AnalysisReport {
  const { facts, seesCost, entity, cut, basis, totals, title } = input;
  const cur = facts.baseCurrency;
  const sales = sum(input.current, (r) => r.sales);
  const prevSales = sum(input.previous, (r) => r.sales);
  const orders = basis === 'orders' ? sum(input.current, (r) => r.orders) : totals.orders;
  const units = sum(input.current, (r) => r.units);
  const prevUnits = sum(input.previous, (r) => r.units);

  let pairs = pair(input.current, input.previous);
  if (input.byMargin === true) {
    pairs = [...pairs].sort(
      (a, b) => (marginOf(b.cur) ?? -Infinity) - (marginOf(a.cur) ?? -Infinity),
    );
  }

  const columns: ExportColumn[] = [{ label: entity, kind: 'text' }];
  if (units > 0) columns.push({ label: 'Units', kind: 'count' });
  columns.push({ label: 'Orders', kind: 'count' }, { label: `Sales (${cur})`, kind: 'money' });
  columns.push(
    { label: 'Share of sales', kind: 'percent' },
    { label: 'Change on comparison', kind: 'percent' },
  );
  if (basis === 'items' && units > 0)
    columns.push({ label: `Average price (${cur})`, kind: 'money' });
  if (cut === 'customer') {
    columns.push({ label: 'First order', kind: 'date' }, { label: 'Last order', kind: 'date' });
  }
  if (seesCost) {
    columns.push(
      { label: `Cost (${cur})`, kind: 'money' },
      { label: `Margin (${cur})`, kind: 'money' },
      { label: 'Margin %', kind: 'percent' },
    );
  }

  const cell = (v: number | string | null) => v;
  const rows = pairs.map((p) => {
    const r = p.cur;
    const line: (string | number | null)[] = [r.label];
    if (units > 0) line.push(round2(r.units));
    line.push(r.orders, round2(r.sales), Number(share(r.sales, sales).toFixed(1)));
    line.push(p.prev === undefined ? null : changePct(r.sales, p.prev.sales));
    if (basis === 'items' && units > 0) line.push(r.units > 0 ? round2(r.sales / r.units) : null);
    if (cut === 'customer') {
      line.push(
        r.firstAt === null ? null : dateOfInstant(r.firstAt, facts.timeZone),
        r.lastAt === null ? null : dateOfInstant(r.lastAt, facts.timeZone),
      );
    }
    if (seesCost)
      line.push(cell(r.knownSales > 0 ? round2(r.cost) : null), marginOf(r), marginPct(r));
    return line;
  });

  const totalsRow: (string | number | null)[] = ['Total'];
  if (units > 0) totalsRow.push(round2(units));
  totalsRow.push(
    basis === 'orders' ? orders : null,
    round2(sales),
    100,
    changePct(sales, prevSales),
  );
  if (basis === 'items' && units > 0) totalsRow.push(units > 0 ? round2(sales / units) : null);
  if (cut === 'customer') totalsRow.push(null, null);
  if (seesCost) {
    const knownSales = sum(input.current, (r) => r.knownSales);
    const cost = sum(input.current, (r) => r.cost);
    totalsRow.push(
      knownSales > 0 ? round2(cost) : null,
      knownSales > 0 ? round2(knownSales - cost) : null,
      knownSales > 0 ? Number((((knownSales - cost) / knownSales) * 100).toFixed(1)) : null,
    );
  }

  const table: ExportTable = { title, columns, rows, totals: totalsRow };
  const rowLinks: RowLinks = pairs.map((p) => linkFor(cut, p.key));

  const kpis: Kpi[] = [
    {
      key: 'sales',
      label: basis === 'items' ? 'Item sales' : 'Sales',
      value: round2(sales),
      unit: money(cur),
      previous: round2(prevSales),
      upIsGood: true,
    },
    {
      key: 'orders',
      label: 'Orders',
      value: orders,
      unit: COUNT,
      previous: basis === 'orders' ? sum(input.previous, (r) => r.orders) : null,
      upIsGood: true,
    },
  ];
  if (units > 0)
    kpis.push({
      key: 'units',
      label: 'Units sold',
      value: round2(units),
      unit: COUNT,
      previous: round2(prevUnits),
      upIsGood: true,
    });
  kpis.push({
    key: 'rows',
    label: `${entity}s with sales`,
    value: input.current.length,
    unit: COUNT,
    previous: input.previous.length,
    upIsGood: true,
  });
  const top = input.current[0];
  if (top !== undefined && sales > 0) {
    kpis.push({
      key: 'top',
      label: `Top ${entity.toLowerCase()}`,
      value: Number(share(top.sales, sales).toFixed(1)),
      unit: PERCENT,
      note: top.label,
    });
  }
  if (seesCost) {
    const known = sum(input.current, (r) => r.knownSales);
    const cost = sum(input.current, (r) => r.cost);
    const prevKnown = sum(input.previous, (r) => r.knownSales);
    const prevCost = sum(input.previous, (r) => r.cost);
    kpis.push({
      key: 'margin',
      label: 'Gross margin',
      value: known > 0 ? Number((((known - cost) / known) * 100).toFixed(1)) : null,
      unit: PERCENT,
      previous:
        prevKnown > 0 ? Number((((prevKnown - prevCost) / prevKnown) * 100).toFixed(1)) : null,
      upIsGood: true,
    });
  }

  const charts: ChartSpec[] = [
    {
      kind: 'ranked',
      title: `Top ${entity.toLowerCase()}s by sales`,
      unit: money(cur),
      items: pairs.slice(0, 10).map((p) => {
        const r = p.cur;
        const href = linkFor(cut, p.key);
        return {
          key: p.key,
          label: r.label,
          value: round2(r.sales),
          note: units > 0 ? `${String(Math.round(r.units))} units` : `${String(r.orders)} orders`,
          changePct: p.prev === undefined ? null : changePct(r.sales, p.prev.sales),
          ...(href === null ? {} : { href }),
        };
      }),
    },
  ];
  if (input.donut === true && input.current.length > 1) {
    charts.push({
      kind: 'donut',
      title: `Share of sales by ${entity.toLowerCase()}`,
      unit: money(cur),
      centerLabel: 'sales',
      items: input.current
        .slice(0, 12)
        .map((r) => ({ key: r.key, label: r.label, value: round2(r.sales) })),
    });
  }

  const reconciliation =
    basis === 'items'
      ? [
          { label: 'Items listed in this report', value: round2(sales) },
          {
            label: 'Order-level discounts, rounding and free gifts',
            value: round2(totals.items - sales),
          },
          { label: 'Tax charged', value: round2(totals.tax) },
          { label: 'Delivery charged', value: round2(totals.delivery) },
          { label: 'Sales on the Business Overview', value: round2(totals.total), strong: true },
        ]
      : [];

  const notes = [
    'A sale is an order that was not cancelled, failed or refunded, and that was paid or placed on credit terms: the same rule as the Business Overview.',
    basis === 'items'
      ? 'Item sales are the value of the lines sold before tax and delivery, so this report adds up to the overview only once tax and delivery are added (see below).'
      : 'Sales are the order totals, including tax and delivery, so they add up to the overview exactly.',
  ];
  if (seesCost)
    notes.push(
      'Margin uses only the lines whose cost was known when they were sold; a line with no cost is left out of the margin, not counted as free.',
    );
  if (input.truncated)
    notes.push('Only the biggest rows are shown. Narrow the period or the branch to see the rest.');

  return {
    kind: 'analysis',
    facts,
    kpis,
    charts,
    table,
    rowLinks,
    reconciliation,
    notes,
    truncated: input.truncated,
  };
}

// ---------------- sales over time ----------------

const TIME_HEADING = { day: 'Day', weekday: 'Weekday', hour: 'Hour' } as const;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface TimeReportInput {
  facts: ReportFacts;
  seesCost: boolean;
  by: 'day' | 'weekday' | 'hour';
  /** The days of the period and of the comparison, oldest first, for zero-filled trends. */
  days: readonly string[];
  previousDays: readonly string[];
  current: readonly CutRow[];
  previous: readonly CutRow[];
  totals: OrderTotals;
  title: string;
}

export function buildTimeReport(input: TimeReportInput): AnalysisReport {
  const { facts, by, totals, title } = input;
  const cur = facts.baseCurrency;
  const sales = sum(input.current, (r) => r.sales);
  const prevSales = sum(input.previous, (r) => r.sales);
  const orders = sum(input.current, (r) => r.orders);
  const prevOrders = sum(input.previous, (r) => r.orders);
  const units = sum(input.current, (r) => r.units);
  const byKey = new Map(input.current.map((r) => [r.key, r]));
  const prevByKey = new Map(input.previous.map((r) => [r.key, r]));

  let keys: string[];
  let labelOf: (k: string) => string;
  if (by === 'day') {
    keys = [...input.days];
    labelOf = (k) => formatLocalDate(k);
  } else if (by === 'weekday') {
    keys = ['1', '2', '3', '4', '5', '6', '7'];
    labelOf = (k) => WEEKDAYS[Number(k) - 1] ?? k;
  } else {
    keys = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    labelOf = (k) => `${k}:00`;
  }

  const columns: ExportColumn[] = [
    { label: TIME_HEADING[by], kind: 'text' },
    { label: 'Orders', kind: 'count' },
    { label: `Sales (${cur})`, kind: 'money' },
    { label: `Average order (${cur})`, kind: 'money' },
    { label: 'Share of sales', kind: 'percent' },
    { label: 'Change on comparison', kind: 'percent' },
  ];

  const rows = keys.map((k, i) => {
    const r = byKey.get(k);
    const prevKey = by === 'day' ? input.previousDays[i] : k;
    const p = prevKey === undefined ? undefined : prevByKey.get(prevKey);
    const s = r?.sales ?? 0;
    const o = r?.orders ?? 0;
    return [
      labelOf(k),
      o,
      round2(s),
      o > 0 ? round2(s / o) : null,
      Number(share(s, sales).toFixed(1)),
      p === undefined ? null : changePct(s, p.sales),
    ];
  });

  const bestKey = keys.reduce(
    (best, k) => ((byKey.get(k)?.sales ?? 0) > (byKey.get(best)?.sales ?? 0) ? k : best),
    keys[0] ?? '',
  );
  const kpis: Kpi[] = [
    {
      key: 'sales',
      label: 'Sales',
      value: round2(sales),
      unit: money(cur),
      previous: round2(prevSales),
      upIsGood: true,
    },
    {
      key: 'orders',
      label: 'Orders',
      value: orders,
      unit: COUNT,
      previous: prevOrders,
      upIsGood: true,
    },
    {
      key: 'avg',
      label: 'Average order',
      value: orders > 0 ? round2(sales / orders) : null,
      unit: money(cur),
      previous: prevOrders > 0 ? round2(prevSales / prevOrders) : null,
      upIsGood: true,
    },
    {
      key: 'tax',
      label: 'Tax charged',
      value: round2(totals.tax),
      unit: money(cur),
      upIsGood: true,
    },
  ];
  if (units > 0)
    kpis.push({ key: 'units', label: 'Units sold', value: round2(units), unit: COUNT });
  if (by !== 'day' && sales > 0) {
    kpis.push({
      key: 'best',
      label: by === 'weekday' ? 'Busiest weekday' : 'Busiest hour',
      value: Number(share(byKey.get(bestKey)?.sales ?? 0, sales).toFixed(1)),
      unit: PERCENT,
      note: labelOf(bestKey),
    });
  }

  const charts: ChartSpec[] =
    by === 'day'
      ? [
          {
            kind: 'line',
            title: 'Sales per day',
            categories: keys.map(labelOf),
            unit: money(cur),
            series: [
              {
                key: 'now',
                label: 'This period',
                values: keys.map((k) => round2(byKey.get(k)?.sales ?? 0)),
              },
              {
                key: 'before',
                label: 'Comparison',
                dashed: true,
                values: keys.map((_, i) => {
                  const pk = input.previousDays[i];
                  return pk === undefined ? null : round2(prevByKey.get(pk)?.sales ?? 0);
                }),
              },
            ],
          },
        ]
      : [
          {
            kind: 'bars',
            title: by === 'weekday' ? 'Sales by weekday' : 'Sales by hour of the day',
            categories: keys.map(labelOf),
            unit: money(cur),
            series: [
              {
                key: 'now',
                label: 'Sales',
                values: keys.map((k) => round2(byKey.get(k)?.sales ?? 0)),
              },
            ],
          },
        ];

  return {
    kind: 'analysis',
    facts,
    kpis,
    charts,
    table: {
      title,
      columns,
      rows,
      totals: [
        'Total',
        orders,
        round2(sales),
        orders > 0 ? round2(sales / orders) : null,
        100,
        changePct(sales, prevSales),
      ],
    },
    rowLinks: rows.map(() => null),
    reconciliation: [
      { label: 'Items before tax and delivery', value: round2(totals.items) },
      { label: 'Tax charged', value: round2(totals.tax) },
      { label: 'Delivery charged', value: round2(totals.delivery) },
      { label: 'Sales on the Business Overview', value: round2(totals.total), strong: true },
    ],
    notes: [
      'A sale is an order that was not cancelled, failed or refunded, and that was paid or placed on credit terms: the same rule as the Business Overview.',
      by === 'day'
        ? 'Each day is compared with the day in the same position of the comparison period.'
        : 'Times are in the business time zone. A busy hour here is where staff are needed.',
    ],
    truncated: false,
  };
}

// ---------------- returning customers ----------------

export function buildCustomerMixReport(input: {
  facts: ReportFacts;
  current: CustomerMix;
  previous: CustomerMix;
  title: string;
}): AnalysisReport {
  const { facts, current: c, previous: p, title } = input;
  const cur = facts.baseCurrency;
  const people = c.newCustomers + c.returningCustomers;
  const prevPeople = p.newCustomers + p.returningCustomers;
  const returningRate = people > 0 ? Number(share(c.returningCustomers, people).toFixed(1)) : null;
  const prevRate =
    prevPeople > 0 ? Number(share(p.returningCustomers, prevPeople).toFixed(1)) : null;
  const named = c.newSales + c.returningSales;

  const kpis: Kpi[] = [
    {
      key: 'customers',
      label: 'Customers who bought',
      value: people,
      unit: COUNT,
      previous: prevPeople,
      upIsGood: true,
    },
    {
      key: 'returning',
      label: 'Returning customers',
      value: c.returningCustomers,
      unit: COUNT,
      previous: p.returningCustomers,
      upIsGood: true,
    },
    {
      key: 'rate',
      label: 'Returning share',
      value: returningRate,
      unit: PERCENT,
      previous: prevRate,
      upIsGood: true,
      note: 'Of customers who bought in the period, the share who had bought before it',
    },
    {
      key: 'new',
      label: 'New customers',
      value: c.newCustomers,
      unit: COUNT,
      previous: p.newCustomers,
      upIsGood: true,
    },
    {
      key: 'repeat',
      label: 'Bought more than once',
      value: c.repeatBuyers,
      unit: COUNT,
      previous: p.repeatBuyers,
      upIsGood: true,
    },
  ];
  if (c.medianDaysBetween !== null) {
    kpis.push({
      key: 'gap',
      label: 'Typical days between orders',
      value: Number(c.medianDaysBetween.toFixed(1)),
      unit: COUNT,
      previous: p.medianDaysBetween === null ? null : Number(p.medianDaysBetween.toFixed(1)),
      upIsGood: false,
    });
  }

  const segments = [
    {
      key: 'returning',
      label: 'Returning customers',
      n: c.returningCustomers,
      sales: c.returningSales,
      prev: p.returningSales,
    },
    { key: 'new', label: 'New customers', n: c.newCustomers, sales: c.newSales, prev: p.newSales },
    {
      key: 'walkin',
      label: 'Walk-in orders (no customer named)',
      n: c.walkInOrders,
      sales: c.walkInSales,
      prev: p.walkInSales,
    },
  ];
  const total = named + c.walkInSales;
  const table: ExportTable = {
    title,
    columns: [
      { label: 'Who', kind: 'text' },
      { label: 'Customers or orders', kind: 'count' },
      { label: `Sales (${cur})`, kind: 'money' },
      { label: 'Share of sales', kind: 'percent' },
      { label: 'Change on comparison', kind: 'percent' },
      { label: `Average per customer (${cur})`, kind: 'money' },
    ],
    rows: segments.map((s) => [
      s.label,
      s.n,
      round2(s.sales),
      Number(share(s.sales, total).toFixed(1)),
      changePct(s.sales, s.prev),
      s.n > 0 ? round2(s.sales / s.n) : null,
    ]),
    totals: [
      'Total',
      null,
      round2(total),
      100,
      changePct(total, p.newSales + p.returningSales + p.walkInSales),
      null,
    ],
  };

  return {
    kind: 'analysis',
    facts,
    kpis,
    charts: [
      {
        kind: 'donut',
        title: 'Where sales come from',
        unit: money(cur),
        centerLabel: 'sales',
        items: segments
          .filter((s) => s.sales > 0)
          .map((s) => ({ key: s.key, label: s.label, value: round2(s.sales) })),
      },
    ],
    table,
    rowLinks: segments.map(() => null),
    reconciliation: [],
    notes: [
      'A customer is whoever the order names: a trade customer, a signed-in shopper, a phone number or an email. An order that names none is a walk-in and is counted apart, never as a person.',
      'A customer is new when their first sale ever falls inside the period, and returning when they bought before it.',
      'The same person buying under a different phone number or email counts as two people. Naming the customer at the till keeps this report accurate.',
    ],
    truncated: false,
  };
}

// ---------------- returns ----------------

export function buildReturnsReport(input: {
  facts: ReportFacts;
  byProduct: readonly ReturnRow[];
  byReason: readonly ReturnRow[];
  previousTotal: number;
  sales: number;
  title: string;
}): AnalysisReport {
  const { facts, title } = input;
  const cur = facts.baseCurrency;
  const total = sum2(input.byReason.length > 0 ? input.byReason : input.byProduct, (r) => r.amount);
  const notes = sum2(input.byReason, (r) => r.notes);
  const table: ExportTable = {
    title,
    columns: [
      { label: 'Product', kind: 'text' },
      { label: 'Units returned', kind: 'count' },
      { label: 'Credit notes', kind: 'count' },
      { label: `Value returned (${cur})`, kind: 'money' },
      { label: 'Share of returns', kind: 'percent' },
    ],
    rows: input.byProduct.map((r) => [
      r.label,
      round2(r.quantity),
      r.notes,
      round2(r.amount),
      Number(share(r.amount, total).toFixed(1)),
    ]),
    totals: ['Total', round2(sum2(input.byProduct, (r) => r.quantity)), notes, round2(total), 100],
  };
  return {
    kind: 'analysis',
    facts,
    kpis: [
      {
        key: 'value',
        label: 'Value returned',
        value: round2(total),
        unit: money(cur),
        previous: round2(input.previousTotal),
        upIsGood: false,
      },
      { key: 'notes', label: 'Credit notes', value: notes, unit: COUNT, upIsGood: false },
      {
        key: 'rate',
        label: 'Returns as a share of sales',
        value: input.sales > 0 ? Number(share(total, input.sales).toFixed(1)) : null,
        unit: PERCENT,
        upIsGood: false,
      },
    ],
    charts: [
      {
        kind: 'ranked',
        title: 'Why goods come back',
        unit: money(cur),
        items: input.byReason.slice(0, 10).map((r) => ({
          key: r.key,
          label: r.label,
          value: round2(r.amount),
          note: `${String(r.notes)} credit notes`,
        })),
      },
    ],
    table,
    rowLinks: input.byProduct.map((r) => linkFor('product', r.key)),
    reconciliation: [],
    notes: [
      'Returns are the credit notes issued in the period, by the date they were issued, not the date of the original sale.',
      'The share of sales compares the value returned with sales in the same period; a long-ago sale can be returned in this one.',
    ],
    truncated: false,
  };
}

function sum2<T>(rows: readonly T[], pick: (r: T) => number): number {
  return rows.reduce((a, r) => a + pick(r), 0);
}
