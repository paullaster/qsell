import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { buildContext, factsOf, type AnalysisContext } from '../analysis/context';
import {
  CUT_LIMIT,
  customerMix,
  orderTotals,
  returnsByProduct,
  returnsByReason,
  salesByItemCut,
  salesByOrderCut,
  type CustomerMix,
  type CutRow,
  type OrderTotals,
  type ReturnRow,
} from '../analysis/sales-queries';
import {
  buildCustomerMixReport,
  buildCutReport,
  buildReturnsReport,
  buildTimeReport,
} from '../analysis/sales-reports';
import type { AnalysisReport } from '../analysis/types';
import { registerExecutor, type RegisteredExecutor, type ReportExecutor } from '../engine/run';
import { readPeriodParams, type PeriodRequest } from '../engine/period-params';
import type { TimeWindow } from '../period';
import type { ReportScope } from '../types';

/** The permissions that change what a sales report shows: cost and margin, and whether every branch may be chosen. */
const PERMISSIONS: readonly PermissionKey[] = ['report_profit:read', 'reports:all_branches'];

const noScope = (scope: ReportScope): boolean => scope.kind === 'none';

const EMPTY_TOTALS: OrderTotals = { items: 0, tax: 0, delivery: 0, total: 0, orders: 0 };
const EMPTY_MIX: CustomerMix = {
  newCustomers: 0,
  returningCustomers: 0,
  newSales: 0,
  returningSales: 0,
  walkInOrders: 0,
  walkInSales: 0,
  repeatBuyers: 0,
  medianDaysBetween: null,
};

/** Reads for a window, skipping the database when the person has no branch to see. */
function reader(db: DrizzleDb, ctx: AnalysisContext) {
  const none = noScope(ctx.scope);
  const { scope, currency } = ctx;
  const tz = ctx.period.timeZone;
  return {
    item: (cut: 'product' | 'category' | 'vendor', w: TimeWindow): Promise<CutRow[]> =>
      none ? Promise.resolve([]) : salesByItemCut(db, cut, w, scope, currency),
    order: (
      cut: 'branch' | 'customer' | 'day' | 'weekday' | 'hour',
      w: TimeWindow,
    ): Promise<CutRow[]> =>
      none ? Promise.resolve([]) : salesByOrderCut(db, cut, w, scope, currency, tz),
    totals: (w: TimeWindow): Promise<OrderTotals> =>
      none ? Promise.resolve(EMPTY_TOTALS) : orderTotals(db, w, scope, currency),
    mix: (w: TimeWindow): Promise<CustomerMix> =>
      none ? Promise.resolve(EMPTY_MIX) : customerMix(db, w, scope, currency),
    returnsByReason: (w: TimeWindow): Promise<ReturnRow[]> =>
      none ? Promise.resolve([]) : returnsByReason(db, w, scope, currency),
    returnsByProduct: (w: TimeWindow): Promise<ReturnRow[]> =>
      none ? Promise.resolve([]) : returnsByProduct(db, w, scope, currency),
  };
}

type Build = (db: DrizzleDb, ctx: AnalysisContext) => Promise<AnalysisReport>;

function executor(
  code: string,
  db: DrizzleDb,
  build: Build,
): ReportExecutor<PeriodRequest, AnalysisReport> {
  return {
    code,
    permissions: PERMISSIONS,
    readParams: (raw) => ({ ok: true, params: readPeriodParams(raw) }),
    // The same answer for the same person and choices is reused for a short while; the "as of" time says how old it is.
    runnerCacheMs: 30_000,
    execute: async ({ userId, params, allowed, now, wantTable }) => {
      const ctx = await buildContext(db, userId, allowed, params, now);
      const data = await build(db, ctx);
      return {
        data,
        ...(wantTable ? { table: data.table } : {}),
        truncated: data.truncated,
      };
    },
  };
}

const cutLimited = (rows: readonly unknown[]): boolean => rows.length >= CUT_LIMIT;

