import type { ReportExecutor } from '../engine/run';
import { readOverviewParams } from '../engine/params';
import { OVERVIEW_PERMISSIONS, type OverviewRequest, type ReportsService } from '../service';
import type { BusinessOverview } from '../types';

/**
 * The Business Overview as a report the runner can produce. It computes exactly what `ReportsService` always did (the
 * service keeps its own short cache, so the runner does not cache it again) and is handed the viewer's permissions
 * the runner already resolved, so each section is computed only for someone who may see it.
 */
export function overviewExecutor(
  service: Pick<ReportsService, 'overview'>,
): ReportExecutor<OverviewRequest, BusinessOverview> {
  return {
    code: 'business-overview',
    permissions: OVERVIEW_PERMISSIONS,
    readParams: (raw) => ({ ok: true, params: readOverviewParams(raw) }),
    execute: async ({ userId, params, allowed }) => {
      const data = await service.overview(userId, params, allowed);
      // The overview reports its own read time and whether it came from its cache.
      return { data, asOf: data.meta.asOf, cached: data.meta.cached };
    },
  };
}
