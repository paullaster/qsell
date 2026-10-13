import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('credit notes: accounting and returns (database)', () => {
  type Db = import('@/server/db/drizzle/client').DrizzleDb;
  let db: Db;
  let schema: typeof import('@/server/db/drizzle/schema');
  let c: import('@/server/di/container').AppContainer;
  let fin: import('./index').FinanceServices;
  let master: import('@/server/domains/customers/master-service').CustomerMasterService;
  let FinanceError: typeof import('./errors').FinanceError;
  let ReturnError: typeof import('@/server/domains/returns/return-receipt-service').ReturnError;
  let companyId: string;
  let branchId: string;
  let productId: string;
  let ctx: import('./errors').FinanceContext;
  const acct: Record<string, string> = {};
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  const origin = { surface: 'test', action: 'run' };
  // The day the books are on: policies and postings are dated by it, so the tests must be too.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
  const actor = { companyId: '', actorId: 'tester', origin: { surface: 'test', action: 'run' } };

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e) return String((e as { code: unknown }).code);
      return `OTHER:${(e as Error).message}`;
    }
  };
  const policy = (o: Partial<import('./receivables/credit-policy-service').PolicyInput> = {}) =>
    fin.creditPolicy.save(ctx, { groupCode: null, walletEnabled: false, allowDeposits: true, overpaymentDefault: 'ask', autoApply: 'never', creditNoteExcess: 'ask', refundsEnabled: true, walletCashOut: false, maxBalance: null, label: 'Wallet', ...o });

  /** A sold order for a customer: two units at 580 (net 500 + tax 80 each), invoiced and with a tax invoice. */
  async function sold(type: 'credit' | 'cash', qty = 2) {
    seq += 1;
    const [cust] = await db.insert(schema.customers).values({ companyId, number: `CN${run}${seq}`, name: `CN customer ${seq}`, accountType: type, creditLimit: '10000000', paymentTermDays: 30 }).returning();
    const id = `cn_${run}_${seq}`;
    const total = 580 * qty;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, trade_customer_id)
      VALUES (${id}, ${`CNO-${run}-${seq}`}, 'u', ${branchId}::uuid, 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, ${500 * qty}, ${80 * qty}, 0, ${total}, ${type === 'credit' ? 'on_account' : 'mpesa_daraja'}, ${cust!.id}::uuid)`);
    await db.insert(schema.orderItems).values({ orderId: id, productId, productName: 'Widget', sku: 'W', quantity: qty, unitPrice: '580.00', totalPrice: total.toFixed(2), imageUrl: '', unitCost: '300.0000' });
    await master.postInvoice({ customer: cust!, orderId: id, orderNumber: `CNO-${run}-${seq}`, amount: total, currency: 'KES' });
    // stock really left for this order (the rule that lets goods come back)
    await db.insert(schema.inventoryMovements).values({ id: `mv_${randomUUID()}`, productId, productName: 'Widget', changeAmount: 0, previousStock: 10, newStock: 10, changeType: 'order_fulfillment', referenceId: id });
    await db.insert(schema.invoiceDocuments).values({ orderId: id, orderNumber: `CNO-${run}-${seq}`, invoiceNumber: `TI-${run}-${seq}`, documentType: 'tax_invoice', customerEmail: 'e@x.io', customerName: 'n', currency: 'KES', subtotal: String(500 * qty), tax: String(80 * qty), shippingFee: '0', totalAmount: String(total), pdfStorageKey: 'x.pdf', emailStatus: 'not_sent', meta: {} });
    return { id, customerId: cust!.id, number: `CNO-${run}-${seq}`, customer: cust! };
  }
  const issue = (orderId: string, quantity: number, o: { restock?: boolean } = {}) =>
    c.creditNotes.issueForOrder({ orderId, lines: [{ productId, quantity }], reason: { code: 'returned_goods' }, issuedBy: 'tester', restock: o.restock });
  const remainingOf = async (orderId: string) => (await db.select().from(schema.customerLedgerEntries).where(and(eq(schema.customerLedgerEntries.orderId, orderId), eq(schema.customerLedgerEntries.documentType, 'invoice'))))[0]!.remainingAmount;
  const accounting = async (cnId: string) => (await db.select().from(schema.creditNoteAccounting).where(eq(schema.creditNoteAccounting.creditNoteId, cnId)))[0]!;
  const stock = async () => (await db.select().from(schema.products).where(eq(schema.products.id, productId)))[0]!.stockQuantity;
  const wallet = async (customerId: string) => (await db.select().from(schema.customerWallets).where(eq(schema.customerWallets.customerId, customerId)))[0]?.balance ?? '0.00';
  const paid = async (cust: { id: string }, amount: string) => {
    const cash = (await fin.paymentMethods.list(companyId)).find((m) => m.method.code === 'CASH')!.method.id;
    const r = await fin.receipts.create(ctx, { customerId: cust.id, paymentMethodId: cash, amount, paymentDate: today });
    await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ FinanceError } = await import('./errors'));
    ({ ReturnError } = await import('@/server/domains/returns/return-receipt-service'));
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    fin = c.finance;
    const { CustomerMasterService } = await import('@/server/domains/customers/master-service');
    master = new CustomerMasterService(db, {} as never, new (await import('@/server/domains/transactions/ledger-service')).TransactionLedgerService(db));
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'CN', tradingName: 'CN', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    companyId = company!.id;
    actor.companyId = companyId;
    const [branch] = await db.insert(schema.branches).values({ companyId, code: `CN${run.toUpperCase()}`, name: 'CN branch', isDefault: true }).returning();
    branchId = branch!.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    for (const a of await fin.setup.listAccounts(companyId)) acct[a.no] = a.id;
    const itemTypeId = `it_${run}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `CN-${run}`.toUpperCase(), stockCode: `CNS-${run}`.toUpperCase(), name: 'Widget', slug: `cn-${randomUUID()}`, itemTypeId, price: '580', costPrice: '300', stockQuantity: 10, taxRate: '16', isTaxInclusive: true });
  });

  it('takes the credit off what the customer owes on the original invoice', async () => {
    const o = await sold('credit');
    const cn = await issue(o.id, 1);
    expect(await remainingOf(o.id)).toBe('580.00');
    const a = await accounting(cn.id);
    expect(a).toMatchObject({ gross: '580.00', taxAmount: '80.00', applied: '580.00', excess: '0.00' });
    const [cust] = await db.select().from(schema.customers).where(eq(schema.customers.id, o.customerId));
    expect(cust!.balance).toBe('580.00');
    expect(await fin.customerLedger.drift(companyId)).toEqual([]);
    expect((await fin.creditNoteAccounting.worklist(companyId)).filter((r) => r.a.creditNoteId === cn.id)).toEqual([]);
  });

  it('an invoice that was already paid leaves an excess that waits on a list', async () => {
    const o = await sold('credit');
    await paid(o.customer, '1160'); // paid in full
    const cn = await issue(o.id, 1);
    expect(await accounting(cn.id)).toMatchObject({ applied: '0.00', excess: '580.00' });
    const work = (await fin.creditNoteAccounting.worklist(companyId)).find((r) => r.a.creditNoteId === cn.id)!;
    expect(work.openCents).toBe(58000);
    expect((await fin.customerLedger.statement(companyId, o.customerId, null, null)).unappliedCents).toBe(58000);
  });

  it('a cash customer paid at the sale: the whole credit is excess', async () => {
    const o = await sold('cash');
    const cn = await issue(o.id, 2);
    expect(await accounting(cn.id)).toMatchObject({ gross: '1160.00', applied: '0.00', excess: '1160.00' });
  });

  it('settles an excess into the wallet, once, only when the policy allows it', async () => {
    const o = await sold('cash');
    const cn = await issue(o.id, 1);
    expect(await codeOf(fin.creditNoteAccounting.resolveToWallet(ctx, cn.id))).toBe('WALLET_OFF');
    await policy({ walletEnabled: true });
    await fin.creditNoteAccounting.resolveToWallet(ctx, cn.id);
    expect(await wallet(o.customerId)).toBe('580.00');
    expect(await codeOf(fin.creditNoteAccounting.resolveToWallet(ctx, cn.id))).toBe('NOTHING_TO_RESOLVE');
    expect((await fin.creditNoteAccounting.worklist(companyId)).some((r) => r.a.creditNoteId === cn.id)).toBe(false);
    const entry = (await db.select().from(schema.walletEntries).where(eq(schema.walletEntries.customerId, o.customerId)))[0]!;
    expect(entry).toMatchObject({ entryType: 'credit_note', amount: '580.00' });
    expect(await fin.customerLedger.drift(companyId)).toEqual([]);
  });

  it('with the policy "credit note excess to wallet" it goes in by itself; a frozen wallet leaves it on the list', async () => {
    await policy({ walletEnabled: true, creditNoteExcess: 'wallet' });
    const o = await sold('cash');
    const cn = await issue(o.id, 1);
    expect(await wallet(o.customerId)).toBe('580.00');
    expect((await fin.creditNoteAccounting.summaries(companyId, [cn.id])).get(cn.id)).toMatchObject({ openCents: 0 });
    const o2 = await sold('cash');
    await fin.wallets.setFrozen(ctx, o2.customerId, 'KES', true);
    const cn2 = await issue(o2.id, 1);
    expect((await fin.creditNoteAccounting.summaries(companyId, [cn2.id])).get(cn2.id)).toMatchObject({ openCents: 58000 });
    await policy();
  });

  it('uses an excess against the customer\'s other unpaid invoices', async () => {
    const o = await sold('credit');
    await paid(o.customer, '1160');
    const cn = await issue(o.id, 1); // 580 excess
    const mine = await (async () => {
      const id = `cn_${run}_${++seq}`;
      await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, trade_customer_id) VALUES (${id}, ${`CNO-${run}-${seq}`}, 'u', ${branchId}::uuid, 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 400, 0, 0, 400, 'on_account', ${o.customerId}::uuid)`);
      await master.postInvoice({ customer: o.customer, orderId: id, orderNumber: `CNO-${run}-${seq}`, amount: 400, currency: 'KES' });
      return id;
    })();
    const out = await fin.creditNoteAccounting.applyExcess(ctx, cn.id, 'oldest_first');
    expect(out.appliedCents).toBe(40000);
    expect(await remainingOf(mine)).toBe('0.00');
    const s = (await fin.creditNoteAccounting.summaries(companyId, [cn.id])).get(cn.id)!;
    expect(s.openCents).toBe(18000);
    expect(s.resolutions).toEqual([{ kind: 'applied', amount: '400.00' }]);
    expect(await fin.customerLedger.drift(companyId)).toEqual([]);
  });

  describe('goods coming back', () => {
    it('a credit note only asks for them: stock does not change until someone confirms', async () => {
      const before = await stock();
      const o = await sold('credit');
      const cn = await issue(o.id, 2, { restock: true });
      expect(await stock()).toBe(before);
      const [rr] = await db.select().from(schema.returnReceipts).where(eq(schema.returnReceipts.creditNoteId, cn.id));
      expect(rr).toMatchObject({ status: 'awaiting_goods' });
      expect(rr!.number).toMatch(/^RRC-/);
      const lines = await db.select().from(schema.returnReceiptLines).where(eq(schema.returnReceiptLines.receiptId, rr!.id));
      expect(lines).toMatchObject([{ expectedQty: 2, receivedQty: 0, unitCost: '300.0000' }]);
    });

    it('confirming adds only good goods to stock, in steps, and closes when complete', async () => {
      const before = await stock();
      const o = await sold('credit');
      const cn = await issue(o.id, 2, { restock: true });
      const [rr] = await db.select().from(schema.returnReceipts).where(eq(schema.returnReceipts.creditNoteId, cn.id));
      const [line] = await db.select().from(schema.returnReceiptLines).where(eq(schema.returnReceiptLines.receiptId, rr!.id));
      const svc = c.returns;
      expect(await codeOf(svc.confirm(actor, rr!.id, [{ lineId: line!.id, quantity: 1, condition: 'damaged', disposition: 'return_to_stock' }]))).toBe('DISPOSITION_INVALID');
      expect(await codeOf(svc.confirm(actor, rr!.id, [{ lineId: line!.id, quantity: 3, condition: 'good', disposition: 'return_to_stock' }]))).toBe('OVER_RECEIVED');
      expect(await stock()).toBe(before);
      const first = await svc.confirm(actor, rr!.id, [{ lineId: line!.id, quantity: 1, condition: 'good', disposition: 'return_to_stock' }]);
      expect(first).toEqual({ status: 'partially_confirmed', stockAdded: 1 });
      expect(await stock()).toBe(before + 1);
      const second = await svc.confirm(actor, rr!.id, [{ lineId: line!.id, quantity: 1, condition: 'damaged', disposition: 'scrap' }]);
      expect(second).toEqual({ status: 'confirmed', stockAdded: 0 });
      expect(await stock()).toBe(before + 1); // the scrapped one never became stock
      expect(await codeOf(svc.confirm(actor, rr!.id, [{ lineId: line!.id, quantity: 1, condition: 'good', disposition: 'return_to_stock' }]))).toBe('CLOSED');
      const confirmations = await db.select().from(schema.returnReceiptConfirmations).where(eq(schema.returnReceiptConfirmations.receiptId, rr!.id));
      expect(confirmations.map((x) => [x.quantity, x.condition, x.disposition, x.stockAdded])).toEqual([[1, 'good', 'return_to_stock', true], [1, 'damaged', 'scrap', false]]);
      await expect(db.update(schema.returnReceiptConfirmations).set({ quantity: 9 }).where(eq(schema.returnReceiptConfirmations.receiptId, rr!.id))).rejects.toThrow();
    });

    it('goods that are not coming are closed with a reason and add nothing', async () => {
      const before = await stock();
      const o = await sold('credit');
      const cn = await issue(o.id, 1, { restock: true });
      const [rr] = await db.select().from(schema.returnReceipts).where(eq(schema.returnReceipts.creditNoteId, cn.id));
      expect(await codeOf(c.returns.close(actor, rr!.id, { code: 'NOPE' }))).toMatch(/OTHER|UNKNOWN/);
      await c.returns.close(actor, rr!.id, { code: 'CUSTOMER_REQUEST' });
      const [after] = await db.select().from(schema.returnReceipts).where(eq(schema.returnReceipts.id, rr!.id));
      expect(after).toMatchObject({ status: 'rejected', closeReasonCode: 'CUSTOMER_REQUEST' });
      expect(await stock()).toBe(before);
    });

    it('two people confirming the same goods at once cannot both add them', async () => {
      const before = await stock();
      const o = await sold('credit');
      const cn = await issue(o.id, 1, { restock: true });
      const [rr] = await db.select().from(schema.returnReceipts).where(eq(schema.returnReceipts.creditNoteId, cn.id));
      const [line] = await db.select().from(schema.returnReceiptLines).where(eq(schema.returnReceiptLines.receiptId, rr!.id));
      const item = [{ lineId: line!.id, quantity: 1, condition: 'good' as const, disposition: 'return_to_stock' as const }];
      const out = await Promise.all([codeOf(c.returns.confirm(actor, rr!.id, item)), codeOf(c.returns.confirm(actor, rr!.id, item))]);
      expect(out.sort()).toEqual(['CLOSED', 'OK']);
      expect(await stock()).toBe(before + 1);
    });
  });

  describe('in the books, once sales are live', () => {
    beforeAll(async () => {
      await policy({ walletEnabled: true });
      await fin.salesPosting.goLive(ctx, { offsetAccountId: acct['3100']! });
    });
    const glOf = async (registerId: string) => {
      const no = new Map(Object.entries(acct).map(([n, id]) => [id, n]));
      return (await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId))).map((l) => [no.get(l.accountId), Number(l.debit), Number(l.credit)]).sort();
    };

    it('posts debit sales returns and tax, credit trade debtors, in the credit note\'s transaction', async () => {
      const o = await sold('credit');
      await fin.salesPosting.processDue();
      const cn = await issue(o.id, 1);
      const a = await accounting(cn.id);
      expect(a.registerId).toBeTruthy();
      expect(await glOf(a.registerId!)).toEqual([['1210', 0, 580], ['2310', 80, 0], ['4200', 500, 0]]);
      const recon = await fin.salesPosting.reconciliation(companyId);
      expect(recon.rows.map((r) => r.diffCents)).toEqual([0]);
    });

    it('an excess moved to the wallet moves in the books too, and everything still agrees', async () => {
      const o = await sold('cash');
      const ref = `CNQ${run}${seq}`;
      await db.execute(sql`UPDATE orders SET payment_status='paid', transaction_reference=${ref} WHERE id = ${o.id}`);
      await master.applyOrderPayment(o.id);
      await fin.salesPosting.processDue();
      const cn = await issue(o.id, 1);
      await fin.creditNoteAccounting.resolveToWallet(ctx, cn.id);
      const [res] = await db.select().from(schema.creditNoteResolutions).where(eq(schema.creditNoteResolutions.creditNoteId, cn.id));
      expect(await glOf(res!.registerId!)).toEqual([['1210', 580, 0], ['2210', 0, 580]]);
      expect((await fin.salesPosting.reconciliation(companyId)).rows.map((r) => r.diffCents)).toEqual([0]);
      expect((await fin.wallets.reconciliation(companyId)).map((r) => r.diffCents)).toEqual([0]);
    });

    it('if the credit note cannot be posted, nothing is created at all', async () => {
      const o = await sold('credit');
      await fin.salesPosting.processDue();
      const [grp] = await db.select().from(schema.generalPostingSetup).where(eq(schema.generalPostingSetup.companyId, companyId)).limit(1);
      await db.update(schema.generalPostingSetup).set({ salesReturnsAccountId: null }).where(eq(schema.generalPostingSetup.companyId, companyId));
      const before = (await db.select().from(schema.creditNotes).where(eq(schema.creditNotes.companyId, companyId))).length;
      const stockBefore = await stock();
      expect(await codeOf(issue(o.id, 1, { restock: true }))).toBe('POSTING_SETUP_MISSING');
      expect((await db.select().from(schema.creditNotes).where(eq(schema.creditNotes.companyId, companyId))).length).toBe(before);
      expect(await remainingOf(o.id)).toBe('1160.00');
      expect(await stock()).toBe(stockBefore);
      await db.update(schema.generalPostingSetup).set({ salesReturnsAccountId: acct['4200']! }).where(eq(schema.generalPostingSetup.id, grp!.id));
      await db.update(schema.generalPostingSetup).set({ salesReturnsAccountId: acct['4200']! }).where(eq(schema.generalPostingSetup.companyId, companyId));
    });

    it('nothing drifts and the books balance', async () => {
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
      const r = await fin.maintenance.checkIntegrity(companyId);
      expect(r.balanceDrift).toBe(0);
      expect(r.customerDrift).toBe(0);
    });
  });
});
