import { createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { FinanceServices } from './index';
import type { FinanceContext } from './errors';

/**
 * Reading a bank's statement through its API, against a stand-in for Jenga (and KCB Buni): what is asked, how it is signed, how pages are
 * followed, and what is kept.   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;

interface Reply {
  status?: number;
  json?: unknown;
}
type Handler = (body: Record<string, unknown>, headers: Record<string, string>) => Reply;

class FakeBank {
  calls: {
    method: string;
    path: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }[] = [];
  handlers = new Map<string, Handler>();
  down = false;
  on(path: string, h: Handler) {
    this.handlers.set(path, h);
  }
  count(path: string) {
    return this.calls.filter((c) => c.path === path).length;
  }
  fetch: typeof fetch = (input, init) => {
    const u = new URL(readText(input));
    const body = (() => {
      try {
        return init?.body === undefined || init.body === null
          ? {}
          : (JSON.parse(readText(init.body)) as Record<string, unknown>);
      } catch {
        return {};
      }
    })();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    this.calls.push({ method: init?.method ?? 'GET', path: u.pathname, body, headers });
    if (this.down)
      return Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') }),
      );
    const h = this.handlers.get(u.pathname);
    const r: Reply = h
      ? h(body, headers)
      : { status: 404, json: { message: `No handler for ${u.pathname}` } };
    return Promise.resolve(
      new Response(JSON.stringify(r.json ?? {}), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

const STATEMENT = '/v3-apis/account-api/v3.0/accounts/fullStatement';
const tx = (
  n: number,
  o: { type?: 'Credit' | 'Debit'; amount?: number; day?: string; description?: string } = {},
) => ({
  reference: `REF${String(n)}`,
  date: `${o.day ?? '2026-10-10'}T10:00:0${String(n % 10)}.000`,
  amount: o.amount ?? 100 + n,
  serial: String(n),
  description: o.description ?? `Transaction ${String(n)}`,
  postedDateTime: `${o.day ?? '2026-10-10'}T10:00:0${String(n % 10)}.000`,
  type: o.type ?? 'Credit',
  runningBalance: { amount: 10_000 + n, currency: 'KES' },
});

describe.skipIf(!has(url))('statement pull (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let fin: FinanceServices;
  let fake: FakeBank;
  let companyId: string;
  let ctx: FinanceContext;
  let publicKey: string;
  let privateKey: string;
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
  const messageOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };

  /** A bank connection of the given kind, switched on, and a bank account connected to it. */
  async function connected(
    opts: {
      code?: 'jenga_hq' | 'kcb_buni';
      settings?: Record<string, unknown>;
      accountNumber?: string | null;
      credentials?: Record<string, string>;
      enabled?: boolean;
    } = {},
  ) {
    seq += 1;
    const code = opts.code ?? 'jenga_hq';
    const { id } = await fin.paymentProviders.create(ctx, {
      providerCode: code,
      displayName: `${code} pull ${run} ${seq}`,
    });
    await fin.paymentProviders.setCredentials(
      ctx,
      id,
      opts.credentials ??
        (code === 'jenga_hq'
          ? { merchantCode: 'm', consumerSecret: 's', apiKey: 'k', privateKeyPem: privateKey }
          : { consumerKey: 'ck', consumerSecret: 'cs' }),
    );
    await db
      .update(schema.paymentProviderConfigs)
      .set({
        isEnabled: opts.enabled ?? true,
        settings: opts.settings ?? {},
        apiBaseUrl:
          code === 'jenga_hq' ? 'https://uat.finserve.africa' : 'https://uat.buni.kcbgroup.com',
      })
      .where(eq(schema.paymentProviderConfigs.id, id));
    const account = await fin.bankAccounts.create(ctx, {
      code: `PL${run}${seq}`,
      name: `Pull test ${seq}`,
      kind: 'bank',
      currency: 'KES',
      providerConfigId: id,
      details:
        opts.accountNumber === null ? {} : { accountNumber: opts.accountNumber ?? '0011547896523' },
    });
    return { providerId: id, account };
  }
  const lines = (accountId: string) =>
    db
      .select()
      .from(schema.bankStatementLines)
      .where(eq(schema.bankStatementLines.bankAccountId, accountId))
      .orderBy(schema.bankStatementLines.id);
  const jengaOk = (pages: unknown[][]) => {
    let n = 0;
    fake.on('/authentication/api/v3/authenticate/merchant', () => ({
      json: { accessToken: 'tok', tokenType: 'Bearer' },
    }));
    fake.on(STATEMENT, () => ({
      json: {
        status: true,
        code: 0,
        message: 'Success',
        data: {
          balance: 1,
          currency: 'KES',
          accountNumber: 'x',
          transactions: pages[Math.min(n++, pages.length - 1)],
        },
      },
    }));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const { createPaymentEngine } = await import('@/server/domains/payments/engine');
    const { PaymentRegistry } = await import('@/server/domains/payments/registry');
    const { FinanceC2bConsumer } =
      await import('@/server/domains/finance/receivables/c2b-consumer');
    const c = getContainer();
    fin = c.finance;
    fake = new FakeBank();
    vi.stubGlobal('fetch', fake.fetch);
    const engine = createPaymentEngine({
      db,
      registry: new PaymentRegistry(),
      payments: c.payments,
      consumer: new FinanceC2bConsumer(db, fin.receipts),
      fetchImpl: fake.fetch,
      jobs: {
        verifyAttempt: () => Promise.resolve(),
        verifyTransaction: () => Promise.resolve(),
        processEvent: () => Promise.resolve(),
        sendOperation: () => Promise.resolve(),
      },
    });
    fin.statementPulls.source = engine;
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const [company] = await db
      .insert(schema.companySettings)
      .values({
        legalName: 'SP',
        tradingName: 'SP',
        email: 'a@b.c',
        phone: '1',
        streetAddress: 's',
        city: 'c',
        countyOrState: 'x',
        postalCode: '1',
        kraPin: 'P',
        publicBaseUrl: 'https://shop.example',
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
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe('Jenga', () => {
    it('signs the request over account, country and last day, follows the pages, and keeps every line once', async () => {
      const f = await connected({ settings: { statementPageSize: 2 } });
      // Newest first, as the bank answers: a full page, then a short one.
      jengaOk([
        [tx(3, { day: day(1), amount: 50, type: 'Debit' }), tx(2, { day: day(1) })],
        [tx(1, { day: day(2) })],
      ]);
      const before = fake.calls.length;
      const out = await fin.statementPulls.pull(ctx, f.account.id, {
        fromDate: day(3),
        toDate: day(1),
      });
      expect(out).toMatchObject({
        lines: 3,
        duplicates: 0,
        truncated: false,
        pages: 2,
        empty: false,
      });
      const mine = fake.calls.slice(before);
      expect(mine.filter((c) => c.path === STATEMENT)).toHaveLength(2);
      expect(
        fake.calls
          .slice(before)
          .filter((c) => c.path === '/authentication/api/v3/authenticate/merchant'),
      ).toHaveLength(1);
      const first = required(mine.find((c) => c.path === STATEMENT));
      expect(first.body).toMatchObject({
        countryCode: 'KE',
        accountNumber: '0011547896523',
        fromDate: day(3),
        toDate: day(1),
        limit: 2,
      });
      expect(first.headers.Authorization).toBe('Bearer tok');
      // The signature checks out with the public key, over exactly account + country + last day.
      const verify = createVerify('RSA-SHA256');
      verify.update(`0011547896523KE${day(1)}`);
      expect(verify.verify(publicKey, first.headers.signature, 'base64')).toBe(true);
      // The second page starts after the last transaction of the first.
      const second = required(mine.filter((c) => c.path === STATEMENT)[1]);
      expect(second.body).toMatchObject({ reference: 'REF2', serial: '2' });
      // Kept in the order things happened, money out as negative.
      const kept = await lines(f.account.id);
      expect(kept.map((l) => [l.lineDate, l.description, Number(l.amount)])).toEqual([
        [day(2), 'Transaction 1', 101],
        [day(1), 'Transaction 2', 102],
        [day(1), 'Transaction 3', -50],
      ]);
      const [imp] = await db
        .select()
        .from(schema.bankStatementImports)
        .where(eq(schema.bankStatementImports.bankAccountId, f.account.id));
      expect(imp).toMatchObject({ format: 'pull', lineCount: 3 });
    });

    it('pulling the same days again, or days that overlap, keeps each line once', async () => {
      const f = await connected();
      jengaOk([[tx(2, { day: day(1) }), tx(1, { day: day(2) })]]);
      await fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(3), toDate: day(1) });
      const again = await fin.statementPulls.pull(ctx, f.account.id, {
        fromDate: day(3),
        toDate: day(1),
      });
      expect(again).toMatchObject({ lines: 0, duplicates: 2 });
      jengaOk([[tx(3, { day: day(0) }), tx(2, { day: day(1) })]]);
      const overlap = await fin.statementPulls.pull(ctx, f.account.id, {
        fromDate: day(1),
        toDate: day(0),
      });
      expect(overlap).toMatchObject({ lines: 1, duplicates: 1 });
      expect(await lines(f.account.id)).toHaveLength(3);
    });

    it('says so when the bank has nothing for the days', async () => {
      const f = await connected();
      jengaOk([[]]);
      expect(
        await fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(3), toDate: day(1) }),
      ).toMatchObject({ lines: 0, empty: true });
    });

    it('matches a line that quotes one of our references, like any imported statement', async () => {
      const f = await connected();
      const method = await fin.paymentMethods.create(ctx, {
        code: `PLM${run}${++seq}`,
        name: `Pull transfer ${seq}`,
        kind: 'bank_transfer',
        balancingBankAccountId: f.account.id,
        providerId: required(
          (await fin.paymentMethods.providerChoices(companyId)).find((p) => p.isSystem),
        ).id,
        glAccountId: required(
          (await fin.setup.listAccounts(companyId)).find((a) => a.no === '1120'),
        ).id,
        usableFor: ['customer_receipt'],
        refundDestination: 'none',
      });
      const [cust] = await db
        .insert(schema.customers)
        .values({
          companyId,
          number: `PLC${run}${seq}`,
          name: `Pull payer ${seq}`,
          accountType: 'cash',
          creditLimit: '0',
        })
        .returning();
      const r = await fin.receipts.create(ctx, {
        customerId: cust.id,
        paymentMethodId: method.id,
        amount: '640.00',
        paymentDate: day(1),
        postingDate: day(1),
        externalReference: `PULLREF${run}${seq}`,
      });
      await fin.receipts.post(ctx, r.id, { allocate: 'none' });
      jengaOk([[tx(1, { day: day(1), amount: 640, description: `Payment PULLREF${run}${seq}` })]]);
      const out = await fin.statementPulls.pull(ctx, f.account.id, {
        fromDate: day(2),
        toDate: day(1),
      });
      expect(out).toMatchObject({ lines: 1, autoMatched: 1 });
      expect((await lines(f.account.id))[0]).toMatchObject({ status: 'matched' });
    });

    it('keeps nothing and says why when the bank refuses, is down, or sends something unreadable', async () => {
      const f = await connected();
      fake.on('/authentication/api/v3/authenticate/merchant', () => ({
        json: { accessToken: 'tok' },
      }));
      fake.on(STATEMENT, () => ({ status: 401, json: { message: 'Invalid signature' } }));
      expect(
        await codeOf(
          fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toBe('PULL_FAILED');
      fake.on(STATEMENT, () => ({ status: 503, json: {} }));
      expect(
        await codeOf(
          fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toBe('PULL_FAILED_RETRY');
      fake.on(STATEMENT, () => ({ json: { status: false, message: 'Account not found' } }));
      expect(
        await messageOf(
          fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toBe('Account not found');
      fake.on(STATEMENT, () => ({
        json: {
          status: true,
          data: { transactions: [{ postedDateTime: 'garbage', amount: 1, type: 'Credit' }] },
        },
      }));
      expect(
        await messageOf(
          fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toContain('date could not be read');
      fake.down = true;
      expect(
        await codeOf(
          fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toBe('PULL_FAILED_RETRY');
      fake.down = false;
      expect(await lines(f.account.id)).toHaveLength(0);
    });

    it('stops with a reason when the bank keeps sending the same page', async () => {
      const f = await connected({ settings: { statementPageSize: 1 } });
      jengaOk([[tx(1, { day: day(1) })]]);
      expect(
        await messageOf(
          fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toContain('same page again');
      expect(await lines(f.account.id)).toHaveLength(0);
    });

    it('needs the private key, because every statement request is signed', async () => {
      const f = await connected({
        credentials: { merchantCode: 'm', consumerSecret: 's', apiKey: 'k' },
      });
      expect(
        await messageOf(
          fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toContain('private key');
    });
  });

  describe('KCB Buni', () => {
    it('says what is missing until the statement call is described in the settings', async () => {
      const f = await connected({ code: 'kcb_buni' });
      expect(
        await messageOf(
          fin.statementPulls.pull(ctx, f.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toContain('statement call is not set up yet');
    });

    it('reads the call that is described: the path with the account and days, the body, and where the lines are in the answer', async () => {
      const f = await connected({
        code: 'kcb_buni',
        settings: {
          statementPath: '/accounts/{account}/transactions',
          statementMethod: 'POST',
          statementBody: { from: '{from}', to: '{to}', country: '{country}', keep: 7 },
          statementMap: {
            list: 'result.items',
            date: 'bookedOn',
            description: 'narrative',
            reference: 'ref',
            amountAbs: 'value',
            direction: 'dc',
            creditWords: ['CR'],
          },
        },
      });
      fake.on('/token', () => ({ json: { access_token: 'kcb-token' } }));
      fake.on('/accounts/0011547896523/transactions', () => ({
        json: {
          result: {
            items: [
              { bookedOn: day(2), narrative: 'Salary', ref: 'K1', value: '900.00', dc: 'CR' },
              { bookedOn: day(1), narrative: 'Rent', ref: 'K2', value: 400, dc: 'DR' },
            ],
          },
        },
      }));
      const out = await fin.statementPulls.pull(ctx, f.account.id, {
        fromDate: day(3),
        toDate: day(1),
      });
      expect(out).toMatchObject({ lines: 2 });
      const call = required(
        fake.calls.find((c) => c.path === '/accounts/0011547896523/transactions'),
      );
      expect(call.body).toEqual({ from: day(3), to: day(1), country: 'KE', keep: 7 });
      expect(call.headers.Authorization).toBe('Bearer kcb-token');
      expect((await lines(f.account.id)).map((l) => [l.description, Number(l.amount)])).toEqual([
        ['Salary', 900],
        ['Rent', -400],
      ]);
    });
  });

  describe('before anything is asked', () => {
    it('refuses an account with no bank connection, or no account number, or a blocked one, and a provider that is switched off', async () => {
      const none = await fin.bankAccounts.create(ctx, {
        code: `PN${run}${++seq}`,
        name: 'Not connected',
        kind: 'bank',
        currency: 'KES',
        details: { accountNumber: '1' },
      });
      expect(
        await codeOf(fin.statementPulls.pull(ctx, none.id, { fromDate: day(2), toDate: day(1) })),
      ).toBe('NO_SOURCE');
      const noNumber = await connected({ accountNumber: null });
      expect(
        await codeOf(
          fin.statementPulls.pull(ctx, noNumber.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toBe('NO_ACCOUNT_NUMBER');
      const off = await connected({ enabled: false });
      jengaOk([[tx(1)]]);
      expect(
        await messageOf(
          fin.statementPulls.pull(ctx, off.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toContain('switched off');
      const blocked = await connected();
      await fin.bankAccounts.setBlocked(ctx, blocked.account.id, true);
      expect(
        await codeOf(
          fin.statementPulls.pull(ctx, blocked.account.id, { fromDate: day(2), toDate: day(1) }),
        ),
      ).toBe('BANK_BLOCKED');
    });

    it('refuses days that make no sense, before calling the bank', async () => {
      const f = await connected();
      const calls = fake.calls.length;
      for (const range of [
        { fromDate: day(1), toDate: day(2) },
        { fromDate: 'x', toDate: day(1) },
        { fromDate: day(0), toDate: day(-3) },
        { fromDate: day(200), toDate: day(1) },
      ]) {
        expect(await codeOf(fin.statementPulls.pull(ctx, f.account.id, range))).toBe(
          'RANGE_INVALID',
        );
      }
      expect(fake.calls).toHaveLength(calls);
    });

    it("does not take another company's connection or account", async () => {
      const f = await connected();
      const [other] = await db
        .insert(schema.companySettings)
        .values({
          legalName: 'Other',
          tradingName: 'Other',
          email: 'a@b.c',
          phone: '1',
          streetAddress: 's',
          city: 'c',
          countyOrState: 'x',
          postalCode: '1',
          kraPin: 'P2',
        })
        .returning();
      expect(
        await codeOf(
          fin.bankAccounts.create(
            { ...ctx, companyId: other.id },
            {
              code: `PX${run}${++seq}`,
              name: 'Steal',
              kind: 'bank',
              currency: 'KES',
              providerConfigId: f.providerId,
            },
          ),
        ),
      ).toBe('PROVIDER_NOT_FOUND');
      expect(
        await codeOf(
          fin.statementPulls.pull({ ...ctx, companyId: other.id }, f.account.id, {
            fromDate: day(2),
            toDate: day(1),
          }),
        ),
      ).toBe('ACCOUNT_NOT_FOUND');
    });
  });
});
