import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, currencies, users } from '@/server/db/drizzle/schema';
import type { AccessControlService } from '@/server/domains/access-control/engine';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { buildHeadline } from './headline';
import {
  COMPARE_LABELS,
  listDays,
  resolvePeriod,
  type PeriodInput,
  type ResolvedPeriod,
} from './period';
import * as q from './queries';
import {
  OVERVIEW_DEFINITIONS_VERSION,
  type AttentionItem,
  type BusinessOverview,
  type CollectionsSummary,
  type Comparison,
  type ProfitSummary,
  type ReceivablesSummary,
  type ReportScope,
  type SalesSummary,
} from './types';

const DEFAULT_BASE_CURRENCY = 'KES';
const MAX_BRANCH_ROWS = 10;
/** Dashboards are opened by many people at once; identical requests within this window share one read. */
const CACHE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 200;

const PROVIDER_NAMES: Record<string, string> = {
  mpesa_daraja: 'M-Pesa Express',
  pesapal_v3: 'Pesapal',
  jenga_hq: 'Jenga HQ',
  kcb_buni: 'KCB Buni',
};

export const PAYMENT_SETUP_HREF = '/admin/settings/payments';

export function compare(current: number, previous: number): Comparison {
  return {
    current,
    previous,
    changePct: previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : null,
  };
}

const money = (n: number): number => Math.round(n * 100) / 100;

export interface OverviewRequest extends PeriodInput {
  /** Narrow to one branch. Only honoured for users who may see every branch. */
  branchId?: string;
}

interface CacheEntry {
  value: BusinessOverview;
  expiresAt: number;
}

export class ReportsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<BusinessOverview>>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly access: Pick<AccessControlService, 'can'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getBusinessOverview(userId: string, request: OverviewRequest): Promise<BusinessOverview> {
    const now = this.clock();
    const period = resolvePeriod(request, now);
    const allowed = await this.allowedPermissions(userId);
    const scope = await this.resolveScope(
      userId,
      allowed.has('reports:all_branches'),
      request.branchId,
    );

