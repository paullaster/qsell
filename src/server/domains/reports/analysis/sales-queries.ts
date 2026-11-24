import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { TimeWindow } from '../period';
import { SALE, branchFilter, num, rows, ts } from '../queries';
import type { ReportScope } from '../types';

/**
 * The queries behind the sales reports. Every one counts an order the way the Business Overview does (`SALE`), is bounded by
 * a window and the viewer's branch scope, sums in the database and returns only the grouped rows. Money is `numeric` until
 * the edge. Two families:
 *  - item cuts (product, category, supplier) group order lines, so a sale is counted once per product it contains;
 *  - order cuts (branch, customer, day, weekday, hour) group whole orders, so their totals are exactly the overview's.
 */

export type ItemCut = 'product' | 'category' | 'vendor';
export type OrderCut = 'branch' | 'customer' | 'day' | 'weekday' | 'hour';

export interface CutRow {
  key: string;
  label: string;
  /** Item cuts: the lines' value before tax and delivery. Order cuts: the order totals (what the overview calls sales). */
  sales: number;
  units: number;
  orders: number;
  /** Cost of the lines whose cost is known, and the value of those same lines. */
  cost: number;
  knownSales: number;
  tax: number;
  /** The latest and earliest order in the group, as ISO text. */
  lastAt: string | null;
  firstAt: string | null;
}

interface Raw {
  key: string;
  label: string;
  sales: string;
  units: string;
  orders: number;
  cost: string;
  known_sales: string;
  tax: string;
  last_at: string | null;
  first_at: string | null;
}

const toRow = (r: Raw): CutRow => ({
  key: r.key,
  label: r.label,
  sales: num(r.sales),
  units: num(r.units),
  orders: r.orders,
  cost: num(r.cost),
  knownSales: num(r.known_sales),
  tax: num(r.tax),
  lastAt: r.last_at,
  firstAt: r.first_at,
});

const windowOf = (w: TimeWindow) =>
  sql`o.created_at >= ${ts(w.from)} and o.created_at < ${ts(w.to)}`;

/** The most rows any grouped read returns. A cut with more is trimmed to its biggest and the report says so. */
export const CUT_LIMIT = 500;

function itemKey(cut: ItemCut) {
  if (cut === 'product') return sql`i.product_id`;
  if (cut === 'category') return sql`coalesce(p.category_id, 'none')`;
  return sql`coalesce(s.vendor_id::text, 'none')`;
}

function itemLabel(cut: ItemCut) {
  if (cut === 'product') return sql`max(i.product_name)`;
  if (cut === 'category')
    return sql`coalesce(nullif(max(p.category_name), ''), 'Not in a category')`;
  return sql`coalesce(max(coalesce(v.trading_name, v.legal_name)), 'No supplier on record')`;
}

function itemJoins(cut: ItemCut) {
  if (cut === 'category') return sql`left join products p on p.id = i.product_id`;
  if (cut === 'vendor') {
    return sql`left join supplier s on s.product_id = i.product_id left join vendors v on v.id = s.vendor_id`;
  }
  return sql``;
}

/** The supplier of a product is the vendor of its latest purchase order that was approved or beyond. */
const SUPPLIER_CTE = sql`with supplier as (
  select distinct on (pl.product_id) pl.product_id, po.vendor_id
  from purchase_order_lines pl
  join purchase_orders po on po.id = pl.po_id
  where pl.product_id is not null
    and po.status not in ('draft', 'pending_approval', 'cancelled')
  order by pl.product_id, po.order_date desc, po.created_at desc
)`;

/** Item cuts. A product is counted in the category it is in today. */
export async function salesByItemCut(
  db: DrizzleDb,
  cut: ItemCut,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
  limit = CUT_LIMIT,
): Promise<CutRow[]> {
  const key = itemKey(cut);
  const r = await rows<Raw>(
    db,
    sql`
      ${cut === 'vendor' ? SUPPLIER_CTE : sql``}
      select ${key} as key,
             ${itemLabel(cut)} as label,
             coalesce(sum(i.total_price), 0)::text as sales,
             coalesce(sum(i.quantity), 0)::text as units,
             count(distinct o.id)::int as orders,
             coalesce(sum(i.unit_cost * i.quantity) filter (where i.unit_cost is not null), 0)::text as cost,
             coalesce(sum(i.total_price) filter (where i.unit_cost is not null), 0)::text as known_sales,
             '0' as tax,
             to_char(max(o.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_at,
             to_char(min(o.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as first_at
      from orders o
      join order_items i on i.order_id = o.id
      ${itemJoins(cut)}
      where ${windowOf(w)}
        and o.currency = ${currency}
        and i.is_gift = false
        and ${SALE}
        ${branchFilter(scope, sql`o.branch_id`)}
      group by 1
      order by sum(i.total_price) desc, 1
      limit ${limit}
    `,
  );
  return r.map(toRow);
}

