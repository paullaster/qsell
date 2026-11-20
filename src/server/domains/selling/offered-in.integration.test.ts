import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type * as sourcesModule from '@/server/domains/lookups/sources';
import type * as requestModule from '@/server/domains/lookups/request';
import { parseCount } from './shifts/shift-rules';

/**
 * Where a product is offered, by selling document (database): a staff document refuses a product that is not offered in it, the pickers
 * leave it out, a quote refuses it, and an order made from a quote is not asked again.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('where it is offered (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let sources: typeof sourcesModule;
  let request: typeof requestModule;
  let companyId: string;
  let itemTypeId: string;
  let customerId: string;
  const actor = { type: 'user' as const, id: 'offered-test' };

  const product = async (offeredIn: string[] | undefined) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `OF-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `OFS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Offered ${randomUUID().slice(0, 6)}`, slug: `of-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100, ...(offeredIn === undefined ? {} : { offeredIn }) });
    const [row] = await db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, id));
    return { id, name: row?.name ?? '' };
  };
  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@of.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const placeAs = async (kind: 'sales_order' | 'sales_invoice' | 'credit_sale', productId: string, person: { id: string }) =>
    await c.salesOrders.place(companyId, { userId: person.id, branchId: null }, { customerId, lines: [{ productId, quantity: 1 }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false }, kind);
  const search = async (key: string, query: string) => {
    const parsed = request.parseLookupRequest({ source: key, query, filters: {} });
    if (!parsed.ok) throw new Error(parsed.error);
    const source = sources.getLookupSource(key);
    if (source === undefined) throw new Error(`no source ${key}`);
    return (await source.search({ companyId, query: parsed.value.query, limit: parsed.value.limit, after: parsed.value.after, filters: parsed.value.filters })).options.map((o) => o.id);
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    sources = await import('@/server/domains/lookups/sources');
    request = await import('@/server/domains/lookups/request');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_of_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Offered Co');
    const [customer] = await db.insert(schema.customers).values({ companyId, number: `OFC-${randomUUID().slice(0, 8)}`, name: 'Offered Buyer', email: `ob-${randomUUID().slice(0, 6)}@of.test`, phone: '0711000222', accountType: 'credit', creditLimit: '100000', paymentTermDays: 30 } as never).returning();
    customerId = customer?.id ?? '';
  });

  it('offers a product everywhere unless it says otherwise', async () => {
    const everywhere = await product(undefined);
    const person = await user('everywhere');
    for (const kind of ['sales_order', 'sales_invoice', 'credit_sale'] as const) expect((await placeAs(kind, everywhere.id, person)).ok).toBe(true);
  });

  it('refuses a product in the documents it is not offered in, naming the document, and sells it where it is', async () => {
    const quoteAndOrder = await product(['quote', 'sales_order']);
    const person = await user('refuser');
    expect((await placeAs('sales_order', quoteAndOrder.id, person)).ok).toBe(true);
    const invoice = await placeAs('sales_invoice', quoteAndOrder.id, person);
    expect(invoice.ok ? '' : invoice.error).toBe(`${quoteAndOrder.name} is not offered in sales invoices. Change where it is offered on the product.`);
    const credit = await placeAs('credit_sale', quoteAndOrder.id, person);
    expect(credit.ok ? '' : credit.error).toContain('not offered in credit sales');
    // An order on account is a credit sale whatever it is taken as.
    const onAccount = await c.salesOrders.place(companyId, { userId: person.id, branchId: null }, { customerId, lines: [{ productId: quoteAndOrder.id, quantity: 1 }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false }, 'credit_sale');
    expect(onAccount.ok).toBe(false);
  });

  it('refuses it at the counter too, before any sale is made', async () => {
    const notAtCounter = await product(['sales_order']);
    const person = await user('counter');
    const name = `OF till ${randomUUID().slice(0, 6)}`;
    const branchId = ((await c.branches.getDefault(companyId)) ?? { id: '' }).id;
    await c.shifts.saveRegister(companyId, actor, { branchId, name, isActive: true }, { code: 'POLICY_CHANGE' });
    const till = (await c.shifts.registerList(companyId)).find((r) => r.name === name);
    const float = parseCount({ total: 0 }, 'float');
    if (!float.ok) throw new Error(float.error);
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId: till?.id ?? '', float });
    expect(opened.ok).toBe(true);
    const [cashMethod] = await db.select({ id: schema.paymentMethods.id }).from(schema.paymentMethods).where(eq(schema.paymentMethods.kind, 'cash')).limit(1);
    const sold = await c.cashSales.complete(companyId, { userId: person.id, branchId: null }, { customerId: null, lines: [{ productId: notAtCounter.id, quantity: 1 }], tenders: [{ methodId: cashMethod?.id ?? randomUUID(), amount: 100, reference: '' }], saleKey: randomUUID() });
    expect(sold.ok ? '' : sold.error).not.toBe('');
    const refused = await c.cashSales.price(companyId, { userId: person.id, branchId: null }, { customerId: null, lines: [{ productId: notAtCounter.id, quantity: 1 }] });
    expect(refused.ok ? '' : refused.error).toContain('not offered in cash sales');
  });

  it('leaves a product out of the pickers of the documents it is not offered in', async () => {
    const onlyOrders = await product(['sales_order']);
    expect(await search('sales-order-products', onlyOrders.name)).toContain(onlyOrders.id);
    expect(await search('sales-invoice-products', onlyOrders.name)).not.toContain(onlyOrders.id);
    expect(await search('credit-sale-products', onlyOrders.name)).not.toContain(onlyOrders.id);
    expect(await search('cash-sale-products', onlyOrders.name)).not.toContain(onlyOrders.id);
  });

  it('keeps the list when a product is saved, and refuses a place it does not know', async () => {
    const { CatalogService } = await import('@/server/domains/catalog/service');
    const made = await product(undefined);
    await CatalogService.updateProduct(made.id, { offeredIn: ['quote', 'pos_cash_sale'] });
    const [row] = await db.select({ offeredIn: schema.products.offeredIn }).from(schema.products).where(eq(schema.products.id, made.id));
    expect(row?.offeredIn).toEqual(['quote', 'pos_cash_sale']);
    await expect(CatalogService.updateProduct(made.id, { offeredIn: ['quote', 'ecommerce'] })).rejects.toThrow('not known');
    // The edit window sends the whole product back with the one change: the list must still be what was chosen.
    const whole = await CatalogService.getProductWithMedia(made.id);
    if (whole === undefined) throw new Error('no product');
    const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = whole as unknown as Record<string, unknown>;
    await CatalogService.updateProduct(made.id, { ...fields, offeredIn: ['quote'] });
    expect((await CatalogService.getProductById(made.id))?.offeredIn).toEqual(['quote']);
    await CatalogService.updateProduct(made.id, { offeredIn: ['quote', 'pos_cash_sale'] });
    // What the edit window reads back is what was saved.
    expect((await CatalogService.getProductById(made.id))?.offeredIn).toEqual(['quote', 'pos_cash_sale']);
  });
});
