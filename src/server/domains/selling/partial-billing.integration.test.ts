import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';

/**
 * Invoicing part of an order (database): off by default and changed with a reason that is recorded; a part invoice of some quantities,
 * the next one finishing the order so the invoices add up to the order to the cent; never two invoices for the same units, never both a
 * whole and a part invoice; the documents never change; and a credit note against one part invoice only.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('invoicing part of an order (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let itemTypeId: string;
  let customerId: string;
  const actor = { type: 'user' as const, id: 'partial-billing-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const user = async () => {
    const [row] = await db.insert(schema.users).values({ email: `pb-${randomUUID().slice(0, 8)}@pb.test`, passwordHash: 'x', name: 'Biller', role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const product = async (name: string, price: number) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `PB-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `PBS-${randomUUID().slice(0, 8)}`.toUpperCase(), name, slug: `pb-${randomUUID()}`, itemTypeId, price: String(price), costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 1000 });
    return id;
  };
  /** A sales order of 10 teas at 100 and 4 mugs at 250: 2,000 in all. */
  const order = async (person: { id: string }) => {
    const tea = await product('Part tea', 100);
    const mug = await product('Part mug', 250);
    const placed = await c.salesOrders.place(companyId, { userId: person.id, branchId: null }, { customerId, lines: [{ productId: tea, quantity: 10 }, { productId: mug, quantity: 4 }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false }, 'sales_order');
    if (!placed.ok) throw new Error(placed.error);
    return { orderId: placed.orderId, tea, mug };
  };
  const itemOf = async (orderId: string, productId: string) => (await c.partialBilling.view(companyId, orderId))?.lines.find((l) => l.productId === productId)?.orderItemId ?? '';

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pb_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Part Billing Co');
    const [customer] = await db.insert(schema.customers).values({ companyId, number: `PBC-${randomUUID().slice(0, 8)}`, name: 'Part Buyer', email: `pbb-${randomUUID().slice(0, 6)}@pb.test`, phone: '0711000444', accountType: 'cash' } as never).returning();
    customerId = customer?.id ?? '';
  });

  it('is off until someone with the permission switches it on with a reason, which is recorded', async () => {
    // A run on a database that has been used before starts from the built-in state.
    await db.delete(schema.billingSettings).where(eq(schema.billingSettings.companyId, companyId));
    expect((await c.partialBilling.settings(companyId)).enabled).toBe(false);
    const person = await user();
    const made = await order(person);
    const refused = await c.partialBilling.issue(companyId, { userId: person.id }, made.orderId, { asks: [{ orderItemId: await itemOf(made.orderId, made.tea), quantity: 1 }], rest: false });
    expect(refused).toEqual({ ok: false, error: 'Invoicing in parts is switched off.' });
    await expect(c.partialBilling.setEnabled(companyId, actor, true, { code: 'NO_SUCH' })).rejects.toThrow();
    await c.partialBilling.setEnabled(companyId, actor, true, reason);
    expect(await c.partialBilling.settings(companyId)).toMatchObject({ enabled: true, version: expect.any(Number) as number, updatedBy: actor.id });
    await expect(c.partialBilling.setEnabled(companyId, actor, true, reason)).rejects.toThrow('already switched on');
    const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectType, 'billing_settings'));
    expect(log.some((e) => e.action === 'billing_settings.changed')).toBe(true);
  });

  it('invoices some quantities, then finishes the order: the invoices add up to the order and are numbered in order', async () => {
    const person = await user();
    const { orderId, tea, mug } = await order(person);
    const teaItem = await itemOf(orderId, tea);
    const mugItem = await itemOf(orderId, mug);
    const first = await c.partialBilling.issue(companyId, { userId: person.id }, orderId, { asks: [{ orderItemId: teaItem, quantity: 4 }], rest: false });
    expect(first).toMatchObject({ ok: true, sequence: 1, finishesOrder: false });
    const afterFirst = await c.partialBilling.view(companyId, orderId);
    expect(afterFirst?.lines.find((l) => l.productId === tea)).toMatchObject({ ordered: 10, invoiced: 4, left: 6 });
    expect(afterFirst?.invoices[0]).toMatchObject({ sequence: 1, goods: 400, total: 400, finishesOrder: false });
    // The same units cannot be invoiced twice, and more than is left is refused in words.
    const tooMany = await c.partialBilling.issue(companyId, { userId: person.id }, orderId, { asks: [{ orderItemId: teaItem, quantity: 7 }], rest: false });
    expect(tooMany.ok ? '' : tooMany.error).toContain('at most 6 is left');
    const second = await c.partialBilling.issue(companyId, { userId: person.id }, orderId, { asks: [{ orderItemId: mugItem, quantity: 4 }], rest: false });
    expect(second).toMatchObject({ ok: true, sequence: 2, finishesOrder: false });
    const rest = await c.partialBilling.issue(companyId, { userId: person.id }, orderId, { asks: [], rest: true });
    expect(rest).toMatchObject({ ok: true, sequence: 3, finishesOrder: true });
    const done = await c.partialBilling.view(companyId, orderId);
    expect(done?.invoices.map((i) => i.total)).toEqual([400, 1000, 600]);
    expect(done?.invoices.reduce((n, i) => n + i.total, 0)).toBe(2000);
    expect(done).toMatchObject({ complete: true, canPart: false, canRest: false });
    expect(new Set(done?.invoices.map((i) => i.invoiceNumber)).size).toBe(3);
    const again = await c.partialBilling.issue(companyId, { userId: person.id }, orderId, { asks: [], rest: true });
    expect(again.ok).toBe(false);
    const documents = await db.select().from(schema.invoiceDocuments).where(eq(schema.invoiceDocuments.orderId, orderId));
    expect(documents.map((d) => d.documentType)).toEqual(['tax_invoice_part', 'tax_invoice_part', 'tax_invoice_part']);
  });

  it('never gives two invoices for the same units when two people press at once', async () => {
    const person = await user();
    const { orderId, tea } = await order(person);
    const teaItem = await itemOf(orderId, tea);
    const results = await Promise.all([1, 2, 3].map(async () => await c.partialBilling.issue(companyId, { userId: person.id }, orderId, { asks: [{ orderItemId: teaItem, quantity: 10 }], rest: false })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await c.partialBilling.view(companyId, orderId))?.lines.find((l) => l.productId === tea)).toMatchObject({ invoiced: 10, left: 0 });
  });

  it('never allows both a whole invoice and a part invoice for one order', async () => {
    const person = await user();
    const parted = await order(person);
    await c.partialBilling.issue(companyId, { userId: person.id }, parted.orderId, { asks: [{ orderItemId: await itemOf(parted.orderId, parted.tea), quantity: 1 }], rest: false });
    await expect(c.invoices.generatePdf(parted.orderId, 'tax_invoice')).rejects.toThrow('invoiced in parts');
    const whole = await order(person);
    await c.invoices.generatePdf(whole.orderId, 'tax_invoice');
    const refused = await c.partialBilling.issue(companyId, { userId: person.id }, whole.orderId, { asks: [{ orderItemId: await itemOf(whole.orderId, whole.tea), quantity: 1 }], rest: false });
    expect(refused).toEqual({ ok: false, error: 'This order already has a tax invoice for the whole order.' });
  });

  it('keeps a part invoice and its lines as they were: the database refuses an edit or a delete, but signing may write its status', async () => {
    const person = await user();
    const { orderId, tea } = await order(person);
    const made = await c.partialBilling.issue(companyId, { userId: person.id }, orderId, { asks: [{ orderItemId: await itemOf(orderId, tea), quantity: 2 }], rest: false });
    if (!made.ok) throw new Error(made.error);
    await expect(db.update(schema.orderBillings).set({ totalAmount: '1.00' }).where(eq(schema.orderBillings.id, made.billingId))).rejects.toThrow();
    await expect(db.delete(schema.orderBillings).where(eq(schema.orderBillings.id, made.billingId))).rejects.toThrow();
    await expect(db.update(schema.orderBillingLines).set({ quantity: 1 }).where(eq(schema.orderBillingLines.billingId, made.billingId))).rejects.toThrow();
    await expect(db.delete(schema.orderBillingLines).where(eq(schema.orderBillingLines.billingId, made.billingId))).rejects.toThrow();
    await db.update(schema.orderBillings).set({ kraStatus: 'transmitted' }).where(eq(schema.orderBillings.id, made.billingId));
    const signed = await c.kraSigning.processOrderBillingDocument({ billingId: made.billingId });
    expect(signed).toBeDefined();
  });

  it('credits one part invoice only: its lines and amounts, and never a whole credit on an order invoiced in parts', async () => {
    const person = await user();
    const { orderId, tea, mug } = await order(person);
    const made = await c.partialBilling.issue(companyId, { userId: person.id }, orderId, { asks: [{ orderItemId: await itemOf(orderId, tea), quantity: 4 }], rest: false });
    if (!made.ok) throw new Error(made.error);
    await expect(c.creditNotes.creditableForOrder(orderId)).rejects.toThrow('invoiced in parts');
    const creditable = await c.creditNotes.creditableForOrder(orderId, made.billingId);
    expect(creditable).toMatchObject({ hasTaxInvoice: true, invoiceTotal: 400, creditedTotal: 0 });
    expect(creditable.lines.map((l) => [l.productId, l.soldQuantity, l.remainingQuantity])).toEqual([[tea, 4, 4]]);
    await expect(c.creditNotes.issueForOrder({ orderId, billingId: made.billingId, lines: [{ productId: mug, quantity: 1 }], reason: { code: 'returned_goods' }, issuedBy: person.id })).rejects.toThrow();
    await expect(c.creditNotes.issueForOrder({ orderId, billingId: made.billingId, lines: [{ productId: tea, quantity: 5 }], reason: { code: 'returned_goods' }, issuedBy: person.id })).rejects.toThrow();
    const note = await c.creditNotes.issueForOrder({ orderId, billingId: made.billingId, lines: [{ productId: tea, quantity: 1 }], reason: { code: 'returned_goods' }, issuedBy: person.id });
    expect(note).toMatchObject({ originalDocumentKey: `order_billing:${made.billingId}:tax_invoice`, totalAmount: '100.00' });
    expect((await c.creditNotes.creditableForOrder(orderId, made.billingId)).lines[0]).toMatchObject({ creditedQuantity: 1, remainingQuantity: 3 });
    await expect(c.creditNotes.issueForOrder({ orderId, lines: [{ productId: tea, quantity: 1 }], reason: { code: 'returned_goods' }, issuedBy: person.id })).rejects.toThrow('invoiced in parts');
  });
});