    // The cache key carries everything that changes the answer, including the user's
    // permission set, so one user's view can never be served to someone allowed less.
    const key = JSON.stringify([
      period.preset,
      period.from.toISOString(),
      period.to.toISOString(),
      // The comparison window is part of the answer: same dates, different comparison = different result.
      period.previous.from.toISOString(),
      period.previous.to.toISOString(),
      scope,
      [...allowed].sort(),
    ]);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now.getTime()) {
      return { ...hit.value, meta: { ...hit.value.meta, cached: true } };
    }
    const pending = this.inFlight.get(key);
    if (pending) return await pending;

    const run = this.build(period, scope, allowed, now)
      .then((value) => {
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return await run;
  }

  // ---------- access ----------

  private async allowedPermissions(userId: string): Promise<Set<PermissionKey>> {
    const keys: PermissionKey[] = [
      'report_sales:read',
      'report_collections:read',
      'report_profit:read',
      'report_receivables:read',
      'report_inventory:read',
      'reports:all_branches',
      'orders:read',
      'approvals:act',
      'transactions:read',
    ];
    const checks = await Promise.all(
      keys.map(async (k) => [k, await this.access.can(userId, k)] as const),
    );
    return new Set(checks.filter(([, ok]) => ok).map(([k]) => k));
  }

  /**
   * Who sees which branch: users with `reports:all_branches` see the whole company (or one
   * branch they pick); everyone else is pinned to their own branch. A user with no branch and
   * no company-wide right sees nothing rather than everything.
   */
  private async resolveScope(
    userId: string,
    allBranches: boolean,
    requested: string | undefined,
  ): Promise<ReportScope> {
    if (allBranches) {
      if (requested) {
        const [b] = await this.db
          .select({ id: branches.id, name: branches.name })
          .from(branches)
          .where(eq(branches.id, requested))
          .limit(1);
        if (b) return { kind: 'branch', branchId: b.id, branchName: b.name };
      }
      return { kind: 'all' };
    }
    const [row] = await this.db
      .select({ branchId: users.branchId, name: branches.name })
      .from(users)
      .leftJoin(branches, eq(branches.id, users.branchId))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.branchId) return { kind: 'none' };
    return { kind: 'branch', branchId: row.branchId, branchName: row.name ?? 'Your branch' };
  }

  // ---------- assembly ----------

  private async baseCurrency(): Promise<string> {
    const [row] = await this.db
      .select({ code: currencies.code })
      .from(currencies)
      .where(eq(currencies.isBaseCurrency, true))
      .limit(1);
    return row?.code ?? DEFAULT_BASE_CURRENCY;
  }

  private async build(
    period: ResolvedPeriod,
    scope: ReportScope,
    allowed: Set<PermissionKey>,
    now: Date,
  ): Promise<BusinessOverview> {
    const currency = await this.baseCurrency();
    const asOf = now.toISOString();
    const sections: string[] = [];
    const empty: BusinessOverview = {
      meta: this.meta(period, scope, currency, asOf, [], [], [], null),
      headline: [],
      branches: null,
      attention: [],
      sales: null,
      collections: null,
      profit: null,
      receivables: null,
      inventory: null,
    };
    if (scope.kind === 'none') return empty;

    const want = (k: PermissionKey) => allowed.has(k);
    if (want('report_sales:read')) sections.push('sales');
    if (want('report_collections:read')) sections.push('collections');
    if (want('report_profit:read')) sections.push('profit');
    if (want('report_receivables:read')) sections.push('receivables');
    if (want('report_inventory:read')) sections.push('inventory');

    // Independent reads run together; a failure in one section must not blank the others.
    const settle = async <T>(enabled: boolean, work: () => Promise<T>): Promise<T | null> => {
      if (!enabled) return null;
      try {
        return await work();
      } catch (error) {
        console.error('[reports.overview] section failed', error);
        return null;
      }
    };

    const [
      sales,
      collections,
      profit,
      receivables,
      inventory,
      attention,
      branchList,
      other,
      lastActivity,
    ] = await Promise.all([
      settle(want('report_sales:read'), () =>
        this.sales(period, scope, currency, want('reports:all_branches')),
      ),
      settle(want('report_collections:read'), () => this.collections(period, scope, currency)),
      settle(want('report_profit:read'), () => this.profit(period, scope, currency)),
      settle(want('report_receivables:read'), () => this.receivables(scope, now)),
      settle(want('report_inventory:read'), () => this.inventory()),
      settle(true, () => this.attention(scope, allowed)),
      settle(want('reports:all_branches'), () => this.branchList()),
      settle(want('report_sales:read'), () =>
        q.otherCurrencyOrders(this.db, period, scope, currency),
      ),
      settle(want('report_sales:read') || want('report_collections:read'), () =>
        q.lastOrderDate(this.db, scope, period.timeZone),
      ),
    ]);

    const failed = [
      ['sales', sales],
      ['collections', collections],
      ['profit', profit],
      ['receivables', receivables],
      ['inventory', inventory],
    ] as const;
    const failedSections = failed
      .filter(([n, v]) => sections.includes(n) && v === null)
      .map(([n]) => n);

    // Low and out-of-stock products are an action item too, not just a card.
    const attentionItems: AttentionItem[] = [...(attention ?? [])];
    if (inventory && inventory.outOfStock > 0) {
      attentionItems.push({
        key: 'out_of_stock',
        label: 'Products out of stock',
        count: inventory.outOfStock,
        href: '/admin/inventory',
        tone: 'critical',
      });
    }
    if (inventory && inventory.lowStock > 0) {
      attentionItems.push({
        key: 'low_stock',
        label: 'Products running low',
        count: inventory.lowStock,
        href: '/admin/inventory',
        tone: 'warning',
      });
    }
    if (receivables && receivables.overdue > 0) {
      attentionItems.push({
        key: 'overdue_customers',
        label: 'Customers with overdue invoices',
        count: receivables.overdueCustomers,
        href: '/admin/customers',
        tone: 'warning',
      });
    }

    return {
      meta: this.meta(
        period,
        scope,
        currency,
        asOf,
        sections,
        other ?? [],
        failedSections,
        lastActivity,
      ),
      headline: buildHeadline({
        sales,
        collections,
        attention: attentionItems,
        meta: {
          baseCurrency: currency,
          compare: { mode: period.compare, label: COMPARE_LABELS[period.compare] },
        },
      }),
      branches: branchList,
      attention: attentionItems,
      sales,
      collections,
      profit,
      receivables,
      inventory,
    };
  }

  private meta(
    period: ResolvedPeriod,
    scope: ReportScope,
    currency: string,
    asOf: string,
    sections: string[],
    otherCurrencies: { currency: string; orders: number }[],
    failedSections: string[],
    lastActivityDate: string | null,
  ): BusinessOverview['meta'] {
    return {
      asOf,
      period: {
        preset: period.preset,
        label: period.label,
        timeZone: period.timeZone,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        fromDate: period.fromDate,
        toDate: period.toDate,
        previousFrom: period.previous.from.toISOString(),
        previousTo: period.previous.to.toISOString(),
        previousFromDate: period.previous.fromDate,
        previousToDate: period.previous.toDate,
        notice: period.notice,
      },
      scope: {
        kind: scope.kind,
        branchId: scope.kind === 'branch' ? scope.branchId : null,
        label:
          scope.kind === 'all'
            ? 'All branches'
            : scope.kind === 'branch'
              ? scope.branchName
              : 'No branch assigned',
      },
      compare: { mode: period.compare, label: COMPARE_LABELS[period.compare] },
      lastActivityDate,
      baseCurrency: currency,
      otherCurrencies,
      definitionsVersion: OVERVIEW_DEFINITIONS_VERSION,
      sections,
      failedSections,
      cached: false,
    };
  }

  private async branchList(): Promise<{ id: string; name: string }[]> {
    return await this.db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.isActive, true))
      .orderBy(branches.name);
  }

  private async sales(
    period: ResolvedPeriod,
    scope: ReportScope,
    currency: string,
    allBranchesViewer: boolean,
  ): Promise<SalesSummary> {
    const wantBranches = allBranchesViewer && scope.kind === 'all';
    const [cur, prev, trendMap, prevTrendMap, top, flow, branchNow, branchPrev] = await Promise.all(
      [
        q.salesTotals(this.db, period, scope, currency),
        q.salesTotals(this.db, period.previous, scope, currency),
        q.salesTrend(this.db, period, scope, currency, period.timeZone),
        q.salesTrend(this.db, period.previous, scope, currency, period.timeZone),
        q.topProducts(this.db, period, scope, currency),
        q.orderFlow(this.db, period, scope, currency),
        wantBranches ? q.salesByBranch(this.db, period, currency) : null,
        wantBranches ? q.salesByBranch(this.db, period.previous, currency) : null,
      ],
    );
    const avg = (t: q.SalesTotals) => (t.orders > 0 ? money(t.sales / t.orders) : 0);
    const previousDays = listDays(period.previous.fromDate, period.days.length);

    let byBranch: SalesSummary['byBranch'] = null;
    if (branchNow && branchPrev && branchNow.size + branchPrev.size > 1) {
      const total = [...branchNow.values()].reduce((s, b) => s + b.sales, 0);
      const rowsAll = [...branchNow.entries()]
        .map(([branchId, b]) => {
          const before = branchPrev.get(branchId)?.sales ?? 0;
          return {
            branchId,
            name: b.name,
            sales: money(b.sales),
            orders: b.orders,
            sharePct: total > 0 ? Number(((b.sales / total) * 100).toFixed(1)) : 0,
            changePct: before > 0 ? Number((((b.sales - before) / before) * 100).toFixed(1)) : null,
            before,
          };
        })
        .sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
      const top = rowsAll.slice(0, MAX_BRANCH_ROWS);
      const rest = rowsAll.slice(MAX_BRANCH_ROWS);
      byBranch = top.map(({ before: _before, ...row }) => row);
      if (rest.length > 0) {
        // Fold the tail into one row so the table always adds up to the whole.
        const restSales = rest.reduce((sum, r) => sum + r.sales, 0);
        const restBefore = rest.reduce((sum, r) => sum + r.before, 0);
        byBranch.push({
          branchId: 'other',
          name: `Other branches (${rest.length})`,
          sales: money(restSales),
          orders: rest.reduce((sum, r) => sum + r.orders, 0),
          sharePct: total > 0 ? Number(((restSales / total) * 100).toFixed(1)) : 0,
          changePct:
            restBefore > 0
              ? Number((((restSales - restBefore) / restBefore) * 100).toFixed(1))
              : null,
        });
      }
    }

    return {
      orders: compare(cur.orders, prev.orders),
      sales: compare(money(cur.sales), money(prev.sales)),
      averageOrder: compare(avg(cur), avg(prev)),
      tax: compare(money(cur.tax), money(prev.tax)),
      trend: period.days.map((date, i) => ({
        date,
        sales: money(trendMap.get(date)?.sales ?? 0),
        orders: trendMap.get(date)?.orders ?? 0,
        previousDate: previousDays[i] ?? '',
        previousSales: money(prevTrendMap.get(previousDays[i] ?? '')?.sales ?? 0),
      })),
      flow: [
        { key: 'paid', label: 'Paid', hint: 'Payment confirmed', countsAsSale: true, ...flow.paid },
        {
          key: 'awaiting',
          label: 'Payment being confirmed',
          hint: 'Customer paid; waiting for confirmation or reconciliation',
          countsAsSale: true,
          ...flow.awaiting,
        },
        {
          key: 'credit',
          label: 'On credit',
          hint: 'Trade customers invoiced, not yet paid',
          countsAsSale: true,
          ...flow.credit,
        },
        {
          key: 'unpaid',
          label: 'Abandoned checkouts',
          hint: 'Shop orders never paid; not counted as sales',
          countsAsSale: false,
          ...flow.unpaid,
        },
        {
          key: 'blocked',
          label: 'Held or refused by approval',
          hint: 'Not counted as sales',
          countsAsSale: false,
          ...flow.blocked,
        },
        {
          key: 'lost',
          label: 'Cancelled, failed or refunded',
          hint: 'Not counted as sales',
          countsAsSale: false,
          ...flow.lost,
        },
      ].map((f) => ({ ...f, value: money(f.value) })),
      byBranch,
      topProducts: top.map((p) => ({ ...p, revenue: money(p.revenue) })),
    };
  }

  private async collections(
    period: ResolvedPeriod,
    scope: ReportScope,
    currency: string,
  ): Promise<CollectionsSummary> {
    const configured = await q.configuredMethods(this.db, scope);
    // Not set up means there is nothing meaningful to settle against: no report, just the way to fix it.
    if (configured.length === 0) return { configured: false, setupHref: PAYMENT_SETUP_HREF };

    const [cur, prev, tenders, inFlight, salesNow] = await Promise.all([
      q.settledByProvider(this.db, period, scope, currency),
      q.settledByProvider(this.db, period.previous, scope, currency),
      q.tenderTotals(this.db, period, scope, currency),
      q.paymentsInFlight(this.db, period, scope, currency),
      q.salesTotals(this.db, period, scope, currency),
    ]);
    const names = new Map(configured.map((c) => [c.providerCode, c.displayName]));
    const total = (rows: q.SettledRow[]) => rows.reduce((s, r) => s + r.amount, 0);
    const curTotal = total(cur);

    const methods = configured.map((c) => {
      const row = cur.find((r) => r.providerCode === c.providerCode);
      const amount = money(row?.amount ?? 0);
      return {
        providerCode: c.providerCode,
        name: names.get(c.providerCode) ?? c.providerCode,
        amount,
        count: row?.count ?? 0,
        sharePct: curTotal > 0 ? Number(((amount / curTotal) * 100).toFixed(1)) : 0,
      };
    });
    methods.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

    const orphans = cur.filter((r) => !names.has(r.providerCode));
    return {
      configured: true,
      collected: compare(money(curTotal), money(total(prev))),
      collectionRatePct:
        salesNow.sales > 0 ? Number(((curTotal / salesNow.sales) * 100).toFixed(1)) : null,
      inFlight: { ...inFlight, pendingAmount: money(inFlight.pendingAmount) },
      methods,
      unconfigured: {
        amount: money(total(orphans)),
        count: orphans.reduce((s, r) => s + r.count, 0),
        providers: orphans.map((r) => PROVIDER_NAMES[r.providerCode] ?? r.providerCode),
      },
      tenders: { amount: money(tenders.amount), count: tenders.count },
    };
  }

  private async profit(
    period: ResolvedPeriod,
    scope: ReportScope,
    currency: string,
  ): Promise<ProfitSummary> {
    const [cur, prev] = await Promise.all([
      q.profitTotals(this.db, period, scope, currency),
      q.profitTotals(this.db, period.previous, scope, currency),
    ]);
    const gp = (t: q.ProfitTotals) => money(t.knownRevenue - t.knownCost);
    return {
      grossProfit: compare(gp(cur), gp(prev)),
      marginPct:
        cur.knownRevenue > 0
          ? Number((((cur.knownRevenue - cur.knownCost) / cur.knownRevenue) * 100).toFixed(1))
          : null,
      costCoveragePct:
        cur.allRevenue > 0 ? Number(((cur.knownRevenue / cur.allRevenue) * 100).toFixed(1)) : null,
    };
  }

  private async receivables(scope: ReportScope, now: Date): Promise<ReceivablesSummary> {
    const r = await q.receivables(this.db, scope, now);
    return {
      outstanding: money(r.outstanding),
      overdue: money(r.overdue),
      overdueCustomers: r.overdueCustomers,
      aging: [
        { label: '1–30 days late', amount: money(r.buckets.b1_30) },
        { label: '31–60 days late', amount: money(r.buckets.b31_60) },
        { label: '61–90 days late', amount: money(r.buckets.b61_90) },
        { label: 'Over 90 days late', amount: money(r.buckets.b90) },
      ],
      topDebtors: r.topDebtors.map((d) => ({
        ...d,
        overdue: money(d.overdue),
        outstanding: money(d.outstanding),
      })),
    };
  }

  private async inventory() {
    const r = await q.inventoryHealth(this.db);
    return { ...r, stockValueAtCost: money(r.stockValueAtCost) };
  }

  /** Items needing action, each shown only to people who can act on it. */
  private async attention(
    scope: ReportScope,
    allowed: Set<PermissionKey>,
  ): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    const [orderCounts, approvals, kra] = await Promise.all([
      allowed.has('orders:read') ? q.orderAttentionCounts(this.db, scope) : null,
      allowed.has('approvals:act') ? q.pendingApprovals(this.db) : 0,
      allowed.has('transactions:read') ? q.failedKraTransmissions(this.db, scope) : 0,
    ]);
    if (orderCounts && orderCounts.discrepancies > 0) {
      items.push({
        key: 'payment_discrepancies',
        label: 'Payments that do not match their order',
        count: orderCounts.discrepancies,
        href: '/admin/reconciliation',
        tone: 'critical',
      });
    }
    if (orderCounts && orderCounts.awaitingVerification > 0) {
      items.push({
        key: 'awaiting_verification',
        label: 'Orders waiting for payment to be confirmed',
        count: orderCounts.awaitingVerification,
        href: '/admin/orders',
        tone: 'warning',
      });
    }
    if (approvals > 0) {
      items.push({
        key: 'pending_approvals',
        label: 'Approvals waiting for a decision',
        count: approvals,
        href: '/admin/approvals/inbox',
        tone: 'warning',
      });
    }
    if (kra > 0) {
      items.push({
        key: 'kra_failed',
        label: 'Tax invoices that failed to reach KRA',
        count: kra,
        href: '/admin/settings/tax-compliance',
        tone: 'critical',
      });
    }
    return items;
  }
}
