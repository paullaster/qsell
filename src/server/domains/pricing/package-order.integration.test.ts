import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { OrderWriteService } from '@/server/domains/orders/write-service';

/**
 * Ordering a configurable package, against a real database: the line becomes its parts, stock is held per part, the selection is
 * recorded, and the rules of ordering hold.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('ordering a package (database)', () => {
  type Container = ReturnType<typeof getContainer>;
  let c: Container;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let write: typeof OrderWriteService;
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;
  const actor = { type: 'user' as const, id: 'package-order-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `PO-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `POS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Order part ${randomUUID().slice(0, 4)}`,
      slug: `po-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '40',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 100,
      ...over,
    });
    return id;
  };

  /** Lunch at 650 with fish (small, large +120), starch (ugali, brown +30) and vegetables (1 or 2). Parts carry different tax. */
  const lunch = async (rules?: Record<string, unknown>) => {
    const p = {
      lunch: await product({ name: 'Express lunch order test', price: '650', costPrice: '0', inventoryKind: 'non_inventory', stockQuantity: 0 }),
      small: await product({ name: 'Small fish', price: '300', costPrice: '150', stockQuantity: 20, taxRate: '16' }),
      large: await product({ name: 'Large fish', price: '420', costPrice: '200', stockQuantity: 20, taxRate: '16' }),
      ugali: await product({ name: 'Ugali', price: '50', costPrice: '20', soldOnlyInPackages: true, showOnWebShop: false, stockQuantity: 30 }),
      brown: await product({ name: 'Brown ugali', price: '80', costPrice: '35', soldOnlyInPackages: true, showOnWebShop: false, stockQuantity: 30 }),
      sukuma: await product({ name: 'Sukuma', price: '40', costPrice: '15', stockQuantity: 30 }),
      cabbage: await product({ name: 'Cabbage', price: '40', costPrice: '15', stockQuantity: 30 }),
    };
    const view = await c.packageConfig.save(
      companyId,
      {
        productId: p.lunch,
        pricingMode: 'base_plus_differences',
        allocation: 'list_price',
        shortStockMode: 'hide',
        ...(rules === undefined ? {} : { rules: { minServings: null, maxServings: null, noticeMinutes: null, closesDaysBefore: null, closesAtMinute: null, weekdays: [], dailyLimit: null, audience: 'anyone', groupIds: [], ...rules } }),
        slots: [
          { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.small, quantity: 1 }, { productId: p.large, quantity: 1, difference: 120 }] },
          { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: p.ugali, quantity: 1 }, { productId: p.brown, quantity: 1, difference: 30 }] },
          { name: 'Vegetables', minPicks: 1, maxPicks: 2, options: [{ productId: p.sukuma, quantity: 1 }, { productId: p.cabbage, quantity: 1, difference: 10 }] },
        ],
      },
      actor,
      reason,
    );
    const pick = (slot: number, productId: string) => {
      const s = view.slots[slot];
      const o = s?.options.find((x) => x.productId === productId);
      if (s === undefined || o === undefined) throw new Error('option missing');
      return { slotId: s.id, optionId: o.id, count: 1 };
    };
    return { p, pick };
  };

  const order = (items: unknown[], over: Record<string, unknown> = {}) =>
    write.createOrder({
      branchId,
      orderNumber: `PKO-${randomUUID()}`,
      customerName: 'Buyer',
      customerEmail: `pko-${randomUUID()}@pkg.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: items as never,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      ...over,
    });
  const stockOf = async (id: string) => (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0];
  const day = (ahead: number) => new Date(Date.now() + ahead * 86_400_000 + 3 * 3_600_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    write = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pko_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Package Order Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
  });

  it('turns a package line into its parts, holds stock per part, taxes each part by its own rate and records the selection', async () => {
    const { p, pick } = await lunch();
    const result = await order([{ productId: p.lunch, quantity: 3, package: { picks: [pick(0, p.large), pick(1, p.brown), pick(2, p.sukuma), pick(2, p.cabbage)] } }]);
    expect(result.success).toBe(true);
    const items = result.order?.items ?? [];
    // One line per product, named for the package, and the parts add up to the price: (650 + 120 + 30 + 10) x 3.
    expect(items.map((i) => i.productName).sort()).toEqual(['Brown ugali (Express lunch order test)', 'Cabbage (Express lunch order test)', 'Large fish (Express lunch order test)', 'Sukuma (Express lunch order test)']);
    expect(items.reduce((n, i) => n + i.totalPrice, 0)).toBeCloseTo(810 * 3, 2);
    expect(items.every((i) => i.quantity === 3)).toBe(true);
    // Stock is held for each part, none for the package product.
    expect(Number((await stockOf(p.large))?.reservedQuantity)).toBe(3);
    expect(Number((await stockOf(p.brown))?.reservedQuantity)).toBe(3);
    expect(Number((await stockOf(p.small))?.reservedQuantity)).toBe(0);
    expect(Number((await stockOf(p.lunch))?.reservedQuantity)).toBe(0);
    // Only the fish carries tax (16%, inside the price): less than the price, more than nothing.
    expect(result.order?.tax ?? 0).toBeGreaterThan(0);
    // The exact selection is kept, with the price after any discounts.
    const [instance] = await db.select().from(schema.packageInstances).where(eq(schema.packageInstances.documentId, result.order?.id ?? ''));
    expect(instance).toMatchObject({ documentType: 'order', lineNo: 1, packageName: 'Express lunch order test', servings: 3, forDate: null });
    expect(Number(instance?.lineTotal)).toBeCloseTo(810 * 3, 2);
    expect(Number(instance?.servingPrice)).toBeCloseTo(810, 2);
    const picks = await db.select().from(schema.packageInstancePicks).where(eq(schema.packageInstancePicks.instanceId, instance?.id ?? '')).orderBy(asc(schema.packageInstancePicks.sortOrder));
    expect(picks.map((x) => [x.slotName, x.productName])).toEqual([['Fish', 'Large fish'], ['Starch', 'Brown ugali'], ['Vegetables', 'Sukuma'], ['Vegetables', 'Cabbage']]);
  });

  it('keeps two lines of one package apart, and folds a part also bought on its own', async () => {
    const { p, pick } = await lunch();
    const result = await order([
      { productId: p.lunch, quantity: 1, package: { picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] } },
      { productId: p.lunch, quantity: 2, package: { picks: [pick(0, p.large), pick(1, p.ugali), pick(2, p.sukuma)] } },
      { productId: p.small, quantity: 1 },
    ]);
    expect(result.success).toBe(true);
    const fish = (result.order?.items ?? []).filter((i) => i.productId === p.small);
    expect(fish).toHaveLength(1);
    expect(fish[0]?.quantity).toBe(2);
    const instances = await db.select().from(schema.packageInstances).where(eq(schema.packageInstances.documentId, result.order?.id ?? '')).orderBy(asc(schema.packageInstances.lineNo));
    expect(instances.map((i) => [i.lineNo, i.servings])).toEqual([[1, 1], [2, 2]]);
    expect(Number((await stockOf(p.ugali))?.reservedQuantity)).toBe(3);
  });

  it('refuses a choice from another package, a missing slot, a bad count and a package that is not one, and holds nothing', async () => {
    const a = await lunch();
    const b = await lunch();
    const bad = [
      [{ productId: a.p.lunch, quantity: 1, package: { picks: [a.pick(0, a.p.small), a.pick(1, a.p.ugali), b.pick(2, b.p.sukuma)] } }],
      [{ productId: a.p.lunch, quantity: 1, package: { picks: [a.pick(0, a.p.small), a.pick(2, a.p.sukuma)] } }],
      [{ productId: a.p.lunch, quantity: 1, package: { picks: [{ ...a.pick(0, a.p.small), count: -1 }, a.pick(1, a.p.ugali), a.pick(2, a.p.sukuma)] } }],
      [{ productId: a.p.small, quantity: 1, package: { picks: [] } }],
    ];
    for (const items of bad) expect((await order(items)).success).toBe(false);
    expect(Number((await stockOf(a.p.small))?.reservedQuantity)).toBe(0);
  });

  it('refuses servings the stock of a part cannot cover, naming the part', async () => {
    const { p, pick } = await lunch();
    const result = await order([{ productId: p.lunch, quantity: 25, package: { picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] } }]);
    expect(result).toMatchObject({ success: false, code: 'stock_short' });
    expect(result.error).toContain('Small fish');
  });

  it('refuses a choice that would sell below what its parts cost', async () => {
    const { p, pick } = await lunch();
    await db.update(schema.products).set({ price: '100' }).where(eq(schema.products.id, p.lunch));
    const result = await order([{ productId: p.lunch, quantity: 1, package: { picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] } }]);
    expect(result).toMatchObject({ success: false, code: 'approval_needed' });
    expect(result.error).toContain('less than its parts cost');
  });

  it('holds the rules of ordering: servings, who may order, the date and notice, the days of the week', async () => {
    const { p, pick } = await lunch({ minServings: 5, maxServings: 8 });
    const items = (n: number) => [{ productId: p.lunch, quantity: n, package: { picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] } }];
    expect((await order(items(2))).error).toContain('at least 5');
    expect((await order(items(9))).error).toContain('at most 8');
    expect((await order(items(5))).success).toBe(true);

    const signed = await lunch({ audience: 'signed_in' });
    const guest = await order([{ productId: signed.p.lunch, quantity: 1, package: { picks: [signed.pick(0, signed.p.small), signed.pick(1, signed.p.ugali), signed.pick(2, signed.p.sukuma)] } }]);
    expect(guest).toMatchObject({ success: false, code: 'package_rule' });
    expect(guest.error).toContain('signed-in');

    const dated = await lunch({ noticeMinutes: 48 * 60, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    const one = (date?: string) => order([{ productId: dated.p.lunch, quantity: 1, package: { picks: [dated.pick(0, dated.p.small), dated.pick(1, dated.p.ugali), dated.pick(2, dated.p.sukuma)] } }], date === undefined ? {} : { fulfilmentDate: date });
    expect((await one()).error).toContain('choose the date');
    expect((await one(day(1))).error).toContain('notice');
    expect((await one('not-a-date')).success).toBe(false);
    expect((await one(day(5))).success).toBe(true);
  });

  it('never promises more servings for a day than the daily limit, even when two orders arrive at the same moment', async () => {
    const { p, pick } = await lunch({ dailyLimit: 5 });
    const date = day(10);
    const mine = () => order([{ productId: p.lunch, quantity: 3, package: { picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] } }], { fulfilmentDate: date });
    const results = await Promise.all([mine(), mine()]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    const refused = results.find((r) => !r.success);
    expect(refused?.error).toMatch(/Only 2 servings left|fully booked/);
    // The refused order left no stock held: 3 of each part for the one that went through.
    expect(Number((await stockOf(p.small))?.reservedQuantity)).toBe(3);
    const small = await order([{ productId: p.lunch, quantity: 2, package: { picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] } }], { fulfilmentDate: date });
    expect(small.success).toBe(true);
    expect((await order([{ productId: p.lunch, quantity: 1, package: { picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] } }], { fulfilmentDate: date })).error).toContain('fully booked');
  });

  it('saves and reads back the rules and the groups a package is limited to', async () => {
    const { p } = await lunch({ dailyLimit: 12, weekdays: [3, 1], closesDaysBefore: 1, closesAtMinute: 600 });
    const [view] = await c.packageConfig.list(companyId, p.lunch);
    expect(view?.rules).toMatchObject({ dailyLimit: 12, weekdays: [1, 3], closesDaysBefore: 1, closesAtMinute: 600, audience: 'anyone', groupIds: [] });
    await expect(lunch({ minServings: 9, maxServings: 3 })).rejects.toThrow(/fewest servings/);
    await expect(lunch({ audience: 'groups', groupIds: [] })).rejects.toThrow(/customer group/);
    await expect(lunch({ audience: 'groups', groupIds: [randomUUID()] })).rejects.toThrow(/does not exist/);
  });
});
