import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * Bulk product delete against a real database:  TEST_DATABASE_URL=postgres://... pnpm test
 * The database is shared, so "select all" is only resolved here, never carried out.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('bulk product delete (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let ProductBulkDelete: typeof import('./bulk-delete').ProductBulkDelete;
  let BulkDeleteError: typeof import('./bulk-delete').BulkDeleteError;
  let companyId: string;
  let itemTypeId: string;

  const actorId = 'bulk-delete-test';

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    const sku = `BD-${randomUUID().slice(0, 8)}`.toUpperCase();
    await db.insert(schema.products).values({
      id,
      sku,
      stockCode: `BS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Bulk ${sku}`,
      slug: `bulk-${randomUUID()}`,
      itemTypeId,
      price: '100',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 0,
      ...over,
    });
    return { id, sku };
  };
  const row = async (id: string) =>
    (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0];

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ ProductBulkDelete, BulkDeleteError } = await import('./bulk-delete'));
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_bulk_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return e instanceof BulkDeleteError ? e.code : `OTHER:${(e as Error).message}`;
    }
  };

  it('soft delete hides the chosen products, keeps their history, frees the SKU and logs why', async () => {
    const [a, b, keep] = [await product(), await product({ stockQuantity: 7 }), await product()];
    const preview = await ProductBulkDelete.preview({ mode: 'ids', ids: [a.id, b.id] }, false);
    expect(preview).toMatchObject({ total: 2, deletable: 2, blocked: [] });

    const result = await ProductBulkDelete.delete(
      { mode: 'ids', ids: [a.id, b.id] },
      { permanent: false, expectedCount: 2, reason: 'Range discontinued', actorId },
    );
    expect(result).toMatchObject({ deleted: 2, skipped: 0, permanent: false });
    expect((await row(a.id))!.deletedAt).not.toBeNull();
    expect((await row(b.id))!.isActive).toBe(false);
    expect((await row(keep.id))!.deletedAt).toBeNull();

    const marker = await db
      .select()
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.productId, b.id),
          eq(schema.inventoryMovements.changeType, 'product_deleted'),
        ),
      );
    expect(marker).toHaveLength(1);
    expect(marker[0]!.note).toContain('Range discontinued');

    // The SKU can be used again.
    await expect(product({ sku: a.sku })).resolves.toBeTruthy();

    const log = await db
      .select()
      .from(schema.decisionLog)
      .where(eq(schema.decisionLog.action, 'catalog.products_deleted'));
    const mine = log.find((l) =>
      (l.outcome as { sample: Array<{ id: string }> }).sample.some((s) => s.id === a.id),
    );
    expect(mine).toMatchObject({ actorId, reasonText: 'Range discontinued' });
  });

  it('refuses a selection that changed since it was confirmed, and does nothing', async () => {
    const a = await product();
    const b = await product();
    expect(
      await codeOf(
        ProductBulkDelete.delete(
          { mode: 'ids', ids: [a.id, b.id] },
          { permanent: false, expectedCount: 3, actorId },
        ),
      ),
    ).toBe('CHANGED');
    expect((await row(a.id))!.deletedAt).toBeNull();
    expect(
      await codeOf(
        ProductBulkDelete.delete(
          { mode: 'all', excludeIds: [] },
          { permanent: false, expectedCount: 1, actorId },
        ),
      ),
    ).toBe('CHANGED');
    expect((await row(b.id))!.deletedAt).toBeNull();
  });

  it('"select all" resolves to every live product except the ones left out', async () => {
    const a = await product();
    const b = await product();
    const gone = await product();
    await ProductBulkDelete.delete(
      { mode: 'ids', ids: [gone.id] },
      { permanent: false, expectedCount: 1, actorId },
    );
    const ids = await ProductBulkDelete.resolve({ mode: 'all', excludeIds: [b.id] });
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(gone.id);
  });

  it('rejects an empty or oversized selection', async () => {
    expect(await codeOf(ProductBulkDelete.resolve({ mode: 'ids', ids: [] }))).toBe('EMPTY');
    const many = Array.from({ length: 10_001 }, (_, i) => `x${i}`);
    expect(await codeOf(ProductBulkDelete.resolve({ mode: 'ids', ids: many }))).toBe('TOO_MANY');
  });

  describe('permanent delete', () => {
    it('needs a reason', async () => {
      const a = await product();
      expect(
        await codeOf(
          ProductBulkDelete.delete(
            { mode: 'ids', ids: [a.id] },
            { permanent: true, expectedCount: 1, reason: ' ', actorId },
          ),
        ),
      ).toBe('REASON_REQUIRED');
      expect(await row(a.id)).toBeDefined();
    });

    it('erases clean products and leaves alone any that history depends on, saying why', async () => {
      const clean = await product();
      const withStock = await product({ stockQuantity: 5 });
      const moved = await product();
      await db.insert(schema.inventoryMovements).values({
        id: `ledger_${randomUUID()}`,
        productId: moved.id,
        productName: 'x',
        changeAmount: 3,
        previousStock: 0,
        newStock: 3,
        changeType: 'restock',
        referenceId: 'PO-1',
      });
      const priced = await product();
      const [cust] = await db
        .insert(schema.customers)
        .values({
          companyId,
          number: `BD-${randomUUID().slice(0, 10)}`,
          name: 'Bulk customer',
          email: `bd-${randomUUID()}@bulk.test`,
          accountType: 'cash',
        })
        .returning();
      const list = await c.pricingConfig.createList(
        companyId,
        {
          code: `BD-${randomUUID().slice(0, 8)}`,
          name: 'Bulk list',
          currency: 'KES',
          scopes: { customer: { op: 'in', values: [cust!.id] } },
        } as never,
        { type: 'user', id: actorId },
        { code: 'POLICY_CHANGE' },
      );
      await c.pricingConfig.setLines(
        companyId,
        list.id,
        [{ productId: priced.id, price: 90 }],
        { type: 'user', id: actorId },
        { code: 'POLICY_CHANGE' },
      );

      const ids = [clean.id, withStock.id, moved.id, priced.id];
      const sel = { mode: 'ids' as const, ids };
      const preview = await ProductBulkDelete.preview(sel, true);
      expect(preview).toMatchObject({ total: 4, deletable: 1 });
      expect(preview.blocked.map((b) => b.reason).sort()).toEqual(['history', 'priced', 'stock']);

      const result = await ProductBulkDelete.delete(sel, {
        permanent: true,
        expectedCount: 4,
        reason: 'Cleaning test data',
        actorId,
      });
      expect(result).toMatchObject({ deleted: 1, skipped: 3, permanent: true });
      expect(result.skippedSample.map((s) => s.id).sort()).toEqual(
        [withStock.id, moved.id, priced.id].sort(),
      );
      expect(await row(clean.id)).toBeUndefined();
      for (const id of [withStock.id, moved.id, priced.id]) expect(await row(id)).toBeDefined();

      // Once the list is retired its price no longer blocks, and goes with the product.
      await c.pricingConfig.retire(
        companyId,
        list.id,
        { type: 'user', id: actorId },
        { code: 'POLICY_CHANGE' },
      );
      const again = await ProductBulkDelete.delete(
        { mode: 'ids', ids: [priced.id] },
        { permanent: true, expectedCount: 1, reason: 'List retired', actorId },
      );
      expect(again.deleted).toBe(1);
      const lines = await db
        .select()
        .from(schema.priceListLines)
        .where(inArray(schema.priceListLines.productId, [priced.id]));
      expect(lines).toHaveLength(0);

      const log = await db
        .select()
        .from(schema.decisionLog)
        .where(eq(schema.decisionLog.action, 'catalog.products_purged'));
      expect(log.some((l) => l.reasonText === 'Cleaning test data')).toBe(true);
    });

    it('never erases a product that was sold', async () => {
      const { OrderWriteService } = await import('@/server/domains/orders/write-service');
      const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Bulk Co');
      const branchId = ((await c.branches.getDefault(companyId)) || branch).id;
      const p = await product({ stockQuantity: 10 });
      const res = await OrderWriteService.createOrder({
        branchId,
        orderNumber: `BD-${randomUUID()}`,
        customerName: 'Buyer',
        customerEmail: `buyer-${randomUUID()}@bulk.test`,
        customerPhone: '0700000000',
        shippingAddress: {
          street: '1 Rd',
          city: 'Nairobi',
          countyOrState: 'Nairobi',
          country: 'KE',
        },
        items: [{ productId: p.id, quantity: 1 }],
        currency: 'KES',
        paymentMethod: 'mpesa_daraja' as never,
      });
      expect(res.success).toBe(true);
      // Even with stock and ledger cleared away, the order line still protects it.
      await db
        .update(schema.products)
        .set({ stockQuantity: 0, reservedQuantity: 0 })
        .where(eq(schema.products.id, p.id));
      await db
        .delete(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.productId, p.id));
      const preview = await ProductBulkDelete.preview({ mode: 'ids', ids: [p.id] }, true);
      expect(preview).toMatchObject({ deletable: 0 });
      expect(preview.blocked.map((b) => b.reason)).toEqual(['sold']);
    });
  });
});
