'use server';

import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { checkWatchSettings, reportRange } from '@/lib/vendor-insights';

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

export async function watchListAction(from?: string, to?: string, settings?: unknown) {
  return await run('vendor_reports:read', meta('watch_list'), async (ctx) => {
    const s = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : {};
    const clean = checkWatchSettings({ duplicateWindowDays: typeof s.duplicateWindowDays === 'number' ? s.duplicateWindowDays : undefined, newVendorDays: typeof s.newVendorDays === 'number' ? s.newVendorDays : undefined, newVendorAmountCents: typeof s.newVendorAmountCents === 'number' ? s.newVendorAmountCents : undefined });
    return await getContainer().vendorInsights.watchList(ctx.companyId, reportRange(from, to, businessDate()), clean);
  });
}
