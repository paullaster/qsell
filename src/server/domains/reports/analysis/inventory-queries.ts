import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { TimeWindow } from '../period';
import { SALE, num, rows, ts } from '../queries';

/**
 * The stock reads behind the inventory reports. A stocked product is one that is active, not deleted, and of the kind that
 * holds stock (a service or a non-stock item is never "out of stock"). Stock and cost are read as they are now; sales speed is
 * read from the last 30 days of sales, counted the way the Business Overview counts a sale.
 */

export const STOCKED = sql`p.deleted_at is null and p.is_active = true and p.inventory_kind = 'inventory'`;

export interface StockRow {
  id: string;
  name: string;
  category: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number;
  /** Cost per unit; null when no cost is recorded (value is then unknown, not zero). */
  cost: number | null;
  soldRecently: number;
  /** The latest sale of this product ever, as ISO text; null when it has never sold. */
  lastSoldAt: string | null;
  unitsSold90: number;
}

export const STOCK_LIMIT = 500;

interface Raw {
  id: string;
  name: string;
  category: string;
  on_hand: string;
  reserved: string;
  reorder: string;
  cost: string | null;
  sold_recent: string;
  sold_90: string;
  last_sold_at: string | null;
}

const toRow = (r: Raw): StockRow => ({
  id: r.id,
  name: r.name,
  category: r.category,
  onHand: num(r.on_hand),
  reserved: num(r.reserved),
  available: num(r.on_hand) - num(r.reserved),
  reorderLevel: num(r.reorder),
  cost: r.cost === null ? null : num(r.cost),
  soldRecently: num(r.sold_recent),
  unitsSold90: num(r.sold_90),
  lastSoldAt: r.last_sold_at,
});

/**
 * Every stocked product with its stock, its cost and how it has been selling. `now` fixes "recently" (30 days) and the 90-day
 * window, so the answer for a given instant is repeatable. Biggest stock value first, capped at `limit`.
 */
function filterClause(filter: StockFilter, slowCut: Date) {
  if (filter === 'low') {
    return sql`and p.stock_quantity - p.reserved_quantity <= greatest(p.low_stock_threshold, 0)`;
  }
  if (filter === 'slow') {
    return sql`and p.stock_quantity > 0 and (s.last_at is null or s.last_at < ${ts(slowCut)})`;
  }
  return sql``;
}

export type StockFilter = 'all' | 'low' | 'slow';

export async function stockPosition(
  db: DrizzleDb,
  now: Date,
  currency: string,
  options: { filter?: StockFilter; limit?: number } = {},
): Promise<{ rows: StockRow[]; total: number }> {
  const limit = options.limit ?? STOCK_LIMIT;
  const filter = options.filter ?? 'all';
  const slowCut = new Date(now.getTime() - 30 * 86_400_000);
  const having = filterClause(filter, slowCut);
  const order =
    filter === 'low'
      ? sql`order by p.stock_quantity - p.reserved_quantity asc, p.name, p.id`
      : sql`order by greatest(p.stock_quantity, 0) * coalesce(p.cost_price, 0) desc, p.name, p.id`;
  const recent = new Date(now.getTime() - 30 * 86_400_000);
  const ninety = new Date(now.getTime() - 90 * 86_400_000);
  const r = await rows<Raw>(
    db,
    sql`
      select p.id,
             p.name,
             coalesce(nullif(p.category_name, ''), 'Not in a category') as category,
             p.stock_quantity::text as on_hand,
             p.reserved_quantity::text as reserved,
             p.low_stock_threshold::text as reorder,
             p.cost_price::text as cost,
             coalesce(s.sold_recent, 0)::text as sold_recent,
             coalesce(s.sold_90, 0)::text as sold_90,
             to_char(s.last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_sold_at
      from products p
      left join lateral (
        select sum(i.quantity) filter (where o.created_at >= ${ts(recent)}) as sold_recent,
               sum(i.quantity) filter (where o.created_at >= ${ts(ninety)}) as sold_90,
               max(o.created_at) as last_at
        from order_items i
        join orders o on o.id = i.order_id
        where i.product_id = p.id and i.is_gift = false
          and o.created_at < ${ts(now)} and o.currency = ${currency} and ${SALE}
      ) s on true
      where ${STOCKED} ${having}
      ${order}
      limit ${limit}
    `,
  );
  return { rows: r.map(toRow), total: r.length };
}

