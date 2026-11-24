import { formatLocalDate } from '@/lib/reports/format';
import type { ExportColumn } from '../export/table';
import { dateOfInstant, linkFor } from './sales-reports';
import type { LocationValue, MovementRow, StockRow } from './inventory-queries';
import type { AnalysisReport, ChartSpec, Kpi, ReportFacts } from './types';

/**
 * Pure builders for the stock reports: rows in, a report out. A product with no recorded cost has an unknown value, which is
 * kept apart from a value of zero: it is counted and named, never silently valued at nothing.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;
const COUNT = { kind: 'count' } as const;
const money = (currency: string) => ({ kind: 'money', currency }) as const;

const valueOf = (r: StockRow): number | null =>
  r.cost === null ? null : Math.max(r.onHand, 0) * r.cost;
const sumValue = (rows: readonly StockRow[]): number =>
  rows.reduce((a, r) => a + (valueOf(r) ?? 0), 0);

const NOTE_NOW = 'Stock and cost are as they are right now, for every location together.';

// ---------------- stock valuation ----------------

export function buildStockValuation(input: {
  facts: ReportFacts;
  rows: readonly StockRow[];
  /** Every stocked product's value according to the Business Overview, to prove the list adds up. */
  overviewValue: number;
  locations: readonly LocationValue[];
  truncated: boolean;
  title: string;
}): AnalysisReport {
  const { facts, rows, title } = input;
  const cur = facts.baseCurrency;
  const listed = round2(sumValue(rows));
  const units = rows.reduce((a, r) => a + Math.max(r.onHand, 0), 0);
  const noCost = rows.filter((r) => r.cost === null && r.onHand > 0).length;

  const columns: ExportColumn[] = [
    { label: 'Product', kind: 'text' },
    { label: 'Category', kind: 'text' },
    { label: 'On hand', kind: 'count' },
    { label: `Cost each (${cur})`, kind: 'money' },
    { label: `Stock value (${cur})`, kind: 'money' },
    { label: 'Share of value', kind: 'percent' },
  ];
  const tableRows = rows.map((r) => {
    const v = valueOf(r);
    return [
      r.name,
      r.category,
      round2(r.onHand),
      r.cost === null ? null : round2(r.cost),
      v === null ? null : round2(v),
      v === null || listed <= 0 ? null : Number(((v / listed) * 100).toFixed(1)),
    ];
  });

  const byCategory = new Map<string, number>();
  for (const r of rows)
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + (valueOf(r) ?? 0));
  const charts: ChartSpec[] = [
    {
      kind: 'donut',
      title: 'Stock value by category',
      unit: money(cur),
      centerLabel: 'at cost',
      items: [...byCategory.entries()]
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([label, value]) => ({ key: label, label, value: round2(value) })),
    },
  ];
  if (input.locations.length > 0) {
    charts.push({
      kind: 'ranked',
      title: 'Stock value by location',
      unit: money(cur),
      items: input.locations.slice(0, 10).map((l) => ({
        key: l.id,
        label: l.name,
        value: round2(l.value),
        note: `${String(Math.round(l.units))} units · ${l.kind}`,
      })),
    });
  }

  const kpis: Kpi[] = [
    {
      key: 'value',
      label: 'Stock value at cost',
      value: round2(input.overviewValue),
      unit: money(cur),
    },
    { key: 'units', label: 'Units on hand', value: round2(units), unit: COUNT },
    { key: 'products', label: 'Products stocked', value: rows.length, unit: COUNT },
    {
      key: 'nocost',
      label: 'In stock with no cost recorded',
      value: noCost,
      unit: COUNT,
      upIsGood: false,
      note: 'Their value is unknown, not zero',
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
      rows: tableRows,
      totals: ['Total', null, round2(units), null, listed, 100],
    },
    rowLinks: rows.map((r) => linkFor('product', r.id)),
    reconciliation: [
      { label: 'Products listed in this report', value: listed },
      {
        label: 'Products not listed (beyond the biggest 500)',
        value: round2(input.overviewValue - listed),
      },
      {
        label: 'Stock value on the Business Overview',
        value: round2(input.overviewValue),
        strong: true,
      },
    ],
    notes: [
      NOTE_NOW,
      'Value is the quantity on hand times the product cost recorded today. A product with no cost recorded is counted but not valued.',
      'Only products that hold stock are listed: a service or a non-stock item is never in stock.',
      ...(input.truncated ? ['Only the 500 products with the most stock value are listed.'] : []),
    ],
    truncated: input.truncated,
  };
}

