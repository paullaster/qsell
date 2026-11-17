import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { SalesQuoteService } from '@/server/domains/quotes/service';
import { defOf } from './selling-documents';

/**
 * The documents before and after an order: an order made from a quote knows its quote (and the quote its order), an order's invoices
 * are listed, and an order that is neither is shown nothing (database).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('related documents of an order (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let quotes: SalesQuoteService;
  let companyId: string;
  let itemTypeId: string;
  let staffId: string;
  const actor = { type: 'user' as const, id: 'order-documents-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const product = async () => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `OD-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `ODS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Docs tea', slug: `od-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
    return id;
  };
  const customer = async () => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `OD-${randomUUID().slice(0, 10)}`, name: `Docs ${randomUUID().slice(0, 4)}`, email: `docs-${randomUUID().slice(0, 8)}@od.test`, phone: '0711000222', accountType: 'credit', creditLimit: '1000000', paymentTermDays: 30, street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    quotes = new (await import('@/server/domains/quotes/service')).SalesQuoteService();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_od_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Order Documents Co');
    const [user] = await db.insert(schema.users).values({ email: `staff-${randomUUID().slice(0, 8)}@od.test`, passwordHash: 'x', name: 'Docs Staff', role: 'manager' }).returning();
    staffId = user?.id ?? '';
  });

  afterAll(async () => {
    await db.delete(schema.sellingDocumentSettings).where(eq(schema.sellingDocumentSettings.companyId, companyId));
  });

  it('keeps the quote an order was made from, and the quote shows its order, both ways', async () => {
    const tea = await product();
    const buyer = await customer();
    const made = await quotes.create(staffId, { customerId: buyer.id, customerName: buyer.name, customerEmail: buyer.email, currency: 'KES', paymentMethod: 'mpesa_daraja', discountPercent: 0, shippingFee: 0, sections: [], lines: [{ productId: tea, quantity: 2, unitPrice: 100, discountPercent: 0 }] });
    await db.update(schema.salesQuotes).set({ status: 'accepted', deliveryAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' } }).where(eq(schema.salesQuotes.id, made.id));
    const order = await quotes.convertToOrder(staffId, made.id);
    if (order === null) throw new Error('not converted');
    const [row] = await db.select({ source: schema.orders.sourceQuoteId }).from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(row?.source).toBe(made.id);
    expect((await quotes.get(made.id))?.convertedOrderNumber).toBe(order.orderNumber);
    const docs = await c.orderDocuments.of(companyId, order.id);
    expect(docs).toMatchObject({ orderNumber: order.orderNumber, quote: { id: made.id, number: made.quoteNumber, status: 'converted', currency: 'KES' } });
  });

  it('lists the invoices raised for an order, in the order they were made, and shows no quote for an order that has none', async () => {
    const tea = await product();
    const buyer = await customer();
    await c.sellingSettings.save(companyId, 'sales_order', { ...defOf('sales_order').defaults, invoice: 'with_document' }, actor, reason);
    const placed = await c.salesOrders.place(companyId, { userId: staffId, branchId: null }, { customerId: buyer.id, lines: [{ productId: tea, quantity: 1 }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false });
    if (!placed.ok) throw new Error(placed.error);
    const docs = await c.orderDocuments.of(companyId, placed.orderId);
    expect(docs?.quote).toBeNull();
    expect(docs?.invoices.map((i) => i.type)).toEqual(['tax_invoice']);
    expect(docs?.invoices[0]).toMatchObject({ currency: 'KES', total: 100, emailed: false });
  });

  it('reads an order with nothing around it as no documents, and an unknown order as nothing', async () => {
    const tea = await product();
    const buyer = await customer();
    await c.sellingSettings.reset(companyId, 'sales_order', actor, reason);
    const placed = await c.salesOrders.place(companyId, { userId: staffId, branchId: null }, { customerId: buyer.id, lines: [{ productId: tea, quantity: 1 }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false });
    if (!placed.ok) throw new Error(placed.error);
    expect(await c.orderDocuments.of(companyId, placed.orderId)).toMatchObject({ quote: null, invoices: [] });
    expect(await c.orderDocuments.of(companyId, 'ord_does_not_exist')).toBeNull();
  });
});
