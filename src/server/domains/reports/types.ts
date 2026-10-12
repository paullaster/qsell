import type { ResolvedPeriod } from './period';

/** Bump when a definition below changes, so a saved number can be traced to the rules that made it. */
export const OVERVIEW_DEFINITIONS_VERSION = '2026-10-v2';

export type ReportScope =
  { kind: 'all' } | { kind: 'branch'; branchId: string; branchName: string } | { kind: 'none' };

export interface Comparison {
  current: number;
  previous: number;
  /** Percent change; null when there is nothing in the previous period to compare with. */
  changePct: number | null;
}

export interface SalesSummary {
  orders: Comparison;
  sales: Comparison;
  averageOrder: Comparison;
  tax: Comparison;
  /** Sales per local day across the period (zero-filled), with the same-position day of the comparison period. */
  trend: {
    date: string;
    sales: number;
    orders: number;
    previousDate: string;
    previousSales: number;
  }[];
  /** Where every order placed in the period ended up; the first three buckets are the sales figure. */
  flow: {
    key: string;
    label: string;
    hint: string;
    count: number;
    value: number;
    countsAsSale: boolean;
  }[];
  /** Only for company-wide viewers with more than one branch. */
  byBranch:
    | {
        branchId: string;
        name: string;
        sales: number;
        orders: number;
        sharePct: number;
        changePct: number | null;
      }[]
    | null;
  topProducts: { productId: string; name: string; revenue: number; units: number }[];
}

export interface CollectionMethod {
  providerCode: string;
  name: string;
  amount: number;
  count: number;
  /** Share of everything collected in the period, 0–100. */
  sharePct: number;
}

export type CollectionsSummary =
  | {
      configured: true;
      collected: Comparison;
      /** Collected as a share of sales in the same period; null when there were no sales. */
      collectionRatePct: number | null;
      /** Payments started but not confirmed, and ones that failed, in the period. */
      inFlight: { pendingCount: number; pendingAmount: number; failedCount: number };
      methods: CollectionMethod[];
      /** Settled through providers that are no longer enabled or configured. Kept so totals reconcile. */
      unconfigured: { amount: number; count: number; providers: string[] };
      /** Redeemed gift cards and loyalty points (store-credit tenders), outside the gateways. */
      tenders: { amount: number; count: number };
    }
  | { configured: false; setupHref: string };

export interface ProfitSummary {
  grossProfit: Comparison;
  marginPct: number | null;
  /** Share of sales value whose product cost is known; margin is only about that share. */
  costCoveragePct: number | null;
}

export interface ReceivablesSummary {
  outstanding: number;
  overdue: number;
  overdueCustomers: number;
  aging: { label: string; amount: number }[];
  topDebtors: { customerId: string; name: string; overdue: number; outstanding: number }[];
}

export interface InventorySummary {
  activeProducts: number;
  outOfStock: number;
  lowStock: number;
  stockValueAtCost: number;
}

export interface AttentionItem {
  key: string;
  label: string;
  count: number;
  href: string;
  tone: 'critical' | 'warning';
}

export interface BusinessOverview {
  meta: {
    /** The moment the data was read. The numbers are the state of the database at this instant. */
    asOf: string;
    period: {
      preset: string;
      label: string;
      timeZone: string;
      from: string;
      to: string;
      fromDate: string;
      toDate: string;
      previousFrom: string;
      previousTo: string;
      previousFromDate: string;
      previousToDate: string;
      notice: string | null;
    };
    scope: { kind: ReportScope['kind']; label: string; branchId: string | null };
    compare: { mode: string; label: string };
    /** Date of the most recent order in scope (any time), so an empty period can point at real activity. */
    lastActivityDate: string | null;
    baseCurrency: string;
    /** Orders etc. in other currencies are not converted, only counted here. */
    otherCurrencies: { currency: string; orders: number }[];
    definitionsVersion: string;
    /** Sections the user may see, in the order shown. Anything else was never computed. */
    sections: string[];
    /** Sections the user may see whose data could not be read just now (shown with a retry, never hidden). */
    failedSections: string[];
    cached: boolean;
  };
  /** Plain-language answer to "how are we doing", built only from sections the viewer may see. */
  headline: string[];
  branches: { id: string; name: string }[] | null;
  attention: AttentionItem[];
  sales: SalesSummary | null;
  collections: CollectionsSummary | null;
  profit: ProfitSummary | null;
  receivables: ReceivablesSummary | null;
  inventory: InventorySummary | null;
}

export type { ResolvedPeriod };
