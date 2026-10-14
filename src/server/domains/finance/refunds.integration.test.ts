import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('refunds (database)', () => {
  type Db = import('@/server/db/drizzle/client').DrizzleDb;
  let db: Db;
  let schema: typeof import('@/server/db/drizzle/schema');
  let c: import('@/server/di/container').AppContainer;
  let fin: import('./index').FinanceServices;
  let master: import('@/server/domains/customers/master-service').CustomerMasterService;
  let withAfterCommit: typeof import('@/server/kernel/after-commit').withAfterCommit;
  let companyId: string;
  let branchId: string;
  let productId: string;
  let boss: string;
  let requester: string;
  let ctx: import('./errors').FinanceContext; // a person who may do everything (not the approver)
  let reqCtx: import('./errors').FinanceContext; // the requester, a real user (approvals need one)
  let bossCtx: import('./errors').FinanceContext;
  const acct: Record<string, string> = {};
  const methodId: Record<string, string> = {};
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  const origin = { surface: 'test', action: 'run' };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e) return String((e).code);
      return `OTHER:${(e as Error).message}`;
    }
  };
  const policy = (o: Partial<import('./receivables/credit-policy-service').PolicyInput> = {}) =>
    fin.creditPolicy.save(ctx, { groupCode: null, walletEnabled: false, allowDeposits: true, overpaymentDefault: 'ask', autoApply: 'never', creditNoteExcess: 'ask', refundsEnabled: true, walletCashOut: false, maxBalance: null, label: 'Wallet', ...o });
  const user = async (label: string) =>
    (await db.insert(schema.users).values({ email: `${label}-${randomUUID()}@refund.test`, passwordHash: 'x', name: label, role: 'manager' }).returning())[0].id;

  /** A cash customer's order, fully paid at the sale, with a credit note for `qty` units: 580 each, owed back. */
  async function owed(qty = 1, o: { total?: number } = {}) {
    seq += 1;
    const [cust] = await db.insert(schema.customers).values({ companyId, number: `RF${run}${seq}`, name: `Refund customer ${seq}`, phone: `0711${String(100000 + seq)}`, accountType: 'cash', creditLimit: '0' }).returning();
    const id = `rf_${run}_${seq}`;
    const total = o.total ?? 580 * qty;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, trade_customer_id, payment_status)
      VALUES (${id}, ${`RFO-${run}-${seq}`}, 'u', ${branchId}::uuid, 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, ${500 * qty}, ${80 * qty}, 0, ${total}, 'mpesa_daraja', ${cust.id}::uuid, 'paid')`);
    await db.insert(schema.orderItems).values({ orderId: id, productId, productName: 'Widget', sku: 'W', quantity: qty, unitPrice: '580.00', totalPrice: total.toFixed(2), imageUrl: '', unitCost: '300.0000' });
    await master.postInvoice({ customer: cust, orderId: id, orderNumber: `RFO-${run}-${seq}`, amount: total, currency: 'KES' });
    await db.insert(schema.inventoryMovements).values({ id: `mv_${randomUUID()}`, productId, productName: 'Widget', changeAmount: 0, previousStock: 10, newStock: 10, changeType: 'order_fulfillment', referenceId: id });
    await db.insert(schema.invoiceDocuments).values({ orderId: id, orderNumber: `RFO-${run}-${seq}`, invoiceNumber: `TI-${run}-${seq}`, documentType: 'tax_invoice', customerEmail: 'e@x.io', customerName: 'n', currency: 'KES', subtotal: String(500 * qty), tax: String(80 * qty), shippingFee: '0', totalAmount: String(total), pdfStorageKey: 'x.pdf', emailStatus: 'not_sent', meta: {} });
    const cn = await c.creditNotes.issueForOrder({ orderId: id, lines: [{ productId, quantity: qty }], reason: { code: 'returned_goods' }, issuedBy: 'tester' });
    return { orderId: id, customer: cust, cn, cents: 58000 * qty };
  }
  const request = (customerId: string, kind: 'credit_note_excess' | 'wallet' | 'receipt_unapplied', sourceId: string, amount: string, o: Partial<import('./receivables/refund-service').RefundInput> = {}) =>
    fin.refunds.create(ctx, { customerId, sourceKind: kind, sourceId, amount, paymentMethodId: methodId.CASH, payoutDetails: { recipientName: 'Customer' }, reasonCode: 'CUSTOMER_REQUEST', mayChangeDestination: false, ...o });
  const status = async (id: string) => (await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.id, id)))[0].status;
  const cnOpen = async (cnId: string) => {
    const [a] = await db.select().from(schema.creditNoteAccounting).where(eq(schema.creditNoteAccounting.creditNoteId, cnId));
    const res = await db.select().from(schema.creditNoteResolutions).where(eq(schema.creditNoteResolutions.creditNoteId, cnId));
    return Math.round(Number(a.excess) * 100) - res.reduce((n, r) => n + Math.round(Number(r.amount) * 100), 0);
  };
  const payOut = async (id: string, by = ctx, bank?: string) => {
    await fin.refunds.attach(by, id, { mediaAssetId: 'media_x', fileName: 'slip.jpg' }).catch(() => undefined);
    return await fin.refunds.recordPayout(by, id, { paidFromMethodId: bank ?? methodId.CASH, reference: `PAY-${seq}` });
  };

  async function workflow(trigger: string, approverUserId: string) {
    const wf = await c.approvalConfig.createWorkflow(companyId, { code: `W-${randomUUID().slice(0, 8)}`, name: 'Refund test', trigger }, { type: 'user', id: 'tester' });
    await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'eq', field: 'methodKind', value: 'mobile_money' }, steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: approverUserId } }] } as never, { type: 'user', id: 'tester' });
    await c.approvalConfig.publish(companyId, wf.id, { type: 'user', id: 'tester' }, { code: 'POLICY_CHANGE' });
    return wf;
  }
  const openEntry = async (id: string) => (await c.approvals.forDocument(companyId, 'refund', id)).flatMap((r) => r.entries).find((e) => e.status === 'open')!;
  const approve = (entryId: string, by: string) => withAfterCommit(db, (tx) => c.approvals.approve(entryId, by, null, tx));

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ withAfterCommit } = await import('@/server/kernel/after-commit'));
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    fin = c.finance;
    const { CustomerMasterService } = await import('@/server/domains/customers/master-service');
    master = new CustomerMasterService(db, {} as never, new (await import('@/server/domains/transactions/ledger-service')).TransactionLedgerService(db));
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'RF', tradingName: 'RF', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    companyId = company.id;
    const [branch] = await db.insert(schema.branches).values({ companyId, code: `RF${run.toUpperCase()}`, name: 'RF branch', isDefault: true }).returning();
    branchId = branch.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    [boss, requester] = await Promise.all([user('boss'), user('requester')]);
    await c.approvalConfig.saveProfile(companyId, { userId: boss, limits: [] }, { type: 'user', id: 'tester' }, { code: 'POLICY_CHANGE' });
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    reqCtx = { ...ctx, actor: { type: 'user', id: requester } };
    bossCtx = { ...ctx, actor: { type: 'user', id: boss } };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    for (const a of await fin.setup.listAccounts(companyId)) acct[a.no] = a.id;
    for (const m of await fin.paymentMethods.list(companyId)) methodId[m.method.code] = m.method.id;
    const itemTypeId = `it_${run}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `RF-${run}`.toUpperCase(), stockCode: `RFS-${run}`.toUpperCase(), name: 'Widget', slug: `rf-${randomUUID()}`, itemTypeId, price: '580', costPrice: '300', stockQuantity: 50, taxRate: '16', isTaxInclusive: true });
  });

  describe('asking for a refund', () => {
    it('can never exceed what is owed, counting what is already asked for', async () => {
      const o = await owed();
      const obs = await fin.refunds.obligations(companyId, o.customer.id);
      expect(obs).toMatchObject([{ kind: 'credit_note_excess', availableCents: 58000 }]);
      expect(await codeOf(request(o.customer.id, 'credit_note_excess', o.cn.id, '580.01'))).toBe('OVER_OBLIGATION');
      await request(o.customer.id, 'credit_note_excess', o.cn.id, '300');
      expect(await codeOf(request(o.customer.id, 'credit_note_excess', o.cn.id, '300', { paymentMethodId: methodId.BANK_TRANSFER, payoutDetails: { bankName: 'KCB', accountNumber: '1', accountName: 'A' } }))).toBe('OVER_OBLIGATION');
      expect((await fin.refunds.obligations(companyId, o.customer.id))[0].availableCents).toBe(28000);
    });

    it('checks the details for the way of paying, and flags a payout to someone else\'s phone', async () => {
      const o = await owed();
      expect(await codeOf(request(o.customer.id, 'credit_note_excess', o.cn.id, '100', { paymentMethodId: methodId.MPESA, payoutDetails: {} }))).toBe('PAYOUT_DETAILS');
      expect(await codeOf(request(o.customer.id, 'credit_note_excess', o.cn.id, '100', { paymentMethodId: methodId.MPESA, payoutDetails: { phone: '0799000111' } }))).toBe('DESTINATION_CHANGED');
      const own = await request(o.customer.id, 'credit_note_excess', o.cn.id, '100', { paymentMethodId: methodId.MPESA, payoutDetails: { phone: o.customer.phone! } });
      expect(own.detailsChanged).toBe(false);
      const other = await request(o.customer.id, 'credit_note_excess', o.cn.id, '120', { paymentMethodId: methodId.MPESA, payoutDetails: { phone: '0799000111' }, mayChangeDestination: true });
      expect(other.detailsChanged).toBe(true);
    });

    it('refuses the same refund asked for twice within a day, a method that cannot refund, and a blocked customer', async () => {
      const o = await owed(2);
      await request(o.customer.id, 'credit_note_excess', o.cn.id, '100');
      expect(await codeOf(request(o.customer.id, 'credit_note_excess', o.cn.id, '100'))).toBe('DUPLICATE_REFUND');
      expect(await codeOf(request(o.customer.id, 'credit_note_excess', o.cn.id, '50', { paymentMethodId: methodId.CHEQUE, payoutDetails: { payeeName: 'x' } }))).toBe('METHOD_NOT_FOR_REFUNDS');
      await db.update(schema.customers).set({ blocked: 'all' }).where(eq(schema.customers.id, o.customer.id));
      expect(await codeOf(request(o.customer.id, 'credit_note_excess', o.cn.id, '60'))).toBe('CUSTOMER_BLOCKED');
    });

    it('a business that does not pay refunds is told so, and a wallet needs cash-out switched on', async () => {
      const o = await owed();
      await policy({ refundsEnabled: false });
      expect(await codeOf(request(o.customer.id, 'credit_note_excess', o.cn.id, '100'))).toBe('REFUNDS_OFF');
      await policy({ walletEnabled: true, walletCashOut: false });
      const [w] = await db.insert(schema.customerWallets).values({ companyId, customerId: o.customer.id, currency: 'KES', balance: '400.00' }).returning();
      expect(await codeOf(request(o.customer.id, 'wallet', w.id, '100'))).toBe('CASH_OUT_OFF');
      await policy();
    });
  });

  describe('approval, payment and what it leaves behind', () => {
    it('with no workflow it goes straight to approved and sets the money aside; paying needs evidence and a reference', async () => {
      const o = await owed();
      const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580');
      expect(await status(r.id)).toBe('draft');
      expect((await fin.refunds.submit(ctx, r.id)).status).toBe('approved');
      expect(await cnOpen(o.cn.id)).toBe(0); // set aside: it cannot be put in the wallet or spent too
      expect((await fin.creditNoteAccounting.worklist(companyId)).some((x) => x.a.creditNoteId === o.cn.id)).toBe(false);
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
      expect(await codeOf(fin.refunds.recordPayout(ctx, r.id, { paidFromMethodId: methodId.CASH, reference: 'R1' }))).toBe('EVIDENCE_REQUIRED');
      await fin.refunds.attach(ctx, r.id, { mediaAssetId: 'media_x', fileName: 'signed-receipt.jpg' });
      expect(await codeOf(fin.refunds.recordPayout(ctx, r.id, { paidFromMethodId: methodId.CASH, reference: ' ' }))).toBe('REFERENCE_REQUIRED');
      expect(await codeOf(fin.refunds.recordPayout(ctx, r.id, { paidFromMethodId: methodId.CHEQUE, reference: 'R1' }))).toBe('BANK_INVALID');
      expect(await codeOf(fin.refunds.recordPayout(ctx, r.id, { paidFromMethodId: methodId.CASH, reference: 'R1', payoutDate: '2999-01-01' }))).toBe('DATE_INVALID');
      const out = await fin.refunds.recordPayout(ctx, r.id, { paidFromMethodId: methodId.CASH, reference: 'R1' });
      expect(out).toMatchObject({ order: 'refunded', gl: false });
      expect(await status(r.id)).toBe('paid');
      const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r.id));
      expect(bank.map((b) => b.amount)).toEqual(['-580.0000']);
      // paid out through a payment method: its G/L account is what the books (and the bank ledger) record
      const [cashMethod] = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, methodId.CASH));
      expect(bank[0].glAccountId).toBe(cashMethod.glAccountId);
      expect((await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.id, r.id)))[0].paidFromMethodId).toBe(methodId.CASH);
      const legacy = await db.select().from(schema.transactionLedgerEntries).where(eq(schema.transactionLedgerEntries.idempotencyKey, `refund:${r.id}`));
      expect(legacy[0]).toMatchObject({ documentType: 'refund', direction: 'debit', amount: '580.00', transactionReference: 'R1' });
      expect(await codeOf(fin.refunds.cancel(ctx, r.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('ALREADY_PAID');
      expect(await codeOf(fin.refunds.recordPayout(ctx, r.id, { paidFromMethodId: methodId.CASH, reference: 'R1' }))).toBe('NOT_APPROVED');
      await expect(db.update(schema.refundRequests).set({ amount: '1.00' }).where(eq(schema.refundRequests.id, r.id))).rejects.toThrow();
      await expect(db.delete(schema.refundEvents).where(eq(schema.refundEvents.refundId, r.id))).rejects.toThrow();
      const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, o.orderId));
      expect(order.paymentStatus).toBe('refunded');
    });

    it('a partial refund leaves the order paid; only a full one makes it refunded', async () => {
      const o = await owed(2);
      const a = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580');
      await fin.refunds.submit(ctx, a.id);
      expect(await payOut(a.id)).toMatchObject({ order: 'partially_refunded' });
      expect((await db.select().from(schema.orders).where(eq(schema.orders.id, o.orderId)))[0].paymentStatus).toBe('paid');
      const b = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580', { paymentMethodId: methodId.BANK_TRANSFER, payoutDetails: { bankName: 'KCB', accountNumber: '1', accountName: 'A' } });
      await fin.refunds.submit(ctx, b.id);
      expect(await payOut(b.id)).toMatchObject({ order: 'refunded' });
      expect((await db.select().from(schema.orders).where(eq(schema.orders.id, o.orderId)))[0].paymentStatus).toBe('refunded');
    });

    it('cancelling after approval gives the money back to where it came from, once', async () => {
      const o = await owed();
      const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580');
      await fin.refunds.submit(ctx, r.id);
      expect(await cnOpen(o.cn.id)).toBe(0);
      await fin.refunds.cancel(ctx, r.id, { code: 'DATA_ENTRY_ERROR' });
      expect(await status(r.id)).toBe('cancelled');
      expect(await cnOpen(o.cn.id)).toBe(58000);
      expect((await fin.creditNoteAccounting.worklist(companyId)).some((x) => x.a.creditNoteId === o.cn.id)).toBe(true);
      expect(await codeOf(fin.refunds.cancel(ctx, r.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('ALREADY_CANCELLED');
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
    });

    it('a wallet is paid out as a refund; cancelling puts it back', async () => {
      await policy({ walletEnabled: true, walletCashOut: true });
      const o = await owed();
      await fin.creditNoteAccounting.resolveToWallet(ctx, o.cn.id);
      const [w] = await db.select().from(schema.customerWallets).where(eq(schema.customerWallets.customerId, o.customer.id));
      expect(w.balance).toBe('580.00');
      const r = await request(o.customer.id, 'wallet', w.id, '400');
      await fin.refunds.submit(ctx, r.id);
      expect((await db.select().from(schema.customerWallets).where(eq(schema.customerWallets.id, w.id)))[0].balance).toBe('180.00');
      expect(await codeOf(request(o.customer.id, 'wallet', w.id, '200', { paymentMethodId: methodId.BANK_TRANSFER, payoutDetails: { bankName: 'KCB', accountNumber: '1', accountName: 'A' } }))).toBe('OVER_OBLIGATION');
      await fin.refunds.cancel(ctx, r.id, { code: 'CUSTOMER_REQUEST' });
      expect((await db.select().from(schema.customerWallets).where(eq(schema.customerWallets.id, w.id)))[0].balance).toBe('580.00');
      await policy();
    });

    it('an overpaid receipt can be refunded', async () => {
      const o = await owed();
      const cash = methodId.CASH;
      const rc = await fin.receipts.create(ctx, { customerId: o.customer.id, paymentMethodId: cash, amount: '250', paymentDate: today });
      await fin.receipts.post(ctx, rc.id, { allocate: 'none' });
      const r = await request(o.customer.id, 'receipt_unapplied', rc.id, '250');
      await fin.refunds.submit(ctx, r.id);
      expect((await fin.receipts.detail(companyId, rc.id))!.unappliedCents).toBe(0);
      await payOut(r.id);
      expect(await status(r.id)).toBe('paid');
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
    });
  });

  describe('paying through M-Pesa automatically', () => {
    it('sends only what is approved, never twice, and records the payment from the confirmed result with the receipt as reference', async () => {
      const o = await owed();
      const { id: providerId } = await fin.paymentProviders.create(ctx, { providerCode: 'mpesa_daraja', displayName: `RF auto ${run}` });
      const [before] = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, methodId.MPESA));
      await db.update(schema.paymentMethods).set({ providerId, refundDestination: 'automatic' }).where(eq(schema.paymentMethods.id, methodId.MPESA));
      try {
        const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '300', { paymentMethodId: methodId.MPESA, payoutDetails: { phone: o.customer.phone! } });
        // not approved yet: nothing to send
        expect(await codeOf(fin.refunds.prepareAutomatic(reqCtx, r.id))).toBe('NOT_APPROVED');
        await fin.refunds.submit(reqCtx, r.id);
        const plan = await fin.refunds.prepareAutomatic(reqCtx, r.id);
        expect(plan).toMatchObject({ providerId, methodId: methodId.MPESA, amount: '300.00', phone: o.customer.phone });
        // someone has already sent it: no second send, and no payment by hand on top of it
        const [op] = await db.insert(schema.providerOperations).values({ companyId, providerId, methodId: methodId.MPESA, operation: 'b2c', status: 'accepted', idempotencyKey: `refund:${r.id}:payout:1`, subjectType: 'refund', subjectId: r.id, amount: '300', input: {} }).returning();
        expect(await codeOf(fin.refunds.prepareAutomatic(reqCtx, r.id))).toBe('PAYOUT_IN_PROGRESS');
        expect(await codeOf(payOut(r.id))).toBe('PAYOUT_IN_PROGRESS');
        // it was not paid (held for a check): the refund stays approved and says why
        await fin.refunds.onAutomaticPayoutFinished({ ...op, status: 'in_doubt', failureCode: 'STATUS_AMOUNT_MISMATCH', failureReason: 'differs' });
        expect(await status(r.id)).toBe('approved');
        // confirmed: recorded as paid, by the system, with the M-Pesa receipt as the reference and no evidence file needed
        await fin.refunds.onAutomaticPayoutFinished({ ...op, status: 'succeeded', platformReference: 'RFAUTO0001' });
        const [paid] = await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.id, r.id));
        expect(paid).toMatchObject({ status: 'paid', payoutReference: 'RFAUTO0001' });
        const [bank] = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r.id));
        expect(Number(bank.amount)).toBe(-300);
      } finally {
        await db.update(schema.paymentMethods).set({ providerId: before.providerId, refundDestination: before.refundDestination }).where(eq(schema.paymentMethods.id, methodId.MPESA));
      }
    });
  });

  describe('with an approval workflow', () => {
    beforeAll(async () => {
      await workflow('refund.payout', boss);
    });

    it('goes to the approver, is set aside only when approved, and the approver cannot record the payment', async () => {
      const o = await owed();
      const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580', { paymentMethodId: methodId.MPESA, payoutDetails: { phone: o.customer.phone! } });
      expect((await fin.refunds.submit(reqCtx, r.id)).status).toBe('pending_approval');
      expect(await cnOpen(o.cn.id)).toBe(58000);
      await approve((await openEntry(r.id)).id, boss);
      expect(await status(r.id)).toBe('approved');
      expect((await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.id, r.id)))[0].approvedBy).toBe(boss);
      expect(await cnOpen(o.cn.id)).toBe(0);
      expect(await codeOf(payOut(r.id, bossCtx))).toBe('SAME_PERSON');
      await payOut(r.id, reqCtx);
      expect(await status(r.id)).toBe('paid');
    });

    it('a changed destination must be approved: with no workflow covering it, it is refused in words', async () => {
      // methodKind mobile_money is covered; a bank payout to a customer is not, so it needs no approval
      const o = await owed();
      const bank = await request(o.customer.id, 'credit_note_excess', o.cn.id, '100', { paymentMethodId: methodId.BANK_TRANSFER, payoutDetails: { bankName: 'KCB', accountNumber: '1', accountName: 'A' } });
      expect((await fin.refunds.submit(ctx, bank.id)).status).toBe('approved');
    });

    it('a rejected refund sets nothing aside; it can be reopened, and a waiting one can be withdrawn', async () => {
      const o = await owed(2);
      const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '300', { paymentMethodId: methodId.MPESA, payoutDetails: { phone: o.customer.phone! } });
      await fin.refunds.submit(reqCtx, r.id);
      const entry = await openEntry(r.id);
      await withAfterCommit(db, (tx) => c.approvals.reject(entry.id, boss, { reasonCode: 'OTHER', comment: 'No' }, tx));
      expect(await status(r.id)).toBe('rejected');
      expect(await cnOpen(o.cn.id)).toBe(116000);
      await withAfterCommit(db, (tx) => c.approvals.reopen('refund', r.id, { userId: requester }, { text: 'Will fix' }, tx, companyId));
      expect(await status(r.id)).toBe('draft');
      await fin.refunds.submit(reqCtx, r.id);
      expect(await status(r.id)).toBe('pending_approval');
      await fin.refunds.cancel(ctx, r.id, { code: 'CUSTOMER_REQUEST' });
      expect(await status(r.id)).toBe('cancelled');
      expect(await cnOpen(o.cn.id)).toBe(116000);
    });

    it('two people submitting the same draft at once: only one goes through', async () => {
      const o = await owed();
      const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580');
      const out = await Promise.all([codeOf(fin.refunds.submit(ctx, r.id)), codeOf(fin.refunds.submit(ctx, r.id))]);
      expect(out.sort()).toEqual(['NOT_DRAFT', 'OK']);
      expect(await cnOpen(o.cn.id)).toBe(0);
    });
  });

  describe('in the books, once sales are live', () => {
    let early: { id: string; cnId: string };
    beforeAll(async () => {
      // approved but unpaid before the books start: it is owed, and comes in as an opening liability
      const o = await owed();
      const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580');
      await fin.refunds.submit(ctx, r.id);
      early = { id: r.id, cnId: o.cn.id };
      await fin.salesPosting.goLive(ctx, { offsetAccountId: acct['3100'] });
    });
    const glOf = async (registerId: string) => {
      const no = new Map(Object.entries(acct).map(([n, id]) => [id, n]));
      return (await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId))).map((l) => [no.get(l.accountId), Number(l.debit), Number(l.credit)]).sort();
    };

    it('what was approved before go-live is a liability from day one, and paying it clears it', async () => {
      expect((await fin.refunds.payableReconciliation(companyId)).map((r) => r.diffCents)).toEqual([0]);
      await payOut(early.id);
      const [paid] = await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.id, early.id));
      expect(await glOf(paid.payoutRegisterId!)).toEqual([['1110', 0, 580], ['2220', 580, 0]]);
      expect((await fin.refunds.payableReconciliation(companyId)).map((r) => r.diffCents)).toEqual([0]);
    });

    it('approval sets it aside (Dr debtors, Cr refunds payable) and payment pays it (Dr refunds payable, Cr cash)', async () => {
      const o = await owed();
      await fin.salesPosting.processDue();
      const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580');
      await fin.refunds.submit(ctx, r.id);
      const [a] = await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.id, r.id));
      expect(await glOf(a.reserveRegisterId!)).toEqual([['1210', 580, 0], ['2220', 0, 580]]);
      expect((await fin.refunds.payableReconciliation(companyId)).map((x) => x.diffCents)).toEqual([0]);
      expect((await fin.salesPosting.reconciliation(companyId)).rows.map((x) => x.diffCents)).toEqual([0]);
      await payOut(r.id);
      expect((await fin.refunds.payableReconciliation(companyId)).map((x) => x.diffCents)).toEqual([0]);
      expect((await fin.salesPosting.reconciliation(companyId)).rows.map((x) => x.diffCents)).toEqual([0]);
    });

    it('cancelling an approved refund reverses what was set aside in the books too', async () => {
      const o = await owed();
      const r = await request(o.customer.id, 'credit_note_excess', o.cn.id, '580');
      await fin.refunds.submit(ctx, r.id);
      await fin.refunds.cancel(ctx, r.id, { code: 'DATA_ENTRY_ERROR' });
      expect((await fin.refunds.payableReconciliation(companyId)).map((x) => x.diffCents)).toEqual([0]);
      expect((await fin.salesPosting.reconciliation(companyId)).rows.map((x) => x.diffCents)).toEqual([0]);
    });

    it('a wallet paid out debits customer deposits; everything still agrees', async () => {
      await policy({ walletEnabled: true, walletCashOut: true });
      const o = await owed();
      await fin.creditNoteAccounting.resolveToWallet(ctx, o.cn.id);
      const [w] = await db.select().from(schema.customerWallets).where(eq(schema.customerWallets.customerId, o.customer.id));
      const r = await request(o.customer.id, 'wallet', w.id, '580');
      await fin.refunds.submit(ctx, r.id);
      const [a] = await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.id, r.id));
      expect(await glOf(a.reserveRegisterId!)).toEqual([['2210', 580, 0], ['2220', 0, 580]]);
      await payOut(r.id);
      expect((await fin.wallets.reconciliation(companyId)).map((x) => x.diffCents)).toEqual([0]);
      expect((await fin.refunds.payableReconciliation(companyId)).map((x) => x.diffCents)).toEqual([0]);
      await policy();
    });

    it('nothing drifts and the books balance', async () => {
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
      const rep = await fin.maintenance.checkIntegrity(companyId);
      expect(rep.balanceDrift).toBe(0);
      expect(rep.customerDrift).toBe(0);
    });
  });
});
