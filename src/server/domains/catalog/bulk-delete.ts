import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { drizzleDb } from '@/server/db/drizzle/client';
import {
  creditNoteLines,
  etimsItems,
  inventoryMovements,
  orderItems,
  priceListLines,
  priceLists,
  products,
} from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';

/** Most products one delete may touch, so a request stays bounded. Larger sets are done in parts. */
export const MAX_BULK_DELETE = 10_000;
/** Products handled per transaction: a failure loses at most one part, never the whole run. */
const CHUNK = 500;

/** Which products a selection is about: the live catalogue, or the ones in the trash. */
export type DeleteScope = 'live' | 'trash';

const inScope = (scope: DeleteScope) =>
  scope === 'trash' ? isNotNull(products.deletedAt) : isNull(products.deletedAt);

export type ProductSelection =
  /** Exactly these products. */
  | { mode: 'ids'; ids: string[] }
  /** Every product in the catalogue except the ones listed (for "select all, then untick a few"). */
  | { mode: 'all'; excludeIds: string[] };

/** Why a product cannot be permanently deleted. Soft delete has no such limits. */
export type BlockReason = 'sold' | 'kra' | 'reserved' | 'priced';

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  sold: 'it appears on orders or credit notes',
  kra: 'it is registered with KRA',
  reserved: 'stock is reserved for it right now',
  priced: 'it is priced in a price list that is not retired',
};

export class BulkDeleteError extends Error {
  constructor(
    readonly code: 'EMPTY' | 'TOO_MANY' | 'CHANGED' | 'REASON_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'BulkDeleteError';
  }
}

export interface DeletePreview {
  total: number;
  /** Products that would be deleted as asked. For a soft delete this is all of them. */
  deletable: number;
  blocked: Array<{ reason: BlockReason; text: string; count: number }>;
  sample: Array<{ id: string; sku: string; name: string; blockedBy: BlockReason[] }>;
  /** What a permanent delete would also erase, so it is never a surprise. Zero for a soft delete. */
  erases: { movements: number; productsWithStock: number; units: number };
}

export interface DeleteResult {
  permanent: boolean;
  requested: number;
  deleted: number;
  skipped: number;
  skippedSample: Array<{ id: string; sku: string; name: string; reasons: string[] }>;
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  stockQuantity: number;
  reservedQuantity: number;
}

/**
 * Deleting products in bulk. A soft delete (the default) keeps the row so orders and the stock
 * ledger keep resolving, and frees the SKU. A permanent delete removes the row and what hangs off
 * it, so it is refused for any product that history depends on.
 */
export class ProductBulkDelete {
  /** Turns a selection into product ids, refusing empty or oversized ones. */
  static async resolve(
    selection: ProductSelection,
    scope: DeleteScope = 'live',
  ): Promise<string[]> {
    if (selection.mode === 'ids') {
      const ids = [...new Set(selection.ids)];
      if (ids.length === 0) throw new BulkDeleteError('EMPTY', 'Choose at least one product.');
      if (ids.length > MAX_BULK_DELETE) throw tooMany(ids.length);
      return ids;
    }
    const exclude = [...new Set(selection.excludeIds)];
    const rows = await drizzleDb
      .select({ id: products.id })
      .from(products)
      .where(and(inScope(scope), exclude.length > 0 ? notInArray(products.id, exclude) : undefined))
      .orderBy(products.id)
      .limit(MAX_BULK_DELETE + 1);
    if (rows.length === 0) throw new BulkDeleteError('EMPTY', 'Choose at least one product.');
    if (rows.length > MAX_BULK_DELETE) throw tooMany(`more than ${MAX_BULK_DELETE}`);
    return rows.map((r) => r.id);
  }

  /** What deleting this selection would do, without doing it. */
  static async preview(
    selection: ProductSelection,
    permanent: boolean,
    scope: DeleteScope = 'live',
  ): Promise<DeletePreview> {
    const ids = await this.resolve(selection, scope);
    const rows = await productsIn(ids, scope);
    const blockedBy = permanent ? await blockers(rows) : new Map<string, BlockReason[]>();
    const counts = new Map<BlockReason, number>();
    for (const reasons of blockedBy.values())
      for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
    const erased = rows.filter((r) => !blockedBy.has(r.id));
    return {
      total: rows.length,
      deletable: erased.length,
      erases: permanent
        ? {
            movements: await countMovements(erased.map((r) => r.id)),
            productsWithStock: erased.filter((r) => r.stockQuantity !== 0).length,
            units: erased.reduce((n, r) => n + Math.max(0, r.stockQuantity), 0),
          }
        : { movements: 0, productsWithStock: 0, units: 0 },
      blocked: [...counts].map(([reason, count]) => ({
        reason,
        text: BLOCK_REASON_TEXT[reason],
        count,
      })),
      sample: rows
        .filter((r) => blockedBy.has(r.id))
        .slice(0, 10)
        .map((r) => ({ id: r.id, sku: r.sku, name: r.name, blockedBy: blockedBy.get(r.id)! })),
    };
  }

