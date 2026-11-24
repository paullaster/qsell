import type { MessageId } from '@/lib/reports/messages';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { DimensionCode } from '../catalogue/dimensions';
import type { ReportDefinition } from './definition';
import type { FamilyCode } from './families';

/**
 * The reports drawn by the generic report page: sales and product analysis, the financial statements and the stock reports.
 * Each is computed by its own executor (`executors/`) from the one definition of a sale or of a ledger balance; the entries
 * here say who may open it, what it measures, how it is proved and where it is documented.
 */

const GUIDE = '15-reports-and-analytics.md';
const NO_TIE_OUT = {
  kind: 'none',
  reason:
    'Counted from orders and order lines with the Business Overview rule for a sale; a reconciliation to the overview is printed on the report itself.',
} as const;

interface Spec {
  code: string;
  /** The message ids: `report.<code with underscores>.title` and `.question`. */
  id: string;
  family: FamilyCode;
  permissions: readonly PermissionKey[];
  measures: readonly string[];
  dimensions: readonly DimensionCode[];
  keywords: readonly string[];
  heading: string;
  /** True when the report shows cost and margin to someone who holds the cost permission. */
  cost?: boolean;
  tieOut?: ReportDefinition['tieOut'];
}

function entry(spec: Spec): ReportDefinition {
  return {
    code: spec.code,
    titleId: `report.${spec.id}.title` as MessageId,
    questionId: `report.${spec.id}.question` as MessageId,
    family: spec.family,
    permissions: spec.permissions,
    ...(spec.cost === true ? { costGatedBy: 'report_profit:read' as const } : {}),
    measures: spec.measures,
    dimensions: spec.dimensions,
    tier: 'live',
    scope: 'both',
    tieOut: spec.tieOut ?? NO_TIE_OUT,
    sensitivity: spec.cost === true ? 'cost' : 'normal',
    exportFormats: ['csv', 'xlsx', 'pdf'],
    maxRows: 500,
    timeoutMs: 30_000,
    keywords: spec.keywords,
    docs: { file: GUIDE, heading: spec.heading },
    view: 'table',
    catalogue: 'complete',
  };
}

const SALES: readonly PermissionKey[] = ['report_sales:read'];
const SALES_AND_COST: readonly PermissionKey[] = ['report_sales:read', 'report_profit:read'];

const CUT_MEASURES = [
  'sales.total',
  'sales.orders',
  'sales.units',
  'profit.gross',
  'profit.margin',
];

