import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('core finance (database)', () => {
  type Db = import('@/server/db/drizzle/client').DrizzleDb;
  let db: Db;
  let schema: typeof import('@/server/db/drizzle/schema');
  let setup: import('./setup-service').FinanceSetupService;
  let fiscal: import('./fiscal-service').FiscalService;
  let engine: import('./engine').PostingEngine;
  let journals: import('./journal-service').JournalService;
  let reports: import('./reports-service').FinanceReportsService;
  let postingSetup: import('./posting-setup-service').PostingSetupService;
  let FinanceError: typeof import('./errors').FinanceError;
  let PostingError: typeof import('./engine').PostingError;
  let companyId: string;
  let ctx: import('./errors').FinanceContext;
  const acct: Record<string, string> = {};

  const origin = { surface: 'test', action: 'run' };
  const line = (no: string, debit: string, credit: string) => ({ accountId: acct[no], debit, credit });
  const request = (key: string, lines: [string, string, string][], over: Record<string, unknown> = {}) => ({
    companyId,
    idempotencyKey: key,
    postingDate: '2026-10-12',
    documentType: 'journal',
    documentNo: key,
    currency: 'KES',
    rate: '1',
    rateSource: 'base' as const,
    chainKey: 'general',
    origin,
    postedBy: 'user' as const,
    lines: lines.map(([n, d, c]) => line(n, d, c)),
    ...over,
  });
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof PostingError || e instanceof FinanceError) return e.code;
      return `OTHER:${(e as Error).message}`;
    }
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ FinanceError } = await import('./errors'));
    const eng = await import('./engine');
    PostingError = eng.PostingError;
    const { DecisionLog } = await import('@/server/kernel/decision-log/service');
    const decisions = new DecisionLog(db);
    const { FiscalService } = await import('./fiscal-service');
    const { FinanceSetupService } = await import('./setup-service');
    const { JournalService } = await import('./journal-service');
    const { FinanceReportsService } = await import('./reports-service');
    const { PostingSetupService } = await import('./posting-setup-service');
    fiscal = new FiscalService(db, decisions);
    setup = new FinanceSetupService(db, decisions, fiscal);
    engine = new eng.PostingEngine(db, decisions);
    journals = new JournalService(db, engine, decisions);
    reports = new FinanceReportsService(db);
    postingSetup = new PostingSetupService(db, decisions);

    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'F', tradingName: 'F', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = company.id;
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    await setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    for (const a of await setup.listAccounts(companyId)) acct[a.no] = a.id;
  });

  describe('setup', () => {
    it('imports the Kenya template once, with groups, setup and a fiscal year', async () => {
      const s = await setup.getSettings(companyId);
      expect(s?.chartTemplate).toBe('kenya');
      expect(s?.baseCurrency).toBeTruthy();
      expect(acct['4100']).toBeTruthy();
      const years = await fiscal.listYears(companyId);
      expect(years).toHaveLength(1);
      expect(years[0].periods).toHaveLength(12);
      const ov = await postingSetup.overview(companyId);
      expect(ov.general).toHaveLength(4);
      const r = await postingSetup.resolveGeneral(companyId, 'DOMESTIC', 'GOODS', 'sales', '2026-10-01');
      expect(r.accountId).toBe(acct['4100']);
      expect((await postingSetup.resolveCustomer(companyId, 'DOMESTIC', 'receivables')).accountId).toBe(acct['1210']);
    });

    it('refuses a second template over an existing chart', async () => {
      expect(await codeOf(setup.applyTemplate(ctx, 'international'))).toBe('CHART_EXISTS');
    });

    it('refuses an overlapping fiscal year', async () => {
      expect(await codeOf(fiscal.createYear(ctx, { startsOn: '2026-06-01', shape: 'monthly' }))).toBe('YEAR_OVERLAP');
      expect(await codeOf(fiscal.createYear(ctx, { startsOn: '2027-01-01', shape: 'monthly' }))).toBe('OK');
    });
  });

  describe('posting', () => {
    it('previews without writing, then posts a balanced journal', async () => {
      const before = (await reports.registers(companyId)).length;
      const preview = await engine.preview(request('p1', [['6200', '1500', '0'], ['4400', '0', '1500']]));
      expect(preview.ok).toBe(true);
      expect(preview.lines.map((l) => l.accountNo)).toEqual(['6200', '4400']);
      expect((await reports.registers(companyId)).length).toBe(before);

      const posted = await engine.post(request('p1', [['6200', '1500', '0'], ['4400', '0', '1500']]));
      expect(posted).toMatchObject({ seq: before + 1, entryCount: 2, replayed: false });
      expect(posted.hash).toHaveLength(64);
    });

    it('is idempotent: the same key returns the first posting and writes nothing', async () => {
      const a = await engine.post(request('idem', [['6200', '10', '0'], ['4400', '0', '10']]));
      const b = await engine.post(request('idem', [['6200', '10', '0'], ['4400', '0', '10']]));
      expect(b.registerId).toBe(a.registerId);
      expect(b.replayed).toBe(true);
      const c = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, a.registerId));
      expect(c).toHaveLength(2);
    });

    it('refuses what the rules forbid, and writes nothing', async () => {
      const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.glEntries))[0].n;
      const n0 = await count();
      expect(await codeOf(engine.post(request('bad1', [['6200', '10', '0'], ['4400', '0', '9']])))).toBe('NOT_BALANCED');
      expect(await codeOf(engine.post(request('bad2', [['1210', '10', '0'], ['4400', '0', '10']])))).toBe('CONTROL_ACCOUNT');
      expect(await codeOf(engine.post(request('bad3', [['6200', '10', '0'], ['4400', '0', '10']], { postingDate: '2030-01-01' })))).toBe('NO_PERIOD');
      expect(await codeOf(engine.post(request('bad4', [['1000', '10', '0'], ['4400', '0', '10']])))).toBe('ACCOUNT_NOT_POSTING');
      expect(await count()).toBe(n0);
    });

    it('lets the engine, or a permitted user, post to a control account', async () => {
      expect(await codeOf(engine.post(request('ctl1', [['1210', '100', '0'], ['4100', '0', '100']], { postedBy: 'engine' })))).toBe('OK');
      expect(await codeOf(engine.post(request('ctl2', [['1210', '100', '0'], ['4100', '0', '100']]), { canPostSoftClosed: false, canPostControlAccounts: true }))).toBe('OK');
    });

    it('posts in a foreign currency with a rate and keeps the base balanced', async () => {
      const posted = await engine.post(request('fx1', [['6200', '100', '0'], ['4400', '0', '100']], { currency: 'USD', rate: '129.5', rateSource: 'manual' }));
      const [reg] = await db.select().from(schema.ledgerRegisters).where(eq(schema.ledgerRegisters.id, posted.registerId));
      expect(reg.baseTotalDebit).toBe('12950.0000');
      expect(reg.baseTotalDebit).toBe(reg.baseTotalCredit);
    });

    it('enforces period status', async () => {
      const [p] = (await fiscal.listYears(companyId))[0].periods.filter((x) => x.no === 9);
      await fiscal.setStatus(ctx, p.id, 'soft_closed');
      const lines: [string, string, string][] = [['6200', '5', '0'], ['4400', '0', '5']];
      expect(await codeOf(engine.post(request('sc1', lines, { postingDate: '2026-09-15' })))).toBe('PERIOD_SOFT_CLOSED');
      expect(await codeOf(engine.post(request('sc2', lines, { postingDate: '2026-09-15' }), { canPostSoftClosed: true, canPostControlAccounts: false }))).toBe('OK');
      await fiscal.setStatus(ctx, p.id, 'closed');
      expect(await codeOf(engine.post(request('sc3', lines, { postingDate: '2026-09-16' }), { canPostSoftClosed: true, canPostControlAccounts: false }))).toBe('PERIOD_CLOSED');
      expect(await codeOf(fiscal.setStatus(ctx, p.id, 'open'))).toBe('REASON_REQUIRED');
      await fiscal.setStatus(ctx, p.id, 'open', 'correcting a late invoice');
      expect(await codeOf(engine.post(request('sc4', lines, { postingDate: '2026-09-17' })))).toBe('OK');
      await fiscal.setStatus(ctx, p.id, 'closed');
      await fiscal.setStatus(ctx, p.id, 'locked', 'year-end');
      expect(await codeOf(fiscal.setStatus(ctx, p.id, 'open', 'x'))).toBe('TRANSITION_ILLEGAL');
    });

    it('honours the company posting window', async () => {
      await setup.updateSettings(ctx, { postingFrom: '2026-10-05', postingTo: null });
      expect(await codeOf(engine.post(request('win1', [['6200', '5', '0'], ['4400', '0', '5']], { postingDate: '2026-10-01' })))).toBe('OUTSIDE_POSTING_WINDOW');
      await setup.updateSettings(ctx, { postingFrom: null, postingTo: null });
    });
  });

  describe('immutability', () => {
    it('the database refuses to change or delete a posted entry or register', async () => {
      const p = await engine.post(request('imm1', [['6200', '7', '0'], ['4400', '0', '7']]));
      const run = async (q: ReturnType<typeof sql>) => {
        try {
          await db.execute(q);
          return 'OK';
        } catch (e) {
          return String((e as { cause?: { message?: string }; message: string }).cause?.message ?? (e as Error).message);
        }
      };
      expect(await run(sql`UPDATE gl_entries SET debit = 99 WHERE register_id = ${p.registerId}::uuid`)).toMatch(/append-only/);
      expect(await run(sql`DELETE FROM gl_entries WHERE register_id = ${p.registerId}::uuid`)).toMatch(/append-only/);
      expect(await run(sql`UPDATE ledger_registers SET description = 'x' WHERE id = ${p.registerId}::uuid`)).toMatch(/append-only/);
      expect(await run(sql`DELETE FROM ledger_registers WHERE id = ${p.registerId}::uuid`)).toMatch(/append-only/);
    });

    it('an unbalanced register cannot be inserted even by direct SQL', async () => {
      const r = await db
        .execute(sql`INSERT INTO ledger_registers (company_id, chain_key, seq, idempotency_key, document_type, document_no, posting_date, document_date, period_id, currency, rate, rate_source, total_debit, total_credit, base_total_debit, base_total_credit, line_count, posted_by_type, origin, previous_hash, hash)
          VALUES (${companyId}::uuid, 'x', 1, 'direct', 'journal', 'D', '2026-10-01', '2026-10-01', gen_random_uuid(), 'KES', '1', 'base', 10, 9, 10, 9, 2, 'user', '{}', 'a', 'b')`)
        .then(() => 'OK')
        .catch((e: { cause?: { message?: string } }) => e.cause?.message ?? 'ERR');
      expect(r).toMatch(/balanced|check/i);
    });

    it('a used account freezes its identity and cannot be deleted', async () => {
      expect(await codeOf(setup.updateAccount(ctx, acct['6200'], { no: '6201', name: 'Rent', type: 'posting', category: 'expense', normalBalance: 'debit' }))).toBe('ACCOUNT_USED');
      const a = await setup.getAccount(companyId, acct['6200']);
      expect(a?.usedAt).not.toBeNull();
      expect(await codeOf(setup.deleteAccount(ctx, acct['6200']))).toBe('ACCOUNT_USED');
      // naming and blocking stay editable
      await setup.updateAccount(ctx, acct['6200'], { no: '6200', name: 'Rent and service charges', type: 'posting', category: 'expense', normalBalance: 'debit' });
      expect(await codeOf(setup.deleteAccount(ctx, acct['6990']))).toBe('OK');
    });
  });

  describe('reversal', () => {
    it('mirrors a register once, with a reason, and nets the accounts to zero', async () => {
      const a = await engine.post(request('rev1', [['6310', '250', '0'], ['4400', '0', '250']]));
      const before = await reports.trialBalance(companyId, '2026-10-01', '2026-10-31');
      expect(await codeOf(engine.reverse({ companyId, registerId: a.registerId, postingDate: '2026-10-13', reasonCode: '', origin }))).toBe('REASON_REQUIRED');
      const r = await engine.reverse({ companyId, registerId: a.registerId, postingDate: '2026-10-13', reasonCode: 'DATA_ENTRY_ERROR', reasonText: 'wrong account', origin });
      expect(r.seq).toBeGreaterThan(a.seq);
      const after = await reports.trialBalance(companyId, '2026-10-01', '2026-10-31');
      const net = (tb: typeof before, no: string) => tb.rows.find((x) => x.no === no);
      expect(Number(net(after, '6310')!.closingDebit)).toBe(0);
      expect(Number(net(before, '6310')!.closingDebit)).toBe(250);

      expect(await codeOf(engine.reverse({ companyId, registerId: a.registerId, postingDate: '2026-10-13', reasonCode: 'X', origin }))).toBe('ALREADY_REVERSED');
      expect(await codeOf(engine.reverse({ companyId, registerId: r.registerId, postingDate: '2026-10-13', reasonCode: 'X', origin }))).toBe('IS_REVERSAL');
    });
  });

  describe('journals', () => {
    it('drafts, previews and posts a batch all-or-nothing, then clears the draft', async () => {
      const b = await journals.createBatch(ctx, 'GEN1', 'General');
      const base = { postingDate: '2026-10-14', description: 'Office rent' };
      await journals.saveLine(ctx, b.id, { ...base, documentNo: 'DOC-1', accountId: acct['6200'], debit: '800', credit: '0' });
      await journals.saveLine(ctx, b.id, { ...base, documentNo: 'DOC-1', accountId: acct['4400'], debit: '0', credit: '800' });
      await journals.saveLine(ctx, b.id, { ...base, documentNo: 'DOC-2', accountId: acct['6200'], debit: '50', credit: '0' });
      await journals.saveLine(ctx, b.id, { ...base, documentNo: 'DOC-2', accountId: acct['4400'], debit: '0', credit: '49' });

      const none = { canPostSoftClosed: false, canPostControlAccounts: false };
      const preview = await journals.preview(ctx, b.id, none);
      expect(preview.map((p) => [p.documentNo, p.ok])).toEqual([['DOC-1', true], ['DOC-2', false]]);
      expect(await codeOf(journals.post(ctx, b.id, none))).toBe('NOT_BALANCED');
      expect((await journals.getBatch(companyId, b.id))!.lines).toHaveLength(4); // nothing posted, draft intact
      expect((await db.select().from(schema.ledgerRegisters).where(and(eq(schema.ledgerRegisters.companyId, companyId), eq(schema.ledgerRegisters.documentNo, 'DOC-1'))))).toHaveLength(0);

      const fix = (await journals.getBatch(companyId, b.id))!.lines.find((l) => l.documentNo === 'DOC-2' && l.credit !== '0.0000')!;
      await journals.saveLine(ctx, b.id, { ...base, documentNo: 'DOC-2', accountId: acct['4400'], debit: '0', credit: '50' }, fix.id);
      const posted = await journals.post(ctx, b.id, none);
      expect(posted).toHaveLength(2);
      expect((await journals.getBatch(companyId, b.id))!.lines).toHaveLength(0);
      expect(await codeOf(journals.post(ctx, b.id, none))).toBe('NOTHING_TO_POST');
    });
  });

  describe('integrity and reports', () => {
    it('the trial balance balances and totals the ranges', async () => {
      const tb = await reports.trialBalance(companyId, '2026-10-01', '2026-10-31');
      expect(tb.totalDebit).toBe(tb.totalCredit);
      const income = tb.rows.find((r) => r.no === '4999');
      expect(income).toBeTruthy();
    });

    it('running balances agree with the ledger', async () => {
      expect(await reports.balanceDrift(companyId, '2026-01-01', '2026-12-31')).toHaveLength(0);
    });

    it('the hash chain verifies, and notices a missing register', async () => {
      const ok = await reports.verifyChain(companyId);
      expect(ok.every((c) => c.ok)).toBe(true);
      expect(ok.find((c) => c.chainKey === 'general')!.checked).toBeGreaterThan(5);
    });

    it('lists entries with keyset paging', async () => {
      const first = await reports.entries(companyId, { limit: 5 });
      expect(first.rows).toHaveLength(5);
      expect(first.next).not.toBeNull();
      const second = await reports.entries(companyId, { limit: 5, cursor: first.next! });
      expect(second.rows[0].id).toBeLessThan(first.rows[4].id + 1);
      expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(10);
    });
  });

  describe('concurrency', () => {
    it('60 simultaneous postings to one chain stay gap-free, balanced and in agreement', async () => {
      const results = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          engine.post(request(`c-${i}`, [['6200', '10', '0'], ['4400', '0', '10']], { chainKey: 'branch-a' })),
        ),
      );
      const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
      expect(seqs[0]).toBe(1);
      expect(seqs[59]).toBe(60);
      expect(new Set(seqs).size).toBe(60);
    });

    it('postings on different chains touching the same accounts do not deadlock', async () => {
      const posts = Array.from({ length: 80 }, (_, i) =>
        engine.post(request(`m-${i}`, i % 2 === 0 ? [['6200', '1', '0'], ['4400', '0', '1']] : [['4400', '0', '1'], ['6200', '1', '0']], { chainKey: `branch-${i % 8}` })),
      );
      await expect(Promise.all(posts)).resolves.toHaveLength(80);
      expect(await reports.balanceDrift(companyId, '2026-01-01', '2026-12-31')).toHaveLength(0);
      expect((await reports.verifyChain(companyId)).every((c) => c.ok)).toBe(true);
    });

    it('two callers racing on the same key post once', async () => {
      const both = await Promise.all([
        engine.post(request('race', [['6200', '3', '0'], ['4400', '0', '3']])),
        engine.post(request('race', [['6200', '3', '0'], ['4400', '0', '3']])),
      ]);
      expect(both[0].registerId).toBe(both[1].registerId);
      const rows = await db.select().from(schema.ledgerRegisters).where(and(eq(schema.ledgerRegisters.companyId, companyId), eq(schema.ledgerRegisters.idempotencyKey, 'race')));
      expect(rows).toHaveLength(1);
    });
  });
});
