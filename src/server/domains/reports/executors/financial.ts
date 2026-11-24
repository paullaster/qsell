import type { DrizzleDb } from '@/server/db/drizzle/client';
import { formatDateRange } from '@/lib/reports/format';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { buildContext, factsOf, type AnalysisContext } from '../analysis/context';
import {
  balancesAt,
  cashAccountIds,
  dayBefore,
  fiscalYearStart,
  loadChart,
  movement,
  salesRoleAccounts,
  type Nets,
} from '../analysis/ledger-queries';
import {
  buildBalanceSheet,
  buildCashFlow,
  buildEquityChanges,
  buildIncomeStatement,
  type PeriodNets,
} from '../analysis/statements';
import type { ReportFacts, StatementReport } from '../analysis/types';
import { registerExecutor, type RegisteredExecutor, type ReportExecutor } from '../engine/run';
import { readPeriodParams, type PeriodRequest } from '../engine/period-params';

/** What changes a statement: whether every branch may be chosen. The statements themselves need their own permission. */
const PERMISSIONS: readonly PermissionKey[] = ['reports:all_branches'];

const EMPTY: Nets = new Map();

interface Deps {
  db: DrizzleDb;
  companyId: () => Promise<string>;
}

type Build = (
  deps: { db: DrizzleDb; companyId: string },
  ctx: AnalysisContext,
) => Promise<StatementReport>;

function executor(
  code: string,
  deps: Deps,
  build: Build,
): ReportExecutor<PeriodRequest, StatementReport> {
  return {
    code,
    permissions: PERMISSIONS,
    readParams: (raw) => ({ ok: true, params: readPeriodParams(raw) }),
    runnerCacheMs: 30_000,
    execute: async ({ userId, params, allowed, now, wantTable }) => {
      const ctx = await buildContext(deps.db, userId, allowed, params, now);
      const companyId = await deps.companyId();
      const data = await build({ db: deps.db, companyId }, ctx);
      return { data, ...(wantTable ? { table: data.table } : {}) };
    },
  };
}

/** A branch is only honoured where a branch's own statement makes sense; a person with no branch sees nothing. */
const branchOf = (ctx: AnalysisContext): string | null =>
  ctx.scope.kind === 'branch' ? ctx.scope.branchId : null;
const hidden = (ctx: AnalysisContext): boolean => ctx.scope.kind === 'none';

/** Company-wide statements: the branch choice is not offered, because a single branch does not have a balance sheet. */
function companyFacts(ctx: AnalysisContext): ReportFacts {
  return { ...factsOf(ctx), scopeLabel: 'All branches', branchId: null, canPickBranch: false };
}

const range = (from: string, to: string): string => formatDateRange(from, to);

/** Both columns' balances for a window: the day before it starts, its end, and everything posted inside it. */
async function periodNets(
  db: DrizzleDb,
  companyId: string,
  fromDate: string,
  toDate: string,
  branchId: string | null,
): Promise<PeriodNets> {
  const [open, close, move] = await Promise.all([
    balancesAt(db, companyId, dayBefore(fromDate), branchId),
    balancesAt(db, companyId, toDate, branchId),
    movement(db, companyId, fromDate, toDate, branchId),
  ]);
  return { open, close, move };
}

const incomeBuild: Build = async ({ db, companyId }, ctx) => {
  const p = ctx.period;
  const branchId = branchOf(ctx);
  const none = hidden(ctx);
  const [chart, roles, now, before] = await Promise.all([
    loadChart(db, companyId),
    salesRoleAccounts(db, companyId),
    none ? Promise.resolve(EMPTY) : movement(db, companyId, p.fromDate, p.toDate, branchId),
    none
      ? Promise.resolve(EMPTY)
      : movement(db, companyId, p.previous.fromDate, p.previous.toDate, branchId),
  ]);
  const statement = buildIncomeStatement({
    facts: factsOf(ctx),
    chart,
    revenueIds: roles.revenue,
    now,
    before,
    nowLabel: range(p.fromDate, p.toDate),
    beforeLabel: range(p.previous.fromDate, p.previous.toDate),
  });
  return branchId === null
    ? statement
    : {
        ...statement,
        notes: [
          ...statement.notes,
          'This is one branch: only ledger entries posted to the branch are included. Entries that carry no branch are in the company figures, not here.',
        ],
      };
};

const balanceSheetBuild: Build = async ({ db, companyId }, ctx) => {
  const p = ctx.period;
  const [chart, now, before] = await Promise.all([
    loadChart(db, companyId),
    balancesAt(db, companyId, p.toDate, null),
    balancesAt(db, companyId, p.previous.toDate, null),
  ]);
  const [nowStart, beforeStart] = await Promise.all([
    fiscalYearStart(db, companyId, p.toDate),
    fiscalYearStart(db, companyId, p.previous.toDate),
  ]);
  const [nowYearOpening, beforeYearOpening] = await Promise.all([
    nowStart === null
      ? Promise.resolve(null)
      : balancesAt(db, companyId, dayBefore(nowStart), null),
    beforeStart === null
      ? Promise.resolve(null)
      : balancesAt(db, companyId, dayBefore(beforeStart), null),
  ]);
  return buildBalanceSheet({
    facts: companyFacts(ctx),
    chart,
    now,
    before,
    nowLabel: `At ${range(p.toDate, p.toDate)}`,
    beforeLabel: `At ${range(p.previous.toDate, p.previous.toDate)}`,
    nowYearOpening,
    beforeYearOpening,
  });
};

const equityBuild: Build = async ({ db, companyId }, ctx) => {
  const p = ctx.period;
  const [chart, nets] = await Promise.all([
    loadChart(db, companyId),
    periodNets(db, companyId, p.fromDate, p.toDate, null),
  ]);
  return buildEquityChanges({
    facts: companyFacts(ctx),
    chart,
    open: nets.open,
    close: nets.close,
    move: nets.move,
    openDate: range(dayBefore(p.fromDate), dayBefore(p.fromDate)),
    closeDate: range(p.toDate, p.toDate),
  });
};

const cashFlowBuild: Build = async ({ db, companyId }, ctx) => {
  const p = ctx.period;
  const chart = await loadChart(db, companyId);
  const [cashIds, now, before] = await Promise.all([
    cashAccountIds(db, companyId, chart),
    periodNets(db, companyId, p.fromDate, p.toDate, null),
    periodNets(db, companyId, p.previous.fromDate, p.previous.toDate, null),
  ]);
  return buildCashFlow({
    facts: companyFacts(ctx),
    chart,
    cashIds,
    now,
    before,
    nowLabel: range(p.fromDate, p.toDate),
    beforeLabel: range(p.previous.fromDate, p.previous.toDate),
  });
};

/** The financial statements, by report code. */
export function financialExecutors(deps: Deps): RegisteredExecutor[] {
  const list: [string, Build][] = [
    ['income-statement', incomeBuild],
    ['balance-sheet', balanceSheetBuild],
    ['changes-in-equity', equityBuild],
    ['cash-flow', cashFlowBuild],
  ];
  return list.map(([code, build]) => registerExecutor(executor(code, deps, build)));
}
