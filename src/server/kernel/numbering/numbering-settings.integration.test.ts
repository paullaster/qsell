import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Sources from '@/server/domains/lookups/sources';
import type * as Request from '@/server/domains/lookups/request';
import type { AppContainer } from '@/server/di/container';

/**
 * The number-series settings against a real database: the pickers' lists (series, branches, reasons),
 * the paged list and its batched facts, and the labels that let a screen name things without
 * loading every series or branch.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('number series settings (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let sources: typeof Sources;
  let request: typeof Request;
  let c: AppContainer;
  let companyId: string;
  let nbo = '';
  let msa = '';
  const tag = randomUUID().slice(0, 5).toUpperCase();
  const actor = { type: 'user' as const, id: 'tester' };
  const reason = { code: 'DATA_ENTRY_ERROR' };

  const search = async (key: string, over: { query?: string; filters?: Record<string, string> } = {}) => {
    const parsed = request.parseLookupRequest({ source: key, query: over.query, filters: over.filters });
    if (!parsed.ok) throw new Error(parsed.error);
    const source = sources.getLookupSource(key);
    if (source === undefined) throw new Error(`no source ${key}`);
    const { query, limit, after, filters } = parsed.value;
    return await source.search({ companyId, query, limit, after, filters });
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    sources = await import('@/server/domains/lookups/sources');
    request = await import('@/server/domains/lookups/request');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    const branch = async (code: string, name: string, over: Record<string, unknown> = {}) =>
      (await db.insert(schema.branches).values({ companyId, code, name, ...over }).returning())[0]?.id ?? '';
    nbo = await branch(`N${tag}`, `Nairobi ${tag}`);
    msa = await branch(`M${tag}`, `Mombasa ${tag}`);
    await branch(`X${tag}`, `Closed ${tag}`, { isActive: false });

    for (const [code, mode] of [['GF', 'gap_free'], ['GP', 'allow_gaps']] as const) {
      const s = await c.numbering.createSeries(companyId, { code: `${tag}${code}`, description: `${tag} ${code} series`, mode }, actor);
      await c.numbering.addLine(companyId, s.id, { startsOn: '2026-01-01', prefix: `${code}-`, digits: 4 }, actor);
    }
    const off = await c.numbering.createSeries(companyId, { code: `${tag}OFF`, description: `${tag} retired`, mode: 'gap_free' }, actor);
    await c.numbering.updateSeries(companyId, off.id, { isActive: false }, actor, reason);
  });

  describe('the pickers', () => {
    it('offer active series only, and for a fiscal document only gap-free ones', async () => {
      const all = await search('number-series', { query: tag });
      expect(all.options.map((o) => o.label.split(' — ')[0])).toEqual([`${tag}GF`, `${tag}GP`]);
      const fiscal = await search('number-series', { query: tag, filters: { fiscal: '1' } });
      expect(fiscal.options.map((o) => o.label.split(' — ')[0])).toEqual([`${tag}GF`]);
      await expect(search('number-series', { filters: { fiscal: '2' } })).rejects.toThrow();
    });

    it('offer open branches, leaving out those that already have their own series for a document', async () => {
      const branches = await search('numbering-branches', { query: tag });
      expect(branches.options.map((o) => o.label)).toEqual([`Mombasa ${tag} (M${tag})`, `Nairobi ${tag} (N${tag})`]);
      const series = (await search('number-series', { query: `${tag}GF` })).options[0]?.id ?? '';
      await c.numbering.setBinding(companyId, { documentKind: 'tax_invoice', branchId: nbo, seriesId: series }, actor, reason);
      const left = await search('numbering-branches', { query: tag, filters: { unbound: 'tax_invoice' } });
      expect(left.options.map((o) => o.id)).toEqual([msa]);
      await expect(search('numbering-branches', { filters: { unbound: 'not_a_kind' } })).rejects.toThrow();
      await c.numbering.clearBinding(companyId, 'tax_invoice', nbo, actor, reason);
    });

    it('offer the restart choices', async () => {
      expect((await search('number-reset-modes')).options.map((o) => o.id).sort()).toEqual(['monthly', 'never', 'yearly']);
    });

    it('offer reasons, each behind its own permission and with whether a comment is required', async () => {
      await db.insert(schema.reasonCodes).values([
        { companyId, code: `${tag}A`, description: `${tag} pricing only`, appliesTo: ['pricing_configuration'] },
        { companyId, code: `${tag}B`, description: `${tag} other area`, appliesTo: ['inventory'], requiresComment: true },
        { companyId, code: `${tag}C`, description: `${tag} anywhere` },
        { companyId, code: `${tag}D`, description: `${tag} retired`, isActive: false },
        { companyId, code: `${tag}E`, description: `${tag} anywhere, explain`, requiresComment: true },
      ]);
      // A reason tied to one area is not offered where it would be refused: the general pickers list only reasons that apply anywhere.
      const numbering = await search('numbering-reasons', { query: tag });
      expect(numbering.options.map((o) => o.id).sort()).toEqual([`${tag}C`, `${tag}E`]);
      expect(numbering.options.find((o) => o.id === `${tag}E`)?.meta).toEqual({ requiresComment: '1' });
      const pricing = await search('pricing-reasons', { query: tag });
      expect(pricing.options.map((o) => o.id).sort()).toEqual([`${tag}A`, `${tag}C`, `${tag}E`]);
      expect((await search('approval-config-reasons', { query: tag })).options).toHaveLength(2);
      expect((await search('approval-reasons', { query: tag })).options).toHaveLength(2);
    });

    it('every one of them names the permission it needs', () => {
      for (const key of ['number-series', 'numbering-branches', 'number-reset-modes', 'numbering-reasons']) {
        expect(sources.getLookupSource(key)?.permission).toBe('numbering:manage');
      }
      expect(sources.getLookupSource('approval-config-reasons')?.permission).toBe('approvals:manage');
      expect(sources.getLookupSource('approval-reasons')?.permission).toBe('approvals:act');
      expect(sources.getLookupSource('pricing-reasons')?.permission).toBe('pricing:read');
    });
  });

  describe('the paged list', () => {
    it('pages by code with line counts and bindings for the page only', async () => {
      const page = await c.numbering.pageSeries(companyId, { query: tag });
      expect(page.rows.map((r) => r.code)).toEqual([`${tag}GF`, `${tag}GP`, `${tag}OFF`]);
      expect(page.lineCounts.get(page.rows[0]?.id ?? '')).toBe(1);
      expect(page.lineCounts.get(page.rows[2]?.id ?? '') ?? 0).toBe(0);
      expect(page.nextCursor).toBeNull();
      expect((await c.numbering.pageSeries(companyId, { query: 'zzz-no-such' })).rows).toHaveLength(0);
    });

    it('names series and branches by id without loading the lists', async () => {
      const page = await c.numbering.pageSeries(companyId, { query: `${tag}GF` });
      const id = page.rows[0]?.id ?? '';
      expect((await c.numbering.seriesLabels(companyId, [id])).get(id)).toBe(`${tag}GF — ${tag} GF series`);
      expect((await c.numbering.branchLabels([nbo])).get(nbo)).toBe(`Nairobi ${tag} (N${tag})`);
      expect((await c.numbering.branchCodes([msa])).get(msa)).toBe(`M${tag}`);
      expect((await c.numbering.seriesLabels(companyId, [])).size).toBe(0);
    });
  });
});