/** Stock value (at cost) by location, from the per-location balances. */
export interface LocationValue {
  id: string;
  name: string;
  kind: string;
  units: number;
  value: number;
}

export async function valueByLocation(db: DrizzleDb): Promise<LocationValue[]> {
  const r = await rows<{ id: string; name: string; kind: string; units: string; value: string }>(
    db,
    sql`
      select l.id::text as id, l.name, l.kind,
             coalesce(sum(greatest(b.on_hand, 0)), 0)::text as units,
             coalesce(sum(greatest(b.on_hand, 0) * coalesce(p.cost_price, 0)), 0)::text as value
      from stock_locations l
      join stock_balances b on b.location_id = l.id
      join products p on p.id = b.product_id and ${STOCKED}
      where l.is_active = true
      group by l.id, l.name, l.kind
      having coalesce(sum(greatest(b.on_hand, 0)), 0) > 0
      order by sum(greatest(b.on_hand, 0) * coalesce(p.cost_price, 0)) desc, l.name
    `,
  );
  return r.map((x) => ({
    id: x.id,
    name: x.name,
    kind: x.kind,
    units: num(x.units),
    value: num(x.value),
  }));
}

/** What moved stock in a window, by product, split into the kinds a person thinks in. */
export interface MovementRow {
  id: string;
  name: string;
  received: number;
  returnedToSupplier: number;
  sold: number;
  returnedByCustomers: number;
  adjusted: number;
  netChange: number;
  onHandNow: number;
}

export async function stockMovements(
  db: DrizzleDb,
  w: TimeWindow,
  limit = STOCK_LIMIT,
): Promise<MovementRow[]> {
  const r = await rows<{
    id: string;
    name: string;
    received: string;
    returned_supplier: string;
    sold: string;
    returned_customers: string;
    adjusted: string;
    net: string;
    on_hand: string;
  }>(
    db,
    sql`
      select p.id, p.name,
        coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'opening', 'receipt_reversal')), 0)::text as received,
        coalesce(sum(m.quantity) filter (where m.movement_type = 'purchase_return'), 0)::text as returned_supplier,
        coalesce(sum(m.quantity) filter (where m.movement_type = 'sale_issue'), 0)::text as sold,
        coalesce(sum(m.quantity) filter (where m.movement_type = 'sale_return'), 0)::text as returned_customers,
        coalesce(sum(m.quantity) filter (where m.movement_type in ('adjustment', 'count_variance', 'write_off', 'delete_adjust')), 0)::text as adjusted,
        coalesce(sum(m.quantity) filter (where m.movement_type not in ('transfer_in', 'transfer_out', 'cost_revaluation')), 0)::text as net,
        p.stock_quantity::text as on_hand
      from stock_movements m
      join products p on p.id = m.product_id
      where m.occurred_at >= ${ts(w.from)} and m.occurred_at < ${ts(w.to)}
      group by p.id, p.name, p.stock_quantity
      having coalesce(sum(m.quantity) filter (where m.movement_type not in ('transfer_in', 'transfer_out', 'cost_revaluation')), 0) <> 0
          or count(*) filter (where m.movement_type not in ('transfer_in', 'transfer_out', 'cost_revaluation')) > 0
      order by abs(coalesce(sum(m.quantity) filter (where m.movement_type not in ('transfer_in', 'transfer_out', 'cost_revaluation')), 0)) desc, p.name
      limit ${limit}
    `,
  );
  return r.map((x) => ({
    id: x.id,
    name: x.name,
    received: num(x.received),
    returnedToSupplier: num(x.returned_supplier),
    sold: num(x.sold),
    returnedByCustomers: num(x.returned_customers),
    adjusted: num(x.adjusted),
    netChange: num(x.net),
    onHandNow: num(x.on_hand),
  }));
}