  /**
   * Deletes the selection in parts. `expectedCount` is what the person was shown; if the selection
   * now resolves to something else (products added or removed meanwhile) nothing is deleted.
   */
  static async delete(
    selection: ProductSelection,
    opts: {
      permanent: boolean;
      expectedCount: number;
      reason?: string;
      actorId: string;
      /** 'trash' deletes products already in the trash for good; it is always permanent. */
      scope?: DeleteScope;
    },
  ): Promise<DeleteResult> {
    const scope = opts.scope ?? 'live';
    if (scope === 'trash' && !opts.permanent)
      throw new BulkDeleteError('REASON_REQUIRED', 'Products in the trash can only be erased.');
    const reason = opts.reason?.trim() ?? '';
    if (opts.permanent && reason.length < 3)
      throw new BulkDeleteError(
        'REASON_REQUIRED',
        'Say why these products are being permanently deleted.',
      );
    const ids = await this.resolve(selection, scope);
    if (ids.length !== opts.expectedCount)
      throw new BulkDeleteError(
        'CHANGED',
        `The selection changed (you confirmed ${opts.expectedCount}, it is now ${ids.length}). Nothing was deleted; review it and try again.`,
      );

    const companyId = (await getContainer().companySettings.ensureSeeded()).id;
    const batchId = randomUUID();
    const result: DeleteResult = {
      permanent: opts.permanent,
      requested: ids.length,
      deleted: 0,
      skipped: 0,
      skippedSample: [],
    };
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const done = await drizzleDb.transaction((tx) =>
        opts.permanent
          ? purgeChunk(tx, part, { companyId, batchId, reason, actorId: opts.actorId }, scope)
          : softChunk(tx, part, { companyId, batchId, reason, actorId: opts.actorId }),
      );
      result.deleted += done.deleted;
      result.skipped += done.skipped.length;
      for (const s of done.skipped)
        if (result.skippedSample.length < 50) result.skippedSample.push(s);
    }
    // Ids that no longer exist (deleted by someone else meanwhile) were neither deleted nor skipped.
    void broadcastRealtime('inventory_update', { type: 'products_deleted', count: result.deleted });
    return result;
  }
}

const tooMany = (n: number | string) =>
  new BulkDeleteError(
    'TOO_MANY',
    `That is ${typeof n === 'number' ? n.toLocaleString('en-KE') : n} products. Delete at most ${MAX_BULK_DELETE.toLocaleString('en-KE')} at a time.`,
  );

type Tx = Parameters<Parameters<typeof drizzleDb.transaction>[0]>[0];
type Ctx = { companyId: string; batchId: string; reason: string; actorId: string };

async function productsIn(ids: string[], scope: DeleteScope): Promise<ProductRow[]> {
  const out: ProductRow[] = [];
  for (let i = 0; i < ids.length; i += 5000) {
    out.push(
      ...(await drizzleDb
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          stockQuantity: products.stockQuantity,
          reservedQuantity: products.reservedQuantity,
        })
        .from(products)
        .where(and(inArray(products.id, ids.slice(i, i + 5000)), inScope(scope)))),
    );
  }
  return out;
}

/** Which of these products history depends on, and why. */
async function blockers(
  rows: ProductRow[],
  db: Pick<typeof drizzleDb, 'select' | 'selectDistinct'> = drizzleDb,
): Promise<Map<string, BlockReason[]>> {
  const out = new Map<string, BlockReason[]>();
  const add = (id: string, r: BlockReason) => out.set(id, [...(out.get(id) ?? []), r]);
  for (const r of rows) if (r.reservedQuantity !== 0) add(r.id, 'reserved');
  for (let i = 0; i < rows.length; i += 5000) {
    const ids = rows.slice(i, i + 5000).map((r) => r.id);
    const [sold, credited, kra, priced] = await Promise.all([
      db
        .selectDistinct({ id: orderItems.productId })
        .from(orderItems)
        .where(inArray(orderItems.productId, ids)),
      db
        .selectDistinct({ id: creditNoteLines.productId })
        .from(creditNoteLines)
        .where(inArray(creditNoteLines.productId, ids)),
      db
        .selectDistinct({ id: etimsItems.productId })
        .from(etimsItems)
        .where(inArray(etimsItems.productId, ids)),
      db
        .selectDistinct({ id: priceListLines.productId })
        .from(priceListLines)
        .innerJoin(priceLists, eq(priceLists.id, priceListLines.priceListId))
        .where(and(inArray(priceListLines.productId, ids), sql`${priceLists.status} <> 'retired'`)),
    ]);
    for (const { id } of [...sold, ...credited]) add(id, 'sold');
    for (const { id } of kra) add(id, 'kra');
    for (const { id } of priced) add(id, 'priced');
  }
  for (const [id, reasons] of out) out.set(id, [...new Set(reasons)]);
  return out;
}

