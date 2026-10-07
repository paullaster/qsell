import { and, count, desc, ilike, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { drizzleDb } from '@/server/db/drizzle/client';
import { inventoryMovements, products } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import { BulkDeleteError, ProductBulkDelete, type ProductSelection } from './bulk-delete';

const CHUNK = 500;
export const TRASH_PAGE_SIZE = 50;

export interface TrashRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  stockQuantity: number;
  deletedAt: string;
  /** Why it cannot come back as it is, if so: another product now uses its code or address. */
  restoreBlockedBy: string | null;
}

export interface TrashPage {
  rows: TrashRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RestoreResult {
  requested: number;
  restored: number;
  skipped: number;
  skippedSample: Array<{ id: string; sku: string; name: string; reason: string }>;
}

type Tx = Parameters<Parameters<typeof drizzleDb.transaction>[0]>[0];

/** Products that were deleted (soft), and bringing them back. */
export class ProductTrash {
  static async count(): Promise<number> {
    const [row] = await drizzleDb
      .select({ n: count() })
      .from(products)
      .where(isNotNull(products.deletedAt));
    return Number(row?.n ?? 0);
  }

  static async list(opts: { search?: string; page?: number }): Promise<TrashPage> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const term = opts.search?.trim();
    const like = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = and(
      isNotNull(products.deletedAt),
      like
        ? or(ilike(products.name, like), ilike(products.sku, like), ilike(products.stockCode, like))
        : undefined,
    );
    const [totalRow] = await drizzleDb.select({ n: count() }).from(products).where(where);
    const rows = await drizzleDb
      .select({
        id: products.id,
        sku: products.sku,
        stockCode: products.stockCode,
        slug: products.slug,
        name: products.name,
        category: products.categoryName,
        stockQuantity: products.stockQuantity,
        deletedAt: products.deletedAt,
      })
      .from(products)
      .where(where)
      .orderBy(desc(products.deletedAt), products.id)
      .limit(TRASH_PAGE_SIZE)
      .offset((page - 1) * TRASH_PAGE_SIZE);
    const taken = await liveClashes(drizzleDb, rows);
    return {
      page,
      pageSize: TRASH_PAGE_SIZE,
      total: Number(totalRow?.n ?? 0),
      rows: rows.map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        category: r.category,
        stockQuantity: r.stockQuantity,
        deletedAt: r.deletedAt!.toISOString(),
        restoreBlockedBy: clash(r, taken, new Set()),
      })),
    };
  }

  /**
   * Brings products back as drafts (they were hidden when deleted, and are republished on purpose).
   * One whose SKU, stock code or address has since been taken by another product stays in the
   * trash, with the reason. `expectedCount` is what the person confirmed.
   */
  static async restore(
    selection: ProductSelection,
    opts: { expectedCount: number; actorId: string },
  ): Promise<RestoreResult> {
    const ids = await ProductBulkDelete.resolve(selection, 'trash');
    if (ids.length !== opts.expectedCount)
      throw new BulkDeleteError(
        'CHANGED',
        `The selection changed (you chose ${opts.expectedCount}, it is now ${ids.length}). Nothing was restored; review it and try again.`,
      );
    const companyId = (await getContainer().companySettings.ensureSeeded()).id;
    const batchId = randomUUID();
    const result: RestoreResult = {
      requested: ids.length,
      restored: 0,
      skipped: 0,
      skippedSample: [],
    };
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const done = await drizzleDb.transaction((tx) =>
        restoreChunk(tx, part, companyId, batchId, opts.actorId),
      );
      result.restored += done.restored;
      result.skipped += done.skipped.length;
      for (const s of done.skipped)
        if (result.skippedSample.length < 50) result.skippedSample.push(s);
    }
    if (result.restored > 0)
      void broadcastRealtime('inventory_update', {
        type: 'products_restored',
        count: result.restored,
      });
    return result;
  }
}

interface Codes {
  id: string;
  sku: string;
  stockCode: string;
  slug: string;
}
interface Taken {
  sku: Set<string>;
  stockCode: Set<string>;
  slug: Set<string>;
}

