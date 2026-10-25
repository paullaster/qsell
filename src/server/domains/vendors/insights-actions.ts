'use server';

import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { reportRange } from '@/lib/vendor-insights';

const meta = (action: string) => ({ surface: 'vendor_reports', action });

export async function commitmentsAction() {
  return await run('vendor_reports:read', meta('commitments'), async (ctx) => await getContainer().vendorInsights.commitments(ctx.companyId));
}

export async function performanceAction(from?: string, to?: string) {
  return await run('vendor_reports:read', meta('performance'), async (ctx) => await getContainer().vendorInsights.performance(ctx.companyId, reportRange(from, to, businessDate())));
}

export async function purchasesAction(from?: string, to?: string) {
  return await run('vendor_reports:read', meta('purchases'), async (ctx) => await getContainer().vendorInsights.purchases(ctx.companyId, reportRange(from, to, businessDate())));
}

export async function watchListAction(from?: string, to?: string) {
  return await run('vendor_reports:read', meta('watch_list'), async (ctx) => await getContainer().vendorInsights.watchList(ctx.companyId, reportRange(from, to, businessDate())));
}

export async function sourcingAction(from?: string, to?: string) {
  return await run('vendor_reports:read', meta('sourcing'), async (ctx) => await getContainer().vendorInsights.sourcing(ctx.companyId, reportRange(from, to, businessDate())));
}

export async function withholdingReportAction(from?: string, to?: string) {
  return await run('vendor_reports:read', meta('withholding'), async (ctx) => await getContainer().vendorInsights.withholding(ctx.companyId, reportRange(from, to, businessDate())));
}

export async function qualificationAction() {
  return await run('vendor_reports:read', meta('qualification'), async (ctx) => await getContainer().vendorInsights.qualification(ctx.companyId));
}

export async function pettyCashReportAction(from?: string, to?: string) {
  return await run('vendor_reports:read', meta('petty_cash'), async (ctx) => await getContainer().vendorInsights.pettyCash(ctx.companyId, reportRange(from, to, businessDate())));
}