// ---------------- low and out of stock ----------------

export function daysOfCover(r: StockRow): number | null {
  if (r.available <= 0) return 0;
  if (r.soldRecently <= 0) return null;
  return Number((r.available / (r.soldRecently / 30)).toFixed(1));
}

export function buildLowStock(input: {
  facts: ReportFacts;
  rows: readonly StockRow[];
  truncated: boolean;
  title: string;
}): AnalysisReport {
  const { facts, title } = input;
  const status = (r: StockRow): string => (r.available <= 0 ? 'Out of stock' : 'Low');
  // Out of stock first; then the soonest to run out; items that are not selling sort last.
  const rows = [...input.rows].sort((a, b) => {
    const rank = (r: StockRow) => (r.available <= 0 ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ca = daysOfCover(a) ?? Number.POSITIVE_INFINITY;
    const cb = daysOfCover(b) ?? Number.POSITIVE_INFINITY;
    return ca === cb ? a.name.localeCompare(b.name) : ca - cb;
  });
  const out = rows.filter((r) => r.available <= 0).length;
  const low = rows.length - out;
  const sellingShort = rows.filter((r) => r.soldRecently > 0).length;

  const columns: ExportColumn[] = [
    { label: 'Product', kind: 'text' },
    { label: 'Category', kind: 'text' },
    { label: 'Status', kind: 'text' },
    { label: 'On hand', kind: 'count' },
    { label: 'Reserved', kind: 'count' },
    { label: 'Available', kind: 'count' },
    { label: 'Reorder level', kind: 'count' },
    { label: 'Sold in the last 30 days', kind: 'count' },
    { label: 'Days of cover', kind: 'count' },
  ];
  const tableRows = rows.map((r) => [
    r.name,
    r.category,
    status(r),
    round2(r.onHand),
    round2(r.reserved),
    round2(r.available),
    round2(r.reorderLevel),
    round2(r.soldRecently),
    daysOfCover(r),
  ]);

  const urgent = rows.filter((r) => r.soldRecently > 0).slice(0, 10);
  const kpis: Kpi[] = [
    { key: 'out', label: 'Out of stock', value: out, unit: COUNT, upIsGood: false },
    { key: 'low', label: 'Low stock', value: low, unit: COUNT, upIsGood: false },
    {
      key: 'selling',
      label: 'Short and selling',
      value: sellingShort,
      unit: COUNT,
      upIsGood: false,
      note: 'Sold in the last 30 days: reorder these first',
    },
  ];
  return {
    kind: 'analysis',
    facts,
    kpis,
    charts:
      urgent.length === 0
        ? []
        : [
            {
              kind: 'ranked',
              title: 'Running out soonest, among what is selling',
              unit: COUNT,
              items: urgent.map((r) => ({
                key: r.id,
                label: r.name,
                value: round2(r.soldRecently),
                note: `${String(round2(r.available))} available · ${
                  daysOfCover(r) === 0 ? 'out now' : `${String(daysOfCover(r))} days of cover`
                }`,
              })),
            },
          ],
    table: { title, columns, rows: tableRows },
    rowLinks: rows.map((r) => linkFor('product', r.id)),
    reconciliation: [],
    notes: [
      NOTE_NOW,
      "Available is on hand minus what is reserved for open orders. Low means available is at or below the product's reorder level; out means nothing is available.",
      'Days of cover is the available stock divided by the average daily sales of the last 30 days. A product that has not sold in that time has no figure, because there is nothing to run out of.',
      ...(input.truncated ? ['Only the first 500 are shown, the emptiest first.'] : []),
    ],
    truncated: input.truncated,
  };
}

// ---------------- slow and dead stock ----------------

export type Bucket = 'slow' | 'stale' | 'dead';

export function bucketOf(r: StockRow, now: Date): { bucket: Bucket; days: number | null } {
  if (r.lastSoldAt === null) return { bucket: 'dead', days: null };
  const days = Math.floor((now.getTime() - new Date(r.lastSoldAt).getTime()) / 86_400_000);
  if (days > 90) return { bucket: 'dead', days };
  if (days > 60) return { bucket: 'stale', days };
  return { bucket: 'slow', days };
}

const BUCKET_WORDS: Record<Bucket, string> = {
  slow: '30 to 60 days',
  stale: '60 to 90 days',
  dead: 'Over 90 days, or never sold',
};

export function buildSlowStock(input: {
  facts: ReportFacts;
  rows: readonly StockRow[];
  now: Date;
  totalStockValue: number;
  truncated: boolean;
  title: string;
}): AnalysisReport {
  const { facts, title, now } = input;
  const cur = facts.baseCurrency;
  const rows = input.rows.filter((r) => r.onHand > 0);
  const tag = rows.map((r) => ({ r, ...bucketOf(r, now) }));
  const value = (xs: typeof tag) => xs.reduce((a, x) => a + (valueOf(x.r) ?? 0), 0);
  const total = value(tag);
  const byBucket = (b: Bucket) => tag.filter((x) => x.bucket === b);

  const columns: ExportColumn[] = [
    { label: 'Product', kind: 'text' },
    { label: 'Category', kind: 'text' },
    { label: 'Not sold for', kind: 'text' },
    { label: 'On hand', kind: 'count' },
    { label: `Cost each (${cur})`, kind: 'money' },
    { label: `Cash tied up (${cur})`, kind: 'money' },
    { label: 'Last sold', kind: 'date' },
    { label: 'Sold in the last 90 days', kind: 'count' },
  ];
  const tableRows = tag.map(({ r, bucket }) => {
    const v = valueOf(r);
    return [
      r.name,
      r.category,
      BUCKET_WORDS[bucket],
      round2(r.onHand),
      r.cost === null ? null : round2(r.cost),
      v === null ? null : round2(v),
      r.lastSoldAt === null ? 'Never' : dateOfInstant(r.lastSoldAt, facts.timeZone),
      round2(r.unitsSold90),
    ];
  });

  const kpis: Kpi[] = [
    {
      key: 'tied',
      label: 'Cash tied up in slow stock',
      value: round2(total),
      unit: money(cur),
      upIsGood: false,
      note: 'Stock that has not sold in 30 days',
    },
    {
      key: 'dead',
      label: 'Dead stock',
      value: round2(value(byBucket('dead'))),
      unit: money(cur),
      upIsGood: false,
      note: 'Not sold for over 90 days, or never',
    },
    { key: 'products', label: 'Products', value: rows.length, unit: COUNT, upIsGood: false },
    {
      key: 'share',
      label: 'Share of all stock value',
      value:
        input.totalStockValue > 0
          ? Number(((total / input.totalStockValue) * 100).toFixed(1))
          : null,
      unit: { kind: 'percent' },
      upIsGood: false,
    },
  ];

  return {
    kind: 'analysis',
    facts,
    kpis,
    charts: [
      {
        kind: 'donut',
        title: 'Cash tied up, by how long it has not sold',
        unit: money(cur),
        centerLabel: 'tied up',
        items: (['slow', 'stale', 'dead'] as const)
          .map((b) => ({ key: b, label: BUCKET_WORDS[b], value: round2(value(byBucket(b))) }))
          .filter((i) => i.value > 0),
      },
    ],
    table: {
      title,
      columns,
      rows: tableRows,
      totals: [
        'Total',
        null,
        null,
        round2(rows.reduce((a, r) => a + r.onHand, 0)),
        null,
        round2(total),
        null,
        null,
      ],
    },
    rowLinks: rows.map((r) => linkFor('product', r.id)),
    reconciliation: [],
    notes: [
      NOTE_NOW,
      'Slow stock is stock on hand of a product that has not sold in the last 30 days. The last sale is the most recent sale of any kind, in any branch.',
      'A product with no cost recorded is listed but its cash tied up is unknown, not zero.',
      'Free gifts are not sales. A product that is only ever given away shows as not selling.',
      ...(input.truncated ? ['Only the 500 with the most cash tied up are shown.'] : []),
    ],
    truncated: input.truncated,
  };
}

// ---------------- stock movement ----------------

export function buildStockMovement(input: {
  facts: ReportFacts;
  rows: readonly MovementRow[];
  truncated: boolean;
  title: string;
}): AnalysisReport {
  const { facts, rows, title } = input;
  const received = rows.reduce((a, r) => a + r.received, 0);
  const sold = rows.reduce((a, r) => a + Math.abs(r.sold), 0);
  const adjusted = rows.reduce((a, r) => a + r.adjusted, 0);
  const net = rows.reduce((a, r) => a + r.netChange, 0);

  const columns: ExportColumn[] = [
    { label: 'Product', kind: 'text' },
    { label: 'Received', kind: 'count' },
    { label: 'Sold', kind: 'count' },
    { label: 'Returned by customers', kind: 'count' },
    { label: 'Returned to suppliers', kind: 'count' },
    { label: 'Adjusted and written off', kind: 'count' },
    { label: 'Net change', kind: 'count' },
    { label: 'On hand now', kind: 'count' },
  ];
  const tableRows = rows.map((r) => [
    r.name,
    round2(r.received),
    round2(Math.abs(r.sold)),
    round2(r.returnedByCustomers),
    round2(Math.abs(r.returnedToSupplier)),
    round2(r.adjusted),
    round2(r.netChange),
    round2(r.onHandNow),
  ]);

  const kpis: Kpi[] = [
    {
      key: 'received',
      label: 'Units received',
      value: round2(received),
      unit: COUNT,
      upIsGood: true,
    },
    { key: 'sold', label: 'Units sold', value: round2(sold), unit: COUNT, upIsGood: true },
    {
      key: 'adjusted',
      label: 'Adjusted and written off',
      value: round2(adjusted),
      unit: COUNT,
      upIsGood: false,
      note: 'Negative means stock was lost',
    },
    { key: 'net', label: 'Net change in stock', value: round2(net), unit: COUNT },
  ];
  const top = [...rows]
    .sort((a, b) => Math.abs(b.sold) - Math.abs(a.sold))
    .filter((r) => r.sold !== 0)
    .slice(0, 10);
  return {
    kind: 'analysis',
    facts,
    kpis,
    charts:
      top.length === 0
        ? []
        : [
            {
              kind: 'ranked',
              title: 'Most units sold',
              unit: COUNT,
              items: top.map((r) => ({
                key: r.id,
                label: r.name,
                value: round2(Math.abs(r.sold)),
                note: `${String(round2(r.onHandNow))} on hand now`,
              })),
            },
          ],
    table: {
      title,
      columns,
      rows: tableRows,
      totals: [
        'Total',
        round2(received),
        round2(sold),
        round2(rows.reduce((a, r) => a + r.returnedByCustomers, 0)),
        round2(rows.reduce((a, r) => a + Math.abs(r.returnedToSupplier), 0)),
        round2(adjusted),
        round2(net),
        null,
      ],
    },
    rowLinks: rows.map((r) => linkFor('product', r.id)),
    reconciliation: [],
    notes: [
      `Movements are the stock ledger for ${formatLocalDate(facts.fromDate)} to ${formatLocalDate(facts.toDate)}, by the time each happened.`,
      'Received includes opening stock and reversals of receipts. Adjusted covers manual adjustments, count differences and write-offs.',
      'Transfers between locations are left out: they move stock, they do not change how much the company holds.',
      ...(input.truncated ? ['Only the 500 products with the biggest change are shown.'] : []),
    ],
    truncated: input.truncated,
  };
}
