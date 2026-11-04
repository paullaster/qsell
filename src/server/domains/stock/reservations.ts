import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { inventoryMovements, products, stockBalances, stockLocations, stockReservations } from '@/server/db/drizzle/schema';
import { planSourcing, mergeLines, type SourcingLine } from '@/lib/stock-sourcing';
import type { SalesChannel } from '@/lib/stock';
import type { StockLedger } from './ledger';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { StockError } from './errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
const round = (n: number): number => Math.round(n * 1000) / 1000;
const OPEN = ['held', 'partly_consumed'] as const;
const releasedState = (expired: boolean): 'expired' | 'released' => (expired ? 'expired' : 'released');

export interface ReserveInput {
  companyId: string;
  refType: string;
  refId: string;
  lines: readonly SourcingLine[];
  channel: SalesChannel;
  /** The order's branch: locations of that branch are tried first. */
  branchId?: string | null;
  /** When the hold lapses if nothing settles it. None holds it until settled or released. */
  expiresAt?: Date | null;
  actor: string;
}

export interface Reserved {
  productId: string;
  locationId: string;
  shard: number;
  quantity: number;
}

export type ReserveResult = { ok: true; reserved: Reserved[] } | { ok: false; error: string; productId: string };

export interface SettleInput {
  companyId: string;
  refType: string;
  refId: string;
  actor: string;
}

export interface ExpiredRef {
  refType: string;
  refId: string;
  quantity: number;
}

/**
 * Holds on stock with a life. Reserve chooses the location (one for the whole order if any can cover it), locks the balances in a
 * fixed order so two baskets cannot wait on each other, and records the hold and why it was placed there. Consume turns a hold into
 * the physical issue; release gives it back. All three are safe to repeat. Design: docs/architecture/stock-locations.md §4.4, §5, §6.2, §7.3.
 */
