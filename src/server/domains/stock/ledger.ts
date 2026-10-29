import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { stockBalances, stockLocations, stockMovements } from '@/server/db/drizzle/schema';
import { isMovementType, type StockMovementType } from '@/lib/stock';
import { StockError } from './errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface MovementInput {
  companyId: string;
  productId: string;
  locationId: string;
  type: StockMovementType;
  /** Signed physical change, never zero (except a pure cost revaluation). */
  quantity: number;
  unitCost?: number;
  documentType?: string;
  documentId?: string;
  /** With a document type, makes the movement happen once: posting it again changes nothing. */
  documentLineId?: string;
  reasonCode?: string;
  actor: { type: 'user' | 'job' | 'integration' | 'system'; id?: string | null };
  occurredAt?: Date;
  correlationId?: string;
  note?: string;
  shard?: number;
}

export interface PostResult {
  /** False when the same line of the same document had already moved this location (a retry). */
  posted: boolean;
  movementId: number | null;
  onHand: number;
}

const QUANTITY_SCALE = 1000;
const isWhole = (q: number): boolean => Number.isFinite(q) && Math.abs(q * QUANTITY_SCALE - Math.round(q * QUANTITY_SCALE)) < 1e-6;

/**
 * The one writer of physical stock in the new ledger: a movement and the balance it changes, in the caller's transaction. The balance
 * row is locked while it changes, so two movements of the same product at the same place queue for that row only. A movement of a
 * location that does not allow negative stock is refused if it would take the balance below zero. Nothing else edits a balance.
 * Design: docs/architecture/stock-locations.md §4.2, §4.3, §5.
 */
export class StockLedger {
  constructor(private readonly db: DrizzleDb) {}

  async post(tx: Tx, m: MovementInput): Promise<PostResult> {
    if (!isMovementType(m.type)) throw new StockError('That kind of stock movement is not known.', 'BAD_TYPE');
    if (!isWhole(m.quantity) || (m.quantity === 0 && m.type !== 'cost_revaluation')) throw new StockError('A stock movement needs a quantity that is not zero, to at most three decimals.', 'BAD_QUANTITY');
    if (m.documentLineId !== undefined && m.documentType === undefined) throw new StockError('A document line needs its document type.', 'BAD_DOCUMENT');
    const shard = m.shard ?? 0;
    const [location] = await tx.select().from(stockLocations).where(and(eq(stockLocations.id, m.locationId), eq(stockLocations.companyId, m.companyId))).limit(1);
    if (location === undefined) throw new StockError('That location could not be found.', 'NOT_FOUND');
    if (!location.isActive) throw new StockError(`The location ${location.code} is stopped and cannot take stock movements.`, 'INACTIVE');

    // Make sure the balance row exists, then lock it for the rest of the transaction.
    await tx
      .insert(stockBalances)
      .values({ companyId: m.companyId, productId: m.productId, locationId: m.locationId, shard })
      .onConflictDoNothing();
    const [balance] = await tx
      .select()
      .from(stockBalances)
      .where(and(eq(stockBalances.productId, m.productId), eq(stockBalances.locationId, m.locationId), eq(stockBalances.shard, shard)))
      .for('update')
      .limit(1);
    if (balance === undefined) throw new StockError('The stock balance could not be read.', 'NO_BALANCE');

    const after = Math.round((balance.onHand + m.quantity) * QUANTITY_SCALE) / QUANTITY_SCALE;
    if (after < 0 && !location.allowNegative) {
      throw new StockError(`There is not enough stock at ${location.name}: ${String(balance.onHand)} on hand, ${String(-m.quantity)} needed.`, 'INSUFFICIENT');
    }

    const [row] = await tx
      .insert(stockMovements)
      .values({
        companyId: m.companyId,
        productId: m.productId,
        locationId: m.locationId,
        shard,
        movementType: m.type,
        quantity: m.quantity,
        unitCost: String(m.unitCost ?? 0),
        documentType: m.documentType ?? null,
        documentId: m.documentId ?? null,
        documentLineId: m.documentLineId ?? null,
        reasonCode: m.reasonCode ?? null,
        actorType: m.actor.type,
        actorId: m.actor.id ?? null,
        occurredAt: m.occurredAt ?? sql`now()`,
        correlationId: m.correlationId ?? null,
        note: (m.note ?? '').slice(0, 500),
      })
      .onConflictDoNothing()
      .returning({ id: stockMovements.id });
    if (row === undefined) return { posted: false, movementId: null, onHand: balance.onHand };

    await tx
      .update(stockBalances)
      .set({ onHand: sql`${stockBalances.onHand} + ${m.quantity}`, version: sql`${stockBalances.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(stockBalances.productId, m.productId), eq(stockBalances.locationId, m.locationId), eq(stockBalances.shard, shard)));
    return { posted: true, movementId: row.id, onHand: after };
  }

  /** Several movements in one transaction, in a fixed order (product, then location) so two callers cannot wait on each other. */
  async postMany(inputs: readonly MovementInput[]): Promise<PostResult[]> {
    const byLockOrder = (a: { m: MovementInput; index: number }, b: { m: MovementInput; index: number }): number => {
      if (a.m.productId !== b.m.productId) return a.m.productId < b.m.productId ? -1 : 1;
      if (a.m.locationId !== b.m.locationId) return a.m.locationId < b.m.locationId ? -1 : 1;
      return a.index - b.index;
    };
    const order = inputs.map((m, index) => ({ m, index })).sort(byLockOrder);
    return await this.db.transaction(async (tx) => {
      const results: PostResult[] = new Array<PostResult>(inputs.length);
      for (const { m, index } of order) results[index] = await this.post(tx, m);
      return results;
    });
  }
}
