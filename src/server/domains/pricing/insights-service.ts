import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  discountRules,
  giftCards,
  loyaltyAccounts,
  loyaltyPrograms,
  rebateBalances,
  rebatePrograms,
  rebateSettlements,
} from '@/server/db/drizzle/schema';
import { PricingConfigError } from './config-service';
import { targetMatches } from './domain/discounts';
import { estimateImpact, marginPercent, type Impact, type SalesSlice } from './domain/impact';
import { rebateFor } from './domain/rebate';
import { toRule } from './discount-service';
import type { PriceGuardService } from './guard-service';

const MAX_DAYS = 366;
const MAX_PRODUCTS = 20_000;
const TTL_MS = 60_000;

export interface Range {
  from: Date;
  /** Exclusive. */
  to: Date;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

/** What a sale is worth with tax left out, from the line's total and its product's tax terms. */
const NET = sql`(case when coalesce(p.is_tax_inclusive, true) then i.total_price / (1 + coalesce(p.tax_rate, 0) / 100) else i.total_price end)`;
const LIVE = sql`o.status not in ('cancelled', 'failed', 'refunded')`;

export interface Overview {
  orders: number;
  netSales: number;
  cost: number;
  grossMarginPercent: number | null;
  /** The share of net sales whose cost was kept with the sale. */
  costCoveragePercent: number;
  discountsGiven: number;
  giftCost: number;
  tendered: number;
  daily: Array<{ day: string; orders: number; netSales: number; marginPercent: number | null }>;
}

export interface PromotionRow {
  ruleId: string;
  code: string;
  name: string;
  status: string;
  uses: number;
  given: number;
  orders: number;
  netSales: number;
  marginPercent: number | null;
  budget: number | null;
  /** What it has given away, in all, as a share of its budget. */
  budgetBurnPercent: number | null;
}

export interface GuardEvents {
  orderLines: number;
  belowFloor: number;
  overLimit: number;
  quotes: Array<{
    userId: string | null;
    name: string;
    quotes: number;
    belowFloor: number;
    overLimit: number;
    averageOverridePercent: number;
  }>;
}

export interface BranchVariance {
  productId: string;
  name: string;
  sku: string;
  spreadPercent: number;
  branches: Array<{ branchId: string | null; branch: string; unitPrice: number; units: number }>;
}

export interface Liabilities {
  rebates: Array<{
    programId: string;
    code: string;
    name: string;
    /** Earned and not yet paid or waiting for payment. For a running period, an estimate. */
    accrued: number;
    paid: number;
    waiting: number;
    truncated: boolean;
  }>;
  loyalty: { active: boolean; accounts: number; points: number; worth: number } | null;
  giftCards: {
    cards: number;
    outstanding: number;
    expiredWithBalance: number;
    blockedWithBalance: number;
  };
}

export type Severity = 'high' | 'medium' | 'low';
export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  count: number;
  /** A few examples to start from. */
  examples: string[];
  href: string | null;
}

export interface RuleImpact extends Impact {
  days: number;
  truncated: boolean;
  supported: boolean;
  unsupportedReason: string | null;
  /** The same giveaway over a year, for comparing with a budget. */
  yearly: number;
}

/**
 * Read-only measures of how pricing is doing: sales and margin, what promotions cost, who is
 * overriding prices, where the same product sells for different prices, what is owed to
 * customers, and what looks wrong. Every figure comes from what was recorded when things
 * happened. Results are cached for a minute, because these run over a lot of orders.
 */
