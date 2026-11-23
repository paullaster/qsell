import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';

/**
 * Invoices of sales: raised for an order that has none, found and shown with how each stands, sent again and printed (database).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('sales invoices (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let itemTypeId: string;
  let staffId: string;
  let tea: string;

  const buyer = async (name = `Invoice ${randomUUID().slice(0, 6)}`) => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `SI-${randomUUID().slice(0, 10)}`, name, email: `si-${randomUUID().slice(0, 8)}@si.test`, phone: '0711000333', accountType: 'credit', creditLimit: '100000000', paymentTermDays: 30, street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  /** A sales order with no invoice (the sales order kind raises it later). */
  const order = async (customerId: string) => {
    const placed = await c.salesOrders.place(companyId, { userId: staffId, branchId: null }, { customerId, lines: [{ productId: tea, quantity: 2 }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false });
    if (!placed.ok) throw new Error(placed.error);
    return placed;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_si_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Sales Invoices Co');
    const [user] = await db.insert(schema.users).values({ email: `staff-${randomUUID().slice(0, 8)}@si.test`, passwordHash: 'x', name: 'Invoice Staff', role: 'manager' }).returning();
    staffId = user?.id ?? '';
    tea = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: tea, sku: `SI-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SIS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Invoice tea', slug: `si-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 10000 });
  });

  it('raises the tax invoice of an order that has none, once, and the order then leaves the list of orders to invoice', async () => {
    const owner = await buyer();
    const placed = await order(owner.id);
    const { SELLING_LOOKUP_SOURCES } = await import('./lookup-sources');
    const source = SELLING_LOOKUP_SOURCES.find((s) => s.key === 'invoiceable-orders');
    const before = await source?.search({ companyId, query: placed.orderNumber, limit: 20, after: null, filters: {} });
    expect(before?.options.map((o) => o.id)).toEqual([placed.orderId]);
    const made = await c.salesInvoices.raise(placed.orderId);
    expect(made).toMatchObject({ ok: true, orderNumber: placed.orderNumber });
    expect((await source?.search({ companyId, query: placed.orderNumber, limit: 20, after: null, filters: {} }))?.options).toEqual([]);
    const again = await c.salesInvoices.raise(placed.orderId);
    expect(again).toEqual({ ok: false, error: `Order ${placed.orderNumber} already has a tax invoice.` });
    expect(await c.salesInvoices.raise('ord_does_not_exist')).toEqual({ ok: false, error: 'That order could not be found.' });
  });

  it('lists an invoice with how it stands, and shows its detail with the lines, credit notes and signing log', async () => {
    const owner = await buyer(`Detail ${randomUUID().slice(0, 6)}`);
    const placed = await order(owner.id);
    const made = await c.salesInvoices.raise(placed.orderId);
    if (!made.ok) throw new Error(made.error);
    const page = await c.salesInvoices.page({ query: owner.name });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ invoiceNumber: made.invoiceNumber, kind: 'tax_invoice', orderNumber: placed.orderNumber, customerName: owner.name, currency: 'KES', total: 200, credited: 0, payment: 'unpaid', salesModule: 'sales_order', emailed: false });
    const detail = await c.salesInvoices.detail(made.invoiceNumber);
    expect(detail).toMatchObject({ invoiceNumber: made.invoiceNumber, customerEmail: owner.email, orderStatus: 'pending', creditNotes: [] });
    // Each line says what it is: one unit's price, the quantity and the line's total; the sums and what is owed come with it.
    expect(detail?.lines).toEqual([expect.objectContaining({ name: 'Invoice tea', quantity: 2, unitPrice: 100, total: 200, discount: 0, listUnitPrice: null })]);
    expect(detail?.figures).toMatchObject({ discount: 0 });
    expect(detail).toMatchObject({ paid: 0, balance: 200 });
    expect(Array.isArray(detail?.signingLog)).toBe(true);
    expect(await c.salesInvoices.detail('NO-SUCH-INVOICE')).toBeNull();
  });

  it('shows an order\'s payment on its invoice and a full credit as credited', async () => {
    const owner = await buyer();
    const placed = await order(owner.id);
    const made = await c.salesInvoices.raise(placed.orderId);
    if (!made.ok) throw new Error(made.error);
    const [row] = await db.select({ id: schema.invoiceDocuments.id }).from(schema.invoiceDocuments).where(eq(schema.invoiceDocuments.invoiceNumber, made.invoiceNumber));
    expect(row).toBeDefined();
    await db.insert(schema.creditNotes).values({ companyId, module: 'sales_order', sourceKind: 'order', sourceId: placed.orderId, sourceRef: placed.orderNumber, creditNoteNo: `CN-SI-${randomUUID().slice(0, 8)}`, originalDocumentKey: `order:${placed.orderId}:tax_invoice`, reasonCode: 'OTHER', currency: 'KES', totalAmount: '200.00', issuedBy: 'test' });
    const [listed] = (await c.salesInvoices.page({ query: made.invoiceNumber })).rows;
    expect(listed).toMatchObject({ credited: 200, payment: 'credited' });
    expect((await c.salesInvoices.detail(made.invoiceNumber))?.creditNotes).toHaveLength(1);
    expect(await c.salesInvoices.detail(made.invoiceNumber)).toMatchObject({ balance: 0 });
  });

  it('lists newest first in pages, narrows by kind, and sends and prints an invoice under the number it already has', async () => {
    const owner = await buyer(`Pager ${randomUUID().slice(0, 6)}`);
    const numbers: string[] = [];
    let last: { orderId: string } | null = null;
    for (let n = 0; n < 26; n += 1) {
      const placed = await order(owner.id);
      const made = await c.salesInvoices.raise(placed.orderId);
      if (made.ok) numbers.push(made.invoiceNumber);
      last = placed;
    }
    expect(numbers).toHaveLength(26);
    const first = await c.salesInvoices.page({ query: owner.name });
    expect(first.rows).toHaveLength(25);
    expect(first.rows[0]?.invoiceNumber).toBe(numbers[25]);
    expect(first.nextCursor).not.toBeNull();
    const second = await c.salesInvoices.page({ query: owner.name, cursor: first.nextCursor });
    expect(second.rows.map((r) => r.invoiceNumber)).toEqual([numbers[0]]);
    expect(second.nextCursor).toBeNull();
    expect((await c.salesInvoices.page({ query: owner.name, kind: 'proforma' })).rows).toEqual([]);
    if (last === null) throw new Error('no order');
    const send = vi.spyOn(c.email, 'send').mockResolvedValue({ ok: true } as never);
    try {
      const sent = await c.salesInvoices.send(last.orderId, 'tax_invoice');
      expect(sent.invoiceNumber).toBe(numbers[25]);
      expect(send).toHaveBeenCalledTimes(1);
      const pdf = await c.salesInvoices.pdf(last.orderId, 'tax_invoice');
      expect(pdf).toMatchObject({ invoiceNumber: numbers[25], mimeType: 'application/pdf' });
      expect(pdf.pdfBase64.length).toBeGreaterThan(100);
    } finally {
      send.mockRestore();
    }
  });
});