export class StockReservations {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ledger: StockLedger,
    private readonly decisionLog?: DecisionLog,
  ) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    return await this.db.transaction((tx) => this.reserveIn(tx, input));
  }

  async reserveIn(tx: Tx, input: ReserveInput): Promise<ReserveResult> {
    const wanted = mergeLines(input.lines).filter((l) => l.quantity > 0);
    if (wanted.length === 0) return { ok: true, reserved: [] };

    const kinds = await tx.select({ id: products.id, inventoryKind: products.inventoryKind }).from(products).where(inArray(products.id, wanted.map((line) => line.productId)));
    const kindById = new Map(kinds.map((product) => [product.id, product.inventoryKind]));
    const notInventory = wanted.find((line) => kindById.get(line.productId) !== 'inventory');
    if (notInventory !== undefined) {
      const [product] = await tx.select({ name: products.name }).from(products).where(eq(products.id, notInventory.productId)).limit(1);
      return { ok: false, productId: notInventory.productId, error: `${product?.name ?? 'This product'} is not inventory-managed and cannot have a stock reservation.` };
    }

    // What this document already holds (or has used) counts: asking again for the same order asks only for the rest.
    const have = await tx
      .select({ productId: stockReservations.productId, quantity: sql<number>`sum(${stockReservations.quantity} - ${stockReservations.released})::float8` })
      .from(stockReservations)
      .where(and(eq(stockReservations.refType, input.refType), eq(stockReservations.refId, input.refId), inArray(stockReservations.state, ['held', 'partly_consumed', 'consumed'])))
      .groupBy(stockReservations.productId);
    const held = new Map(have.map((r) => [r.productId, r.quantity]));
    const remaining = wanted.map((l) => ({ productId: l.productId, quantity: round(l.quantity - (held.get(l.productId) ?? 0)) })).filter((l) => l.quantity > 0);
    if (remaining.length === 0) return { ok: true, reserved: [] };

    const branch = input.branchId ?? null;
    const candidates = await tx
      .select({ id: stockLocations.id, code: stockLocations.code })
      .from(stockLocations)
      .where(and(eq(stockLocations.companyId, input.companyId), eq(stockLocations.isActive, true), eq(stockLocations.isSellable, true), sql`${input.channel} = ANY (${stockLocations.sellsChannels})`))
      .orderBy(sql`COALESCE(${stockLocations.branchId} = ${branch}::uuid, false) DESC`, sql`${stockLocations.isDefault} DESC`, asc(stockLocations.code));

    // Lock every balance that could supply these lines, always in the same order.
    const productIds = remaining.map((l) => l.productId);
    const rows =
      candidates.length === 0
        ? []
        : await tx
            .select()
            .from(stockBalances)
            .where(and(inArray(stockBalances.productId, productIds), inArray(stockBalances.locationId, candidates.map((c) => c.id))))
            .orderBy(asc(stockBalances.productId), asc(stockBalances.locationId), asc(stockBalances.shard))
            .for('update');

    const grid = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const perLocation = grid.get(r.locationId) ?? new Map<string, number>();
      perLocation.set(r.productId, round((perLocation.get(r.productId) ?? 0) + Math.max(0, round(r.onHand - r.reserved))));
      grid.set(r.locationId, perLocation);
    }
    const plan = planSourcing(remaining, candidates.map((c) => ({ locationId: c.id, code: c.code })), grid);
    if (!plan.ok) {
      const [p] = await tx.select({ name: products.name }).from(products).where(eq(products.id, plan.productId)).limit(1);
      return { ok: false, productId: plan.productId, error: `Insufficient inventory for "${p?.name ?? plan.productId}". Available: ${String(plan.available)}, Requested: ${String(plan.requested)}.` };
    }

    const reserved: Reserved[] = [];
    for (const a of plan.allocations) {
      // Take it from the shards of that place with the most free, so a hot product spreads over its shards.
      const shards = rows.filter((r) => r.productId === a.productId && r.locationId === a.locationId).map((r) => ({ shard: r.shard, free: round(r.onHand - r.reserved) })).sort((x, y) => (y.free === x.free ? x.shard - y.shard : y.free - x.free));
      let left = a.quantity;
      for (const s of shards) {
        if (left <= 0) break;
        const take = Math.min(left, Math.max(0, s.free));
        if (take <= 0) continue;
        await tx
          .update(stockBalances)
          .set({ reserved: sql`${stockBalances.reserved} + ${take}`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(stockBalances.productId, a.productId), eq(stockBalances.locationId, a.locationId), eq(stockBalances.shard, s.shard)));
        await tx
          .insert(stockReservations)
          .values({
            companyId: input.companyId,
            productId: a.productId,
            locationId: a.locationId,
            shard: s.shard,
            refType: input.refType,
            refId: input.refId,
            refLineId: a.productId,
            quantity: take,
            expiresAt: input.expiresAt ?? null,
            sourcing: { ...plan.trace[a.productId], channel: input.channel, branchId: branch, considered: candidates.map((c) => c.code) },
            actor: input.actor.slice(0, 200),
          })
          .onConflictDoUpdate({
            target: [stockReservations.refType, stockReservations.refId, stockReservations.refLineId, stockReservations.productId, stockReservations.locationId, stockReservations.shard],
            targetWhere: sql`${stockReservations.state} IN ('held','partly_consumed')`,
            set: { quantity: sql`${stockReservations.quantity} + ${take}`, stateChangedAt: sql`now()` },
          });
        reserved.push({ productId: a.productId, locationId: a.locationId, shard: s.shard, quantity: round(take) });
        left = round(left - take);
      }
    }
    return { ok: true, reserved };
  }

  /**
   * The old journal still has one line per product for an order that was issued or given back. The books are fed from it, and the old
   * way uses it to know an order is already settled, so it must exist whichever way the order was settled. One line per product however
   * many places it came from; a second call adds nothing. (Issuing an order in parts, one delivery after another, is the one case that
   * adds each part to its line: `accumulate`. A whole-order settlement never does, since the old way and the new may both settle one
   * order across the switch, and the second must not count it again.)
   */
  private async journalSettlement(tx: Tx, orderId: string, actor: string, type: 'order_fulfillment' | 'order_cancellation_release', perProduct: Map<string, number>, note: string, accumulate = false): Promise<void> {
    for (const [productId, quantity] of perProduct) {
      if (quantity <= 0) continue;
      const [p] = await tx.select({ name: products.name }).from(products).where(eq(products.id, productId)).limit(1);
      const total = Number([...(await tx.execute<{ total: string }>(sql`SELECT COALESCE(sum(on_hand), 0) AS total FROM stock_balances WHERE product_id = ${productId}`))][0]?.total ?? 0);
      const issued = type === 'order_fulfillment';
      const line = tx.insert(inventoryMovements).values({
        id: `ledger_${crypto.randomUUID()}`,
        productId,
        productName: p?.name ?? '',
        changeAmount: issued ? -quantity : quantity,
        previousStock: issued ? round(total + quantity) : total,
        newStock: total,
        changeType: type,
        referenceId: orderId,
        actor: actor.slice(0, 200),
        note: note.slice(0, 250),
      });
      // Whole-order settlement: a second call adds nothing. Part by part: each part is added to the one line.
      await (accumulate
        ? line.onConflictDoUpdate({
            target: [inventoryMovements.referenceId, inventoryMovements.productId, inventoryMovements.changeType],
            targetWhere: sql`${inventoryMovements.changeType} in ('order_fulfillment', 'order_cancellation_release')`,
            // The line's stock after is what it was plus the part, so that after less before is always the sum of the parts.
            set: { changeAmount: sql`${inventoryMovements.changeAmount} + excluded.change_amount`, newStock: sql`${inventoryMovements.newStock} + excluded.change_amount` },
          })
        : line.onConflictDoNothing());
    }
  }

  /** The open holds of a document, locked, in the same order reserve locks balances. */
  private async openHolds(tx: Tx, refType: string, refId: string) {
    return await tx
      .select()
      .from(stockReservations)
      .where(and(eq(stockReservations.refType, refType), eq(stockReservations.refId, refId), inArray(stockReservations.state, [...OPEN])))
      .orderBy(asc(stockReservations.productId), asc(stockReservations.locationId), asc(stockReservations.shard))
      .for('update');
  }

  /**
   * Turns the holds of a document into the physical issue: a `sale_issue` movement at the location of each hold, priced at the product's
   * cost now. If the shelf has less than was held (stock was written down meanwhile) the sale still settles for what is there, never
   * below zero, and the hold says so. Does nothing when the document has no open holds.
   */
  async consumeIn(tx: Tx, input: SettleInput): Promise<{ issued: number; holds: number }> {
    const holds = await this.openHolds(tx, input.refType, input.refId);
    let issued = 0;
    const perProduct = new Map<string, number>();
    for (const h of holds) {
      const left = round(h.quantity - h.consumed - h.released);
      if (left <= 0) continue;
      const [b] = await tx
        .select({ onHand: stockBalances.onHand })
        .from(stockBalances)
        .where(and(eq(stockBalances.productId, h.productId), eq(stockBalances.locationId, h.locationId), eq(stockBalances.shard, h.shard)))
        .for('update')
        .limit(1);
      const issue = Math.min(left, Math.max(0, b?.onHand ?? 0));
      if (issue > 0) {
        const [p] = await tx.select({ cost: products.costPrice }).from(products).where(eq(products.id, h.productId)).limit(1);
        await this.ledger.post(tx, {
          companyId: input.companyId,
          productId: h.productId,
          locationId: h.locationId,
          shard: h.shard,
          type: 'sale_issue',
          quantity: -issue,
          unitCost: Number(p?.cost ?? 0),
          documentType: input.refType,
          documentId: input.refId,
          documentLineId: h.refLineId,
          actor: { type: 'system', id: input.actor.slice(0, 200) },
          note: `Issued ${String(issue)} for ${input.refType} ${input.refId}`,
        });
      }
      await tx
        .update(stockBalances)
        .set({ reserved: sql`GREATEST(${stockBalances.reserved} - ${left}, 0)`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(stockBalances.productId, h.productId), eq(stockBalances.locationId, h.locationId), eq(stockBalances.shard, h.shard)));
      await tx
        .update(stockReservations)
        .set({ consumed: sql`${stockReservations.consumed} + ${left}`, state: 'consumed', stateChangedAt: sql`now()`, reason: issue < left ? `short at issue: ${String(round(left - issue))} not on the shelf` : null })
        .where(eq(stockReservations.id, h.id));
      issued = round(issued + issue);
      perProduct.set(h.productId, round((perProduct.get(h.productId) ?? 0) + issue));
    }
    if (input.refType === 'order') await this.journalSettlement(tx, input.refId, input.actor, 'order_fulfillment', perProduct, `Fulfilled and finalized stock deduction for order ${input.refId}`);
    return { issued, holds: holds.length };
  }

  /**
   * Issues only part of what a document holds: the quantities asked for, product by product, from the holds in their fixed order. A
   * hold issued in part stays open for the rest. `key` names this part (a delivery), so the same part posted twice moves stock once.
   * A product the document holds nothing of (its stock was issued already, for example when it was paid) issues nothing. `covered`
   * is how much of what was asked the holds covered; the shelf can still have less than that, as with a whole issue.
   */
  async consumePartIn(tx: Tx, input: SettleInput & { key: string }, wanted: ReadonlyMap<string, number>): Promise<{ issued: number; covered: number; coveredBy: Map<string, number> }> {
    const holds = await this.openHolds(tx, input.refType, input.refId);
    const remaining = new Map(wanted);
    const perProduct = new Map<string, number>();
    const coveredBy = new Map<string, number>();
    let issued = 0;
    let covered = 0;
    for (const h of holds) {
      const want = remaining.get(h.productId) ?? 0;
      const left = round(h.quantity - h.consumed - h.released);
      if (want <= 0 || left <= 0) continue;
      const take = Math.min(left, want);
      const [b] = await tx
        .select({ onHand: stockBalances.onHand })
        .from(stockBalances)
        .where(and(eq(stockBalances.productId, h.productId), eq(stockBalances.locationId, h.locationId), eq(stockBalances.shard, h.shard)))
        .for('update')
        .limit(1);
      const issue = Math.min(take, Math.max(0, b?.onHand ?? 0));
      if (issue > 0) {
        const [p] = await tx.select({ cost: products.costPrice }).from(products).where(eq(products.id, h.productId)).limit(1);
        await this.ledger.post(tx, {
          companyId: input.companyId,
          productId: h.productId,
          locationId: h.locationId,
          shard: h.shard,
          type: 'sale_issue',
          quantity: -issue,
          unitCost: Number(p?.cost ?? 0),
          documentType: input.refType,
          documentId: input.refId,
          documentLineId: `${h.id}:${input.key}`,
          actor: { type: 'system', id: input.actor.slice(0, 200) },
          note: `Issued ${String(issue)} for ${input.refType} ${input.refId} (${input.key})`,
        });
      }
      await tx
        .update(stockBalances)
        .set({ reserved: sql`GREATEST(${stockBalances.reserved} - ${take}, 0)`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(stockBalances.productId, h.productId), eq(stockBalances.locationId, h.locationId), eq(stockBalances.shard, h.shard)));
      await tx
        .update(stockReservations)
        .set({
          consumed: sql`${stockReservations.consumed} + ${take}`,
          state: take === left ? 'consumed' : 'partly_consumed',
          stateChangedAt: sql`now()`,
          ...(issue < take ? { reason: `short at issue: ${String(round(take - issue))} not on the shelf` } : {}),
        })
        .where(eq(stockReservations.id, h.id));
      remaining.set(h.productId, round(want - take));
      issued = round(issued + issue);
      covered = round(covered + take);
      coveredBy.set(h.productId, round((coveredBy.get(h.productId) ?? 0) + take));
      perProduct.set(h.productId, round((perProduct.get(h.productId) ?? 0) + issue));
    }
    if (input.refType === 'order') await this.journalSettlement(tx, input.refId, input.actor, 'order_fulfillment', perProduct, `Fulfilled and finalized stock deduction for order ${input.refId}`, true);
    return { issued, covered, coveredBy };
  }

  /** Where a product of a document was held (the place with the most), or the default location when it was not held. */
  async placeOfIn(tx: Tx, companyId: string, refType: string, refId: string, productId: string): Promise<string> {
    const [h] = await tx
      .select({ locationId: stockReservations.locationId })
      .from(stockReservations)
      .where(and(eq(stockReservations.refType, refType), eq(stockReservations.refId, refId), eq(stockReservations.productId, productId)))
      .orderBy(sql`${stockReservations.quantity} DESC`, asc(stockReservations.locationId))
      .limit(1);
    return h?.locationId ?? (await this.ledger.defaultLocationIn(tx)).locationId;
  }

  /** Holds `quantity` of a product at a place for a document again, after it was issued and has come back. Refused if the shelf cannot cover it. */
  private async holdAgainIn(tx: Tx, input: { companyId: string; refType: string; refId: string; productId: string; quantity: number; locationId: string; key: string; actor: string }): Promise<string[]> {
    const rows = await tx
      .select()
      .from(stockBalances)
      .where(and(eq(stockBalances.productId, input.productId), eq(stockBalances.locationId, input.locationId)))
      .orderBy(asc(stockBalances.shard))
      .for('update');
    const made: string[] = [];
    let left = input.quantity;
    for (const r of [...rows].sort((x, y) => round(y.onHand - y.reserved) - round(x.onHand - x.reserved))) {
      const take = Math.min(left, Math.max(0, round(r.onHand - r.reserved)));
      if (take <= 0) continue;
      await tx
        .update(stockBalances)
        .set({ reserved: sql`${stockBalances.reserved} + ${take}`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(stockBalances.productId, input.productId), eq(stockBalances.locationId, input.locationId), eq(stockBalances.shard, r.shard)));
      const [hold] = await tx
        .insert(stockReservations)
        .values({
          companyId: input.companyId,
          productId: input.productId,
          locationId: input.locationId,
          shard: r.shard,
          refType: input.refType,
          refId: input.refId,
          refLineId: `${input.productId}:again:${input.key}`,
          quantity: take,
          sourcing: { reason: 'came back with a returned delivery', delivery: input.key },
          actor: input.actor.slice(0, 200),
        })
        .returning({ id: stockReservations.id });
      if (hold !== undefined) made.push(hold.id);
      left = round(left - take);
      if (left <= 0) break;
    }
    if (left > 0) throw new StockError(`There is not enough stock to hold ${String(left)} again for the order. Count more stock in first, then receive these goods.`, 'CANNOT_HOLD_AGAIN');
    return made;
  }

  /** The place goods are counted into to be looked at: a quarantine location, the order's branch first. Refused if the company has none. */
  async quarantinePlaceIn(tx: Tx, companyId: string, nearLocationId: string): Promise<string> {
    const [near] = await tx.select({ branchId: stockLocations.branchId }).from(stockLocations).where(eq(stockLocations.id, nearLocationId)).limit(1);
    const [q] = await tx
      .select({ id: stockLocations.id })
      .from(stockLocations)
      .where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.kind, 'quarantine'), eq(stockLocations.isActive, true)))
      .orderBy(sql`COALESCE(${stockLocations.branchId} = ${near?.branchId ?? null}::uuid, false) DESC`, asc(stockLocations.code))
      .limit(1);
    if (q === undefined) throw new StockError('There is no quarantine place to count these goods into. Set one up under stock locations first, or choose another way.', 'NO_QUARANTINE');
    return q.id;
  }

  /** Takes goods that went back out of the old settlement journal's line for the order, since they are no longer shipped. */
  private async journalGiveBackIn(tx: Tx, orderId: string, productId: string, quantity: number): Promise<void> {
    await tx
      .update(inventoryMovements)
      // Both figures move, so the line still says (after less before) what the goods that stayed out came to.
      .set({ changeAmount: sql`${inventoryMovements.changeAmount} + ${quantity}`, newStock: sql`${inventoryMovements.newStock} + ${quantity}` })
      .where(and(eq(inventoryMovements.referenceId, orderId), eq(inventoryMovements.productId, productId), eq(inventoryMovements.changeType, 'order_fulfillment')));
  }

  /**
   * Does what a return receipt says to the stock of one product, and says exactly what it did so that a correction can undo it.
   *  - `return_to_stock`: stock the delivery issued is counted back (`sale_return`) where it was held; stock that never left the books needs nothing.
   *  - `quarantine`: counted into a quarantine place (issued stock comes back there; stock still on the books is moved there).
   *  - `scrap`: counted back and written off (issued), or written off (still on the books).
   * What was issued and came back is open on the order again, so it is held again at the place it was held, to be issued when it next
   * goes out; if the shelf cannot cover that, nothing is done. Everything is once for each `key`.
   */
  async receiveGoodsBackIn(
    tx: Tx,
    input: { companyId: string; orderId: string; productId: string; quantity: number; key: string; disposition: 'return_to_stock' | 'quarantine' | 'scrap'; issuedHere: boolean; actor: string; note: string },
  ): Promise<{ locationId: string | null; effects: { movements: { type: string; locationId: string; quantity: number }[]; holds: string[]; journalBack: number } }> {
    const effects: { movements: { type: string; locationId: string; quantity: number }[]; holds: string[]; journalBack: number } = { movements: [], holds: [], journalBack: 0 };
    const q = input.quantity;
    const place = await this.placeOfIn(tx, input.companyId, 'order', input.orderId, input.productId);
    const [p] = await tx.select({ cost: products.costPrice }).from(products).where(eq(products.id, input.productId)).limit(1);
    const base = { companyId: input.companyId, productId: input.productId, unitCost: Number(p?.cost ?? 0), documentType: 'delivery_return', documentId: input.key, actor: { type: 'system' as const, id: input.actor.slice(0, 200) }, note: input.note.slice(0, 250) };
    const move = async (type: 'sale_return' | 'write_off' | 'transfer_out' | 'transfer_in', locationId: string, quantity: number, line: string, reasonCode?: string) => {
      await this.ledger.post(tx, { ...base, type, locationId, quantity, documentLineId: `${input.productId}:${line}`, ...(reasonCode === undefined ? {} : { reasonCode }) });
      effects.movements.push({ type, locationId, quantity });
    };
    let where: string | null = null;
    if (input.disposition === 'return_to_stock' && input.issuedHere) {
      await move('sale_return', place, q, 'back');
      where = place;
    } else if (input.disposition === 'quarantine') {
      const quarantine = await this.quarantinePlaceIn(tx, input.companyId, place);
      if (input.issuedHere) await move('sale_return', quarantine, q, 'back');
      else {
        await move('transfer_out', place, -q, 'out');
        await move('transfer_in', quarantine, q, 'in');
      }
      where = quarantine;
    } else if (input.disposition === 'scrap') {
      if (input.issuedHere) await move('sale_return', place, q, 'back');
      await move('write_off', place, -q, 'off', 'damaged_in_delivery');
      where = place;
    }
    if (input.issuedHere) {
      await this.journalGiveBackIn(tx, input.orderId, input.productId, q);
      effects.journalBack = q;
      // What came back is open on the order again, so it is held again to be issued when it next goes out; without a hold a second
      // delivery would take it off the shelf with nothing on the books to say so.
      effects.holds = await this.holdAgainIn(tx, { companyId: input.companyId, refType: 'order', refId: input.orderId, productId: input.productId, quantity: q, locationId: place, key: input.key, actor: input.actor });
    }
    return { locationId: where, effects };
  }

  /**
   * Undoes what a receipt did (for a correction): the movements are reversed with adjustments, the holds made again are given back, and
   * the journal line takes the goods again. Refused if a hold made again has been used since (the goods have gone out again), because
   * then the receipt can no longer be taken back without changing what was shipped.
   */
  async undoReceiptIn(tx: Tx, input: { companyId: string; orderId: string; productId: string; key: string; actor: string; effects: { movements?: { type: string; locationId: string; quantity: number }[]; holds?: string[]; journalBack?: number } }): Promise<void> {
    const holds = input.effects.holds ?? [];
    const rows = holds.length === 0 ? [] : await tx.select().from(stockReservations).where(inArray(stockReservations.id, holds)).orderBy(asc(stockReservations.productId), asc(stockReservations.locationId), asc(stockReservations.shard)).for('update');
    if (rows.some((r) => r.state !== 'held' || r.consumed > 0 || r.released > 0)) {
      throw new StockError('The goods from this receipt have gone out again since, so it can no longer be corrected. Put right any difference with a stock adjustment.', 'RECEIPT_IN_USE');
    }
    for (const r of rows) {
      await tx
        .update(stockBalances)
        .set({ reserved: sql`GREATEST(${stockBalances.reserved} - ${r.quantity}, 0)`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(stockBalances.productId, r.productId), eq(stockBalances.locationId, r.locationId), eq(stockBalances.shard, r.shard)));
      await tx.update(stockReservations).set({ released: r.quantity, state: 'released', reason: 'the return receipt was corrected', stateChangedAt: sql`now()` }).where(eq(stockReservations.id, r.id));
    }
    const [p] = await tx.select({ cost: products.costPrice }).from(products).where(eq(products.id, input.productId)).limit(1);
    let n = 0;
    for (const m of [...(input.effects.movements ?? [])].reverse()) {
      n += 1;
      await this.ledger.post(tx, { companyId: input.companyId, productId: input.productId, locationId: m.locationId, type: 'adjustment', quantity: -m.quantity, unitCost: Number(p?.cost ?? 0), documentType: 'delivery_return', documentId: input.key, documentLineId: `${input.productId}:undo:${String(n)}`, reasonCode: 'return_corrected', actor: { type: 'system', id: input.actor.slice(0, 200) }, note: 'Undoing a return receipt that was corrected' });
    }
    if ((input.effects.journalBack ?? 0) > 0) await this.journalGiveBackIn(tx, input.orderId, input.productId, -(input.effects.journalBack ?? 0));
  }

  /** A paid order's holds no longer lapse: they are kept until the deliveries issue them, or the order is cancelled. */
  async keepHeld(input: SettleInput): Promise<number> {
    const done = await this.db
      .update(stockReservations)
      .set({ expiresAt: null })
      .where(and(eq(stockReservations.refType, input.refType), eq(stockReservations.refId, input.refId), inArray(stockReservations.state, [...OPEN]), sql`${stockReservations.expiresAt} IS NOT NULL`))
      .returning({ id: stockReservations.id });
    return done.length;
  }

  async consume(input: SettleInput): Promise<{ issued: number; holds: number }> {
    return await this.db.transaction((tx) => this.consumeIn(tx, input));
  }

  /** Gives the holds of a document back. Safe to repeat. */
  async releaseIn(tx: Tx, input: SettleInput & { reason: string; expired?: boolean }): Promise<{ released: number; holds: number }> {
    const holds = await this.openHolds(tx, input.refType, input.refId);
    let released = 0;
    const perProduct = new Map<string, number>();
    for (const h of holds) {
      const left = round(h.quantity - h.consumed - h.released);
      if (left <= 0) continue;
      await tx
        .update(stockBalances)
        .set({ reserved: sql`GREATEST(${stockBalances.reserved} - ${left}, 0)`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(stockBalances.productId, h.productId), eq(stockBalances.locationId, h.locationId), eq(stockBalances.shard, h.shard)));
      await tx
        .update(stockReservations)
        .set({ released: sql`${stockReservations.released} + ${left}`, state: h.consumed > 0 ? 'consumed' : releasedState(input.expired === true), reason: input.reason.slice(0, 300), stateChangedAt: sql`now()` })
        .where(eq(stockReservations.id, h.id));
      released = round(released + left);
      perProduct.set(h.productId, round((perProduct.get(h.productId) ?? 0) + left));
    }
    if (input.refType === 'order') await this.journalSettlement(tx, input.refId, input.actor, 'order_cancellation_release', perProduct, `Released reservation for order ${input.refId}. ${input.reason}`.trim());
    return { released, holds: holds.length };
  }

  async release(input: SettleInput & { reason: string; expired?: boolean }): Promise<{ released: number; holds: number }> {
    return await this.db.transaction((tx) => this.releaseIn(tx, input));
  }

  /**
   * Moves a product's open holds on a document to another location, before anything is picked: the holds at the old places are given
   * back with the reason and the same quantity is held at the new one, in one transaction, only if the new place can cover it. The old
   * and the new hold both stay on record; the history says who moved it, from where, and why.
   */
  async resource(input: { companyId: string; refType: string; refId: string; productId: string; toLocationId: string; reason: string; actor: string }): Promise<{ moved: number }> {
    const reason = input.reason.trim();
    if (reason === '') throw new StockError('Say why the stock is being taken from somewhere else.', 'REASON_NEEDED');
    if (reason.length > 300) throw new StockError('Keep the reason to 300 characters.', 'REASON_TOO_LONG');
    return await this.db.transaction(async (tx) => {
      const holds = await tx
        .select()
        .from(stockReservations)
        .where(and(eq(stockReservations.refType, input.refType), eq(stockReservations.refId, input.refId), eq(stockReservations.productId, input.productId), inArray(stockReservations.state, [...OPEN])))
        .orderBy(asc(stockReservations.locationId), asc(stockReservations.shard))
        .for('update');
      const moving = holds.filter((h) => h.locationId !== input.toLocationId);
      if (holds.length === 0) throw new StockError('That product has no stock held for this order that can be moved.', 'NO_HOLD');
      if (moving.length === 0) throw new StockError('The stock for that product is already held there.', 'ALREADY_THERE');
      const [target] = await tx.select().from(stockLocations).where(and(eq(stockLocations.id, input.toLocationId), eq(stockLocations.companyId, input.companyId))).limit(1);
      if (target === undefined) throw new StockError('That location could not be found.', 'NOT_FOUND');
      const recorded = (holds[0]?.sourcing as { channel?: unknown } | undefined)?.channel;
      const channel = typeof recorded === 'string' ? recorded : 'ecommerce';
      if (!target.isActive || !target.isSellable || !target.sellsChannels.includes(channel)) {
        throw new StockError(`${target.name} cannot supply this order: it is stopped, or it does not sell to this channel.`, 'CANNOT_SUPPLY');
      }
      const amount = round(moving.reduce((sum, h) => sum + (h.quantity - h.consumed - h.released), 0));
      const places = [...new Set([...moving.map((h) => h.locationId), target.id])];
      const rows = await tx
        .select()
        .from(stockBalances)
        .where(and(eq(stockBalances.productId, input.productId), inArray(stockBalances.locationId, places)))
        .orderBy(asc(stockBalances.locationId), asc(stockBalances.shard))
        .for('update');
      const shards = rows.filter((r) => r.locationId === target.id).map((r) => ({ shard: r.shard, free: round(r.onHand - r.reserved) })).sort((x, y) => (y.free === x.free ? x.shard - y.shard : y.free - x.free));
      const free = round(shards.reduce((sum, s) => sum + Math.max(0, s.free), 0));
      if (free < amount) throw new StockError(`${target.name} has ${String(free)} free of this product, and ${String(amount)} is needed.`, 'INSUFFICIENT');

      const fromCodes: string[] = [];
      for (const h of moving) {
        const left = round(h.quantity - h.consumed - h.released);
        await tx
          .update(stockBalances)
          .set({ reserved: sql`GREATEST(${stockBalances.reserved} - ${left}, 0)`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(stockBalances.productId, h.productId), eq(stockBalances.locationId, h.locationId), eq(stockBalances.shard, h.shard)));
        await tx
          .update(stockReservations)
          .set({ released: sql`${stockReservations.released} + ${left}`, state: h.consumed > 0 ? 'consumed' : 'released', reason: `re-sourced: ${reason}`.slice(0, 300), stateChangedAt: sql`now()` })
          .where(eq(stockReservations.id, h.id));
        const [from] = await tx.select({ code: stockLocations.code }).from(stockLocations).where(eq(stockLocations.id, h.locationId)).limit(1);
        fromCodes.push(from?.code ?? '?');
      }
      let left = amount;
      for (const s of shards) {
        if (left <= 0) break;
        const take = Math.min(left, Math.max(0, s.free));
        if (take <= 0) continue;
        await tx
          .update(stockBalances)
          .set({ reserved: sql`${stockBalances.reserved} + ${take}`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(stockBalances.productId, input.productId), eq(stockBalances.locationId, target.id), eq(stockBalances.shard, s.shard)));
        await tx
          .insert(stockReservations)
          .values({
            companyId: input.companyId,
            productId: input.productId,
            locationId: target.id,
            shard: s.shard,
            refType: input.refType,
            refId: input.refId,
            refLineId: input.productId,
            quantity: take,
            expiresAt: moving[0]?.expiresAt ?? null,
            sourcing: { rule: 're_sourced', channel, from: fromCodes, reason, locationCode: target.code },
            actor: input.actor.slice(0, 200),
          })
          .onConflictDoUpdate({
            target: [stockReservations.refType, stockReservations.refId, stockReservations.refLineId, stockReservations.productId, stockReservations.locationId, stockReservations.shard],
            targetWhere: sql`${stockReservations.state} IN ('held','partly_consumed')`,
            set: { quantity: sql`${stockReservations.quantity} + ${take}`, stateChangedAt: sql`now()` },
          });
        left = round(left - take);
      }
      await this.decisionLog?.record(
        { companyId: input.companyId, subject: { type: input.refType, id: input.refId }, action: 'stock.hold.re_sourced', actor: { type: 'user', id: input.actor }, from: fromCodes.join(', '), to: target.code, reason: { text: reason }, outcome: { productId: input.productId, quantity: amount } },
        tx,
      );
      return { moved: amount };
    });
  }

  /**
   * Gives back every hold whose time has passed, one document at a time so a failure on one leaves the rest alone. Returns the
   * documents it released, for whoever owns them to act on (an unpaid order is marked expired).
   */
  async expireDue(companyId: string, now: Date, limit = 200): Promise<ExpiredRef[]> {
    const due = await this.db
      .selectDistinct({ refType: stockReservations.refType, refId: stockReservations.refId })
      .from(stockReservations)
      .where(and(eq(stockReservations.companyId, companyId), inArray(stockReservations.state, [...OPEN]), lte(stockReservations.expiresAt, now)))
      .limit(limit);
    const out: ExpiredRef[] = [];
    for (const d of due) {
      const { released } = await this.release({ companyId, refType: d.refType, refId: d.refId, actor: 'stock-reservation-expiry', reason: 'expired: the hold ran out', expired: true });
      if (released > 0) out.push({ refType: d.refType, refId: d.refId, quantity: released });
    }
    return out;
  }
}