/** Sales by product, category or supplier: the lines sold, grouped, against the comparison period. */
function itemCutBuild(
  cut: 'product' | 'category' | 'vendor',
  entity: string,
  title: string,
  extra: { donut?: boolean; byMargin?: boolean } = {},
): Build {
  return async (db, ctx) => {
    const read = reader(db, ctx);
    const [current, previous, totals] = await Promise.all([
      read.item(cut, ctx.period),
      read.item(cut, ctx.period.previous),
      read.totals(ctx.period),
    ]);
    return buildCutReport({
      facts: factsOf(ctx),
      seesCost: ctx.seesCost,
      entity,
      cut,
      basis: 'items',
      current,
      previous,
      totals,
      truncated: cutLimited(current),
      title,
      ...extra,
    });
  };
}

/** Sales by branch or customer: whole orders, so the total is exactly what the overview shows. */
function orderCutBuild(
  cut: 'branch' | 'customer',
  entity: string,
  title: string,
  extra: { donut?: boolean } = {},
): Build {
  return async (db, ctx) => {
    const read = reader(db, ctx);
    const [current, previous, totals] = await Promise.all([
      read.order(cut, ctx.period),
      read.order(cut, ctx.period.previous),
      read.totals(ctx.period),
    ]);
    return buildCutReport({
      facts: factsOf(ctx),
      seesCost: ctx.seesCost,
      entity,
      cut,
      basis: 'orders',
      current,
      previous,
      totals,
      truncated: cutLimited(current),
      title,
      ...extra,
    });
  };
}

function timeBuild(by: 'day' | 'weekday' | 'hour', title: string): Build {
  return async (db, ctx) => {
    const read = reader(db, ctx);
    const [current, previous, totals] = await Promise.all([
      read.order(by, ctx.period),
      read.order(by, ctx.period.previous),
      read.totals(ctx.period),
    ]);
    return buildTimeReport({
      facts: factsOf(ctx),
      seesCost: ctx.seesCost,
      by,
      days: ctx.period.days,
      previousDays: ctx.previousDays,
      current,
      previous,
      totals,
      title,
    });
  };
}

const customersBuild: Build = async (db, ctx) => {
  const read = reader(db, ctx);
  const [current, previous] = await Promise.all([
    read.mix(ctx.period),
    read.mix(ctx.period.previous),
  ]);
  return buildCustomerMixReport({
    facts: factsOf(ctx),
    current,
    previous,
    title: 'Returning customers',
  });
};

const returnsBuild: Build = async (db, ctx) => {
  const read = reader(db, ctx);
  const [byProduct, byReason, previousReasons, totals] = await Promise.all([
    read.returnsByProduct(ctx.period),
    read.returnsByReason(ctx.period),
    read.returnsByReason(ctx.period.previous),
    read.totals(ctx.period),
  ]);
  return buildReturnsReport({
    facts: factsOf(ctx),
    byProduct,
    byReason,
    previousTotal: previousReasons.reduce((a, r) => a + r.amount, 0),
    sales: totals.total,
    title: 'Sales returns',
  });
};

/** The sales reports, by report code. */
export function salesExecutors(deps: { db: DrizzleDb }): RegisteredExecutor[] {
  const { db } = deps;
  const list: [string, Build][] = [
    ['sales-summary', timeBuild('day', 'Sales summary')],
    ['sales-by-product', itemCutBuild('product', 'Product', 'Sales by product')],
    [
      'sales-by-category',
      itemCutBuild('category', 'Category', 'Sales by category', { donut: true }),
    ],
    ['sales-by-vendor', itemCutBuild('vendor', 'Supplier', 'Sales by supplier', { donut: true })],
    ['sales-by-branch', orderCutBuild('branch', 'Branch', 'Sales by branch', { donut: true })],
    ['sales-by-customer', orderCutBuild('customer', 'Customer', 'Sales by customer')],
    ['sales-by-weekday', timeBuild('weekday', 'Sales by weekday')],
    ['sales-by-hour', timeBuild('hour', 'Sales by hour')],
    ['returning-customers', customersBuild],
    ['sales-returns', returnsBuild],
    [
      'gross-margin',
      itemCutBuild('product', 'Product', 'Gross margin by product', { byMargin: true }),
    ],
  ];
  return list.map(([code, build]) => registerExecutor(executor(code, db, build)));
}
