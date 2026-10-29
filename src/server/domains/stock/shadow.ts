import { asc, eq, gt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { products, stockSettings } from '@/server/db/drizzle/schema';
import { StockError } from './errors';
import type { StockLocationService } from './locations';

interface Row extends Record<string, unknown> {
  product_id: string;
  location_id?: string;
  expected: string | number;
  found: string | number;
  total?: string | number;
  n?: string | number;
}
const BATCH = 200;

export interface ShadowProblem {
  kind: 'on_hand_differs' | 'reserved_differs' | 'ledger_differs' | 'negative_on_hand' | 'reservation_differs';
  productId: string;
  locationId?: string;
  expected: number;
  found: number;
}

export interface ShadowReport {
  /** Products checked. */
  products: number;
  onHandDiffers: number;
  reservedDiffers: number;
  ledgerDiffers: number;
  negative: number;
  /** Balances whose reserved quantity is not the sum of the open holds (checked once the ledger holds the reservations). */
  reservationsDiffer: number;
  /** The first few of each, with the numbers, so a person can find them. */
  sample: ShadowProblem[];
}

const SAMPLE = 25;

/**
 * The shadow of the migration (design §10, steps 1 and 2): while it is on, the old stock counters are mirrored into the new ledger by
 * database triggers; the backfill brings every product's history and balance across; the comparison proves the two agree. The old
 * counters stay the source of truth until the cut-over.
 */
export class StockShadow {
  constructor(
    private readonly db: DrizzleDb,
    private readonly locations: StockLocationService,
  ) {}

  private async ensureSettings(companyId: string): Promise<void> {
    await this.db.insert(stockSettings).values({ companyId }).onConflictDoNothing();
  }

  async status(companyId: string): Promise<{ shadowWrite: boolean; backfillCursor: string | null; backfillDoneAt: Date | null }> {
    await this.ensureSettings(companyId);
    const [row] = await this.db.select().from(stockSettings).where(eq(stockSettings.companyId, companyId)).limit(1);
    return { shadowWrite: row?.shadowWrite ?? false, backfillCursor: row?.backfillCursor ?? null, backfillDoneAt: row?.backfillDoneAt ?? null };
  }

  /** Switches the mirror on or off. Switching it on starts a new backfill pass, since the mirror alone does not bring old stock across. */
  async setShadow(companyId: string, on: boolean): Promise<void> {
    await this.ensureSettings(companyId);
    if (on && (await this.db.select({ l: stockSettings.ledgerMode }).from(stockSettings).where(eq(stockSettings.companyId, companyId)))[0]?.l === true) {
      throw new StockError('The ledger is already the truth, so there is nothing left to mirror.', 'LEDGER_MODE');
    }
    await this.locations.ensureDefault(companyId);
    await this.db
      .update(stockSettings)
      .set(on ? { shadowWrite: true, backfillCursor: null, backfillDoneAt: null, updatedAt: sql`now()` } : { shadowWrite: false, updatedAt: sql`now()` })
      .where(eq(stockSettings.companyId, companyId));
  }

  /**
   * Brings one product across, under the product's row lock so no sale can slip between the copy and the balance: its history becomes
   * movements at the default location, an opening movement covers whatever the history does not explain, and the balance takes the
   * product's counters. Safe to repeat.
   */
  async backfillProduct(companyId: string, productId: string): Promise<boolean> {
    const loc = await this.locations.ensureDefault(companyId);
    return await this.db.transaction(async (tx) => {
      const [p] = await tx
        .select({ stock: products.stockQuantity, reserved: products.reservedQuantity, cost: products.costPrice })
        .from(products)
        .where(eq(products.id, productId))
        .for('update')
        .limit(1);
      if (p === undefined) return false;
      // A product the ledger already manages (it has movements the ledger itself wrote) is never overwritten from the old counter.
      const native = [...(await tx.execute<Row>(sql`SELECT 1 AS n FROM stock_movements WHERE product_id = ${productId} AND legacy_movement_id IS NULL AND NOT migrated LIMIT 1`))];
      if (native.length > 0) return false;
      const cost = p.cost;
      await tx.execute(sql`
        INSERT INTO stock_movements (company_id, product_id, location_id, shard, movement_type, quantity, unit_cost, document_type, document_id,
                                     actor_type, occurred_at, note, legacy_movement_id, migrated)
        SELECT ${companyId}::uuid, im.product_id, ${loc.id}::uuid, 0, stock_movement_kind(im.change_type), im.new_stock - im.previous_stock, ${cost}::numeric,
               'inventory_journal', im.reference_id, 'legacy', im.created_at, im.note, im.id, true
        FROM inventory_movements im
        WHERE im.product_id = ${productId}
          AND im.change_type NOT IN ('order_reservation', 'order_cancellation_release', 'cost_change')
          AND im.new_stock <> im.previous_stock
        ORDER BY im.created_at, im.id
        ON CONFLICT (legacy_movement_id) WHERE legacy_movement_id IS NOT NULL DO NOTHING`);
      const [sum] = [...(await tx.execute<Row>(sql`SELECT COALESCE(sum(quantity), 0)::numeric AS total FROM stock_movements WHERE product_id = ${productId} AND location_id = ${loc.id}::uuid`))];
      const gap = Math.round((p.stock - Number(sum?.total ?? 0)) * 1000) / 1000;
      if (gap !== 0) {
        await tx.execute(sql`
          INSERT INTO stock_movements (company_id, product_id, location_id, shard, movement_type, quantity, unit_cost, document_type, document_id,
                                       actor_type, note, migrated)
          VALUES (${companyId}::uuid, ${productId}, ${loc.id}::uuid, 0, 'opening', ${gap}, ${cost}::numeric, 'migration', 'backfill', 'system',
                  'Opening balance from the product counter', true)`);
      }
      await tx.execute(sql`
        INSERT INTO stock_balances (company_id, product_id, location_id, shard, on_hand, reserved, version)
        VALUES (${companyId}::uuid, ${productId}, ${loc.id}::uuid, 0, ${p.stock}, ${p.reserved}, 1)
        ON CONFLICT (product_id, location_id, shard)
        DO UPDATE SET on_hand = EXCLUDED.on_hand, reserved = EXCLUDED.reserved, version = stock_balances.version + 1, updated_at = now()`);
      return true;
    });
  }

  /** One slice of the backfill, in product-id order from where the last one stopped. Returns how many products it brought across and whether it is finished. */
  async backfillBatch(companyId: string, limit = BATCH): Promise<{ done: number; finished: boolean }> {
    const status = await this.status(companyId);
    if (!status.shadowWrite) throw new StockError('Switch the shadow on before the backfill, so no sale is missed in between.', 'SHADOW_OFF');
    if (status.backfillDoneAt !== null) return { done: 0, finished: true };
    const ids = await this.db
      .select({ id: products.id })
      .from(products)
      .where(status.backfillCursor === null ? undefined : gt(products.id, status.backfillCursor))
      .orderBy(asc(products.id))
      .limit(limit);
    let done = 0;
    for (const { id } of ids) if (await this.backfillProduct(companyId, id)) done++;
    const last = ids.at(-1);
    const finished = ids.length < limit;
    await this.db
      .update(stockSettings)
      .set({ backfillCursor: last?.id ?? status.backfillCursor, backfillDoneAt: finished ? sql`now()` : null, updatedAt: sql`now()` })
      .where(eq(stockSettings.companyId, companyId));
    return { done, finished };
  }

  /** Proves the new ledger agrees with the old counters. Never changes anything. */
  async compare(): Promise<ShadowReport> {
    const sample: ShadowProblem[] = [];
    const take = (kind: ShadowProblem['kind'], rows: Row[]) => {
      for (const r of rows) {
        if (sample.length >= SAMPLE * 4) break;
        sample.push({ kind, productId: r.product_id, locationId: r.location_id, expected: Number(r.expected), found: Number(r.found) });
      }
    };
    const [total] = [...(await this.db.execute<Row>(sql`SELECT count(*)::int AS n FROM products`))];
    const onHand = [...(await this.db.execute<Row>(sql`
      SELECT p.id AS product_id, p.stock_quantity AS expected, COALESCE(sum(b.on_hand), 0) AS found
      FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id
      GROUP BY p.id HAVING p.stock_quantity <> COALESCE(sum(b.on_hand), 0)
      ORDER BY p.id LIMIT 1000`))];
    const reserved = [...(await this.db.execute<Row>(sql`
      SELECT p.id AS product_id, p.reserved_quantity AS expected, COALESCE(sum(b.reserved), 0) AS found
      FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id
      GROUP BY p.id HAVING p.reserved_quantity <> COALESCE(sum(b.reserved), 0)
      ORDER BY p.id LIMIT 1000`))];
    const ledger = [...(await this.db.execute<Row>(sql`
      SELECT COALESCE(m.product_id, b.product_id) AS product_id, COALESCE(m.location_id, b.location_id) AS location_id,
             COALESCE(m.total, 0) AS expected, COALESCE(b.total, 0) AS found
      FROM (SELECT product_id, location_id, sum(quantity) AS total FROM stock_movements GROUP BY product_id, location_id) m
      FULL JOIN (SELECT product_id, location_id, sum(on_hand) AS total FROM stock_balances GROUP BY product_id, location_id) b
        ON b.product_id = m.product_id AND b.location_id = m.location_id
      WHERE COALESCE(m.total, 0) <> COALESCE(b.total, 0)
        AND EXISTS (SELECT 1 FROM products p WHERE p.id = COALESCE(m.product_id, b.product_id))
      ORDER BY 1 LIMIT 1000`))];
    const negative = [...(await this.db.execute<Row>(sql`
      SELECT b.product_id, b.location_id, 0 AS expected, sum(b.on_hand) AS found
      FROM stock_balances b JOIN stock_locations l ON l.id = b.location_id
      WHERE NOT l.allow_negative GROUP BY b.product_id, b.location_id HAVING sum(b.on_hand) < 0
      ORDER BY 1 LIMIT 1000`))];
    const ledgerMode = (await this.db.select({ l: stockSettings.ledgerMode }).from(stockSettings).where(sql`${stockSettings.companyId} = stock_current_company()`).limit(1))[0]?.l === true;
    const holds = ledgerMode
      ? [...(await this.db.execute<Row>(sql`
          SELECT COALESCE(r.product_id, b.product_id) AS product_id, COALESCE(r.location_id, b.location_id) AS location_id,
                 COALESCE(r.total, 0) AS expected, COALESCE(b.total, 0) AS found
          FROM (SELECT product_id, location_id, sum(quantity - consumed - released) AS total FROM stock_reservations WHERE state IN ('held', 'partly_consumed') GROUP BY product_id, location_id) r
          FULL JOIN (SELECT product_id, location_id, sum(reserved) AS total FROM stock_balances GROUP BY product_id, location_id) b
            ON b.product_id = r.product_id AND b.location_id = r.location_id
          WHERE COALESCE(r.total, 0) <> COALESCE(b.total, 0)
          ORDER BY 1 LIMIT 1000`))]
      : [];
    take('reservation_differs', holds.slice(0, SAMPLE));
    take('on_hand_differs', onHand.slice(0, SAMPLE));
    take('reserved_differs', reserved.slice(0, SAMPLE));
    take('ledger_differs', ledger.slice(0, SAMPLE));
    take('negative_on_hand', negative.slice(0, SAMPLE));
    return { products: Number(total?.n ?? 0), onHandDiffers: onHand.length, reservedDiffers: reserved.length, ledgerDiffers: ledger.length, negative: negative.length, reservationsDiffer: holds.length, sample };
  }
}
