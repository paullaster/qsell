export interface TriggerField {
  path: string;
  label: string;
  type: 'number' | 'text' | 'boolean';
}

export interface TriggerDefinition {
  code: string;
  module: string;
  /** What approver limits are kept per. */
  documentKind: string;
  label: string;
  fields: TriggerField[];
}

const common: TriggerField[] = [
  { path: 'amount', label: 'Amount (base currency)', type: 'number' },
  { path: 'branchId', label: 'Branch', type: 'text' },
  { path: 'requestedBy', label: 'Requested by', type: 'text' },
];

/**
 * The points where a module asks for approval. A developer adds one when a module gains a new
 * place to ask; what happens at it (conditions, steps, approvers) is entirely configuration.
 */
export const TRIGGERS: TriggerDefinition[] = [
  {
    code: 'sales_order.submitted',
    module: 'sales',
    documentKind: 'sales_order',
    label: 'Sales order submitted',
    fields: [
      ...common,
      { path: 'discountPercent', label: 'Largest line discount %', type: 'number' },
      { path: 'orderDiscountPercent', label: 'Whole-order discount %', type: 'number' },
      { path: 'belowFloor', label: 'Any line below its price floor', type: 'boolean' },
      {
        path: 'floorShortfallPercent',
        label: 'Biggest shortfall under a price floor %',
        type: 'number',
      },
      { path: 'customer.id', label: 'Customer', type: 'text' },
      { path: 'customer.accountType', label: 'Customer account type', type: 'text' },
      {
        path: 'customer.overCreditLimit',
        label: 'Over the customer credit limit',
        type: 'boolean',
      },
      { path: 'customer.isBlocked', label: 'Customer blocked', type: 'boolean' },
      { path: 'salesModule', label: 'Sales channel', type: 'text' },
    ],
  },
  {
    code: 'sales_quote.submitted',
    module: 'sales',
    documentKind: 'sales_quote',
    label: 'Quote submitted',
    fields: [
      ...common,
      { path: 'discountPercent', label: 'Largest line discount %', type: 'number' },
      { path: 'quoteDiscountPercent', label: 'Whole-quote discount %', type: 'number' },
      { path: 'marginPercent', label: 'Gross margin %', type: 'number' },
      { path: 'belowFloor', label: 'Margin below the company floor', type: 'boolean' },
      { path: 'belowPriceFloor', label: 'Any line below its price floor', type: 'boolean' },
      {
        path: 'floorShortfallPercent',
        label: 'Biggest shortfall under a price floor %',
        type: 'number',
      },
      { path: 'overridePercent', label: 'Biggest price reduction from list %', type: 'number' },
      {
        path: 'overrideOverLimit',
        label: 'A price reduction beyond the requester’s limit',
        type: 'boolean',
      },
      { path: 'customer.id', label: 'Customer', type: 'text' },
    ],
  },
  {
    code: 'credit_note.requested',
    module: 'finance',
    documentKind: 'credit_note',
    label: 'Credit note requested',
    fields: [
      ...common,
      { path: 'reasonCode', label: 'Reason', type: 'text' },
      { path: 'isFullReturn', label: 'Credits the whole invoice', type: 'boolean' },
    ],
  },
  {
    code: 'refund.payout',
    module: 'finance',
    documentKind: 'refund',
    label: 'Refund to a customer',
    fields: [
      ...common,
      { path: 'reasonCode', label: 'Reason', type: 'text' },
      { path: 'methodKind', label: 'How it is paid (cash, mobile money, bank, cheque)', type: 'text' },
      { path: 'source', label: 'What it is owed from (credit note, wallet, receipt)', type: 'text' },
      { path: 'destinationChanged', label: 'Paid somewhere other than the customer\'s recorded details', type: 'boolean' },
      { path: 'customer.id', label: 'Customer', type: 'text' },
    ],
  },
  {
    code: 'credit_adjustment.requested',
    module: 'finance',
    documentKind: 'credit_adjustment',
    label: 'Customer credit given up, added or taken off',
    fields: [
      ...common,
      { path: 'kind', label: 'What it does (waive_excess, wallet_increase, wallet_decrease)', type: 'text' },
      { path: 'reasonCode', label: 'Reason', type: 'text' },
      { path: 'customer.id', label: 'Customer', type: 'text' },
    ],
  },
  {
    code: 'provider.disbursement',
    module: 'finance',
    documentKind: 'provider_operation',
    label: 'Payout through a payment provider',
    fields: [
      ...common,
      { path: 'operation', label: 'Kind of payout (b2c, b2pochi, b2c_topup, reversal, b2b_paybill, b2b_buygoods, tax_remittance)', type: 'text' },
      { path: 'providerId', label: 'Provider', type: 'text' },
    ],
  },
  {
    code: 'stock_adjustment.submitted',
    module: 'inventory',
    documentKind: 'stock_adjustment',
    label: 'Stock adjustment submitted',
    fields: [
      ...common,
      { path: 'quantity', label: 'Quantity change', type: 'number' },
      { path: 'percentOfOnHand', label: 'Change as % of on-hand', type: 'number' },
      { path: 'reasonCode', label: 'Reason', type: 'text' },
    ],
  },
  {
    code: 'customer.credit_limit_changed',
    module: 'sales',
    documentKind: 'customer_credit_limit',
    label: 'Customer credit limit changed',
    fields: [
      ...common,
      { path: 'newLimit', label: 'New limit', type: 'number' },
      { path: 'oldLimit', label: 'Old limit', type: 'number' },
    ],
  },
  {
    code: 'price_list.publish',
    module: 'sales',
    documentKind: 'price_list',
    label: 'Price list published',
    fields: [...common, { path: 'changedLines', label: 'Lines changed', type: 'number' }],
  },
  {
    code: 'discount_rule.publish',
    module: 'sales',
    documentKind: 'discount_rule',
    label: 'Discount rule put in force',
    fields: [
      ...common,
      { path: 'ruleKind', label: 'Kind (line or order)', type: 'text' },
      { path: 'rewardPercent', label: 'Largest percentage given', type: 'number' },
      { path: 'budget', label: 'Budget (0 if none)', type: 'number' },
      { path: 'hasEndDate', label: 'Has an end date', type: 'boolean' },
      { path: 'requiresCoupon', label: 'Needs a coupon code', type: 'boolean' },
      {
        path: 'projectedGiveaway',
        label: 'Projected give-away over the last 90 days of sales (0 if not estimated)',
        type: 'number',
      },
      { path: 'projectedYearly', label: 'Projected give-away over a year', type: 'number' },
      {
        path: 'marginAfterPercent',
        label: 'Margin % on the covered sales after it (0 if unknown)',
        type: 'number',
      },
    ],
  },
  {
    code: 'rebate.settle',
    module: 'sales',
    documentKind: 'rebate_settlement',
    label: 'Rebate paid to a customer',
    fields: [
      ...common,
      { path: 'programCode', label: 'Rebate programme', type: 'text' },
      { path: 'periodKey', label: 'Period', type: 'text' },
      { path: 'basis', label: 'Purchases counted', type: 'number' },
      { path: 'percent', label: 'Rebate % reached', type: 'number' },
    ],
  },
  {
    code: 'price_list.live_change',
    module: 'sales',
    documentKind: 'price_list_change',
    label: 'Price change on a list in force',
    fields: [
      ...common,
      { path: 'changedLines', label: 'Prices changed', type: 'number' },
      { path: 'largestRisePercent', label: 'Largest price rise %', type: 'number' },
      { path: 'largestCutPercent', label: 'Largest price cut %', type: 'number' },
      { path: 'newProducts', label: 'Products newly priced', type: 'number' },
      { path: 'removesPrices', label: 'Stops pricing products', type: 'boolean' },
      { path: 'headerChange', label: 'Changes who or when the list applies', type: 'boolean' },
      { path: 'listKind', label: 'List kind (list or contract)', type: 'text' },
      { path: 'listCode', label: 'List code', type: 'text' },
    ],
  },
];

export const DOCUMENT_KIND_LABELS: Record<string, string> = {
  sales_order: 'Sales orders',
  sales_quote: 'Quotes',
  credit_note: 'Credit notes',
  refund: 'Refunds',
  stock_adjustment: 'Stock adjustments',
  customer_credit_limit: 'Customer credit limits',
  price_list: 'Price lists',
  price_list_change: 'Price changes',
  discount_rule: 'Discount rules',
  rebate_settlement: 'Rebate payments',
  provider_operation: 'Payments sent out through a provider',
};

export const MODULE_LABELS: Record<string, string> = {
  sales: 'Sales',
  finance: 'Finance',
  inventory: 'Inventory',
};

export function triggerByCode(code: string): TriggerDefinition | undefined {
  return TRIGGERS.find((t) => t.code === code);
}
