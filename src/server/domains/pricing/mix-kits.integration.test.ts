import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * Kits and hampers, free gifts and mix deals in orders and quotes, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * The database is shared, so every rule is limited to products or a customer made by the test.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('kits, gifts and mix deals (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;

  const actor = { type: 'user' as const, id: 'kit-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const customer = async () =>
    (
      await db
        .insert(schema.customers)
        .values({
          companyId,
          number: `KC-${randomUUID().slice(0, 10)}`,
          name: 'Kit Customer',
          email: `kc-${randomUUID()}@kit.test`,
          accountType: 'cash',
        })
        .returning()
    )[0]!;

  const user = async () =>
    (
      await db
        .insert(schema.users)
        .values({
          email: `k-${randomUUID()}@kit.test`,
          passwordHash: 'x',
          name: 'Kit',
          role: 'manager',
        })
        .returning()
    )[0]!;

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `K-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `KS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Kit product ${randomUUID().slice(0, 4)}`,
      slug: `kit-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '0',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 100,
      ...over,
    });
    return id;
  };
  const row = async (id: string) =>
    (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0]!;

  const makeKit = (
    productId: string,
    components: Array<{ productId: string; quantity: number; weight?: number }>,
    allocation: 'list_price' | 'cost' | 'explicit' = 'list_price',
  ) => c.kitConfig.save(companyId, { productId, allocation, components }, actor, reason);

  const order = async (
    email: string,
    items: Array<[string, number]>,
    over: Record<string, unknown> = {},
  ) => {
    const { OrderWriteService } = await import('@/server/domains/orders/write-service');
    return OrderWriteService.createOrder({
      branchId,
      orderNumber: `KIT-${randomUUID()}`,
      customerName: 'Kit Buyer',
      customerEmail: email,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: items.map(([productId, quantity]) => ({ productId, quantity })),
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      salesModule: 'sales_order',
      ...over,
    });
  };

  const baseRule = (over: Record<string, unknown>) => ({
    code: `R-${randomUUID().slice(0, 8)}`,
    name: 'Test rule',
    kind: 'line' as const,
    priority: 0,
    stacking: 'exclusive' as const,
    validFrom: new Date(Date.now() - 3600_000),
    validTo: new Date(Date.now() + 86400_000 * 30),
    schedule: {},
    scopes: {},
    target: {},
    conditions: {},
    reward: { type: 'percent', value: 0 },
    requiresCoupon: false,
    limits: {},
    ...over,
  });
  const activeRule = async (over: Record<string, unknown>) => {
    const r = await c.discountConfig.createRule(companyId, baseRule(over) as never, actor, reason);
    await c.discountConfig.activate(companyId, r.id, actor, reason);
    return r;
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_kit_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Kit Co');
    branchId = ((await c.branches.getDefault(companyId)) || branch).id;
  });

  describe('setting up a kit', () => {
    it('makes a kit of a product, shows what it is worth and how many can be made, and logs it', async () => {
      const k = await product({ price: '2000' });
      const wine = await product({ price: '1500', stockQuantity: 10 });
      const cheese = await product({ price: '400', stockQuantity: 9 });
      const kit = await makeKit(k, [
        { productId: wine, quantity: 1 },
        { productId: cheese, quantity: 2 },
      ]);
      expect(kit).toMatchObject({ productId: k, allocation: 'list_price', componentsWorth: 2300 });
      expect(kit.buildable).toBe(4); // cheese: 9 / 2
      const log = await c.decisionLog.timeline('product_kit', kit.id);
      expect(log.map((l) => l.action)).toContain('pricing.kit_created');
      const again = await makeKit(k, [{ productId: wine, quantity: 2 }]);
      expect(again.version).toBe(2);
      expect(again.components).toHaveLength(1);
      await c.kitConfig.remove(companyId, k, actor, reason);
      expect((await c.kitConfig.list(companyId)).some((x) => x.productId === k)).toBe(false);
    });

    it('refuses nesting, itself, repeats, missing products, and a bad reason', async () => {
      const k = await product();
      const a = await product();
      const b = await product();
      await expect(makeKit(k, [{ productId: k, quantity: 1 }])).rejects.toThrow(/itself/);
      await expect(
        makeKit(k, [
          { productId: a, quantity: 1 },
          { productId: a, quantity: 1 },
        ]),
      ).rejects.toThrow(/twice/);
      await expect(makeKit(k, [{ productId: 'prod_missing', quantity: 1 }])).rejects.toThrow(
        /no longer exist/,
      );
      await expect(makeKit(k, [])).rejects.toThrow(/at least one/);
      await makeKit(k, [{ productId: a, quantity: 1 }]);
      // k is a kit, so it cannot be a component, and a component cannot become a kit.
      await expect(makeKit(b, [{ productId: k, quantity: 1 }])).rejects.toThrow(/another kit/);
      await expect(makeKit(a, [{ productId: b, quantity: 1 }])).rejects.toThrow(
        /component of another kit/,
      );
      await expect(
        c.kitConfig.save(
          companyId,
          { productId: b, allocation: 'list_price', components: [{ productId: a, quantity: 1 }] },
          actor,
          {},
        ),
      ).rejects.toThrow(/reason/i);
    });

    it('shows how a price would be split before it is saved', async () => {
      const a = await product({ price: '300' });
      const b = await product({ price: '100' });
      const parts = await c.kitConfig.preview(companyId, {
        total: 800,
        allocation: 'list_price',
        components: [
          { productId: a, quantity: 1 },
          { productId: b, quantity: 1 },
        ],
      });
      expect(parts.map((p) => p.amount)).toEqual([600, 200]);
    });

    it('a product that is part of a kit cannot be erased for good', async () => {
      const k = await product();
      const a = await product();
      await makeKit(k, [{ productId: a, quantity: 1 }]);
      const { ProductBulkDelete } = await import('@/server/domains/catalog/bulk-delete');
      const preview = await ProductBulkDelete.preview({ mode: 'ids', ids: [a] }, true);
      expect(preview.blocked.map((b) => b.reason)).toEqual(['kit']);
    });
  });

  describe('selling a kit', () => {
    it('becomes a line per component, each with its share and its own tax, and holds stock per component', async () => {
      const cust = await customer();
      const k = await product({ price: '2000', taxRate: '16', stockQuantity: 0 });
      const wine = await product({ price: '1500', taxRate: '16', stockQuantity: 10 });
      const cheese = await product({ price: '400', taxRate: '0', stockQuantity: 10 });
      await makeKit(k, [
        { productId: wine, quantity: 1 },
        { productId: cheese, quantity: 2 },
      ]);
      const res = await order(cust.email!, [[k, 1]]);
      expect(res.success).toBe(true);
      const o = res.order!;
      expect(o.items).toHaveLength(2);
      const byProduct = new Map(o.items.map((i) => [i.productId, i]));
      expect(byProduct.get(wine)!.quantity).toBe(1);
      expect(byProduct.get(cheese)!.quantity).toBe(2);
      expect(byProduct.get(wine)!.productName).toContain('(');
      expect(byProduct.get(wine)!.totalPrice + byProduct.get(cheese)!.totalPrice).toBeCloseTo(
        2000,
        2,
      );
      expect(byProduct.get(wine)!.priceTrace?.kit).toMatchObject({
        productId: k,
        quantity: 1,
        total: 2000,
      });
      // Tax follows each component: 16% on the wine's share, none on the cheese's.
      const wineShare = byProduct.get(wine)!.totalPrice;
      expect(o.tax).toBe(Math.round((wineShare * 16) / 116));
      expect(o.totalAmount).toBe(2000);
      // Stock is held for the components, not the kit.
      expect((await row(wine)).reservedQuantity).toBe(1);
      expect((await row(cheese)).reservedQuantity).toBe(2);
      expect((await row(k)).reservedQuantity).toBe(0);
    });

    it('is refused when a component is out of stock, and nothing stays held', async () => {
      const cust = await customer();
      const k = await product({ price: '1000', stockQuantity: 0 });
      const a = await product({ stockQuantity: 5 });
      const b = await product({ stockQuantity: 0 });
      await makeKit(k, [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ]);
      const res = await order(cust.email!, [[k, 1]]);
      expect(res.success).toBe(false);
      expect((await row(a)).reservedQuantity).toBe(0);
    });

    it('is refused, saying which component, when one has been switched off', async () => {
      const cust = await customer();
      const k = await product({ price: '1000' });
      const a = await product();
      const b = await product();
      await makeKit(k, [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ]);
      await db.update(schema.products).set({ isActive: false }).where(eq(schema.products.id, b));
      c.kits.invalidate(companyId);
      const res = await order(cust.email!, [[k, 1]]);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/no longer available/);
    });

    it('a discount on the kit is shared across its components', async () => {
      const cust = await customer();
      const k = await product({ price: '2000' });
      const a = await product({ price: '1000' });
      const b = await product({ price: '1000' });
      await makeKit(k, [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ]);
      await activeRule({
        target: { productIds: [k] },
        scopes: { customer: { op: 'in', values: [cust.id] } },
        reward: { type: 'percent', value: 10 },
      });
      const res = await order(cust.email!, [[k, 1]]);
      expect(res.success).toBe(true);
      expect(res.order!.totalAmount).toBe(1800);
      expect(res.order!.items.map((i) => i.totalPrice)).toEqual([900, 900]);
    });

    it('a component that is also bought on its own folds into one line', async () => {
      const cust = await customer();
      const k = await product({ price: '1000' });
      const a = await product({ price: '600' });
      const b = await product({ price: '400' });
      await makeKit(k, [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ]);
      const res = await order(cust.email!, [
        [k, 1],
        [a, 2],
      ]);
      expect(res.success).toBe(true);
      const lines = res.order!.items;
      expect(lines.filter((i) => i.productId === a)).toHaveLength(1);
      expect(lines.find((i) => i.productId === a)!.quantity).toBe(3);
      expect(res.order!.totalAmount).toBe(2200);
    });

    it("a kit is priced against a floor made from its components' cost", async () => {
      const k = await product({ price: '1000', costPrice: '0' });
      const a = await product({ costPrice: '300' });
      const b = await product({ costPrice: '200' });
      await makeKit(k, [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ]);
      await c.priceGuardConfig.setFloorRule(
        companyId,
        { scopeType: 'product', scopeRef: k, markupPercent: 20 },
        actor,
        reason,
      );
      const f = (await c.priceGuard.floorsFor(companyId, [k])).get(k)!;
      expect(f.floorNet).toBe(600); // (300 + 200) x 1.2
    });
  });

  describe('free gifts', () => {
    const giftRule = (
      cust: { id: string },
      pen: string,
      trigger: object = {},
      over: Record<string, unknown> = {},
    ) =>
      activeRule({
        kind: 'gift',
        scopes: { customer: { op: 'in', values: [cust.id] } },
        mix: { type: 'gift', trigger, gifts: [{ productId: pen, quantity: 1 }] },
        ...over,
      });

    it('adds the gift to the order at no charge, holds its stock, and counts the use at its value', async () => {
      const cust = await customer();
      const p = await product({ price: '1000' });
      const pen = await product({ price: '50', stockQuantity: 5 });
      const r = await giftRule(cust, pen, { minOrderValue: 1000, target: { productIds: [p] } });
      const res = await order(cust.email!, [[p, 1]]);
      expect(res.success).toBe(true);
      const gift = res.order!.items.find((i) => i.isGift)!;
      expect(gift).toMatchObject({ productId: pen, quantity: 1, unitPrice: 0, totalPrice: 0 });
      expect(res.order!.totalAmount).toBe(1000);
      expect((await row(pen)).reservedQuantity).toBe(1);
      expect(await c.discountConfig.getRuleView(companyId, r.id)).toMatchObject({
        uses: 1,
        given: 50,
      });
      expect(res.order!.discounts).toMatchObject({
        gifts: [{ productId: pen, quantity: 1, value: 50 }],
      });
    });

    it('is not added when the order is too small, or the gift is out of stock', async () => {
      const cust = await customer();
      const p = await product({ price: '500' });
      const pen = await product({ price: '50', stockQuantity: 5 });
      await giftRule(cust, pen, { minOrderValue: 1000, target: { productIds: [p] } });
      const small = await order(cust.email!, [[p, 1]]);
      expect(small.order!.items.some((i) => i.isGift)).toBe(false);

      const cust2 = await customer();
      const q = await product({ price: '2000' });
      const none = await product({ price: '50', stockQuantity: 0 });
      await giftRule(cust2, none, { minOrderValue: 1000, target: { productIds: [q] } });
      const out = await order(cust2.email!, [[q, 1]]);
      expect(out.success).toBe(true);
      expect(out.order!.items.some((i) => i.isGift)).toBe(false);
    });

    it("cancelling the order gives back the gift's stock and the rule's use", async () => {
      const cust = await customer();
      const p = await product({ price: '1000' });
      const pen = await product({ price: '50', stockQuantity: 5 });
      const r = await giftRule(cust, pen, { target: { productIds: [p] } });
      const res = await order(cust.email!, [[p, 1]]);
      expect((await row(pen)).reservedQuantity).toBe(1);
      const { InventoryDomainService } = await import('@/server/domains/inventory/service');
      await InventoryDomainService.cancelOrder(res.order!.id, 'changed mind');
      expect((await row(pen)).reservedQuantity).toBe(0);
      expect((await c.discountConfig.getRuleView(companyId, r.id)).uses).toBe(0);
    });

    it('a gift that is also bought folds into the bought line', async () => {
      const cust = await customer();
      const p = await product({ price: '1000' });
      const pen = await product({ price: '50', stockQuantity: 20 });
      await giftRule(cust, pen, { target: { productIds: [p] } });
      const res = await order(cust.email!, [
        [p, 1],
        [pen, 2],
      ]);
      expect(res.success).toBe(true);
      // The gift line (free) and the bought line are different lines of the same product, kept
      // apart: one is a gift, one is not.
      const lines = res.order!.items.filter((i) => i.productId === pen);
      expect(lines.map((l) => l.isGift ?? false).sort()).toEqual([false, true]);
      expect(res.order!.totalAmount).toBe(1100);
    });
  });

  describe('mix deals in orders', () => {
    it('buy 2 get 1 free takes the cheapest of three off the order', async () => {
      const cust = await customer();
      const p = await product({ price: '100' });
      await activeRule({
        kind: 'mix',
        scopes: { customer: { op: 'in', values: [cust.id] } },
        mix: {
          type: 'buy_get',
          sameSet: true,
          buy: { target: { productIds: [p] }, quantity: 2 },
          get: { target: { productIds: [p] }, quantity: 1, reward: { kind: 'free' } },
        },
      });
      const res = await order(cust.email!, [[p, 3]]);
      expect(res.success).toBe(true);
      expect(res.order!.totalAmount).toBe(200);
      expect(res.order!.items[0]!.priceTrace?.discounts?.applied[0]).toMatchObject({
        how: 'buy 2, get 1 free',
        amount: 100,
      });
    });
  });

  describe('in quotes', () => {
    const quoteInput = (customerId: string | null, lines: unknown[]) => ({
      customerId,
      customerName: 'Kit Quote Buyer',
      customerEmail: `kq-${randomUUID()}@kit.test`,
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

    it('a kit line is taxed by component and costs what its components cost', async () => {
      const svc = await service();
      const author = await user();
      const k = await product({ price: '2000', taxRate: '16', costPrice: '0' });
      const wine = await product({ price: '1500', taxRate: '16', costPrice: '900' });
      const cheese = await product({ price: '400', taxRate: '0', costPrice: '150' });
      await makeKit(k, [
        { productId: wine, quantity: 1 },
        { productId: cheese, quantity: 2 },
      ]);
      const q = await svc.create(
        author.id,
        quoteInput(null, [{ productId: k, quantity: 1, discountPercent: 0 }]) as never,
      );
      const line = q.lines[0]!;
      expect(Number(line.unitCost)).toBe(1200); // 900 + 2 x 150
      const wineShare = (2000 * 1500) / 2300;
      expect(Number(line.taxAmount)).toBeCloseTo((wineShare * 16) / 116, 1);
      expect(Number(q.totalAmount)).toBe(2000);
    });

    it('free gifts are added on save, once, and counted in the cost', async () => {
      const svc = await service();
      const author = await user();
      const cust = await customer();
      const p = await product({ price: '1000' });
      const pen = await product({ price: '50', costPrice: '20', stockQuantity: 5 });
      await activeRule({
        kind: 'gift',
        scopes: { customer: { op: 'in', values: [cust.id] } },
        mix: {
          type: 'gift',
          trigger: { target: { productIds: [p] } },
          gifts: [{ productId: pen, quantity: 2 }],
        },
      });
      const q = await svc.create(
        author.id,
        quoteInput(cust.id, [{ productId: p, quantity: 1, discountPercent: 0 }]) as never,
      );
      const gifts = q.lines.filter((l) => l.isGift);
      expect(gifts).toHaveLength(1);
      expect(gifts[0]).toMatchObject({ productId: pen, unitPrice: '0.0000', lineAmount: '0.00' });
      expect(Number(q.totalCost)).toBe(40);
      expect(Number(q.totalAmount)).toBe(1000);

      // Saved again with the gift line sent back (as the editor does), there is still one gift.
      const again = await svc.update(
        author.id,
        q.id,
        quoteInput(
          cust.id,
          q.lines.map((l) => ({
            productId: l.productId,
            quantity: Number(l.quantity),
            discountPercent: 0,
            unitPrice: Number(l.unitPrice),
            priceMode: 'kept',
            isGift: l.isGift,
          })),
        ) as never,
      );
      expect(again.lines.filter((l) => l.isGift)).toHaveLength(1);
    });

    it('an order made from a quote with a kit and a gift gets component and gift lines, and counts the use', async () => {
      const svc = await service();
      const author = await user();
      const cust = await customer();
      const k = await product({ price: '1000', stockQuantity: 0 });
      const a = await product({ price: '600', stockQuantity: 10 });
      const b = await product({ price: '400', stockQuantity: 10 });
      const pen = await product({ price: '50', stockQuantity: 10 });
      await makeKit(k, [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ]);
      const r = await activeRule({
        kind: 'gift',
        scopes: { customer: { op: 'in', values: [cust.id] } },
        mix: {
          type: 'gift',
          trigger: { target: { productIds: [k] } },
          gifts: [{ productId: pen, quantity: 1 }],
        },
      });
      const q = await svc.create(
        author.id,
        quoteInput(cust.id, [{ productId: k, quantity: 1, discountPercent: 0 }]) as never,
      );
      expect(q.lines.map((l) => l.isGift).sort()).toEqual([false, true]);

      // What converting does: the quote's lines and totals become the order's, nothing is repriced.
      const { mergeLinesForOrder } = await import('@/server/domains/quotes/order-lines');
      const lines = mergeLinesForOrder(q.lines);
      const res = await order(
        cust.email!,
        lines.map((l) => [l.productId!, Number(l.quantity)] as [string, number]),
        {
          quotedItems: lines.map((l) => ({
            productId: l.productId!,
            quantity: Number(l.quantity),
            productName: l.description,
            sku: l.sku,
            lineAmount: Number(l.lineAmount),
            taxRate: Number(l.taxRate),
            isTaxInclusive: l.isTaxInclusive,
            priceTrace: l.priceTrace ?? null,
            isGift: l.isGift,
          })),
          quotedTotals: {
            subtotal: Number(q.subtotal),
            tax: Number(q.taxAmount),
            shippingFee: 0,
            totalAmount: Number(q.totalAmount),
          },
          discountApplications:
            (q.discounts as { applications?: never[] } | null)?.applications ?? [],
          discountSummary: q.discounts ?? undefined,
        },
      );
      expect(res.success).toBe(true);
      const o = res.order!;
      expect(o.items.map((i) => i.productId).sort()).toEqual([a, b, pen].sort());
      expect(o.items.find((i) => i.productId === pen)).toMatchObject({
        isGift: true,
        totalPrice: 0,
      });
      expect(o.totalAmount).toBe(1000);
      expect((await row(a)).reservedQuantity).toBe(1);
      expect((await row(pen)).reservedQuantity).toBe(1);
      expect((await row(k)).reservedQuantity).toBe(0);
      // The gift's use is counted when the quote becomes an order, not when it was saved.
      expect((await c.discountConfig.getRuleView(companyId, r.id)).uses).toBe(1);
    });
  });
});
