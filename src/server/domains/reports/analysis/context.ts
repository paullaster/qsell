import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { currencies } from '@/server/db/drizzle/schema';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { PeriodRequest } from '../engine/period-params';
import { resolveReportScope, scopeLabel } from '../engine/scope';
import { listDays, resolvePeriod, type ResolvedPeriod } from '../period';
import type { ReportScope } from '../types';
import type { ReportFacts } from './types';

const FALLBACK_CURRENCY = 'KES';

/** Everything a report needs to know about who is asking and what they asked for, worked out once on the server. */
export interface AnalysisContext {
  period: ResolvedPeriod;
  scope: ReportScope;
  currency: string;
  /** The local days of the comparison period, oldest first (for lining a day up with its counterpart). */
  previousDays: string[];
  /** Whether the person may see cost and margin figures. */
  seesCost: boolean;
  canPickBranch: boolean;
  now: Date;
}

export async function buildContext(
  db: DrizzleDb,
  userId: string,
  allowed: ReadonlySet<PermissionKey>,
  request: PeriodRequest,
  now: Date,
): Promise<AnalysisContext> {
  const period = resolvePeriod(request, now);
  const canPickBranch = allowed.has('reports:all_branches');
  const scope = await resolveReportScope(db, userId, canPickBranch, request.branchId);
  const [base] = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.isBaseCurrency, true))
    .limit(1);
  const dayMs = 86_400_000;
  const count =
    Math.round(
      (Date.parse(period.previous.toDate) - Date.parse(period.previous.fromDate)) / dayMs,
    ) + 1;
  const previousDays = listDays(period.previous.fromDate, Math.max(count, 0));
  return {
    period,
    previousDays,
    scope,
    currency: base?.code ?? FALLBACK_CURRENCY,
    seesCost: allowed.has('report_profit:read'),
    canPickBranch,
    now,
  };
}

export function factsOf(ctx: AnalysisContext): ReportFacts {
  const p = ctx.period;
  return {
    preset: p.preset,
    compare: p.compare,
    fromDate: p.fromDate,
    toDate: p.toDate,
    previousFromDate: p.previous.fromDate,
    previousToDate: p.previous.toDate,
    timeZone: p.timeZone,
    baseCurrency: ctx.currency,
    scopeLabel: scopeLabel(ctx.scope),
    branchId: ctx.scope.kind === 'branch' ? ctx.scope.branchId : null,
    canPickBranch: ctx.canPickBranch,
    notice: p.notice ?? null,
  };
}