/** Codes and addresses among these rows that a live product already uses. */
async function liveClashes(db: Pick<typeof drizzleDb, 'select'>, rows: Codes[]): Promise<Taken> {
  const taken: Taken = { sku: new Set(), stockCode: new Set(), slug: new Set() };
  if (rows.length === 0) return taken;
  const live = await db
    .select({ sku: products.sku, stockCode: products.stockCode, slug: products.slug })
    .from(products)
    .where(
      and(
        isNull(products.deletedAt),
        or(
          inArray(
            products.sku,
            rows.map((r) => r.sku),
          ),
          inArray(
            products.stockCode,
            rows.map((r) => r.stockCode),
          ),
          inArray(
            products.slug,
            rows.map((r) => r.slug),
          ),
        ),
      ),
    );
  for (const l of live) {
    taken.sku.add(l.sku);
    taken.stockCode.add(l.stockCode);
    taken.slug.add(l.slug);
  }
  return taken;
}

/** The first reason this product cannot return, given live products and ones already restored in this batch. */
function clash(r: Codes, taken: Taken, claimed: Set<string>): string | null {
  if (taken.sku.has(r.sku) || claimed.has(`sku:${r.sku}`))
    return `another product now uses the SKU ${r.sku}`;
  if (taken.stockCode.has(r.stockCode) || claimed.has(`stock:${r.stockCode}`))
    return `another product now uses the stock code ${r.stockCode}`;
  if (taken.slug.has(r.slug) || claimed.has(`slug:${r.slug}`))
    return `another product now uses the web address "${r.slug}"`;
  return null;
}

async function restoreChunk(
  tx: Tx,
  ids: string[],
  companyId: string,
  batchId: string,
  actorId: string,
) {
  const rows = await tx
    .select({
      id: products.id,
      sku: products.sku,
      stockCode: products.stockCode,
      slug: products.slug,
      name: products.name,
      stockQuantity: products.stockQuantity,
    })
    .from(products)
    .where(and(inArray(products.id, ids), isNotNull(products.deletedAt)))
    .orderBy(products.id)
    .for('update');
  const taken = await liveClashes(tx, rows);
  // Two deleted products can share a SKU (it was reused); only the first of them can return.
  const claimed = new Set<string>();
  const skipped: RestoreResult['skippedSample'] = [];
  const toRestore: typeof rows = [];
  for (const r of rows) {
    const why = clash(r, taken, claimed);
    if (why) {
      skipped.push({ id: r.id, sku: r.sku, name: r.name, reason: why });
      continue;
    }
    claimed.add(`sku:${r.sku}`).add(`stock:${r.stockCode}`).add(`slug:${r.slug}`);
    toRestore.push(r);
  }
  if (toRestore.length > 0) {
    const now = new Date();
    await tx
      .update(products)
      .set({ deletedAt: null, isActive: false, updatedAt: now })
      .where(
        inArray(
          products.id,
          toRestore.map((r) => r.id),
        ),
      );
    await tx.insert(inventoryMovements).values(
      toRestore.map((r) => ({
        id: `ledger_${randomUUID()}`,
        productId: r.id,
        productName: r.name,
        changeAmount: 0,
        previousStock: r.stockQuantity,
        newStock: r.stockQuantity,
        changeType: 'product_restored',
        referenceId: `RESTORE-${r.sku}`,
        actor: actorId,
        note: `Product ${r.sku} restored from the trash as a draft`,
      })),
    );
    await getContainer().decisionLog.record(
      {
        companyId,
        actor: { type: 'user', id: actorId },
        subject: { type: 'product_batch', id: batchId },
        action: 'catalog.products_restored',
        reason: { text: 'Restored from the trash.' },
        from: 'soft_deleted',
        to: 'draft',
        outcome: {
          restored: toRestore.length,
          skipped: skipped.length,
          sample: toRestore.slice(0, 20).map((r) => ({ id: r.id, sku: r.sku, name: r.name })),
        },
      },
      tx,
    );
  }
  return { restored: toRestore.length, skipped };
}
