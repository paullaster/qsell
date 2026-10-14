import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('receivables (database)', () => {
  type Db = import('@/server/db/drizzle/client').DrizzleDb;
  let db: Db;
  let schema: typeof import('@/server/db/drizzle/schema');
  let fin: import('../index').FinanceServices;
  let FinanceError: typeof import('../errors').FinanceError;
  let companyId: string;
  let ctx: import('../errors').FinanceContext;
  let ids: { methods: Record<string, string>; banks: Record<string, string> };
  let seq = 0;

  const origin = { surface: 'test', action: 'run' };
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof FinanceError) return e.code;
      return `OTHER:${(e as Error).message}`;
    }
  };

  /** A credit customer with the given open invoices (amount, due date). Returns ids. */
  async function customerWith(invoices: [string, string][]) {
    seq += 1;
    const [c] = await db
      .insert(schema.customers)
      .values({ companyId, number: `C${seq}`, name: `Customer ${seq}`, accountType: 'credit', creditLimit: '1000000' })
      .returning();
    const entries: string[] = [];
    let total = 0;
    for (const [amount, due] of invoices) {
      total += Number(amount);
      entries.push(
        await fin.customerLedger.addEntry(db, {
          companyId,
          customerId: c.id,
          documentType: 'invoice',
          documentNo: `INV-${seq}-${entries.length + 1}`,
          amountCents: Math.round(Number(amount) * 100),
          currency: 'KES',
          postingDate: '2026-09-01',
          dueDate: new Date(`${due}T00:00:00Z`),
        }),
      );
    }
    await db.update(schema.customers).set({ balance: total.toFixed(2) }).where(eq(schema.customers.id, c.id));
    return { id: c.id, entries };
  }

  const receive = async (customerId: string, amount: string, over: Record<string, unknown> = {}) => {
    seq += 1;
    return await fin.receipts.create(ctx, {
      customerId,
      paymentMethodId: ids.methods.CASH,
      amount,
      paymentDate: '2026-10-10',
      ...over,
    });
  };
  const remaining = async (entryId: string) =>
    (await db.select().from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.id, entryId)))[0].remainingAmount;
  const balanceOf = async (customerId: string) =>
    (await db.select().from(schema.customers).where(eq(schema.customers.id, customerId)))[0].balance;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ FinanceError } = await import('../errors'));
    const { DecisionLog } = await import('@/server/kernel/decision-log/service');
    const { ReasonCodes } = await import('@/server/kernel/reason-codes/service');
    const { NumberSeriesService } = await import('@/server/kernel/numbering/service');
    const { createFinanceServices } = await import('../index');
    const decisions = new DecisionLog(db);
    const reasons = new ReasonCodes(db);
    fin = createFinanceServices(db, decisions, { numbering: new NumberSeriesService(db, decisions, reasons, {}), reasons, paymentConfigs: undefined as never, payments: undefined as never });

    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'R', tradingName: 'R', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = company.id;
    await reasons.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    ids = {
      methods: Object.fromEntries((await fin.paymentMethods.list(companyId)).map((m) => [m.method.code, m.method.id])),
      banks: Object.fromEntries((await fin.bankAccounts.list(companyId)).map((b) => [b.account.code, b.account.id])),
    };
  });

  describe('payment setup', () => {
    it('seeds the standard accounts and methods once', async () => {
      expect(Object.keys(ids.banks).sort()).toEqual(['BANK', 'CASH', 'CHQ-TRANSIT', 'MOBILE', 'MPESA']);
      expect(Object.keys(ids.methods)).toContain('MPESA');
      const again = await fin.paymentMethods.seedStandard(ctx);
      expect(again).toEqual({ bankAccounts: 0, methods: 0 });
    });

    it('guards bank accounts and methods', async () => {
      const gl = (await fin.setup.listAccounts(companyId)).find((a) => a.no === '6200')!;
      const manual = (await fin.paymentMethods.providerChoices(companyId)).find((p) => p.isSystem)!;
      const cashGl = (await fin.paymentMethods.list(companyId)).find((m) => m.method.code === 'CASH')!.method.glAccountId;
      const base = { name: 'X', kind: 'cash' as const, balancingBankAccountId: ids.banks.CASH, providerId: manual.id, glAccountId: cashGl };
      expect(await codeOf(fin.bankAccounts.create(ctx, { code: 'bad code', name: 'X', kind: 'bank', currency: 'KES' }))).toBe('CODE_INVALID');
      expect(await codeOf(fin.paymentMethods.create(ctx, { ...base, code: 'X', glAccountId: gl.id }))).toBe('ACCOUNT_NOT_ASSET');
      expect(await codeOf(fin.paymentMethods.create(ctx, { ...base, code: 'X', providerId: '' }))).toBe('PROVIDER_REQUIRED');
      expect(await codeOf(fin.paymentMethods.create(ctx, { ...base, code: 'X', glAccountId: '' }))).toBe('GL_REQUIRED');
      expect(await codeOf(fin.paymentMethods.create(ctx, { ...base, code: 'CASH', name: 'Dup' }))).toBe('DUPLICATE');
      expect(await codeOf(fin.paymentMethods.create(ctx, { ...base, code: 'LIM', name: 'L', limits: { min: '10', max: '5' } }))).toBe('LIMIT_INVALID');
      expect(await codeOf(fin.paymentMethods.update(ctx, ids.methods.CASH, { code: 'OTHER' }))).toBe('CODE_FIXED');
    });

    it('links orders to methods by their old provider code, in batches', async () => {
      const [o] = await db.execute<{ n: number }>(sql`SELECT 1 AS n`);
      expect(o).toBeTruthy();
      const orderCols = `id, order_number, user_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method`;
      const run = Math.random().toString(36).slice(2, 8);
      for (let i = 0; i < 3; i++) {
        await db.execute(sql.raw(`INSERT INTO orders (${orderCols}) VALUES ('legacy_${run}_${i}', 'O-${run}-${i}', 'u', 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}', 1, 0, 0, 1, '${i === 2 ? 'on_account' : 'mpesa_daraja'}')`));
      }
      const n = await fin.paymentMethods.backfillOrders(ctx);
      expect(n).toBeGreaterThanOrEqual(2);
      const linked = await db.execute<{ id: string; payment_method_id: string | null }>(sql`SELECT id, payment_method_id FROM orders WHERE id LIKE ${`legacy_${run}_%`} ORDER BY id`);
      const rows = [...linked];
      expect(rows[0].payment_method_id).toBe(ids.methods.MPESA);
      expect(rows[2].payment_method_id).toBeNull(); // on_account is a credit sale, not a way of paying
      expect(await fin.paymentMethods.backfillOrders(ctx)).toBe(0); // run again: nothing left to link
    });
  });

  describe('recording a receipt', () => {
    it('applies the payment method rules', async () => {
      const c = await customerWith([]);
      const mpesa = ids.methods.MPESA;
      expect(await codeOf(fin.receipts.create(ctx, { customerId: c.id, paymentMethodId: mpesa, amount: '100' }))).toBe('REFERENCE_REQUIRED');
      expect(await codeOf(receive(c.id, '0'))).toBe('AMOUNT_INVALID');
      expect(await codeOf(receive(c.id, '10.555'))).toBe('AMOUNT_INVALID');
      expect(await codeOf(receive(c.id, '10', { currency: 'USD', rate: '130' }))).toBe('CURRENCY_MISMATCH');
      expect(await codeOf(receive(c.id, '10', { paymentDate: '2999-01-01' }))).toBe('DATE_FUTURE');
      await fin.paymentMethods.setEnabled(ctx, ids.methods.MOBILE_MONEY, false);
      expect(await codeOf(receive(c.id, '10', { paymentMethodId: ids.methods.MOBILE_MONEY, externalReference: 'X1' }))).toBe('METHOD_DISABLED');
      await fin.paymentMethods.setEnabled(ctx, ids.methods.MOBILE_MONEY, true);
    });

    it('refuses the same outside reference twice on one method, but not after it is cancelled', async () => {
      const c = await customerWith([]);
      const mk = () => receive(c.id, '100', { paymentMethodId: ids.methods.MPESA, externalReference: 'QWE123' });
      const first = await mk();
      expect(await codeOf(mk())).toBe('DUPLICATE_REFERENCE');
      await fin.receipts.cancelDraft(ctx, first.id, { code: 'DATA_ENTRY_ERROR' });
      expect(await codeOf(mk())).toBe('OK');
    });

    it('returns the same receipt for the same idempotency key', async () => {
      const c = await customerWith([]);
      const a = await receive(c.id, '55', { idempotencyKey: 'k-1' });
      const b = await receive(c.id, '55', { idempotencyKey: 'k-1' });
      expect(b).toEqual(a);
    });

    it('needs the cheque details and the evidence the method asks for', async () => {
      const c = await customerWith([]);
      const cheque = ids.methods.CHEQUE;
      expect(await codeOf(receive(c.id, '500', { paymentMethodId: cheque, externalReference: 'CH1' }))).toBe('COUNTERPARTY_REQUIRED');
      const r = await receive(c.id, '500', { paymentMethodId: cheque, externalReference: 'CH1', counterparty: { chequeNo: '000123', bank: 'KCB', drawer: 'Acme' } });
      expect(await codeOf(fin.receipts.post(ctx, r.id))).toBe('EVIDENCE_REQUIRED');
      await fin.receipts.attach(ctx, r.id, { mediaAssetId: 'media_test', fileName: 'cheque.jpg' });
      expect(await codeOf(fin.receipts.post(ctx, r.id))).toBe('OK');
    });
  });

  describe('posting and allocation (sub-ledger only, GL not live)', () => {
    it('writes the customer, bank and transaction ledgers and nothing in the general ledger', async () => {
      const c = await customerWith([]);
      const r = await receive(c.id, '1000');
      const out = await fin.receipts.post(ctx, r.id);
      expect(out).toMatchObject({ glPosted: false, registerId: null, appliedCents: 0 });
      const d = (await fin.receipts.detail(companyId, r.id))!;
      expect(d.receipt.status).toBe('posted');
      expect(d.unappliedCents).toBe(100000);
      expect(d.events.map((e) => e.event)).toEqual(['created', 'posted']);
      const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r.id));
      expect(bank.map((b) => b.amount)).toEqual(['1000.0000']);
      const legacy = await db.select().from(schema.transactionLedgerEntries).where(eq(schema.transactionLedgerEntries.idempotencyKey, `receipt:${r.id}`));
      expect(legacy).toHaveLength(1);
      expect(legacy[0]).toMatchObject({ direction: 'credit', amount: '1000.00' });
      expect(await codeOf(fin.receipts.post(ctx, r.id))).toBe('NOT_DRAFT');
    });

    it('applies oldest-due first and leaves a part-paid invoice open', async () => {
      const c = await customerWith([['500', '2026-09-20'], ['300', '2026-09-05'], ['900', '2026-10-30']]);
      const r = await receive(c.id, '600');
      const out = await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
      expect(out.appliedCents).toBe(60000);
      expect(await remaining(c.entries[1])).toBe('0.00'); // 300, due first
      expect(await remaining(c.entries[0])).toBe('200.00'); // 500 - 300
      expect(await remaining(c.entries[2])).toBe('900.00');
      expect(await balanceOf(c.id)).toBe('1100.00'); // 1700 - 600
      expect((await fin.receipts.detail(companyId, r.id))!.unappliedCents).toBe(0);
    });

    it('keeps an excess as an unapplied credit, never a negative debtor', async () => {
      const c = await customerWith([['800', '2026-09-20']]);
      const r = await receive(c.id, '1000');
      await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
      expect(await remaining(c.entries[0])).toBe('0.00');
      expect(await balanceOf(c.id)).toBe('0.00');
      const st = await fin.customerLedger.statement(companyId, c.id, null, null);
      expect(st).toMatchObject({ owedCents: 0, unappliedCents: 20000, netCents: -20000 });
    });

    it('applies by hand, and refuses to over-apply the invoice or the receipt', async () => {
      const c = await customerWith([['500', '2026-09-20'], ['500', '2026-09-21']]);
      const r = await receive(c.id, '600');
      await fin.receipts.post(ctx, r.id);
      expect(await codeOf(fin.receipts.apply(ctx, r.id, [{ entryId: c.entries[0], amountCents: 50001 }]))).toBe('OVER_INVOICE');
      expect(await codeOf(fin.receipts.apply(ctx, r.id, [{ entryId: c.entries[0], amountCents: 50000 }, { entryId: c.entries[1], amountCents: 20000 }]))).toBe('OVER_CREDIT');
      expect(await codeOf(fin.receipts.apply(ctx, r.id, [{ entryId: c.entries[0], amountCents: 10000 }, { entryId: c.entries[0], amountCents: 10000 }]))).toBe('DUPLICATE_TARGET');
      expect(await remaining(c.entries[0])).toBe('500.00'); // nothing leaked from the refusals
      await fin.receipts.apply(ctx, r.id, [{ entryId: c.entries[1], amountCents: 40000 }]);
      expect(await remaining(c.entries[1])).toBe('100.00');
      expect((await fin.receipts.detail(companyId, r.id))!.unappliedCents).toBe(20000);
    });

    it('cannot apply across currencies or to a payment', async () => {
      const c = await customerWith([['500', '2026-09-20']]);
      const usd = await fin.customerLedger.addEntry(db, { companyId, customerId: c.id, documentType: 'invoice', documentNo: 'USD-1', amountCents: 10000, currency: 'USD', postingDate: '2026-09-01' });
      const r = await receive(c.id, '600');
      await fin.receipts.post(ctx, r.id);
      expect(await codeOf(fin.receipts.apply(ctx, r.id, [{ entryId: usd, amountCents: 10000 }]))).toBe('CURRENCY_MISMATCH');
    });

    it('two people applying the same money at once: exactly one wins', async () => {
      const c = await customerWith([['600', '2026-09-20'], ['600', '2026-09-21']]);
      const r = await receive(c.id, '600');
      await fin.receipts.post(ctx, r.id);
      const results = await Promise.all([
        codeOf(fin.receipts.apply(ctx, r.id, [{ entryId: c.entries[0], amountCents: 60000 }])),
        codeOf(fin.receipts.apply(ctx, r.id, [{ entryId: c.entries[1], amountCents: 60000 }])),
      ]);
      expect(results.sort()).toEqual(['NOTHING_TO_APPLY', 'OK']);
      const total = Number(await remaining(c.entries[0])) + Number(await remaining(c.entries[1]));
      expect(total).toBe(600);
    });

    it('many payments settling one invoice at once never over-apply it', async () => {
      const c = await customerWith([['1000', '2026-09-20']]);
      const receipts = await Promise.all(Array.from({ length: 8 }, (_, i) => receive(c.id, '200', { externalReference: `P-${seq}-${i}`, paymentMethodId: ids.methods.MPESA })));
      const outcomes = await Promise.all(
        receipts.map(async (r) => {
          await fin.receipts.post(ctx, r.id);
          return await codeOf(fin.receipts.apply(ctx, r.id, [{ entryId: c.entries[0], amountCents: 20000 }]));
        }),
      );
      expect(outcomes.filter((o) => o === 'OK')).toHaveLength(5);
      expect(outcomes.filter((o) => o === 'OVER_INVOICE')).toHaveLength(3);
      expect(await remaining(c.entries[0])).toBe('0.00');
    });

    it('undoes an application that spans several invoices, all of it or not at all', async () => {
      const c = await customerWith([['500', '2026-09-20'], ['300', '2026-09-21'], ['700', '2026-09-22']]);
      const r = await receive(c.id, '900');
      await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' }); // 500 + 300 + 100
      expect(await remaining(c.entries[2])).toBe('600.00');
      const detail = (await fin.receipts.detail(companyId, r.id))!;
      const applicationId = detail.applications[0].application_id;
      expect(new Set(detail.applications.map((a) => a.application_id)).size).toBe(1);
      expect(detail.applications).toHaveLength(3);
      await fin.receipts.unapply(ctx, r.id, applicationId, { code: 'DATA_ENTRY_ERROR' });
      expect(await Promise.all(c.entries.map(remaining))).toEqual(['500.00', '300.00', '700.00']);
      expect(await balanceOf(c.id)).toBe('1500.00');
      expect((await fin.receipts.detail(companyId, r.id))!.unappliedCents).toBe(90000);
      expect(await codeOf(fin.receipts.unapply(ctx, r.id, applicationId, { code: 'DATA_ENTRY_ERROR' }))).toBe('ALREADY_UNAPPLIED');
      // and the money can be applied again, to different invoices
      await fin.receipts.apply(ctx, r.id, [{ entryId: c.entries[2], amountCents: 40000 }, { entryId: c.entries[1], amountCents: 30000 }]);
      expect(await remaining(c.entries[2])).toBe('300.00');
      expect(await remaining(c.entries[1])).toBe('0.00');
      expect((await fin.receipts.detail(companyId, r.id))!.unappliedCents).toBe(20000);
    });

    it('undoes an application once, with a reason, and reopens the invoice', async () => {
      const c = await customerWith([['500', '2026-09-20']]);
      const r = await receive(c.id, '500');
      await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
      const app = (await fin.receipts.detail(companyId, r.id))!.applications[0];
      expect(await codeOf(fin.receipts.unapply(ctx, r.id, app.application_id, { code: 'NOPE' }))).toMatch(/does not exist/);
      await fin.receipts.unapply(ctx, r.id, app.application_id, { code: 'DATA_ENTRY_ERROR' });
      expect(await remaining(c.entries[0])).toBe('500.00');
      expect(await balanceOf(c.id)).toBe('500.00');
      expect(await codeOf(fin.receipts.unapply(ctx, r.id, app.application_id, { code: 'DATA_ENTRY_ERROR' }))).toBe('ALREADY_UNAPPLIED');
      expect((await fin.receipts.detail(companyId, r.id))!.unappliedCents).toBe(50000);
    });
  });

  describe('reversing', () => {
    it('refuses while applied, then reverses cleanly once the applications are undone', async () => {
      const c = await customerWith([['500', '2026-09-20']]);
      const r = await receive(c.id, '500');
      await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
      expect(await codeOf(fin.receipts.reverse(ctx, r.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('HAS_APPLICATIONS');
      const app = (await fin.receipts.detail(companyId, r.id))!.applications[0];
      await fin.receipts.unapply(ctx, r.id, app.application_id, { code: 'DATA_ENTRY_ERROR' });
      await fin.receipts.reverse(ctx, r.id, { code: 'DATA_ENTRY_ERROR', text: 'wrong customer' });
      const d = (await fin.receipts.detail(companyId, r.id))!;
      expect(d.receipt.status).toBe('reversed');
      const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r.id));
      expect(bank.reduce((n, b) => n + Number(b.amount), 0)).toBe(0);
      const [entry] = await db.select().from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.id, d.receipt.ledgerEntryId!));
      expect(entry.remainingAmount).toBe('0.00');
      const legacy = await db.select().from(schema.transactionLedgerEntries).where(eq(schema.transactionLedgerEntries.idempotencyKey, `receipt-reversal:${r.id}`));
      expect(legacy[0]).toMatchObject({ direction: 'debit', amount: '500.00' });
      expect(await codeOf(fin.receipts.reverse(ctx, r.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('NOT_POSTED');
      expect(await remaining(c.entries[0])).toBe('500.00');
    });
  });

  describe('the general ledger, once live', () => {
    beforeAll(async () => {
      await db.update(schema.financeSettings).set({ salesGlGoLive: '2026-01-01' }).where(eq(schema.financeSettings.companyId, companyId));
    });

    const glOf = async (registerId: string) =>
      (await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId))).sort((a, b) => a.lineNo - b.lineNo);

    it('posts debit bank / credit receivables with the receipt as its source, and reverses with it', async () => {
      const c = await customerWith([['500', '2026-09-20']]);
      const r = await receive(c.id, '500', { paymentMethodId: ids.methods.MPESA, externalReference: `GL${seq}` });
      const out = await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
      expect(out.glPosted).toBe(true);
      const lines = await glOf(out.registerId!);
      const accounts = new Map((await fin.setup.listAccounts(companyId)).map((a) => [a.id, a.no]));
      expect(lines.map((l) => [accounts.get(l.accountId), l.debit, l.credit])).toEqual([
        ['1125', '500.0000', '0.0000'], // M-Pesa settlement account
        ['1210', '0.0000', '500.0000'], // trade debtors
      ]);
      const reg = await fin.reports.register(companyId, out.registerId!);
      expect(reg).toBeTruthy();
      const app = (await fin.receipts.detail(companyId, r.id))!.applications[0];
      await fin.receipts.unapply(ctx, r.id, app.application_id, { code: 'DATA_ENTRY_ERROR' });
      await fin.receipts.reverse(ctx, r.id, { code: 'DATA_ENTRY_ERROR' });
      const net = await db.execute<{ d: string; c: string }>(sql`SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM gl_entries WHERE company_id = ${companyId}::uuid AND document_no = ${(await fin.receipts.detail(companyId, r.id))!.receipt.number}`);
      const row = [...net][0];
      expect(Number(row.d)).toBe(Number(row.c));
      expect(Number(row.d)).toBe(1000); // 500 posted + 500 reversed, each side
    });

    it('refuses to post into a closed period and names it', async () => {
      const c = await customerWith([]);
      const r = await receive(c.id, '10', { paymentDate: '2026-02-10' });
      const [period] = await db.select().from(schema.accountingPeriods).where(and(eq(schema.accountingPeriods.companyId, companyId), sql`${schema.accountingPeriods.startsOn} <= '2026-02-10' AND ${schema.accountingPeriods.endsOn} >= '2026-02-10'`));
      await db.update(schema.accountingPeriods).set({ status: 'closed' }).where(eq(schema.accountingPeriods.id, period.id));
      expect(await codeOf(fin.receipts.post(ctx, r.id))).toBe('PERIOD_CLOSED');
      await db.update(schema.accountingPeriods).set({ status: 'open' }).where(eq(schema.accountingPeriods.id, period.id));
      expect(await codeOf(fin.receipts.post(ctx, r.id))).toBe('OK');
    });

    it('a missing customer posting group is a clear error and writes nothing', async () => {
      const c = await customerWith([]);
      await db.update(schema.customers).set({ postingGroupCode: 'NOPE' }).where(eq(schema.customers.id, c.id));
      const r = await receive(c.id, '10');
      expect(await codeOf(fin.receipts.post(ctx, r.id))).toBe('POSTING_SETUP_MISSING');
      const d = (await fin.receipts.detail(companyId, r.id))!;
      expect(d.receipt.status).toBe('draft');
      expect(await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r.id))).toHaveLength(0);
    });

    it('moves a cheque through in-transit, deposit and clearing, and a bounce reopens the invoice', async () => {
      const c = await customerWith([['800', '2026-09-20']]);
      const r = await receive(c.id, '800', { paymentMethodId: ids.methods.CHEQUE, externalReference: `CHQ${seq}`, counterparty: { chequeNo: '77', bank: 'Equity', drawer: 'Acme' } });
      await fin.receipts.attach(ctx, r.id, { mediaAssetId: 'media_x', fileName: 'c.jpg' });
      await fin.receipts.post(ctx, r.id, { allocate: 'oldest_first' });
      const bal = async (code: string) => Number((await db.execute<{ s: string }>(sql`SELECT COALESCE(SUM(l.amount),0) s FROM bank_ledger_entries l JOIN bank_accounts b ON b.id = l.bank_account_id WHERE b.code = ${code} AND l.document_id = ${r.id}::uuid`))[0].s);
      expect(await bal('CHQ-TRANSIT')).toBe(800);
      expect(await codeOf(fin.receipts.clearCheque(ctx, r.id))).toBe('CHEQUE_STATE'); // not deposited yet
      expect(await codeOf(fin.receipts.depositCheque(ctx, r.id, { depositMethodId: ids.methods.CASH }))).toBe('BANK_KIND');
      await fin.receipts.depositCheque(ctx, r.id, { depositMethodId: ids.methods.BANK_TRANSFER });
      await fin.receipts.clearCheque(ctx, r.id);
      expect(await bal('CHQ-TRANSIT')).toBe(0);
      expect(await bal('BANK')).toBe(800);
      expect(await remaining(c.entries[0])).toBe('0.00');

      await fin.receipts.bounceCheque(ctx, r.id, { code: 'OTHER', text: 'refer to drawer' });
      const d = (await fin.receipts.detail(companyId, r.id))!;
      expect(d.receipt).toMatchObject({ status: 'reversed', chequeStatus: 'bounced' });
      expect(await bal('BANK')).toBe(0);
      expect(await remaining(c.entries[0])).toBe('800.00');
      expect(await balanceOf(c.id)).toBe('800.00');
      // the books for this receipt net to zero on every account
      const nets = await db.execute<{ account_id: string; net: string }>(sql`SELECT account_id, SUM(debit - credit) net FROM gl_entries WHERE company_id = ${companyId}::uuid AND document_no = ${d.receipt.number} GROUP BY account_id HAVING SUM(debit - credit) <> 0`);
      expect([...nets]).toEqual([]);
    });
  });

  describe('the record cannot be rewritten', () => {
    it('refuses direct edits and deletes the database must never allow', async () => {
      const c = await customerWith([['100', '2026-09-20']]);
      const r = await receive(c.id, '100');
      await fin.receipts.post(ctx, r.id);
      const d = (await fin.receipts.detail(companyId, r.id))!;
      const fails = async (p: Promise<unknown>) => { try { await p; return false; } catch { return true; } };
      expect(await fails(db.update(schema.customerReceipts).set({ amount: '1.00' }).where(eq(schema.customerReceipts.id, r.id)))).toBe(true);
      expect(await fails(db.delete(schema.customerReceipts).where(eq(schema.customerReceipts.id, r.id)))).toBe(true);
      expect(await fails(db.update(schema.customerLedgerEntries).set({ amount: '-1.00' }).where(eq(schema.customerLedgerEntries.id, d.receipt.ledgerEntryId!)))).toBe(true);
      expect(await fails(db.delete(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.id, c.entries[0])))).toBe(true);
      expect(await fails(db.update(schema.customerDetailedEntries).set({ amount: '1.00' }).where(eq(schema.customerDetailedEntries.ledgerEntryId, c.entries[0])))).toBe(true);
      expect(await fails(db.delete(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r.id)))).toBe(true);
      expect(await fails(db.delete(schema.receiptEvents).where(eq(schema.receiptEvents.receiptId, r.id)))).toBe(true);
    });

    it('a reversed or cancelled receipt cannot come back to life', async () => {
      const c = await customerWith([]);
      const r = await receive(c.id, '5');
      await fin.receipts.cancelDraft(ctx, r.id, { code: 'DATA_ENTRY_ERROR' });
      await expect(db.update(schema.customerReceipts).set({ status: 'draft' }).where(eq(schema.customerReceipts.id, r.id))).rejects.toThrow();
    });

    it('every remaining amount equals the sum of its history', async () => {
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
    });
  });

  describe('the existing sales flow keeps the same books', () => {
    it('an invoice and a payment through the older customer service leave consistent history', async () => {
      // Money taken by hand is refused once the books are live (see sales posting); this checks the
      // sub-ledger path as it is before go-live.
      await db.update(schema.financeSettings).set({ salesGlGoLive: null }).where(eq(schema.financeSettings.companyId, companyId));
      const { CustomerMasterService } = await import('@/server/domains/customers/master-service');
      const { TransactionLedgerService } = await import('@/server/domains/transactions/ledger-service');
      const master = new CustomerMasterService(db, {} as never, new TransactionLedgerService(db));
      const [cust] = await db
        .insert(schema.customers)
        .values({ companyId, number: 'LEGACY1', name: 'Legacy', accountType: 'credit', creditLimit: '100000', paymentTermDays: 14 })
        .returning();
      const order = (n: number) => ({ customer: cust, orderId: `lo_${n}`, orderNumber: `LO-${n}`, amount: 700, currency: 'KES' });
      await master.postInvoice(order(1));
      await master.postInvoice(order(2));
      await master.receivePayment(companyId, cust.id, { amount: 1000, reference: 'LEGACYPAY1', currency: 'KES' });
      const found = await master.getCustomer(companyId, cust.id);
      expect(found!.customer.balance).toBe('400.00');
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
      const open = await fin.customerLedger.openItems(companyId, cust.id);
      expect(open.map((o) => o.remainingAmount)).toEqual(['400.00']);
      await expect(master.deleteCustomer(companyId, cust.id)).rejects.toThrow(/financial history/);
    });
  });

  describe('scheduled checks', () => {
    it('creates ledger partitions ahead of time, and only the missing ones', async () => {
      await fin.maintenance.ensurePartitions(36);
      expect(await fin.maintenance.ensurePartitions(36)).toBe(0);
    });

    it('passes on healthy books and leaves a trace', async () => {
      const report = await fin.maintenance.checkIntegrity(companyId);
      expect(report).toMatchObject({ balanceDrift: 0, customerDrift: 0, chainProblems: [], ok: true });
      const trace = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.companyId, companyId), eq(schema.decisionLog.action, 'finance.integrity_ok')));
      expect(trace.length).toBeGreaterThan(0);
    });

    it('raises the alarm when a stored figure no longer matches its record', async () => {
      // Tamper with the speed-up tables, which are not append-only, as a bug or a manual fix would.
      const [bal] = await db.select().from(schema.glAccountBalances).where(eq(schema.glAccountBalances.companyId, companyId)).limit(1);
      await db.update(schema.glAccountBalances).set({ baseDebit: sql`${schema.glAccountBalances.baseDebit} + 5` }).where(and(eq(schema.glAccountBalances.companyId, companyId), eq(schema.glAccountBalances.accountId, bal.accountId), eq(schema.glAccountBalances.periodId, bal.periodId), eq(schema.glAccountBalances.dimensionSetId, bal.dimensionSetId), eq(schema.glAccountBalances.shard, bal.shard)));
      const [ledgerRow] = await db.select().from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.companyId, companyId)).limit(1);
      await db.update(schema.customerLedgerEntries).set({ remainingAmount: sql`${schema.customerLedgerEntries.remainingAmount} + 1` }).where(eq(schema.customerLedgerEntries.id, ledgerRow.id));
      const report = await fin.maintenance.checkIntegrity(companyId);
      expect(report.ok).toBe(false);
      expect(report.balanceDrift).toBeGreaterThan(0);
      expect(report.customerDrift).toBe(1);
      const alert = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.companyId, companyId), eq(schema.decisionLog.action, 'finance.integrity_alert')));
      expect(alert.length).toBe(1);
      // put it back so later checks see healthy books
      await db.update(schema.glAccountBalances).set({ baseDebit: sql`${schema.glAccountBalances.baseDebit} - 5` }).where(and(eq(schema.glAccountBalances.companyId, companyId), eq(schema.glAccountBalances.accountId, bal.accountId), eq(schema.glAccountBalances.periodId, bal.periodId), eq(schema.glAccountBalances.dimensionSetId, bal.dimensionSetId), eq(schema.glAccountBalances.shard, bal.shard)));
      await db.update(schema.customerLedgerEntries).set({ remainingAmount: sql`${schema.customerLedgerEntries.remainingAmount} - 1` }).where(eq(schema.customerLedgerEntries.id, ledgerRow.id));
      expect((await fin.maintenance.checkIntegrity(companyId)).ok).toBe(true);
    });

    it('notices an altered register in the tail of a hash chain', async () => {
      const [reg] = await db.select().from(schema.ledgerRegisters).where(eq(schema.ledgerRegisters.companyId, companyId)).limit(1);
      // Altering a register behind the engine's back (the trigger that forbids it is switched off here).
      await db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE ledger_registers DISABLE TRIGGER ledger_registers_append_only`);
        await tx.execute(sql`UPDATE ledger_registers SET hash = repeat('0', 64) WHERE id = ${reg.id}::uuid`);
        await tx.execute(sql`ALTER TABLE ledger_registers ENABLE TRIGGER ledger_registers_append_only`);
      });
      const problems = await fin.maintenance.verifyChainTails(companyId);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0].problem).toMatch(/altered|does not follow/);
      await db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE ledger_registers DISABLE TRIGGER ledger_registers_append_only`);
        await tx.execute(sql`UPDATE ledger_registers SET hash = ${reg.hash} WHERE id = ${reg.id}::uuid`);
        await tx.execute(sql`ALTER TABLE ledger_registers ENABLE TRIGGER ledger_registers_append_only`);
      });
      expect(await fin.maintenance.verifyChainTails(companyId)).toEqual([]);
    });

    it('seals credentials that predate key ids again under the current key, and leaves unreadable ones alone', async () => {
      const { PaymentService } = await import('@/server/domains/payments/service');
      const { PaymentRegistry } = await import('@/server/domains/payments/registry');
      const { encryptCredentials, decryptCredentials, needsResealing } = await import('@/server/domains/payments/crypto');
      const { createCipheriv, randomBytes } = await import('node:crypto');
      // A blob exactly as it was sealed before key ids existed (no key id bound in).
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.DATA_ENCRYPTION_KEY!, 'base64'), iv);
      const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ consumerKey: 'legacy-key' }))), cipher.final()]);
      const legacy = { v: 1 as const, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') };
      const garbage = { v: 1 as const, iv: legacy.iv, tag: legacy.tag, ciphertext: Buffer.from('not the real ciphertext').toString('base64') };
      const [b1] = await db.insert(schema.branches).values({ companyId, code: `RB${seq}A`, name: 'Reseal A', isDefault: false }).returning();
      const [b2] = await db.insert(schema.branches).values({ companyId, code: `RB${seq}B`, name: 'Reseal B', isDefault: false }).returning();
      const [good] = await db.insert(schema.paymentProviderConfigs).values({ companyId, branchId: b1.id, providerCode: 'pesapal_v3', displayName: `P ${seq}a`, apiBaseUrl: 'https://x.test', credentialsEncrypted: legacy }).returning();
      const [bad] = await db.insert(schema.paymentProviderConfigs).values({ companyId, branchId: b2.id, providerCode: 'pesapal_v3', displayName: `P ${seq}b`, apiBaseUrl: 'https://x.test', credentialsEncrypted: garbage }).returning();
      const [current] = await db.insert(schema.paymentProviderConfigs).values({ companyId, branchId: b1.id, providerCode: 'jenga_hq', displayName: `J ${seq}`, apiBaseUrl: 'https://x.test', credentialsEncrypted: encryptCredentials({ apiKey: 'k' }) }).returning();
      const out = await new PaymentService(db, new PaymentRegistry()).resealCredentials();
      expect(out.resealed).toBeGreaterThanOrEqual(1);
      expect(out.failed.map((f) => f.id)).toContain(bad.id);
      const row = async (id: string) => (await db.select().from(schema.paymentProviderConfigs).where(eq(schema.paymentProviderConfigs.id, id)))[0];
      expect(needsResealing((await row(good.id)).credentialsEncrypted)).toBe(false);
      expect(decryptCredentials((await row(good.id)).credentialsEncrypted)).toEqual({ consumerKey: 'legacy-key' });
      expect((await row(bad.id)).credentialsEncrypted).toEqual(garbage); // never overwritten
      expect((await row(current.id)).credentialsEncrypted).toEqual(current.credentialsEncrypted); // already current: untouched
    });
  });
});