/** Real stock movements (not the markers written when a product is created or soft-deleted). */
async function countMovements(
  ids: string[],
  db: Pick<typeof drizzleDb, 'select'> = drizzleDb,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < ids.length; i += 5000) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(inventoryMovements)
      .where(
        and(
          inArray(inventoryMovements.productId, ids.slice(i, i + 5000)),
          sql`${inventoryMovements.referenceId} <> 'PRODUCT_CREATION'`,
          sql`${inventoryMovements.referenceId} not like 'DELETE-%'`,
          sql`${inventoryMovements.referenceId} not like 'RESTORE-%'`,
        ),
      );
    total += row?.n ?? 0;
  }
  return total;
}

const logDecision = (
  tx: Tx,
  ctx: Ctx,
  action: 'catalog.products_deleted' | 'catalog.products_purged',
  rows: ProductRow[],
  skipped: number,
  extra: Record<string, unknown> = {},
) =>
  getContainer().decisionLog.record(
    {
      companyId: ctx.companyId,
      actor: { type: 'user', id: ctx.actorId },
      subject: { type: 'product_batch', id: ctx.batchId },
      action,
      reason: { text: ctx.reason || 'Bulk delete from the product list.' },
      from: 'present',
      to: action === 'catalog.products_purged' ? 'erased' : 'soft_deleted',
      outcome: {
        deleted: rows.length,
        skipped,
        ...extra,
        sample: rows.slice(0, 20).map((r) => ({ id: r.id, sku: r.sku, name: r.name })),
      },
    },
    tx,
  );

async function lockLive(tx: Tx, ids: string[], scope: DeleteScope = 'live'): Promise<ProductRow[]> {
  return tx
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      stockQuantity: products.stockQuantity,
      reservedQuantity: products.reservedQuantity,
    })
    .from(products)
    .where(and(inArray(products.id, ids), inScope(scope)))
    .orderBy(products.id)
    .for('update');
}

async function softChunk(tx: Tx, ids: string[], ctx: Ctx) {
  const rows = await lockLive(tx, ids);
  if (rows.length === 0) return { deleted: 0, skipped: [] };
  const now = new Date();
  await tx
    .update(products)
    .set({ deletedAt: now, isActive: false, updatedAt: now })
    .where(
      inArray(
        products.id,
        rows.map((r) => r.id),
      ),
    );
  await tx.insert(inventoryMovements).values(
    rows.map((r) => ({
      id: `ledger_${randomUUID()}`,
      productId: r.id,
      productName: r.name,
      changeAmount: 0,
      previousStock: r.stockQuantity,
      newStock: r.stockQuantity,
      changeType: 'product_deleted',
      referenceId: `DELETE-${r.sku}`,
      actor: ctx.actorId,
      note: `Product ${r.sku} deleted with ${r.stockQuantity} units on hand${ctx.reason ? `. Reason: ${ctx.reason}` : ''}`,
    })),
  );
  await logDecision(tx, ctx, 'catalog.products_deleted', rows, 0);
  return { deleted: rows.length, skipped: [] };
}

async function purgeChunk(tx: Tx, ids: string[], ctx: Ctx, scope: DeleteScope) {
  // Rows are locked first so nothing can sell or restock them between the check and the delete.
  const rows = await lockLive(tx, ids, scope);
  const blocked = await blockers(rows, tx);
  const eligible = rows.filter((r) => !blocked.has(r.id));
  const skipped = rows
    .filter((r) => blocked.has(r.id))
    .map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      reasons: blocked.get(r.id)!.map((b) => BLOCK_REASON_TEXT[b]),
    }));
  if (eligible.length > 0) {
    const movements = await countMovements(
      eligible.map((r) => r.id),
      tx,
    );
    const unitsOnHand = eligible.reduce((n, r) => n + Math.max(0, r.stockQuantity), 0);
    await tx.delete(products).where(
      inArray(
        products.id,
        eligible.map((r) => r.id),
      ),
    );
    await logDecision(tx, ctx, 'catalog.products_purged', eligible, skipped.length, {
      movementsErased: movements,
      unitsOnHand,
    });
  }
  return { deleted: eligible.length, skipped };
}
