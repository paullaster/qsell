import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { has } from '@/lib/has';
import { required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { FinanceServices } from './index';
import type { AppContainer } from '@/server/di/container';
import type { CustomerMasterService } from '@/server/domains/customers/master-service';
import type * as mod_errors from './errors';
import type { FinanceContext } from './errors';
import type { PolicyInput } from './receivables/credit-policy-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('customer wallet (database)', () => {
  type Db = DrizzleDb;
  let db: Db;
  let schema: typeof mod_server_db_drizzle_schema;
  let fin: FinanceServices;
  let container: AppContainer;
  let master: CustomerMasterService;
  let FinanceError: typeof mod_errors.FinanceError;
  let companyId: string;
  let ctx: FinanceContext;
  const acct: Record<string, string> = {};
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 7);
  const origin = { surface: 'test', action: 'run' };
  // The day the books are on: policies and postings are dated by it, so the tests must be too.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof FinanceError) return e.code;
      return `OTHER:${(e as Error).message}`;
    }
  };
  const policy = (o: Partial<PolicyInput> = {}) =>
    fin.creditPolicy.save(ctx, { groupCode: null, walletEnabled: true, allowDeposits: true, overpaymentDefault: 'ask', autoApply: 'never', creditNoteExcess: 'ask', refundsEnabled: true, walletCashOut: false, maxBalance: null, label: 'Wallet', ...o });
  async function customer() {
    seq += 1;
    const [c] = await db.insert(schema.customers).values({ companyId, number: `W${run}${seq}`, name: `Wallet ${seq}`, accountType: 'credit', creditLimit: '10000000' }).returning();
    return c;
  }
  async function invoice(c: { id: string }, amount: number) {
    const id = await fin.customerLedger.addEntry(db, { companyId, customerId: c.id, documentType: 'invoice', documentNo: `WI-${run}-${++seq}`, amountCents: amount * 100, currency: 'KES', postingDate: '2026-09-01', dueDate: new Date('2026-09-30T00:00:00Z') });
    await db.update(schema.customers).set({ balance: sql`${schema.customers.balance} + ${amount}` }).where(eq(schema.customers.id, c.id));
    return id;
  }
  async function receipt(c: { id: string }, amount: string, o: { deposit?: boolean; allocate?: 'oldest_first' | 'none' } = {}) {
    const cash = required((await fin.paymentMethods.list(companyId)).find((m) => m.method.code === 'CASH')).method.id;
    const r = await fin.receipts.create(ctx, { customerId: c.id, paymentMethodId: cash, amount, paymentDate: today, isDeposit: o.deposit });
    await fin.receipts.post(ctx, r.id, { allocate: o.allocate ?? 'oldest_first' });
    return r.id;
  }
  const wallet = async (c: { id: string }) => (await db.select().from(schema.customerWallets).where(eq(schema.customerWallets.customerId, c.id)))[0];
  const bal = async (c: { id: string }) => (await wallet(c))?.balance ?? '0.00';
  const remaining = async (id: string) => (await db.select().from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.id, id)))[0].remainingAmount;
  const entries = async (c: { id: string }) => (await db.select().from(schema.walletEntries).where(eq(schema.walletEntries.customerId, c.id)).orderBy(schema.walletEntries.id)).map((e) => [e.entryType, e.amount] as const);
  const glNet = async (no: string) => {
    const [r] = await db.execute<{ n: string }>(sql`SELECT COALESCE(SUM(base_credit - base_debit),0)::text n FROM gl_account_balances WHERE company_id=${companyId}::uuid AND account_id=${acct[no]}::uuid`);
    return Number(r.n);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ FinanceError } = await import('./errors'));
    const { getContainer } = await import('@/server/di/container');
    container = getContainer();
    fin = container.finance;
    const { CustomerMasterService } = await import('@/server/domains/customers/master-service');
    master = new CustomerMasterService(db, {} as never, new (await import('@/server/domains/transactions/ledger-service')).TransactionLedgerService(db));
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'WL', tradingName: 'WL', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    companyId = company.id;
    await container.reasonCodes.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    for (const a of await fin.setup.listAccounts(companyId)) acct[a.no] = a.id;
  });

  it('with no policy there is no wallet: excess stays an unapplied credit, as before', async () => {
    const c = await customer();
    const r = await receipt(c, '500');
    expect(await codeOf(fin.wallets.moveReceiptToWallet(ctx, r))).toBe('WALLET_OFF');
    expect(required((await fin.receipts.detail(companyId, r))).unappliedCents).toBe(50000);
    expect(await wallet(c)).toBeUndefined();
  });

  it('moves an unapplied receipt into the wallet: liability up, customer credit gone, never a debtor', async () => {
    await policy();
    const c = await customer();
    const inv = await invoice(c, 300);
    const r = await receipt(c, '1000'); // 300 to the invoice, 700 over
    expect(required((await fin.receipts.detail(companyId, r))).unappliedCents).toBe(70000);
    await fin.wallets.moveReceiptToWallet(ctx, r, { cents: 20000 });
    expect(await bal(c)).toBe('200.00');
    expect(required((await fin.receipts.detail(companyId, r))).unappliedCents).toBe(50000);
    expect(await codeOf(fin.wallets.moveReceiptToWallet(ctx, r, { cents: 60000 }))).toBe('NOTHING_TO_MOVE');
    await fin.wallets.moveReceiptToWallet(ctx, r);
    expect(await bal(c)).toBe('700.00');
    expect(required((await fin.receipts.detail(companyId, r))).unappliedCents).toBe(0);
    expect(await entries(c)).toEqual([['overpayment', '200.00'], ['overpayment', '500.00']]);
    expect(await remaining(inv)).toBe('0.00');
    expect(await fin.customerLedger.drift(companyId)).toEqual([]);
  });

  it('an advance deposit needs the wallet on and deposits allowed, then goes straight in', async () => {
    const c = await customer();
    await policy({ walletEnabled: false });
    expect(await codeOf(receipt(c, '100', { deposit: true }))).toBe('WALLET_OFF');
    await policy({ allowDeposits: false });
    expect(await codeOf(receipt(c, '100', { deposit: true }))).toBe('DEPOSITS_OFF');
    await policy();
    const r = await receipt(c, '2500', { deposit: true });
    expect(await bal(c)).toBe('2500.00');
    expect(await entries(c)).toEqual([['deposit', '2500.00']]);
    expect(required((await fin.receipts.detail(companyId, r))).unappliedCents).toBe(0);
    const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r));
    expect(bank.map((b) => b.amount)).toEqual(['2500.0000']);
  });

  it('with the policy "overpayment to wallet", the excess goes in at posting; a frozen wallet just leaves it unapplied', async () => {
    await policy({ overpaymentDefault: 'wallet' });
    const c = await customer();
    await invoice(c, 100);
    await receipt(c, '400');
    expect(await bal(c)).toBe('300.00');
    await fin.wallets.setFrozen(ctx, c.id, 'KES', true, 'dispute');
    const r2 = await receipt(c, '50');
    expect(await bal(c)).toBe('300.00');
    expect(required((await fin.receipts.detail(companyId, r2))).unappliedCents).toBe(5000);
    expect(required((await fin.receipts.detail(companyId, r2))).events.map((e) => e.event)).toContain('wallet_move_skipped');
    await policy();
  });

  it('a wallet limit refuses what would go over it', async () => {
    await policy({ maxBalance: '1000' });
    const c = await customer();
    const r = await receipt(c, '800');
    await fin.wallets.moveReceiptToWallet(ctx, r, { cents: 80000 });
    const r2 = await receipt(c, '500');
    expect(await codeOf(fin.wallets.moveReceiptToWallet(ctx, r2))).toBe('WALLET_LIMIT');
    await policy();
  });

  it('pays invoices from the wallet, never more than it holds, never when frozen', async () => {
    const c = await customer();
    await receipt(c, '1000', { deposit: true });
    const a = await invoice(c, 600);
    const b = await invoice(c, 900);
    await fin.wallets.utilise(ctx, { customerId: c.id, currency: 'KES', applications: 'oldest_first' });
    expect(await bal(c)).toBe('0.00');
    expect(await remaining(a)).toBe('0.00');
    expect(await remaining(b)).toBe('500.00');
    expect(await codeOf(fin.wallets.utilise(ctx, { customerId: c.id, currency: 'KES', applications: [{ entryId: b, amountCents: 100 }] }))).toBe('WALLET_INSUFFICIENT');
    await fin.wallets.setFrozen(ctx, c.id, 'KES', true);
    expect(await codeOf(fin.wallets.utilise(ctx, { customerId: c.id, currency: 'KES', applications: 'oldest_first' }))).toBe('WALLET_FROZEN');
    expect(await fin.customerLedger.drift(companyId)).toEqual([]);
  });

  it('two uses at once cannot spend the same money twice', async () => {
    const c = await customer();
    await receipt(c, '1000', { deposit: true });
    const a = await invoice(c, 800);
    const b = await invoice(c, 800);
    const out = await Promise.all([
      codeOf(fin.wallets.utilise(ctx, { customerId: c.id, currency: 'KES', applications: [{ entryId: a, amountCents: 80000 }] })),
      codeOf(fin.wallets.utilise(ctx, { customerId: c.id, currency: 'KES', applications: [{ entryId: b, amountCents: 80000 }] })),
    ]);
    expect(out.sort()).toEqual(['OK', 'WALLET_INSUFFICIENT']);
    expect(await bal(c)).toBe('200.00');
  });

  it('undoes a use once: the invoice is owed again and the money is back', async () => {
    const c = await customer();
    await receipt(c, '700', { deposit: true });
    const inv = await invoice(c, 400);
    const out = await fin.wallets.utilise(ctx, { customerId: c.id, currency: 'KES', applications: 'oldest_first' });
    expect(await bal(c)).toBe('300.00');
    await fin.wallets.reverseUtilisation(ctx, out.walletEntryId, { code: 'DATA_ENTRY_ERROR' });
    expect(await bal(c)).toBe('700.00');
    expect(await remaining(inv)).toBe('400.00');
    expect(await codeOf(fin.wallets.reverseUtilisation(ctx, out.walletEntryId, { code: 'DATA_ENTRY_ERROR' }))).toBe('ALREADY_REVERSED');
    expect(await fin.customerLedger.drift(companyId)).toEqual([]);
  });

  it('on a new credit invoice the wallet pays by itself when the policy says so, and the sale always goes ahead', async () => {
    await policy({ autoApply: 'oldest_first' });
    const c = await customer();
    await receipt(c, '300', { deposit: true });
    const id = `wa_${run}_${++seq}`;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, trade_customer_id) VALUES (${id}, ${`WO-${run}-${seq}`}, 'u', 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 1000, 0, 0, 1000, 'on_account', ${c.id}::uuid)`);
    await master.postInvoice({ customer: c, orderId: id, orderNumber: `WO-${run}-${seq}`, amount: 1000, currency: 'KES' });
    const [inv] = await db.select().from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.orderId, id));
    expect(inv.remainingAmount).toBe('700.00');
    expect(await bal(c)).toBe('0.00');
    const [cust] = await db.select().from(schema.customers).where(eq(schema.customers.id, c.id));
    expect(cust.balance).toBe('700.00');
    // a frozen wallet never stops a sale
    const c2 = await customer();
    await receipt(c2, '300', { deposit: true });
    await fin.wallets.setFrozen(ctx, c2.id, 'KES', true);
    const id2 = `wb_${run}_${++seq}`;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, trade_customer_id) VALUES (${id2}, ${`WO-${run}-${seq}`}, 'u', 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 500, 0, 0, 500, 'on_account', ${c2.id}::uuid)`);
    await master.postInvoice({ customer: c2, orderId: id2, orderNumber: `WO-${run}-${seq}`, amount: 500, currency: 'KES' });
    const [inv2] = await db.select().from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.orderId, id2));
    expect(inv2.remainingAmount).toBe('500.00');
    await policy();
  });

  it('the wallet pays an order at the till; a cancelled order gives it back', async () => {
    const c = await customer();
    await receipt(c, '600', { deposit: true });
    const id = `wt_${run}_${++seq}`;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, trade_customer_id) VALUES (${id}, ${`WT-${run}-${seq}`}, 'u', 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 1000, 0, 0, 1000, 'mpesa_daraja', ${c.id}::uuid)`);
    const res = await container.tenders.apply(companyId, id, { wallet: 'all' }, { type: 'user', id: 'tester' });
    expect(res).toMatchObject({ tendered: 600, due: 400, paid: false });
    expect(await bal(c)).toBe('0.00');
    expect((await entries(c)).map((e) => e[0])).toEqual(['deposit', 'tender']);
    await expect(container.tenders.apply(companyId, id, { wallet: 'all' }, { type: 'user', id: 'tester' })).rejects.toThrow(/nothing in the wallet|only/i);
    await db.transaction((tx) => container.tenders.reverseOrder(tx, id));
    await db.transaction((tx) => container.tenders.reverseOrder(tx, id)); // twice: once
    expect(await bal(c)).toBe('600.00');
  });

  it('a receipt moved to the wallet can be reversed only while that money is still there', async () => {
    const c = await customer();
    const r = await receipt(c, '1000', { deposit: true });
    const inv = await invoice(c, 700);
    await fin.wallets.utilise(ctx, { customerId: c.id, currency: 'KES', applications: 'oldest_first' });
    expect(await codeOf(fin.receipts.reverse(ctx, r, { code: 'DATA_ENTRY_ERROR' }))).toBe('WALLET_USED');
    const used = (await db.select().from(schema.walletEntries).where(and(eq(schema.walletEntries.customerId, c.id), eq(schema.walletEntries.entryType, 'utilisation'))))[0];
    await fin.wallets.reverseUtilisation(ctx, used.id, { code: 'DATA_ENTRY_ERROR' });
    expect(await remaining(inv)).toBe('700.00');
    await fin.receipts.reverse(ctx, r, { code: 'DATA_ENTRY_ERROR' });
    expect(await bal(c)).toBe('0.00');
    expect(required((await fin.receipts.detail(companyId, r))).receipt.status).toBe('reversed');
    expect(await fin.customerLedger.drift(companyId)).toEqual([]);
  });

  it('is append-only and never negative, enforced by the database', async () => {
    const c = await customer();
    await receipt(c, '100', { deposit: true });
    const w = (await wallet(c));
    await expect(db.update(schema.walletEntries).set({ amount: '1.00' }).where(eq(schema.walletEntries.walletId, w.id))).rejects.toThrow();
    await expect(db.delete(schema.walletEntries).where(eq(schema.walletEntries.walletId, w.id))).rejects.toThrow();
    await expect(db.update(schema.customerWallets).set({ balance: '-1.00' }).where(eq(schema.customerWallets.id, w.id))).rejects.toThrow();
    await expect(db.delete(schema.customerWallets).where(eq(schema.customerWallets.id, w.id))).rejects.toThrow();
  });

  describe('in the books, once sales are live', () => {
    beforeAll(async () => {
      await policy();
      await fin.salesPosting.goLive(ctx, { offsetAccountId: acct['3100'] });
    });

    it('go-live brought the existing wallets in as a liability', async () => {
      expect(await glNet('2210')).toBeGreaterThan(0);
      const recon = await fin.wallets.reconciliation(companyId);
      expect(recon.map((r) => r.diffCents)).toEqual([0]);
    });

    it('moving to the wallet, using it and undoing it keep the books and the wallets in agreement', async () => {
      const c = await customer();
      const r = await receipt(c, '900', { deposit: true });
      const [rec] = await fin.wallets.reconciliation(companyId);
      expect(rec.diffCents).toBe(0);
      const reg = await db.select().from(schema.ledgerRegisters).where(and(eq(schema.ledgerRegisters.companyId, companyId), eq(schema.ledgerRegisters.sourceId, r), eq(schema.ledgerRegisters.documentType, 'wallet_credit')));
      expect(reg).toHaveLength(1);
      const lines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, reg[0].id));
      const no = new Map(Object.entries(acct).map(([n, id]) => [id, n]));
      expect(lines.map((l) => [no.get(l.accountId), Number(l.debit), Number(l.credit)]).sort()).toEqual([['1210', 900, 0], ['2210', 0, 900]]);

      const inv = await invoice(c, 500);
      const out = await fin.wallets.utilise(ctx, { customerId: c.id, currency: 'KES', applications: 'oldest_first' });
      await fin.salesPosting.processDue();
      const [post] = await db.select().from(schema.financeSalesPostings).where(and(eq(schema.financeSalesPostings.kind, 'wallet_use'), eq(schema.financeSalesPostings.subjectId, String(out.walletEntryId))));
      expect(post).toMatchObject({ status: 'posted' });
      const useLines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, required(post.registerId)));
      expect(useLines.map((l) => [no.get(l.accountId), Number(l.debit), Number(l.credit)]).sort()).toEqual([['1210', 0, 500], ['2210', 500, 0]]);
      expect((await fin.wallets.reconciliation(companyId))[0].diffCents).toBe(0);

      await fin.wallets.reverseUtilisation(ctx, out.walletEntryId, { code: 'DATA_ENTRY_ERROR' });
      expect(await remaining(inv)).toBe('500.00');
      expect((await fin.wallets.reconciliation(companyId))[0].diffCents).toBe(0);
    });

    it('a use that has not reached the books yet is simply cancelled if undone', async () => {
      const c = await customer();
      await receipt(c, '300', { deposit: true });
      await invoice(c, 300);
      const out = await db.transaction((tx) => (fin.wallets as unknown as { utiliseIn: (tx: unknown, c: unknown, i: unknown) => Promise<{ walletEntryId: number }> }).utiliseIn(tx, ctx, { customerId: c.id, currency: 'KES', applications: 'oldest_first' }));
      await fin.wallets.reverseUtilisation(ctx, out.walletEntryId, { code: 'DATA_ENTRY_ERROR' });
      const [post] = await db.select().from(schema.financeSalesPostings).where(and(eq(schema.financeSalesPostings.kind, 'wallet_use'), eq(schema.financeSalesPostings.subjectId, String(out.walletEntryId))));
      expect(post.status).toBe('skipped');
    });

    it('a wallet-paid cash sale debits customer deposits, not a bank', async () => {
      const c = await customer();
      await receipt(c, '1000', { deposit: true });
      const id = `wc_${run}_${++seq}`;
      await db.execute(sql`INSERT INTO orders (id, order_number, user_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, trade_customer_id) VALUES (${id}, ${`WC-${run}-${seq}`}, 'u', 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 1000, 0, 0, 1000, 'mpesa_daraja', ${c.id}::uuid)`);
      await container.tenders.apply(companyId, id, { wallet: 'all' }, { type: 'user', id: 'tester' });
      // a cash customer's order: paid in full by the wallet
      await db.update(schema.customers).set({ accountType: 'cash' }).where(eq(schema.customers.id, c.id));
      const [cust] = await db.select().from(schema.customers).where(eq(schema.customers.id, c.id));
      await master.postInvoice({ customer: cust, orderId: id, orderNumber: `WC-${run}-${seq}`, amount: 1000, currency: 'KES' });
      await db.execute(sql`UPDATE orders SET payment_status='paid', transaction_reference='TENDER-X' WHERE id = ${id}`);
      await master.applyOrderPayment(id);
      await fin.salesPosting.processDue();
      const [row] = await db.select().from(schema.financeSalesPostings).where(and(eq(schema.financeSalesPostings.kind, 'cash_sale'), eq(schema.financeSalesPostings.subjectId, id)));
      expect(row).toMatchObject({ status: 'posted' });
      const lines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, required(row.registerId)));
      const no = new Map(Object.entries(acct).map(([n, aid]) => [aid, n]));
      expect(lines.map((l) => [no.get(l.accountId), Number(l.debit), Number(l.credit)]).sort()).toEqual([['2210', 1000, 0], ['4100', 0, 1000]]);
      expect((await fin.wallets.reconciliation(companyId))[0].diffCents).toBe(0);
    });

    it('nothing drifts and the books balance', async () => {
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
      const r = await fin.maintenance.checkIntegrity(companyId);
      expect(r.balanceDrift).toBe(0);
      expect(r.customerDrift).toBe(0);
    });
  });
});
