import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { ReportDefinition } from './definition';
import { FAMILY_CODES, type FamilyCode } from './families';
import {
  COLLECTION_REPORTS,
  FINANCIAL_REPORTS,
  INVENTORY_REPORTS,
  SALES_REPORTS,
} from './analysis';
import { LEGACY_REPORTS } from './legacy';

export type { ReportDefinition } from './definition';
export { FAMILY_CODES, FAMILY_LABELS, type FamilyCode } from './families';

/** Reports built on the registry. */
const BUILT_IN: readonly ReportDefinition[] = [
  {
    code: 'business-overview',
    titleId: 'report.business_overview.title',
    questionId: 'report.business_overview.question',
    family: 'executive',
    permissions: ['dashboard:read'],
    // The overview computes each section only for someone who holds that section's own permission.
    costGatedBy: 'report_profit:read',
    measures: [
      'sales.total',
      'sales.orders',
      'sales.average_order',
      'sales.tax',
      'collections.collected',
      'collections.rate',
      'collections.tenders',
      'profit.gross',
      'profit.margin',
      'profit.cost_coverage',
      'receivables.outstanding',
      'receivables.overdue',
      'inventory.stock_value',
      'inventory.out_of_stock',
      'inventory.low_stock',
    ],
    dimensions: ['date', 'branch', 'product', 'payment_method'],
    tier: 'live',
    scope: 'both',
    tieOut: {
      kind: 'none',
      reason:
        'The overview reads orders and payments directly; tie-outs to the books arrive with the rollups in slice R-1.',
    },
    sensitivity: 'cost',
    exportFormats: [],
    maxRows: 500,
    timeoutMs: 20_000,
    keywords: ['overview', 'dashboard', 'sales today', 'how are we doing', 'business summary'],
    docs: {
      file: '01-business-overview-and-dashboard.md',
      heading: 'Section C: Sales Performance & Order Flow',
    },
    view: 'overview',
    href: '/admin',
    catalogue: 'complete',
  },
];

/**
 * Every report the platform has. Add an entry when a report is built or adopted; `registry.test.ts` fails the build if
 * an entry is incomplete. Reports that already had a screen are listed in `legacy.ts`.
 */
export const REPORTS: readonly ReportDefinition[] = [
  ...BUILT_IN,
  ...SALES_REPORTS,
  ...COLLECTION_REPORTS,
  ...FINANCIAL_REPORTS,
  ...INVENTORY_REPORTS,
  ...LEGACY_REPORTS,
];

const BY_CODE: ReadonlyMap<string, ReportDefinition> = new Map(REPORTS.map((r) => [r.code, r]));

export function findReport(code: string): ReportDefinition | undefined {
  return BY_CODE.get(code);
}

/** The reports a person may open: every permission the report needs is among the ones they hold. */
export function visibleReports(allowed: ReadonlySet<PermissionKey>): ReportDefinition[] {
  return REPORTS.filter((r) => r.permissions.every((p) => allowed.has(p)));
}

/** The visible reports grouped by family, in the hub's order; empty families are left out. */
export function groupByFamily(
  reports: readonly ReportDefinition[],
): { family: FamilyCode; reports: ReportDefinition[] }[] {
  return FAMILY_CODES.map((family) => ({
    family,
    reports: reports.filter((r) => r.family === family),
  })).filter((g) => g.reports.length > 0);
}
