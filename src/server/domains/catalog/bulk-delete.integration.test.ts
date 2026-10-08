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

    it('erases products with only stock movements (and their records), but leaves alone any that orders, KRA or live prices depend on', async () => {
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
      expect(preview).toMatchObject({ total: 4, deletable: 3 });
      expect(preview.blocked.map((b) => b.reason)).toEqual(['priced']);
      // The person is told up front what else goes with them.
      expect(preview.erases).toEqual({ movements: 1, productsWithStock: 1, units: 5 });

      const result = await ProductBulkDelete.delete(sel, {
        permanent: true,
        expectedCount: 4,
        reason: 'Cleaning test data',
        actorId,
      });
      expect(result).toMatchObject({ deleted: 3, skipped: 1, permanent: true });
      expect(result.skippedSample.map((s) => s.id)).toEqual([priced.id]);
      for (const id of [clean.id, withStock.id, moved.id]) expect(await row(id)).toBeUndefined();
      expect(await row(priced.id)).toBeDefined();
      // The movement records went with the product.
      expect(
        await db
          .select()
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.productId, moved.id)),
      ).toHaveLength(0);

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
      const mine = log.find((l) =>
        (l.outcome as { sample: Array<{ id: string }> }).sample.some((x) => x.id === clean.id),
      );
      expect(mine?.reasonText).toBe('Cleaning test data');
      expect(mine?.outcome).toMatchObject({ deleted: 3, movementsErased: 1, unitsOnHand: 5 });
    });

    it('does not erase a product while stock is reserved for it', async () => {
      const p = await product({ stockQuantity: 5, reservedQuantity: 2 });
      const preview = await ProductBulkDelete.preview({ mode: 'ids', ids: [p.id] }, true);
      expect(preview).toMatchObject({ deletable: 0 });
      expect(preview.blocked.map((b) => b.reason)).toEqual(['reserved']);
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

  describe('publishing and hiding in bulk', () => {
    let ProductBulkStatus: typeof import('./bulk-status').ProductBulkStatus;
    beforeAll(async () => {
      ({ ProductBulkStatus } = await import('./bulk-status'));
    });

    it('marks products active or draft, counts the ones already there, and logs it', async () => {
      const a = await product({ isActive: true });
      const b = await product({ isActive: false });
      const sel = { mode: 'ids' as const, ids: [a.id, b.id] };
      const hide = await ProductBulkStatus.set(sel, false, { expectedCount: 2, actorId });
      expect(hide).toMatchObject({ changed: 1, unchanged: 1, skipped: 0 });
      expect((await row(a.id))!.isActive).toBe(false);
      const show = await ProductBulkStatus.set(sel, true, { expectedCount: 2, actorId });
      expect(show).toMatchObject({ changed: 2, unchanged: 0 });
      expect((await row(b.id))!.isActive).toBe(true);
      const log = await db
        .select()
        .from(schema.decisionLog)
        .where(eq(schema.decisionLog.action, 'catalog.products_activated'));
      expect(log.some((l) => l.actorId === actorId)).toBe(true);
    });

    it('will not publish a sold product that has no selling price, and says so', async () => {
      const noPrice = await product({ isActive: false, price: null });
      const ok = await product({ isActive: false });
      const r = await ProductBulkStatus.set({ mode: 'ids', ids: [noPrice.id, ok.id] }, true, {
        expectedCount: 2,
        actorId,
      });
      expect(r).toMatchObject({ changed: 1, skipped: 1 });
      expect(r.skippedSample[0]).toMatchObject({ id: noPrice.id });
      expect((await row(noPrice.id))!.isActive).toBe(false);
      // Hiding is always allowed.
      const hide = await ProductBulkStatus.set({ mode: 'ids', ids: [ok.id] }, false, {
        expectedCount: 1,
        actorId,
      });
      expect(hide.changed).toBe(1);
    });

    it('refuses a selection that changed since it was chosen', async () => {
      const a = await product();
      expect(
        await codeOf(
          ProductBulkStatus.set({ mode: 'ids', ids: [a.id] }, true, { expectedCount: 5, actorId }),
        ),
      ).toBe('CHANGED');
    });
  });

  describe('the trash', () => {
    let ProductTrash: typeof import('./trash').ProductTrash;
    beforeAll(async () => {
      ({ ProductTrash } = await import('./trash'));
    });
    const trashIt = async (id: string) =>
      ProductBulkDelete.delete(
        { mode: 'ids', ids: [id] },
        { permanent: false, expectedCount: 1, actorId },
      );

    it('lists deleted products, newest first, and finds them by SKU', async () => {
      const a = await product();
      const b = await product();
      await trashIt(a.id);
      await trashIt(b.id);
      const found = await ProductTrash.list({ search: a.sku });
      expect(found.rows.map((r) => r.id)).toEqual([a.id]);
      expect(found.rows[0]).toMatchObject({ sku: a.sku, restoreBlockedBy: null });
      expect(await ProductTrash.count()).toBeGreaterThanOrEqual(2);
    });

    it('restores products as drafts, with a ledger marker and a log entry', async () => {
      const a = await product({ stockQuantity: 4, isActive: true });
      await trashIt(a.id);
      const r = await ProductTrash.restore(
        { mode: 'ids', ids: [a.id] },
        { expectedCount: 1, actorId },
      );
      expect(r).toMatchObject({ restored: 1, skipped: 0 });
      expect(await row(a.id)).toMatchObject({ deletedAt: null, isActive: false, stockQuantity: 4 });
      const marker = await db
        .select()
        .from(schema.inventoryMovements)
        .where(
          and(
            eq(schema.inventoryMovements.productId, a.id),
            eq(schema.inventoryMovements.changeType, 'product_restored'),
          ),
        );
      expect(marker).toHaveLength(1);
      const log = await db
        .select()
        .from(schema.decisionLog)
        .where(eq(schema.decisionLog.action, 'catalog.products_restored'));
      expect(
        log.some((l) =>
          (l.outcome as { sample: Array<{ id: string }> }).sample.some((x) => x.id === a.id),
        ),
      ).toBe(true);
    });

    it('leaves a product in the trash when its SKU has been taken, and says so', async () => {
      const a = await product();
      await trashIt(a.id);
      await product({ sku: a.sku });
      const listed = await ProductTrash.list({ search: a.sku });
      expect(listed.rows[0]!.restoreBlockedBy).toContain(`SKU ${a.sku}`);
      const r = await ProductTrash.restore(
        { mode: 'ids', ids: [a.id] },
        { expectedCount: 1, actorId },
      );
      expect(r).toMatchObject({ restored: 0, skipped: 1 });
      expect(r.skippedSample[0]!.reason).toContain('SKU');
      expect((await row(a.id))!.deletedAt).not.toBeNull();
    });

    it('restores only one of two deleted products that shared a SKU', async () => {
      const first = await product();
      await trashIt(first.id);
      const second = await product({ sku: first.sku });
      await trashIt(second.id);
      const r = await ProductTrash.restore(
        { mode: 'ids', ids: [first.id, second.id] },
        { expectedCount: 2, actorId },
      );
      expect(r).toMatchObject({ restored: 1, skipped: 1 });
    });

    it('refuses a restore whose selection changed, and does nothing', async () => {
      const a = await product();
      await trashIt(a.id);
      expect(
        await codeOf(
          ProductTrash.restore({ mode: 'ids', ids: [a.id] }, { expectedCount: 2, actorId }),
        ),
      ).toBe('CHANGED');
      expect((await row(a.id))!.deletedAt).not.toBeNull();
    });

    it('a live product addressed through the trash is left untouched', async () => {
      const live = await product();
      const sel = { mode: 'ids' as const, ids: [live.id] };
      expect((await ProductBulkDelete.preview(sel, true, 'trash')).total).toBe(0);
      const erased = await ProductBulkDelete.delete(sel, {
        permanent: true,
        expectedCount: 1,
        reason: 'Mistaken id',
        actorId,
        scope: 'trash',
      });
      expect(erased.deleted).toBe(0);
      const restored = await ProductTrash.restore(sel, { expectedCount: 1, actorId });
      expect(restored.restored).toBe(0);
      expect((await row(live.id))!.deletedAt).toBeNull();
    });

    it('erases products from the trash for good, but never without permanent intent', async () => {
      const a = await product({ stockQuantity: 2 });
      await trashIt(a.id);
      expect(
        await codeOf(
          ProductBulkDelete.delete(
            { mode: 'ids', ids: [a.id] },
            { permanent: false, expectedCount: 1, actorId, scope: 'trash' },
          ),
        ),
      ).not.toBe('OK');
      const r = await ProductBulkDelete.delete(
        { mode: 'ids', ids: [a.id] },
        {
          permanent: true,
          expectedCount: 1,
          reason: 'Emptying the trash',
          actorId,
          scope: 'trash',
        },
      );
      expect(r).toMatchObject({ deleted: 1, permanent: true });
      expect(await row(a.id)).toBeUndefined();
    });
  });
});
