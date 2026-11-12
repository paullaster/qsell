import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * Products sold only inside packages (docs/architecture/configurable-packages.md section 4), against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('products sold only inside packages (database)', () => {
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let itemTypeId: string;
  let branchId: string;

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    const token = randomUUID().slice(0, 8);
    await db.insert(schema.products).values({
      id,
      sku: `PO-${token}`.toUpperCase(),
      stockCode: `POS-${token}`.toUpperCase(),
      name: `Part ${token}`,
      slug: `part-${randomUUID()}`,
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
  const row = async (id: string) => (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0]!;

  beforeAll(async () => {
    const { getContainer } = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    const c = getContainer();
    const company = await c.companySettings.ensureSeeded();
    itemTypeId = `it_po_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(company.id, 'Package Test Co');
    branchId = ((await c.branches.getDefault(company.id)) ?? branch).id;
  });

  it('refuses, in the database, a package-only product that is shown in the web shop or is checkout packaging', async () => {
    await expect(product({ soldOnlyInPackages: true, showOnWebShop: true })).rejects.toThrow();
    await expect(product({ soldOnlyInPackages: true, showOnWebShop: false, isCheckoutPackaging: true })).rejects.toThrow();
    const id = await product({ soldOnlyInPackages: true, showOnWebShop: false });
    expect((await row(id)).soldOnlyInPackages).toBe(true);
  });

  it('keeps a package-only product out of every shop read, and an ordinary one in', async () => {
    const { CatalogService } = await import('./service');
    const { StorefrontCatalog } = await import('./storefront-service');
    const hiddenId = await product({ soldOnlyInPackages: true, showOnWebShop: false });
    const shownId = await product();
    const hidden = await row(hiddenId);
    expect(await CatalogService.getPublicProductByKey(hidden.slug)).toBeUndefined();
    expect(await CatalogService.getPublicProduct(hiddenId)).toBeUndefined();
    expect((await CatalogService.getPublicProductByKey((await row(shownId)).slug))?.id).toBe(shownId);
    expect((await StorefrontCatalog.productsByIds([hiddenId, shownId])).map((p) => p.id)).toEqual([shownId]);
    // Admin and stock still see it: it is real inventory.
    expect((await CatalogService.getProductById(hiddenId))?.soldOnlyInPackages).toBe(true);
    expect((await CatalogService.getSellableProducts()).map((p) => p.id)).not.toContain(hiddenId);
  });

  it('turning the flag on takes the product off the shop in the same save; checkout packaging cannot take it', async () => {
    const { CatalogService } = await import('./service');
    const id = await product();
    const saved = await CatalogService.updateProduct(id, { soldOnlyInPackages: true });
    expect(saved).toMatchObject({ soldOnlyInPackages: true, showOnWebShop: false });
    expect(await row(id)).toMatchObject({ soldOnlyInPackages: true, showOnWebShop: false });
    await expect(CatalogService.updateProduct(id, { isCheckoutPackaging: true })).rejects.toThrow(/both checkout packaging and sold only inside packages/);
    // Turning it off again does not put it back in the shop by itself.
    await CatalogService.updateProduct(id, { soldOnlyInPackages: false });
    expect(await row(id)).toMatchObject({ soldOnlyInPackages: false, showOnWebShop: false });
  });

  it('refuses a package-only product as a line of its own, in every kind of order, and names it', async () => {
    const { OrderWriteService } = await import('@/server/domains/orders/write-service');
    const id = await product({ soldOnlyInPackages: true, showOnWebShop: false, name: 'Brown ugali test part' });
    for (const salesModule of ['ecommerce', 'sales_order'] as const) {
      const result = await OrderWriteService.createOrder({
        branchId,
        orderNumber: `PO-${randomUUID()}`,
        customerName: 'Buyer',
        customerEmail: `po-${randomUUID()}@pkg.test`,
        customerPhone: '0700000000',
        shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
        items: [{ productId: id, quantity: 1 }],
        currency: 'KES',
        paymentMethod: 'mpesa_daraja' as never,
        salesModule,
      });
      expect(result).toMatchObject({ success: false, code: 'not_for_sale' });
      expect(JSON.stringify(result)).toContain('Brown ugali test part is sold only as part of a package');
    }
    // Nothing was held for the refused order.
    expect(Number((await row(id)).reservedQuantity)).toBe(0);
  });
});
