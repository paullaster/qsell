import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { has } from '@/lib/has';
import { required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { FinanceServices } from './index';
import type { CustomerMasterService } from '@/server/domains/customers/master-service';
import type { FinanceContext } from './errors';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('sales posting (database)', () => {
  type Db = DrizzleDb;
  let db: Db;
  let schema: typeof mod_server_db_drizzle_schema;
  let fin: FinanceServices;
  let master: CustomerMasterService;
  let companyId: string;
  let ctx: FinanceContext;
  const acct: Record<string, string> = {};
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 7);
  const origin = { surface: 'test', action: 'run' };
  // The day the books are on: policies and postings are dated by it, so the tests must be too.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

  async function customer(type: 'credit' | 'cash') {
    seq += 1;
    const [c] = await db
      .insert(schema.customers)
      .values({ companyId, number: `SP${run}${seq}`, name: `Sales ${seq}`, accountType: type, creditLimit: '10000000', paymentTermDays: 14 })
      .returning();
    return c;
  }
  /** An order row as checkout leaves it. */
  async function order(c: { id: string }, o: { total: number; tax?: number; shipping?: number; method?: string; currency?: string; tendered?: number }) {
    seq += 1;
    const id = `sp_${run}_${seq}`;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, currency, payment_method, trade_customer_id, tendered_amount)
      VALUES (${id}, ${`SO-${run}-${seq}`}, 'u', 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, ${o.total - (o.tax ?? 0) - (o.shipping ?? 0)}, ${o.tax ?? 0}, ${o.shipping ?? 0}, ${o.total}, ${o.currency ?? 'KES'}, ${o.method ?? 'mpesa_daraja'}, ${c.id}::uuid, ${o.tendered ?? 0})`);
    return { id, number: `SO-${run}-${seq}` };
  }
  const invoice = async (c: Awaited<ReturnType<typeof customer>>, ord: { id: string; number: string }, total: number) =>
    await master.postInvoice({ customer: c, orderId: ord.id, orderNumber: ord.number, amount: total, currency: 'KES' });
  const rows = async (kind?: string) =>
    (await db.select().from(schema.financeSalesPostings).where(and(eq(schema.financeSalesPostings.companyId, companyId), has(kind) ? eq(schema.financeSalesPostings.kind, kind as never) : undefined)));
  const glFor = async (registerId: string) => {
    const lines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId));
    const no = new Map(Object.entries(acct).map(([n, id]) => [id, n]));
    return lines.map((l) => [required(no.get(l.accountId)), Number(l.debit), Number(l.credit)] as const).sort((a, b) => a[0].localeCompare(b[0]));
  };
  const reconcile = async () => (await fin.salesPosting.reconciliation(companyId)).rows.map((r) => r.diffCents);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const container = getContainer();
    fin = container.finance;
    const { CustomerMasterService } = await import('@/server/domains/customers/master-service');
    master = new CustomerMasterService(db, {} as never, new (await import('@/server/domains/transactions/ledger-service')).TransactionLedgerService(db));
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'SP', tradingName: 'SP', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = company.id;
    await container.reasonCodes.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    for (const a of await fin.setup.listAccounts(companyId)) acct[a.no] = a.id;
  });

  it('before go-live: a credit invoice is not queued, a cash sale writes its bank movement only', async () => {
    const credit = await customer('credit');
    const o1 = await order(credit, { total: 1000 });
    await invoice(credit, o1, 1000);
    expect(await rows('invoice')).toHaveLength(0);

    const cash = await customer('cash');
    const o2 = await order(cash, { total: 1160, tax: 160 });
    await invoice(cash, o2, 1160);
    await master.applyOrderPayment(o2.id).catch(() => undefined);
    // a cash order's payment reference comes from the order; give it one, as the gateway does
    await db.execute(sql`UPDATE orders SET transaction_reference = 'QX1', payment_status = 'paid' WHERE id = ${o2.id}`);
    await master.applyOrderPayment(o2.id);
    expect(await rows('cash_sale')).toHaveLength(1);
    await fin.salesPosting.processDue();
    const [row] = await rows('cash_sale');
    expect(row).toMatchObject({ status: 'posted', registerId: null });
    const bank = await db.select().from(schema.bankLedgerEntries).where(and(eq(schema.bankLedgerEntries.companyId, companyId), eq(schema.bankLedgerEntries.documentNo, o2.number)));
    expect(bank.map((b) => b.amount)).toEqual(['1160.0000']);
    // nothing in the general ledger
    expect((await db.select().from(schema.glEntries).where(eq(schema.glEntries.companyId, companyId)))).toHaveLength(0);
  });

  it('readiness names what is missing', async () => {
    const checks = await fin.salesPosting.readiness(companyId);
    expect(checks.filter((c) => c.blocking && !c.ok)).toEqual([]);
    await db.update(schema.financeSettings).set({ outputTaxAccountId: null }).where(eq(schema.financeSettings.companyId, companyId));
    const broken = await fin.salesPosting.readiness(companyId);
    expect(broken.find((c) => c.key === 'tax')).toMatchObject({ ok: false });
    await fin.salesPosting.setOutputTaxAccount(ctx, acct['2310']);
    expect(await fin.salesPosting.setOutputTaxAccount(ctx, acct['6200']).catch((e: Error) => e.message)).toMatch(/liability/);
  });

  it('go-live brings in what customers owe, once, and the books agree with the accounts', async () => {
    // customers who owe money today (from before the books started)
    const owing = await customer('credit');
    await fin.customerLedger.addEntry(db, { companyId, customerId: owing.id, documentType: 'invoice', documentNo: `OLD-${run}`, amountCents: 250000, currency: 'KES', postingDate: '2026-09-01' });
    await db.update(schema.customers).set({ balance: '2500.00' }).where(eq(schema.customers.id, owing.id));
    expect(await fin.salesPosting.goLive(ctx, { offsetAccountId: acct['6200'] }).catch((e: Error) => e.message)).toMatch(/not an equity/);
    const out = await fin.salesPosting.goLive(ctx, { offsetAccountId: acct['3100'] });
    expect(out.opening).toEqual([{ group: 'DOMESTIC', amount: '3500.00' }]); // 1000 from the first test + 2500
    expect(await fin.salesPosting.goLive(ctx, { offsetAccountId: acct['3100'] }).catch((e: { code?: string }) => e.code)).toBe('ALREADY_LIVE');
    expect(await reconcile()).toEqual([0]);
  });

  it('a credit invoice reaches the ledger with sales, tax and shipping, and stays in agreement', async () => {
    const c = await customer('credit');
    const o = await order(c, { total: 11600, tax: 1600, shipping: 500 });
    await invoice(c, o, 11600);
    const [q] = await rows('invoice');
    expect(q).toMatchObject({ status: 'pending', subjectId: o.id });
    // the sale already exists; the ledger catches up
    await fin.salesPosting.processDue();
    const [done] = (await rows('invoice')).filter((r) => r.status === 'posted');
    expect(done.status).toBe('posted');
    expect(await glFor(required(done.registerId))).toEqual([['1210', 11600, 0], ['2310', 0, 1600], ['4100', 0, 9500], ['4400', 0, 500]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(await reconcile()).toEqual([0]);
    // queued twice, posted once
    await fin.salesPosting.attempt(done.id);
    expect((await rows('invoice')).length).toBe(1);
  });

  it('a gateway payment of a credit order moves money in and debt out', async () => {
    const c = await customer('credit');
    const o = await order(c, { total: 5000, method: 'mpesa_daraja' });
    await invoice(c, o, 5000);
    await fin.salesPosting.processDue();
    await db.execute(sql`UPDATE orders SET transaction_reference = 'MPESAQ1', payment_status = 'paid' WHERE id = ${o.id}`);
    await master.applyOrderPayment(o.id);
    await fin.salesPosting.processDue();
    const [p] = await rows('credit_payment');
    expect(p).toMatchObject({ status: 'posted' });
    expect(await glFor(required(p.registerId))).toEqual([['1125', 5000, 0], ['1210', 0, 5000]]);
    expect(await reconcile()).toEqual([0]);
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, o.id));
    expect(row.paymentMethodId).toBeNull(); // raw insert here; new orders get it from the repository
  });

  it('a cash sale paid by M-Pesa plus a gift card debits both, and credits sales and tax', async () => {
    const c = await customer('cash');
    const o = await order(c, { total: 10000, tax: 1379, tendered: 3000 });
    await invoice(c, o, 10000);
    await db.insert(schema.orderTenders).values({ orderId: o.id, kind: 'gift_card', reference: 'GC1', amount: '3000.00', actor: 't' });
    await db.execute(sql`UPDATE orders SET transaction_reference = 'MP2', payment_status = 'paid' WHERE id = ${o.id}`);
    await master.applyOrderPayment(o.id);
    await fin.salesPosting.processDue();
    const row = required((await rows('cash_sale')).find((r) => r.subjectId === o.id));
    expect(row.status).toBe('posted');
    expect(await glFor(required(row.registerId))).toEqual([['1125', 7000, 0], ['2230', 3000, 0], ['2310', 0, 1379], ['4100', 0, 8621]]);
    expect(await reconcile()).toEqual([0]);
  });

  it('a set-up mistake never stops the sale: the posting waits, says why, and succeeds once fixed', async () => {
    const c = await customer('credit');
    const o = await order(c, { total: 2100, shipping: 100 });
    await db.execute(sql`UPDATE customer_posting_groups SET service_charge_account_id = NULL WHERE company_id = ${companyId}::uuid AND code = 'DOMESTIC'`);
    await invoice(c, o, 2100); // the sale itself succeeds
    const r1 = await fin.salesPosting.processDue();
    expect(r1.failed).toBeGreaterThan(0);
    const [waiting] = (await rows('invoice')).filter((r) => r.subjectId === o.id);
    expect(waiting).toMatchObject({ status: 'failed' });
    expect(waiting.lastError).toMatch(/service_charge/);
    expect(await fin.salesPosting.backlog(companyId)).toMatchObject({ failed: expect.any(Number) });
    await fin.salesPosting.saveCustomerGroupAccounts(ctx, 'DOMESTIC', { service_charge: acct['4400'] });
    const r2 = await fin.salesPosting.retry(ctx, waiting.id);
    expect(r2.posted).toBeGreaterThanOrEqual(1);
    expect(required((await rows('invoice')).find((r) => r.subjectId === o.id)).status).toBe('posted');
    expect(await reconcile()).toEqual([0]);
  });

  it('a foreign-currency sale waits with a clear reason instead of posting a wrong amount', async () => {
    const c = await customer('credit');
    const o = await order(c, { total: 100, currency: 'USD' });
    await master.postInvoice({ customer: c, orderId: o.id, orderNumber: o.number, amount: 100, currency: 'USD' });
    await fin.salesPosting.processDue();
    const r = required((await rows('invoice')).find((x) => x.subjectId === o.id));
    expect(r.status).toBe('failed');
    expect(r.lastError).toMatch(/foreign currency/);
    // the receivables reconciliation says what it left out
    expect((await fin.salesPosting.reconciliation(companyId)).rows[0].foreignEntries).toBeGreaterThan(0);
  });

  it('a rebate credited to a customer costs the business and reduces the debt, in the books too', async () => {
    const c = await customer('credit');
    const o = await order(c, { total: 4000 });
    await invoice(c, o, 4000);
    await fin.salesPosting.processDue();
    // what the rebate settlement writes: a credit entry, applied to the invoice
    const [inv] = await db.select().from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.orderId, o.id));
    const credit = await fin.customerLedger.addEntry(db, { companyId, customerId: c.id, documentType: 'rebate_credit', documentNo: `RBT-${run}`, amountCents: -60000, currency: 'KES', postingDate: today });
    await db.transaction((tx) => fin.customerLedger.applyIn(tx, ctx, { customerId: c.id, creditEntryId: credit, applications: [{ entryId: inv.id, amountCents: 60000 }], postingDate: today, createdBy: null }));
    await fin.salesPosting.enqueue(db, { companyId, kind: 'rebate_credit', subjectId: credit });
    await fin.salesPosting.processDue();
    const r = required((await rows('rebate_credit')).find((x) => x.subjectId === credit));
    expect(r.status).toBe('posted');
    expect(await glFor(required(r.registerId))).toEqual([['1210', 0, 600], ['6310', 600, 0]]);
    await db.execute(sql`UPDATE customers SET balance = balance - 600 WHERE id = ${c.id}::uuid`);
    expect(await reconcile()).toEqual([0]);
  });

  it('refuses money taken by hand outside Receipts once the books are live', async () => {
    const c = await customer('credit');
    const o = await order(c, { total: 300 });
    await invoice(c, o, 300);
    await expect(master.receivePayment(companyId, c.id, { amount: 300, reference: 'HAND1', currency: 'KES' })).rejects.toThrow(/Finance → Receipts/);
  });

  it('manual receipts keep the control account in agreement too', async () => {
    const c = await customer('credit');
    const o = await order(c, { total: 700 });
    await invoice(c, o, 700);
    await fin.salesPosting.processDue();
    const r = await fin.receipts.create(ctx, { customerId: c.id, paymentMethodId: required((await fin.paymentMethods.list(companyId)).find((m) => m.method.code === 'CASH')).method.id, amount: '700', paymentDate: today });
    await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
    expect(await reconcile()).toEqual([0]);
  });

  it('every queued event is accounted for: nothing stuck, books balanced, history intact', async () => {
    // (the foreign-currency invoice is the one event that is meant to still be waiting)
    const waiting = (await rows()).filter((r) => r.status !== 'posted');
    expect(waiting.map((r) => r.kind)).toEqual(['invoice']);
    expect((await fin.maintenance.checkIntegrity(companyId)).balanceDrift).toBe(0);
    expect(await fin.customerLedger.drift(companyId)).toEqual([]);
  });
});
