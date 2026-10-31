import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { products, stockBalances, stockLocations, stockReservations } from '@/server/db/drizzle/schema';
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
  async consumeIn(tx: Tx, input: SettleInput): Promise<{ issued: number }> {
    const holds = await this.openHolds(tx, input.refType, input.refId);
    let issued = 0;
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
    }
    return { issued };
  }

  async consume(input: SettleInput): Promise<{ issued: number }> {
    return await this.db.transaction((tx) => this.consumeIn(tx, input));
  }

  /** Gives the holds of a document back. Safe to repeat. */
  async releaseIn(tx: Tx, input: SettleInput & { reason: string; expired?: boolean }): Promise<{ released: number }> {
    const holds = await this.openHolds(tx, input.refType, input.refId);
    let released = 0;
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
    }
    return { released };
  }

  async release(input: SettleInput & { reason: string; expired?: boolean }): Promise<{ released: number }> {
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
