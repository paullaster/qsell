import type { MessageId } from '@/lib/reports/messages';
import type { DimensionCode } from './dimensions';

/**
 * The measure catalogue: the one place a number is defined. A report, a dashboard, an export and the API read a
 * measure from here; none of them invents its own meaning. When a definition changes, its `version` changes and
 * the catalogue version (`version.ts`) moves, so a figure that was saved or printed can be traced to the rules
 * that made it.
 *
 * Every measure says **which document states count**. The rules below are the ones the Business Overview applies
 * today (`queries.ts`); writing them down here does not change a figure, it makes the rule visible and testable.
 */

export type MeasureUnit = 'money' | 'count' | 'percent' | 'days' | 'ratio';

/** How the figure is put together from its rows. `ratio` is always computed from sums, never by averaging averages. */
export type MeasureAggregation = 'sum' | 'count' | 'distinct_count' | 'ratio' | 'snapshot';

export type MeasureSensitivity = 'normal' | 'cost';

/** A status column of a document, and the values that do or do not count. */
export interface StatusRule {
  field: 'status' | 'payment_status' | 'approval_status';
  /** If given, only these values count. */
  counted?: readonly string[];
  /** If given, these values never count. */
  excluded?: readonly string[];
}

/** Which rows of a source count towards a measure. */
export interface StateRule {
  /** The kind of record the rule is about. */
  document:
    | 'order'
    | 'order_line'
    | 'payment_attempt'
    | 'order_tender'
    | 'customer_ledger_entry'
    | 'vendor_ledger_entry'
    | 'credit_note'
    | 'product';
  /** Status conditions on that record. */
  statuses: readonly StatusRule[];
  /** Plain statement of any condition that is not a status (kept short; the words are for implementors, not shoppers). */
  other?: string;
}

export interface MeasureDefinition {
  code: string;
  labelId: MessageId;
  meaningId: MessageId;
  unit: MeasureUnit;
  aggregation: MeasureAggregation;
  /** True when any grouping of the measure sums to the total (money and counts); false for ratios and snapshots of levels. */
  additive: boolean;
  /** For a ratio: the measures it divides. Both must exist and be additive. */
  ratio?: { numerator: string; denominator: string };
  /** The expression in implementor terms. Not shown to shoppers; the meaning above is. */
  formula: string;
  /** The tier this measure is served from today (the design adds rollups in R-1). */
  source: { tier: 'live'; tables: readonly string[] };
  /** Which records count. A measure with an empty list counts every row of its source. */
  rules: readonly StateRule[];
  /** The cuts that make sense. */
  dimensions: readonly DimensionCode[];
  /** `cost` measures reveal product costs and are only returned to someone holding the cost permission. */
  sensitivity: MeasureSensitivity;
  /** Changes when this definition changes. Format `YYYY-MM-vN`. */
  version: string;
}

/** What makes an order a sale (the rule `SALE` in `queries.ts`). */
const COUNTS_AS_SALE: StateRule = {
  document: 'order',
  statuses: [
    { field: 'status', excluded: ['failed', 'cancelled', 'refunded'] },
    { field: 'payment_status', excluded: ['failed'] },
    { field: 'approval_status', excluded: ['rejected', 'draft'] },
  ],
  other:
    'An order that is still unpaid counts only when it was placed by a trade (credit) customer. An unpaid shop checkout is an abandoned cart, not a sale.',
};

const SALES_DIMENSIONS = [
  'date',
  'branch',
  'channel',
  'sales_type',
  'customer',
  'customer_group',
  'product',
  'category',
  'brand',
  'salesperson',
  'payment_method',
  'delivery_zone',
  'vendor',
] as const satisfies readonly DimensionCode[];

const V = '2026-11-v1';

