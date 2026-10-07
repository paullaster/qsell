import { and, inArray, isNull } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { products } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import { BulkDeleteError, ProductBulkDelete, type ProductSelection } from './bulk-delete';

/** Products handled per transaction, as for deletes. */
const CHUNK = 500;

export interface StatusResult {
  active: boolean;
  requested: number;
  changed: number;
  /** Already in the state asked for. */
  unchanged: number;
  skipped: number;
  skippedSample: Array<{ id: string; sku: string; name: string; reason: string }>;
}

type Tx = Parameters<Parameters<typeof drizzleDb.transaction>[0]>[0];

/**
 * Publishes (Active) or hides (Draft) products in bulk, in one request and in parts, so a long
 * list neither takes one round trip per product nor stops half way with nothing said. Activating
 * keeps the rule a single product edit has: a product that is sold needs a selling price.
 */
export class ProductBulkStatus {
  static async set(
    selection: ProductSelection,
    active: boolean,
    opts: { expectedCount: number; actorId: string },
  ): Promise<StatusResult> {
    const ids = await ProductBulkDelete.resolve(selection);
    if (ids.length !== opts.expectedCount)
      throw new BulkDeleteError(
        'CHANGED',
        `The selection changed (you chose ${opts.expectedCount}, it is now ${ids.length}). Nothing was changed; review it and try again.`,
      );
    const companyId = (await getContainer().companySettings.ensureSeeded()).id;
    const result: StatusResult = {
      active,
      requested: ids.length,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      skippedSample: [],
    };
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const done = await drizzleDb.transaction((tx) =>
        changeChunk(tx, part, active, companyId, opts.actorId),
      );
      result.changed += done.changed;
      result.unchanged += done.unchanged;
      result.skipped += done.skipped.length;
      for (const s of done.skipped)
        if (result.skippedSample.length < 50) result.skippedSample.push(s);
    }
    if (result.changed > 0)
      void broadcastRealtime('inventory_update', {
        type: 'products_status',
        count: result.changed,
      });
    return result;
  }
}

async function changeChunk(
  tx: Tx,
  ids: string[],
  active: boolean,
  companyId: string,
  actorId: string,
) {
  const rows = await tx
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      isActive: products.isActive,
      isSellable: products.isSellable,
      price: products.price,
    })
    .from(products)
    .where(and(inArray(products.id, ids), isNull(products.deletedAt)))
    .orderBy(products.id)
    .for('update');

  const skipped: StatusResult['skippedSample'] = [];
  const toChange: typeof rows = [];
  let unchanged = 0;
  for (const r of rows) {
    if (r.isActive === active) {
      unchanged++;
    } else if (active && r.isSellable && !(Number(r.price) > 0)) {
      skipped.push({
        id: r.id,
        sku: r.sku,
        name: r.name,
        reason: 'it is sold but has no selling price yet',
      });
    } else {
      toChange.push(r);
    }
  }
  if (toChange.length > 0) {
    await tx
      .update(products)
      .set({ isActive: active, updatedAt: new Date() })
      .where(
        inArray(
          products.id,
          toChange.map((r) => r.id),
        ),
      );
    await getContainer().decisionLog.record(
      {
        companyId,
        actor: { type: 'user', id: actorId },
        subject: { type: 'product_batch', id: toChange[0]!.id },
        action: active ? 'catalog.products_activated' : 'catalog.products_deactivated',
        reason: { text: 'Bulk status change from the product list.' },
        from: active ? 'draft' : 'active',
        to: active ? 'active' : 'draft',
        outcome: {
          changed: toChange.length,
          skipped: skipped.length,
          sample: toChange.slice(0, 20).map((r) => ({ id: r.id, sku: r.sku, name: r.name })),
        },
      },
      tx,
    );
  }
  return { changed: toChange.length, unchanged, skipped };
}
