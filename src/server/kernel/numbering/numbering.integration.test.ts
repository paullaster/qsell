import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { has, nth, required } from '@/lib/values';
import type { NumberSeriesService } from './service';
import type { DecisionLog } from '../decision-log/service';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as mod_service from './service';

/**
 * Integration tests against a real Postgres built from the migrations (the append-only
 * triggers live there). Run with:  TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('number series (database)', () => {
  type Svc = NumberSeriesService;
  let svc: Svc;
  let decisions: DecisionLog;
  let db: DrizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let companyId: string;
  let nbo: { id: string };
  let msa: { id: string };
  let clearBlocks: () => void;
  let NumberSeriesError: typeof mod_service.NumberSeriesError;
  const actor = { type: 'user' as const, id: 'tester' };
  const reason = { code: 'DATA_ENTRY_ERROR' };

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return e instanceof NumberSeriesError ? e.code : `OTHER:${(e as Error).message}`;
    }
  };

  /** A series with one open line starting 2026-01-01, prefix "<CODE>-", 4 digits. */
  async function series(
    code: string,
    over: Record<string, unknown> = {},
    line: Record<string, unknown> = {},
  ) {
    const s = await svc.createSeries(
      companyId,
      { code, description: code, mode: 'gap_free', ...over } as never,
      actor,
    );
    await svc.addLine(
      companyId,
      s.id,
      { startsOn: '2026-01-01', prefix: `${code}-`, digits: 4, ...line },
      actor,
    );
    return s;
  }
  const inTx = <T>(fn: (tx: never) => Promise<T>) => db.transaction((tx) => fn(tx as never));
  const req = (over: Record<string, unknown> = {}) => ({
    companyId,
    date: '2026-03-01',
    actor,
    ...over,
  });
  const next = (code: string, over: Record<string, unknown> = {}) =>
    inTx((tx) => svc.assignFromSeries(code, req(over), tx)).then((r) => r.number);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const service = await import('./service');
    NumberSeriesError = service.NumberSeriesError;
    clearBlocks = service.clearNumberBlockCache;
    const { DecisionLog } = await import('../decision-log/service');
    const { ReasonCodes } = await import('../reason-codes/service');
    const reasons = new ReasonCodes(db);
    decisions = new DecisionLog(db);
    svc = new service.NumberSeriesService(db, decisions, reasons);

    const [company] = await db
      .insert(schema.companySettings)
      .values({
        legalName: 'T',
        tradingName: 'T',
        email: 'a@b.c',
        phone: '1',
        streetAddress: 's',
        city: 'c',
        countyOrState: 'x',
        postalCode: '1',
        kraPin: 'P',
      })
      .returning();
    companyId = required(company).id;
    await reasons.ensureSystemReasons(companyId);
    [nbo] = await db
      .insert(schema.branches)
      .values({ companyId, code: 'NBO', name: 'Nairobi' })
      .returning();
    [msa] = await db
      .insert(schema.branches)
      .values({ companyId, code: 'MSA', name: 'Mombasa' })
      .returning();
  });

  describe('gap-free', () => {
    it('numbers in order and gives the number back when the transaction rolls back', async () => {
      const s = await series('GF1');
      expect(await next('GF1')).toBe('GF1-0001');

      await expect(
        db.transaction(async (tx) => {
          const n = await svc.assignFromSeries('GF1', req(), tx);
          expect(n.number).toBe('GF1-0002');
          throw new Error('document save failed');
        }),
      ).rejects.toThrow('document save failed');

      expect(await next('GF1')).toBe('GF1-0002'); // not 0003: the failed save left no gap
      const issued = await svc.recentAllocations(companyId, s.id);
      expect(issued.map((i) => i.number).sort()).toEqual(['GF1-0001', 'GF1-0002']);
    });

    it('is contiguous and duplicate-free under 40 concurrent transactions', async () => {
      await series('GF2');
      const numbers = (await Promise.all(Array.from({ length: 40 }, () => next('GF2')))).sort();
      expect(new Set(numbers).size).toBe(40);
      expect(numbers[0]).toBe('GF2-0001');
      expect(numbers[39]).toBe('GF2-0040');
    });

    it('refuses to run outside a transaction, because a failure would leave a gap', async () => {
      await series('GF3');
      expect(await codeOf(svc.assignFromSeries('GF3', req()))).toBe('TRANSACTION_REQUIRED');
    });

    it('returns the same number when asked again for the same document, with no gap', async () => {
      const s = await series('GF4');
      const doc = { kind: 'sales_order', id: 'order-1' };
      const a = await inTx((tx) => svc.assignFromSeries('GF4', req({ document: doc }), tx));
      const b = await inTx((tx) => svc.assignFromSeries('GF4', req({ document: doc }), tx));
      expect(b.number).toBe(a.number);
      expect(b.reused).toBe(true);
      expect(await next('GF4', { document: { kind: 'sales_order', id: 'order-2' } })).toBe(
        'GF4-0002',
      );
      expect((await svc.recentAllocations(companyId, s.id)).length).toBe(2);
    });

    it('numbers a document once even when two requests for it race, without burning a number', async () => {
      await series('GF5');
      const doc = { kind: 'sales_order', id: 'racing' };
      const [x, y] = await Promise.all([
        inTx((tx) => svc.assignFromSeries('GF5', req({ document: doc }), tx)),
        inTx((tx) => svc.assignFromSeries('GF5', req({ document: doc }), tx)),
      ]);
      expect(x.number).toBe(y.number);
      expect(await next('GF5', { document: { kind: 'sales_order', id: 'later' } })).toBe(
        'GF5-0002',
      );
    });

    it('enforces date order when asked to', async () => {
      await series('GF6', { dateOrder: true });
      await next('GF6', { date: '2026-03-10' });
      expect(await codeOf(next('GF6', { date: '2026-03-09' }))).toBe('DATE_ORDER');
      expect(await next('GF6', { date: '2026-03-10' })).toBe('GF6-0002'); // same day is fine
    });
  });

  describe('allow gaps', () => {
    it('gives unique numbers to many concurrent callers using few trips to the database', async () => {
      clearBlocks();
      const s = await series('AG1', { mode: 'allow_gaps', blockSize: 25 });
      const results = await Promise.all(
        Array.from({ length: 120 }, () => svc.assignFromSeries('AG1', req())),
      );
      expect(new Set(results.map((r) => r.number)).size).toBe(120);
      const detail = await svc.seriesDetail(companyId, s.id);
      expect(nth(detail.counters, 0).lastNo).toBeLessThanOrEqual(125); // at most 5 blocks reserved for 120 numbers
    });

    it('leaves a gap after a restart but never repeats a number', async () => {
      clearBlocks();
      await series('AG2', { mode: 'allow_gaps', blockSize: 10 });
      expect((await svc.assignFromSeries('AG2', req())).number).toBe('AG2-0001');
      clearBlocks(); // an app restart loses the rest of the block
      expect((await svc.assignFromSeries('AG2', req())).number).toBe('AG2-0011');
    });
  });

  describe('periods, branches and ranges', () => {
    it('restarts the counter each year, and keeps a back-dated document in its own year', async () => {
      await series('YR', {}, { prefix: 'YR-{YY}-', reset: 'yearly' });
      expect(await next('YR', { date: '2026-12-30' })).toBe('YR-26-0001');
      expect(await next('YR', { date: '2027-01-02' })).toBe('YR-27-0001');
      expect(await next('YR', { date: '2026-12-31' })).toBe('YR-26-0002'); // back-dated, still 2026
    });

    it('uses a branch-specific line for that branch and the general line for the rest', async () => {
      const s = await series('BR', {}, { prefix: 'ALL-' });
      await svc.addLine(
        companyId,
        s.id,
        { startsOn: '2026-01-01', prefix: 'NBO-', digits: 4, branchId: nbo.id },
        actor,
      );
      expect(await next('BR', { branchId: nbo.id })).toBe('NBO-0001');
      expect(await next('BR', { branchId: msa.id })).toBe('ALL-0001');
      expect(await next('BR')).toBe('ALL-0002');
    });

    it('needs a branch when the prefix has a {BRANCH} token', async () => {
      await series('TK', {}, { prefix: 'TK-{BRANCH}-' });
      expect(await next('TK', { branchId: msa.id })).toBe('TK-MSA-0001');
      expect(await codeOf(next('TK'))).toBe('BRANCH_REQUIRED');
    });

    it('falls through to the next usable line when the first is used up', async () => {
      const s = await series('FT', {}, { prefix: 'ALL-' });
      await svc.addLine(
        companyId,
        s.id,
        { startsOn: '2026-01-01', prefix: 'NBO-', digits: 4, endNo: 2, branchId: nbo.id },
        actor,
      );
      expect(await next('FT', { branchId: nbo.id })).toBe('NBO-0001');
      expect(await next('FT', { branchId: nbo.id })).toBe('NBO-0002');
      expect(await next('FT', { branchId: nbo.id })).toBe('ALL-0001'); // branch range used up
    });

    it('stops with a clear error when everything is used up, and never duplicates', async () => {
      await series('EX', {}, { endNo: 1 });
      await next('EX');
      const err = await next('EX').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NumberSeriesError);
      expect(err).toMatchObject({ code: 'SERIES_EXHAUSTED' });
      expect((err as { detail?: { trace: unknown[] } }).detail?.trace.length).toBeGreaterThan(0);
    });

    it('explains why no line could be used', async () => {
      await series('NL');
      const err = await next('NL', { date: '2025-06-01' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'NO_OPEN_LINE', message: expect.stringContaining('starts on 2026-01-01') as unknown });
    });

    it('warns once when the warning number is reached, and records it', async () => {
      const s = await series('WN', {}, { endNo: 10, warnAt: 2 });
      const a = await inTx((tx) => svc.assignFromSeries('WN', req(), tx));
      expect(a.warning).toBeNull();
      const b = await inTx((tx) => svc.assignFromSeries('WN', req(), tx));
      expect(b.warning).toContain('near its end');
      await next('WN');
      const log = (await decisions.timeline('number_series', s.id)).filter(
        (e) => e.action === 'numbering.near_end',
      );
      expect(log).toHaveLength(1);
    });
  });

  describe('typed-in numbers', () => {
    it('rejects them unless the series allows it, and rejects duplicates', async () => {
      await series('MN');
      expect(await codeOf(next('MN', { manualNo: 'X-1' }))).toBe('MANUAL_NOT_ALLOWED');
      await series('MY', { manualAllowed: true });
      const a = await inTx((tx) => svc.assignFromSeries('MY', req({ manualNo: 'LEGACY-77' }), tx));
      expect(a.source).toBe('manual');
      expect(await codeOf(next('MY', { manualNo: 'LEGACY-77' }))).toBe('DUPLICATE_NUMBER');
      expect(await codeOf(next('MY', { manualNo: 'bad number!' }))).toBe('MANUAL_NUMBER_INVALID');
    });

    it('skips an automatic number that a typed-in number already took', async () => {
      await series('MC', { manualAllowed: true });
      await next('MC', { manualNo: 'MC-0002' });
      expect(await next('MC')).toBe('MC-0001');
      expect(await next('MC')).toBe('MC-0003'); // 0002 was taken by hand
    });
  });

  describe('administration', () => {
    it('rejects overlapping open lines for the same branch scope, and invalid configuration', async () => {
      const s = await series('AD1');
      const overlap = await codeOf(
        svc.addLine(companyId, s.id, { startsOn: '2026-06-01', prefix: 'X-' }, actor),
      );
      expect(overlap).toBe('LINE_OVERLAP');
      expect(
        await codeOf(
          svc.addLine(
            companyId,
            s.id,
            { startsOn: '2026-06-01', digits: 0, branchId: nbo.id },
            actor,
          ),
        ),
      ).toBe('INVALID_CONFIG');
      // a different branch scope does not overlap
      await svc.addLine(
        companyId,
        s.id,
        { startsOn: '2026-06-01', prefix: 'N-', branchId: nbo.id },
        actor,
      );
    });

    it('freezes what would change the meaning of numbers already issued', async () => {
      const s = await series('AD2');
      await next('AD2');
      const [line] = (await svc.seriesDetail(companyId, s.id)).lines;
      expect(
        await codeOf(svc.updateLine(companyId, required(line).line.id, { prefix: 'NEW-' }, actor, reason)),
      ).toBe('FROZEN');
      const extended = await svc.updateLine(
        companyId,
        required(line).line.id,
        { endNo: 5000 },
        actor,
        reason,
      );
      expect(extended.endNo).toBe(5000);
    });

    it('needs a valid reason to close, reopen or change things', async () => {
      const s = await series('AD3');
      const [line] = (await svc.seriesDetail(companyId, s.id)).lines;
      const lineId = required(line).line.id;
      expect(await codeOf(svc.setLineOpen(companyId, lineId, false, actor, { code: '' }))).toBe(
        'OTHER:A reason is required.',
      );
      expect(await codeOf(svc.setLineOpen(companyId, lineId, false, actor, { code: 'NOPE' }))).toBe(
        'OTHER:Reason "NOPE" does not exist.',
      );
      expect(
        await codeOf(svc.setLineOpen(companyId, lineId, false, actor, { code: 'OTHER' })),
      ).toBe('OTHER:Reason "OTHER" needs a comment explaining it.');
      await svc.setLineOpen(companyId, lineId, false, actor, { code: 'PERIOD_ROLLOVER' });
      expect(await codeOf(next('AD3'))).toBe('NO_OPEN_LINE');
      await svc.setLineOpen(companyId, lineId, true, actor, { code: 'DATA_ENTRY_ERROR' });
      expect(await next('AD3')).toBe('AD3-0001');
    });

    it('records every configuration change with who, why and the before/after', async () => {
      const s = await series('AD4');
      await svc.updateSeries(companyId, s.id, { description: 'Renamed' }, actor, {
        code: 'POLICY_CHANGE',
      });
      const log = await decisions.timeline('number_series', s.id);
      const update = required(log.find((e) => e.action === 'numbering.series_updated'));
      expect(update.actorId).toBe('tester');
      expect(update.reasonCode).toBe('POLICY_CHANGE');
      expect((update.inputs as { patch: { description: string } }).patch.description).toBe(
        'Renamed',
      );
      expect(log.some((e) => e.action === 'numbering.line_added')).toBe(true);
    });

    it('numbers by document kind through a binding, with a per-branch override', async () => {
      const general = await series('BD1');
      const nairobi = await series('BD2');
      await svc.setBinding(
        companyId,
        { documentKind: 'sales_quote', seriesId: general.id },
        actor,
        reason,
      );
      await svc.setBinding(
        companyId,
        { documentKind: 'sales_quote', branchId: nbo.id, seriesId: nairobi.id },
        actor,
        reason,
      );
      expect((await inTx((tx) => svc.assign('sales_quote', req(), tx))).number).toBe('BD1-0001');
      expect(
        (await inTx((tx) => svc.assign('sales_quote', req({ branchId: nbo.id }), tx))).number,
      ).toBe('BD2-0001');
      expect(
        (await inTx((tx) => svc.assign('sales_quote', req({ branchId: msa.id }), tx))).number,
      ).toBe('BD1-0002');
      expect(await codeOf(inTx((tx) => svc.assign('delivery_unknown', req(), tx)))).toBe(
        'UNKNOWN_DOCUMENT_KIND',
      );
      // With automatic first-use setup off, an unbound kind is an explicit error.
      const strict = new (await import('./service')).NumberSeriesService(
        db,
        decisions,
        new (await import('../reason-codes/service')).ReasonCodes(db),
        { autoSetup: false },
      );
      expect(await codeOf(inTx((tx) => strict.assign('returns_order', req(), tx)))).toBe(
        'NO_BINDING',
      );
    });

    it('only lets gap-free series number fiscal documents', async () => {
      const gaps = await series('FS1', { mode: 'allow_gaps' });
      const strict = await series('FS2');
      expect(
        await codeOf(
          svc.setBinding(
            companyId,
            { documentKind: 'tax_invoice', seriesId: gaps.id },
            actor,
            reason,
          ),
        ),
      ).toBe('FISCAL_REQUIRES_GAP_FREE');
      await svc.setBinding(
        companyId,
        { documentKind: 'tax_invoice', seriesId: strict.id },
        actor,
        reason,
      );
      expect(
        await codeOf(svc.updateSeries(companyId, strict.id, { mode: 'allow_gaps' }, actor, reason)),
      ).toBe('FISCAL_REQUIRES_GAP_FREE');
    });

    it('will not delete a series that has issued numbers or is bound', async () => {
      const s = await series('DEL');
      await next('DEL');
      expect(await codeOf(svc.deleteSeries(companyId, s.id, actor, reason))).toBe('IN_USE');
      const fresh = await series('DEL2');
      await svc.deleteSeries(companyId, fresh.id, actor, reason);
      expect((await svc.listSeries(companyId)).some((x) => x.code === 'DEL2')).toBe(false);
    });

    it('previews the next number without using it', async () => {
      await series('PV');
      const a = await svc.preview(companyId, { seriesCode: 'PV' }, { date: '2026-03-01' });
      const b = await svc.preview(companyId, { seriesCode: 'PV' }, { date: '2026-03-01' });
      expect(a.number).toBe('PV-0001');
      expect(b.number).toBe('PV-0001');
      expect(await next('PV')).toBe('PV-0001');
      expect(
        (await svc.preview(companyId, { seriesCode: 'PV' }, { date: '2026-03-01' })).number,
      ).toBe('PV-0002');
      const none = await svc.preview(companyId, { seriesCode: 'PV' }, { date: '2025-01-01' });
      expect(none.ok).toBe(false);
      expect(none.error?.code).toBe('NO_OPEN_LINE');
    });

    it('sets up every document kind in one step, gap-free for the fiscal ones', async () => {
      const [other] = await db
        .insert(schema.companySettings)
        .values({
          legalName: 'Seed Co',
          tradingName: 'Seed Co',
          email: 's@b.c',
          phone: '1',
          streetAddress: 's',
          city: 'c',
          countyOrState: 'x',
          postalCode: '1',
          kraPin: 'P',
        })
        .returning();
      const own = required(other).id;
      const { ReasonCodes } = await import('../reason-codes/service');
      await new ReasonCodes(db).ensureSystemReasons(own);

      const { created } = await svc.seedStandard(own, actor, '2026-03-01');
      expect(created).toContain('tax_invoice');
      const ownBranch = nth((
        await db
          .insert(schema.branches)
          .values({ companyId: own, code: 'NBO', name: 'Nairobi' })
          .returning()
      ), 0);
      const inv = await inTx((tx) =>
        svc.assign(
          'tax_invoice',
          {
            companyId: own,
            branchId: ownBranch.id,
            date: '2026-03-01',
            document: { kind: 'tax_invoice', id: 'i1' },
          },
          tx,
        ),
      );
      expect(inv.number).toBe('INV-NBO-26-000000001');
      const all = await svc.listSeries(own);
      expect(required(all.find((s) => s.code === 'INV')).mode).toBe('gap_free');
      expect(required(all.find((s) => s.code === 'SO')).mode).toBe('allow_gaps');
      expect((await svc.seedStandard(own, actor, '2026-03-01')).created).toEqual([]); // safe to repeat
    });
  });

  describe('per-branch counters, automatic setup and continuation', () => {
    it('gives each branch its own unbroken sequence when the pattern names the branch', async () => {
      await series('PB', {}, { prefix: 'PB-{BRANCH}-' });
      const interleaved = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          next('PB', { branchId: i % 2 === 0 ? nbo.id : msa.id }),
        ),
      );
      const nairobi = interleaved.filter((n) => n.startsWith('PB-NBO-')).sort();
      const mombasa = interleaved.filter((n) => n.startsWith('PB-MSA-')).sort();
      // each branch is contiguous from 1: no gaps caused by the other branch
      expect(nairobi).toEqual(
        Array.from({ length: 15 }, (_, i) => `PB-NBO-${String(i + 1).padStart(4, '0')}`),
      );
      expect(mombasa).toEqual(
        Array.from({ length: 15 }, (_, i) => `PB-MSA-${String(i + 1).padStart(4, '0')}`),
      );
    });

    it('sets up the standard series the first time a kind is numbered, even when many callers race', async () => {
      const [other] = await db
        .insert(schema.companySettings)
        .values({
          legalName: 'Auto',
          tradingName: 'Auto',
          email: 'a@b.c',
          phone: '1',
          streetAddress: 's',
          city: 'c',
          countyOrState: 'x',
          postalCode: '1',
          kraPin: 'P',
        })
        .returning();
      const own = required(other).id;
      const numbers = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          svc.assign('sales_order', {
            companyId: own,
            date: '2026-05-01',
            document: { kind: 'sales_order', id: `auto-${i}` },
          }),
        ),
      );
      const values = numbers.map((n) => n.number);
      expect(new Set(values).size).toBe(20);
      expect(values[0]).toMatch(/^ORD-2026-\d{10}$/);
      const bound = (await svc.bindings(own)).filter((b) => b.documentKind === 'sales_order');
      expect(bound).toHaveLength(1);
    });

    it('carries on from an older counter instead of restarting at 1', async () => {
      const [other] = await db
        .insert(schema.companySettings)
        .values({
          legalName: 'Legacy',
          tradingName: 'Legacy',
          email: 'a@b.c',
          phone: '1',
          streetAddress: 's',
          city: 'c',
          countyOrState: 'x',
          postalCode: '1',
          kraPin: 'P',
        })
        .returning();
      const { NumberSeriesService } = await import('./service');
      const { ReasonCodes } = await import('../reason-codes/service');
      const withLegacy = new NumberSeriesService(db, decisions, new ReasonCodes(db), {
        legacyStart: (_company, kind) => Promise.resolve(kind === 'customer' ? 500 : null),
      });
      const n = await withLegacy.assign('customer', { companyId: required(other).id, date: '2026-05-01' });
      expect(n.number).toBe('C000000500');
    });

    it('sizes the standard series for the real volume', async () => {
      const { DOCUMENT_KINDS } = await import('./document-kinds');
      // ~330 million orders a year: anything per-document at that rate needs 9+ digits.
      for (const kind of [
        'sales_order',
        'sales_delivery',
        'proforma_invoice',
        'customer_payment',
      ] as const) {
        expect(DOCUMENT_KINDS[kind].suggested.digits).toBeGreaterThanOrEqual(9);
      }
      // fiscal documents number per branch so each branch's sequence is unbroken
      for (const [kind, def] of Object.entries(DOCUMENT_KINDS)) {
        if (def.fiscal) expect(def.suggested.prefix, kind).toContain('{BRANCH}');
      }
    });
  });

  describe('append-only facts', () => {
    /** Drizzle wraps the Postgres error, so the trigger's message is on `.cause`. */
    const refused = async (p: Promise<unknown>) => {
      const e = (await p.then(
        () => null,
        (err: unknown) => err,
      )) as { message?: string; cause?: { message?: string } } | null;
      expect(e).not.toBeNull();
      expect(`${e?.message ?? ''} ${e?.cause?.message ?? ''}`).toMatch(/append-only/);
    };

    it('refuses to change or delete issued numbers and decision log entries', async () => {
      const s = await series('AO');
      await next('AO');
      await refused(
        Promise.resolve(
          db.execute(
            sql`update number_series_allocations set number = 'X' where series_id = ${s.id}`,
          ),
        ),
      );
      await refused(
        Promise.resolve(
          db.execute(sql`delete from number_series_allocations where series_id = ${s.id}`),
        ),
      );
      await refused(
        Promise.resolve(
          db.execute(sql`update decision_log set action = 'x' where subject_id = ${s.id}`),
        ),
      );
      await refused(
        Promise.resolve(
          db.delete(schema.decisionLog).where(eq(schema.decisionLog.subjectId, s.id)),
        ),
      );
    });
  });
});
