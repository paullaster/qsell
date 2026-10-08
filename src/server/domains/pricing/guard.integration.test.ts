import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * Price floors, override limits and sub-categories against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * The database is shared, so every rule here is scoped to a product, category, brand or group
 * made by the test, and every limit to a role made by the test.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('price floors and override limits (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let Catalog: typeof import('@/server/domains/catalog/service').CatalogService;
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;

  const actor = { type: 'user' as const, id: 'guard-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const user = async (role = 'manager') =>
    (
      await db
        .insert(schema.users)
        .values({
          email: `g-${randomUUID()}@guard.test`,
          passwordHash: 'x',
          name: 'Guard user',
          role,
        })
        .returning()
    )[0]!;

  const category = async (name: string, parentId: string | null = null) =>
    Catalog.createCategory({
      name: `${name} ${randomUUID().slice(0, 6)}`,
      slug: `g-${randomUUID()}`,
      description: '',
      isActive: true,
      displayOrder: 1,
      parentId,
    } as never);

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `G-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `GS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Guard product ${randomUUID().slice(0, 4)}`,
      slug: `guard-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '100',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 50,
      ...over,
    });
    return id;
  };

  const rule = (
    scopeType: 'product' | 'product_group' | 'brand' | 'category',
    scopeRef: string,
    markupPercent: number,
    enforcement: 'approval' | 'block' = 'approval',
  ) =>
    c.priceGuardConfig.setFloorRule(
      companyId,
      { scopeType, scopeRef, markupPercent, enforcement },
      actor,
      reason,
    );

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ CatalogService: Catalog } = await import('@/server/domains/catalog/service'));
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_guard_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Guard Co');
    branchId = ((await c.branches.getDefault(companyId)) || branch).id;
  });

  describe('sub-categories', () => {
    it('sit under a parent, are listed as a tree, and carry their path', async () => {
      const shoes = await category('Shoes');
      const running = await category('Running', shoes.id);
      const trail = await category('Trail', running.id);
      const all = await Catalog.getAllCategories();
      const idx = (id: string) => all.findIndex((x) => x.id === id);
      expect(idx(shoes.id)).toBeLessThan(idx(running.id));
      expect(idx(running.id)).toBeLessThan(idx(trail.id));
      const t = all.find((x) => x.id === trail.id)!;
      expect(t.depth).toBe(2);
      expect(t.path).toBe(`${shoes.name} › ${running.name} › ${trail.name}`);
    });

    it('refuses a loop, a missing parent, a repeated name, and deleting a category with children', async () => {
      const a = await category('A');
      const b = await category('B', a.id);
      await expect(Catalog.updateCategory(a.id, { parentId: b.id })).rejects.toThrow(
        /own sub-categories/,
      );
      await expect(Catalog.updateCategory(a.id, { parentId: a.id })).rejects.toThrow(/itself/);
      await expect(category('X', 'cat_missing')).rejects.toThrow(/does not exist/);
      await expect(
        Catalog.createCategory({
          name: b.name.toUpperCase(),
          slug: `g-${randomUUID()}`,
          description: '',
          isActive: true,
          displayOrder: 1,
        } as never),
      ).rejects.toThrow(/already exists/);
      await expect(Catalog.deleteCategory(a.id)).rejects.toThrow(/sub-categor/);
      await Catalog.deleteCategory(b.id);
      await expect(Catalog.deleteCategory(a.id)).resolves.toMatchObject({ deleted: true });
    });

    it('moves a branch under another parent', async () => {
      const a = await category('A');
      const b = await category('B');
      const moved = await Catalog.updateCategory(b.id, { parentId: a.id });
      expect(moved.parentId).toBe(a.id);
      const back = await Catalog.updateCategory(b.id, { parentId: null });
      expect(back.parentId).toBeNull();
    });
  });

  describe('which floor applies', () => {
    it('a sub-category rule beats its parent, and a product rule beats both', async () => {
      const parent = await category('Parent');
      const child = await category('Child', parent.id);
      const p = await product({ categoryId: child.id, categoryName: child.name });
      const other = await product({ categoryId: parent.id, categoryName: parent.name });
      await rule('category', parent.id, 10);
      expect((await c.priceGuard.floorsFor(companyId, [p])).get(p)!.floorNet).toBe(110);
      await rule('category', child.id, 25);
      expect((await c.priceGuard.floorsFor(companyId, [p])).get(p)!.floorNet).toBe(125);
      // The parent's rule still covers a product directly in the parent.
      expect((await c.priceGuard.floorsFor(companyId, [other])).get(other)!.floorNet).toBe(110);
      await rule('product', p, 40);
      expect((await c.priceGuard.floorsFor(companyId, [p])).get(p)!.floorNet).toBe(140);
    });

    it('a group or brand rule applies, and the strictest of several wins', async () => {
      const brand = `Brand${randomUUID().slice(0, 6)}`;
      const p = await product({ brand });
      const group = await c.priceGuardConfig.saveProductGroup(
        companyId,
        { code: `G-${randomUUID().slice(0, 6)}`, name: 'Floor group' },
        actor,
        reason,
      );
      await c.priceGuardConfig.addMembers(companyId, group.id, { productIds: [p] }, actor, reason);
      await rule('brand', brand, 15);
      expect((await c.priceGuard.floorsFor(companyId, [p])).get(p)!.floorNet).toBe(115);
      await rule('product_group', group.id, 30);
      expect((await c.priceGuard.floorsFor(companyId, [p])).get(p)!.floorNet).toBe(130);
      await rule('product_group', group.id, 5);
      expect((await c.priceGuard.floorsFor(companyId, [p])).get(p)!.floorNet).toBe(115);
      // Leaving the group removes its rule from the product.
      await c.priceGuardConfig.removeMembers(companyId, group.id, [p], actor, reason);
      expect((await c.priceGuard.floorsFor(companyId, [p])).get(p)!.floorNet).toBe(115);
    });

    it('has no floor without a cost, and says so', async () => {
      const p = await product({ costPrice: '0' });
      await rule('product', p, 20);
      const f = (await c.priceGuard.floorsFor(companyId, [p])).get(p)!;
      expect(f.floorNet).toBeNull();
      expect(f.note).toContain('no cost');
    });

    it('explains the answer, listing the rules it passed over', async () => {
      const parent = await category('Parent');
      const p = await product({ categoryId: parent.id, categoryName: parent.name });
      await rule('category', parent.id, 10);
      await rule('product', p, 30);
      const e = await c.priceGuardConfig.explainFloor(companyId, p);
      expect(e.floorNet).toBe(130);
      expect(e.summary).toContain('cost 100.00 + 30%');
      expect(e.considered.map((x) => x.used)).toEqual([true, false]);
    });
  });

  describe('changing the rules', () => {
    it('validates, versions, and logs why', async () => {
      const p = await product();
      await expect(rule('product', p, -1)).rejects.toThrow(/between 0/);
      await expect(rule('product', 'prod_missing', 10)).rejects.toThrow(/does not exist/);
      await expect(rule('category', 'cat_missing', 10)).rejects.toThrow(/does not exist/);
      await expect(
        c.priceGuardConfig.setFloorRule(
          companyId,
          { scopeType: 'brand', scopeRef: 'NoSuchBrand-' + randomUUID(), markupPercent: 5 },
          actor,
          reason,
        ),
      ).rejects.toThrow(/No product has the brand/);
      await expect(
        c.priceGuardConfig.setFloorRule(
          companyId,
          { scopeType: 'product', scopeRef: p, markupPercent: 5 },
          actor,
          {},
        ),
      ).rejects.toThrow(/reason/i);
      const first = await rule('product', p, 10);
      const second = await rule('product', p, 12);
      expect(second.id).toBe(first.id);
      expect(second.version).toBe(2);
      const log = await c.decisionLog.timeline('price_floor_rule', first.id);
      expect(log.map((l) => l.action)).toEqual(
        expect.arrayContaining(['pricing.floor_created', 'pricing.floor_changed']),
      );
      await c.priceGuardConfig.removeFloorRule(companyId, first.id, actor, reason);
      expect((await c.priceGuard.floorsFor(companyId, [p])).get(p)!.rule).toBeNull();
    });

    it('product groups reject unknown SKUs without adding any', async () => {
      const p = await product();
      const sku = (await db.select().from(schema.products).where(eq(schema.products.id, p)))[0]!
        .sku;
      const g = await c.priceGuardConfig.saveProductGroup(
        companyId,
        { code: `G-${randomUUID().slice(0, 6)}`, name: 'Group' },
        actor,
        reason,
      );
      await expect(
        c.priceGuardConfig.addMembers(companyId, g.id, { skus: [sku, 'NOPE-SKU'] }, actor, reason),
      ).rejects.toThrow(/not found/);
      expect(await c.priceGuardConfig.groupMembers(companyId, g.id)).toHaveLength(0);
      const ok = await c.priceGuardConfig.addMembers(
        companyId,
        g.id,
        { skus: [sku] },
        actor,
        reason,
      );
      expect(ok).toEqual({ added: 1, alreadyIn: 0 });
      const again = await c.priceGuardConfig.addMembers(
        companyId,
        g.id,
        { skus: [sku] },
        actor,
        reason,
      );
      expect(again).toEqual({ added: 0, alreadyIn: 1 });
    });
  });

  describe('override limits', () => {
    /** A user whose only limit-relevant role is one made for this test. */
    async function limitedUser(maxPercent: number) {
      const [role] = await db
        .insert(schema.roles)
        .values({ key: `qa-${randomUUID().slice(0, 10)}`, name: 'QA seller' })
        .returning();
      const [perm] = await db
        .select()
        .from(schema.permissions)
        .where(eq(schema.permissions.key, 'quotes:create'))
        .limit(1);
      await db.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: perm!.id });
      const u = await user('customer');
      await db.insert(schema.userRoles).values({ userId: u.id, roleId: role!.id });
      c.accessControl.invalidateUser(u.id);
      await c.priceGuardConfig.setLimit(
        companyId,
        { roleKey: role!.key, maxPercent },
        actor,
        reason,
      );
      return { id: u.id, roleKey: role!.key };
    }

    it("measures how far below list a price was taken against the person's limit", async () => {
      const seller = await limitedUser(5);
      const p = await product({ costPrice: '0' });
      const within = await c.priceGuard.assess(companyId, seller.id, [
        { productId: p, quantity: 1, netUnit: 96, listNetUnit: 100 },
      ]);
      expect(within).toMatchObject({ overrideLimitPercent: 5, overOverrideLimit: false });
      const over = await c.priceGuard.assess(companyId, seller.id, [
        { productId: p, quantity: 1, netUnit: 90, listNetUnit: 100 },
      ]);
      expect(over).toMatchObject({
        largestOverridePercent: 10,
        overOverrideLimit: true,
        needsApproval: true,
      });
    });

    it('a price above list is never an override, and a person with no limit row has none', async () => {
      const seller = await limitedUser(5);
      const p = await product({ costPrice: '0' });
      const up = await c.priceGuard.assess(companyId, seller.id, [
        { productId: p, quantity: 1, netUnit: 120, listNetUnit: 100 },
      ]);
      expect(up.largestOverridePercent).toBe(0);
      const nobody = await user('customer');
      const free = await c.priceGuard.assess(companyId, nobody.id, [
        { productId: p, quantity: 1, netUnit: 10, listNetUnit: 100 },
      ]);
      expect(free.overrideLimitPercent).toBeNull();
      expect(free.overOverrideLimit).toBe(false);
    });
  });

  describe('in orders and quotes', () => {
    const order = async (productId: string, over: Record<string, unknown> = {}) => {
      const { OrderWriteService } = await import('@/server/domains/orders/write-service');
      return OrderWriteService.createOrder({
        branchId,
        orderNumber: `GRD-${randomUUID()}`,
        customerName: 'Guard Buyer',
        customerEmail: `buyer-${randomUUID()}@guard.test`,
        customerPhone: '0700000000',
        shippingAddress: {
          street: '1 Rd',
          city: 'Nairobi',
          countyOrState: 'Nairobi',
          country: 'KE',
        },
        items: [{ productId, quantity: 1 }],
        currency: 'KES',
        paymentMethod: 'mpesa_daraja' as never,
        salesModule: 'sales_order',
        ...over,
      });
    };
    const stock = async (id: string) =>
      (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0]!;

    async function workflowFor(
      requester: string,
      approver: string,
      trigger: string,
      extra: unknown[],
    ) {
      const wf = await c.approvalConfig.createWorkflow(
        companyId,
        { code: `GW-${randomUUID().slice(0, 8)}`, name: 'Guard workflow', trigger },
        actor,
      );
      await c.approvalConfig.saveDraft(
        companyId,
        wf.id,
        {
          conditions: {
            op: 'and',
            children: [{ op: 'eq', field: 'requestedBy', value: requester }, ...extra],
          },
          steps: [{ sequence: 1, name: 'Approver', approver: { type: 'user', userId: approver } }],
        } as never,
        actor,
      );
      await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    }

    it('refuses an order below a floor when no approval workflow covers it, and releases the stock', async () => {
      const requester = await user();
      const p = await product({ price: '100', costPrice: '100' });
      await rule('product', p, 20);
      const res = await order(p, { requestedBy: requester.id });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/below its floor/);
      expect(res.error).toMatch(/no approval workflow/);
      expect((await stock(p)).reservedQuantity).toBe(0);
    });

    it('holds an order below a floor for approval when a workflow says so, and records why', async () => {
      const requester = await user();
      const approver = await user();
      await workflowFor(requester.id, approver.id, 'sales_order.submitted', [
        { op: 'eq', field: 'belowFloor', value: true },
      ]);
      const p = await product({ price: '100', costPrice: '100' });
      await rule('product', p, 20);
      const res = await order(p, { requestedBy: requester.id });
      expect(res.success).toBe(true);
      expect(res.order!.approvalStatus).toBe('pending');
      const item = res.order!.items[0]!;
      expect(item.priceTrace?.guard).toMatchObject({
        belowFloor: true,
        floorNet: 120,
        shortfallPercent: 16.67,
      });
      expect(item.priceTrace?.guard?.floorSource).toContain('cost + 20%');
    });

    it('lets an order at or above its floor straight through', async () => {
      const requester = await user();
      const p = await product({ price: '130', costPrice: '100' });
      await rule('product', p, 20);
      const res = await order(p, { requestedBy: requester.id });
      expect(res.success).toBe(true);
      expect(res.order!.approvalStatus).not.toBe('pending');
    });

    it('compares on the price before tax', async () => {
      const requester = await user();
      // 116 including 16% tax is 100 before tax: below a floor of 110, above a floor of 100.
      const p = await product({ price: '116', costPrice: '100', taxRate: '16' });
      await rule('product', p, 10);
      const below = await order(p, { requestedBy: requester.id });
      expect(below.success).toBe(false);
      await rule('product', p, 0);
      const at = await order(p, { requestedBy: requester.id });
      expect(at.success).toBe(true);
    });

    it('a "refuse" floor refuses even when a workflow would approve it', async () => {
      const requester = await user();
      const approver = await user();
      await workflowFor(requester.id, approver.id, 'sales_order.submitted', []);
      const p = await product({ price: '100', costPrice: '100' });
      await rule('product', p, 20, 'block');
      const res = await order(p, { requestedBy: requester.id });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/below its price floor/);
    });

    it('a till sale below a floor is refused, since it cannot wait for approval', async () => {
      const requester = await user();
      const p = await product({ price: '100', costPrice: '100' });
      await rule('product', p, 20);
      const res = await order(p, { requestedBy: requester.id, salesModule: 'pos_cash_sale' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/till/);
    });

    it('the web shop is not subject to floors', async () => {
      const p = await product({ price: '100', costPrice: '100' });
      await rule('product', p, 20);
      const res = await order(p, { salesModule: 'ecommerce' });
      expect(res.success).toBe(true);
    });

    describe('quotes', () => {
      const quoteInput = (lines: unknown[]) => ({
        customerName: 'Guard Quote Buyer',
        customerEmail: 'guard-quote@guard.test',
        currency: 'KES',
        paymentMethod: 'mpesa_daraja' as never,
        discountPercent: 0,
        shippingFee: 0,
        sections: [],
        lines,
      });
      const service = async () => {
        const { SalesQuoteService } = await import('@/server/domains/quotes/service');
        return new SalesQuoteService();
      };

      it('a typed price below a floor holds the quote for approval, and the lines say why', async () => {
        const quotes = await service();
        const author = await user();
        const p = await product({ price: '100', costPrice: '100' });
        await rule('product', p, 20);
        const q = await quotes.create(
          author.id,
          quoteInput([{ productId: p, quantity: 1, discountPercent: 0, unitPrice: 105 }]) as never,
        );
        expect(q.status).toBe('pending_approval');
        expect(q.approvalStatus).toBe('pending');
        expect(q.lines[0]!.priceTrace?.guard).toMatchObject({ belowFloor: true, floorNet: 120 });
        // At the floor it is an ordinary draft.
        const ok = await quotes.create(
          author.id,
          quoteInput([{ productId: p, quantity: 1, discountPercent: 0, unitPrice: 120 }]) as never,
        );
        expect(ok.status).toBe('draft');
      });

      it('a line discount counts: the floor is measured on what the customer pays', async () => {
        const quotes = await service();
        const author = await user();
        const p = await product({ price: '200', costPrice: '100' });
        await rule('product', p, 20);
        const q = await quotes.create(
          author.id,
          quoteInput([{ productId: p, quantity: 1, discountPercent: 50, unitPrice: 200 }]) as never,
        );
        expect(q.status).toBe('pending_approval');
        expect(q.lines[0]!.priceTrace?.guard?.belowFloor).toBe(true);
      });

      it('a "refuse" floor stops the quote from being saved', async () => {
        const quotes = await service();
        const author = await user();
        const p = await product({ price: '100', costPrice: '100' });
        await rule('product', p, 20, 'block');
        await expect(
          quotes.create(
            author.id,
            quoteInput([{ productId: p, quantity: 1, discountPercent: 0, unitPrice: 90 }]) as never,
          ),
        ).rejects.toThrow(/below its price floor/);
      });

      it('goes through a workflow when its conditions name the floor', async () => {
        const quotes = await service();
        const author = await user();
        const approver = await user();
        await workflowFor(author.id, approver.id, 'sales_quote.submitted', [
          { op: 'eq', field: 'belowPriceFloor', value: true },
        ]);
        const p = await product({ price: '100', costPrice: '100' });
        await rule('product', p, 20);
        const q = await quotes.create(
          author.id,
          quoteInput([{ productId: p, quantity: 1, discountPercent: 0, unitPrice: 110 }]) as never,
        );
        expect(q.approvalManagedBy).toBe('workflow');
        expect(q.status).toBe('pending_approval');
      });

      it("a price taken further below list than the seller's limit needs approval", async () => {
        const quotes = await service();
        const [role] = await db
          .insert(schema.roles)
          .values({ key: `qa-${randomUUID().slice(0, 10)}`, name: 'QA seller' })
          .returning();
        const [perm] = await db
          .select()
          .from(schema.permissions)
          .where(eq(schema.permissions.key, 'quotes:create'))
          .limit(1);
        await db
          .insert(schema.rolePermissions)
          .values({ roleId: role!.id, permissionId: perm!.id });
        const seller = await user('customer');
        await db.insert(schema.userRoles).values({ userId: seller.id, roleId: role!.id });
        c.accessControl.invalidateUser(seller.id);
        await c.priceGuardConfig.setLimit(
          companyId,
          { roleKey: role!.key, maxPercent: 5 },
          actor,
          reason,
        );

        const p = await product({ price: '100', costPrice: '0' });
        const within = await quotes.create(
          seller.id,
          quoteInput([{ productId: p, quantity: 1, discountPercent: 0, unitPrice: 96 }]) as never,
        );
        expect(within.status).toBe('draft');
        const over = await quotes.create(
          seller.id,
          quoteInput([{ productId: p, quantity: 1, discountPercent: 0, unitPrice: 90 }]) as never,
        );
        expect(over.status).toBe('pending_approval');
        expect(over.lines[0]!.priceTrace?.guard).toMatchObject({
          overridePercent: 10,
          overrideLimitPercent: 5,
          overOverrideLimit: true,
        });
        // A discount is a reduction too.
        const discounted = await quotes.create(
          seller.id,
          quoteInput([{ productId: p, quantity: 1, discountPercent: 8, unitPrice: 100 }]) as never,
        );
        expect(discounted.status).toBe('pending_approval');
      });
    });
  });
});
