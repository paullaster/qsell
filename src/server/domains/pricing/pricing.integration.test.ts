import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

/**
 * Price lists, lines, lifecycle and pricing, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * Every list is limited to a customer (or group) made by the test, so lists left by other tests
 * or earlier runs never match these sales.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('pricing (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let companyId: string;
  let itemTypeId: string;

  const actor = { type: 'user' as const, id: 'pricing-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const customer = async (name = 'Pricing Customer') =>
    (
      await db
        .insert(schema.customers)
        .values({
          companyId,
          number: `PC-${randomUUID().slice(0, 10)}`,
          name,
          email: `pc-${randomUUID()}@pricing.test`,
          accountType: 'cash',
        })
        .returning()
    )[0]!;

  const product = async (price: number | null = 1000, taxRate = '0') => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `P-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `PS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Pricing product',
      slug: `pricing-${randomUUID()}`,
      itemTypeId,
      price: price == null ? null : String(price),
      taxRate,
      isTaxInclusive: true,
      stockQuantity: 100,
    });
    return id;
  };

  const list = (customerId: string, over: Record<string, unknown> = {}) =>
    c.pricingConfig.createList(
      companyId,
      {
        code: `PL-${randomUUID().slice(0, 8)}`,
        name: 'Test list',
        currency: 'KES',
        scopes: { customer: { op: 'in', values: [customerId] } },
        ...over,
      } as never,
      actor,
      reason,
    );

  const sell = async (customerId: string, productId: string, quantity = 1, extra = {}) =>
    (
      await c.pricing.priceLines(companyId, { customerId, channel: 'sales_order', ...extra }, [
        {
          productId,
          quantity,
          standardPrice: 1000,
          taxRate: 0,
          lineTaxInclusive: true,
          standardTaxInclusive: true,
        },
      ])
    )[0]!;

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pricing_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    // Make sure there is a base currency to price in.
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    await db
      .insert(schema.currencies)
      .values({ code: 'USD', name: 'US Dollar', symbol: '$', exchangeRate: '0.0077' })
      .onConflictDoNothing();
  });

  it('prices from a list only once it is active, and says which list won', async () => {
    const cust = await customer();
    const p = await product(1000);
    const pl = await list(cust.id);
    await c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 800 }], actor, reason);

    const before = await sell(cust.id, p);
    expect(before.unitPrice).toBe(1000);
    expect(before.trace.source).toBe('standard');

    await c.pricingConfig.activate(companyId, pl.id, actor, reason);
    const after = await sell(cust.id, p, 3);
    expect(after.unitPrice).toBe(800);
    expect(after.lineTotal).toBe(2400);
    expect(after.trace.source).toBe('price_list');
    expect(after.trace.winner?.listId).toBe(pl.id);
    expect(after.trace.steps.join(' ')).toMatch(new RegExp(pl.code));

    // Another customer is not affected.
    const other = await customer();
    expect((await sell(other.id, p)).unitPrice).toBe(1000);
  });

  it('applies quantity breaks, in both modes', async () => {
    const cust = await customer();
    const p = await product(1000);
    const allUnits = await list(cust.id);
    await c.pricingConfig.setLines(
      companyId,
      allUnits.id,
      [{ productId: p, price: 100, tiers: [{ fromQty: 50, price: 90 }] }],
      actor,
      reason,
    );
    await c.pricingConfig.activate(companyId, allUnits.id, actor, reason);
    expect((await sell(cust.id, p, 49)).lineTotal).toBe(4900);
    expect((await sell(cust.id, p, 50)).lineTotal).toBe(4500);

    const cust2 = await customer();
    const incr = await list(cust2.id, { quantityMode: 'incremental' });
    await c.pricingConfig.setLines(
      companyId,
      incr.id,
      [{ productId: p, price: 100, tiers: [{ fromQty: 51, price: 90 }] }],
      actor,
      reason,
    );
    await c.pricingConfig.activate(companyId, incr.id, actor, reason);
    expect((await sell(cust2.id, p, 60)).lineTotal).toBe(5000 + 10 * 90);
  });

  it('keeps history: a change closes the old price and a past sale can still be explained', async () => {
    const cust = await customer();
    const p = await product();
    const pl = await list(cust.id);
    await c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 800 }], actor, reason);
    await c.pricingConfig.activate(companyId, pl.id, actor, reason);
    const first = await sell(cust.id, p);
    const asOf = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 750 }], actor, reason);
    expect((await sell(cust.id, p)).unitPrice).toBe(750);
    // Priced "as of" before the change gives the old price.
    expect((await sell(cust.id, p, 1, { at: asOf })).unitPrice).toBe(800);
    const hist = await c.pricingConfig.lineHistory(companyId, pl.id, p);
    expect(hist).toHaveLength(2);
    expect(hist.filter((h) => h.validTo === null)).toHaveLength(1);
    expect(first.trace.winner?.lineId).toBe(hist.find((h) => Number(h.price) === 800)!.id);
  });

  it('is idempotent: sending the same prices twice changes nothing', async () => {
    const cust = await customer();
    const p = await product();
    const pl = await list(cust.id);
    const rows = [{ productId: p, price: 700, tiers: [{ fromQty: 10, price: 650 }] }];
    expect(await c.pricingConfig.setLines(companyId, pl.id, rows, actor, reason)).toEqual({
      created: 1,
      replaced: 0,
      unchanged: 0,
    });
    expect(await c.pricingConfig.setLines(companyId, pl.id, rows, actor, reason)).toEqual({
      created: 0,
      replaced: 1 - 1,
      unchanged: 1,
    });
    expect(await c.pricingConfig.lineHistory(companyId, pl.id, p)).toHaveLength(1);
  });

  it('schedules a price for later, and a change made now replaces what was scheduled', async () => {
    const cust = await customer();
    const p = await product();
    const pl = await list(cust.id);
    await c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 800 }], actor, reason);
    await c.pricingConfig.activate(companyId, pl.id, actor, reason);
    const nextWeek = new Date(Date.now() + 7 * 864e5);
    await c.pricingConfig.setLines(
      companyId,
      pl.id,
      [{ productId: p, price: 900 }],
      actor,
      reason,
      {
        validFrom: nextWeek,
      },
    );
    expect((await sell(cust.id, p)).unitPrice).toBe(800);
    expect((await sell(cust.id, p, 1, { at: new Date(nextWeek.getTime() + 1000) })).unitPrice).toBe(
      900,
    );
    // A change now supersedes the scheduled one.
    await c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 770 }], actor, reason);
    expect((await sell(cust.id, p)).unitPrice).toBe(770);
    expect((await sell(cust.id, p, 1, { at: new Date(nextWeek.getTime() + 1000) })).unitPrice).toBe(
      770,
    );
    // And there is still only one open-ended price.
    const hist = await c.pricingConfig.lineHistory(companyId, pl.id, p);
    expect(hist.filter((h) => h.validTo === null)).toHaveLength(1);
  });

  it('refuses a price that starts in the past, an unknown product, bad tiers, and a missing reason', async () => {
    const cust = await customer();
    const p = await product();
    const pl = await list(cust.id);
    await expect(
      c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 1 }], actor, reason, {
        validFrom: new Date(Date.now() - 86400000),
      }),
    ).rejects.toThrow(/past/);
    await expect(
      c.pricingConfig.setLines(companyId, pl.id, [{ productId: 'nope', price: 1 }], actor, reason),
    ).rejects.toThrow(/do not exist/);
    await expect(
      c.pricingConfig.setLines(
        companyId,
        pl.id,
        [
          {
            productId: p,
            price: 5,
            tiers: [
              { fromQty: 5, price: 1 },
              { fromQty: 5, price: 1 },
            ],
          },
        ],
        actor,
        reason,
      ),
    ).rejects.toThrow(/higher/);
    await expect(
      c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 5 }], actor, {}),
    ).rejects.toThrow(/reason/i);
  });

  it('a locked price cannot be replaced without an explicit override, which is recorded', async () => {
    const cust = await customer();
    const p = await product();
    const pl = await list(cust.id, { kind: 'contract' });
    const until = new Date(Date.now() + 30 * 864e5);
    await c.pricingConfig.setLines(
      companyId,
      pl.id,
      [{ productId: p, price: 600, lockedUntil: until }],
      actor,
      reason,
    );
    await expect(
      c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 650 }], actor, reason),
    ).rejects.toThrow(/locked/);
    await c.pricingConfig.setLines(
      companyId,
      pl.id,
      [{ productId: p, price: 650 }],
      actor,
      reason,
      {
        overrideLock: true,
      },
    );
    const hist = await c.pricingConfig.lineHistory(companyId, pl.id, p);
    expect(hist).toHaveLength(2);
  });

  it('records every change in the decision log with its reason', async () => {
    const cust = await customer();
    const p = await product();
    const pl = await list(cust.id);
    await c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price: 500 }], actor, reason);
    await c.pricingConfig.activate(companyId, pl.id, actor, reason);
    await c.pricingConfig.updateList(companyId, pl.id, { priority: 4 }, actor, reason);
    await c.pricingConfig.retire(companyId, pl.id, actor, { code: 'OTHER', text: 'Season over' });
    const t = await c.pricingConfig.timeline(pl.id);
    expect(t.map((e) => e.action)).toEqual([
      'pricing.list_created',
      'pricing.prices_changed',
      'pricing.list_activated',
      'pricing.list_changed',
      'pricing.list_retired',
    ]);
    expect(t.every((e) => e.reasonCode)).toBe(true);
    expect(t.at(-1)!.reasonText).toBe('Season over');
    const changed = t.find((e) => e.action === 'pricing.list_changed')!;
    expect(changed.fromState).toBe('v1');
    expect(changed.toState).toBe('v2');
    // A retired list stops pricing.
    expect((await sell(cust.id, p)).trace.source).toBe('standard');
  });

  it('blocks activating a list that would tie with a live one, and allows it once ranked apart', async () => {
    const cust = await customer();
    const p = await product();
    const a = await list(cust.id, { priority: 3 });
    const b = await list(cust.id, { priority: 3 });
    await c.pricingConfig.setLines(companyId, a.id, [{ productId: p, price: 500 }], actor, reason);
    await c.pricingConfig.setLines(companyId, b.id, [{ productId: p, price: 450 }], actor, reason);
    await c.pricingConfig.activate(companyId, a.id, actor, reason);
    await expect(c.pricingConfig.activate(companyId, b.id, actor, reason)).rejects.toThrow(/tie/);
    await c.pricingConfig.updateList(companyId, b.id, { priority: 4 }, actor, reason);
    await c.pricingConfig.activate(companyId, b.id, actor, reason);
    expect((await sell(cust.id, p)).unitPrice).toBe(450);
    // Lowering it back to a tie is refused on a live list too.
    await expect(
      c.pricingConfig.updateList(companyId, b.id, { priority: 3 }, actor, reason),
    ).rejects.toThrow(/tie/);
    // Adding a product to a live list that an equally ranked list already prices is refused.
    const p2 = await product();
    const cust2 = await customer();
    const x = await list(cust2.id, { priority: 1 });
    const y = await list(cust2.id, { priority: 1 });
    await c.pricingConfig.setLines(companyId, x.id, [{ productId: p2, price: 10 }], actor, reason);
    await c.pricingConfig.setLines(companyId, y.id, [{ productId: p, price: 10 }], actor, reason);
    await c.pricingConfig.activate(companyId, x.id, actor, reason);
    await c.pricingConfig.activate(companyId, y.id, actor, reason); // no product in common
    await expect(
      c.pricingConfig.setLines(companyId, y.id, [{ productId: p2, price: 11 }], actor, reason),
    ).rejects.toThrow(/same rank/);
  });

  it('refuses to activate an empty list or one naming a customer that is gone', async () => {
    const cust = await customer();
    const empty = await list(cust.id);
    await expect(c.pricingConfig.activate(companyId, empty.id, actor, reason)).rejects.toThrow(
      /at least one price/,
    );
    await expect(
      list(cust.id, { scopes: { customer: { op: 'in', values: [randomUUID()] } } }),
    ).rejects.toThrow(/no longer exist/);
    await expect(list(cust.id, { scopes: { customer: { op: 'in', values: [] } } })).rejects.toThrow(
      /at least one/,
    );
    await expect(list(cust.id, { currency: 'ZZZ' })).rejects.toThrow(/currency/);
  });

  it('a customer in several groups is priced by the highest-priority group', async () => {
    const cust = await customer();
    const p = await product();
    const mk = async (priority: number) =>
      c.pricingConfig.saveGroup(
        companyId,
        { code: `G-${randomUUID().slice(0, 8)}`, name: 'Group', priority },
        actor,
        reason,
      );
    const low = await mk(1);
    const high = await mk(9);
    await c.pricingConfig.changeMembers(companyId, low.id, { add: [cust.id] }, actor, reason);
    await c.pricingConfig.changeMembers(companyId, high.id, { add: [cust.id] }, actor, reason);
    const forGroup = async (g: string, price: number) => {
      const pl = await c.pricingConfig.createList(
        companyId,
        {
          code: `GL-${randomUUID().slice(0, 8)}`,
          name: 'Group list',
          currency: 'KES',
          scopes: { customer_group: { op: 'in', values: [g] } },
        },
        actor,
        reason,
      );
      await c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price }], actor, reason);
      await c.pricingConfig.activate(companyId, pl.id, actor, reason);
      return pl;
    };
    await forGroup(low.id, 900);
    await forGroup(high.id, 850);
    expect(await c.pricing.groupFor(companyId, cust.id)).toBe(high.id);
    expect((await sell(cust.id, p)).unitPrice).toBe(850);
    // Leave the high group and the low one prices them.
    await c.pricingConfig.changeMembers(companyId, high.id, { remove: [cust.id] }, actor, reason);
    expect((await sell(cust.id, p)).unitPrice).toBe(900);
    const timeline = await c.decisionLog.timeline('customer_group', high.id);
    expect(timeline.map((e) => e.action)).toContain('pricing.group_members_changed');
  });

  it('weights can be changed with a reason, logged, and reset', async () => {
    const before = await c.pricingConfig.getWeights(companyId);
    try {
      const after = await c.pricingConfig.setWeights(companyId, { route: 99 }, actor, reason);
      expect(after.route).toBe(99);
      await expect(
        c.pricingConfig.setWeights(companyId, { route: -1 }, actor, reason),
      ).rejects.toThrow(/whole numbers/);
      await expect(
        c.pricingConfig.setWeights(companyId, { galaxy: 1 } as never, actor, reason),
      ).rejects.toThrow(/not a weight/);
      const t = await c.decisionLog.timeline('price_weights', companyId);
      expect(t.at(-1)!.action).toBe('pricing.weights_changed');
      expect(t.at(-1)!.inputs).toMatchObject({ route: before.route });
    } finally {
      await c.pricingConfig.resetWeights(companyId, actor, reason);
    }
    expect((await c.pricingConfig.getWeights(companyId)).route).toBe(16);
  });

  it('converts a base-currency price into another currency at the rate', async () => {
    const cust = await customer();
    const p = await product();
    const pl = await list(cust.id);
    await c.pricingConfig.setLines(
      companyId,
      pl.id,
      [{ productId: p, price: 1000 }],
      actor,
      reason,
    );
    await c.pricingConfig.activate(companyId, pl.id, actor, reason);
    const [usd] = await db
      .select()
      .from(schema.currencies)
      .where(eq(schema.currencies.code, 'USD'));
    const [kes] = await db
      .select()
      .from(schema.currencies)
      .where(and(eq(schema.currencies.code, 'KES')));
    const rate = Number(usd!.exchangeRate) / Number(kes!.exchangeRate);
    const r = await sell(cust.id, p, 10, { currency: 'USD' });
    expect(r.lineTotal).toBeCloseTo(Math.round(1000 * 10 * rate * 100) / 100, 2);
    expect(r.trace.steps.join(' ')).toMatch(/Converted from KES/);
  });

  // ── Wired into orders and quotes ───────────────────────────────────────

  describe('in sales orders and quotes', () => {
    let branchId: string;
    let requester: string;

    beforeAll(async () => {
      const { branch } = await c.organizations.ensureDefaultOrgAndBranch(
        companyId,
        'Pricing Test Co',
      );
      branchId = ((await c.branches.getDefault(companyId)) || branch).id;
      requester = (
        await db
          .insert(schema.users)
          .values({
            email: `pricing-${randomUUID()}@pricing.test`,
            passwordHash: 'x',
            name: 'Pricing requester',
            role: 'manager',
          })
          .returning()
      )[0]!.id;
    });

    const order = async (
      email: string | null,
      productId: string,
      over: Record<string, unknown> = {},
    ) => {
      const { OrderWriteService } = await import('@/server/domains/orders/write-service');
      return OrderWriteService.createOrder({
        branchId,
        orderNumber: `PRC-${randomUUID()}`,
        customerName: 'Pricing Buyer',
        customerEmail: email ?? `buyer-${randomUUID()}@pricing.test`,
        customerPhone: '0700000000',
        shippingAddress: {
          street: '1 Test Rd',
          city: 'Nairobi',
          countyOrState: 'Nairobi',
          country: 'KE',
        },
        items: [{ productId, quantity: 2 }],
        currency: 'KES',
        paymentMethod: 'mpesa_daraja' as never,
        ...over,
      });
    };

    const withList = async (cust: { id: string }, p: string, price: number) => {
      const pl = await list(cust.id);
      await c.pricingConfig.setLines(companyId, pl.id, [{ productId: p, price }], actor, reason);
      await c.pricingConfig.activate(companyId, pl.id, actor, reason);
      return pl;
    };

    it('a staff order is priced from the lists and keeps the explanation', async () => {
      const cust = await customer();
      const p = await product(1000);
      const pl = await withList(cust, p, 800);
      const res = await order(cust.email!, p, { salesModule: 'sales_order' });
      expect(res.success).toBe(true);
      const o = res.order!;
      expect(o.items[0]!.unitPrice).toBe(800);
      expect(o.items[0]!.totalPrice).toBe(1600);
      expect(o.totalAmount).toBe(1600);
      const stored = await c.orders.getById(o.id);
      expect(stored!.items[0]!.priceTrace?.winner?.listId).toBe(pl.id);
      expect(stored!.items[0]!.priceTrace?.source).toBe('price_list');
    });

    it('the web shop keeps the standard price, so shown and charged prices agree', async () => {
      const cust = await customer();
      const p = await product(1000);
      await withList(cust, p, 800);
      const res = await order(cust.email!, p); // ecommerce
      expect(res.success).toBe(true);
      expect(res.order!.items[0]!.unitPrice).toBe(1000);
      const stored = await c.orders.getById(res.order!.id);
      expect(stored!.items[0]!.priceTrace).toBeNull();
    });

    it('a staff order for something that cannot be priced is refused, never priced at zero', async () => {
      const p = await product(null);
      const res = await order(null, p, { salesModule: 'sales_order' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/cannot be priced/);
    });

    it('a product with a list price but no standard price can still be ordered', async () => {
      const cust = await customer();
      const p = await product(null);
      await withList(cust, p, 640);
      const res = await order(cust.email!, p, { salesModule: 'sales_order' });
      expect(res.success).toBe(true);
      expect(res.order!.items[0]!.unitPrice).toBe(640);
    });

    const quoteInput = (customerId: string, lines: unknown[]) => ({
      customerId,
      customerName: 'Quote Buyer',
      customerEmail: 'quote-buyer@pricing.test',
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      discountPercent: 0,
      shippingFee: 0,
      sections: [],
      lines,
    });

    it('quote lines follow their price mode: catalog from the lists, manual as typed, kept as saved', async () => {
      const { SalesQuoteService } = await import('@/server/domains/quotes/service');
      const quotes = new SalesQuoteService();
      const cust = await customer();
      const p1 = await product(1000);
      const p2 = await product(1000);
      const p3 = await product(1000);
      const pl = await withList(cust, p1, 700);
      await c.pricingConfig.setLines(
        companyId,
        pl.id,
        [
          { productId: p2, price: 600 },
          { productId: p3, price: 500 },
        ],
        actor,
        reason,
      );
      const q = await quotes.create(
        requester,
        quoteInput(cust.id, [
          { productId: p1, quantity: 1, discountPercent: 0 },
          { productId: p2, quantity: 1, discountPercent: 0, unitPrice: 999 },
          { productId: p3, quantity: 1, discountPercent: 0, unitPrice: 123, priceMode: 'catalog' },
        ]) as never,
      );
      const byProduct = (qq: typeof q) => new Map(qq.lines.map((l) => [l.productId, l]));
      let lines = byProduct(q);
      expect(Number(lines.get(p1)!.unitPrice)).toBe(700);
      expect(lines.get(p1)!.priceTrace?.winner?.listId).toBe(pl.id);
      expect(Number(lines.get(p2)!.unitPrice)).toBe(999);
      expect(lines.get(p2)!.priceTrace).toBeNull();
      expect(Number(lines.get(p3)!.unitPrice)).toBe(500); // the typed number is ignored in catalog mode

      // The list changes. Re-saving with the saved prices kept does not reprice the quote.
      await c.pricingConfig.setLines(
        companyId,
        pl.id,
        [{ productId: p1, price: 650 }],
        actor,
        reason,
      );
      const kept = await quotes.update(
        requester,
        q.id,
        quoteInput(cust.id, [
          { productId: p1, quantity: 1, discountPercent: 0, unitPrice: 700, priceMode: 'kept' },
        ]) as never,
      );
      const k = kept.lines[0]!;
      expect(Number(k.unitPrice)).toBe(700);
      expect(k.priceTrace?.winner?.listId).toBe(pl.id);
      // Repricing on request picks up the change.
      const repriced = await quotes.update(
        requester,
        q.id,
        quoteInput(cust.id, [{ productId: p1, quantity: 1, discountPercent: 0 }]) as never,
      );
      expect(Number(repriced.lines[0]!.unitPrice)).toBe(650);
    });
  });
});
