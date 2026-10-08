import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

/**
 * Discount rules, coupons, limits and their use in orders and quotes, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * The database is shared, so every rule here is limited to a product or customer made by the
 * test and can never touch anyone else's sales.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('discounts (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;

  const actor = { type: 'user' as const, id: 'discount-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const user = async () =>
    (
      await db
        .insert(schema.users)
        .values({
          email: `d-${randomUUID()}@disc.test`,
          passwordHash: 'x',
          name: 'Disc',
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
          number: `DC-${randomUUID().slice(0, 10)}`,
          name: 'Discount Customer',
          email: `dc-${randomUUID()}@disc.test`,
          accountType: 'cash',
        })
        .returning()
    )[0]!;

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `D-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `DS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Disc product ${randomUUID().slice(0, 4)}`,
      slug: `disc-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '0',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 500,
      ...over,
    });
    return id;
  };

  const baseInput = (over: Record<string, unknown> = {}) => ({
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
    reward: { type: 'percent', value: 10 },
    requiresCoupon: false,
    limits: {},
    ...over,
  });

  /** A rule that only ever applies to the given products (so it cannot touch other tests). */
  const rule = async (
    productIds: string[],
    over: Record<string, unknown> = {},
    activate = true,
  ) => {
    const r = await c.discountConfig.createRule(
      companyId,
      baseInput({ target: { productIds }, ...over }) as never,
      actor,
      reason,
    );
    if (activate) await c.discountConfig.activate(companyId, r.id, actor, reason);
    return r;
  };

  const simulate = (
    customerId: string | null,
    lines: Array<[string, number]>,
    extra: Record<string, unknown> = {},
  ) =>
    c.discountConfig.simulate(companyId, {
      customerId,
      lines: lines.map(([productId, quantity]) => ({ productId, quantity })),
      ...extra,
    });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_disc_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Discount Co');
    branchId = ((await c.branches.getDefault(companyId)) || branch).id;
  });

  describe('rule lifecycle', () => {
    it('checks a rule, then keeps it as a draft that prices nothing', async () => {
      const p = await product();
      await expect(
        c.discountConfig.createRule(
          companyId,
          baseInput({
            target: { productIds: [p] },
            reward: { type: 'percent', value: 150 },
          }) as never,
          actor,
          reason,
        ),
      ).rejects.toMatchObject({ code: 'INVALID' });
      await expect(
        c.discountConfig.createRule(
          companyId,
          baseInput({ target: { productIds: ['prod_missing'] } }) as never,
          actor,
          reason,
        ),
      ).rejects.toThrow(/no longer exist/);
      const draft = await rule([p], {}, false);
      expect(draft.status).toBe('draft');
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(100);
    });

    it('goes in force, cannot be edited while pricing sales, and versions each change', async () => {
      const p = await product();
      const r = await rule([p]);
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(90);
      await expect(
        c.discountConfig.updateRule(
          companyId,
          r.id,
          { reward: { type: 'percent', value: 20 } },
          actor,
          reason,
        ),
      ).rejects.toMatchObject({ code: 'NOT_EDITABLE' });
      await c.discountConfig.pause(companyId, r.id, actor, reason);
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(100);
      const edited = await c.discountConfig.updateRule(
        companyId,
        r.id,
        { reward: { type: 'percent', value: 20 } },
        actor,
        reason,
      );
      expect(edited.version).toBe(2);
      await c.discountConfig.activate(companyId, r.id, actor, reason);
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(80);
      await c.discountConfig.retire(companyId, r.id, actor, reason);
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(100);
      await expect(c.discountConfig.activate(companyId, r.id, actor, reason)).rejects.toThrow(
        /retired/,
      );
      const log = await c.decisionLog.timeline('discount_rule', r.id);
      expect(log.map((l) => l.action)).toEqual(
        expect.arrayContaining([
          'pricing.discount_created',
          'pricing.discount_activated',
          'pricing.discount_paused',
          'pricing.discount_changed',
          'pricing.discount_retired',
        ]),
      );
    });

    it('a reason is needed for every change', async () => {
      const p = await product();
      await expect(
        c.discountConfig.createRule(
          companyId,
          baseInput({ target: { productIds: [p] } }) as never,
          actor,
          {},
        ),
      ).rejects.toThrow(/reason/i);
    });

    it('a coupon rule cannot go in force without a coupon', async () => {
      const p = await product();
      const r = await rule([p], { requiresCoupon: true }, false);
      await expect(c.discountConfig.activate(companyId, r.id, actor, reason)).rejects.toThrow(
        /coupon/,
      );
      await c.discountConfig.createCoupons(
        companyId,
        r.id,
        { codes: [`C${randomUUID().slice(0, 8)}`] },
        actor,
        reason,
      );
      await expect(c.discountConfig.activate(companyId, r.id, actor, reason)).resolves.toBeTruthy();
    });
  });

  describe('which discount applies', () => {
    it('the best exclusive rule wins, and the others say why they lost', async () => {
      const p = await product();
      await rule([p], {
        code: `A-${randomUUID().slice(0, 6)}`,
        reward: { type: 'percent', value: 10 },
      });
      const better = await rule([p], {
        code: `B-${randomUUID().slice(0, 6)}`,
        reward: { type: 'percent', value: 15 },
      });
      const s = await simulate(null, [[p, 2]]);
      expect(s.lines[0]!.lineTotalAfter).toBe(170);
      expect(s.lines[0]!.applied.map((a) => a.code)).toEqual([better.code]);
      expect(s.lines[0]!.considered.some((x) => x.outcome === 'lost')).toBe(true);
    });

    it('stackable rules combine, each on what is left', async () => {
      const p = await product();
      await rule([p], {
        stacking: 'stackable',
        priority: 2,
        reward: { type: 'percent', value: 10 },
      });
      await rule([p], {
        stacking: 'stackable',
        priority: 1,
        reward: { type: 'amount_per_line', value: 5 },
      });
      expect((await simulate(null, [[p, 1]])).lines[0]!.lineTotalAfter).toBe(85);
    });

    it('a coupon unlocks a rule, a wrong one is refused with the reason', async () => {
      const p = await product();
      const r = await rule([p], { requiresCoupon: true }, false);
      const code = `WELCOME${randomUUID().slice(0, 5).toUpperCase()}`;
      await c.discountConfig.createCoupons(companyId, r.id, { codes: [code] }, actor, reason);
      await c.discountConfig.activate(companyId, r.id, actor, reason);
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(100);
      expect(
        (await simulate(null, [[p, 1]], { couponCodes: [code.toLowerCase()] })).lines[0]!
          .unitPriceAfter,
      ).toBe(90);
      const bad = await simulate(null, [[p, 1]], { couponCodes: ['NOPE12345'] });
      expect(bad.couponProblems[0]).toMatchObject({
        code: 'NOPE12345',
        reason: 'That code is not valid.',
      });
      await c.discountConfig.setCouponStatus(
        companyId,
        (await c.discountConfig.listCoupons(companyId, r.id))[0]!.id,
        'disabled',
        actor,
        reason,
      );
      expect(
        (await simulate(null, [[p, 1]], { couponCodes: [code] })).couponProblems[0]!.reason,
      ).toMatch(/no longer in use/);
    });

    it('a rule limited to a customer or group applies only to them', async () => {
      const p = await product();
      const mine = await customer();
      const other = await customer();
      await rule([p], { scopes: { customer: { op: 'in', values: [mine.id] } } });
      expect((await simulate(mine.id, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(90);
      expect((await simulate(other.id, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(100);
    });

    it('trying a draft shows what it would do before it is in force', async () => {
      const p = await product();
      const draft = await rule([p], {}, false);
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(100);
      expect(
        (await simulate(null, [[p, 1]], { tryRuleId: draft.id })).lines[0]!.unitPriceAfter,
      ).toBe(90);
    });

    it('never takes a product below its price floor', async () => {
      const p = await product({ price: '100', costPrice: '90' });
      const g = await c.priceGuardConfig.setFloorRule(
        companyId,
        { scopeType: 'product', scopeRef: p, markupPercent: 10 },
        actor,
        reason,
      );
      expect(g.markupPercent).toBe(10);
      await rule([p], { reward: { type: 'percent', value: 30 } });
      const s = await simulate(null, [[p, 1]]);
      expect(s.lines[0]!.unitPriceAfter).toBe(99);
      expect(s.lines[0]!.considered.find((x) => x.outcome === 'applied')!.why).toContain('floor');
    });

    it('order rules need the order value, and a threshold applies across the lines', async () => {
      const p1 = await product({ price: '600' });
      const p2 = await product({ price: '600' });
      const cust = await customer();
      await rule([p1, p2], {
        kind: 'order',
        scopes: { customer: { op: 'in', values: [cust.id] } },
        conditions: { minOrderValue: 1000 },
        reward: { type: 'percent', value: 5 },
      });
      expect((await simulate(cust.id, [[p1, 1]])).totalDiscount).toBe(0);
      const s = await simulate(cust.id, [
        [p1, 1],
        [p2, 1],
      ]);
      expect(s.totalDiscount).toBe(60);
      expect(s.lines.map((l) => l.lineTotalAfter)).toEqual([570, 570]);
    });
  });

  describe('limits', () => {
    const commitFor = async (
      ruleId: string,
      version: number,
      docId: string,
      customerId: string | null,
      amount = 10,
    ) =>
      db.transaction((tx) =>
        c.discounts.commit(tx, companyId, { type: 'order', id: docId, customerId }, [
          { ruleId, ruleVersion: version, code: 'X', couponId: null, couponCode: null, amount },
        ]),
      );

    it('a rule is used up after its uses, and says so', async () => {
      const p = await product();
      const r = await rule([p], { limits: { maxUses: 2 } });
      await commitFor(r.id, r.version, `t-${randomUUID()}`, null);
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(90);
      await commitFor(r.id, r.version, `t-${randomUUID()}`, null);
      c.discounts.invalidate(companyId);
      const s = await simulate(null, [[p, 1]]);
      expect(s.lines[0]!.unitPriceAfter).toBe(100);
      const mine = s.lines[0]!.considered.find((x) => x.code === r.code)!;
      expect(mine).toMatchObject({ outcome: 'blocked' });
      expect(mine.why).toMatch(/Used up/);
    });

    it('a budget runs out, and the last use is cut to what is left', async () => {
      const p = await product({ price: '100' });
      const r = await rule([p], { limits: { budget: 15 }, reward: { type: 'percent', value: 10 } });
      await commitFor(r.id, r.version, `t-${randomUUID()}`, null, 10);
      const s = await simulate(null, [[p, 1]]);
      expect(s.lines[0]!.unitPriceAfter).toBe(95); // 5 of the 15 budget is left
    });

    it('a customer can use a rule only so many times', async () => {
      const p = await product();
      const cust = await customer();
      const r = await rule([p], { limits: { maxUsesPerCustomer: 1 } });
      await commitFor(r.id, r.version, `t-${randomUUID()}`, cust.id);
      expect((await simulate(cust.id, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(100);
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(90);
    });

    it('using a document twice records one use, and a cancelled one gives its use back', async () => {
      const p = await product();
      const r = await rule([p], { limits: { maxUses: 5 } });
      const doc = `t-${randomUUID()}`;
      await commitFor(r.id, r.version, doc, null);
      await commitFor(r.id, r.version, doc, null);
      const used = async () => (await c.discountConfig.getRuleView(companyId, r.id)).uses;
      expect(await used()).toBe(1);
      await db.transaction((tx) => c.discounts.reverse(tx, { type: 'order', id: doc }));
      expect(await used()).toBe(0);
      // Reversing again changes nothing.
      expect(
        await db.transaction((tx) => c.discounts.reverse(tx, { type: 'order', id: doc })),
      ).toBe(0);
    });

    it('usage records cannot be edited or deleted', async () => {
      const p = await product();
      const r = await rule([p]);
      await commitFor(r.id, r.version, `t-${randomUUID()}`, null);
      await expect(
        db.execute(sql`update discount_usage set amount = 1 where rule_id = ${r.id}`),
      ).rejects.toThrow();
      await expect(
        db.execute(sql`delete from discount_usage where rule_id = ${r.id}`),
      ).rejects.toThrow();
    });

    it('many orders at once are all counted', async () => {
      const p = await product();
      const r = await rule([p]);
      await Promise.all(
        Array.from({ length: 20 }, () => commitFor(r.id, r.version, `t-${randomUUID()}`, null, 5)),
      );
      const view = await c.discountConfig.getRuleView(companyId, r.id);
      expect(view.uses).toBe(20);
      expect(view.given).toBe(100);
    });

    it('a strict limit holds exactly even when many orders arrive together', async () => {
      const p = await product();
      const r = await rule([p], { limits: { maxUses: 3 } }, false);
      await c.discountConfig.updateRule(companyId, r.id, { strictLimits: true }, actor, reason);
      await c.discountConfig.activate(companyId, r.id, actor, reason);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => commitFor(r.id, r.version + 1, `t-${randomUUID()}`, null)),
      );
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(3);
      expect((await c.discountConfig.getRuleView(companyId, r.id)).uses).toBe(3);
    });
  });

  describe('coupons', () => {
    it('makes random codes that are unique, easy to read and in the right number', async () => {
      const p = await product();
      const r = await rule([p], { requiresCoupon: true }, false);
      const { created } = await c.discountConfig.createCoupons(
        companyId,
        r.id,
        { generate: { count: 60, prefix: 'XMAS', length: 8 } },
        actor,
        reason,
      );
      expect(created).toHaveLength(60);
      expect(new Set(created).size).toBe(60);
      expect(created.every((x) => /^XMAS-[A-HJKMNP-Z2-9]{8}$/.test(x))).toBe(true);
      await expect(
        c.discountConfig.createCoupons(companyId, r.id, { codes: [created[0]!] }, actor, reason),
      ).rejects.toMatchObject({ code: 'DUPLICATE_CODE' });
      await expect(
        c.discountConfig.createCoupons(companyId, r.id, { codes: ['a b'] }, actor, reason),
      ).rejects.toMatchObject({ code: 'INVALID' });
    });

    it('a coupon has its own limits: overall, per customer and dates', async () => {
      const p = await product();
      const cust = await customer();
      const r = await rule([p], { requiresCoupon: true }, false);
      const code = `LIM${randomUUID().slice(0, 6).toUpperCase()}`;
      const expired = `OLD${randomUUID().slice(0, 6).toUpperCase()}`;
      await c.discountConfig.createCoupons(
        companyId,
        r.id,
        { codes: [code], maxUsesPerCustomer: 1 },
        actor,
        reason,
      );
      await c.discountConfig.createCoupons(
        companyId,
        r.id,
        {
          codes: [expired],
          validFrom: new Date(Date.now() - 7200_000),
          validTo: new Date(Date.now() - 3600_000),
        },
        actor,
        reason,
      );
      await c.discountConfig.activate(companyId, r.id, actor, reason);
      expect(
        (await simulate(cust.id, [[p, 1]], { couponCodes: [expired] })).couponProblems[0]!.reason,
      ).toMatch(/expired/);
      const coupon = (await c.discountConfig.listCoupons(companyId, r.id)).find(
        (x) => x.code === code,
      )!;
      await db.transaction((tx) =>
        c.discounts.commit(
          tx,
          companyId,
          { type: 'order', id: `t-${randomUUID()}`, customerId: cust.id },
          [
            {
              ruleId: r.id,
              ruleVersion: r.version,
              code: 'X',
              couponId: coupon.id,
              couponCode: code,
              amount: 10,
            },
          ],
        ),
      );
      expect(
        (await simulate(cust.id, [[p, 1]], { couponCodes: [code] })).couponProblems[0]!.reason,
      ).toMatch(/already used/);
      expect((await simulate(null, [[p, 1]], { couponCodes: [code] })).couponProblems).toHaveLength(
        0,
      );
    });
  });

  describe('in orders', () => {
    const order = async (
      email: string,
      productId: string,
      quantity: number,
      over: Record<string, unknown> = {},
    ) => {
      const { OrderWriteService } = await import('@/server/domains/orders/write-service');
      return OrderWriteService.createOrder({
        branchId,
        orderNumber: `DSC-${randomUUID()}`,
        customerName: 'Disc Buyer',
        customerEmail: email,
        customerPhone: '0700000000',
        shippingAddress: {
          street: '1 Rd',
          city: 'Nairobi',
          countyOrState: 'Nairobi',
          country: 'KE',
        },
        items: [{ productId, quantity }],
        currency: 'KES',
        paymentMethod: 'mpesa_daraja' as never,
        salesModule: 'sales_order',
        ...over,
      });
    };

    it('prices the order with the discount, records it, and counts the use', async () => {
      const cust = await customer();
      const p = await product({ price: '200' });
      const r = await rule([p], {
        scopes: { customer: { op: 'in', values: [cust.id] } },
        limits: { maxUses: 10 },
      });
      const res = await order(cust.email!, p, 3);
      expect(res.success).toBe(true);
      const o = res.order!;
      expect(o.totalAmount).toBe(540); // 600 less 10%
      expect(o.items[0]!.unitPrice).toBe(180);
      expect(o.items[0]!.priceTrace?.discounts).toMatchObject({
        unitPriceBefore: 200,
        applied: [{ code: r.code, amount: 60, level: 'line' }],
      });
      expect(o.discounts).toMatchObject({ total: 60 });
      const view = await c.discountConfig.getRuleView(companyId, r.id);
      expect(view).toMatchObject({ uses: 1, given: 60 });
    });

    it('cancelling the order gives the discount back', async () => {
      const cust = await customer();
      const p = await product({ price: '200' });
      const r = await rule([p], { scopes: { customer: { op: 'in', values: [cust.id] } } });
      const res = await order(cust.email!, p, 1);
      expect(res.success).toBe(true);
      const { InventoryDomainService } = await import('@/server/domains/inventory/service');
      await InventoryDomainService.cancelOrder(res.order!.id, 'changed mind');
      const view = await c.discountConfig.getRuleView(companyId, r.id);
      expect(view).toMatchObject({ uses: 0, given: 0 });
    });

    it('an order coupon is applied, and a bad one refuses the order and releases the stock', async () => {
      const cust = await customer();
      const p = await product({ price: '1000' });
      const r = await rule(
        [p],
        {
          kind: 'order',
          scopes: { customer: { op: 'in', values: [cust.id] } },
          requiresCoupon: true,
          reward: { type: 'amount', value: 100 },
          conditions: { minOrderValue: 500 },
        },
        false,
      );
      const code = `ORD${randomUUID().slice(0, 6).toUpperCase()}`;
      await c.discountConfig.createCoupons(companyId, r.id, { codes: [code] }, actor, reason);
      await c.discountConfig.activate(companyId, r.id, actor, reason);
      const bad = await order(cust.email!, p, 1, { couponCodes: ['WRONG999'] });
      expect(bad.success).toBe(false);
      expect(bad.error).toMatch(/Coupon WRONG999/);
      const stockRow = (
        await db.select().from(schema.products).where(eq(schema.products.id, p))
      )[0]!;
      expect(stockRow.reservedQuantity).toBe(0);
      const good = await order(cust.email!, p, 1, { couponCodes: [code] });
      expect(good.success).toBe(true);
      expect(good.order!.totalAmount).toBe(900);
    });

    it('when a strict limit is taken between pricing and saving, the order is refused and nothing is kept', async () => {
      const cust = await customer();
      const p = await product({ price: '100' });
      const r = await rule(
        [p],
        { scopes: { customer: { op: 'in', values: [cust.id] } }, limits: { maxUses: 1 } },
        false,
      );
      await c.discountConfig.updateRule(companyId, r.id, { strictLimits: true }, actor, reason);
      await c.discountConfig.activate(companyId, r.id, actor, reason);
      const results = await Promise.all([
        order(cust.email!, p, 1),
        order(cust.email!, p, 1),
        order(cust.email!, p, 1),
      ]);
      // Pricing is read before saving, so more than one may price with the discount, but the
      // strict check at saving lets only one keep it.
      expect(results.filter((x) => x.success).length).toBeGreaterThanOrEqual(1);
      expect((await c.discountConfig.getRuleView(companyId, r.id)).uses).toBe(1);
      for (const x of results.filter((y) => !y.success))
        expect(x.error).toMatch(/no longer available|Used up/i);
    });
  });

  describe('in quotes', () => {
    const quoteInput = (
      customerId: string | null,
      lines: unknown[],
      over: Record<string, unknown> = {},
    ) => ({
      customerId,
      customerName: 'Disc Quote Buyer',
      customerEmail: `dq-${randomUUID()}@disc.test`,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      discountPercent: 0,
      shippingFee: 0,
      sections: [],
      lines,
      ...over,
    });
    const quotes = async () => {
      const { SalesQuoteService } = await import('@/server/domains/quotes/service');
      return new SalesQuoteService();
    };

    it('a line discount lowers the unit price, with the explanation on the line', async () => {
      const svc = await quotes();
      const author = await user();
      const p = await product({ price: '200' });
      const r = await rule([p]);
      const q = await svc.create(
        author.id,
        quoteInput(null, [{ productId: p, quantity: 2, discountPercent: 0 }]) as never,
      );
      expect(Number(q.lines[0]!.unitPrice)).toBe(180);
      expect(q.lines[0]!.priceTrace?.discounts?.applied[0]).toMatchObject({
        code: r.code,
        amount: 40,
      });
      expect(Number(q.totalAmount)).toBe(360);
    });

    it('a typed price is not discounted again, and typing the discounted price is not an override', async () => {
      const svc = await quotes();
      const author = await user();
      const p = await product({ price: '200' });
      await rule([p]);
      const q = await svc.create(
        author.id,
        quoteInput(null, [
          { productId: p, quantity: 1, discountPercent: 0, unitPrice: 180, priceMode: 'manual' },
        ]) as never,
      );
      expect(Number(q.lines[0]!.unitPrice)).toBe(180);
      expect(q.lines[0]!.priceTrace?.guard?.overridePercent).toBe(0);
    });

    it('a coupon on the quote takes its share off each line, and converting records the use once', async () => {
      const svc = await quotes();
      const author = await user();
      const cust = await customer();
      const p1 = await product({ price: '600' });
      const p2 = await product({ price: '400' });
      const r = await rule(
        [p1, p2],
        {
          kind: 'order',
          scopes: { customer: { op: 'in', values: [cust.id] } },
          requiresCoupon: true,
          reward: { type: 'amount', value: 100 },
        },
        false,
      );
      const code = `QT${randomUUID().slice(0, 6).toUpperCase()}`;
      await c.discountConfig.createCoupons(companyId, r.id, { codes: [code] }, actor, reason);
      await c.discountConfig.activate(companyId, r.id, actor, reason);

      await expect(
        svc.create(
          author.id,
          quoteInput(cust.id, [{ productId: p1, quantity: 1, discountPercent: 0 }], {
            couponCodes: ['NOPE99999'],
          }) as never,
        ),
      ).rejects.toThrow(/Coupon NOPE99999/);

      const q = await svc.create(
        author.id,
        quoteInput(
          cust.id,
          [
            { productId: p1, quantity: 1, discountPercent: 0 },
            { productId: p2, quantity: 1, discountPercent: 0 },
          ],
          { couponCodes: [code] },
        ) as never,
      );
      expect(Number(q.totalAmount)).toBe(900);
      expect(q.lines.map((l) => Number(l.ruleDiscountPercent))).toEqual([10, 10]);
      expect(q.couponCodes).toEqual([code]);
      expect(q.discounts).toMatchObject({ total: 100 });
      // Saving does not use the rule up: that happens when the quote becomes an order.
      expect((await c.discountConfig.getRuleView(companyId, r.id)).uses).toBe(0);
    });
  });

  describe('approval to put a rule in force', () => {
    async function workflowFor(requester: string, approver: string) {
      const wf = await c.approvalConfig.createWorkflow(
        companyId,
        {
          code: `DW-${randomUUID().slice(0, 8)}`,
          name: 'Discount approval',
          trigger: 'discount_rule.publish',
        },
        actor,
      );
      await c.approvalConfig.saveDraft(
        companyId,
        wf.id,
        {
          conditions: { op: 'eq', field: 'requestedBy', value: requester },
          steps: [{ sequence: 1, name: 'Approver', approver: { type: 'user', userId: approver } }],
        } as never,
        actor,
      );
      await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    }
    const tx = <T>(fn: (t: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
      db.transaction(fn);

    it('goes in force at once when no workflow applies', async () => {
      const requester = await user();
      const p = await product();
      const r = await rule([p], {}, false);
      expect(
        await c.discountConfig.requestActivation(
          companyId,
          r.id,
          { type: 'user', id: requester.id },
          reason,
        ),
      ).toEqual({
        outcome: 'active',
      });
    });

    it("is held until approved, then goes in force with the requester's reason", async () => {
      const requester = await user();
      const approver = await user();
      await workflowFor(requester.id, approver.id);
      const p = await product({ price: '100' });
      const r = await rule([p], {}, false);
      const out = await c.discountConfig.requestActivation(
        companyId,
        r.id,
        { type: 'user', id: requester.id },
        { code: 'POLICY_CHANGE', text: 'Spring campaign' },
      );
      expect(out.outcome).toBe('pending');
      expect(await c.discountConfig.getRule(companyId, r.id)).toMatchObject({
        status: 'draft',
        approvalStatus: 'pending',
      });
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(100);
      await expect(
        c.discountConfig.updateRule(companyId, r.id, { priority: 3 }, actor, reason),
      ).rejects.toMatchObject({ code: 'NOT_EDITABLE' });

      const entry = (await c.approvals.inbox(approver.id)).find(
        (e) => e.documentKind === 'discount_rule',
      )!;
      await tx((t) => c.approvals.approve(entry.entryId, approver.id, null, t));
      c.discounts.invalidate(companyId);
      expect(await c.discountConfig.getRule(companyId, r.id)).toMatchObject({
        status: 'active',
        approvalStatus: 'none',
      });
      expect((await simulate(null, [[p, 1]])).lines[0]!.unitPriceAfter).toBe(90);
      const activated = (await c.decisionLog.timeline('discount_rule', r.id)).find(
        (l) => l.action === 'pricing.discount_activated',
      );
      expect(activated).toMatchObject({
        actorId: requester.id,
        reasonCode: 'POLICY_CHANGE',
        reasonText: 'Spring campaign',
      });
    });

    it('a refusal leaves the rule as it was', async () => {
      const requester = await user();
      const approver = await user();
      await workflowFor(requester.id, approver.id);
      const p = await product();
      const r = await rule([p], {}, false);
      await c.discountConfig.requestActivation(
        companyId,
        r.id,
        { type: 'user', id: requester.id },
        reason,
      );
      const entry = (await c.approvals.inbox(approver.id)).find(
        (e) => e.documentKind === 'discount_rule',
      )!;
      await tx((t) =>
        c.approvals.reject(
          entry.entryId,
          approver.id,
          { reasonCode: 'OTHER', comment: 'Too generous' },
          t,
        ),
      );
      expect(await c.discountConfig.getRule(companyId, r.id)).toMatchObject({
        status: 'draft',
        approvalStatus: 'rejected',
      });
    });
  });

  describe('mix deals and gifts', () => {
    const deal = async (mix: unknown, over: Record<string, unknown> = {}, activate = true) => {
      const kind = (mix as { type: string }).type === 'gift' ? 'gift' : 'mix';
      const r = await c.discountConfig.createRule(
        companyId,
        baseInput({ kind, reward: { type: 'percent', value: 0 }, mix, ...over }) as never,
        actor,
        reason,
      );
      if (activate) await c.discountConfig.activate(companyId, r.id, actor, reason);
      return r;
    };
    const only = (...ids: string[]) => ({ productIds: ids });

    it('buy 2 get 1 free: the cheapest of each group of three is free', async () => {
      const cust = await customer();
      const p = await product({ price: '100' });
      await deal(
        {
          type: 'buy_get',
          sameSet: true,
          buy: { target: only(p), quantity: 2 },
          get: { target: only(p), quantity: 1, reward: { kind: 'free' } },
        },
        { scopes: { customer: { op: 'in', values: [cust.id] } } },
      );
      const s = await simulate(cust.id, [[p, 3]]);
      expect(s.lines[0]!.lineTotalAfter).toBe(200);
      expect(s.lines[0]!.applied[0]).toMatchObject({ how: 'buy 2, get 1 free', amount: 100 });
      expect((await simulate(cust.id, [[p, 2]])).lines[0]!.lineTotalAfter).toBe(200);
      expect((await simulate(null, [[p, 3]])).lines[0]!.lineTotalAfter).toBe(300);
    });

    it('any 3 for a set price across products, and a bundle deal for a fixed price', async () => {
      const cust = await customer();
      const [a, b, d] = [
        await product({ price: '100' }),
        await product({ price: '100' }),
        await product({ price: '100' }),
      ];
      const scope = { customer: { op: 'in', values: [cust.id] } };
      await deal(
        {
          type: 'mix_match',
          set: only(a, b, d),
          quantity: 3,
          reward: { kind: 'price', value: 250 },
        },
        { scopes: scope },
      );
      const s = await simulate(cust.id, [
        [a, 1],
        [b, 1],
        [d, 1],
      ]);
      expect(s.totalAfter).toBe(250);
      // Split to the cent: each line within a cent of an even share, adding up exactly.
      expect([...s.lines.map((l) => l.lineTotalAfter)].sort()).toEqual([83.33, 83.33, 83.34]);

      const x = await product({ price: '300' });
      const y = await product({ price: '150' });
      await deal(
        {
          type: 'bundle_deal',
          price: 350,
          slots: [
            { target: only(x), quantity: 1 },
            { target: only(y), quantity: 1 },
          ],
        },
        { scopes: scope },
      );
      expect(
        (
          await simulate(cust.id, [
            [x, 1],
            [y, 1],
          ])
        ).totalAfter,
      ).toBe(350);
      expect((await simulate(cust.id, [[x, 1]])).totalAfter).toBe(300);
    });

    it('works on what the line rules left, and a unit earns only one deal', async () => {
      const cust = await customer();
      const p = await product({ price: '100' });
      const scope = { scopes: { customer: { op: 'in', values: [cust.id] } } };
      await rule([p], { ...scope, reward: { type: 'percent', value: 10 } });
      await deal(
        {
          type: 'buy_get',
          sameSet: true,
          buy: { target: only(p), quantity: 1 },
          get: { target: only(p), quantity: 1, reward: { kind: 'free' } },
        },
        scope,
      );
      // 2 units at 100 less 10% = 180; one of the two is then free (90): 90.
      expect((await simulate(cust.id, [[p, 2]])).lines[0]!.lineTotalAfter).toBe(90);
    });

    it('a free gift is earned by spending enough, is judged after discounts, and checks stock', async () => {
      const cust = await customer();
      const p = await product({ price: '1000' });
      const pen = await product({ price: '50', stockQuantity: 10 });
      const empty = await product({ price: '50', stockQuantity: 0 });
      const scope = { scopes: { customer: { op: 'in', values: [cust.id] } } };
      await deal(
        {
          type: 'gift',
          trigger: { minOrderValue: 1000, target: only(p) },
          gifts: [{ productId: pen, quantity: 1 }],
        },
        scope,
      );
      // 10% off brings 1,000 to 900: not enough for the gift.
      await rule([p], { ...scope, reward: { type: 'percent', value: 10 } });
      expect((await simulate(cust.id, [[p, 1]])).gifts).toHaveLength(0);
      const two = await simulate(cust.id, [[p, 2]]);
      expect(two.gifts).toHaveLength(1);
      expect(two.gifts[0]).toMatchObject({
        productName: expect.any(String),
        quantity: 1,
        value: 50,
      });

      await deal(
        { type: 'gift', trigger: { minOrderValue: 1 }, gifts: [{ productId: empty, quantity: 1 }] },
        { ...scope, code: `G-${randomUUID().slice(0, 6)}` },
      );
      const s = await simulate(cust.id, [[p, 2]]);
      expect(s.gifts.map((g) => g.productName)).toHaveLength(1);
      expect(s.orderConsidered.some((x) => x.why.includes('out of stock'))).toBe(true);
    });

    it('checks the deal before it is saved', async () => {
      const p = await product();
      const bad = (mix: unknown, kind = 'mix') =>
        c.discountConfig.createRule(
          companyId,
          baseInput({
            kind,
            reward: { type: 'percent', value: 0 },
            mix,
            target: { productIds: [p] },
          }) as never,
          actor,
          reason,
        );
      await expect(bad(null)).rejects.toMatchObject({ code: 'INVALID' });
      await expect(
        bad({
          type: 'buy_get',
          buy: { target: {}, quantity: 0 },
          get: { target: {}, quantity: 1, reward: { kind: 'free' } },
        }),
      ).rejects.toThrow(/at least 1/);
      await expect(
        bad({ type: 'mix_match', set: {}, quantity: 1, reward: { kind: 'price', value: 10 } }),
      ).rejects.toThrow(/at least 2/);
      await expect(
        bad({
          type: 'bundle_deal',
          price: 10,
          slots: [
            { target: {}, quantity: 1 },
            { target: only(p), quantity: 1 },
          ],
        }),
      ).rejects.toThrow(/choose which products/);
      await expect(
        bad(
          {
            type: 'gift',
            trigger: { minOrderValue: 5 },
            gifts: [{ productId: 'prod_missing', quantity: 1 }],
          },
          'gift',
        ),
      ).rejects.toThrow(/missing or switched off/);
      await expect(
        bad({ type: 'gift', trigger: {}, gifts: [{ productId: p, quantity: 1 }] }, 'mix'),
      ).rejects.toThrow(/Choose a buy-and-get/);
    });

    it('is described in plain words', async () => {
      const p = await product({ name: 'Trail Shoe' });
      const r = await deal(
        {
          type: 'buy_get',
          sameSet: true,
          buy: { target: only(p), quantity: 2 },
          get: { target: only(p), quantity: 1, reward: { kind: 'free' } },
        },
        {},
        false,
      );
      const view = await c.discountConfig.getRuleView(companyId, r.id);
      expect(view.summary).toContain('Buy 2 of Trail Shoe, get 1 more free');
      expect(view.summary).toContain('Each unit earns at most one deal');
    });

    it("a used-up gift or deal is blocked like any rule, and use is counted with the gift's value", async () => {
      const cust = await customer();
      const p = await product({ price: '100' });
      const pen = await product({ price: '40', stockQuantity: 10 });
      const r = await deal(
        { type: 'gift', trigger: {}, gifts: [{ productId: pen, quantity: 1 }] },
        {
          scopes: { customer: { op: 'in', values: [cust.id] } },
          target: only(p),
          limits: { maxUses: 1 },
        },
      );
      const basket = await c.discounts.evaluate(companyId, { customerId: cust.id }, [
        {
          productId: p,
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          taxRate: 0,
          lineTaxInclusive: true,
        },
      ]);
      expect(basket.gifts).toHaveLength(1);
      expect(basket.applications.find((a) => a.ruleId === r.id)!.amount).toBe(40);
      await db.transaction((tx) =>
        c.discounts.commit(
          tx,
          companyId,
          { type: 'order', id: `t-${randomUUID()}`, customerId: cust.id },
          basket.applications,
        ),
      );
      const again = await simulate(cust.id, [[p, 1]]);
      expect(again.gifts).toHaveLength(0);
    });
  });
});
