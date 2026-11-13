import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { OrderWriteService } from '@/server/domains/orders/write-service';

/**
 * The preparation sheet against a real database: what is read comes from the saved selections of orders that still stand.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('the preparation sheet (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let write: typeof OrderWriteService;
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;
  const actor = { type: 'user' as const, id: 'preparation-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `PP-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `PPS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Prep part ${randomUUID().slice(0, 4)}`,
      slug: `pp-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '0',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 200,
      ...over,
    });
    return id;
  };

  const lunch = async () => {
    const p = {
      lunch: await product({ name: 'Prep lunch', price: '650', inventoryKind: 'non_inventory', stockQuantity: 0 }),
      small: await product({ name: 'Prep small fish', price: '300', costPrice: '100' }),
      large: await product({ name: 'Prep large fish', price: '420', costPrice: '150' }),
      ugali: await product({ name: 'Prep ugali', price: '50', costPrice: '10', soldOnlyInPackages: true, showOnWebShop: false }),
    };
    const view = await c.packageConfig.save(
      companyId,
      {
        productId: p.lunch,
        pricingMode: 'base_plus_differences',
        allocation: 'list_price',
        shortStockMode: 'hide',
        slots: [
          { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.small, quantity: 1 }, { productId: p.large, quantity: 1, difference: 120 }] },
          { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: p.ugali, quantity: 2 }] },
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

  const order = async (productId: string, servings: number, picks: unknown[], date?: string) => {
    const result = await write.createOrder({
      branchId,
      orderNumber: `PRP-${randomUUID()}`,
      customerName: 'Prep Buyer',
      customerEmail: `prp-${randomUUID()}@pkg.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: servings, package: { picks } }] as never,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      ...(date === undefined ? {} : { fulfilmentDate: date }),
    });
    if (!result.success || result.order === undefined) throw new Error(result.error ?? 'refused');
    return result.order;
  };
  /** A day no other run has used (the database is shared), far enough ahead to pass every notice rule. */
  const freshDay = () => day(60 + Math.floor(Math.random() * 20_000));
  const day = (ahead: number) => new Date(Date.now() + ahead * 86_400_000 + 3 * 3_600_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    write = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pp_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Preparation Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
  });

  it('lists what each order chose and totals the servings, portions and units for the day', async () => {
    const { p, pick } = await lunch();
    const date = freshDay();
    const a = await order(p.lunch, 3, [pick(0, p.large), pick(1, p.ugali)], date);
    const b = await order(p.lunch, 9, [pick(0, p.small), pick(1, p.ugali)], date);
    await order(p.lunch, 5, [pick(0, p.small), pick(1, p.ugali)], day(30 + Math.floor(Math.random() * 20_000)));
    const view = await c.preparation.forDay(companyId, date, day(0));
    const mine = view.sheet.groups.flatMap((g) => g.packages).filter((x) => x.packageProductId === p.lunch);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.servings).toBe(12);
    expect(mine[0]?.selections.map((s) => [s.orderNumber, s.servings, s.words]).sort()).toEqual(
      [[a.orderNumber, 3, 'Prep large fish and Prep ugali'], [b.orderNumber, 9, 'Prep small fish and Prep ugali']].sort(),
    );
    const part = (id: string) => view.sheet.totals.parts.find((x) => x.productId === id);
    expect(part(p.large)).toMatchObject({ portions: 3, units: 3 });
    expect(part(p.small)).toMatchObject({ portions: 9, units: 9 });
    // Two units of ugali in each serving.
    expect(part(p.ugali)).toMatchObject({ portions: 12, units: 24 });
    expect(view.truncated).toBe(false);
  });

  it('leaves out a cancelled order and gives the day back when everything is cancelled', async () => {
    const { p, pick } = await lunch();
    const date = freshDay();
    const kept = await order(p.lunch, 2, [pick(0, p.small), pick(1, p.ugali)], date);
    const gone = await order(p.lunch, 4, [pick(0, p.large), pick(1, p.ugali)], date);
    const { OrderStages } = await import('@/server/domains/orders/stages');
    await OrderStages.move(db, gone.id, 'cancelled', 'cancelled', { source: 'staff', reasonCode: 'cancelled', message: 'Customer asked', checkHold: true });
    const view = await c.preparation.forDay(companyId, date, day(0));
    const pkg = view.sheet.groups.flatMap((g) => g.packages).find((x) => x.packageProductId === p.lunch);
    expect(pkg?.selections.map((s) => s.orderNumber)).toEqual([kept.orderNumber]);
    expect(view.sheet.totals.parts.find((x) => x.productId === p.large)).toBeUndefined();
  });

  it('shows orders that have no date apart, and lists the coming days that have orders', async () => {
    const { p, pick } = await lunch();
    const undated = await order(p.lunch, 1, [pick(0, p.small), pick(1, p.ugali)]);
    const date = freshDay();
    await order(p.lunch, 6, [pick(0, p.small), pick(1, p.ugali)], date);
    const none = await c.preparation.forDay(companyId, null, day(0));
    expect(none.sheet.groups.flatMap((g) => g.packages).flatMap((x) => x.selections).some((s) => s.orderNumber === undated.orderNumber)).toBe(true);
    const days = (await c.preparation.forDay(companyId, date, date)).days;
    expect(days.find((d) => d.date === date)).toMatchObject({ orders: 1, servings: 6 });
    // Days before the one asked from are not listed.
    expect(days.every((d) => d.date >= date)).toBe(true);
  });

  it('is scoped to the company', async () => {
    const { p, pick } = await lunch();
    const date = freshDay();
    await order(p.lunch, 2, [pick(0, p.small), pick(1, p.ugali)], date);
    const other = await c.preparation.forDay(randomUUID(), date, day(0));
    expect(other.sheet.groups).toEqual([]);
    expect(other.days).toEqual([]);
  });
});
