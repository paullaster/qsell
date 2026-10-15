import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Sources from '@/server/domains/lookups/sources';
import type * as Request from '@/server/domains/lookups/request';
import type { AppContainer } from '@/server/di/container';

/**
 * The dimension settings against a real database: the pickers' lists (what they offer and hide),
 * the keyset-paged lists behind the screens, and the rule failures that carry words for the person.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('dimension settings (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let sources: typeof Sources;
  let request: typeof Request;
  let c: AppContainer;
  let companyId: string;
  let otherCompanyId: string;
  let parentId: string;
  let otherDimensionId: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();

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
    otherCompanyId = (
      await db.insert(schema.companySettings).values({ legalName: `Other ${tag}`, tradingName: `Other ${tag}`, email: `o-${tag}@example.test`, phone: '0', streetAddress: '1', city: 'N', countyOrState: 'N', postalCode: '0', kraPin: `P${tag}` }).returning()
    )[0]?.id ?? '';
    const make = async (company: string, code: string, name: string) =>
      (await db.insert(schema.dimensions).values({ companyId: company, code, name }).returning())[0]?.id ?? '';
    parentId = await make(companyId, `${tag}-P`, `${tag} Parent`);
    await make(companyId, `${tag}-A`, `${tag} Alpha`);
    await make(companyId, `${tag}-B`, `${tag} Beta`);
    otherDimensionId = await make(otherCompanyId, `${tag}-X`, `${tag} Other company`);
    for (let i = 0; i < 30; i++) {
      await db.insert(schema.dimensionValues).values({ dimensionId: parentId, dimensionCode: `${tag}-P`, code: `V${String(i).padStart(2, '0')}`, name: `Value ${String(i)}` });
    }
    await db.insert(schema.dimensionValues).values({ dimensionId: otherDimensionId, dimensionCode: `${tag}-X`, code: 'OTHER', name: 'Other company value' });
  });

  describe('the pickers', () => {
    it('offers the company dimensions, searchable, never another company\'s', async () => {
      const all = await search('dimensions', { query: tag });
      expect(all.options.map((o) => o.label.split(' — ')[0])).toEqual([`${tag}-A`, `${tag}-B`, `${tag}-P`]);
      const one = await search('dimensions', { query: 'Beta' });
      expect(one.options.map((o) => o.label)).toContain(`${tag}-B — ${tag} Beta`);
      expect((await search('dimensions', { query: 'Other company' })).options).toHaveLength(0);
    });

    it('leaves out the dimension being edited, and refuses a filter that is not an id', async () => {
      const without = await search('dimensions', { query: tag, filters: { exclude: parentId } });
      expect(without.options.map((o) => o.id)).not.toContain(parentId);
      await expect(search('dimensions', { filters: { exclude: 'nope' } })).rejects.toThrow();
      await expect(search('dimensions', { filters: { other: parentId } })).rejects.toThrow();
    });

    it('offers the values of one dimension, and nothing of another company\'s', async () => {
      const values = await search('dimension-values', { filters: { dimension: parentId }, query: 'V0' });
      expect(values.options.length).toBeGreaterThan(0);
      expect(values.options.every((o) => o.label.startsWith(`${tag}-P:V0`))).toBe(true);
      expect((await search('dimension-values', { filters: { dimension: otherDimensionId } })).options).toHaveLength(0);
      await expect(search('dimension-values')).rejects.toThrow();
      const minusOne = await search('dimension-values', { filters: { dimension: parentId, exclude: values.options[0]?.id ?? '' }, query: 'V0' });
      expect(minusOne.options.map((o) => o.id)).not.toContain(values.options[0]?.id);
    });

    it('offers the fixed lists', async () => {
      expect((await search('dimension-option-strings')).options.map((o) => o.id)).toContain('branch');
      expect((await search('dimension-kinds')).options.map((o) => o.id)).toEqual(['global', 'shortcut']);
    });

    it('pages a long list a page at a time', async () => {
      const first = await search('dimension-values', { filters: { dimension: parentId } });
      expect(first.options).toHaveLength(20);
      expect(first.nextCursor).not.toBeNull();
      const second = await search('dimension-values', { filters: { dimension: parentId } });
      expect(second.options[0]?.id).toBe(first.options[0]?.id);
    });
  });

  describe('the paged lists', () => {
    it('pages dimensions by code and finds them by text', async () => {
      const page = await c.dimensions.pageByCompany(companyId, { query: tag });
      expect(page.rows.map((r) => r.code)).toEqual([`${tag}-A`, `${tag}-B`, `${tag}-P`]);
      expect(page.nextCursor).toBeNull();
      expect((await c.dimensions.pageByCompany(companyId, { query: 'zzz-nothing' })).rows).toHaveLength(0);
    });

    it('pages values with a keyset cursor and no repeats', async () => {
      const first = await c.dimensions.pageValues(parentId, {});
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await c.dimensions.pageValues(parentId, { cursor: first.nextCursor });
      expect(second.rows).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.rows, ...second.rows].map((r) => r.id);
      expect(new Set(ids).size).toBe(30);
      expect(first.rows[0]?.code).toBe('V00');
      expect((await c.dimensions.pageValues(parentId, { query: 'Value 29' })).rows.map((r) => r.code)).toEqual(['V29']);
    });

    it('starts from the top on a cursor that is not ours', async () => {
      const page = await c.dimensions.pageValues(parentId, { cursor: 'not-a-cursor' });
      expect(page.rows[0]?.code).toBe('V00');
    });

    it('labels parents without loading a list', async () => {
      expect(await c.dimensions.codesOf([parentId])).toEqual({ [parentId]: `${tag}-P` });
      expect(await c.dimensions.codesOf([])).toEqual({});
    });
  });

  describe('the rules', () => {
    it('refuses with words meant for the person', async () => {
      const { DimensionWriteService } = await import('./write-service');
      const { DimensionError } = await import('./errors');
      const { SettingsError } = await import('@/server/domains/settings/errors');
      const write = new DimensionWriteService(c.dimensions, c.branches, c.db);
      const duplicate = write.createDimension({ companyId, code: `${tag}-A`, name: 'again' });
      await expect(duplicate).rejects.toBeInstanceOf(DimensionError);
      await expect(duplicate).rejects.toBeInstanceOf(SettingsError);
      await expect(duplicate).rejects.toThrow(/already exists/);
      await expect(write.createDimension({ companyId, code: `${tag}-G`, name: 'Global without number', isGlobal: true })).rejects.toThrow(/dimension_no is required/);
      await expect(write.createDimension({ companyId, code: `${tag}-S`, name: 'Both', isGlobal: true, isShortcut: true, dimensionNo: 9 })).rejects.toThrow(/cannot be both/);
    });

    it('refuses a parent from another company', async () => {
      const { DimensionWriteService } = await import('./write-service');
      const write = new DimensionWriteService(c.dimensions, c.branches, c.db);
      await expect(write.createDimension({ companyId, code: `${tag}-Q`, name: 'Stolen parent', parentId: otherDimensionId })).rejects.toThrow(/Parent dimension not found/);
    });
  });
});