function orderKey(cut: OrderCut, timeZone: string) {
  switch (cut) {
    case 'branch':
      return sql`coalesce(o.branch_id::text, 'none')`;
    case 'customer':
      return sql`coalesce(o.trade_customer_id::text, nullif(o.user_id, ''), nullif(o.customer_phone, ''), nullif(o.customer_email, ''), 'walk-in')`;
    case 'day':
      return sql`to_char(o.created_at at time zone ${timeZone}, 'YYYY-MM-DD')`;
    case 'weekday':
      return sql`to_char(o.created_at at time zone ${timeZone}, 'ID')`;
    case 'hour':
      return sql`to_char(o.created_at at time zone ${timeZone}, 'HH24')`;
  }
}

/** Order cuts: whole orders, with the lines' units and cost attached once per order. */
export async function salesByOrderCut(
  db: DrizzleDb,
  cut: OrderCut,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
  timeZone: string,
  limit = CUT_LIMIT,
): Promise<CutRow[]> {
  const key = orderKey(cut, timeZone);
  let label = sql`min(${key})`;
  let joins = sql``;
  if (cut === 'branch') {
    label = sql`coalesce(max(b.name), 'No branch')`;
    joins = sql`left join branches b on b.id = o.branch_id`;
  } else if (cut === 'customer') {
    label = sql`coalesce(max(c.name), max(nullif(o.customer_name, '')), 'Walk-in customer')`;
    joins = sql`left join customers c on c.id = o.trade_customer_id`;
  }
  const timeCut = cut === 'day' || cut === 'weekday' || cut === 'hour';
  const order = timeCut ? sql`order by 1` : sql`order by sum(o.total_amount) desc, 1`;
  const r = await rows<Raw>(
    db,
    sql`
      select ${key} as key,
             ${label} as label,
             coalesce(sum(o.total_amount), 0)::text as sales,
             coalesce(sum(a.units), 0)::text as units,
             count(*)::int as orders,
             coalesce(sum(a.cost), 0)::text as cost,
             coalesce(sum(a.known_sales), 0)::text as known_sales,
             coalesce(sum(o.tax), 0)::text as tax,
             to_char(max(o.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_at,
             to_char(min(o.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as first_at
      from orders o
      ${joins}
      left join lateral (
        select sum(i.quantity) as units,
               sum(i.unit_cost * i.quantity) filter (where i.unit_cost is not null) as cost,
               sum(i.total_price) filter (where i.unit_cost is not null) as known_sales
        from order_items i
        where i.order_id = o.id and i.is_gift = false
      ) a on true
      where ${windowOf(w)}
        and o.currency = ${currency}
        and ${SALE}
        ${branchFilter(scope, sql`o.branch_id`)}
      group by 1
      ${order}
      limit ${limit}
    `,
  );
  return r.map(toRow);
}

/** What the orders in a window add up to, split the way a receipt is: items, tax, delivery and the total. */
export interface OrderTotals {
  items: number;
  tax: number;
  delivery: number;
  total: number;
  orders: number;
}

