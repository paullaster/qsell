import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { parseCount } from './shift-rules';

/**
 * A shift's closing difference written to the books (database): the till's cash account against the over/short account, once, waiting
 * with a reason when the accounts are not chosen yet and written as soon as they are. It sets up finance for the company, so run it on a
 * database of its own:  TEST_DATABASE_URL=postgres://... pnpm exec vitest run src/server/domains/selling/shifts/shift-difference
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('till differences in the books (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let cashAccountId = '';
  let expenseGlId = '';
  const actor = { type: 'user' as const, id: 'shift-difference-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@sd.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const counted = (total: number) => {
    const r = parseCount({ total }, 'cash');
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const tillWith = async (cash: string | null) => {
    const name = `SD till ${randomUUID().slice(0, 6)}`;
    await c.shifts.saveRegister(companyId, actor, { branchId, name, isActive: true, cashAccountId: cash }, reason);
    const till = (await c.shifts.registerList(companyId)).find((r) => r.name === name);
    return till?.id ?? '';
  };
  const closeWith = async (registerId: string, float: number, declared: number) => {
    const person = await user('closer');
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId, float: counted(float) });
    if (!opened.ok) throw new Error(opened.error);
    const closed = await c.shifts.close(companyId, { userId: person.id, supervisor: true }, opened.shiftId, { declared: counted(declared), reason: declared === float ? '' : 'counted at the end of the day' });
    if (!closed.ok) throw new Error(closed.error);
    return opened.shiftId;
  };
  const bankEntries = async (shiftId: string) => await db.select().from(schema.bankLedgerEntries).where(and(eq(schema.bankLedgerEntries.documentType, 'shift_difference'), eq(schema.bankLedgerEntries.documentId, shiftId)));

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Differences Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const ctx = { companyId, actor, origin: { surface: 'test', action: 'setup' } };
    await c.finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('already has a chart')) throw error;
    });
    await c.finance.paymentMethods.seedStandard(ctx).catch(() => undefined);
    // A cash account for the tills with a way of paying that goes into it, and an account for the differences.
    const run = randomUUID().slice(0, 6).toUpperCase();
    const [provider] = await db.select({ id: schema.paymentMethods.providerId }).from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId)).limit(1);
    const [bank] = await db.insert(schema.bankAccounts).values({ companyId, code: `SDC${run}`, name: `Till cash ${run}`, kind: 'cash', currency: 'KES', createdBy: 'test' } as never).returning();
    const [cashGl] = await db.insert(schema.glAccounts).values({ companyId, no: `17${run}`, name: `Till cash ${run}`, type: 'posting', category: 'assets', normalBalance: 'debit' } as never).returning();
    const [expense] = await db.insert(schema.glAccounts).values({ companyId, no: `67${run}`, name: `Cash over and short ${run}`, type: 'posting', category: 'expenses', normalBalance: 'debit' } as never).returning();
    await db.insert(schema.paymentMethods).values({ companyId, providerId: provider?.id ?? '', code: `SDC${run}`, name: `Till cash ${run}`, kind: 'cash', balancingBankAccountId: bank?.id ?? '', glAccountId: cashGl?.id ?? '', usableFor: ['customer_receipt'], createdBy: 'test' } as never);
    cashAccountId = bank?.id ?? '';
    expenseGlId = expense?.id ?? '';
  });

  it('refuses a till cash account that is not a cash account, and a difference account that is not an open posting account', async () => {
    const [bank] = await db.insert(schema.bankAccounts).values({ companyId, code: `SDB${randomUUID().slice(0, 5)}`.toUpperCase(), name: 'A bank', kind: 'bank', currency: 'KES', createdBy: 'test' } as never).returning();
    await expect(c.shifts.saveRegister(companyId, actor, { branchId, name: `x${randomUUID().slice(0, 5)}`, isActive: true, cashAccountId: bank?.id ?? '' }, reason)).rejects.toThrow('cash accounts');
    await expect(c.shifts.saveSettings(companyId, actor, { tolerance: { amount: 100, percent: 1 }, supervisorClose: 'direct', varianceGlAccountId: randomUUID() }, reason)).rejects.toThrow('open posting account');
  });

  it('writes a short till to the books once: the cash account goes down by the difference', async () => {
    await c.shifts.saveSettings(companyId, actor, { tolerance: { amount: 100, percent: 1 }, supervisorClose: 'direct', varianceGlAccountId: expenseGlId }, reason);
    const till = await tillWith(cashAccountId);
    const shiftId = await closeWith(till, 1000, 950);
    expect(await c.shifts.report(companyId, shiftId)).toMatchObject({ variance: -50, differencePosting: { status: 'posted', note: null } });
    const entries = await bankEntries(shiftId);
    expect(entries.map((e) => Number(e.amount))).toEqual([-50]);
    expect(entries[0]?.bankAccountId).toBe(cashAccountId);
    expect(await c.shifts.postDifference(shiftId)).toBe(true);
    expect(await bankEntries(shiftId)).toHaveLength(1);
  });

  it('writes an over till as a gain, and writes nothing for a till that was right', async () => {
    const till = await tillWith(cashAccountId);
    const over = await closeWith(till, 1000, 1030);
    expect((await bankEntries(over)).map((e) => Number(e.amount))).toEqual([30]);
    const right = await closeWith(await tillWith(cashAccountId), 1000, 1000);
    expect(await bankEntries(right)).toEqual([]);
    expect((await c.shifts.report(companyId, right))?.differencePosting).toBeNull();
  });

  it('waits with the reason when the till has no cash account, closes all the same, and writes it once the account is chosen', async () => {
    const till = await tillWith(null);
    const shiftId = await closeWith(till, 1000, 940);
    const waiting = await c.shifts.report(companyId, shiftId);
    expect(waiting).toMatchObject({ status: 'closed', variance: -60 });
    expect(waiting?.differencePosting?.status).toBe('pending');
    expect(waiting?.differencePosting?.note).toContain('has no cash account');
    expect(await bankEntries(shiftId)).toEqual([]);
    await c.shifts.saveRegister(companyId, actor, { id: till, branchId, name: (await c.shifts.registerList(companyId)).find((r) => r.id === till)?.name ?? '', isActive: true, cashAccountId }, reason);
    expect(await c.shifts.postDueDifferences(500)).toBeGreaterThanOrEqual(0);
    expect(await c.shifts.postDifference(shiftId)).toBe(true);
    expect((await bankEntries(shiftId)).map((e) => Number(e.amount))).toEqual([-60]);
    expect((await c.shifts.report(companyId, shiftId))?.differencePosting).toMatchObject({ status: 'posted' });
  });

  it('waits when no account is chosen for differences', async () => {
    await c.shifts.saveSettings(companyId, actor, { tolerance: { amount: 100, percent: 1 }, supervisorClose: 'direct', varianceGlAccountId: null }, reason);
    try {
      const shiftId = await closeWith(await tillWith(cashAccountId), 1000, 980);
      const report = await c.shifts.report(companyId, shiftId);
      expect(report?.differencePosting?.status).toBe('pending');
      expect(report?.differencePosting?.note).toContain('No account is chosen');
    } finally {
      await c.shifts.saveSettings(companyId, actor, { tolerance: { amount: 100, percent: 1 }, supervisorClose: 'direct', varianceGlAccountId: expenseGlId }, reason);
    }
  });

  it('once the books are live, posts a balanced entry: a short till debits the over and short account and credits the cash', async () => {
    await db.update(schema.financeSettings).set({ salesGlGoLive: '2026-01-01' }).where(eq(schema.financeSettings.companyId, companyId));
    try {
      const shiftId = await closeWith(await tillWith(cashAccountId), 1000, 925);
      const [entry] = await bankEntries(shiftId);
      expect(entry?.registerId).not.toBeNull();
      const lines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, entry?.registerId ?? ''));
      const byAccount = new Map(lines.map((l) => [l.accountId, [Number(l.debit), Number(l.credit)] as const]));
      expect(byAccount.get(expenseGlId)).toEqual([75, 0]);
      expect(lines.reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0)).toBe(0);
      expect(lines).toHaveLength(2);
    } finally {
      await db.update(schema.financeSettings).set({ salesGlGoLive: null }).where(eq(schema.financeSettings.companyId, companyId));
    }
  });
});
