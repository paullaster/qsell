import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type * as afterCommitModule from '@/server/kernel/after-commit';
import { defOf } from './selling-documents';

/**
 * A document whose invoice is made with it, held by an approval, gets its tax invoice automatically once it is approved, unless the
 * company turned that off, when staff raise it (database).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('the invoice once an approval releases a document (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let itemTypeId: string;
  let afterCommit: typeof afterCommitModule;
  const actor = { type: 'user' as const, id: 'invoice-after-approval-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const base = defOf('sales_invoice').defaults;

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@iaa.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const product = async () => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `IA-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `IAS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Approval tea', slug: `ia-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
    return id;
  };
  /** Every sales invoice this requester issues waits for this approver. */
  const holdFor = async (requester: string, approver: string) => {
    const wf = await c.approvalConfig.createWorkflow(companyId, { code: `IAA-${randomUUID().slice(0, 8)}`, name: 'Hold sales invoices', trigger: 'sales_order.submitted' }, actor);
    await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'and', children: [{ op: 'eq', field: 'requestedBy', value: requester }] }, steps: [{ sequence: 1, name: 'Approver', approver: { type: 'user', userId: approver } }] } as never, actor);
    await c.approvalConfig.publish(companyId, wf.id, actor, reason);
  };
  const issueHeld = async (requester: string) => {
    const [customer] = await db.insert(schema.customers).values({ companyId, number: `IAA-${randomUUID().slice(0, 10)}`, name: 'Held Buyer', email: `held-${randomUUID().slice(0, 8)}@iaa.test`, phone: '0711000555', accountType: 'credit', creditLimit: '1000000', paymentTermDays: 30, street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' }).returning();
    const tea = await product();
    const placed = await c.salesOrders.place(companyId, { userId: requester, branchId: null }, { customerId: customer?.id ?? '', lines: [{ productId: tea, quantity: 2 }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false }, 'sales_invoice');
    if (!placed.ok) throw new Error(placed.error);
    return { ...placed, tea };
  };
  const approveIt = async (orderId: string, approver: string) => {
    const entries = (await c.approvals.forDocument(companyId, 'sales_order', orderId)).flatMap((r) => r.entries).filter((e) => e.approverUserId === approver);
    const first = entries[0];
    if (first === undefined) throw new Error('no approval entry for the approver');
    await afterCommit.withAfterCommit(db, (t) => c.approvals.approve(first.id, approver, null, t));
  };
  const stockOf = async (id: string) => {
    const [row] = await db.select({ stock: schema.products.stockQuantity, reserved: schema.products.reservedQuantity }).from(schema.products).where(eq(schema.products.id, id));
    return { stock: row?.stock ?? 0, reserved: row?.reserved ?? 0 };
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    afterCommit = await import('@/server/kernel/after-commit');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_ia_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Invoice After Approval Co');
  });

  afterAll(async () => {
    await db.delete(schema.sellingDocumentSettings).where(eq(schema.sellingDocumentSettings.companyId, companyId));
  });

  it('makes the tax invoice (and issues the stock) once the approver approves, by default', async () => {
    const requester = await user('requester');
    const approver = await user('approver');
    await holdFor(requester.id, approver.id);
    const held = await issueHeld(requester.id);
    expect(held.waitingForApproval).toBe(true);
    expect((await c.orderDocuments.of(companyId, held.orderId))?.invoices).toEqual([]);
    expect(await stockOf(held.tea)).toEqual({ stock: 100, reserved: 2 });
    const [row] = await db.select({ flag: schema.orders.invoiceWhenApproved }).from(schema.orders).where(eq(schema.orders.id, held.orderId));
    expect(row?.flag).toBe(true);
    await approveIt(held.orderId, approver.id);
    expect((await c.orderDocuments.of(companyId, held.orderId))?.invoices.map((i) => i.type)).toEqual(['tax_invoice']);
    expect(await stockOf(held.tea)).toEqual({ stock: 98, reserved: 0 });
  });

  it('leaves the invoice for staff when the company turned the automatic invoice off, who can then raise it', async () => {
    const requester = await user('requester');
    const approver = await user('approver');
    await holdFor(requester.id, approver.id);
    await c.sellingSettings.save(companyId, 'sales_invoice', { ...base, invoiceAfterApproval: false }, actor, reason);
    try {
      const held = await issueHeld(requester.id);
      expect(held.waitingForApproval).toBe(true);
      const [row] = await db.select({ flag: schema.orders.invoiceWhenApproved }).from(schema.orders).where(eq(schema.orders.id, held.orderId));
      expect(row?.flag).toBe(false);
      await approveIt(held.orderId, approver.id);
      expect((await c.orderDocuments.of(companyId, held.orderId))?.invoices).toEqual([]);
      const raised = await c.salesInvoices.raise(held.orderId);
      expect(raised).toMatchObject({ ok: true, orderNumber: held.orderNumber });
    } finally {
      await c.sellingSettings.reset(companyId, 'sales_invoice', actor, reason);
    }
  });

  it('does not make a second invoice when one already exists', async () => {
    const requester = await user('requester');
    const approver = await user('approver');
    await holdFor(requester.id, approver.id);
    const held = await issueHeld(requester.id);
    await approveIt(held.orderId, approver.id);
    const once = (await c.orderDocuments.of(companyId, held.orderId))?.invoices ?? [];
    expect(once).toHaveLength(1);
    expect(await c.salesInvoices.raise(held.orderId)).toEqual({ ok: false, error: `Order ${held.orderNumber} already has a tax invoice.` });
  });
});
