import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { TimeWindow } from './period';
import type { ReportScope } from './types';

/**
 * Read-only aggregate queries behind the Business Overview. Rules:
 *  - everything is summed in the database; only small result sets reach the app
 *  - every query is bounded by an explicit time window and the caller's branch scope
 *  - money is `numeric` end to end and converted once, at the edge
 */

type Rows<T> = T[];

async function rows<T>(db: DrizzleDb, query: SQL): Promise<Rows<T>> {
  // postgres-js returns the row array directly.
  return (await db.execute(query)) as unknown as Rows<T>;
}

/** Dates go in as ISO text: raw SQL templates are not mapped by the column types. */
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

const num = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

function branchFilter(scope: ReportScope, column: SQL): SQL {
  return scope.kind === 'branch' ? sql`and ${column} = ${scope.branchId}` : sql``;
}

/**
 * What counts as a sale: not cancelled / failed / refunded, not waiting on or refused by an
 * approval, and either paid-or-in-payment or placed by a trade (credit) customer. An unpaid
 * retail checkout that was never paid is an abandoned cart, not a sale.
 */
const SALE = sql`
  o.status not in ('failed', 'cancelled', 'refunded')
  and o.payment_status <> 'failed'
  and o.approval_status not in ('rejected', 'draft')
  and (o.payment_status <> 'unpaid' or o.trade_customer_id is not null)
`;

export interface SalesTotals {
  orders: number;
  sales: number;
  tax: number;
}

