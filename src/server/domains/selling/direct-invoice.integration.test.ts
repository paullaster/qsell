import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { defOf, type SellingSettings } from './selling-documents';

/**
 * A sale invoiced directly, with no sales order in front of it: issued by staff to a customer, behaving as the company's settings for
 * sales invoices say (credit check, credit days, stock release, hold until paid), with its tax invoice made with it (database).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('sales invoices issued directly (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let itemTypeId: string;
  let staffId: string;
  const actor = { type: 'user' as const, id: 'direct-invoice-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const base = defOf('sales_invoice').defaults;

  const product = async () => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `DI-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `DIS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Direct tea', slug: `di-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
    return id;
  };
  const customer = async (over: Record<string, unknown> = {}) => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `DI-${randomUUID().slice(0, 10)}`, name: `Direct ${randomUUID().slice(0, 4)}`, email: `di-${randomUUID().slice(0, 8)}@di.test`, phone: '0711000444', accountType: 'credit', creditLimit: '1000', paymentTermDays: 21, street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya', ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  const issue = async (customerId: string, productId: string, quantity: number, hold = false) =>
    await c.salesOrders.place(companyId, { userId: staffId, branchId: null }, { customerId, lines: [{ productId, quantity }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: hold }, 'sales_invoice');
  const save = async (over: Partial<SellingSettings>) => await c.sellingSettings.save(companyId, 'sales_invoice', { ...base, ...over }, actor, reason);
  const stockOf = async (id: string) => {
    const [row] = await db.select({ stock: schema.products.stockQuantity, reserved: schema.products.reservedQuantity }).from(schema.products).where(eq(schema.products.id, id));
    return { stock: row?.stock ?? 0, reserved: row?.reserved ?? 0 };
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_di_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Direct Invoice Co');
    const [user] = await db.insert(schema.users).values({ email: `staff-${randomUUID().slice(0, 8)}@di.test`, passwordHash: 'x', name: 'Direct Staff', role: 'manager' }).returning();
    staffId = user?.id ?? '';
  });

  afterAll(async () => {
    await db.delete(schema.sellingDocumentSettings).where(eq(schema.sellingDocumentSettings.companyId, companyId));
  });

  it('issues the invoice with the document: its order is a sales invoice, the tax invoice is made at once, the stock leaves, and it falls due on the customer\'s terms', async () => {
    const tea = await product();
    const buyer = await customer();
    const placed = await issue(buyer.id, tea, 3);
    if (!placed.ok) throw new Error(placed.error);
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, placed.orderId));
    expect(row).toMatchObject({ salesModule: 'sales_invoice', tradeCustomerId: buyer.id, stockRelease: 'on_issue' });
    expect(Number(row?.totalAmount)).toBeCloseTo(300, 1);
    const docs = await c.orderDocuments.of(companyId, placed.orderId);
    expect(docs?.invoices.map((i) => i.type)).toEqual(['tax_invoice']);
    expect(await stockOf(tea)).toEqual({ stock: 97, reserved: 0 });
    const [entry] = await db.select({ due: schema.customerLedgerEntries.dueDate }).from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.orderId, placed.orderId));
    expect(Math.round(((entry?.due?.getTime() ?? 0) - Date.now()) / 86_400_000)).toBe(21);
    // It shows in the invoice list as a direct sale.
    const listed = (await c.salesInvoices.page({ query: placed.orderNumber })).rows[0];
    expect(listed).toMatchObject({ kind: 'tax_invoice', salesModule: 'sales_invoice', total: 300, payment: 'unpaid' });
  });

  it('does not skip the credit check: over the limit is refused in words, and a company can switch the check off', async () => {
    const tea = await product();
    const buyer = await customer({ creditLimit: '500' });
    const over = await issue(buyer.id, tea, 6);
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.error).toContain('would exceed the credit limit of 500');
    expect(await stockOf(tea)).toEqual({ stock: 100, reserved: 0 });
    await save({ creditCheck: 'off' });
    expect((await issue(buyer.id, tea, 6)).ok).toBe(true);
    await c.sellingSettings.reset(companyId, 'sales_invoice', actor, reason);
  });

  it('follows the credit days setting: a fixed number, or due at once', async () => {
    const tea = await product();
    const buyer = await customer({ paymentTermDays: 45 });
    const days = async () => {
      const placed = await issue(buyer.id, tea, 1);
      if (!placed.ok) throw new Error(placed.error);
      const [entry] = await db.select({ due: schema.customerLedgerEntries.dueDate }).from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.orderId, placed.orderId));
      return Math.round(((entry?.due?.getTime() ?? 0) - Date.now()) / 86_400_000) + 0;
    };
    expect(await days()).toBe(45);
    await save({ creditDays: 'fixed', fixedDays: 10 });
    expect(await days()).toBe(10);
    await save({ creditDays: 'on_issue' });
    expect(await days()).toBe(0);
    await c.sellingSettings.reset(companyId, 'sales_invoice', actor, reason);
  });

  it('holds the stock until it is paid when the setting says so, for one invoice where allowed, and for a customer without an account when payment is required first', async () => {
    const tea = await product();
    const buyer = await customer({ creditLimit: '100000' });
    await save({ stockRelease: 'on_payment' });
    const always = await issue(buyer.id, tea, 2);
    if (!always.ok) throw new Error(always.error);
    expect(await stockOf(tea)).toEqual({ stock: 100, reserved: 2 });
    await save({ stockRelease: 'on_issue', allowHoldUntilPaid: true });
    const one = await issue(buyer.id, tea, 3, true);
    if (!one.ok) throw new Error(one.error);
    expect(await stockOf(tea)).toEqual({ stock: 100, reserved: 5 });
    const normal = await issue(buyer.id, tea, 4);
    if (!normal.ok) throw new Error(normal.error);
    expect(await stockOf(tea)).toEqual({ stock: 96, reserved: 5 });
    await save({ noAccount: 'pay_first' });
    const cash = await customer({ accountType: 'cash', creditLimit: '0', paymentTermDays: 0 });
    const walkIn = await issue(cash.id, tea, 1);
    if (!walkIn.ok) throw new Error(walkIn.error);
    expect(await stockOf(tea)).toEqual({ stock: 96, reserved: 6 });
    await c.sellingSettings.reset(companyId, 'sales_invoice', actor, reason);
  });

  it('shows the customer\'s credit position under the settings for sales invoices, including an overdue invoice when that is checked', async () => {
    const buyer = await customer({ creditLimit: '2000' });
    expect(await c.salesOrders.creditPosition(companyId, buyer.id, 'sales_invoice')).toMatchObject({ hasCreditAccount: true, creditLimit: 2000, available: 2000, overdue: false });
    await db.insert(schema.customerLedgerEntries).values({ companyId, customerId: buyer.id, documentType: 'invoice', documentNo: `OLD-${randomUUID().slice(0, 6)}`, description: 'Credit invoice', amount: '100.00', remainingAmount: '100.00', dueDate: new Date(Date.now() - 60 * 86_400_000), postingDate: '2020-01-01', currency: 'KES' });
    expect((await c.salesOrders.creditPosition(companyId, buyer.id, 'sales_invoice'))?.overdue).toBe(false);
    await save({ creditCheck: 'limit_and_overdue', overdueDays: 30 });
    expect((await c.salesOrders.creditPosition(companyId, buyer.id, 'sales_invoice'))?.overdue).toBe(true);
    const tea = await product();
    const refused = await issue(buyer.id, tea, 1);
    expect(refused.ok ? '' : refused.error).toContain('overdue by more than 30 days');
    await c.sellingSettings.reset(companyId, 'sales_invoice', actor, reason);
  });
});