export const SALES_REPORTS: readonly ReportDefinition[] = [
  entry({
    code: 'sales-summary',
    id: 'sales_summary',
    family: 'sales',
    permissions: SALES,
    measures: ['sales.total', 'sales.orders', 'sales.average_order', 'sales.tax', 'sales.units'],
    dimensions: ['date'],
    keywords: ['sales', 'daily sales', 'sales trend', 'revenue', 'takings'],
    heading: 'Sales reports',
  }),
  entry({
    code: 'sales-by-product',
    id: 'sales_by_product',
    family: 'sales',
    permissions: SALES,
    measures: CUT_MEASURES,
    dimensions: ['product'],
    keywords: [
      'item sales',
      'top selling',
      'best sellers',
      'best selling products',
      'products sold',
    ],
    heading: 'Sales reports',
    cost: true,
  }),
  entry({
    code: 'sales-by-category',
    id: 'sales_by_category',
    family: 'sales',
    permissions: SALES,
    measures: CUT_MEASURES,
    dimensions: ['category'],
    keywords: ['category sales', 'sales by category', 'product groups', 'range performance'],
    heading: 'Sales reports',
    cost: true,
  }),
  entry({
    code: 'sales-by-vendor',
    id: 'sales_by_vendor',
    family: 'sales',
    permissions: SALES,
    measures: CUT_MEASURES,
    dimensions: ['vendor'],
    keywords: ['sales by supplier', 'sales by vendor', 'supplier performance', 'brands that sell'],
    heading: 'Sales reports',
    cost: true,
  }),
  entry({
    code: 'sales-by-branch',
    id: 'sales_by_branch',
    family: 'sales',
    permissions: SALES,
    measures: CUT_MEASURES,
    dimensions: ['branch'],
    keywords: ['branch sales', 'shop comparison', 'sales by shop', 'outlet performance'],
    heading: 'Sales reports',
    cost: true,
  }),
  entry({
    code: 'sales-by-customer',
    id: 'sales_by_customer',
    family: 'customers',
    permissions: SALES,
    measures: CUT_MEASURES,
    dimensions: ['customer'],
    keywords: ['top customers', 'best customers', 'customer sales', 'who buys most'],
    heading: 'Sales reports',
    cost: true,
  }),
  entry({
    code: 'sales-by-weekday',
    id: 'sales_by_weekday',
    family: 'sales',
    permissions: SALES,
    measures: ['sales.total', 'sales.orders', 'sales.average_order'],
    dimensions: ['date'],
    keywords: ['busiest day', 'weekday sales', 'day of the week', 'best day'],
    heading: 'Sales reports',
  }),
  entry({
    code: 'sales-by-hour',
    id: 'sales_by_hour',
    family: 'pos',
    permissions: SALES,
    measures: ['sales.total', 'sales.orders', 'sales.average_order'],
    dimensions: ['date'],
    keywords: ['busiest hour', 'peak hours', 'rush hour', 'staffing', 'hourly sales'],
    heading: 'Sales reports',
  }),
  entry({
    code: 'returning-customers',
    id: 'returning_customers',
    family: 'customers',
    permissions: SALES,
    measures: [
      'customers.buyers',
      'customers.returning_buyers',
      'customers.returning_share',
      'sales.total',
    ],
    dimensions: ['date', 'branch'],
    keywords: [
      'repeat customers',
      'customer retention',
      'new customers',
      'loyalty',
      'customers coming back',
    ],
    heading: 'Sales reports',
  }),
  entry({
    code: 'sales-returns',
    id: 'sales_returns',
    family: 'sales',
    permissions: SALES,
    measures: ['sales.returns', 'sales.total'],
    dimensions: ['date', 'branch', 'product'],
    keywords: ['returns', 'credit notes', 'refunds', 'goods returned', 'return rate'],
    heading: 'Sales reports',
  }),
  entry({
    code: 'gross-margin',
    id: 'gross_margin',
    family: 'sales',
    permissions: SALES_AND_COST,
    measures: CUT_MEASURES,
    dimensions: ['product'],
    keywords: ['margin', 'profit by product', 'profitability', 'markup', 'selling below cost'],
    heading: 'Sales reports',
    cost: true,
  }),
];

const FINANCIALS: readonly PermissionKey[] = ['report_financials:read'];
const COMPANY_FINANCIALS: readonly PermissionKey[] = [
  'report_financials:read',
  'reports:all_branches',
];
const GL_TIE_OUT = {
  kind: 'gl',
  control: 'Trial balance',
} as const;

const STOCK_NO_TIE_OUT = {
  kind: 'none',
  reason:
    'Read from the stock records as they are now; the stock value is proved against the Business Overview on the report itself.',
} as const;
const INVENTORY: readonly PermissionKey[] = ['report_inventory:read'];
const INVENTORY_AND_COST: readonly PermissionKey[] = [
  'report_inventory:read',
  'report_profit:read',
];