export async function salesTotals(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<SalesTotals> {
  const r = await rows<{ orders: number; sales: string; tax: string }>(
    db,
    sql`
      select count(*)::int as orders,
             coalesce(sum(o.total_amount), 0)::text as sales,
             coalesce(sum(o.tax), 0)::text as tax
      from orders o
      where o.created_at >= ${ts(w.from)} and o.created_at < ${ts(w.to)}
        and o.currency = ${currency}
        and ${SALE}
        ${branchFilter(scope, sql`o.branch_id`)}
    `,
  );
  const row = r[0];
  return { orders: row?.orders ?? 0, sales: num(row?.sales), tax: num(row?.tax) };
}

/** Orders in other currencies in the window (counted, never added to base-currency totals). */
export async function otherCurrencyOrders(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<{ currency: string; orders: number }[]> {
  return await rows<{ currency: string; orders: number }>(
    db,
    sql`
      select o.currency, count(*)::int as orders
      from orders o
      where o.created_at >= ${ts(w.from)} and o.created_at < ${ts(w.to)}
        and o.currency <> ${currency}
        and ${SALE}
        ${branchFilter(scope, sql`o.branch_id`)}
      group by o.currency
      order by orders desc
      limit 5
    `,
  );
}

export async function salesTrend(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
  timeZone: string,
): Promise<Map<string, { sales: number; orders: number }>> {
  const r = await rows<{ day: string; sales: string; orders: number }>(
    db,
    sql`
      select to_char(o.created_at at time zone ${timeZone}, 'YYYY-MM-DD') as day,
             coalesce(sum(o.total_amount), 0)::text as sales,
             count(*)::int as orders
      from orders o
      where o.created_at >= ${ts(w.from)} and o.created_at < ${ts(w.to)}
        and o.currency = ${currency}
        and ${SALE}
        ${branchFilter(scope, sql`o.branch_id`)}
      group by 1
    `,
  );
  return new Map(r.map((x) => [x.day, { sales: num(x.sales), orders: x.orders }]));
}

export async function topProducts(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
  limit = 5,
): Promise<{ productId: string; name: string; revenue: number; units: number }[]> {
  const r = await rows<{ product_id: string; name: string; revenue: string; units: string }>(
    db,
    sql`
      select i.product_id,
             max(i.product_name) as name,
             sum(i.total_price)::text as revenue,
             sum(i.quantity)::text as units
      from orders o
      join order_items i on i.order_id = o.id
      where o.created_at >= ${ts(w.from)} and o.created_at < ${ts(w.to)}
        and o.currency = ${currency}
        and i.is_gift = false
        and ${SALE}
        ${branchFilter(scope, sql`o.branch_id`)}
      group by i.product_id
      order by sum(i.total_price) desc, i.product_id
      limit ${limit}
    `,
  );
  return r.map((x) => ({
    productId: x.product_id,
    name: x.name,
    revenue: num(x.revenue),
    units: num(x.units),
  }));
}

export interface ProfitTotals {
  /** Revenue and cost of the lines whose cost is known. */
  knownRevenue: number;
  knownCost: number;
  /** Revenue of every line, known cost or not. */
  allRevenue: number;
}

export async function profitTotals(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<ProfitTotals> {
  const r = await rows<{ known_revenue: string; known_cost: string; all_revenue: string }>(
    db,
    sql`
      select coalesce(sum(i.total_price) filter (where i.unit_cost is not null), 0)::text as known_revenue,
             coalesce(sum(i.unit_cost * i.quantity) filter (where i.unit_cost is not null), 0)::text as known_cost,
             coalesce(sum(i.total_price), 0)::text as all_revenue
      from orders o
      join order_items i on i.order_id = o.id
      where o.created_at >= ${ts(w.from)} and o.created_at < ${ts(w.to)}
        and o.currency = ${currency}
        and ${SALE}
        ${branchFilter(scope, sql`o.branch_id`)}
    `,
  );
  const row = r[0];
  return {
    knownRevenue: num(row?.known_revenue),
    knownCost: num(row?.known_cost),
    allRevenue: num(row?.all_revenue),
  };
}

export interface ConfiguredMethod {
  providerCode: string;
  displayName: string;
}

/** Payment methods that are switched on and have saved credentials, for the branches in scope. */
export async function configuredMethods(
  db: DrizzleDb,
  scope: ReportScope,
): Promise<ConfiguredMethod[]> {
  const r = await rows<{ provider_code: string; display_name: string }>(
    db,
    sql`
      select c.provider_code, min(c.display_name) as display_name
      from payment_provider_configs c
      where c.is_enabled = true
        and c.credentials_encrypted is not null
        ${branchFilter(scope, sql`c.branch_id`)}
      group by c.provider_code
      order by min(c.display_name)
    `,
  );
  return r.map((x) => ({ providerCode: x.provider_code, displayName: x.display_name }));
}

export interface SettledRow {
  providerCode: string;
  amount: number;
  count: number;
}

/**
 * Money actually settled in a window, by provider. Primary source is the payment-attempt record
 * (provider + `paid_at`). Older gateway transactions are included only for orders that have no
 * successful attempt, so nothing is counted twice.
 */
export async function settledByProvider(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<SettledRow[]> {
  const r = await rows<{ provider: string; amount: string; count: number }>(
    db,
    sql`
      with settled as (
        select a.provider_code as provider, a.amount, a.id::text as ref
        from payment_attempts a
        where a.status = 'successful'
          and a.paid_at >= ${ts(w.from)} and a.paid_at < ${ts(w.to)}
          and a.currency = ${currency}
          ${branchFilter(scope, sql`a.branch_id`)}
        union all
        select t.gateway_provider as provider, t.amount, t.id as ref
        from payment_transactions t
        join orders o on o.id = t.order_id
        where t.status = 'successful'
          and t.updated_at >= ${ts(w.from)} and t.updated_at < ${ts(w.to)}
          and t.currency = ${currency}
          and not exists (
            select 1 from payment_attempts a2
            where a2.order_id = t.order_id and a2.status = 'successful'
          )
          ${branchFilter(scope, sql`o.branch_id`)}
      )
      select provider, coalesce(sum(amount), 0)::text as amount, count(*)::int as count
      from settled
      group by provider
    `,
  );
  return r.map((x) => ({ providerCode: x.provider, amount: num(x.amount), count: x.count }));
}

export async function tenderTotals(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<{ amount: number; count: number }> {
  const r = await rows<{ amount: string; count: number }>(
    db,
    sql`
      select coalesce(sum(t.amount), 0)::text as amount, count(*)::int as count
      from order_tenders t
      join orders o on o.id = t.order_id
      where t.created_at >= ${ts(w.from)} and t.created_at < ${ts(w.to)}
        and o.currency = ${currency}
        ${branchFilter(scope, sql`o.branch_id`)}
    `,
  );
  return { amount: num(r[0]?.amount), count: r[0]?.count ?? 0 };
}

export async function receivables(
  db: DrizzleDb,
  scope: ReportScope,
  asOf: Date,
): Promise<{
  outstanding: number;
  overdue: number;
  overdueCustomers: number;
  buckets: { b1_30: number; b31_60: number; b61_90: number; b90: number };
  topDebtors: { customerId: string; name: string; overdue: number; outstanding: number }[];
}> {
  // Customer ledger rows carry no branch; the branch of the order they came from decides scope.
  const join = scope.kind === 'branch' ? sql`join orders o on o.id = l.order_id` : sql``;
  const where = branchFilter(scope, sql`o.branch_id`);
  const at = ts(asOf);

  const totals = await rows<{
    outstanding: string;
    overdue: string;
    overdue_customers: number;
    b1_30: string;
    b31_60: string;
    b61_90: string;
    b90: string;
  }>(
    db,
    sql`
      select coalesce(sum(l.remaining_amount), 0)::text as outstanding,
             coalesce(sum(l.remaining_amount) filter (where l.due_date < ${at}), 0)::text as overdue,
             count(distinct l.customer_id) filter (where l.due_date < ${at})::int as overdue_customers,
             coalesce(sum(l.remaining_amount) filter (
               where l.due_date < ${at} and l.due_date >= ${at} - interval '30 days'), 0)::text as b1_30,
             coalesce(sum(l.remaining_amount) filter (
               where l.due_date < ${at} - interval '30 days' and l.due_date >= ${at} - interval '60 days'), 0)::text as b31_60,
             coalesce(sum(l.remaining_amount) filter (
               where l.due_date < ${at} - interval '60 days' and l.due_date >= ${at} - interval '90 days'), 0)::text as b61_90,
             coalesce(sum(l.remaining_amount) filter (
               where l.due_date < ${at} - interval '90 days'), 0)::text as b90
      from customer_ledger_entries l
      ${join}
      where l.remaining_amount > 0
        ${where}
    `,
  );
  const debtors = await rows<{
    customer_id: string;
    name: string;
    overdue: string;
    outstanding: string;
  }>(
    db,
    sql`
      select l.customer_id, max(c.name) as name,
             coalesce(sum(l.remaining_amount) filter (where l.due_date < ${at}), 0)::text as overdue,
             sum(l.remaining_amount)::text as outstanding
      from customer_ledger_entries l
      join customers c on c.id = l.customer_id
      ${join}
      where l.remaining_amount > 0
        ${where}
      group by l.customer_id
      order by coalesce(sum(l.remaining_amount) filter (where l.due_date < ${at}), 0) desc,
               sum(l.remaining_amount) desc
      limit 5
    `,
  );
  const t = totals[0];
  return {
    outstanding: num(t?.outstanding),
    overdue: num(t?.overdue),
    overdueCustomers: t?.overdue_customers ?? 0,
    buckets: {
      b1_30: num(t?.b1_30),
      b31_60: num(t?.b31_60),
      b61_90: num(t?.b61_90),
      b90: num(t?.b90),
    },
    topDebtors: debtors.map((d) => ({
      customerId: d.customer_id,
      name: d.name,
      overdue: num(d.overdue),
      outstanding: num(d.outstanding),
    })),
  };
}

/** Stock is held company-wide (not per branch), so this is not narrowed by branch. */
export async function inventoryHealth(db: DrizzleDb): Promise<{
  activeProducts: number;
  outOfStock: number;
  lowStock: number;
  stockValueAtCost: number;
}> {
  const r = await rows<{ active: number; out_of_stock: number; low: number; value: string }>(
    db,
    sql`
      select count(*)::int as active,
             count(*) filter (where p.stock_quantity - p.reserved_quantity <= 0)::int as out_of_stock,
             count(*) filter (
               where p.stock_quantity - p.reserved_quantity > 0
                 and p.stock_quantity - p.reserved_quantity <= p.low_stock_threshold
             )::int as low,
             coalesce(sum(greatest(p.stock_quantity, 0) * p.cost_price), 0)::text as value
      from products p
      where p.deleted_at is null and p.is_active = true
    `,
  );
  const row = r[0];
  return {
    activeProducts: row?.active ?? 0,
    outOfStock: row?.out_of_stock ?? 0,
    lowStock: row?.low ?? 0,
    stockValueAtCost: num(row?.value),
  };
}

export async function orderAttentionCounts(
  db: DrizzleDb,
  scope: ReportScope,
): Promise<{ awaitingVerification: number; discrepancies: number }> {
  const r = await rows<{ awaiting: number; discrepancy: number }>(
    db,
    sql`
      select count(*) filter (where o.payment_status = 'pending_verification')::int as awaiting,
             count(*) filter (where o.payment_status = 'discrepancy')::int as discrepancy
      from orders o
      where o.payment_status in ('pending_verification', 'discrepancy')
        ${branchFilter(scope, sql`o.branch_id`)}
    `,
  );
  return { awaitingVerification: r[0]?.awaiting ?? 0, discrepancies: r[0]?.discrepancy ?? 0 };
}

export async function pendingApprovals(db: DrizzleDb): Promise<number> {
  const r = await rows<{ n: number }>(
    db,
    sql`select count(*)::int as n from approval_requests where status = 'pending'`,
  );
  return r[0]?.n ?? 0;
}

export async function failedKraTransmissions(db: DrizzleDb, scope: ReportScope): Promise<number> {
  const r = await rows<{ n: number }>(
    db,
    sql`
      select count(*)::int as n
      from kra_transmissions k
      where k.status = 'failed'
        ${branchFilter(scope, sql`k.branch_id`)}
    `,
  );
  return r[0]?.n ?? 0;
}

export type FlowBucket = 'paid' | 'awaiting' | 'credit' | 'unpaid' | 'blocked' | 'lost';

/**
 * Where every order placed in the window ended up. The first three buckets are the ones that
 * count as sales (same rule as SALE above); the rest explain why an order is not in the sales
 * figure, so a low number is never a mystery.
 */
export async function orderFlow(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<Record<FlowBucket, { count: number; value: number }>> {
  const r = await rows<{ bucket: FlowBucket; count: number; value: string }>(
    db,
    sql`
      select bucket, count(*)::int as count, coalesce(sum(total_amount), 0)::text as value
      from (
        select o.total_amount,
          case
            when o.status in ('failed', 'cancelled', 'refunded') or o.payment_status = 'failed' then 'lost'
            when o.approval_status in ('rejected', 'draft') then 'blocked'
            when o.payment_status in ('paid', 'reconciled') then 'paid'
            when o.payment_status in ('pending_verification', 'discrepancy') then 'awaiting'
            when o.trade_customer_id is not null then 'credit'
            else 'unpaid'
          end as bucket
        from orders o
        where o.created_at >= ${ts(w.from)} and o.created_at < ${ts(w.to)}
          and o.currency = ${currency}
          ${branchFilter(scope, sql`o.branch_id`)}
      ) t
      group by bucket
    `,
  );
  const out = {} as Record<FlowBucket, { count: number; value: number }>;
  for (const key of ['paid', 'awaiting', 'credit', 'unpaid', 'blocked', 'lost'] as const) {
    const row = r.find((x) => x.bucket === key);
    out[key] = { count: row?.count ?? 0, value: num(row?.value) };
  }
  return out;
}

export async function salesByBranch(
  db: DrizzleDb,
  w: TimeWindow,
  currency: string,
): Promise<Map<string, { name: string; sales: number; orders: number }>> {
  const r = await rows<{
    branch_id: string | null;
    name: string | null;
    sales: string;
    orders: number;
  }>(
    db,
    sql`
      select o.branch_id, max(b.name) as name,
             coalesce(sum(o.total_amount), 0)::text as sales, count(*)::int as orders
      from orders o
      left join branches b on b.id = o.branch_id
      where o.created_at >= ${ts(w.from)} and o.created_at < ${ts(w.to)}
        and o.currency = ${currency}
        and ${SALE}
      group by o.branch_id
    `,
  );
  return new Map(
    r.map((x) => [
      x.branch_id ?? 'none',
      { name: x.name ?? 'No branch', sales: num(x.sales), orders: x.orders },
    ]),
  );
}

/** Payments started in the window that have not been confirmed, and ones that failed. */
export async function paymentsInFlight(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<{ pendingCount: number; pendingAmount: number; failedCount: number }> {
  const r = await rows<{ pending: number; pending_amount: string; failed: number }>(
    db,
    sql`
      select count(*) filter (where a.status in ('initiated', 'pending', 'awaiting_redirect'))::int as pending,
             coalesce(sum(a.amount) filter (where a.status in ('initiated', 'pending', 'awaiting_redirect')), 0)::text as pending_amount,
             count(*) filter (where a.status in ('failed', 'cancelled', 'expired'))::int as failed
      from payment_attempts a
      where a.created_at >= ${ts(w.from)} and a.created_at < ${ts(w.to)}
        and a.currency = ${currency}
        ${branchFilter(scope, sql`a.branch_id`)}
    `,
  );
  const row = r[0];
  return {
    pendingCount: row?.pending ?? 0,
    pendingAmount: num(row?.pending_amount),
    failedCount: row?.failed ?? 0,
  };
}

/** When the business last took an order, in the business timezone (YYYY-MM-DD), or null if never. */
export async function lastOrderDate(
  db: DrizzleDb,
  scope: ReportScope,
  timeZone: string,
): Promise<string | null> {
  const r = await rows<{ day: string | null }>(
    db,
    sql`
      select to_char(max(o.created_at) at time zone ${timeZone}, 'YYYY-MM-DD') as day
      from orders o
      where true ${branchFilter(scope, sql`o.branch_id`)}
    `,
  );
  return r[0]?.day ?? null;
}