export async function orderTotals(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<OrderTotals> {
  const r = await rows<{
    items: string;
    tax: string;
    delivery: string;
    total: string;
    orders: number;
  }>(
    db,
    sql`
      select coalesce(sum(o.subtotal), 0)::text as items,
             coalesce(sum(o.tax), 0)::text as tax,
             coalesce(sum(o.shipping_fee), 0)::text as delivery,
             coalesce(sum(o.total_amount), 0)::text as total,
             count(*)::int as orders
      from orders o
      where ${windowOf(w)} and o.currency = ${currency} and ${SALE}
        ${branchFilter(scope, sql`o.branch_id`)}
    `,
  );
  const x = r[0];
  return {
    items: num(x?.items),
    tax: num(x?.tax),
    delivery: num(x?.delivery),
    total: num(x?.total),
    orders: x?.orders ?? 0,
  };
}

/**
 * New against returning customers in a window. A customer is whoever the order names (a trade customer, a signed-in
 * shopper, a phone number or an email); an order with none of those is a walk-in and is not counted as a person. A customer
 * is "new" when their first sale ever falls in the window, and "returning" when they bought before it.
 */
export interface CustomerMix {
  newCustomers: number;
  returningCustomers: number;
  newSales: number;
  returningSales: number;
  walkInOrders: number;
  walkInSales: number;
  /** People who bought more than once inside the window. */
  repeatBuyers: number;
  /** Median gap between two orders of the same customer in the window, in days; null when no one bought twice. */
  medianDaysBetween: number | null;
}

export async function customerMix(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<CustomerMix> {
  const person = sql`coalesce(o.trade_customer_id::text, nullif(o.user_id, ''), nullif(o.customer_phone, ''), nullif(o.customer_email, ''))`;
  const r = await rows<{
    new_customers: number;
    returning_customers: number;
    new_sales: string;
    returning_sales: string;
    walk_in_orders: number;
    walk_in_sales: string;
    repeat_buyers: number;
    median_days: string | null;
  }>(
    db,
    sql`
      with first_seen as (
        select ${person} as person, min(o.created_at) as first_at
        from orders o
        where o.created_at < ${ts(w.to)} and o.currency = ${currency} and ${SALE}
          and ${person} is not null
        group by 1
      ),
      in_window as (
        select o.id, ${person} as person, o.total_amount, o.created_at
        from orders o
        where ${windowOf(w)} and o.currency = ${currency} and ${SALE}
          ${branchFilter(scope, sql`o.branch_id`)}
      ),
      per_person as (
        select x.person,
               f.first_at >= ${ts(w.from)} as is_new,
               count(*) as orders,
               sum(x.total_amount) as sales
        from in_window x join first_seen f on f.person = x.person
        group by x.person, f.first_at
      ),
      gaps as (
        select extract(epoch from (created_at - lag(created_at) over (partition by person order by created_at))) / 86400 as days
        from in_window where person is not null
      )
      select count(*) filter (where is_new)::int as new_customers,
             count(*) filter (where not is_new)::int as returning_customers,
             coalesce(sum(sales) filter (where is_new), 0)::text as new_sales,
             coalesce(sum(sales) filter (where not is_new), 0)::text as returning_sales,
             (select count(*)::int from in_window where person is null) as walk_in_orders,
             (select coalesce(sum(total_amount), 0)::text from in_window where person is null) as walk_in_sales,
             count(*) filter (where orders > 1)::int as repeat_buyers,
             (select percentile_cont(0.5) within group (order by days)::text from gaps where days is not null) as median_days
      from per_person
    `,
  );
  const x = r[0];
  return {
    newCustomers: x?.new_customers ?? 0,
    returningCustomers: x?.returning_customers ?? 0,
    newSales: num(x?.new_sales),
    returningSales: num(x?.returning_sales),
    walkInOrders: x?.walk_in_orders ?? 0,
    walkInSales: num(x?.walk_in_sales),
    repeatBuyers: x?.repeat_buyers ?? 0,
    medianDaysBetween:
      x?.median_days === null || x?.median_days === undefined ? null : num(x.median_days),
  };
}

/** Sales returns (credit notes) in a window, by reason and by product. */
export interface ReturnRow {
  key: string;
  label: string;
  amount: number;
  quantity: number;
  notes: number;
}

export async function returnsByReason(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
): Promise<ReturnRow[]> {
  const r = await rows<{ key: string; amount: string; notes: number }>(
    db,
    sql`
      select cn.reason_code as key, sum(cn.total_amount)::text as amount, count(*)::int as notes
      from credit_notes cn
      where cn.created_at >= ${ts(w.from)} and cn.created_at < ${ts(w.to)}
        and cn.currency = ${currency}
        ${branchFilter(scope, sql`cn.branch_id`)}
      group by cn.reason_code
      order by sum(cn.total_amount) desc
    `,
  );
  return r.map((x) => ({
    key: x.key,
    label: x.key,
    amount: num(x.amount),
    quantity: 0,
    notes: x.notes,
  }));
}

export async function returnsByProduct(
  db: DrizzleDb,
  w: TimeWindow,
  scope: ReportScope,
  currency: string,
  limit = CUT_LIMIT,
): Promise<ReturnRow[]> {
  const r = await rows<{
    key: string;
    label: string;
    amount: string;
    quantity: string;
    notes: number;
  }>(
    db,
    sql`
      select l.product_id as key, max(l.description) as label,
             sum(l.amount)::text as amount, sum(l.quantity)::text as quantity,
             count(distinct cn.id)::int as notes
      from credit_notes cn
      join credit_note_lines l on l.credit_note_id = cn.id
      where cn.created_at >= ${ts(w.from)} and cn.created_at < ${ts(w.to)}
        and cn.currency = ${currency}
        ${branchFilter(scope, sql`cn.branch_id`)}
      group by l.product_id
      order by sum(l.amount) desc
      limit ${limit}
    `,
  );
  return r.map((x) => ({
    key: x.key,
    label: x.label,
    amount: num(x.amount),
    quantity: num(x.quantity),
    notes: x.notes,
  }));
}