export class InsightsService {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly guard: PriceGuardService,
  ) {}

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private checkRange(r: Range) {
    const days = (r.to.getTime() - r.from.getTime()) / 86_400_000;
    if (!(days > 0) || days > MAX_DAYS)
      throw new PricingConfigError('INVALID', `Choose a period of 1 to ${MAX_DAYS} days.`);
  }

  private rows<T>(result: unknown): T[] {
    return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
  }

  // ── Sales and margin ─────────────────────────────────────────────────────

  async overview(companyId: string, range: Range, branchId?: string | null): Promise<Overview> {
    this.checkRange(range);
    const key = `ov:${companyId}:${range.from.toISOString()}:${range.to.toISOString()}:${branchId ?? ''}`;
    return this.cached(key, async () => {
      const branch = branchId ? sql`and o.branch_id = ${branchId}` : sql``;
      const [tot] = this.rows<Record<string, string>>(
        await this.db.execute(sql`
          select count(distinct o.id) as orders,
                 coalesce(sum(${NET}), 0) as net,
                 coalesce(sum(case when i.unit_cost is not null then ${NET} end), 0) as costed_net,
                 coalesce(sum(i.unit_cost * i.quantity), 0) as cost,
                 coalesce(sum(case when i.is_gift then coalesce(i.unit_cost, 0) * i.quantity end), 0) as gift_cost
          from orders o
          join order_items i on i.order_id = o.id
          left join products p on p.id = i.product_id
          where o.created_at >= ${range.from.toISOString()} and o.created_at < ${range.to.toISOString()}
            and ${LIVE} ${branch}`),
      );
      const [tender] = this.rows<Record<string, string>>(
        await this.db.execute(sql`
          select coalesce(sum(o.tendered_amount), 0) as tendered
          from orders o
          where o.created_at >= ${range.from.toISOString()} and o.created_at < ${range.to.toISOString()}
            and ${LIVE} ${branch}`),
      );
      const [given] = this.rows<Record<string, string>>(
        await this.db.execute(sql`
          select coalesce(sum(amount), 0) as given from discount_usage
          where company_id = ${companyId} and document_type = 'order'
            and occurred_at >= ${range.from.toISOString()} and occurred_at < ${range.to.toISOString()}`),
      );
      const daily = this.rows<Record<string, string>>(
        await this.db.execute(sql`
          select ((o.created_at at time zone 'Africa/Nairobi')::date)::text as day,
                 count(distinct o.id) as orders,
                 coalesce(sum(${NET}), 0) as net,
                 coalesce(sum(case when i.unit_cost is not null then ${NET} end), 0) as costed_net,
                 coalesce(sum(i.unit_cost * i.quantity), 0) as cost
          from orders o
          join order_items i on i.order_id = o.id
          left join products p on p.id = i.product_id
          where o.created_at >= ${range.from.toISOString()} and o.created_at < ${range.to.toISOString()}
            and ${LIVE} ${branch}
          group by 1 order by 1`),
      );
      const net = n(tot?.net);
      return {
        orders: n(tot?.orders),
        netSales: r2(net),
        cost: r2(n(tot?.cost)),
        grossMarginPercent: marginPercent(n(tot?.costed_net), n(tot?.cost)),
        costCoveragePercent: net > 0 ? Math.round((n(tot?.costed_net) / net) * 1000) / 10 : 0,
        discountsGiven: r2(n(given?.given)),
        giftCost: r2(n(tot?.gift_cost)),
        tendered: r2(n(tender?.tendered)),
        daily: daily.map((d) => ({
          day: d.day!,
          orders: n(d.orders),
          netSales: r2(n(d.net)),
          marginPercent: marginPercent(n(d.costed_net), n(d.cost)),
        })),
      };
    });
  }

  // ── Promotions ───────────────────────────────────────────────────────────

  async promotions(companyId: string, range: Range): Promise<PromotionRow[]> {
    this.checkRange(range);
    const key = `pr:${companyId}:${range.from.toISOString()}:${range.to.toISOString()}`;
    return this.cached(key, async () => {
      const rows = this.rows<Record<string, string | null>>(
        await this.db.execute(sql`
          with u as (
            select rule_id, document_id, sum(amount) as amt,
                   sum(case when kind = 'use' then 1 else -1 end) as n
            from discount_usage
            where company_id = ${companyId} and document_type = 'order'
              and occurred_at >= ${range.from.toISOString()} and occurred_at < ${range.to.toISOString()}
            group by rule_id, document_id
            having sum(case when kind = 'use' then 1 else -1 end) > 0
          )
          select r.id, r.code, r.name, r.status, (r.limits->>'budget') as budget,
                 count(*) as uses, sum(u.amt) as given, sum(o.subtotal) as net,
                 sum(c.costed_net) as costed_net, sum(c.cost) as cost
          from u
          join discount_rules r on r.id = u.rule_id
          join orders o on o.id = u.document_id and ${LIVE}
          left join lateral (
            select sum(${NET}) as costed_net, sum(i.unit_cost * i.quantity) as cost
            from order_items i left join products p on p.id = i.product_id
            where i.order_id = o.id and i.unit_cost is not null
          ) c on true
          group by r.id
          order by sum(u.amt) desc
          limit 200`),
      );
      const ids = rows.map((r) => r.id!);
      const totals = ids.length
        ? this.rows<{ rule_id: string; amount: string }>(
            await this.db.execute(sql`
              select rule_id, sum(amount) as amount from discount_counters
              where rule_id in (${sql.join(
                ids.map((i) => sql`${i}`),
                sql`, `,
              )}) group by rule_id`),
          )
        : [];
      const spent = new Map(totals.map((t) => [t.rule_id, n(t.amount)]));
      return rows.map((r) => {
        const budget = r.budget == null ? null : n(r.budget);
        return {
          ruleId: r.id!,
          code: r.code!,
          name: r.name!,
          status: r.status!,
          uses: n(r.uses),
          given: r2(n(r.given)),
          orders: n(r.uses),
          netSales: r2(n(r.net)),
          marginPercent: marginPercent(n(r.costed_net), n(r.cost)),
          budget,
          budgetBurnPercent:
            budget && budget > 0
              ? Math.round(((spent.get(r.id!) ?? 0) / budget) * 1000) / 10
              : null,
        };
      });
    });
  }

  // ── Overrides and floor breaches ─────────────────────────────────────────

  async guardEvents(companyId: string, range: Range): Promise<GuardEvents> {
    this.checkRange(range);
    const key = `ge:${companyId}:${range.from.toISOString()}:${range.to.toISOString()}`;
    return this.cached(key, async () => {
      const [o] = this.rows<Record<string, string>>(
        await this.db.execute(sql`
          select count(*) as lines,
                 count(*) filter (where i.price_trace->'guard'->>'belowFloor' = 'true') as below,
                 count(*) filter (where i.price_trace->'guard'->>'overOverrideLimit' = 'true') as over
          from orders o join order_items i on i.order_id = o.id
          where o.created_at >= ${range.from.toISOString()} and o.created_at < ${range.to.toISOString()}
            and ${LIVE} and not i.is_gift`),
      );
      const quotes = this.rows<Record<string, string | null>>(
        await this.db.execute(sql`
          select q.created_by as uid, coalesce(u.name, q.created_by, 'Unknown') as name,
                 count(distinct q.id) as quotes,
                 count(*) filter (where l.price_trace->'guard'->>'belowFloor' = 'true') as below,
                 count(*) filter (where l.price_trace->'guard'->>'overOverrideLimit' = 'true') as over,
                 coalesce(avg(nullif((l.price_trace->'guard'->>'overridePercent')::numeric, 0)), 0) as avg_override
          from sales_quotes q
          join sales_quote_lines l on l.quote_id = q.id
          left join users u on u.id::text = q.created_by
          where q.company_id = ${companyId}
            and q.created_at >= ${range.from.toISOString()} and q.created_at < ${range.to.toISOString()}
            and not l.is_gift
          group by q.created_by, u.name
          order by count(*) filter (where l.price_trace->'guard'->>'belowFloor' = 'true') desc,
                   count(*) filter (where l.price_trace->'guard'->>'overOverrideLimit' = 'true') desc
          limit 50`),
      );
      return {
        orderLines: n(o?.lines),
        belowFloor: n(o?.below),
        overLimit: n(o?.over),
        quotes: quotes.map((q) => ({
          userId: q.uid,
          name: q.name ?? 'Unknown',
          quotes: n(q.quotes),
          belowFloor: n(q.below),
          overLimit: n(q.over),
          averageOverridePercent: Math.round(n(q.avg_override) * 10) / 10,
        })),
      };
    });
  }

  // ── The same product at different prices ─────────────────────────────────

  async branchVariance(companyId: string, range: Range, limit = 20): Promise<BranchVariance[]> {
    this.checkRange(range);
    const key = `bv:${companyId}:${range.from.toISOString()}:${range.to.toISOString()}:${limit}`;
    return this.cached(key, async () => {
      const rows = this.rows<Record<string, string | null>>(
        await this.db.execute(sql`
          with s as (
            select i.product_id, o.branch_id,
                   sum(${NET}) / nullif(sum(i.quantity), 0) as unit, sum(i.quantity) as units
            from orders o
            join order_items i on i.order_id = o.id
            left join products p on p.id = i.product_id
            where o.created_at >= ${range.from.toISOString()} and o.created_at < ${range.to.toISOString()}
              and ${LIVE} and not i.is_gift and i.total_price > 0
            group by i.product_id, o.branch_id
          ), v as (
            select product_id, min(unit) lo, max(unit) hi, count(*) n from s group by product_id
            having count(*) >= 2 and min(unit) > 0
          )
          select v.product_id, p.name, p.sku, ((v.hi - v.lo) / v.lo * 100) as spread,
                 s.branch_id, coalesce(b.name, 'No branch') as branch, s.unit, s.units
          from (select * from v order by (hi - lo) / lo desc limit ${limit}) v
          join s on s.product_id = v.product_id
          join products p on p.id = v.product_id
          left join branches b on b.id = s.branch_id
          order by spread desc, v.product_id, s.unit`),
      );
      const out = new Map<string, BranchVariance>();
      for (const r of rows) {
        const v =
          out.get(r.product_id!) ??
          ({
            productId: r.product_id!,
            name: r.name!,
            sku: r.sku!,
            spreadPercent: Math.round(n(r.spread) * 10) / 10,
            branches: [],
          } as BranchVariance);
        v.branches.push({
          branchId: r.branch_id,
          branch: r.branch!,
          unitPrice: r2(n(r.unit)),
          units: n(r.units),
        });
        out.set(r.product_id!, v);
      }
      return [...out.values()];
    });
  }

  // ── What is owed to customers ────────────────────────────────────────────

  async liabilities(companyId: string): Promise<Liabilities> {
    const programs = await this.db
      .select()
      .from(rebatePrograms)
      .where(
        and(
          eq(rebatePrograms.companyId, companyId),
          inArray(rebatePrograms.status, ['active', 'paused']),
        ),
      );
    const rebates: Liabilities['rebates'] = [];
    for (const p of programs) {
      const balances = await this.db
        .select({
          customerId: rebateBalances.customerId,
          periodKey: rebateBalances.periodKey,
          basis: rebateBalances.basis,
        })
        .from(rebateBalances)
        .where(eq(rebateBalances.programId, p.id))
        .limit(50_001);
      const truncated = balances.length > 50_000;
      const settlements = await this.db
        .select()
        .from(rebateSettlements)
        .where(
          and(
            eq(rebateSettlements.programId, p.id),
            inArray(rebateSettlements.status, ['pending', 'settled']),
          ),
        );
      const taken = new Set(settlements.map((s) => `${s.customerId}|${s.periodKey}`));
      let accrued = 0;
      for (const b of truncated ? balances.slice(0, 50_000) : balances)
        if (!taken.has(`${b.customerId}|${b.periodKey}`))
          accrued += rebateFor(Number(b.basis), p.tiers, p.tierMode);
      rebates.push({
        programId: p.id,
        code: p.code,
        name: p.name,
        accrued: r2(accrued),
        paid: r2(
          settlements
            .filter((s) => s.status === 'settled')
            .reduce((x, s) => x + Number(s.amount), 0),
        ),
        waiting: r2(
          settlements
            .filter((s) => s.status === 'pending')
            .reduce((x, s) => x + Number(s.amount), 0),
        ),
        truncated,
      });
    }
    const [lp] = await this.db
      .select()
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.companyId, companyId));
    let loyalty: Liabilities['loyalty'] = null;
    if (lp) {
      const [t] = await this.db
        .select({
          accounts: sql<number>`count(*) filter (where ${loyaltyAccounts.balance} > 0)::int`,
          points: sql<string>`coalesce(sum(${loyaltyAccounts.balance}), 0)`,
        })
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.companyId, companyId));
      loyalty = {
        active: lp.status === 'active',
        accounts: t?.accounts ?? 0,
        points: n(t?.points),
        worth: r2(n(t?.points) * Number(lp.pointValue)),
      };
    }
    const [g] = await this.db
      .select({
        cards: sql<number>`count(*) filter (where ${giftCards.balance} > 0)::int`,
        outstanding: sql<string>`coalesce(sum(${giftCards.balance}) filter (where ${giftCards.status} = 'active' and (${giftCards.expiresAt} is null or ${giftCards.expiresAt} > now())), 0)`,
        expired: sql<string>`coalesce(sum(${giftCards.balance}) filter (where ${giftCards.expiresAt} <= now()), 0)`,
        blocked: sql<string>`coalesce(sum(${giftCards.balance}) filter (where ${giftCards.status} = 'blocked'), 0)`,
      })
      .from(giftCards)
      .where(eq(giftCards.companyId, companyId));
    return {
      rebates,
      loyalty,
      giftCards: {
        cards: g?.cards ?? 0,
        outstanding: r2(n(g?.outstanding)),
        expiredWithBalance: r2(n(g?.expired)),
        blockedWithBalance: r2(n(g?.blocked)),
      },
    };
  }

  // ── What looks wrong ─────────────────────────────────────────────────────

  async findings(companyId: string): Promise<Finding[]> {
    return this.cached(`fi:${companyId}`, async () => {
      const out: Finding[] = [];
      const add = (f: Omit<Finding, 'examples'> & { examples?: string[] }) => {
        if (f.count > 0) out.push({ examples: [], ...f });
      };
      const q = async (query: ReturnType<typeof sql>) =>
        this.rows<Record<string, string | null>>(await this.db.execute(query));

      const NETP = sql`(case when coalesce(p.is_tax_inclusive, true) then p.price / (1 + coalesce(p.tax_rate, 0) / 100) else p.price end)`;
      const live = sql`p.is_active and p.deleted_at is null and p.is_sellable`;

      const belowCost = await q(sql`
        select p.name || ' (' || p.sku || ')' as label, count(*) over () as total
        from products p where ${live} and p.price is not null and p.cost_price > 0 and ${NETP} < p.cost_price
        order by (p.cost_price - ${NETP}) desc limit 5`);
      add({
        code: 'sells_below_cost',
        severity: 'high',
        title: 'Products priced below their cost',
        detail: 'The standard price, with tax left out, is under what the product costs.',
        count: n(belowCost[0]?.total),
        examples: belowCost.map((r) => r.label!),
        href: '/admin/products',
      });

      const listBelowCost = await q(sql`
        select p.name || ' (' || p.sku || ') on ' || l.code as label, count(*) over () as total
        from price_list_lines pl
        join price_lists l on l.id = pl.price_list_id and l.company_id = ${companyId} and l.status = 'active'
        join products p on p.id = pl.product_id
        where pl.valid_to is null and p.cost_price > 0 and pl.price < p.cost_price
        order by (p.cost_price - pl.price) desc limit 5`);
      add({
        code: 'list_below_cost',
        severity: 'high',
        title: 'Price list prices below cost',
        detail:
          'A price in a list in force is under the product’s cost. The price is compared as typed, so a tax-inclusive price can look lower than it is.',
        count: n(listBelowCost[0]?.total),
        examples: listBelowCost.map((r) => r.label!),
        href: '/admin/pricing',
      });

      const noCost = await q(sql`
        select count(*) as total, min(p.name || ' (' || p.sku || ')') as one
        from products p where ${live} and p.price is not null and p.price > 0 and p.cost_price <= 0`);
      add({
        code: 'no_cost',
        severity: 'medium',
        title: 'Products with no cost on file',
        detail:
          'Without a cost there is no price floor and no margin. Add the cost to protect them.',
        count: n(noCost[0]?.total),
        examples: noCost[0]?.one ? [noCost[0].one] : [],
        href: '/admin/pricing/floors',
      });

      const noPrice = await q(sql`
        select count(*) as total from products p
        where ${live} and (p.price is null or p.price <= 0)
          and not exists (select 1 from price_list_lines pl where pl.product_id = p.id and pl.valid_to is null)`);
      add({
        code: 'no_price',
        severity: 'medium',
        title: 'Sellable products with no price',
        detail: 'No standard price and no price list line: they cannot be priced.',
        count: n(noPrice[0]?.total),
        href: '/admin/products',
      });

      const ended = await q(sql`
        select l.code as label, count(*) over () as total from price_lists l
        where l.company_id = ${companyId} and l.status = 'active' and l.valid_to is not null and l.valid_to < now()
        limit 5`);
      add({
        code: 'price_list_ended',
        severity: 'low',
        title: 'Price lists in force that have ended',
        detail: 'They price nothing now. Retire them to keep the list tidy.',
        count: n(ended[0]?.total),
        examples: ended.map((r) => r.label!),
        href: '/admin/pricing',
      });

      const open = await q(sql`
        select r.code as label, count(*) over () as total from discount_rules r
        where r.company_id = ${companyId} and r.status = 'active' and r.valid_to is null
        limit 5`);
      add({
        code: 'discount_no_end',
        severity: 'medium',
        title: 'Discounts in force with no end date',
        detail: 'A promotion with no end is a standing price cut. Confirm that is intended.',
        count: n(open[0]?.total),
        examples: open.map((r) => r.label!),
        href: '/admin/pricing/discounts',
      });

      const uncapped = await q(sql`
        select r.code as label, count(*) over () as total from discount_rules r
        where r.company_id = ${companyId} and r.status = 'active'
          and (r.limits->>'budget') is null and (r.limits->>'maxUses') is null
          and (r.limits->>'maxDiscountPercent') is null and r.kind in ('line', 'order')
          and coalesce((r.reward->>'value')::numeric, 0) >= 20 and r.reward->>'type' = 'percent'
        limit 5`);
      add({
        code: 'discount_uncapped',
        severity: 'high',
        title: 'Large discounts with no budget or limit',
        detail: 'A percentage of 20 or more with no budget, use limit or cap.',
        count: n(uncapped[0]?.total),
        examples: uncapped.map((r) => r.label!),
        href: '/admin/pricing/discounts',
      });

      const ending = await q(sql`
        select r.code as label, count(*) over () as total from discount_rules r
        where r.company_id = ${companyId} and r.status = 'active'
          and r.valid_to between now() and now() + interval '7 days'
        limit 5`);
      add({
        code: 'discount_ending',
        severity: 'low',
        title: 'Discounts ending within a week',
        detail: 'Customers will see prices rise when they end.',
        count: n(ending[0]?.total),
        examples: ending.map((r) => r.label!),
        href: '/admin/pricing/discounts',
      });

      const kits = await q(sql`
        select p.name || ' (' || p.sku || ')' as label, count(*) over () as total
        from product_kits k join products p on p.id = k.product_id
        where k.company_id = ${companyId} and k.is_active and exists (
          select 1 from product_kit_components c join products cp on cp.id = c.product_id
          where c.kit_id = k.id and (not cp.is_active or cp.deleted_at is not null))
        limit 5`);
      add({
        code: 'kit_component_off',
        severity: 'high',
        title: 'Kits with a component that cannot be sold',
        detail:
          'An order for these kits is refused until the component is back on sale or the kit is changed.',
        count: n(kits[0]?.total),
        examples: kits.map((r) => r.label!),
        href: '/admin/pricing/kits',
      });

      const slow = await q(sql`
        select s.id::text as label, count(*) over () as total from rebate_settlements s
        where s.company_id = ${companyId} and s.status = 'pending' and s.created_at < now() - interval '14 days'
        limit 5`);
      add({
        code: 'rebate_waiting',
        severity: 'medium',
        title: 'Rebate payments waiting over two weeks',
        detail: 'Customers are owed these. Chase the approvers.',
        count: n(slow[0]?.total),
        href: '/admin/approvals',
      });

      const breakage = await q(sql`
        select count(*) as total from gift_cards
        where company_id = ${companyId} and expires_at <= now() and balance > 0`);
      add({
        code: 'gift_cards_expired',
        severity: 'low',
        title: 'Expired gift cards with a balance',
        detail: 'Decide how expired value is treated; the cards cannot be spent.',
        count: n(breakage[0]?.total),
        href: '/admin/pricing/gift-cards',
      });

      const rank = { high: 0, medium: 1, low: 2 } as const;
      return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
    });
  }

  // ── What a rule would cost ───────────────────────────────────────────────

  /**
   * The cost of a discount rule over recent sales. A line rule looks at the lines its target
   * covers; an order rule at the orders that reach its minimum; a gift at the orders that earn it.
   */
  async impactOfRule(companyId: string, ruleId: string, days = 90): Promise<RuleImpact> {
    if (!Number.isInteger(days) || days < 7 || days > MAX_DAYS)
      throw new PricingConfigError('INVALID', `Look back between 7 and ${MAX_DAYS} days.`);
    const [row] = await this.db
      .select()
      .from(discountRules)
      .where(and(eq(discountRules.id, ruleId), eq(discountRules.companyId, companyId)))
      .limit(1);
    if (!row) throw new PricingConfigError('NOT_FOUND', 'That rule does not exist.');
    const rule = toRule(row);
    const empty: SalesSlice = { units: 0, lines: 0, net: 0, cost: 0, costedNet: 0 };
    const unsupported = (reason: string): RuleImpact => ({
      ...estimateImpact({ type: 'percent', value: 0 }, empty),
      days,
      truncated: false,
      supported: false,
      unsupportedReason: reason,
      yearly: 0,
    });
    if (rule.kind === 'mix')
      return unsupported(
        'Product deals are not estimated: how often the deal would trigger depends on how customers mix their baskets.',
      );
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);

    // One row per product, so a rule's target can be matched without reading every line.
    const perProduct = this.rows<Record<string, string>>(
      await this.db.execute(sql`
        select i.product_id, sum(i.quantity) as units, count(*) as lines, sum(${NET}) as net,
               sum(case when i.unit_cost is not null then ${NET} end) as costed_net,
               sum(i.unit_cost * i.quantity) as cost
        from orders o join order_items i on i.order_id = o.id left join products p on p.id = i.product_id
        where o.created_at >= ${from.toISOString()} and o.created_at < ${to.toISOString()}
          and ${LIVE} and not i.is_gift
        group by i.product_id
        order by sum(${NET}) desc
        limit ${MAX_PRODUCTS + 1}`),
    );
    const truncated = perProduct.length > MAX_PRODUCTS;
    const used = truncated ? perProduct.slice(0, MAX_PRODUCTS) : perProduct;
    const facts = new Map<
      string,
      Awaited<ReturnType<PriceGuardService['floorProducts']>> extends Map<string, infer V>
        ? V
        : never
    >();
    for (let i = 0; i < used.length; i += 5000) {
      const chunk = used.slice(i, i + 5000).map((r) => r.product_id!);
      for (const [id, f] of await this.guard.floorProducts(companyId, chunk)) facts.set(id, f);
    }
    const slice: SalesSlice = { ...empty };
    // A gift is triggered by the goods its own trigger names; other rules by their target.
    const aimedAt =
      rule.kind === 'gift' && rule.mix?.type === 'gift' && rule.mix.trigger.target
        ? rule.mix.trigger.target
        : rule.target;
    const matches = (productId: string) => {
      const f = facts.get(productId);
      return targetMatches(aimedAt, {
        id: productId,
        brand: f?.brand ?? null,
        categoryChain: f?.categoryChain ?? [],
        groupIds: f?.groupIds ?? [],
      });
    };

    let orders = 0;
    if (rule.kind === 'line') {
      for (const r of used) {
        if (!matches(r.product_id!)) continue;
        slice.units += n(r.units);
        slice.lines += n(r.lines);
        slice.net += n(r.net);
        slice.cost += n(r.cost);
        slice.costedNet += n(r.costed_net);
      }
    } else {
      // Orders reaching the minimum value of the goods the rule covers.
      const min =
        rule.kind === 'gift' && rule.mix?.type === 'gift'
          ? (rule.mix.trigger.minOrderValue ?? 0)
          : (rule.conditions.minOrderValue ?? 0);
      const covered = used.filter((r) => matches(r.product_id!)).map((r) => r.product_id!);
      if (covered.length > 0) {
        const sums = this.rows<Record<string, string>>(
          await this.db.execute(sql`
            select o.id, sum(${NET}) as net, sum(i.quantity) as units, count(*) as lines,
                   sum(case when i.unit_cost is not null then ${NET} end) as costed_net,
                   sum(i.unit_cost * i.quantity) as cost
            from orders o join order_items i on i.order_id = o.id left join products p on p.id = i.product_id
            where o.created_at >= ${from.toISOString()} and o.created_at < ${to.toISOString()}
              and ${LIVE} and not i.is_gift
              and i.product_id in (${sql.join(
                covered.slice(0, 5000).map((c) => sql`${c}`),
                sql`, `,
              )})
            group by o.id having sum(${NET}) >= ${min}
            limit 200000`),
        );
        for (const s of sums) {
          orders += 1;
          slice.units += n(s.units);
          slice.lines += n(s.lines);
          slice.net += n(s.net);
          slice.cost += n(s.cost);
          slice.costedNet += n(s.costed_net);
        }
      }
    }

    let impact: Impact;
    if (rule.kind === 'gift') {
      // Each qualifying order gets the gifts: their cost is what is given away.
      const giftIds = rule.mix?.type === 'gift' ? rule.mix.gifts : [];
      const costs = giftIds.length
        ? this.rows<{ id: string; cost: string }>(
            await this.db.execute(
              sql`select id, cost_price as cost from products where id in (${sql.join(
                giftIds.map((g) => sql`${g.productId}`),
                sql`, `,
              )})`,
            ),
          )
        : [];
      const costOf = new Map(costs.map((c) => [c.id, n(c.cost)]));
      const per = giftIds.reduce((x, g) => x + (costOf.get(g.productId) ?? 0) * g.quantity, 0);
      const min = rule.mix?.type === 'gift' ? (rule.mix.trigger.minOrderValue ?? 0) : 0;
      // Gifts count at what they cost the company, not their selling price.
      const qualifying = slice.net > 0 ? Math.max(orders, 0) : 0;
      impact = estimateImpact({ type: 'amount', value: per }, slice, { orders: qualifying });
      impact.notes.unshift(
        `A gift counts at its cost to you (${r2(per)} per order). ${min > 0 ? `Orders are counted from ${min} of matching goods.` : ''}`.trim(),
      );
    } else if (rule.reward) {
      impact = estimateImpact(rule.reward, slice, {
        orders,
        kind: rule.kind === 'order' ? 'order' : 'line',
      });
    } else {
      return unsupported('This rule has no reward to estimate.');
    }
    if (truncated)
      impact.notes.push(
        `Only the ${MAX_PRODUCTS.toLocaleString()} best-selling products were looked at.`,
      );
    return {
      ...impact,
      days,
      truncated,
      supported: true,
      unsupportedReason: null,
      yearly: r2((impact.giveaway * 365) / days),
    };
  }
}
