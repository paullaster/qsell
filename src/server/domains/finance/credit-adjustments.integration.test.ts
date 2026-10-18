import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceServices } from './index';
import type * as mod_server_kernel_after_commit from '@/server/kernel/after-commit';
import type { FinanceContext } from './errors';
import type { PolicyInput } from './receivables/credit-policy-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('credit adjustments (database)', () => {
  type Db = DrizzleDb;
  let db: Db;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: AppContainer;
  let fin: FinanceServices;
  let withAfterCommit: typeof mod_server_kernel_after_commit.withAfterCommit;
  let companyId: string;
  let asker: string;
  let decider: string;
  let ctx: FinanceContext; // does everything, a system tester
  let askCtx: FinanceContext;
  let decideCtx: FinanceContext;
  const acct: Record<string, string> = {};
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  const origin = { surface: 'test', action: 'run' };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (isRecord(e) && 'code' in e) return readText(e.code);
      return `OTHER:${(e as Error).message}`;
    }
  };
  const policy = (o: Partial<PolicyInput> = {}) =>
    fin.creditPolicy.save(ctx, { groupCode: null, walletEnabled: true, allowDeposits: true, overpaymentDefault: 'ask', autoApply: 'never', creditNoteExcess: 'ask', refundsEnabled: true, walletCashOut: false, maxBalance: null, expiryDays: null, expiryNoticeDays: 30, label: 'Wallet', ...o });
  const user = async (label: string) => (await db.insert(schema.users).values({ email: `${label}-${randomUUID()}@adj.test`, passwordHash: 'x', name: label, role: 'manager' }).returning())[0].id;
  async function customer() {
    seq += 1;
    const [cust] = await db.insert(schema.customers).values({ companyId, number: `CA${run}${seq}`, name: `Adjust ${seq}`, accountType: 'credit', creditLimit: '10000000' }).returning();
    return cust;
  }
  async function receipt(cust: { id: string }, amount: string, o: { deposit?: boolean } = {}) {
    const cash = required((await fin.paymentMethods.list(companyId)).find((m) => m.method.code === 'CASH')).method.id;
    const r = await fin.receipts.create(ctx, { customerId: cust.id, paymentMethodId: cash, amount, paymentDate: today, isDeposit: o.deposit });
    await fin.receipts.post(ctx, r.id, { allocate: 'none' });
    return r.id;
  }
  /** A wallet holding `amount`, by way of an advance deposit. */
  async function funded(amount: string) {
    const cust = await customer();
    await receipt(cust, amount, { deposit: true });
    return cust;
  }
  const wallet = async (cust: { id: string }) => (await db.select().from(schema.customerWallets).where(eq(schema.customerWallets.customerId, cust.id)))[0];
  const ask = (cust: { id: string }, kind: 'waive_excess' | 'wallet_increase' | 'wallet_decrease', amount: string, o: Record<string, unknown> = {}, by = askCtx) =>
    fin.creditAdjustments.request(by, { kind, customerId: cust.id, amount, reasonCode: 'CUSTOMER_REQUEST', ...o });
  const row = async (id: string) => (await db.select().from(schema.creditAdjustments).where(eq(schema.creditAdjustments.id, id)))[0];
  const glNet = async (no: string) => {
    const [r] = await db.execute<{ n: string }>(sql`SELECT COALESCE(SUM(base_credit - base_debit),0)::text n FROM gl_account_balances WHERE company_id=${companyId}::uuid AND account_id=${acct[no]}::uuid`);
    return Number(r.n);
  };
  async function workflow(approverUserId: string) {
    const wf = await c.approvalConfig.createWorkflow(companyId, { code: `W-${randomUUID().slice(0, 8)}`, name: 'Adjustment test', trigger: 'credit_adjustment.requested' }, { type: 'user', id: 'tester' });
    await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'gte', field: 'amount', value: 1 }, steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: approverUserId } }] } as never, { type: 'user', id: 'tester' });
    await c.approvalConfig.publish(companyId, wf.id, { type: 'user', id: 'tester' }, { code: 'POLICY_CHANGE' });
    return wf;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ withAfterCommit } = await import('@/server/kernel/after-commit'));
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    fin = c.finance;
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'CA', tradingName: 'CA', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    companyId = company.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    [asker, decider] = await Promise.all([user('asker'), user('decider')]);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    askCtx = { ...ctx, actor: { type: 'user', id: asker } };
    decideCtx = { ...ctx, actor: { type: 'user', id: decider } };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    for (const a of await fin.setup.listAccounts(companyId)) acct[a.no] = a.id;
    await policy();
  });

  describe('giving up an excess nobody will claim', () => {
    it('is asked by one person and decided by another, and takes the money off the customer\'s credit', async () => {
      const cust = await customer();
      const rc = await receipt(cust, '250');
      const a = await ask(cust, 'waive_excess', '100', { sourceKind: 'receipt_unapplied', sourceId: rc });
      expect(a.number).toMatch(/^CAJ-/);
      expect(await fin.creditAdjustments.submit(askCtx, a.id)).toEqual({ status: 'requested' });
      // the asker cannot decide their own; nothing has changed yet
      expect(await codeOf(fin.creditAdjustments.decide(askCtx, a.id, 'approve'))).toBe('SAME_PERSON');
      expect(required(await fin.receipts.detail(companyId, rc)).unappliedCents).toBe(25000);
      expect(await fin.creditAdjustments.decide(decideCtx, a.id, 'approve')).toEqual({ status: 'applied' });
      expect(required(await fin.receipts.detail(companyId, rc)).unappliedCents).toBe(15000);
      expect(await row(a.id)).toMatchObject({ status: 'applied', decidedBy: decider });
      // decided once
      expect(await codeOf(fin.creditAdjustments.decide(decideCtx, a.id, 'approve'))).toBe('BAD_STATE');
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
    });

    it('can never exceed what is owed, counting refunds and other adjustments already spoken for', async () => {
      const cust = await customer();
      const rc = await receipt(cust, '250');
      expect(await codeOf(ask(cust, 'waive_excess', '250.01', { sourceKind: 'receipt_unapplied', sourceId: rc }))).toBe('OVER_OBLIGATION');
      await ask(cust, 'waive_excess', '200', { sourceKind: 'receipt_unapplied', sourceId: rc });
      expect(await codeOf(ask(cust, 'waive_excess', '60', { sourceKind: 'receipt_unapplied', sourceId: rc }))).toBe('OVER_OBLIGATION');
      // a refund cannot claim what a waiting adjustment already holds
      const cash = required((await fin.paymentMethods.list(companyId)).find((m) => m.method.code === 'CASH')).method.id;
      expect(await codeOf(fin.refunds.create(ctx, { customerId: cust.id, sourceKind: 'receipt_unapplied', sourceId: rc, amount: '60', paymentMethodId: cash, payoutDetails: { recipientName: 'X' }, reasonCode: 'CUSTOMER_REQUEST' }))).toBe('OVER_OBLIGATION');
      // only an excess can be given up, and only for this customer
      expect(await codeOf(ask(cust, 'waive_excess', '10', { sourceKind: 'wallet', sourceId: rc }))).toBe('SOURCE_INVALID');
      const other = await customer();
      expect(await codeOf(ask(other, 'waive_excess', '10', { sourceKind: 'receipt_unapplied', sourceId: rc }))).toBe('SOURCE_NOT_FOUND');
    });

    it('a request turned down needs a reason and changes nothing; one cancelled cannot be decided', async () => {
      const cust = await customer();
      const rc = await receipt(cust, '90');
      const a = await ask(cust, 'waive_excess', '90', { sourceKind: 'receipt_unapplied', sourceId: rc });
      expect(await codeOf(fin.creditAdjustments.decide(decideCtx, a.id, 'reject'))).toBe('NOTE_REQUIRED');
      await fin.creditAdjustments.decide(decideCtx, a.id, 'reject', 'the customer is coming for it');
      expect((await row(a.id)).status).toBe('rejected');
      expect(required(await fin.receipts.detail(companyId, rc)).unappliedCents).toBe(9000);
      const b = await ask(cust, 'waive_excess', '40', { sourceKind: 'receipt_unapplied', sourceId: rc });
      await fin.creditAdjustments.cancel(askCtx, b.id, { code: 'DATA_ENTRY_ERROR' });
      expect(await codeOf(fin.creditAdjustments.decide(decideCtx, b.id, 'approve'))).toBe('BAD_STATE');
      expect(await codeOf(fin.creditAdjustments.cancel(askCtx, b.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('NOT_ACTIVE');
    });

    it('the credit note excess is reduced too, and the waiver shows among its resolutions', async () => {
      const cust = await customer();
      const rc = await receipt(cust, '300');
      const a = await ask(cust, 'waive_excess', '300', { sourceKind: 'receipt_unapplied', sourceId: rc });
      await fin.creditAdjustments.decide(decideCtx, a.id, 'approve');
      const obs = await fin.refunds.obligations(companyId, cust.id);
      expect(obs.filter((o) => o.id === rc)).toEqual([]);
    });
  });

  describe('adding to and taking from a wallet', () => {
    it('adds goodwill and takes a correction off, each decided by another person', async () => {
      const cust = await funded('500');
      expect((await wallet(cust)).balance).toBe('500.00');
      const up = await ask(cust, 'wallet_increase', '50');
      await fin.creditAdjustments.decide(decideCtx, up.id, 'approve');
      expect((await wallet(cust)).balance).toBe('550.00');
      const down = await ask(cust, 'wallet_decrease', '200');
      await fin.creditAdjustments.decide(decideCtx, down.id, 'approve');
      expect((await wallet(cust)).balance).toBe('350.00');
      const entries = await db.select().from(schema.walletEntries).where(eq(schema.walletEntries.customerId, cust.id)).orderBy(schema.walletEntries.id);
      expect(entries.map((e) => [e.entryType, e.amount])).toEqual([['deposit', '500.00'], ['adjustment', '50.00'], ['adjustment', '-200.00']]);
    });

    it('never takes more than is in the wallet, counting what is already asked for, and the wallet must be on', async () => {
      const cust = await funded('100');
      expect(await codeOf(ask(cust, 'wallet_decrease', '100.01'))).toBe('WALLET_INSUFFICIENT');
      await ask(cust, 'wallet_decrease', '80');
      expect(await codeOf(ask(cust, 'wallet_decrease', '30'))).toBe('WALLET_INSUFFICIENT');
      const none = await customer();
      expect(await codeOf(ask(none, 'wallet_decrease', '1'))).toBe('WALLET_INSUFFICIENT');
      await policy({ walletEnabled: false });
      expect(await codeOf(ask(cust, 'wallet_increase', '5'))).toBe('WALLET_OFF');
      await policy();
    });

    it('respects the most a wallet may hold when adding', async () => {
      await policy({ maxBalance: '120' });
      const cust = await funded('100');
      const up = await ask(cust, 'wallet_increase', '50');
      expect(await codeOf(fin.creditAdjustments.decide(decideCtx, up.id, 'approve'))).toBe('WALLET_LIMIT');
      expect((await row(up.id)).status).toBe('requested');
      await policy();
    });

    it('can start a wallet that does not exist yet (goodwill to a new customer)', async () => {
      const cust = await customer();
      const up = await ask(cust, 'wallet_increase', '25');
      await fin.creditAdjustments.decide(decideCtx, up.id, 'approve');
      expect((await wallet(cust)).balance).toBe('25.00');
    });
  });

  describe('in the books, once sales are live', () => {
    beforeAll(async () => {
      await fin.salesPosting.goLive(ctx, { offsetAccountId: acct['3100'] });
    });

    it('giving up credit is income, a lapse or a take-off is income, goodwill is a cost, and the wallet books stay in step', async () => {
      const cust = await funded('500');
      const forfeit0 = await glNet('4430');
      const cost0 = await glNet('6320');
      const up = await ask(cust, 'wallet_increase', '40');
      await fin.creditAdjustments.decide(decideCtx, up.id, 'approve');
      expect(await glNet('6320')).toBe(cost0 - 40); // a debit
      const down = await ask(cust, 'wallet_decrease', '100');
      await fin.creditAdjustments.decide(decideCtx, down.id, 'approve');
      expect(await glNet('4430')).toBe(forfeit0 + 100);
      expect((await fin.wallets.reconciliation(companyId))[0].diffCents).toBe(0);

      const rc = await receipt(cust, '70');
      const waive = await ask(cust, 'waive_excess', '70', { sourceKind: 'receipt_unapplied', sourceId: rc });
      await fin.creditAdjustments.decide(decideCtx, waive.id, 'approve');
      expect(await glNet('4430')).toBe(forfeit0 + 170);
      const applied = await row(waive.id);
      const lines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, required(applied.registerId)));
      const no = new Map(Object.entries(acct).map(([n, id]) => [id, n]));
      expect(lines.map((l) => [no.get(l.accountId), Number(l.debit), Number(l.credit)]).sort()).toEqual([['1210', 70, 0], ['4430', 0, 70]]);
      expect(await fin.customerLedger.drift(companyId)).toEqual([]);
    });

    it('a wallet in dollars: goodwill is added at the day\'s rate and a take-off leaves at what the wallet is worth per dollar', async () => {
      const bank = (await db.insert(schema.bankAccounts).values({ companyId, code: `USD${run}`, name: `Dollar bank ${run}`, kind: 'bank', currency: 'USD', createdBy: 'test' }).returning())[0];
      const gl = (await db.insert(schema.glAccounts).values({ companyId, no: `19${run}`, name: `Dollar bank ${run}`, type: 'posting', category: 'assets', normalBalance: 'debit' }).returning())[0];
      const [anyMethod] = await db.select({ providerId: schema.paymentMethods.providerId }).from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId)).limit(1);
      const method = (await db.insert(schema.paymentMethods).values({ companyId, providerId: anyMethod.providerId, code: `USD${run}`, name: `Dollars ${run}`, kind: 'bank_transfer', balancingBankAccountId: bank.id, glAccountId: gl.id, usableFor: ['customer_receipt'], createdBy: 'test' }).returning())[0];
      await fin.fx.setRate(ctx, { currency: 'USD', effectiveOn: today, rate: '128' });
      const cust = await customer();
      const r = await fin.receipts.create(ctx, { customerId: cust.id, paymentMethodId: method.id, amount: '100', paymentDate: today, isDeposit: true, currency: 'USD', rate: '129' });
      await fin.receipts.post(ctx, r.id, { allocate: 'none' });
      const forfeit0 = await glNet('4430');
      const up = await ask(cust, 'wallet_increase', '10', { currency: 'USD' });
      await fin.creditAdjustments.decide(decideCtx, up.id, 'approve');
      const down = await ask(cust, 'wallet_decrease', '55', { currency: 'USD' });
      await fin.creditAdjustments.decide(decideCtx, down.id, 'approve');
      const held = (await db.select().from(schema.customerWallets).where(and(eq(schema.customerWallets.customerId, cust.id), eq(schema.customerWallets.currency, 'USD'))))[0];
      // 100 at 129 and 10 at 128 are worth 14,180; 55 of the 110 leave at 128.90909091 a dollar
      expect([held.balance, Number(held.baseValue)]).toEqual(['55.00', 7090]);
      expect(await glNet('4430')).toBe(forfeit0 + 7090);
      expect((await fin.wallets.reconciliation(companyId))[0].diffCents).toBe(0);
    });

    it('refuses with a clear message when the posting setup has no account for it, and nothing is changed', async () => {
      const cust = await funded('100');
      await db.update(schema.customerPostingGroups).set({ creditForfeitAccountId: null }).where(eq(schema.customerPostingGroups.companyId, companyId));
      const down = await ask(cust, 'wallet_decrease', '30');
      expect(await codeOf(fin.creditAdjustments.decide(decideCtx, down.id, 'approve'))).toBe('POSTING_SETUP_MISSING');
      expect((await wallet(cust)).balance).toBe('100.00');
      expect((await row(down.id)).status).toBe('requested');
      await db.update(schema.customerPostingGroups).set({ creditForfeitAccountId: acct['4430'] }).where(eq(schema.customerPostingGroups.companyId, companyId));
    });
  });

  describe('with an approval workflow', () => {
    let boss: string;
    beforeAll(async () => {
      boss = await user('boss');
      await c.approvalConfig.saveProfile(companyId, { userId: boss, limits: [] }, { type: 'user', id: 'tester' }, { code: 'POLICY_CHANGE' });
      await workflow(boss);
    });
    const openEntry = async (id: string) => required((await c.approvals.forDocument(companyId, 'credit_adjustment', id)).flatMap((r) => r.entries).find((e) => e.status === 'open'));

    it('goes to the approver; nothing happens until they approve, and nobody can decide it by hand meanwhile', async () => {
      const cust = await funded('300');
      const a = await ask(cust, 'wallet_decrease', '100');
      expect(await fin.creditAdjustments.submit(askCtx, a.id)).toEqual({ status: 'pending_approval' });
      expect((await wallet(cust)).balance).toBe('300.00');
      expect(await codeOf(fin.creditAdjustments.decide(decideCtx, a.id, 'approve'))).toBe('BAD_STATE');
    });

    it('applies when the approver approves, and not when they reject or the asker withdraws', async () => {
      const cust = await funded('300');
      const yes = await ask(cust, 'wallet_decrease', '100');
      await fin.creditAdjustments.submit(askCtx, yes.id);
      await withAfterCommit(db, async (tx) => await c.approvals.approve((await openEntry(yes.id)).id, boss, null, tx));
      expect((await row(yes.id)).status).toBe('applied');
      expect((await wallet(cust)).balance).toBe('200.00');

      const no = await ask(cust, 'wallet_decrease', '50');
      await fin.creditAdjustments.submit(askCtx, no.id);
      await withAfterCommit(db, async (tx) => await c.approvals.reject((await openEntry(no.id)).id, boss, { reasonCode: 'OTHER', comment: 'No' }, tx));
      expect((await row(no.id)).status).toBe('rejected');

      const gone = await ask(cust, 'wallet_decrease', '50');
      await fin.creditAdjustments.submit(askCtx, gone.id);
      await fin.creditAdjustments.cancel(askCtx, gone.id, { code: 'DATA_ENTRY_ERROR' });
      expect((await row(gone.id)).status).toBe('cancelled');
      expect((await wallet(cust)).balance).toBe('200.00');
    });
  });

  describe('a balance nobody used lapses', () => {
    const backdate = (cust: { id: string }, days: number) => db.update(schema.customerWallets).set({ updatedAt: new Date(Date.now() - days * 86_400_000) }).where(eq(schema.customerWallets.customerId, cust.id));

    it('lapses once the policy\'s days have passed, once, and keeps the record', async () => {
      await policy({ expiryDays: 90, expiryNoticeDays: 30 });
      const old = await funded('400');
      const fresh = await funded('300');
      const used = await funded('200');
      await backdate(old, 120);
      await backdate(used, 10);
      const first = await fin.creditAdjustments.expireDormant(new Date());
      expect(first.failed).toBe(0);
      expect((await wallet(old)).balance).toBe('0.00');
      expect((await wallet(fresh)).balance).toBe('300.00');
      expect((await wallet(used)).balance).toBe('200.00');
      const lapsed = (await db.select().from(schema.creditAdjustments).where(and(eq(schema.creditAdjustments.customerId, old.id), eq(schema.creditAdjustments.kind, 'wallet_expiry'))))[0];
      expect(lapsed).toMatchObject({ status: 'applied', amount: '400.00', reasonCode: 'CREDIT_LAPSED' });
      const entries = await db.select().from(schema.walletEntries).where(eq(schema.walletEntries.customerId, old.id)).orderBy(schema.walletEntries.id);
      expect(entries.at(-1)).toMatchObject({ entryType: 'expiry', amount: '-400.00' });
      // running it again changes nothing
      const second = await fin.creditAdjustments.expireDormant(new Date());
      expect(second.expired).toBe(0);
      expect((await db.select().from(schema.creditAdjustments).where(and(eq(schema.creditAdjustments.customerId, old.id), eq(schema.creditAdjustments.kind, 'wallet_expiry'))))).toHaveLength(1);
      await policy();
    });

    it('leaves a frozen wallet alone, and lists balances about to lapse soonest first', async () => {
      await policy({ expiryDays: 90, expiryNoticeDays: 30 });
      const frozen = await funded('50');
      await fin.wallets.setFrozen(ctx, frozen.id, 'KES', true, 'under review');
      await backdate(frozen, 400);
      await fin.creditAdjustments.expireDormant(new Date());
      expect((await wallet(frozen)).balance).toBe('50.00');
      const soon = await funded('75');
      await backdate(soon, 70);
      const list = await fin.creditAdjustments.expiringSoon(companyId, new Date());
      const mine = list.find((r) => r.customerId === soon.id);
      expect(mine).toMatchObject({ state: 'soon', balance: '75.00', expiryDays: 90 });
      await policy();
    });

    it('does nothing for a policy that never lets balances lapse', async () => {
      await policy({ expiryDays: null });
      const cust = await funded('60');
      await backdate(cust, 2000);
      await fin.creditAdjustments.expireDormant(new Date());
      expect((await wallet(cust)).balance).toBe('60.00');
    });

    it('refuses silly expiry settings', async () => {
      expect(await codeOf(policy({ expiryDays: 5 }))).toBe('EXPIRY_INVALID');
      expect(await codeOf(policy({ expiryDays: 60, expiryNoticeDays: 60 }))).toBe('EXPIRY_INVALID');
    });
  });

  it('another company cannot see or decide it', async () => {
    const cust = await funded('40');
    const a = await ask(cust, 'wallet_decrease', '10');
    const stranger: FinanceContext = { ...decideCtx, companyId: randomUUID() };
    expect(await codeOf(fin.creditAdjustments.decide(stranger, a.id, 'approve'))).toBe('NOT_FOUND');
    expect(await fin.creditAdjustments.detail(stranger.companyId, a.id)).toBeNull();
  });
});