export const INVENTORY_REPORTS: readonly ReportDefinition[] = [
  entry({
    code: 'stock-valuation',
    id: 'stock_valuation',
    family: 'inventory',
    permissions: INVENTORY_AND_COST,
    measures: ['inventory.stock_value'],
    dimensions: ['product', 'category'],
    keywords: [
      'stock value',
      'inventory value',
      'valuation',
      'stock on hand',
      'what is our stock worth',
    ],
    heading: 'Inventory reports',
    cost: true,
    tieOut: STOCK_NO_TIE_OUT,
  }),
  entry({
    code: 'low-stock',
    id: 'low_stock',
    family: 'inventory',
    permissions: INVENTORY,
    measures: ['inventory.out_of_stock', 'inventory.low_stock'],
    dimensions: ['product', 'category'],
    keywords: ['reorder', 'out of stock', 'low stock', 'stock out', 'what to buy', 'replenishment'],
    heading: 'Inventory reports',
    tieOut: STOCK_NO_TIE_OUT,
  }),
  entry({
    code: 'slow-stock',
    id: 'slow_stock',
    family: 'inventory',
    permissions: INVENTORY_AND_COST,
    measures: ['inventory.stock_value'],
    dimensions: ['product', 'category'],
    keywords: [
      'dead stock',
      'slow moving',
      'obsolete stock',
      'not selling',
      'cash tied up',
      'ageing stock',
    ],
    heading: 'Inventory reports',
    cost: true,
    tieOut: STOCK_NO_TIE_OUT,
  }),
  entry({
    code: 'stock-movement',
    id: 'stock_movement',
    family: 'inventory',
    permissions: INVENTORY,
    measures: ['inventory.net_movement'],
    dimensions: ['date', 'product'],
    keywords: [
      'stock movement',
      'stock ledger',
      'goods received',
      'stock adjustments',
      'write offs',
      'shrinkage',
    ],
    heading: 'Inventory reports',
    tieOut: STOCK_NO_TIE_OUT,
  }),
];

export const COLLECTION_REPORTS: readonly ReportDefinition[] = [
  entry({
    code: 'money-collected',
    id: 'money_collected',
    family: 'finance',
    permissions: ['report_collections:read', 'reports:all_branches'],
    measures: ['collections.collected', 'collections.rate', 'collections.tenders'],
    dimensions: ['date', 'payment_method'],
    keywords: [
      'payments received',
      'collections',
      'mpesa collected',
      'how customers paid',
      'takings by method',
    ],
    heading: 'Sales reports',
  }),
];

export const FINANCIAL_REPORTS: readonly ReportDefinition[] = [
  entry({
    code: 'income-statement',
    id: 'income_statement',
    family: 'finance',
    permissions: FINANCIALS,
    measures: ['ledger.net_profit', 'ledger.gross_profit'],
    dimensions: ['date', 'branch'],
    keywords: [
      'profit and loss',
      'income statement',
      'p&l',
      'net profit',
      'gross profit',
      'earnings',
    ],
    heading: 'Financial statements',
    tieOut: GL_TIE_OUT,
  }),
  entry({
    code: 'balance-sheet',
    id: 'balance_sheet',
    family: 'finance',
    permissions: COMPANY_FINANCIALS,
    measures: ['ledger.total_assets', 'ledger.total_equity'],
    dimensions: ['date'],
    keywords: ['balance sheet', 'financial position', 'assets and liabilities', 'net worth'],
    heading: 'Financial statements',
    tieOut: GL_TIE_OUT,
  }),
  entry({
    code: 'changes-in-equity',
    id: 'changes_in_equity',
    family: 'finance',
    permissions: COMPANY_FINANCIALS,
    measures: ['ledger.net_profit', 'ledger.total_equity'],
    dimensions: ['date'],
    keywords: [
      'retained earnings',
      'statement of retained earnings',
      'changes in equity',
      'owners equity',
      'drawings',
    ],
    heading: 'Financial statements',
    tieOut: GL_TIE_OUT,
  }),
  entry({
    code: 'cash-flow',
    id: 'cash_flow',
    family: 'finance',
    permissions: COMPANY_FINANCIALS,
    measures: ['ledger.cash_from_operations', 'ledger.net_profit'],
    dimensions: ['date'],
    keywords: [
      'cash flow',
      'cashflow',
      'cash flow statement',
      'where did the cash go',
      'cash position',
    ],
    heading: 'Financial statements',
    tieOut: GL_TIE_OUT,
  }),
];
