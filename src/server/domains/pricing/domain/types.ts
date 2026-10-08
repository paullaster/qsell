/**
 * Pricing vocabulary. Dependency-free so the engine, the service, the schema and the screens all
 * share it. See docs/architecture/pricing-module.md.
 */

/** The ways a price list can be limited. Each is a dimension of the sale being priced. */
export const SCOPE_DIMENSIONS = [
  'customer',
  'customer_group',
  'route',
  'branch',
  'sales_type',
  'channel',
  'country',
] as const;
export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

export const SCOPE_LABELS: Record<ScopeDimension, string> = {
  customer: 'Customer',
  customer_group: 'Customer group',
  route: 'Route',
  branch: 'Branch',
  sales_type: 'Sales type',
  channel: 'Channel',
  country: 'Country',
};

export interface ScopeRule {
  /** `in`: the sale must match one of the values. `not_in`: it must match none of them. */
  op: 'in' | 'not_in';
  values: string[];
}
export type Scopes = Partial<Record<ScopeDimension, ScopeRule>>;

/** Sales types a price list can be scoped to. */
export const SALES_TYPES = ['cash', 'credit'] as const;
/** Channels a price list can be scoped to (the invoicing module the sale belongs to). */
export const CHANNELS = ['ecommerce', 'sales_order', 'credit_sale', 'pos_cash_sale'] as const;

export type QuantityMode = 'all_units' | 'incremental';
export type PriceListKind = 'list' | 'contract';
export type PriceListStatus = 'draft' | 'active' | 'retired';

/**
 * How much each dimension counts towards specificity. A list's specificity is the sum of the
 * weights of the dimensions it limits with `in`, plus the contract weight for a contract. The
 * defaults are powers of two in the agreed order, so one higher dimension always beats any
 * combination of lower ones; a business can change them (some rank route above group).
 */
export type SpecificityWeights = Record<ScopeDimension | 'contract', number>;
export const DEFAULT_WEIGHTS: SpecificityWeights = {
  contract: 1000,
  customer: 64,
  customer_group: 32,
  route: 16,
  branch: 8,
  sales_type: 4,
  channel: 2,
  country: 1,
};

export interface Tier {
  fromQty: number;
  price: number;
}

export interface PriceListHeader {
  id: string;
  code: string;
  name: string;
  kind: PriceListKind;
  currency: string;
  taxInclusive: boolean;
  quantityMode: QuantityMode;
  priority: number;
  validFrom: Date;
  validTo: Date | null;
  scopes: Scopes;
  version: number;
}

export interface PriceListLine {
  id: string;
  priceListId: string;
  productId: string;
  price: number;
  tiers: Tier[];
  floorPrice: number | null;
  lockedUntil: Date | null;
  validFrom: Date;
  validTo: Date | null;
}

/** What is known about the sale being priced. Missing values simply do not match a scope. */
export interface PriceContext {
  at: Date;
  currency: string;
  /** The company's base currency and the rate that turns a base price into `currency`. */
  baseCurrency: string;
  rateFromBase: number;
  decimals: number;
  customerId?: string | null;
  /** The customer's winning group (highest priority), already chosen. */
  customerGroupId?: string | null;
  route?: string | null;
  branchId?: string | null;
  salesType?: string | null;
  channel?: string | null;
  country?: string | null;
}

export interface PriceItemInput {
  productId: string;
  quantity: number;
  /** The product's standard price, in the product's own tax basis. Null when it has none. */
  standardPrice: number | null;
  taxRate: number;
  /** The tax basis the document line is kept in; the result is expressed in it. */
  lineTaxInclusive: boolean;
  /** The basis the standard price is held in. */
  standardTaxInclusive: boolean;
}

export type CandidateOutcome = 'won' | 'lost' | 'not_applicable';

export interface TraceCandidate {
  source: 'price_list' | 'standard';
  listId?: string;
  listCode?: string;
  listVersion?: number;
  lineId?: string;
  specificity: number;
  priority: number;
  outcome: CandidateOutcome;
  /** Plain language: why it won, lost or did not apply. */
  why: string;
}