const defs: readonly MeasureDefinition[] = [
  // ---- sales ----
  {
    code: 'sales.total',
    labelId: 'measure.sales.total.label',
    meaningId: 'measure.sales.total.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula: 'sum(orders.total_amount) over orders that count as a sale, in the business currency',
    source: { tier: 'live', tables: ['orders'] },
    rules: [COUNTS_AS_SALE],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'sales.orders',
    labelId: 'measure.sales.orders.label',
    meaningId: 'measure.sales.orders.meaning',
    unit: 'count',
    aggregation: 'count',
    additive: true,
    formula: 'count(orders) over orders that count as a sale',
    source: { tier: 'live', tables: ['orders'] },
    rules: [COUNTS_AS_SALE],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'sales.average_order',
    labelId: 'measure.sales.average_order.label',
    meaningId: 'measure.sales.average_order.meaning',
    unit: 'money',
    aggregation: 'ratio',
    additive: false,
    ratio: { numerator: 'sales.total', denominator: 'sales.orders' },
    formula: 'sales.total / sales.orders, zero when there are no orders',
    source: { tier: 'live', tables: ['orders'] },
    rules: [COUNTS_AS_SALE],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'sales.tax',
    labelId: 'measure.sales.tax.label',
    meaningId: 'measure.sales.tax.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula: 'sum(orders.tax) over orders that count as a sale',
    source: { tier: 'live', tables: ['orders'] },
    rules: [COUNTS_AS_SALE],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'normal',
    version: V,
  },

  // ---- collections ----
  {
    code: 'collections.collected',
    labelId: 'measure.collections.collected.label',
    meaningId: 'measure.collections.collected.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula:
      'sum(payment_attempts.amount) of successful attempts by paid_at, plus gateway transactions for orders with no successful attempt',
    source: { tier: 'live', tables: ['payment_attempts', 'payment_transactions'] },
    rules: [
      {
        document: 'payment_attempt',
        statuses: [{ field: 'status', counted: ['successful'] }],
        other:
          'An older gateway transaction counts only when its order has no successful attempt, so nothing is counted twice.',
      },
    ],
    dimensions: ['date', 'branch', 'payment_method'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'collections.rate',
    labelId: 'measure.collections.rate.label',
    meaningId: 'measure.collections.rate.meaning',
    unit: 'percent',
    aggregation: 'ratio',
    additive: false,
    ratio: { numerator: 'collections.collected', denominator: 'sales.total' },
    formula:
      '100 * collections.collected / sales.total over the same period, empty when there are no sales',
    source: { tier: 'live', tables: ['payment_attempts', 'payment_transactions', 'orders'] },
    rules: [],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'collections.tenders',
    labelId: 'measure.collections.tenders.label',
    meaningId: 'measure.collections.tenders.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula: 'sum(order_tenders.amount) by creation date',
    source: { tier: 'live', tables: ['order_tenders', 'orders'] },
    rules: [],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },

  // ---- profit (reveals product cost) ----
  {
    code: 'profit.gross',
    labelId: 'measure.profit.gross.label',
    meaningId: 'measure.profit.gross.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula:
      'sum(order_items.total_price) - sum(order_items.unit_cost * order_items.quantity) over lines with a recorded unit cost',
    source: { tier: 'live', tables: ['orders', 'order_items'] },
    rules: [
      COUNTS_AS_SALE,
      {
        document: 'order_line',
        statuses: [],
        other: 'Only lines with a recorded unit cost count towards profit.',
      },
    ],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'cost',
    version: V,
  },
  {
    code: 'profit.margin',
    labelId: 'measure.profit.margin.label',
    meaningId: 'measure.profit.margin.meaning',
    unit: 'percent',
    aggregation: 'ratio',
    additive: false,
    ratio: { numerator: 'profit.gross', denominator: 'profit.known_revenue' },
    formula: '100 * profit.gross / revenue of lines with a recorded unit cost',
    source: { tier: 'live', tables: ['orders', 'order_items'] },
    rules: [COUNTS_AS_SALE],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'cost',
    version: V,
  },
  {
    code: 'profit.known_revenue',
    labelId: 'measure.profit.known_revenue.label',
    meaningId: 'measure.profit.known_revenue.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula: 'sum(order_items.total_price) over lines with a recorded unit cost',
    source: { tier: 'live', tables: ['orders', 'order_items'] },
    rules: [COUNTS_AS_SALE],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'cost',
    version: V,
  },
  {
    code: 'profit.cost_coverage',
    labelId: 'measure.profit.cost_coverage.label',
    meaningId: 'measure.profit.cost_coverage.meaning',
    unit: 'percent',
    aggregation: 'ratio',
    additive: false,
    ratio: { numerator: 'profit.known_revenue', denominator: 'profit.all_revenue' },
    formula: '100 * revenue of lines with a recorded unit cost / revenue of all lines',
    source: { tier: 'live', tables: ['orders', 'order_items'] },
    rules: [COUNTS_AS_SALE],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'cost',
    version: V,
  },
  {
    code: 'profit.all_revenue',
    labelId: 'measure.profit.all_revenue.label',
    meaningId: 'measure.profit.all_revenue.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula: 'sum(order_items.total_price) over all lines of orders that count as a sale',
    source: { tier: 'live', tables: ['orders', 'order_items'] },
    rules: [COUNTS_AS_SALE],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'cost',
    version: V,
  },

  // ---- receivables ----
  {
    code: 'receivables.outstanding',
    labelId: 'measure.receivables.outstanding.label',
    meaningId: 'measure.receivables.outstanding.meaning',
    unit: 'money',
    aggregation: 'snapshot',
    additive: true,
    formula: 'sum(customer_ledger_entries.remaining_amount) where remaining_amount > 0, as of now',
    source: { tier: 'live', tables: ['customer_ledger_entries'] },
    rules: [
      {
        document: 'customer_ledger_entry',
        statuses: [],
        other:
          'Entries with something still unpaid. A branch view takes the branch of the order the entry came from.',
      },
    ],
    dimensions: ['branch', 'customer', 'customer_group'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'receivables.overdue',
    labelId: 'measure.receivables.overdue.label',
    meaningId: 'measure.receivables.overdue.meaning',
    unit: 'money',
    aggregation: 'snapshot',
    additive: true,
    formula:
      'sum(customer_ledger_entries.remaining_amount) where remaining_amount > 0 and due_date < now',
    source: { tier: 'live', tables: ['customer_ledger_entries'] },
    rules: [
      {
        document: 'customer_ledger_entry',
        statuses: [],
        other: 'Entries with something still unpaid and a due date in the past.',
      },
    ],
    dimensions: ['branch', 'customer', 'customer_group'],
    sensitivity: 'normal',
    version: V,
  },

  // ---- payables ----
  {
    code: 'payables.outstanding',
    labelId: 'measure.payables.outstanding.label',
    meaningId: 'measure.payables.outstanding.meaning',
    unit: 'money',
    aggregation: 'snapshot',
    additive: true,
    formula:
      "sum(vendor_ledger_entries.remaining_amount) where document_type = 'invoice' and remaining_amount > 0, as of a date",
    source: { tier: 'live', tables: ['vendor_ledger_entries'] },
    rules: [
      {
        document: 'vendor_ledger_entry',
        statuses: [],
        other:
          'Supplier invoices with something still unpaid. Payments and credits not yet set against an invoice are shown apart, never netted.',
      },
    ],
    dimensions: ['vendor'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'payables.overdue',
    labelId: 'measure.payables.overdue.label',
    meaningId: 'measure.payables.overdue.meaning',
    unit: 'money',
    aggregation: 'snapshot',
    additive: true,
    formula:
      'sum(vendor_ledger_entries.remaining_amount) of unpaid supplier invoices more than 0 days past due (invoice date when there is no due date), as of a date',
    source: { tier: 'live', tables: ['vendor_ledger_entries'] },
    rules: [
      {
        document: 'vendor_ledger_entry',
        statuses: [],
        other:
          'Unpaid supplier invoices past their due date, or past their invoice date when no due date was given.',
      },
    ],
    dimensions: ['vendor'],
    sensitivity: 'normal',
    version: V,
  },

  {
    code: 'sales.units',
    labelId: 'measure.sales.units.label',
    meaningId: 'measure.sales.units.meaning',
    unit: 'count',
    aggregation: 'sum',
    additive: true,
    formula:
      'sum(order_items.quantity) over the lines of orders that count as a sale, free gifts left out',
    source: { tier: 'live', tables: ['orders', 'order_items'] },
    rules: [
      COUNTS_AS_SALE,
      { document: 'order_line', statuses: [], other: 'Free gift lines are not counted.' },
    ],
    dimensions: SALES_DIMENSIONS,
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'sales.returns',
    labelId: 'measure.sales.returns.label',
    meaningId: 'measure.sales.returns.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula:
      'sum(credit_notes.total_amount) issued in the period, by the date the credit note was issued',
    source: { tier: 'live', tables: ['credit_notes', 'credit_note_lines'] },
    rules: [
      {
        document: 'credit_note',
        statuses: [],
        other: 'Every credit note issued in the period, in the business currency.',
      },
    ],
    dimensions: ['date', 'branch', 'product'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'customers.buyers',
    labelId: 'measure.customers.buyers.label',
    meaningId: 'measure.customers.buyers.meaning',
    unit: 'count',
    aggregation: 'distinct_count',
    additive: false,
    formula:
      'count(distinct customer) over orders that count as a sale; a customer is the trade customer, shopper, phone or email the order names',
    source: { tier: 'live', tables: ['orders'] },
    rules: [COUNTS_AS_SALE],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'customers.returning_buyers',
    labelId: 'measure.customers.returning_buyers.label',
    meaningId: 'measure.customers.returning_buyers.meaning',
    unit: 'count',
    aggregation: 'distinct_count',
    additive: false,
    formula:
      'count(distinct customer) whose first sale ever is before the period, among those who bought in it',
    source: { tier: 'live', tables: ['orders'] },
    rules: [COUNTS_AS_SALE],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'customers.returning_share',
    labelId: 'measure.customers.returning_share.label',
    meaningId: 'measure.customers.returning_share.meaning',
    unit: 'percent',
    aggregation: 'snapshot',
    additive: false,
    formula:
      '100 * customers.returning_buyers / customers.buyers, worked out on the distinct customers of the whole period (a share of people cannot be added up across groups), empty when no one bought',
    source: { tier: 'live', tables: ['orders'] },
    rules: [],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },

  // ---- stock movement ----
  {
    code: 'inventory.net_movement',
    labelId: 'measure.inventory.net_movement.label',
    meaningId: 'measure.inventory.net_movement.meaning',
    unit: 'count',
    aggregation: 'sum',
    additive: true,
    formula:
      'sum(stock_movements.quantity) in the period, transfers between locations and cost revaluations left out',
    source: { tier: 'live', tables: ['stock_movements', 'products'] },
    rules: [],
    dimensions: ['date', 'product'],
    sensitivity: 'normal',
    version: V,
  },
  // ---- ledger (financial statements) ----
  {
    code: 'ledger.net_profit',
    labelId: 'measure.ledger.net_profit.label',
    meaningId: 'measure.ledger.net_profit.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula:
      'minus the net debit of every income, cost of sales and expense account, by posting date, in the base currency',
    source: { tier: 'live', tables: ['gl_entries', 'gl_account_balances', 'gl_accounts'] },
    rules: [],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'ledger.gross_profit',
    labelId: 'measure.ledger.gross_profit.label',
    meaningId: 'measure.ledger.gross_profit.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula: 'net sales minus cost of sales, from the ledger, by posting date',
    source: { tier: 'live', tables: ['gl_entries', 'gl_account_balances', 'gl_accounts'] },
    rules: [],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'ledger.total_assets',
    labelId: 'measure.ledger.total_assets.label',
    meaningId: 'measure.ledger.total_assets.meaning',
    unit: 'money',
    aggregation: 'snapshot',
    additive: false,
    formula: 'the net debit of every asset account as at a date',
    source: { tier: 'live', tables: ['gl_entries', 'gl_account_balances', 'gl_accounts'] },
    rules: [],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'ledger.total_equity',
    labelId: 'measure.ledger.total_equity.label',
    meaningId: 'measure.ledger.total_equity.meaning',
    unit: 'money',
    aggregation: 'snapshot',
    additive: false,
    formula: 'equity accounts plus profit not yet closed to retained earnings, as at a date',
    source: { tier: 'live', tables: ['gl_entries', 'gl_account_balances', 'gl_accounts'] },
    rules: [],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'ledger.cash_from_operations',
    labelId: 'measure.ledger.cash_from_operations.label',
    meaningId: 'measure.ledger.cash_from_operations.meaning',
    unit: 'money',
    aggregation: 'sum',
    additive: true,
    formula:
      'net profit adjusted for non-cash items and changes in working capital, by the indirect method',
    source: { tier: 'live', tables: ['gl_entries', 'gl_account_balances', 'gl_accounts'] },
    rules: [],
    dimensions: ['date', 'branch'],
    sensitivity: 'normal',
    version: V,
  },

  // ---- inventory ----
  {
    code: 'inventory.stock_value',
    labelId: 'measure.inventory.stock_value.label',
    meaningId: 'measure.inventory.stock_value.meaning',
    unit: 'money',
    aggregation: 'snapshot',
    additive: true,
    formula:
      'sum(greatest(products.stock_quantity, 0) * products.cost_price) over active, undeleted products',
    source: { tier: 'live', tables: ['products'] },
    rules: [
      {
        document: 'product',
        statuses: [],
        other:
          'Active products that are not deleted and hold stock (the inventory kind). Stock is held for the whole company, so a branch view does not narrow it.',
      },
    ],
    dimensions: ['product', 'category', 'brand'],
    sensitivity: 'cost',
    version: V,
  },
  {
    code: 'inventory.out_of_stock',
    labelId: 'measure.inventory.out_of_stock.label',
    meaningId: 'measure.inventory.out_of_stock.meaning',
    unit: 'count',
    aggregation: 'snapshot',
    additive: true,
    formula: 'count(products) where stock_quantity - reserved_quantity <= 0',
    source: { tier: 'live', tables: ['products'] },
    rules: [
      {
        document: 'product',
        statuses: [],
        other: 'Active products that are not deleted and hold stock (the inventory kind). A service or non-stock item is never out of stock.',
      },
    ],
    dimensions: ['product', 'category', 'brand'],
    sensitivity: 'normal',
    version: V,
  },
  {
    code: 'inventory.low_stock',
    labelId: 'measure.inventory.low_stock.label',
    meaningId: 'measure.inventory.low_stock.meaning',
    unit: 'count',
    aggregation: 'snapshot',
    additive: true,
    formula: 'count(products) where 0 < stock_quantity - reserved_quantity <= low_stock_threshold',
    source: { tier: 'live', tables: ['products'] },
    rules: [
      {
        document: 'product',
        statuses: [],
        other: 'Active products that are not deleted and hold stock (the inventory kind). A service or non-stock item is never out of stock.',
      },
    ],
    dimensions: ['product', 'category', 'brand'],
    sensitivity: 'normal',
    version: V,
  },
];

export const MEASURES: Readonly<Record<string, MeasureDefinition>> = Object.fromEntries(
  defs.map((d) => [d.code, d]),
);

export const MEASURE_CODES: readonly string[] = defs.map((d) => d.code);

export function measure(code: string): MeasureDefinition | undefined {
  return MEASURES[code];
}

export function isMeasureCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(MEASURES, code);
}
