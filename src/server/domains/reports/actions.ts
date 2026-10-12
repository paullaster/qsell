'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import type { OverviewRequest } from './service';
import type { BusinessOverview } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Business Overview data. Opening the page needs `dashboard:read`; each section is then
 * computed only if the caller holds that section's own permission (see ReportsService).
 */
export async function getBusinessOverviewAction(
  input: OverviewRequest = {},
): Promise<BusinessOverview> {
  const userId = await requirePermission('dashboard:read');
  const clean: OverviewRequest = {
    preset: typeof input.preset === 'string' ? input.preset.slice(0, 20) : undefined,
    compare: typeof input.compare === 'string' ? input.compare.slice(0, 20) : undefined,
    from: typeof input.from === 'string' ? input.from.slice(0, 10) : undefined,
    to: typeof input.to === 'string' ? input.to.slice(0, 10) : undefined,
    branchId:
      typeof input.branchId === 'string' && UUID_RE.test(input.branchId)
        ? input.branchId
        : undefined,
  };
  return await getContainer().reports.getBusinessOverview(userId, clean);
}
