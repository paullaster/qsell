import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * Configurable packages: defining, changing and removing them, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * The database is shared, so every rule is limited to products made by the test.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('configurable packages (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let companyId: string;
  let itemTypeId: string;
  const actor = { type: 'user' as const, id: 'package-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `PK-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `PKS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Pkg product ${randomUUID().slice(0, 4)}`,
      slug: `pkg-${randomUUID()}`,
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

  /** The express lunch from the design: a base price of 650, fish in three sizes, a starch, vegetables. */
  const lunchParts = async () => ({
    lunch: await product({ price: '650', costPrice: '0' }),
    small: await product({ price: '300', costPrice: '150' }),
    medium: await product({ price: '400', costPrice: '200' }),
    ugali: await product({ price: '50', costPrice: '20', soldOnlyInPackages: true, showOnWebShop: false }),
    brown: await product({ price: '80', costPrice: '35', soldOnlyInPackages: true, showOnWebShop: false }),
    sukuma: await product({ price: '40', costPrice: '15' }),
    cabbage: await product({ price: '40', costPrice: '15' }),
  });
  const lunchInput = (p: Awaited<ReturnType<typeof lunchParts>>, over: Record<string, unknown> = {}) => ({
    productId: p.lunch,
    pricingMode: 'base_plus_differences' as const,
    allocation: 'list_price' as const,
    shortStockMode: 'hide' as const,
    slots: [
      { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.small }, { productId: p.medium, difference: 100, isDefault: true }].map((o) => ({ quantity: 1, ...o })) },
      { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: p.ugali, isDefault: true }, { productId: p.brown, difference: 30 }].map((o) => ({ quantity: 1, ...o })) },
      { name: 'Vegetables', minPicks: 1, maxPicks: 2, options: [{ productId: p.sukuma }, { productId: p.cabbage }].map((o) => ({ quantity: 1, ...o })) },
    ],
    ...over,
  });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pkg_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  it('makes a package, shows the from price and what is in it, and logs it', async () => {
    const p = await lunchParts();
    const view = await c.packageConfig.save(companyId, lunchInput(p), actor, reason);
    expect(view).toMatchObject({ productId: p.lunch, pricingMode: 'base_plus_differences', shortStockMode: 'hide', version: 1, isActive: true, unavailableOptions: 0 });
    expect(view.slots.map((s) => s.name)).toEqual(['Fish', 'Starch', 'Vegetables']);
    expect(view.slots[1]?.options.map((o) => o.name).length).toBe(2);
    // The cheapest valid selection: the first fish (no difference), ugali, one vegetable.
    expect(view.from).toMatchObject({ price: 650, cost: 150 + 20 + 15, belowCost: false });
    const log = await c.decisionLog.timeline('product_package', view.id);
    expect(log.map((l) => l.action)).toContain('pricing.package_created');
  });

  it('changing a package keeps one package, raises its version, and replaces its slots', async () => {
    const p = await lunchParts();
    const first = await c.packageConfig.save(companyId, lunchInput(p), actor, reason);
    const second = await c.packageConfig.save(companyId, lunchInput(p, { slots: lunchInput(p).slots.slice(0, 1), shortStockMode: 'substitute' }), actor, reason);
    expect(second).toMatchObject({ id: first.id, version: 2, shortStockMode: 'substitute' });
    expect(second.slots).toHaveLength(1);
    expect((await c.packageConfig.list(companyId)).filter((x) => x.productId === p.lunch)).toHaveLength(1);
    expect((await c.decisionLog.timeline('product_package', first.id)).map((l) => l.action)).toContain('pricing.package_changed');
  });

  it('flags a package whose cheapest selection sells below cost, and counts options that can no longer be chosen', async () => {
    const p = await lunchParts();
    await db.update(schema.products).set({ price: '100' }).where(eq(schema.products.id, p.lunch));
    const view = await c.packageConfig.save(companyId, lunchInput(p), actor, reason);
    expect(view.from).toMatchObject({ price: 100, belowCost: true });
    await db.update(schema.products).set({ isActive: false }).where(eq(schema.products.id, p.brown));
    const after = (await c.packageConfig.list(companyId, p.lunch))[0];
    expect(after?.unavailableOptions).toBe(1);
  });

  it('prices each option on its own in summed mode, using a fixed price when one is given', async () => {
    const p = await lunchParts();
    const input = lunchInput(p, { pricingMode: 'summed' as const });
    input.slots[0]!.options[0] = { productId: p.small, quantity: 1, ownPrice: 280 } as never;
    const view = await c.packageConfig.save(companyId, input, actor, reason);
    // Cheapest: small fish (fixed 280) + ugali (50) + sukuma (40).
    expect(view.from.price).toBe(370);
  });

  it('refuses what the rules refuse, in plain words, and saves nothing', async () => {
    const p = await lunchParts();
    const fails = async (input: ReturnType<typeof lunchInput>, expected: RegExp) => {
      await expect(c.packageConfig.save(companyId, input, actor, reason)).rejects.toThrow(expected);
    };
    await fails(lunchInput(p, { slots: [] }), /at least one slot/);
    await fails(lunchInput(p, { productId: p.ugali }), /sold only inside packages/);
    const selfSlot = lunchInput(p);
    selfSlot.slots[0]!.options.push({ productId: p.lunch, quantity: 1 } as never);
    await fails(selfSlot, /cannot contain itself/);
    const twice = lunchInput(p);
    twice.slots[0]!.options.push({ productId: p.small, quantity: 1 } as never);
    await fails(twice, /listed twice/);
    const unsold = await product({ isSellable: false });
    const withUnsold = lunchInput(p);
    withUnsold.slots[0]!.options.push({ productId: unsold, quantity: 1 } as never);
    await fails(withUnsold, /not sold to customers/);
    await fails(lunchInput(p, { shortStockMode: 'nope' as never }), /out of stock/);
    expect((await c.packageConfig.list(companyId, p.lunch))).toEqual([]);
  });

  it('keeps packages, kits and options apart', async () => {
    const p = await lunchParts();
    await c.packageConfig.save(companyId, lunchInput(p), actor, reason);
    // An option of a package cannot itself be made a package.
    await expect(c.packageConfig.save(companyId, { ...lunchInput(p), productId: p.small }, actor, reason)).rejects.toThrow(/option of another package/);
    // A package cannot be offered inside another package.
    const other = await lunchParts();
    const inside = lunchInput(other);
    inside.slots[0]!.options.push({ productId: p.lunch, quantity: 1 } as never);
    await expect(c.packageConfig.save(companyId, inside, actor, reason)).rejects.toThrow(/another package or a kit/);
    // A kit cannot be an option, and a kit product cannot be a package.
    const kitProduct = await product();
    await c.kitConfig.save(companyId, { productId: kitProduct, allocation: 'list_price', components: [{ productId: other.sukuma, quantity: 1 }] }, actor, reason);
    const withKit = lunchInput(other);
    withKit.slots[0]!.options.push({ productId: kitProduct, quantity: 1 } as never);
    await expect(c.packageConfig.save(companyId, withKit, actor, reason)).rejects.toThrow(/another package or a kit/);
    await expect(c.packageConfig.save(companyId, { ...lunchInput(other), productId: kitProduct }, actor, reason)).rejects.toThrow(/is a kit/);
  });

  it('protects an option product from deletion while a package offers it, and removing the package frees it', async () => {
    const p = await lunchParts();
    await c.packageConfig.save(companyId, lunchInput(p), actor, reason);
    await expect(db.delete(schema.products).where(eq(schema.products.id, p.small))).rejects.toThrow();
    await c.packageConfig.remove(companyId, p.lunch, actor, reason);
    expect(await c.packageConfig.list(companyId, p.lunch)).toEqual([]);
    expect((await db.select().from(schema.packageOptions).where(eq(schema.packageOptions.productId, p.small))).length).toBe(0);
    await expect(c.packageConfig.remove(companyId, p.lunch, actor, reason)).rejects.toThrow(/not a package/);
  });

  it('warns in Pricing Insights about a package that can be chosen below cost and about an option that cannot be chosen', async () => {
    const p = await lunchParts();
    await db.update(schema.products).set({ price: '100' }).where(eq(schema.products.id, p.lunch));
    const view = await c.packageConfig.save(companyId, lunchInput(p), actor, reason);
    await db.update(schema.products).set({ isActive: false }).where(eq(schema.products.id, p.cabbage));
    const findings = await c.insights.findings(companyId);
    const below = findings.find((f) => f.code === 'package_below_cost');
    expect(below?.examples?.some((e) => e.startsWith(view.productName))).toBe(true);
    expect(below?.href).toBe('/admin/pricing/packages');
    expect(findings.find((f) => f.code === 'package_option_off')?.examples?.some((e) => e.startsWith(view.productName))).toBe(true);
  });

  it('refuses a missing or unknown reason', async () => {
    const p = await lunchParts();
    await expect(c.packageConfig.save(companyId, lunchInput(p), actor, { code: '' })).rejects.toThrow();
  });
});
