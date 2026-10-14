import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('payment providers and methods (database)', () => {
  type Db = import('@/server/db/drizzle/client').DrizzleDb;
  let db: Db;
  let schema: typeof import('@/server/db/drizzle/schema');
  let fin: import('./index').FinanceServices;
  let payments: import('@/server/domains/payments/service').PaymentService;
  let companyId: string;
  let ctx: import('./errors').FinanceContext;
  let manual: string;
  let glNairobi: string;
  let glMombasa: string;
  let glDefault: string;
  let branchA: import('@/server/db/drizzle/schema').BranchRow;
  let branchB: import('@/server/db/drizzle/schema').BranchRow;
  let branchC: import('@/server/db/drizzle/schema').BranchRow;
  const run = randomUUID().slice(0, 6).toUpperCase();
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
  const bank = async (label: string) => await fin.bankAccounts.create(ctx, { code: `PS${run}${++seq}`, name: `Setup ${label}`, kind: 'bank', currency: 'KES' });
  const method = (providerId: string, bankId: string, o: Partial<import('./receivables/payment-method-service').PaymentMethodInput> = {}) =>
    fin.paymentMethods.create(ctx, { code: `PM${run}${++seq}`, name: `Method ${seq}`, kind: 'mobile_money', balancingBankAccountId: bankId, providerId, glAccountId: glDefault, ...o });
  const customer = async () => {
    const [c] = await db.insert(schema.customers).values({ companyId, number: `PC${run}${++seq}`, name: `Setup customer ${seq}`, phone: `0733${String(100000 + seq)}`, accountType: 'cash', creditLimit: '0' }).returning();
    return c;
  };
  const receive = async (methodId: string, amount: string, branchId?: string) => {
    const c = await customer();
    const r = await fin.receipts.create(ctx, { customerId: c.id, paymentMethodId: methodId, amount, paymentDate: today, externalReference: `REF${seq}${Math.floor(Math.random() * 1e6)}`, branchId });
    await fin.receipts.post(ctx, r.id, { allocate: 'none' });
    return r;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const c = getContainer();
    fin = c.finance;
    payments = c.payments;
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'PS', tradingName: 'PS', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    companyId = company.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    const accts = await fin.setup.listAccounts(companyId);
    glDefault = accts.find((a) => a.no === '1120')!.id;
    glNairobi = accts.find((a) => a.no === '1125')!.id;
    glMombasa = accts.find((a) => a.no === '1130')!.id;
    manual = (await fin.paymentMethods.providerChoices(companyId)).find((p) => p.isSystem)!.id;
    [branchA, branchB, branchC] = await Promise.all(['A', 'B', 'C'].map(async (n) => (await db.insert(schema.branches).values({ companyId, code: `PB${run}${n}`, name: `Branch ${n}`, isDefault: false }).returning())[0]));
  });

  describe('providers', () => {
    it('the built-in Manual provider exists once, takes no credentials and cannot be changed or deleted', async () => {
      expect((await fin.paymentMethods.providerChoices(companyId)).filter((p) => p.isSystem)).toHaveLength(1);
      expect(await codeOf(fin.paymentProviders.update(ctx, manual, { displayName: 'Mine' }))).toBe('SYSTEM_PROVIDER');
      expect(await codeOf(fin.paymentProviders.setCredentials(ctx, manual, { consumerKey: 'x' }))).toBe('SYSTEM_PROVIDER');
      expect(await codeOf(fin.paymentProviders.setEnabled(ctx, manual, false))).toBe('SYSTEM_PROVIDER');
      expect(await codeOf(fin.paymentProviders.delete(ctx, manual))).toBe('SYSTEM_PROVIDER');
    });

    it('a provider is created once per name, holds sealed credentials, and is switched on only after a good test', async () => {
      const { id } = await fin.paymentProviders.create(ctx, { providerCode: 'mpesa_daraja', displayName: 'M-Pesa Test A' });
      expect(await codeOf(fin.paymentProviders.create(ctx, { providerCode: 'mpesa_daraja', displayName: 'm-pesa test a' }))).toBe('DUPLICATE');
      expect(await codeOf(fin.paymentProviders.update(ctx, id, { apiBaseUrl: 'http://insecure.example' }))).toBe('URL_INVALID');
      expect(await codeOf(fin.paymentProviders.setEnabled(ctx, id, true))).toBe('NO_CREDENTIALS');
      await fin.paymentProviders.setCredentials(ctx, id, { consumerKey: 'KEY-123456789', consumerSecret: 'SECRET-123456789', passkey: 'PASS-123456789', shortcode: '174379' });
      const [row] = await db.select().from(schema.paymentProviderConfigs).where(eq(schema.paymentProviderConfigs.id, id));
      expect(JSON.stringify(row.credentialsEncrypted)).not.toContain('SECRET-123456789');
      const view = (await fin.paymentProviders.list(companyId, null)).find((p) => p.id === id)!;
      expect(view.hasCredentials).toBe(true);
      expect(JSON.stringify(view.maskedCredentials)).not.toContain('SECRET-123456789');
      expect(await codeOf(fin.paymentProviders.setEnabled(ctx, id, true))).toBe('NOT_TESTED');
      await db.update(schema.paymentProviderConfigs).set({ lastTestOk: true, lastTestAt: new Date() }).where(eq(schema.paymentProviderConfigs.id, id));
      await fin.paymentProviders.setEnabled(ctx, id, true);
      // the values are never in the decision log, only which fields changed
      const log = await db.execute<{ inputs: unknown }>(await import('drizzle-orm').then(({ sql }) => sql`SELECT inputs FROM decision_log WHERE subject_id = ${id} AND action = 'finance.payment_provider_credentials_set'`));
      expect(JSON.stringify([...log])).toContain('consumerKey');
      expect(JSON.stringify([...log])).not.toContain('KEY-123456789');
    });

    it('cannot be deleted while a method goes through it, but can once nothing does', async () => {
      const { id } = await fin.paymentProviders.create(ctx, { providerCode: 'pesapal_v3', displayName: 'Pesapal Test' });
      const b = await bank('del');
      const m = await method(id, b.id);
      expect(await codeOf(fin.paymentProviders.delete(ctx, id))).toBe('PROVIDER_IN_USE');
      await fin.paymentMethods.delete(ctx, m.id);
      expect(await codeOf(fin.paymentProviders.delete(ctx, id))).toBe('OK');
      expect(await codeOf(fin.paymentProviders.delete(ctx, id))).toBe('NOT_FOUND');
    });
  });

  describe('methods under one provider', () => {
    let providerId: string;
    let nairobi: { id: string };
    let mombasa: { id: string };
    beforeAll(async () => {
      providerId = (await fin.paymentProviders.create(ctx, { providerCode: 'mpesa_daraja', displayName: 'M-Pesa Shared' })).id;
      const bn = await bank('nairobi');
      const bm = await bank('mombasa');
      nairobi = await method(providerId, bn.id, { name: 'M-Pesa paybill — Nairobi', branchId: branchA.id, glAccountId: glNairobi, channelKind: 'paybill', channelNumber: '123456' });
      mombasa = await method(providerId, bm.id, { name: 'M-Pesa till — Mombasa', branchId: branchB.id, glAccountId: glMombasa, channelKind: 'till', channelNumber: '987654' });
    });

    it('each method has its own branch, bank account, G/L account and number under the one provider', async () => {
      const list = await fin.paymentMethods.list(companyId);
      const n = list.find((m) => m.method.id === nairobi.id)!;
      const m = list.find((x) => x.method.id === mombasa.id)!;
      expect([n.method.providerId, m.method.providerId]).toEqual([providerId, providerId]);
      expect([n.branchName, m.branchName]).toEqual(['Branch A', 'Branch B']);
      expect([n.glNo, m.glNo]).toEqual(['1125', '1130']);
      expect([n.method.channelNumber, m.method.channelNumber]).toEqual(['123456', '987654']);
      expect(n.method.balancingBankAccountId).not.toBe(m.method.balancingBankAccountId);
      expect((await fin.paymentProviders.list(companyId, null)).find((p) => p.id === providerId)!.methods.map((x) => x.id).sort()).toEqual([nairobi.id, mombasa.id].sort());
    });

    it('a receipt takes its branch from the method and the bank ledger records the method\'s G/L account', async () => {
      const r = await receive(nairobi.id, '1000');
      const [row] = await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.id, r.id));
      expect(row.branchId).toBe(branchA.id);
      const [entry] = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r.id));
      expect(entry.glAccountId).toBe(glNairobi);
      const r2 = await receive(mombasa.id, '400');
      expect((await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r2.id)))[0].glAccountId).toBe(glMombasa);
    });

    it('a method of one branch cannot take a receipt of another', async () => {
      const c = await customer();
      expect(await codeOf(fin.receipts.create(ctx, { customerId: c.id, paymentMethodId: nairobi.id, amount: '10', externalReference: 'WRONGBR1', branchId: branchB.id }))).toBe('METHOD_BRANCH');
    });

    it('its G/L account cannot change once receipts were posted through it, but the name can', async () => {
      expect(await codeOf(fin.paymentMethods.update(ctx, nairobi.id, { glAccountId: glMombasa }))).toBe('METHOD_IN_USE');
      await fin.paymentMethods.update(ctx, nairobi.id, { name: 'M-Pesa paybill — Nairobi (main)' });
      const unused = await method(providerId, (await bank('free')).id, { branchId: branchC.id });
      await fin.paymentMethods.update(ctx, unused.id, { glAccountId: glMombasa });
    });

    it('the bank reconciliation proof follows the G/L accounts the methods post to', async () => {
      const b = await bank('proof');
      const m1 = await method(providerId, b.id, { glAccountId: glNairobi });
      const m2 = await method(providerId, b.id, { glAccountId: glMombasa });
      await receive(m1.id, '100');
      await receive(m2.id, '50');
      const preview = await fin.bankReconciliation.preview(companyId, b.id, today);
      expect(preview.bookBalance).toBe('150.0000');
      const gls = await fin.bankStatements.chargeGlChoices(companyId, b.id);
      expect(gls.map((g) => g.glId).sort()).toEqual([glNairobi, glMombasa].sort());
    });
  });

  describe('a charge from a statement line', () => {
    it('asks which G/L account when the bank account\'s methods post to several, and uses the chosen one', async () => {
      const b = await bank('charge');
      await db.update(schema.bankAccounts).set({ feeGlAccountId: (await fin.setup.listAccounts(companyId)).find((a) => a.category === 'expense' && a.type === 'posting')!.id }).where(eq(schema.bankAccounts.id, b.id));
      await method(manual, b.id, { kind: 'bank_transfer', glAccountId: glNairobi });
      await method(manual, b.id, { kind: 'bank_deposit', glAccountId: glMombasa });
      const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10).split('-').reverse().join('/');
      const map = { headerRow: 1, date: 'Date', description: ['Narration'], reference: 'Ref', paidIn: 'In', withdrawn: 'Out' };
      await fin.bankStatements.import(ctx, { bankAccountId: b.id, fileName: `c${Math.random()}.csv`, text: `Date,Narration,Ref,In,Out\n${day(1)},Fee one,F1,,10.00\n${day(1)},Fee two,F2,,20.00`, format: 'csv', mapping: map });
      const lines = await db.select().from(schema.bankStatementLines).where(eq(schema.bankStatementLines.bankAccountId, b.id)).orderBy(schema.bankStatementLines.id);
      expect(await codeOf(fin.bankStatements.recordChargeFromLine(ctx, lines[0].id))).toBe('GL_CHOICE_NEEDED');
      expect(await codeOf(fin.bankStatements.recordChargeFromLine(ctx, lines[0].id, { glAccountId: glDefault }))).toBe('GL_CHOICE_NEEDED');
      await fin.bankStatements.recordChargeFromLine(ctx, lines[0].id, { glAccountId: glMombasa });
      const [e] = await db.select().from(schema.bankLedgerEntries).where(and(eq(schema.bankLedgerEntries.bankAccountId, b.id), eq(schema.bankLedgerEntries.documentType, 'bank_charge')));
      expect(e.glAccountId).toBe(glMombasa);
      const empty = await bank('nomethod');
      await db.update(schema.bankAccounts).set({ feeGlAccountId: (await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, b.id)))[0].feeGlAccountId }).where(eq(schema.bankAccounts.id, empty.id));
      await fin.bankStatements.import(ctx, { bankAccountId: empty.id, fileName: `d${Math.random()}.csv`, text: `Date,Narration,Ref,In,Out\n${day(1)},Fee,F9,,5.00`, format: 'csv', mapping: map });
      const [l] = await db.select().from(schema.bankStatementLines).where(eq(schema.bankStatementLines.bankAccountId, empty.id));
      expect(await codeOf(fin.bankStatements.recordChargeFromLine(ctx, l.id))).toBe('NO_METHOD');
    });
  });

  describe('what checkout offers a branch', () => {
    let providerId: string;
    let legacyBranch: import('@/server/db/drizzle/schema').BranchRow;
    beforeAll(async () => {
      providerId = (await fin.paymentProviders.create(ctx, { providerCode: 'jenga_hq', displayName: 'Equity Checkout' })).id;
      await db.update(schema.paymentProviderConfigs).set({ isEnabled: true }).where(eq(schema.paymentProviderConfigs.id, providerId));
      legacyBranch = (await db.insert(schema.branches).values({ companyId, code: `PL${run}`, name: 'Legacy branch', isDefault: false }).returning())[0]!;
    });

    it('a branch gets its own method\'s provider; a method for every branch serves the rest; first by sort order', async () => {
      const b1 = await bank('co1');
      const b2 = await bank('co2');
      const own = await method(providerId, b1.id, { branchId: branchA.id, kind: 'gateway', sortOrder: 50 });
      const all = await method(providerId, b2.id, { branchId: null, kind: 'gateway', sortOrder: 10 });
      const forA = await payments.resolveCheckout(branchA, 'jenga_hq');
      expect(forA).toMatchObject({ methodId: own.id });
      expect(forA!.provider.id).toBe(providerId);
      expect((await payments.resolveCheckout(branchB, 'jenga_hq'))!.methodId).toBe(all.id);
      expect((await payments.listEnabledProviders(branchA)).map((p) => p.id)).toEqual(expect.arrayContaining([providerId]));
    });

    it('nothing is offered through a provider that is switched off or has no method for the service', async () => {
      await db.update(schema.paymentProviderConfigs).set({ isEnabled: false }).where(eq(schema.paymentProviderConfigs.id, providerId));
      expect(await payments.resolveCheckout(branchA, 'jenga_hq')).toBeNull();
      expect((await payments.listEnabledProviders(branchA)).map((p) => p.id)).not.toContain(providerId);
      await db.update(schema.paymentProviderConfigs).set({ isEnabled: true }).where(eq(schema.paymentProviderConfigs.id, providerId));
      expect(await payments.resolveCheckout(branchA, 'kcb_buni')).toBeNull();
    });

    it('a provider configured for one branch the older way is still offered there until it has a method', async () => {
      const [legacy] = await db.insert(schema.paymentProviderConfigs).values({ companyId, branchId: legacyBranch.id, providerCode: 'kcb_buni', displayName: `KCB legacy ${run}`, isEnabled: true, apiBaseUrl: 'https://x.test', credentialsEncrypted: { v: 1 } as never }).returning();
      const found = await payments.resolveCheckout(legacyBranch, 'kcb_buni');
      expect(found).toMatchObject({ methodId: null });
      expect(found!.provider.id).toBe(legacy.id);
      expect(await payments.resolveCheckout(branchA, 'kcb_buni')).toBeNull();
      expect((await payments.listEnabledProviders(legacyBranch)).map((p) => p.id)).toContain(legacy.id);
      // once a method exists for the branch it goes through that provider's method
      const m = await method(legacy.id, (await bank('co3')).id, { branchId: legacyBranch.id, kind: 'gateway' });
      expect((await payments.resolveCheckout(legacyBranch, 'kcb_buni'))!.methodId).toBe(m.id);
    });
  });

  describe('once the books are live', () => {
    it('a receipt through a branch method posts to that method\'s G/L account, on that branch', async () => {
      await fin.salesPosting.goLive(ctx, { offsetAccountId: (await fin.setup.listAccounts(companyId)).find((a) => a.no === '3100')!.id });
      const providerId = (await fin.paymentProviders.create(ctx, { providerCode: 'pesapal_v3', displayName: 'Pesapal Live' })).id;
      const m = await method(providerId, (await bank('live')).id, { branchId: branchB.id, glAccountId: glMombasa, kind: 'card' });
      const r = await receive(m.id, '750');
      const [rc] = await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.id, r.id));
      expect(rc.branchId).toBe(branchB.id);
      const [entry] = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, r.id));
      const lines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, entry.registerId!));
      expect(lines.find((l) => Number(l.debit) === 750)!.accountId).toBe(glMombasa);
      expect((await fin.salesPosting.reconciliation(companyId)).rows.map((x) => x.diffCents)).toEqual([0]);
    });
  });
});
