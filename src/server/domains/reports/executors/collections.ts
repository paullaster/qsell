import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { buildContext, factsOf } from '../analysis/context';
import { changePct } from '../analysis/sales-reports';
import type { AnalysisReport, Kpi } from '../analysis/types';
import { readPeriodParams, type PeriodRequest } from '../engine/period-params';
import { registerExecutor, type RegisteredExecutor, type ReportExecutor } from '../engine/run';
import {
  configuredMethods,
  paymentsInFlight,
  salesTotals,
  settledByProvider,
  tenderTotals,
  type SettledRow,
} from '../queries';

const PERMISSIONS: readonly PermissionKey[] = ['reports:all_branches'];

const round2 = (n: number): number => Math.round(n * 100) / 100;
const share = (part: number, whole: number): number =>
  whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0;

/**
 * Money collected, in full: every payment method that settled money in the period, with the count, the share and the change on
 * the comparison, plus store credit used and what is still in flight. It adds up the way the overview's Money collected panel does.
 */
function collectionsExecutor(db: DrizzleDb): ReportExecutor<PeriodRequest, AnalysisReport> {
  return {
    code: 'money-collected',
    permissions: PERMISSIONS,
    readParams: (raw) => ({ ok: true, params: readPeriodParams(raw) }),
    runnerCacheMs: 30_000,
    execute: async ({ userId, params, allowed, now, wantTable }) => {
      const ctx = await buildContext(db, userId, allowed, params, now);
      const { period, scope, currency } = ctx;
      const none = scope.kind === 'none';
      const empty: SettledRow[] = [];
      const [configured, cur, prev, tenders, inFlight, sales, prevSales] = await Promise.all([
        none ? Promise.resolve([]) : configuredMethods(db, scope),
        none ? Promise.resolve(empty) : settledByProvider(db, period, scope, currency),
        none ? Promise.resolve(empty) : settledByProvider(db, period.previous, scope, currency),
        none ? Promise.resolve({ amount: 0, count: 0 }) : tenderTotals(db, period, scope, currency),
        none
          ? Promise.resolve({ pendingCount: 0, pendingAmount: 0, failedCount: 0 })
          : paymentsInFlight(db, period, scope, currency),
        none
          ? Promise.resolve({ orders: 0, sales: 0, tax: 0 })
          : salesTotals(db, period, scope, currency),
        none
          ? Promise.resolve({ orders: 0, sales: 0, tax: 0 })
          : salesTotals(db, period.previous, scope, currency),
      ]);

      const names = new Map(configured.map((c) => [c.providerCode, c.displayName]));
      const total = cur.reduce((a, r) => a + r.amount, 0);
      const prevTotal = prev.reduce((a, r) => a + r.amount, 0);
      const prevBy = new Map(prev.map((r) => [r.providerCode, r.amount]));
      const codes = [
        ...new Set([...cur.map((r) => r.providerCode), ...prev.map((r) => r.providerCode)]),
      ];
      const rows = codes
        .map((code) => {
          const row = cur.find((r) => r.providerCode === code);
          const amount = row?.amount ?? 0;
          return {
            code,
            name: names.get(code) ?? `${code} (no longer set up)`,
            amount,
            count: row?.count ?? 0,
            prev: prevBy.get(code),
          };
        })
        .sort((a, b) =>
          a.amount === b.amount ? a.name.localeCompare(b.name) : b.amount - a.amount,
        );

      const unit = { kind: 'money', currency } as const;
      const kpis: Kpi[] = [
        {
          key: 'collected',
          label: 'Money collected',
          value: round2(total),
          unit,
          previous: round2(prevTotal),
          upIsGood: true,
        },
        {
          key: 'rate',
          label: 'Collected as a share of sales',
          value: sales.sales > 0 ? share(total, sales.sales) : null,
          unit: { kind: 'percent' },
          previous: prevSales.sales > 0 ? share(prevTotal, prevSales.sales) : null,
          upIsGood: true,
          note: 'Money confirmed in the period against sales in the period',
        },
        {
          key: 'credit',
          label: 'Store credit used',
          value: round2(tenders.amount),
          unit,
          note: 'Gift cards and loyalty points',
        },
        {
          key: 'pending',
          label: 'Payments not yet confirmed',
          value: round2(inFlight.pendingAmount),
          unit,
          upIsGood: false,
          note: `${String(inFlight.pendingCount)} waiting`,
        },
        {
          key: 'failed',
          label: 'Payments that failed',
          value: inFlight.failedCount,
          unit: { kind: 'count' },
          upIsGood: false,
        },
      ];

      const data: AnalysisReport = {
        kind: 'analysis',
        facts: factsOf(ctx),
        kpis,
        charts: [
          {
            kind: 'donut',
            title: 'How customers paid',
            unit,
            centerLabel: 'collected',
            items: rows
              .filter((r) => r.amount > 0)
              .map((r) => ({ key: r.code, label: r.name, value: round2(r.amount) })),
          },
        ],
        table: {
          title: 'Money collected',
          columns: [
            { label: 'Payment method', kind: 'text' },
            { label: 'Payments', kind: 'count' },
            { label: `Collected (${currency})`, kind: 'money' },
            { label: 'Share', kind: 'percent' },
            { label: 'Change on comparison', kind: 'percent' },
            { label: `Average payment (${currency})`, kind: 'money' },
          ],
          rows: rows.map((r) => [
            r.name,
            r.count,
            round2(r.amount),
            share(r.amount, total),
            r.prev === undefined ? null : changePct(r.amount, r.prev),
            r.count > 0 ? round2(r.amount / r.count) : null,
          ]),
          totals: [
            'Total',
            rows.reduce((a, r) => a + r.count, 0),
            round2(total),
            100,
            changePct(total, prevTotal),
            null,
          ],
        },
        rowLinks: rows.map(() => null),
        reconciliation: [],
        notes: [
          'Money collected is payments confirmed in the period, dated by when each payment was confirmed, not by the date of the order.',
          'It is compared with sales in the same period, so a period that collects old invoices can show more than 100% of its sales.',
          'Store credit (gift cards and loyalty points) is shown on its own: it is a way of paying, but it does not pass through a payment method.',
          'A provider that has been switched off still shows if it settled money in the period, so the total always adds up.',
        ],
        truncated: false,
      };
      return { data, ...(wantTable ? { table: data.table } : {}) };
    },
  };
}

export function collectionsExecutors(deps: { db: DrizzleDb }): RegisteredExecutor[] {
  return [registerExecutor(collectionsExecutor(deps.db))];
}
