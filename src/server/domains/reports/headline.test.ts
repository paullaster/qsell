import { describe, expect, it } from 'vitest';
import { buildHeadline } from './headline';
import type { BusinessOverview } from './types';

const cmp = (current: number, previous: number, changePct: number | null) => ({
  current,
  previous,
  changePct,
});
const meta = {
  baseCurrency: 'KES',
  compare: { mode: 'previous_period', label: 'Previous period' },
};

const sales = (
  over: Partial<NonNullable<BusinessOverview['sales']>> = {},
): NonNullable<BusinessOverview['sales']> => ({
  orders: cmp(7, 5, 40),
  sales: cmp(14000, 10000, 40),
  averageOrder: cmp(2000, 2000, 0),
  tax: cmp(0, 0, null),
  trend: [],
  flow: [],
  byBranch: null,
  topProducts: [],
  ...over,
});

const collections = (over: Record<string, unknown> = {}) =>
  ({
    configured: true,
    collected: cmp(6000, 0, null),
    collectionRatePct: 42.9,
    inFlight: { pendingCount: 0, pendingAmount: 0, failedCount: 0 },
    methods: [],
    unconfigured: { amount: 0, count: 0, providers: [] },
    tenders: { amount: 0, count: 0 },
    ...over,
  }) as NonNullable<BusinessOverview['collections']>;

describe('buildHeadline', () => {
  it('states sales, comparison, collection and attention in plain sentences', () => {
    const lines = buildHeadline({
      sales: sales(),
      collections: collections({
        inFlight: { pendingCount: 2, pendingAmount: 400, failedCount: 0 },
      }),
      attention: [
        { key: 'a', label: 'x', count: 1, href: '/', tone: 'critical' },
        { key: 'b', label: 'y', count: 2, href: '/', tone: 'warning' },
      ],
      meta,
    });
    expect(lines).toEqual([
      'Sales were KES 14,000 from 7 orders, up 40% on previous period.',
      'KES 6,000 was collected (42.9% of sales), with 2 payments still unconfirmed.',
      '2 items need your attention, 1 of them urgent.',
    ]);
  });

  it('says so plainly when nothing happened', () => {
    const lines = buildHeadline({
      sales: sales({ orders: cmp(0, 0, null), sales: cmp(0, 0, null) }),
      collections: collections({ collected: cmp(0, 0, null), collectionRatePct: null }),
      attention: [],
      meta,
    });
    expect(lines).toEqual([
      'No sales were recorded in this period.',
      'No money was collected in this period.',
    ]);
  });

  it('never mentions a section the viewer cannot see', () => {
    expect(buildHeadline({ sales: null, collections: null, attention: [], meta })).toEqual([]);
    const onlySales = buildHeadline({ sales: sales(), collections: null, attention: [], meta });
    expect(onlySales).toHaveLength(1);
    expect(onlySales[0]).not.toMatch(/collected/);
  });

  it('is silent about collections when no payment method is configured', () => {
    const lines = buildHeadline({
      sales: sales(),
      collections: { configured: false, setupHref: '/admin/settings/payments' },
      attention: [],
      meta,
    });
    expect(lines.some((l) => /collected/.test(l))).toBe(false);
  });

  it('reports a drop, a flat period and a first period without a baseline', () => {
    const line = (c: ReturnType<typeof cmp>) =>
      buildHeadline({ sales: sales({ sales: c }), collections: null, attention: [], meta })[0];
    expect(line(cmp(8000, 10000, -20))).toContain('down 20% on previous period');
    expect(line(cmp(10000, 10000, 0))).toContain('level with previous period');
    expect(line(cmp(10000, 0, null))).toMatch(/orders\.$/);
  });

  it('names the comparison the viewer chose', () => {
    const lines = buildHeadline({
      sales: sales(),
      collections: null,
      attention: [],
      meta: {
        baseCurrency: 'KES',
        compare: { mode: 'previous_year', label: 'Same period last year' },
      },
    });
    expect(lines[0]).toContain('on same period last year');
  });
});