/** The recorded explanation of a price. Stored on the document line. */
export interface PriceTrace {
  engineVersion: 1;
  at: string;
  inputs: {
    productId: string;
    quantity: number;
    currency: string;
    customerId?: string | null;
    customerGroupId?: string | null;
    branchId?: string | null;
    salesType?: string | null;
    channel?: string | null;
    route?: string | null;
    country?: string | null;
  };
  candidates: TraceCandidate[];
  /** Plain-language steps, in order, ending in the price. */
  steps: string[];
  source: 'price_list' | 'standard' | 'none';
  /** Set when a price list line won. */
  winner?: {
    listId: string;
    listCode: string;
    listVersion: number;
    lineId: string;
    /** A contract price is not reduced by promotions unless a rule says so. */
    listKind?: PriceListKind;
  };
  /** What the discount rules did to this line's price, once they have been applied. */
  discounts?: DiscountTrace;
  /** Set on a component line made from a kit: which kit, how many were sold, and what they came to. */
  kit?: { productId: string; name: string; quantity: number; total: number };
  unitPrice: number | null;
  lineTotal: number | null;
  /** Set when the price is below the line's floor (a soft floor: needs a decision elsewhere). */
  floorPrice?: number | null;
  belowFloor?: boolean;
  /** What the price floor and override limit checks found, once a document has been checked. */
  guard?: GuardTrace;
}

export interface PriceResult {
  /** Null when the line cannot be priced; never a silent zero. */
  unitPrice: number | null;
  lineTotal: number | null;
  trace: PriceTrace;
}

// ── Price floors and override limits ─────────────────────────────────────────

/** What a floor rule is attached to. */
export const FLOOR_SCOPE_TYPES = [
  'product',
  'product_group',
  'brand',
  'category',
  'default',
] as const;
export type FloorScopeType = (typeof FLOOR_SCOPE_TYPES)[number];
/** 'approval': below the floor needs approval. 'block': below the floor is refused. */
export type FloorEnforcement = 'approval' | 'block';

export interface FloorRule {
  id: string;
  scopeType: FloorScopeType;
  scopeRef: string;
  markupPercent: number;
  enforcement: FloorEnforcement;
}

/** A product as the floor needs to see it. */
export interface FloorProduct {
  id: string;
  costPrice: number;
  brand: string | null;
  /** The product's category first, then each category above it. */
  categoryChain: string[];
  groupIds: string[];
}

export interface FloorResult {
  /** The lowest net (before tax) unit price, or null when no rule applies or the cost is unknown. */
  floorNet: number | null;
  rule: FloorRule | null;
  /** Why there is no floor, when there is a rule but no cost to work from. */
  note: string | null;
  /** Where the floor came from, in words. */
  source: string | null;
}

/** What the guard recorded about a line, kept in its price explanation. */
export interface GuardTrace {
  floorNet: number | null;
  floorSource: string | null;
  floorKind: 'rule' | 'price_list' | null;
  belowFloor: boolean;
  shortfallPercent: number;
  enforcement: FloorEnforcement | null;
  /** What the price list said this unit costs, before the reduction, net of tax. */
  listNetUnit: number | null;
  overridePercent: number;
  overrideLimitPercent: number | null;
  overOverrideLimit: boolean;
}

/** What the discount rules did to a line, kept in its price explanation. */
export interface DiscountTrace {
  /** The price before any discount, as the price list or standard price gave it. */
  unitPriceBefore: number;
  lineTotalBefore: number;
  applied: Array<{
    ruleId: string;
    code: string;
    name: string;
    level: 'line' | 'order';
    amount: number;
    how: string;
    couponCode?: string;
  }>;
  /** Taken back because the line would have gone below its floor. */
  trimmed: number;
  /** Rules that were looked at and why they did or did not apply. */
  considered: Array<{ code: string; outcome: string; why: string }>;
}
