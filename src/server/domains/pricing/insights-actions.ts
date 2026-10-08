'use server';

import { getContainer } from '@/server/di/container';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import type { PricingResult } from './actions';
import { PricingConfigError } from './config-service';
import type {
  BranchVariance,
  Finding,
  GuardEvents,
  Liabilities,
  Overview,
  PromotionRow,
  RuleImpact,
} from './insights-service';
import {
  PriceBookService,
  type BookContext,
  type BookPage,
  type BookQuery,
} from './price-book-service';

async function run<T>(fn: (companyId: string) => Promise<T>): Promise<PricingResult<T>> {
  try {
    await requirePermission('pricing:read');
    const company = await getContainer().companySettings.ensureSeeded();
    return { ok: true, data: await fn(company.id) };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError)
      return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    if (error instanceof PricingConfigError)
      return { ok: false, error: error.message, code: error.code, issues: error.issues };
    if (error instanceof ReasonError) return { ok: false, error: error.message, code: error.code };
    console.error('[insights]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

export interface InsightsData {
  days: number;
  overview: Overview;
  promotions: PromotionRow[];
  guard: GuardEvents;
  variance: BranchVariance[];
  liabilities: Liabilities;
  findings: Finding[];
}

export async function getInsightsAction(input: {
  days: number;
  branchId?: string | null;
}): Promise<PricingResult<InsightsData>> {
  return run(async (companyId) => {
    const days = Math.min(366, Math.max(1, Math.trunc(input.days) || 30));
    const to = new Date();
    const range = { from: new Date(to.getTime() - days * 86_400_000), to };
    const { insights } = getContainer();
    const [overview, promotions, guard, variance, liabilities, findings] = await Promise.all([
      insights.overview(companyId, range, input.branchId ?? null),
      insights.promotions(companyId, range),
      insights.guardEvents(companyId, range),
      insights.branchVariance(companyId, range),
      insights.liabilities(companyId),
      insights.findings(companyId),
    ]);
    return { days, overview, promotions, guard, variance, liabilities, findings };
  });
}

export async function impactOfRuleAction(
  ruleId: string,
  days = 90,
): Promise<PricingResult<RuleImpact>> {
  return run((companyId) => getContainer().insights.impactOfRule(companyId, ruleId, days));
}

export async function priceBookAction(
  ctx: BookContext,
  query: BookQuery,
): Promise<PricingResult<BookPage>> {
  return run((companyId) => getContainer().priceBook.page(companyId, ctx, query));
}

export async function exportPriceBookAction(
  ctx: BookContext,
  query: BookQuery,
): Promise<PricingResult<{ csv: string; rows: number; truncated: boolean }>> {
  return run(async (companyId) => {
    const { rows, truncated } = await getContainer().priceBook.export(companyId, ctx, query);
    return { csv: PriceBookService.toCsv(rows), rows: rows.length, truncated };
  });
}
