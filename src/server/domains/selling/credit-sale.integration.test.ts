import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type * as afterCommitModule from '@/server/kernel/after-commit';
import { defOf } from './selling-documents';

/**
 * A credit sale: a sale to a customer's account, invoiced at once, behaving as the company's settings for credit sales say (the
 * credit limit, credit days, approval, stock, invoicing), with a customer without an account refused (database).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('credit sales (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let itemTypeId: string;
  let afterCommit: typeof afterCommitModule;
  const actor = { type: 'user' as const, id: 'credit-sale-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const base = defOf('credit_sale').defaults;

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@cs.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const product = async () => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `CS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `CSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Credit tea', slug: `cs-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
    return id;
  };
  const customer = async (over: Record<string, unknown> = {}) => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `CS-${randomUUID().slice(0, 10)}`, name: `Credit ${randomUUID().slice(0, 4)}`, email: `cs-${randomUUID().slice(0, 8)}@cs.test`, phone: '0711000666', accountType: 'credit', creditLimit: '1000', paymentTermDays: 30, street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya', ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  const sell = async (staffId: string, customerId: string, productId: string, quantity: number) =>
    await c.salesOrders.place(companyId, { userId: staffId, branchId: null }, { customerId, lines: [{ productId, quantity }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false }, 'credit_sale');

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    afterCommit = await import('@/server/kernel/after-commit');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_cs_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Credit Sales Co');
  });

  afterAll(async () => {
    await db.delete(schema.sellingDocumentSettings).where(eq(schema.sellingDocumentSettings.companyId, companyId));
  });

  it('is an order on account, a credit sale, invoiced at once, falling due on the customer\'s terms, and listed under credit sales and not under sales orders', async () => {
    const staff = await user('staff');
    const tea = await product();
    const buyer = await customer({ paymentTermDays: 21 });
    const placed = await sell(staff.id, buyer.id, tea, 3);
    if (!placed.ok) throw new Error(placed.error);
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, placed.orderId));
    expect(row).toMatchObject({ salesModule: 'credit_sale', paymentMethod: 'on_account', tradeCustomerId: buyer.id });
    expect((await c.orderDocuments.of(companyId, placed.orderId))?.invoices.map((i) => i.type)).toEqual(['tax_invoice']);
    const [entry] = await db.select({ due: schema.customerLedgerEntries.dueDate, remaining: schema.customerLedgerEntries.remainingAmount }).from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.orderId, placed.orderId));
    expect(Math.round(((entry?.due?.getTime() ?? 0) - Date.now()) / 86_400_000)).toBe(21);
    expect(Number(entry?.remaining)).toBeCloseTo(300, 1);
    expect((await c.salesOrders.page(companyId, { query: placed.orderNumber }, 'credit_sale')).rows.map((r) => r.orderNumber)).toEqual([placed.orderNumber]);
    expect((await c.salesOrders.page(companyId, { query: placed.orderNumber })).rows).toEqual([]);
    expect(await c.salesInvoices.page({ query: placed.orderNumber }).then((p) => p.rows[0]?.salesModule)).toBe('credit_sale');
  });

  it('refuses a customer without a credit account, in words', async () => {
    const staff = await user('staff');
    const tea = await product();
    const cash = await customer({ accountType: 'cash', creditLimit: '0', paymentTermDays: 0 });
    const refused = await sell(staff.id, cash.id, tea, 1);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error).toContain('is a cash customer');
  });

  it('checks the limit: over it is refused with no workflow to ask, and asks for approval when a workflow covers it, then makes the invoice once approved', async () => {
    const staff = await user('staff');
    const approver = await user('approver');
    const tea = await product();
    const buyer = await customer({ creditLimit: '500' });
    const refused = await sell(staff.id, buyer.id, tea, 6);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error).toContain('would exceed the credit limit of 500');
    const wf = await c.approvalConfig.createWorkflow(companyId, { code: `CSW-${randomUUID().slice(0, 8)}`, name: 'Credit over the limit', trigger: 'sales_order.submitted' }, actor);
    await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'and', children: [{ op: 'eq', field: 'requestedBy', value: staff.id }, { op: 'eq', field: 'customer.overCreditLimit', value: true }] }, steps: [{ sequence: 1, name: 'Approver', approver: { type: 'user', userId: approver.id } }] } as never, actor);
    await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    const held = await sell(staff.id, buyer.id, tea, 6);
    if (!held.ok) throw new Error(held.error);
    expect(held.waitingForApproval).toBe(true);
    expect((await c.orderDocuments.of(companyId, held.orderId))?.invoices).toEqual([]);
    const entry = (await c.approvals.forDocument(companyId, 'sales_order', held.orderId)).flatMap((r) => r.entries).find((e) => e.approverUserId === approver.id);
    if (entry === undefined) throw new Error('no approval entry');
    await afterCommit.withAfterCommit(db, (t) => c.approvals.approve(entry.id, approver.id, null, t));
    expect((await c.orderDocuments.of(companyId, held.orderId))?.invoices.map((i) => i.type)).toEqual(['tax_invoice']);
  });

  it('follows the settings for credit sales and not those for sales orders: switching its credit check off lets an over-limit sale through while orders are still checked', async () => {
    const staff = await user('staff');
    const tea = await product();
    const buyer = await customer({ creditLimit: '500' });
    await c.sellingSettings.save(companyId, 'credit_sale', { ...base, creditCheck: 'off' }, actor, reason);
    try {
      expect((await sell(staff.id, buyer.id, tea, 6)).ok).toBe(true);
      const order = await c.salesOrders.place(companyId, { userId: staff.id, branchId: null }, { customerId: buyer.id, lines: [{ productId: tea, quantity: 6 }], paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false });
      expect(order.ok).toBe(false);
    } finally {
      await c.sellingSettings.reset(companyId, 'credit_sale', actor, reason);
    }
  });
});
