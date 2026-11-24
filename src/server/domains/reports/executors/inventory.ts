import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { buildContext, factsOf, type AnalysisContext } from '../analysis/context';
import {
  buildLowStock,
  buildSlowStock,
  buildStockMovement,
  buildStockValuation,
} from '../analysis/inventory-reports';
import {
  STOCK_LIMIT,
  stockMovements,
  stockPosition,
  valueByLocation,
} from '../analysis/inventory-queries';
import type { AnalysisReport, ReportFacts } from '../analysis/types';
import { readPeriodParams, type PeriodRequest } from '../engine/period-params';
import { registerExecutor, type RegisteredExecutor, type ReportExecutor } from '../engine/run';
import { inventoryHealth } from '../queries';

const PERMISSIONS: readonly PermissionKey[] = ['report_profit:read'];

/** Stock is held for the whole company, so these reports have no branch to choose and, but for movement, no period. */
function nowFacts(ctx: AnalysisContext): ReportFacts {
  return {
    ...factsOf(ctx),
    scopeLabel: 'All locations',
    branchId: null,
    canPickBranch: false,
    asAtNow: true,
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

const valuationBuild: Build = async (db, ctx) => {
  const [position, health, locations] = await Promise.all([
    stockPosition(db, ctx.now, ctx.currency),
    inventoryHealth(db),
    valueByLocation(db),
  ]);
  return buildStockValuation({
    facts: nowFacts(ctx),
    rows: position.rows,
    overviewValue: health.stockValueAtCost,
    locations,
    truncated: position.rows.length >= STOCK_LIMIT,
    title: 'Stock valuation',
  });
};

const lowStockBuild: Build = async (db, ctx) => {
  const position = await stockPosition(db, ctx.now, ctx.currency, { filter: 'low' });
  return buildLowStock({
    facts: nowFacts(ctx),
    rows: position.rows,
    truncated: position.rows.length >= STOCK_LIMIT,
    title: 'Low and out of stock',
  });
};

const slowStockBuild: Build = async (db, ctx) => {
  const [position, health] = await Promise.all([
    stockPosition(db, ctx.now, ctx.currency, { filter: 'slow' }),
    inventoryHealth(db),
  ]);
  return buildSlowStock({
    facts: nowFacts(ctx),
    rows: position.rows,
    now: ctx.now,
    totalStockValue: health.stockValueAtCost,
    truncated: position.rows.length >= STOCK_LIMIT,
    title: 'Slow and dead stock',
  });
};

const movementBuild: Build = async (db, ctx) => {
  const rows = await stockMovements(db, ctx.period);
  return buildStockMovement({
    facts: { ...factsOf(ctx), scopeLabel: 'All locations', branchId: null, canPickBranch: false },
    rows,
    truncated: rows.length >= STOCK_LIMIT,
    title: 'Stock movement',
  });
};

/** The stock reports, by report code. */
export function inventoryExecutors(deps: { db: DrizzleDb }): RegisteredExecutor[] {
  const { db } = deps;
  const list: [string, Build][] = [
    ['stock-valuation', valuationBuild],
    ['low-stock', lowStockBuild],
    ['slow-stock', slowStockBuild],
    ['stock-movement', movementBuild],
  ];
  return list.map(([code, build]) => registerExecutor(executor(code, db, build)));
}
