import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * What the web shop shows and checks for configurable packages, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * The database is shared, so every rule is limited to products made by the test.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('package shop (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let companyId: string;
  let itemTypeId: string;
  const actor = { type: 'user' as const, id: 'package-shop-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const made: string[] = [];

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `PS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `PSS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Shop product ${randomUUID().slice(0, 4)}`,
      slug: `ps-${randomUUID()}`,
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

  const lunch = async (mode: 'hide' | 'disable' | 'substitute' = 'hide', ugaliOver: Record<string, unknown> = {}) => {
    const p = {
      lunch: await product({ price: '650', costPrice: '0', inventoryKind: 'non_inventory', stockQuantity: 0 }),
      small: await product({ name: 'Small fish', price: '300', costPrice: '150' }),
      medium: await product({ name: 'Medium fish', price: '400', costPrice: '200' }),
      ugali: await product({ name: 'Ugali', price: '50', costPrice: '20', soldOnlyInPackages: true, showOnWebShop: false, stockQuantity: 5, ...ugaliOver }),
      brown: await product({ name: 'Brown ugali', price: '80', costPrice: '35', soldOnlyInPackages: true, showOnWebShop: false, stockQuantity: 2 }),
      sukuma: await product({ name: 'Sukuma', price: '40', costPrice: '15' }),
      cabbage: await product({ name: 'Cabbage', price: '40', costPrice: '15' }),
    };
    const view = await c.packageConfig.save(
      companyId,
      {
        productId: p.lunch,
        pricingMode: 'base_plus_differences',
        allocation: 'list_price',
        shortStockMode: mode,
        slots: [
          { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.small, quantity: 1 }, { productId: p.medium, quantity: 1, difference: 100, isDefault: true }] },
          { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: p.ugali, quantity: 1, isDefault: true }, { productId: p.brown, quantity: 1, difference: 30 }] },
          { name: 'Vegetables', minPicks: 1, maxPicks: 2, options: [{ productId: p.sukuma, quantity: 1 }, { productId: p.cabbage, quantity: 1, difference: 10 }] },
        ],
      },
      actor,
      reason,
    );
    made.push(p.lunch);
    const optionId = (slot: number, productId: string): string => {
      const found = view.slots[slot]?.options.find((o) => o.productId === productId);
      if (found === undefined) throw new Error('option missing');
      return found.id;
    };
    const pick = (slot: number, productId: string, count = 1) => ({ slotId: view.slots[slot]?.id ?? '', optionId: optionId(slot, productId), count });
    return { p, view, optionId, pick };
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_ps_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  // The database is shared with the other package tests (Insights lists examples), so what is made here is taken away again.
  afterAll(async () => {
    for (const productId of made) await c.packageConfig.remove(companyId, productId, actor, reason).catch(() => undefined);
  });

  it('offers a package with names and prices but no cost, stock count or supplier', async () => {
    const { p } = await lunch();
    const builder = await c.packageShop.builder(companyId, p.lunch);
    expect(builder?.offered).toBe(true);
    expect(builder?.package).toMatchObject({ basePrice: 650, pricingMode: 'base_plus_differences' });
    expect(builder?.package.slots.map((s) => s.name)).toEqual(['Fish', 'Starch', 'Vegetables']);
    // No field named for cost, a stock count, reserved stock or a supplier travels to the browser.
    expect(JSON.stringify(builder)).not.toMatch(/"(cost\w*|stock|stockQuantity|reserved\w*|supplier\w*)"/i);
    expect(builder?.available).toHaveLength(6);
  });

  it('offers nothing for an ordinary product, another company, a switched-off package or a product not sold on the web', async () => {
    const { p } = await lunch();
    expect(await c.packageShop.builder(companyId, p.small)).toBeNull();
    expect(await c.packageShop.builder(randomUUID(), p.lunch)).toBeNull();
    await db.update(schema.products).set({ showOnWebShop: false }).where(eq(schema.products.id, p.lunch));
    expect(await c.packageShop.builder(companyId, p.lunch)).toBeNull();
    await db.update(schema.products).set({ showOnWebShop: true }).where(eq(schema.products.id, p.lunch));
    expect(await c.packageShop.builder(companyId, p.lunch)).not.toBeNull();
    await db.update(schema.productPackages).set({ isActive: false }).where(eq(schema.productPackages.productId, p.lunch));
    expect(await c.packageShop.builder(companyId, p.lunch)).toBeNull();
  });

  it('leaves out options that were switched off or deleted', async () => {
    const { p } = await lunch();
    await db.update(schema.products).set({ isActive: false }).where(eq(schema.products.id, p.cabbage));
    const builder = await c.packageShop.builder(companyId, p.lunch);
    expect(builder?.package.slots[2]?.options.map((o) => o.name)).toEqual(['Sukuma']);
  });

  it('works out which options have stock for this many servings, and when the package cannot be offered', async () => {
    const { p, optionId } = await lunch();
    const one = await c.packageShop.builder(companyId, p.lunch, 1);
    expect(one?.available).toContain(optionId(1, p.brown));
    // Only two brown ugali: three servings cannot have it, four ugali are still fine (five in stock).
    const three = await c.packageShop.builder(companyId, p.lunch, 3);
    expect(three?.available).not.toContain(optionId(1, p.brown));
    expect(three?.available).toContain(optionId(1, p.ugali));
    expect(three?.offered).toBe(true);
    // Every starch short: a required slot with nothing to choose, so the package is not offered.
    const six = await c.packageShop.builder(companyId, p.lunch, 6);
    expect(six?.offered).toBe(false);
  });

  it('prices a basket line from the database and ignores anything the browser says about price', async () => {
    const { p, pick } = await lunch();
    const [line] = await c.packageShop.basket(companyId, [{ productId: p.lunch, servings: 2, picks: [pick(0, p.medium), pick(1, p.brown), pick(2, p.sukuma), pick(2, p.cabbage)] }]);
    expect(line).toMatchObject({ ok: true, servingPrice: 650 + 100 + 30 + 10, total: 2 * 790 });
    expect(line?.ok === true && line.summary).toContain('Medium fish, Brown ugali, Sukuma and Cabbage');
  });

  it('refuses a choice from another package, a missing slot, a package that is gone and an ordinary product', async () => {
    const a = await lunch();
    const b = await lunch();
    const foreign = await c.packageShop.basket(companyId, [{ productId: a.p.lunch, servings: 1, picks: [a.pick(0, a.p.small), a.pick(1, a.p.ugali), b.pick(2, b.p.sukuma)] }]);
    expect(foreign[0]).toMatchObject({ ok: false });
    const missing = await c.packageShop.basket(companyId, [{ productId: a.p.lunch, servings: 1, picks: [a.pick(0, a.p.small), a.pick(2, a.p.sukuma)] }]);
    expect(missing[0]).toMatchObject({ ok: false });
    const gone = await c.packageShop.basket(companyId, [{ productId: a.p.small, servings: 1, picks: [] }]);
    expect(gone[0]).toEqual({ ok: false, problems: ['This package is not available any more.'] });
  });

  it('lets two lines of one basket share stock only once: the second sees what the first took', async () => {
    const { p, pick } = await lunch();
    const brown = { productId: p.lunch, servings: 1, picks: [pick(0, p.small), pick(1, p.brown), pick(2, p.sukuma)] };
    const [first, second, third] = await c.packageShop.basket(companyId, [brown, { ...brown, picks: [pick(0, p.medium), pick(1, p.brown), pick(2, p.sukuma)] }, { ...brown, picks: [pick(0, p.small), pick(1, p.brown), pick(2, p.cabbage)] }]);
    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    // Two brown ugali in stock, both taken.
    expect(third).toMatchObject({ ok: false });
    expect(third?.ok === false && third.problems[0]).toContain('Brown ugali');
  });

  it('refuses servings out of range and a basket of more than twenty lines is clipped', async () => {
    const { p, pick } = await lunch();
    const picks = [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)];
    for (const servings of [0, -2, 1.5, 100_000]) {
      expect((await c.packageShop.basket(companyId, [{ productId: p.lunch, servings, picks }]))[0]).toMatchObject({ ok: false });
    }
    const many = await c.packageShop.basket(companyId, Array.from({ length: 30 }, () => ({ productId: p.lunch, servings: 1, picks })));
    expect(many).toHaveLength(20);
  });

  it('does not count a service or a non-stock option as running out', async () => {
    const { p, pick } = await lunch('hide', { inventoryKind: 'non_inventory', stockQuantity: 0 });
    const [line] = await c.packageShop.basket(companyId, [{ productId: p.lunch, servings: 10, picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] }]);
    expect(line?.ok).toBe(true);
  });

  it('counts the places that sell to the web shop when stock is kept by place', async () => {
    const { p, pick } = await lunch();
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    try {
      const [line] = await c.packageShop.basket(companyId, [{ productId: p.lunch, servings: 1, picks: [pick(0, p.small), pick(1, p.ugali), pick(2, p.sukuma)] }]);
      // No place holds any of it: the counters on the product are not the truth in this mode.
      expect(line).toMatchObject({ ok: false });
    } finally {
      await c.stockSettings.setLedgerMode(companyId, false);
    }
  });

  it('flags a package product in the shop so it is never added as it stands, and keeps ordinary products as they are', async () => {
    const { p } = await lunch();
    const { withShopAvailability } = await import('@/server/domains/catalog/shop-availability');
    const { CatalogService } = await import('@/server/domains/catalog/service');
    const pkg = await CatalogService.getPublicProductByKey(p.lunch);
    const plain = await CatalogService.getPublicProductByKey(p.small);
    if (pkg === undefined || plain === undefined) throw new Error('products missing');
    const [shownPackage, shownPlain] = await withShopAvailability([pkg, plain]);
    expect(shownPackage).toMatchObject({ isPackage: true, inventoryKind: 'non_inventory' });
    expect(shownPlain?.isPackage).toBeUndefined();
  });
});
