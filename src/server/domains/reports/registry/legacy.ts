import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { MessageId } from '@/lib/reports/messages';
import type { ReportDefinition, TieOut } from './definition';
import type { FamilyCode } from './families';

/**
 * Reports that were built before the registry and keep their own screen, now all under `/admin/reports/<name>`. Listing them here
 * makes them findable from the Reports page, gives each one permission and one documentation record, and lets the registry
 * tests hold them to the same rules as new reports. Working screens (journals, refunds, bank accounts, till shifts) are not
 * reports and are not listed. Each keeps its own service; the permission listed is the one the screen already needs.
 */

const NOT_TIED = {
  kind: 'none',
  reason:
    'Reads its own documents or ledger directly; its proof against the books is declared when it is rebuilt on the registry.',
} as const satisfies TieOut;

interface Legacy {
  code: string;
  title: MessageId;
  question: MessageId;
  family: FamilyCode;
  /** The screen's address under /admin/reports. Leave out for a report the report page draws itself (`generic`). */
  href?: string;
  generic?: boolean;
  permissions: readonly PermissionKey[];
  keywords: readonly string[];
  docs: { file: string; heading: string };
  tieOut?: TieOut;
  sensitivity?: ReportDefinition['sensitivity'];
  scope?: ReportDefinition['scope'];
  /** Figures already in the catalogue; leave out for a report whose figures are not catalogued yet. */
  measures?: ReportDefinition['measures'];
  exportFormats?: ReportDefinition['exportFormats'];
  dimensions?: ReportDefinition['dimensions'];
}

function legacy(l: Legacy): ReportDefinition {
  const catalogued = l.measures !== undefined && l.measures.length > 0;
  return {
    code: l.code,
    titleId: l.title,
    questionId: l.question,
    family: l.family,
    permissions: l.permissions,
    measures: l.measures ?? [],
    dimensions: l.dimensions ?? [],
    tier: 'live',
    scope: l.scope ?? 'company',
    tieOut: l.tieOut ?? NOT_TIED,
    sensitivity: l.sensitivity ?? 'normal',
    exportFormats: l.exportFormats ?? [],
    maxRows: 500,
    timeoutMs: 30_000,
    keywords: l.keywords,
    docs: l.docs,
    view: l.generic === true ? 'table' : 'legacy',
    ...(l.generic === true || l.href === undefined ? {} : { href: l.href }),
    catalogue: catalogued ? 'complete' : 'pending',
  };
}

const FINANCE = '10-finance-general-ledger-and-accounts-receivable.md';
const VENDORS = '09-vendor-management-procurement-and-payables.md';
const DELIVERY = '06-delivery-logistics-and-field-dispatch.md';
const PRICING = '04-pricing-engine-promotions-and-margins.md';

