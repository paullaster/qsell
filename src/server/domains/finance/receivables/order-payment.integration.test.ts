import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';

import { has, required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { FinanceServices } from '../index';
import type { FinanceContext } from '../errors';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('an order follows the receipts applied to its invoice (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let fin: FinanceServices;
  let companyId: string;
  let branchId: string;
  let ctx: FinanceContext;
  let methods: Record<string, string>;
  let seq = 0;

  /** An order with one invoice of the given amount; the order starts with the payment state given. */
  async function orderWithInvoice(amount: string, over: Record<string, unknown> = {}) {
    seq += 1;
    const [c] = await db.insert(schema.customers).values({ companyId, number: `OP${seq}`, name: `Payer ${seq}`, accountType: 'credit', creditLimit: '1000000' }).returning();
    const orderId = `ord_${randomUUID()}`;
    await db.insert(schema.orders).values({
      id: orderId,
      orderNumber: `OP-${randomUUID().slice(0, 12)}`,
      branchId,
      customerName: 'Payer',
      customerEmail: 'p@test.local',
      customerPhone: '0',
      shippingAddress: { street: 's', city: 'c', countyOrState: 'k', country: 'KE' },
      subtotal: amount,
      tax: '0',
      shippingFee: '0',
      totalAmount: amount,
      paymentMethod: 'credit',
      paymentStatus: 'unpaid',
      status: 'processing',
      ...over,
    });
    const entry = await fin.customerLedger.addEntry(db, {
      companyId,
      customerId: c.id,
      orderId,
      documentType: 'invoice',
      documentNo: `INV-OP-${seq}`,
      amountCents: Math.round(Number(amount) * 100),
      currency: 'KES',
      postingDate: '2026-09-01',
      dueDate: new Date('2026-09-30T00:00:00Z'),
    });
    await db.update(schema.customers).set({ balance: amount }).where(eq(schema.customers.id, c.id));
    return { customerId: c.id, orderId, entry };
  }

  const receive = async (customerId: string, amount: string, method = 'CASH') => {
    seq += 1;
    const extra = method === 'CHEQUE' ? { externalReference: `OPCHQ${seq}`, counterparty: { chequeNo: String(seq), bank: 'KCB', drawer: 'Payer' } } : {};
    const r = await fin.receipts.create(ctx, { customerId, paymentMethodId: methods[method], amount, paymentDate: '2026-10-10', ...extra });
    if (method === 'CHEQUE') await fin.receipts.attach(ctx, r.id, { mediaAssetId: 'media_op', fileName: 'c.jpg' });
    return r;
  };
  const order = async (id: string) => required((await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0]);
  const stages = async (id: string) =>
    (await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, id)).orderBy(asc(schema.orderStageEvents.sequence))).map((e) => e.stage);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { DecisionLog } = await import('@/server/kernel/decision-log/service');
    const { ReasonCodes } = await import('@/server/kernel/reason-codes/service');
    const { NumberSeriesService } = await import('@/server/kernel/numbering/service');
    const { createFinanceServices } = await import('../index');
    const decisions = new DecisionLog(db);
    const reasons = new ReasonCodes(db);
    fin = createFinanceServices(db, decisions, { numbering: new NumberSeriesService(db, decisions, reasons, {}), reasons, paymentConfigs: undefined as never, payments: undefined as never });
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'OP', tradingName: 'OP', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = company.id;
    branchId = required((await db.insert(schema.branches).values({ companyId, code: `OP${randomUUID().slice(0, 6)}`, name: 'OP Branch' }).returning())[0]).id;
    await reasons.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin: { surface: 'test', action: 'run' } };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    methods = Object.fromEntries((await fin.paymentMethods.list(companyId)).map((m) => [m.method.code, m.method.id]));
  });

  it('shows part paid for a part payment, then paid for the rest, and keeps the order where it was in fulfilment', async () => {
    const o = await orderWithInvoice('1000', { status: 'shipped' });
    const first = await receive(o.customerId, '400');
    await fin.receipts.post(ctx, first.id, { allocate: 'oldest_first' });
    expect((await order(o.orderId)).paymentStatus).toBe('partially_paid');
    const second = await receive(o.customerId, '600');
    await fin.receipts.post(ctx, second.id, { allocate: 'oldest_first' });
    const paid = await order(o.orderId);
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.status).toBe('shipped');
    expect(paid.paidAt).not.toBeNull();
    expect((await stages(o.orderId)).filter((s) => s.startsWith('payment_'))).toEqual(['payment_partial', 'payment_confirmed']);
  });

  it('takes the payment back, with a stage, when the application is undone or the receipt is bounced', async () => {
    const o = await orderWithInvoice('500');
    const r = await receive(o.customerId, '500');
    await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
    expect((await order(o.orderId)).paymentStatus).toBe('paid');
    const detail = required(await fin.receipts.detail(companyId, r.id));
    const applicationId = required(detail.applications.find((a) => !a.undone)?.application_id);
    await fin.receipts.unapply(ctx, r.id, applicationId, { code: 'OTHER', text: 'wrong invoice' });
    expect((await order(o.orderId)).paymentStatus).toBe('unpaid');
    expect((await stages(o.orderId)).filter((s) => s.startsWith('payment_'))).toEqual(['payment_confirmed', 'payment_reversed']);
    await fin.receipts.apply(ctx, r.id, 'oldest_first');
    expect((await order(o.orderId)).paymentStatus).toBe('paid');
  });

  it('counts a cheque only once it clears (the default), and a bounce takes it back', async () => {
    const o = await orderWithInvoice('800');
    const r = await receive(o.customerId, '800', 'CHEQUE');
    await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
    expect((await order(o.orderId)).paymentStatus).toBe('unpaid');
    await fin.receipts.depositCheque(ctx, r.id, { depositMethodId: methods.BANK_TRANSFER });
    expect((await order(o.orderId)).paymentStatus).toBe('unpaid');
    await fin.receipts.clearCheque(ctx, r.id);
    expect((await order(o.orderId)).paymentStatus).toBe('paid');
    await fin.receipts.bounceCheque(ctx, r.id, { code: 'OTHER', text: 'refer to drawer' });
    expect((await order(o.orderId)).paymentStatus).toBe('unpaid');
    expect((await stages(o.orderId)).filter((s) => s.startsWith('payment_'))).toEqual(['payment_confirmed', 'payment_reversed']);
  });

  it('counts a cheque as soon as it is received when the company chooses so', async () => {
    await fin.setup.setChequeRule(ctx, 'on_receipt');
    try {
      const o = await orderWithInvoice('300');
      const r = await receive(o.customerId, '300', 'CHEQUE');
      await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
      expect((await order(o.orderId)).paymentStatus).toBe('paid');
      await fin.receipts.bounceCheque(ctx, r.id, { code: 'OTHER', text: 'bounced' });
      expect((await order(o.orderId)).paymentStatus).toBe('unpaid');
    } finally {
      await fin.setup.setChequeRule(ctx, 'on_clearing');
    }
  });

  it('refuses a cheque rule it does not know and records the change', async () => {
    await expect(fin.setup.setChequeRule(ctx, 'sometime' as never)).rejects.toMatchObject({ code: 'INVALID' });
    const [s] = await db.select().from(schema.financeSettings).where(eq(schema.financeSettings.companyId, companyId));
    expect(s?.chequeCountsAsPaid).toBe('on_clearing');
  });

  it('leaves an order whose payment is being confirmed or already reconciled alone', async () => {
    for (const state of ['pending_verification', 'reconciled']) {
      const o = await orderWithInvoice('200', { paymentStatus: state });
      const r = await receive(o.customerId, '200');
      await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
      expect((await order(o.orderId)).paymentStatus).toBe(state);
    }
  });

  /** Puts a credit entry of another kind (a credit note, the wallet) in the ledger and applies it to the invoice, as those services do. */
  async function settleWith(o: { customerId: string; orderId: string; entry: string }, documentType: 'credit_note' | 'wallet_use', amount: string, creditOrderId: string | null) {
    seq += 1;
    await db.transaction(async (tx) => {
      const credit = await fin.customerLedger.addEntry(tx, {
        companyId,
        customerId: o.customerId,
        orderId: creditOrderId,
        documentType,
        documentNo: `${documentType.toUpperCase()}-${seq}`,
        amountCents: -Math.round(Number(amount) * 100),
        currency: 'KES',
        postingDate: '2026-10-11',
      });
      await fin.customerLedger.applyIn(tx, ctx, { customerId: o.customerId, creditEntryId: credit, applications: [{ entryId: o.entry, amountCents: Math.round(Number(amount) * 100) }], postingDate: '2026-10-11', createdBy: null });
    });
  }

  it('does not treat a credit note raised against the order as a payment, but counts what is still owed after it', async () => {
    const o = await orderWithInvoice('1000');
    await settleWith(o, 'credit_note', '1000', o.orderId);
    expect((await order(o.orderId)).paymentStatus).toBe('unpaid');
    expect(await stages(o.orderId)).not.toContain('payment_confirmed');

    const part = await orderWithInvoice('1000');
    await settleWith(part, 'credit_note', '300', part.orderId);
    const r = await receive(part.customerId, '700');
    await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
    expect((await order(part.orderId)).paymentStatus).toBe('paid');
  });

  it('counts the wallet, and a credit note spent on another order, as payment', async () => {
    const viaWallet = await orderWithInvoice('400');
    await settleWith(viaWallet, 'wallet_use', '400', null);
    expect((await order(viaWallet.orderId)).paymentStatus).toBe('paid');

    const other = await orderWithInvoice('250');
    await settleWith(other, 'credit_note', '100', `ord_${randomUUID()}`);
    expect((await order(other.orderId)).paymentStatus).toBe('partially_paid');
  });

  it('clears the time it was paid when the payment is taken back, and stamps it again when paid again', async () => {
    const o = await orderWithInvoice('600');
    const r = await receive(o.customerId, '600');
    await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
    expect((await order(o.orderId)).paidAt).not.toBeNull();
    const detail = required(await fin.receipts.detail(companyId, r.id));
    await fin.receipts.unapply(ctx, r.id, required(detail.applications.find((a) => !a.undone)?.application_id), { code: 'OTHER', text: 'mistake' });
    expect((await order(o.orderId)).paidAt).toBeNull();
    await fin.receipts.apply(ctx, r.id, 'oldest_first');
    expect((await order(o.orderId)).paidAt).not.toBeNull();
  });

  it('catches up orders whose receipts came before the feature, without changing their fulfilment, and is safe to repeat', async () => {
    const o = await orderWithInvoice('900', { status: 'pending' });
    const r = await receive(o.customerId, '900');
    await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
    // History: put the order back as it was before orders followed receipts (a direct change, which the database flags and records).
    await db.execute(sql`UPDATE orders SET payment_status = 'unpaid', paid_at = NULL, status = 'pending' WHERE id = ${o.orderId}`);
    const first = await fin.maintenance.recheckOrderPayments(ctx);
    expect(first.moved).toBeGreaterThanOrEqual(1);
    const caught = await order(o.orderId);
    expect(caught.paymentStatus).toBe('paid');
    expect(caught.status).toBe('pending');
    const again = await fin.maintenance.recheckOrderPayments(ctx);
    expect(again.moved).toBe(0);
  });

  it('re-judges the orders cheques were applied to the moment the rule changes', async () => {
    const o = await orderWithInvoice('700');
    const r = await receive(o.customerId, '700', 'CHEQUE');
    await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
    expect((await order(o.orderId)).paymentStatus).toBe('unpaid');
    try {
      const changed = await fin.setup.setChequeRule(ctx, 'on_receipt');
      expect(changed.moved).toBeGreaterThanOrEqual(1);
      expect((await order(o.orderId)).paymentStatus).toBe('paid');
    } finally {
      await fin.setup.setChequeRule(ctx, 'on_clearing');
    }
    expect((await order(o.orderId)).paymentStatus).toBe('unpaid');
  });

  it('shows the invoice number the customer was given, the order and the lines on what a receipt paid', async () => {
    const o = await orderWithInvoice('1500');
    await db.insert(schema.orderItems).values([
      { orderId: o.orderId, productId: 'p1', productName: 'Blue shirt', sku: 'BS', quantity: 2, unitPrice: '500.00', totalPrice: '1000.00' },
      { orderId: o.orderId, productId: 'p2', productName: 'Cap', sku: 'CP', quantity: 1, unitPrice: '500.00', totalPrice: '500.00' },
    ]);
    const paid = await receive(o.customerId, '1500');
    await fin.receipts.post(ctx, paid.id, { allocate: 'oldest_first' });
    const before = required(await fin.receipts.detail(companyId, paid.id));
    expect(before.applications[0]?.ref).toMatchObject({ invoiceNo: null, orderNumber: expect.any(String) as string, lines: [{ name: 'Blue shirt' }, { name: 'Cap' }] });
    await db.insert(schema.invoiceDocuments).values({
      orderId: o.orderId, orderNumber: 'X', invoiceNumber: `INV-T-${randomUUID().slice(0, 8)}`, documentType: 'tax_invoice', customerEmail: 'p@test.local', customerName: 'Payer',
      subtotal: '1500', tax: '0', shippingFee: '0', totalAmount: '1500',
    });
    const after = required(await fin.receipts.detail(companyId, paid.id));
    expect(after.applications[0]?.ref?.invoiceNo).toMatch(/^INV-T-/);
  });

  it('applies to exactly the invoice that was named, and leaves the rest unapplied', async () => {
    seq += 1;
    const a = await orderWithInvoice('500');
    const [c] = await db.select().from(schema.customers).where(eq(schema.customers.id, a.customerId));
    // A second invoice for the same customer, newer than the first.
    const orderB = `ord_${randomUUID()}`;
    await db.insert(schema.orders).values({
      id: orderB, orderNumber: `OP-${randomUUID().slice(0, 12)}`, branchId, customerName: 'Payer', customerEmail: 'p@test.local', customerPhone: '0',
      shippingAddress: { street: 's', city: 'c', countyOrState: 'k', country: 'KE' }, subtotal: '800', tax: '0', shippingFee: '0', totalAmount: '800',
      paymentMethod: 'credit', paymentStatus: 'unpaid', status: 'processing',
    });
    const entryB = await fin.customerLedger.addEntry(db, { companyId, customerId: c.id, orderId: orderB, documentType: 'invoice', documentNo: 'INV-OP-B', amountCents: 80000, currency: 'KES', postingDate: '2026-09-15', dueDate: new Date('2026-10-15T00:00:00Z') });
    const r = await receive(c.id, '600');
    const out = await fin.receipts.post(ctx, r.id, { allocate: [{ entryId: entryB, amountCents: 300_00 }] });
    expect(out.appliedCents).toBe(300_00);
    const remaining = async (id: string) => required((await db.select().from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.id, id)))[0]).remainingAmount;
    expect(await remaining(a.entry)).toBe('500.00');
    expect(await remaining(entryB)).toBe('500.00');
    expect((await order(orderB)).paymentStatus).toBe('partially_paid');
    expect((await order(a.orderId)).paymentStatus).toBe('unpaid');
    const detail = required(await fin.receipts.detail(companyId, r.id));
    expect(detail.unappliedCents).toBe(300_00);
    // Over-applying the named invoice is refused and nothing is posted.
    const r2 = await receive(c.id, '900');
    await expect(fin.receipts.post(ctx, r2.id, { allocate: [{ entryId: entryB, amountCents: 600_00 }] })).rejects.toMatchObject({ code: expect.any(String) as string });
    expect(required(await fin.receipts.detail(companyId, r2.id)).receipt.status).toBe('draft');
  });
});
