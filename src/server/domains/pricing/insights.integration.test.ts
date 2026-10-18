import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * Pricing insights, the impact of a discount and the price book, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * The database is shared, so sales figures are read for a branch made here, and rules and
 * products are unique to each test.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('pricing insights (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let companyId: string;
  let itemTypeId: string;

  const actor = { type: 'user' as const, id: 'p5-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const range = () => ({
    from: new Date(Date.now() - 86400_000),
    to: new Date(Date.now() + 86400_000),
  });

  const branch = async () =>
    (
      await db
        .insert(schema.branches)
        .values({
          companyId,
          code: `B${randomUUID().slice(0, 8)}`.toUpperCase(),
          name: `Branch ${randomUUID().slice(0, 4)}`,
        })
        .returning()
    )[0]!;

  const user = async () =>
    (
      await db
        .insert(schema.users)
        .values({
          email: `p5-${randomUUID()}@p5.test`,
          passwordHash: 'x',
          name: 'P5 Seller',
          role: 'manager',
        })
        .returning()
    )[0]!;

  const customer = async () =>
    (
      await db
        .insert(schema.customers)
        .values({
          companyId,
          number: `P5-${randomUUID().slice(0, 10)}`,
          name: 'P5 Customer',
          email: `p5c-${randomUUID()}@p5.test`,
          accountType: 'cash',
        })
        .returning()
    )[0]!;

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `P5-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `P5S-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `P5 product ${randomUUID().slice(0, 4)}`,
      slug: `p5-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '60',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 1000,
      ...over,
    });
    return id;
  };

  const order = async (email: string, branchId: string, items: Array<[string, number]>) => {
    const { OrderWriteService } = await import('@/server/domains/orders/write-service');
    const res = await OrderWriteService.createOrder({
      branchId,
      orderNumber: `P5-${randomUUID()}`,
      customerName: 'P5 Buyer',
      customerEmail: email,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: items.map(([productId, quantity]) => ({ productId, quantity })),
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      salesModule: 'sales_order',
    });
    if (!res.success) throw new Error(res.error);
    return res.order!;
  };

  const rule = async (over: Record<string, unknown>, activate = true) => {
    const r = await c.discountConfig.createRule(
      companyId,
      {
        code: `R-${randomUUID().slice(0, 8)}`,
        name: 'P5 rule',
        kind: 'line' as const,
        priority: 0,
        stacking: 'exclusive' as const,
        validFrom: new Date(Date.now() - 3600_000),
        validTo: new Date(Date.now() + 86400_000 * 30),
        schedule: {},
        scopes: {},
        target: {},
        conditions: {},
        reward: { type: 'percent', value: 10 },
        requiresCoupon: false,
        limits: {},
        ...over,
      } as never,
      actor,
      reason,
    );
    if (activate) await c.discountConfig.activate(companyId, r.id, actor, reason);
    return r;
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_p5_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'P5 Co');
  });

  describe('what a sale keeps', () => {
    it('keeps what each unit cost, for components and gifts too', async () => {
      const b = await branch();
      const cust = await customer();
      const kit = await product({ price: '1000', costPrice: '0', stockQuantity: 0 });
      const a = await product({ costPrice: '30' });
      const g = await product({ costPrice: '7' });
      await c.kitConfig.save(
        companyId,
        { productId: kit, allocation: 'list_price', components: [{ productId: a, quantity: 2 }] },
        actor,
        reason,
      );
      await rule({
        kind: 'gift',
        scopes: { customer: { op: 'in', values: [cust.id] } },
        mix: {
          type: 'gift',
          trigger: { target: { productIds: [kit] } },
          gifts: [{ productId: g, quantity: 1 }],
        },
      });
      const o = await order(cust.email!, b.id, [[kit, 1]]);
      const costs = Object.fromEntries(o.items.map((i) => [i.productId, i.unitCost]));
      expect(costs[a]).toBe(30);
      expect(costs[g]).toBe(7);
      expect(costs[kit]).toBeUndefined();
    });
  });

  describe('sales and margin', () => {
    it('adds up net sales, cost and margin for a branch, and says how much of it has a cost', async () => {
      const b = await branch();
      const cust = await customer();
      const withCost = await product({ price: '116', taxRate: '16', costPrice: '50' });
      await order(cust.email!, b.id, [[withCost, 10]]); // net 1000, cost 500
      const noCost = await product({ price: '100', costPrice: '0' });
      await order(cust.email!, b.id, [[noCost, 5]]); // net 500, cost 0 recorded as 0
      const o = await c.insights.overview(companyId, range(), b.id);
      expect(o.orders).toBe(2);
      expect(o.netSales).toBe(1500);
      expect(o.cost).toBe(500);
      expect(o.costCoveragePercent).toBe(100); // cost 0 is kept as 0, so it counts as known
      expect(o.grossMarginPercent).toBeCloseTo(66.7, 1);
      expect(o.daily).toHaveLength(1);
      expect(o.daily[0]).toMatchObject({ orders: 2, netSales: 1500 });
    });

    it('leaves out cancelled orders', async () => {
      const b = await branch();
      const cust = await customer();
      const p = await product();
      const o = await order(cust.email!, b.id, [[p, 3]]);
      await db.update(schema.orders).set({ status: 'cancelled' }).where(eq(schema.orders.id, o.id));
      expect((await c.insights.overview(companyId, range(), b.id)).orders).toBe(0);
    });

    it('refuses a period that is too long or backwards', async () => {
      await expect(
        c.insights.overview(companyId, { from: new Date('2020-01-01'), to: new Date() }),
      ).rejects.toMatchObject({ code: 'INVALID' });
      await expect(
        c.insights.overview(companyId, { from: new Date(), to: new Date(Date.now() - 1000) }),
      ).rejects.toMatchObject({ code: 'INVALID' });
    });
  });

  describe('promotions', () => {
    it('shows what a rule gave, the margin on the orders it touched, and how much of its budget is gone', async () => {
      const b = await branch();
      const cust = await customer();
      const p = await product({ price: '100', costPrice: '60' });
      const r = await rule({
        target: { productIds: [p] },
        scopes: { customer: { op: 'in', values: [cust.id] } },
        reward: { type: 'percent', value: 10 },
        limits: { budget: 100 },
      });
      await order(cust.email!, b.id, [[p, 10]]); // 1000 -> 900, gives 100
      const rows = await c.insights.promotions(companyId, range());
      const row = rows.find((x) => x.ruleId === r.id)!;
      expect(row).toMatchObject({
        uses: 1,
        given: 100,
        netSales: 900,
        budget: 100,
        budgetBurnPercent: 100,
      });
      // 900 of sales against 600 of cost.
      expect(row.marginPercent).toBeCloseTo(33.3, 1);
    });

    it('a cancelled order no longer counts as a use', async () => {
      const b = await branch();
      const cust = await customer();
      const p = await product();
      const r = await rule({
        target: { productIds: [p] },
        scopes: { customer: { op: 'in', values: [cust.id] } },
      });
      const o = await order(cust.email!, b.id, [[p, 2]]);
      const { InventoryReservationService } =
        await import('@/server/domains/inventory/reservation-service');
      await InventoryReservationService.releaseOrder(o.id, 'test', 'p5-test');
      const rows = await c.insights.promotions(companyId, range());
      expect(rows.find((x) => x.ruleId === r.id)).toBeUndefined();
    });
  });

  describe('overrides and floor breaches', () => {
    it('counts a seller’s quotes that went below the floor', async () => {
      const { SalesQuoteService } = await import('@/server/domains/quotes/service');
      const quotes = new SalesQuoteService();
      const seller = await user();
      const p = await product({ price: '100', costPrice: '100' });
      await c.priceGuardConfig.setFloorRule(
        companyId,
        { scopeType: 'product', scopeRef: p, markupPercent: 20, enforcement: 'approval' },
        actor,
        reason,
      );
      await quotes.create(seller.id, {
        customerName: 'Guard Buyer',
        customerEmail: 'p5@guard.test',
        currency: 'KES',
        paymentMethod: 'mpesa_daraja' as never,
        discountPercent: 0,
        shippingFee: 0,
        sections: [],
        lines: [{ productId: p, quantity: 1, discountPercent: 0, unitPrice: 105 }],
      } as never);
      const g = await c.insights.guardEvents(companyId, range());
      const mine = g.quotes.find((q) => q.userId === seller.id)!;
      expect(mine).toMatchObject({ name: 'P5 Seller', quotes: 1, belowFloor: 1 });
    });
  });

  describe('the same product at different prices', () => {
    it('lists a product that sold for different prices in different branches, widest gap first', async () => {
      const b1 = await branch();
      const b2 = await branch();
      const cust = await customer();
      const p = await product({ price: '100' });
      const o1 = await order(cust.email!, b1.id, [[p, 10]]);
      const o2 = await order(cust.email!, b2.id, [[p, 10]]);
      // Branch 2 sold it for 80 each.
      await db
        .update(schema.orderItems)
        .set({ unitPrice: '80.00', totalPrice: '800.00' })
        .where(eq(schema.orderItems.orderId, o2.id));
      void o1;
      const v = (await c.insights.branchVariance(companyId, range(), 200)).find(
        (x) => x.productId === p,
      )!;
      expect(v.spreadPercent).toBe(25);
      expect(v.branches.map((x) => x.unitPrice).sort((a, z) => a - z)).toEqual([80, 100]);
    });
  });

  describe('what is owed to customers', () => {
    it('adds up rebates earned, points and gift cards', async () => {
      const before = await c.insights.liabilities(companyId);
      await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 250, count: 2 }, actor, reason);
      await c.giftCards.issue(
        companyId,
        { funding: { kind: 'complimentary' }, value: 100, expiresAt: new Date(Date.now() + 86400_000) },
        actor,
        reason,
      );
      const after = await c.insights.liabilities(companyId);
      expect(after.giftCards.outstanding - before.giftCards.outstanding).toBe(600);
      expect(after.giftCards.cards - before.giftCards.cards).toBe(3);

      const cust = await customer();
      const prog = await c.rebateConfig.create(
        companyId,
        {
          code: `LB-${randomUUID().slice(0, 6)}`,
          name: 'Liability test',
          period: 'quarter',
          tierMode: 'all_sales',
          tiers: [{ from: 1000, percent: 2 }],
          scopes: { customer: { op: 'in', values: [cust.id] } },
          target: { all: true },
          validFrom: new Date(Date.now() - 86400_000),
          validTo: null,
        } as never,
        actor,
        reason,
      );
      await c.rebateConfig.activate(companyId, prog.id, actor, reason);
      c.rebates.invalidate(companyId);
      await db.transaction((tx) =>
        c.rebates.accrueOrder(tx, { companyId, customerId: cust.id }, `o-${randomUUID()}`, [
          { productId: 'x', net: 5000 },
        ]),
      );
      const row = (await c.insights.liabilities(companyId)).rebates.find(
        (r) => r.programId === prog.id,
      )!;
      expect(row).toMatchObject({ accrued: 100, paid: 0, waiting: 0 });
    });
  });

  describe('what looks wrong', () => {
    it('flags prices below cost, missing costs, and risky discounts', async () => {
      const cheap = await product({ price: '1', costPrice: '999999' });
      await product({ price: '50', costPrice: '0' });
      await rule({
        reward: { type: 'percent', value: 40 },
        limits: {},
        target: { productIds: [cheap] },
        validTo: null,
      });
      const f = await c.insights.findings(companyId);
      const by = Object.fromEntries(f.map((x) => [x.code, x]));
      expect(by.sells_below_cost?.severity).toBe('high');
      expect(by.sells_below_cost?.examples.some((e) => e.includes('P5 product'))).toBe(true);
      expect(by.no_cost?.count).toBeGreaterThan(0);
      expect(by.discount_no_end?.count).toBeGreaterThan(0);
      expect(by.discount_uncapped?.severity).toBe('high');
      // High severity comes first.
      expect(f[0]!.severity).toBe('high');
    });
  });

  describe('what a discount would have cost', () => {
    const past = async (p: string, units: number, orders: number) => {
      const b = await branch();
      const cust = await customer();
      for (let i = 0; i < orders; i++) await order(cust.email!, b.id, [[p, units]]);
    };

    it('a percentage on a product: what it gives away and what it does to the margin', async () => {
      const p = await product({ price: '100', costPrice: '60' });
      await past(p, 10, 3); // 3 orders of 1000 net, cost 600
      const r = await rule(
        { target: { productIds: [p] }, reward: { type: 'percent', value: 10 } },
        false,
      );
      const i = await c.insights.impactOfRule(companyId, r.id);
      expect(i.supported).toBe(true);
      expect(i.matched).toMatchObject({ units: 30, net: 3000, cost: 1800 });
      expect(i.giveaway).toBe(300);
      expect(i.marginBeforePercent).toBe(40);
      expect(i.marginAfterPercent).toBeCloseTo(33.3, 1);
      expect(i.yearly).toBeCloseTo((300 * 365) / 90, 1);
    });

    it('an order rule counts only the orders that reach its minimum', async () => {
      const p = await product({ price: '100', costPrice: '60' });
      const b = await branch();
      const cust = await customer();
      await order(cust.email!, b.id, [[p, 20]]); // 2000: reaches
      await order(cust.email!, b.id, [[p, 5]]); // 500: does not
      const r = await rule(
        {
          kind: 'order',
          target: { productIds: [p] },
          conditions: { minOrderValue: 1000 },
          reward: { type: 'amount', value: 100 },
        },
        false,
      );
      const i = await c.insights.impactOfRule(companyId, r.id);
      expect(i.matched.net).toBe(2000);
      expect(i.giveaway).toBe(100);
    });

    it('a gift counts at what it costs you, once per qualifying order', async () => {
      const p = await product({ price: '100', costPrice: '60' });
      const gift = await product({ costPrice: '25' });
      await past(p, 10, 2);
      const r = await rule(
        {
          kind: 'gift',
          mix: {
            type: 'gift',
            trigger: { minOrderValue: 500, target: { productIds: [p] } },
            gifts: [{ productId: gift, quantity: 2 }],
          },
        },
        false,
      );
      const i = await c.insights.impactOfRule(companyId, r.id);
      expect(i.supported).toBe(true);
      expect(i.giveaway).toBe(100); // 2 orders x 2 x 25
    });

    it('does not estimate a product deal, and says why', async () => {
      const p = await product();
      const r = await rule(
        {
          kind: 'mix',
          mix: {
            type: 'buy_get',
            sameSet: true,
            buy: { target: { productIds: [p] }, quantity: 2 },
            get: { target: { productIds: [p] }, quantity: 1, reward: { kind: 'free' } },
          },
        },
        false,
      );
      const i = await c.insights.impactOfRule(companyId, r.id);
      expect(i.supported).toBe(false);
      expect(i.unsupportedReason).toContain('Product deals');
    });

    it('going in force still works when it is estimated for approval', async () => {
      const requester = await user();
      const p = await product();
      const r = await rule({ target: { productIds: [p] } }, false);
      expect(
        await c.discountConfig.requestActivation(
          companyId,
          r.id,
          { type: 'user', id: requester.id },
          reason,
        ),
      ).toEqual({ outcome: 'active' });
    });

    it('refuses a silly look-back and an unknown rule', async () => {
      await expect(c.insights.impactOfRule(companyId, randomUUID(), 3)).rejects.toMatchObject({
        code: 'INVALID',
      });
      await expect(c.insights.impactOfRule(companyId, randomUUID())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('the price book', () => {
    it('shows each product’s price for a customer, with the discount that applies, margin and floor', async () => {
      const cust = await customer();
      const sku = `BK-${randomUUID().slice(0, 8)}`.toUpperCase();
      const p = await product({ sku, price: '200', costPrice: '100', name: `Book item ${sku}` });
      await rule({
        target: { productIds: [p] },
        scopes: { customer: { op: 'in', values: [cust.id] } },
        reward: { type: 'percent', value: 25 },
      });
      await c.priceGuardConfig.setFloorRule(
        companyId,
        { scopeType: 'product', scopeRef: p, markupPercent: 70, enforcement: 'approval' },
        actor,
        reason,
      );
      const page = await c.priceBook.page(companyId, { customerId: cust.id }, { search: sku });
      expect(page.total).toBe(1);
      expect(page.rows[0]).toMatchObject({
        productId: p,
        listNet: 200,
        // The 25% discount is held at the floor (cost + 70%), never taken below it.
        effectiveNet: 170,
        source: 'Standard price',
        marginPercent: 41.2,
        floorNet: 170,
        belowFloor: false,
      });
      expect(page.rows[0]!.discounts).toHaveLength(1);
      // Without the customer the discount does not apply.
      const plain = await c.priceBook.page(companyId, {}, { search: sku });
      expect(plain.rows[0]).toMatchObject({ effectiveNet: 200, belowFloor: false });
      expect(plain.rows[0]!.discounts).toEqual([]);
    });

    it('flags a product whose own price is under its floor', async () => {
      const sku = `FL-${randomUUID().slice(0, 8)}`.toUpperCase();
      const p = await product({ sku, price: '200', costPrice: '100' });
      await c.priceGuardConfig.setFloorRule(
        companyId,
        { scopeType: 'product', scopeRef: p, markupPercent: 120, enforcement: 'approval' },
        actor,
        reason,
      );
      const row = (await c.priceBook.page(companyId, {}, { search: sku })).rows[0]!;
      expect(row).toMatchObject({ effectiveNet: 200, floorNet: 220, belowFloor: true });
    });

    it('pages, searches, and exports a spreadsheet that cannot run as a formula', async () => {
      const tag = randomUUID().slice(0, 6).toUpperCase();
      for (let i = 0; i < 3; i++)
        await product({
          sku: `PG-${tag}-${i}`,
          name: i === 0 ? `=SUM(A1) ${tag}` : `Paged ${tag} ${i}`,
        });
      const first = await c.priceBook.page(companyId, {}, { search: tag, limit: 2 });
      expect(first.total).toBe(3);
      expect(first.rows).toHaveLength(2);
      const second = await c.priceBook.page(companyId, {}, { search: tag, limit: 2, offset: 2 });
      expect(second.rows).toHaveLength(1);
      const { PriceBookService } = await import('@/server/domains/pricing/price-book-service');
      const all = await c.priceBook.export(companyId, {}, { search: tag });
      expect(all.rows).toHaveLength(3);
      const csv = PriceBookService.toCsv(all.rows);
      expect(csv.split('\n')[0]).toContain('SKU,Product');
      expect(csv).toContain("'=SUM(A1)");
      expect(csv.split('\n')).toHaveLength(4);
    });

    it('says when a product cannot be priced in that situation', async () => {
      const sku = `NP-${randomUUID().slice(0, 8)}`.toUpperCase();
      await product({ sku, price: null });
      const page = await c.priceBook.page(companyId, {}, { search: sku });
      expect(page.rows[0]).toMatchObject({ effectiveNet: null, source: 'No price' });
      expect(page.rows[0]!.problem).toContain('cannot be priced');
    });
  });
});
