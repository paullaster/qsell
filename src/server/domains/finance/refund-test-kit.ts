import { randomUUID } from 'node:crypto';
import { beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { isRecord, readText, required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { CustomerMasterService } from '@/server/domains/customers/master-service';
import type * as mod_server_kernel_after_commit from '@/server/kernel/after-commit';
import type { FinanceServices } from './index';
import type { FinanceContext } from './errors';
import type { PolicyInput } from './receivables/credit-policy-service';
import type { RefundInput } from './receivables/refund-service';

/**
 * The scaffolding the refund-family integration tests share: a company with the Kenya chart, payment methods, a customer who
 * is owed money by a credit note, and people to ask, approve and pay. Call it inside a `describe` that has a database; the
 * returned object fills in when the suite starts.
 */
export interface RefundKit {
  db: DrizzleDb;
  schema: typeof mod_server_db_drizzle_schema;
  c: AppContainer;
  fin: FinanceServices;
  withAfterCommit: typeof mod_server_kernel_after_commit.withAfterCommit;
  companyId: string;
  branchId: string;
  boss: string;
  requester: string;
  ctx: FinanceContext;
  reqCtx: FinanceContext;
  bossCtx: FinanceContext;
  acct: Record<string, string>;
  methodId: Record<string, string>;
  today: string;
  codeOf: (p: Promise<unknown>) => Promise<string>;
  policy: (o?: Partial<PolicyInput>) => Promise<void>;
  user: (label: string) => Promise<string>;
  owed: (qty?: number) => Promise<{ orderId: string; customer: typeof mod_server_db_drizzle_schema.customers.$inferSelect; cn: { id: string }; cents: number }>;
  request: (customerId: string, kind: 'credit_note_excess' | 'wallet' | 'receipt_unapplied', sourceId: string, amount: string, o?: Partial<RefundInput>) => Promise<{ id: string; number: string; detailsChanged: boolean }>;
  status: (id: string) => Promise<string>;
  payOut: (id: string, by?: FinanceContext, method?: string) => Promise<unknown>;
  workflow: (trigger: string, approverUserId: string, condition?: Record<string, unknown>) => Promise<{ id: string }>;
  openEntry: (documentKind: string, id: string) => Promise<{ id: string }>;
  approve: (entryId: string, by: string) => Promise<unknown>;
  glNet: (no: string) => Promise<number>;
}

export function refundKit(label: string): RefundKit {
  const k = {} as RefundKit;
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  let master: CustomerMasterService;
  let productId: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: k.db } = await import('@/server/db/drizzle/client'));
    k.schema = await import('@/server/db/drizzle/schema');
    ({ withAfterCommit: k.withAfterCommit } = await import('@/server/kernel/after-commit'));
    const { getContainer } = await import('@/server/di/container');
    k.c = getContainer();
    k.fin = k.c.finance;
    const { CustomerMasterService } = await import('@/server/domains/customers/master-service');
    master = new CustomerMasterService(k.db, {} as never, new (await import('@/server/domains/transactions/ledger-service')).TransactionLedgerService(k.db));
    const { db, schema, c, fin } = k;
    const [company] = await db.insert(schema.companySettings).values({ legalName: label, tradingName: label, email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    k.companyId = company.id;
    const [branch] = await db.insert(schema.branches).values({ companyId: k.companyId, code: `K${run.toUpperCase()}`, name: 'Kit branch', isDefault: true }).returning();
    k.branchId = branch.id;
    await c.reasonCodes.ensureSystemReasons(k.companyId);
    const origin = { surface: 'test', action: 'run' };
    k.user = async (name) => (await db.insert(schema.users).values({ email: `${name}-${randomUUID()}@kit.test`, passwordHash: 'x', name, role: 'manager' }).returning())[0].id;
    [k.boss, k.requester] = await Promise.all([k.user('boss'), k.user('requester')]);
    await c.approvalConfig.saveProfile(k.companyId, { userId: k.boss, limits: [] }, { type: 'user', id: 'tester' }, { code: 'POLICY_CHANGE' });
    k.ctx = { companyId: k.companyId, actor: { type: 'user', id: 'tester' }, origin };
    k.reqCtx = { ...k.ctx, actor: { type: 'user', id: k.requester } };
    k.bossCtx = { ...k.ctx, actor: { type: 'user', id: k.boss } };
    k.today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
    await fin.setup.applyTemplate(k.ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(k.ctx);
    k.acct = {};
    k.methodId = {};
    for (const a of await fin.setup.listAccounts(k.companyId)) k.acct[a.no] = a.id;
    for (const m of await fin.paymentMethods.list(k.companyId)) k.methodId[m.method.code] = m.method.id;
    const itemTypeId = `it_${run}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `KT-${run}`.toUpperCase(), stockCode: `KTS-${run}`.toUpperCase(), name: 'Widget', slug: `kt-${randomUUID()}`, itemTypeId, price: '580', costPrice: '300', stockQuantity: 50, taxRate: '16', isTaxInclusive: true });
  });

  k.codeOf = async (p) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (isRecord(e) && 'code' in e) return readText(e.code);
      return `OTHER:${(e as Error).message}`;
    }
  };
  k.policy = async (o = {}) => {
    await k.fin.creditPolicy.save(k.ctx, { groupCode: null, walletEnabled: false, allowDeposits: true, overpaymentDefault: 'ask', autoApply: 'never', creditNoteExcess: 'ask', refundsEnabled: true, walletCashOut: false, maxBalance: null, label: 'Wallet', ...o });
  };
  k.owed = async (qty = 1) => {
    const { db, schema, c } = k;
    seq += 1;
    const [cust] = await db.insert(schema.customers).values({ companyId: k.companyId, number: `KT${run}${seq}`, name: `Kit customer ${seq}`, phone: `0711${String(100000 + seq)}`, accountType: 'cash', creditLimit: '0' }).returning();
    const id = `kt_${run}_${seq}`;
    const total = 580 * qty;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, trade_customer_id, payment_status)
      VALUES (${id}, ${`KTO-${run}-${seq}`}, 'u', ${k.branchId}::uuid, 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, ${500 * qty}, ${80 * qty}, 0, ${total}, 'mpesa_daraja', ${cust.id}::uuid, 'paid')`);
    await db.insert(schema.orderItems).values({ orderId: id, productId, productName: 'Widget', sku: 'W', quantity: qty, unitPrice: '580.00', totalPrice: total.toFixed(2), imageUrl: '', unitCost: '300.0000' });
    await master.postInvoice({ customer: cust, orderId: id, orderNumber: `KTO-${run}-${seq}`, amount: total, currency: 'KES' });
    await db.insert(schema.inventoryMovements).values({ id: `mv_${randomUUID()}`, productId, productName: 'Widget', changeAmount: 0, previousStock: 10, newStock: 10, changeType: 'order_fulfillment', referenceId: id });
    await db.insert(schema.invoiceDocuments).values({ orderId: id, orderNumber: `KTO-${run}-${seq}`, invoiceNumber: `KTI-${run}-${seq}`, documentType: 'tax_invoice', customerEmail: 'e@x.io', customerName: 'n', currency: 'KES', subtotal: String(500 * qty), tax: String(80 * qty), shippingFee: '0', totalAmount: String(total), pdfStorageKey: 'x.pdf', emailStatus: 'not_sent', meta: {} });
    const cn = await c.creditNotes.issueForOrder({ orderId: id, lines: [{ productId, quantity: qty }], reason: { code: 'returned_goods' }, issuedBy: 'tester' });
    return { orderId: id, customer: cust, cn, cents: 58000 * qty };
  };
  k.request = (customerId, kind, sourceId, amount, o = {}) =>
    k.fin.refunds.create(k.ctx, { customerId, sourceKind: kind, sourceId, amount, paymentMethodId: k.methodId.CASH, payoutDetails: { recipientName: 'Customer' }, reasonCode: 'CUSTOMER_REQUEST', mayChangeDestination: false, ...o });
  k.status = async (id) => (await k.db.select().from(k.schema.refundRequests).where(eq(k.schema.refundRequests.id, id)))[0].status;
  k.payOut = async (id, by = k.ctx, method) => {
    await k.fin.refunds.attach(by, id, { mediaAssetId: 'media_x', fileName: 'slip.jpg' }).catch(() => undefined);
    return await k.fin.refunds.recordPayout(by, id, { paidFromMethodId: method ?? k.methodId.CASH, reference: `PAY-${++seq}` });
  };
  k.workflow = async (trigger, approverUserId, condition = { op: 'eq', field: 'methodKind', value: 'mobile_money' }) => {
    const wf = await k.c.approvalConfig.createWorkflow(k.companyId, { code: `W-${randomUUID().slice(0, 8)}`, name: 'Kit test', trigger }, { type: 'user', id: 'tester' });
    await k.c.approvalConfig.saveDraft(k.companyId, wf.id, { conditions: condition, steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: approverUserId } }] } as never, { type: 'user', id: 'tester' });
    await k.c.approvalConfig.publish(k.companyId, wf.id, { type: 'user', id: 'tester' }, { code: 'POLICY_CHANGE' });
    return wf;
  };
  k.openEntry = async (documentKind, id) => required((await k.c.approvals.forDocument(k.companyId, documentKind, id)).flatMap((r) => r.entries).find((e) => e.status === 'open'));
  k.approve = (entryId, by) => k.withAfterCommit(k.db, (tx) => k.c.approvals.approve(entryId, by, null, tx));
  k.glNet = async (no) => {
    const [r] = await k.db.execute<{ n: string }>(sql`SELECT COALESCE(SUM(base_credit - base_debit),0)::text n FROM gl_account_balances WHERE company_id=${k.companyId}::uuid AND account_id=${k.acct[no]}::uuid`);
    return Number(r.n);
  };
  return k;
}