export const LEGACY_REPORTS: readonly ReportDefinition[] = [
  // ---- finance ----
  legacy({
    code: 'trial-balance',
    title: 'report.trial_balance.title',
    question: 'report.trial_balance.question',
    family: 'finance',
    href: '/admin/reports/trial-balance',
    permissions: ['trial_balance:read'],
    keywords: ['trial balance', 'ledger balances', 'accounts balance', 'general ledger'],
    docs: { file: FINANCE, heading: 'Trial Balance' },
    tieOut: { kind: 'gl', control: 'Every ledger account: total debits equal total credits' },
  }),
  legacy({
    code: 'receivables-ageing',
    title: 'report.receivables_ageing.title',
    question: 'report.receivables_ageing.question',
    family: 'finance',
    generic: true,
    permissions: ['receivables_ageing:read'],
    keywords: ['receivables', 'ageing', 'aging', 'debtors', 'who owes us', 'overdue invoices'],
    docs: { file: FINANCE, heading: 'Receivables Ageing' },
    tieOut: { kind: 'subledger', control: 'Trade debtors control account' },
    measures: ['receivables.outstanding', 'receivables.overdue'],
    exportFormats: ['csv', 'xlsx', 'pdf'],
    dimensions: ['customer'],
  }),

  // ---- vendors ----
  legacy({
    code: 'payables-ageing',
    title: 'report.payables_ageing.title',
    question: 'report.payables_ageing.question',
    family: 'vendors',
    generic: true,
    permissions: ['vendor_payments:read'],
    keywords: ['what we owe', 'payables', 'creditors', 'supplier ageing', 'accounts payable'],
    docs: { file: VENDORS, heading: 'What We Owe / Payables Ageing' },
    tieOut: { kind: 'subledger', control: 'Trade creditors control account' },
    measures: ['payables.outstanding', 'payables.overdue'],
    exportFormats: ['csv', 'xlsx', 'pdf'],
    dimensions: ['vendor'],
  }),
  legacy({
    code: 'vendor-reports',
    title: 'report.vendor_reports.title',
    question: 'report.vendor_reports.question',
    family: 'vendors',
    href: '/admin/reports/vendor-reports',
    permissions: ['vendor_reports:read'],
    keywords: ['vendor reports', 'supplier spend', 'purchases', 'commitments', 'watch list'],
    docs: { file: VENDORS, heading: 'Vendor Reports' },
  }),
  legacy({
    code: 'vendor-scorecards',
    title: 'report.vendor_scorecards.title',
    question: 'report.vendor_scorecards.question',
    family: 'vendors',
    href: '/admin/reports/vendor-scorecards',
    permissions: ['scorecards:read'],
    keywords: ['vendor scorecard', 'supplier rating', 'on-time delivery', 'supplier performance'],
    docs: { file: VENDORS, heading: 'Vendor Scorecards' },
  }),

  // ---- delivery ----
  legacy({
    code: 'delivery-report',
    title: 'report.delivery_report.title',
    question: 'report.delivery_report.question',
    family: 'delivery',
    href: '/admin/reports/delivery-report',
    permissions: ['delivery_costs:manage'],
    keywords: ['delivery report', 'delivery cost', 'delivery margin', 'rider pay'],
    docs: { file: DELIVERY, heading: 'Delivery Report' },
  }),
  legacy({
    code: 'delivery-performance',
    title: 'report.delivery_performance.title',
    question: 'report.delivery_performance.question',
    family: 'delivery',
    href: '/admin/reports/delivery-performance',
    permissions: ['deliveries:dispatch'],
    keywords: [
      'delivery performance',
      'on-time delivery',
      'rider performance',
      'failed deliveries',
    ],
    docs: { file: DELIVERY, heading: 'Delivery Performance' },
  }),
  legacy({
    code: 'late-deliveries',
    title: 'report.late_deliveries.title',
    question: 'report.late_deliveries.question',
    family: 'delivery',
    href: '/admin/reports/late-deliveries',
    permissions: ['deliveries:dispatch'],
    keywords: ['late deliveries', 'delayed orders', 'delivery delays'],
    docs: { file: DELIVERY, heading: 'Late Deliveries' },
  }),

  // ---- sales and pricing ----
  legacy({
    code: 'pricing-insights',
    title: 'report.pricing_insights.title',
    question: 'report.pricing_insights.question',
    family: 'sales',
    href: '/admin/reports/pricing-insights',
    permissions: ['pricing:read'],
    keywords: ['pricing insights', 'margin', 'below cost', 'promotion cost', 'discount leakage'],
    docs: { file: PRICING, heading: 'Pricing Insights' },
    // It shows margins and costs, and is gated by the pricing permission the screen already needs.
    sensitivity: 'cost',
  }),

  // ---- customers ----
  legacy({
    code: 'customer-analytics',
    title: 'report.customer_analytics.title',
    question: 'report.customer_analytics.question',
    family: 'customers',
    href: '/admin/reports/customer-analytics',
    permissions: ['analytics:read'],
    keywords: ['customer analytics', 'buying patterns', 'customer accounts'],
    docs: { file: '01-business-overview-and-dashboard.md', heading: 'Customer Analytics' },
  }),
];
