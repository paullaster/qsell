import { beforeAll, describe, expect, it } from 'vitest';
import type * as ClientModule from '@/server/db/drizzle/client';
import type * as SchemaModule from '@/server/db/drizzle/schema';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { RegisteredExecutor } from '../engine/run';
import type { StatementReport } from '../analysis/types';
import { has } from '@/lib/values';

/**
 * The financial statements against a real ledger built from the migrations:
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * A company of its own is made here, so nothing else in a shared database changes the figures. A year of balanced journals is
 * posted through the real posting engine, and every statement is read back through its executor.
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('financial statements (database)', () => {
  let db: typeof ClientModule.drizzleDb;
  let executors: RegisteredExecutor[];
  let companyId: string;
  const NOW = new Date('2026-11-05T09:00:00Z');
  const allowed: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['reports:all_branches']);
  const acct: Record<string, string> = {};

  const run = async (code: string, raw: Record<string, string>): Promise<StatementReport> => {
    const executor = executors.find((e) => e.code === code);
    if (executor === undefined) throw new Error(`no executor ${code}`);
    const prepared = executor.prepare(raw);
    if (!prepared.ok) throw new Error(prepared.error);
    const result = await prepared.run.execute({
      userId: 'a-user',
      allowed,
      now: NOW,
      maxRows: 500,
      wantTable: true,
    });
    return result.data as StatementReport;
  };
  const october = { period: 'custom', from: '2026-10-01', to: '2026-10-31' };
  const val = (s: StatementReport, key: string, col = 0): number | null =>
    s.lines.find((l) => l.key === key)?.values[col] ?? null;

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    const schema: typeof SchemaModule = await import('@/server/db/drizzle/schema');
    const eng = await import('@/server/domains/finance/engine');
    const { DecisionLog } = await import('@/server/kernel/decision-log/service');
    const { FiscalService } = await import('@/server/domains/finance/fiscal-service');
    const { FinanceSetupService } = await import('@/server/domains/finance/setup-service');
    const decisions = new DecisionLog(db);
    const fiscal = new FiscalService(db, decisions);
    const setup = new FinanceSetupService(db, decisions, fiscal);
    const engine = new eng.PostingEngine(db, decisions);

    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const [company] = await db
      .insert(schema.companySettings)
      .values({
        legalName: 'Stmt',
        tradingName: 'Stmt',
        email: 'a@b.c',
        phone: '1',
        streetAddress: 's',
        city: 'c',
        countyOrState: 'x',
        postalCode: '1',
        kraPin: 'P',
      })
      .returning();
    companyId = company?.id ?? '';
    const origin = { surface: 'test', action: 'run' };
    const ctx = { companyId, actor: { type: 'user' as const, id: 'tester' }, origin };
    await setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    for (const a of await setup.listAccounts(companyId)) acct[a.no] = a.id;

    let n = 0;
    const post = async (date: string, debit: string, credit: string, amount: string) => {
      n += 1;
      await engine.post({
        companyId,
        idempotencyKey: `stmt-${String(n)}`,
        postingDate: date,
        documentType: 'journal',
        documentNo: `STMT-${String(n)}`,
        currency: 'KES',
        rate: '1',
        rateSource: 'base' as const,
        chainKey: 'general',
        origin,
        postedBy: 'engine' as const,
        lines: [
          { accountId: acct[debit] ?? '', debit: amount, credit: '0' },
          { accountId: acct[credit] ?? '', debit: '0', credit: amount },
        ],
      });
    };
    // Opening position in September: cash 1,000 against capital 1,000.
    await post('2026-09-15', '1110', '3100', '1000');
    // October: the same year of events the unit test works by hand.
    await post('2026-10-02', '1110', '3100', '500'); // capital introduced
    await post('2026-10-03', '1110', '2410', '300'); // a loan
    await post('2026-10-04', '1510', '1110', '400'); // equipment bought for cash
    await post('2026-10-05', '1210', '4100', '2000'); // sales on credit
    await post('2026-10-08', '1110', '1210', '1500'); // collected
    await post('2026-10-09', '1310', '2110', '800'); // stock bought on credit
    await post('2026-10-10', '2110', '1110', '500'); // part paid
    await post('2026-10-11', '5100', '1310', '600'); // cost of goods sold
    await post('2026-10-12', '6200', '1110', '200'); // rent
    await post('2026-10-13', '6600', '1520', '40'); // depreciation
    await post('2026-10-14', '3300', '1110', '100'); // owner drawings
    await post('2026-10-15', '1110', '4400', '50'); // other income

    const { financialExecutors } = await import('./financial');
    executors = financialExecutors({ db, companyId: () => Promise.resolve(companyId) });
  });

  it('works out the income statement and proves it against the ledger', async () => {
    const s = await run('income-statement', october);
    expect(val(s, 'net-sales')).toBe(2000);
    expect(val(s, 'cost-total')).toBe(600);
    expect(val(s, 'gross')).toBe(1400);
    expect(val(s, 'exp-total')).toBe(240);
    expect(val(s, 'operating')).toBe(1160);
    expect(val(s, 'other-total')).toBe(50);
    expect(val(s, 'net-profit')).toBe(1210);
    expect(s.checks.every((c) => c.ok)).toBe(true);
    // The comparison period (September) had no profit and loss at all.
    expect(val(s, 'net-profit', 1)).toBe(0);
  });

  it('takes sales accounts from the posting setup and the rest as other income', async () => {
    const s = await run('income-statement', october);
    expect(s.lines.some((l) => l.label === 'Sales of goods')).toBe(true);
    expect(s.lines.find((l) => l.key === 'other')?.kind).toBe('heading');
  });

  it('balances the balance sheet, reading closed periods from the running balances', async () => {
    const s = await run('balance-sheet', october);
    expect(val(s, 'assets-total')).toBe(3210);
    expect(val(s, 'liabilities-total')).toBe(600);
    expect(val(s, 'equity-total')).toBe(2610);
    expect(s.checks).toEqual([expect.objectContaining({ key: 'balances', ok: true })]);
    // The day before the period: only the opening position.
    expect(val(s, 'assets-total', 1)).toBe(1000);
    expect(s.facts.canPickBranch).toBe(false);
  });

  it('rolls retained earnings forward to the equity on the balance sheet', async () => {
    const s = await run('changes-in-equity', october);
    expect(s.lines.find((l) => l.key === 'opening')?.values).toEqual([1000, 0, 1000]);
    expect(s.lines.find((l) => l.key === 'profit')?.values).toEqual([0, 1210, 1210]);
    expect(s.lines.find((l) => l.key === 'drawings')?.values).toEqual([0, -100, -100]);
    expect(s.lines.find((l) => l.key === 'closing')?.values).toEqual([1500, 1110, 2610]);
    expect(s.checks.every((c) => c.ok)).toBe(true);
  });

  it('explains the change in cash and ends on the cash and bank accounts', async () => {
    const s = await run('cash-flow', october);
    expect(val(s, 'profit')).toBe(1210);
    expect(val(s, 'depreciation')).toBe(40);
    expect(val(s, 'operating-total')).toBe(850);
    expect(val(s, 'investing-total')).toBe(-400);
    expect(val(s, 'financing-total')).toBe(700);
    expect(val(s, 'net-change')).toBe(1150);
    expect(val(s, 'opening-cash')).toBe(1000);
    expect(val(s, 'closing-cash')).toBe(2150);
    expect(s.checks).toEqual([expect.objectContaining({ key: 'matches-cash', ok: true })]);
  });

  it('returns the statement as a table for a download', async () => {
    const s = await run('income-statement', october);
    expect(s.table.rows.length).toBe(s.lines.length);
    expect(s.table.columns.map((c) => c.kind)).toEqual([
      'text',
      'money',
      'money',
      'money',
      'percent',
    ]);
  });

  it('is empty, not wrong, for a period before anything was posted', async () => {
    const s = await run('balance-sheet', {
      period: 'custom',
      from: '2020-01-01',
      to: '2020-01-31',
    });
    expect(val(s, 'assets-total')).toBe(0);
    expect(s.checks.every((c) => c.ok)).toBe(true);
  });
});
