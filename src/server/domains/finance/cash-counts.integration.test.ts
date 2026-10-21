import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { FinanceServices } from './index';
import type { FinanceContext } from './errors';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('cash counts (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let fin: FinanceServices;
  let companyId: string;
  let glCash: string;
  let glExpense: string;
  let glIncome: string;
  let manualProvider: string;
  let ctx: FinanceContext;
  const run = randomUUID().slice(0, 6).toUpperCase();
  let seq = 0;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
  const day = (back: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10);
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (isRecord(e) && 'code' in e) return readText(e.code);
      return `OTHER:${(e as Error).message}`;
    }
  };

  /** A cash account of its own, with a method paying into it and `amount` of cash taken in on `on`. */
  async function drawer(amount: string, on = day(1), kind: 'cash' | 'bank' = 'cash') {
    seq += 1;
    const account = await fin.bankAccounts.create(ctx, {
      code: `CD${run}${seq}`,
      name: `Drawer ${seq}`,
      kind,
      currency: 'KES',
    });
    const method = await fin.paymentMethods.create(ctx, {
      code: `CDM${run}${seq}`,
      name: `Cash ${seq}`,
      kind: 'cash',
      balancingBankAccountId: account.id,
      providerId: manualProvider,
      glAccountId: glCash,
      usableFor: ['customer_receipt'],
      refundDestination: 'none',
    });
    const [c] = await db
      .insert(schema.customers)
      .values({
        companyId,
        number: `CC${run}${seq}`,
        name: `Cash customer ${seq}`,
        accountType: 'cash',
        creditLimit: '0',
      })
      .returning();
    const r = await fin.receipts.create(ctx, {
      customerId: c.id,
      paymentMethodId: method.id,
      amount,
      paymentDate: on,
      postingDate: on,
      externalReference: `CASH${run}${seq}`,
    });
    await fin.receipts.post(ctx, r.id, { allocate: 'none' });
    return { account, method };
  }
  const counts = (accountId: string) =>
    db
      .select()
      .from(schema.cashCounts)
      .where(eq(schema.cashCounts.bankAccountId, accountId))
      .orderBy(schema.cashCounts.createdAt);
  const balance = async (accountId: string, date = today) =>
    fin.cashCounts.bookBalanceCents(db, accountId, date);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const c = getContainer();
    fin = c.finance;
    const [company] = await db
      .insert(schema.companySettings)
      .values({
        legalName: 'CC',
        tradingName: 'CC',
        email: 'a@b.c',
        phone: '1',
        streetAddress: 's',
        city: 'c',
        countyOrState: 'x',
        postalCode: '1',
        kraPin: 'P',
      })
      .returning();
    companyId = company.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    ctx = {
      companyId,
      actor: { type: 'user', id: 'tester' },
      origin: { surface: 'test', action: 'run' },
    };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    const accts = await fin.setup.listAccounts(companyId);
    glCash = required(accts.find((a) => a.no === '1120')).id;
    glExpense = required(accts.find((a) => a.category === 'expense' && a.type === 'posting')).id;
    glIncome = required(accts.find((a) => a.category === 'income' && a.type === 'posting')).id;
    manualProvider = required(
      (await fin.paymentMethods.providerChoices(companyId)).find((p) => p.isSystem),
    ).id;
  });

  it('reads what the books say a drawer held at the end of a day', async () => {
    const d = await drawer('1000.00', day(3));
    expect(await balance(d.account.id, day(4))).toBe(0);
    expect(await balance(d.account.id, day(3))).toBe(100_000);
    const preview = await fin.cashCounts.preview(companyId, d.account.id, today);
    expect(preview).toMatchObject({
      currency: 'KES',
      bookCents: 100_000,
      lastVariance: null,
      glChoiceCount: 1,
    });
  });

  it('records a count that agrees without touching the books, and keeps it', async () => {
    const d = await drawer('500.00');
    const out = await fin.cashCounts.post(ctx, {
      bankAccountId: d.account.id,
      countDate: today,
      denominations: [{ value: '500', count: '1' }],
    });
    expect(out).toMatchObject({ difference: '0.00', gl: false });
    expect(out.number).toMatch(/^CCT-/);
    const [c] = await counts(d.account.id);
    expect(c).toMatchObject({
      countedAmount: '500.00',
      expectedAmount: '500.00',
      difference: '0.00',
      varianceGlAccountId: null,
      bankEntryId: null,
    });
    expect(c.denominations).toEqual([{ value: '500.00', count: 1 }]);
    expect(await balance(d.account.id)).toBe(50_000);
  });

  it('writes a shortage to the account chosen, with a reason, and the drawer then holds what was counted', async () => {
    const d = await drawer('2000.00');
    expect(
      await codeOf(
        fin.cashCounts.post(ctx, {
          bankAccountId: d.account.id,
          countDate: today,
          total: '1850.00',
        }),
      ),
    ).toBe('COUNT_INCOMPLETE');
    expect(
      await codeOf(
        fin.cashCounts.post(ctx, {
          bankAccountId: d.account.id,
          countDate: today,
          total: '1850.00',
          varianceGlAccountId: glExpense,
        }),
      ),
    ).toBe('COUNT_INCOMPLETE');
    expect(
      await codeOf(
        fin.cashCounts.post(ctx, {
          bankAccountId: d.account.id,
          countDate: today,
          total: '1850.00',
          varianceGlAccountId: randomUUID(),
          note: 'change given wrongly',
        }),
      ),
    ).toBe('VARIANCE_ACCOUNT_INVALID');
    const out = await fin.cashCounts.post(ctx, {
      bankAccountId: d.account.id,
      countDate: today,
      total: '1850.00',
      varianceGlAccountId: glExpense,
      note: 'change given wrongly',
    });
    expect(out.difference).toBe('-150.00');
    const [c] = await counts(d.account.id);
    expect(c).toMatchObject({
      countedAmount: '1850.00',
      expectedAmount: '2000.00',
      difference: '-150.00',
      note: 'change given wrongly',
      countedBy: 'tester',
    });
    expect(await balance(d.account.id)).toBe(185_000);
    const [e] = await db
      .select()
      .from(schema.bankLedgerEntries)
      .where(
        and(
          eq(schema.bankLedgerEntries.bankAccountId, d.account.id),
          eq(schema.bankLedgerEntries.documentType, 'cash_count'),
        ),
      );
    expect(e).toMatchObject({ amount: '-150.0000', documentId: c.id });
    // The next preview offers the account used last time.
    const next = await fin.cashCounts.preview(companyId, d.account.id, today);
    expect(next.lastVariance?.id).toBe(glExpense);
    expect(next.bookCents).toBe(185_000);
  });

  it('writes an overage the other way', async () => {
    const d = await drawer('100.00');
    const out = await fin.cashCounts.post(ctx, {
      bankAccountId: d.account.id,
      countDate: today,
      denominations: [{ value: '50', count: '3' }],
      varianceGlAccountId: glIncome,
      note: 'a customer left change',
    });
    expect(out.difference).toBe('50.00');
    expect(await balance(d.account.id)).toBe(15_000);
  });

  it('counts as of the day given: later movements do not belong to it', async () => {
    const d = await drawer('300.00', day(5));
    const c2 = await db
      .insert(schema.customers)
      .values({
        companyId,
        number: `CX${run}${++seq}`,
        name: 'Later payer',
        accountType: 'cash',
        creditLimit: '0',
      })
      .returning();
    const r = await fin.receipts.create(ctx, {
      customerId: c2[0].id,
      paymentMethodId: d.method.id,
      amount: '200.00',
      paymentDate: day(1),
      postingDate: day(1),
      externalReference: `LATER${run}${seq}`,
    });
    await fin.receipts.post(ctx, r.id, { allocate: 'none' });
    const out = await fin.cashCounts.post(ctx, {
      bankAccountId: d.account.id,
      countDate: day(3),
      total: '300.00',
    });
    expect(out.difference).toBe('0.00');
    expect(await balance(d.account.id)).toBe(50_000);
  });

  it('refuses what cannot be counted, in words', async () => {
    const d = await drawer('100.00');
    const bank = await drawer('100.00', day(1), 'bank');
    expect(
      await codeOf(
        fin.cashCounts.post(ctx, {
          bankAccountId: bank.account.id,
          countDate: today,
          total: '100.00',
        }),
      ),
    ).toBe('NOT_CASH');
    expect(
      await codeOf(
        fin.cashCounts.post(ctx, {
          bankAccountId: d.account.id,
          countDate: day(-1),
          total: '100.00',
        }),
      ),
    ).toBe('DATE_IN_FUTURE');
    expect(
      await codeOf(fin.cashCounts.post(ctx, { bankAccountId: d.account.id, countDate: today })),
    ).toBe('COUNT_INVALID');
    expect(
      await codeOf(
        fin.cashCounts.post(ctx, {
          bankAccountId: d.account.id,
          countDate: today,
          denominations: [{ value: '100', count: '1.5' }],
        }),
      ),
    ).toBe('COUNT_INVALID');
    expect(
      await codeOf(
        fin.cashCounts.post(ctx, { bankAccountId: randomUUID(), countDate: today, total: '1.00' }),
      ),
    ).toBe('ACCOUNT_NOT_FOUND');
    expect(await counts(d.account.id)).toHaveLength(0);
  });

  it('cannot be changed or removed afterwards: a mistake is answered by counting again', async () => {
    const d = await drawer('100.00');
    await fin.cashCounts.post(ctx, {
      bankAccountId: d.account.id,
      countDate: today,
      total: '100.00',
    });
    const [c] = await counts(d.account.id);
    const fail = async (p: PromiseLike<unknown>) => {
      try {
        await p;
        return 'OK';
      } catch (e) {
        return ((e as { cause?: Error }).cause ?? (e as Error)).message;
      }
    };
    expect(
      await fail(
        db
          .update(schema.cashCounts)
          .set({ countedAmount: '999.00', difference: '899.00' })
          .where(eq(schema.cashCounts.id, c.id)),
      ),
    ).toContain('count again');
    expect(
      await fail(db.delete(schema.cashCounts).where(eq(schema.cashCounts.id, c.id))),
    ).toContain('count again');
  });

  it('pages through earlier counts, newest first', async () => {
    const d = await drawer('100.00');
    for (let i = 0; i < 3; i++)
      await fin.cashCounts.post(ctx, {
        bankAccountId: d.account.id,
        countDate: today,
        total: '100.00',
      });
    const first = await fin.cashCounts.list(companyId, d.account.id, undefined, 2);
    expect(first.rows).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await fin.cashCounts.list(companyId, d.account.id, first.next ?? undefined, 2);
    expect(second.rows).toHaveLength(1);
    expect(second.next).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(3);
  });

  describe('once the books are live', () => {
    it('writes a shortage as a debit to the chosen account and a credit to the cash account, and the books still agree', async () => {
      await fin.salesPosting.goLive(ctx, {
        offsetAccountId: required(
          (await fin.setup.listAccounts(companyId)).find((a) => a.no === '3100'),
        ).id,
      });
      const d = await drawer('400.00', today);
      const out = await fin.cashCounts.post(ctx, {
        bankAccountId: d.account.id,
        countDate: today,
        total: '370.00',
        varianceGlAccountId: glExpense,
        note: 'short at close',
      });
      expect(out.gl).toBe(true);
      const [e] = await db
        .select()
        .from(schema.bankLedgerEntries)
        .where(
          and(
            eq(schema.bankLedgerEntries.bankAccountId, d.account.id),
            eq(schema.bankLedgerEntries.documentType, 'cash_count'),
          ),
        );
      const gl = await db
        .select()
        .from(schema.glEntries)
        .where(eq(schema.glEntries.registerId, required(e.registerId)));
      expect(gl.find((x) => Number(x.debit) === 30)?.accountId).toBe(glExpense);
      expect(gl.find((x) => Number(x.credit) === 30)?.accountId).toBe(glCash);
      expect(
        (await fin.salesPosting.reconciliation(companyId)).rows.map((r) => r.diffCents),
      ).toEqual([0]);
    });
  });
});
