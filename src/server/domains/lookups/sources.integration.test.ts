import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Sources from './sources';
import type * as Request from './request';

/**
 * The searchable lists, against a real database: ordering, contains-search over the configured
 * columns, literal wildcards, company scoping, filters, and paging by cursor.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('lookup sources (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let sources: typeof Sources;
  let request: typeof Request;
  let companyId: string;
  let otherCompanyId: string;
  const tag = randomUUID().slice(0, 8);

  const search = async (
    key: string,
    over: Partial<{
      query: string;
      limit: number;
      after: string | null;
      filters: Record<string, string>;
    }> = {},
    company = () => companyId,
  ) => {
    const parsed = request.parseLookupRequest({
      source: key,
      query: over.query,
      limit: over.limit,
      cursor: over.after,
      filters: over.filters,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const source = sources.getLookupSource(key);
    if (source === undefined) throw new Error(`no source ${key}`);
    const { query, limit, after, filters } = parsed.value;
    return await source.search({ companyId: company(), query, limit, after, filters });
  };

  const template = (name: string, over: Record<string, unknown> = {}) =>
    db.insert(schema.salesQuoteTemplates).values({ companyId, name: `${tag} ${name}`, ...over });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    sources = await import('./sources');
    request = await import('./request');
    companyId = (await mod.getContainer().companySettings.ensureSeeded()).id;
    otherCompanyId = (
      await db
        .insert(schema.companySettings)
        .values({
          legalName: `Other ${tag}`,
          tradingName: `Other ${tag}`,
          email: `other-${tag}@example.test`,
          phone: '0',
          streetAddress: '1',
          city: 'N',
          countyOrState: 'N',
          postalCode: '0',
          kraPin: `P${tag}`,
        })
        .returning()
    )[0].id;
    await template('Alpha', { category: 'Staples' });
    await template('Beta', { description: 'Contains 50%_off wording', isDefault: false });
    await template('Gamma', { status: 'archived' });
    await db
      .insert(schema.salesQuoteTemplates)
      .values({ companyId: otherCompanyId, name: `${tag} Alpha elsewhere` });
    for (let i = 0; i < 7; i += 1) await template(`Page ${String(i).padStart(2, '0')}`);
  });

  it('lists active templates of the company in name order, never another company’s', async () => {
    const page = await search('quote-templates', { query: tag, limit: 50 });
    const names = page.options.map((o) => o.label);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain(`${tag} Alpha`);
    expect(names.some((n) => n.includes('elsewhere'))).toBe(false);
    expect(names).not.toContain(`${tag} Gamma`);
  });

  it('searches every configured column, case-insensitively', async () => {
    expect((await search('quote-templates', { query: `${tag} ALPHA` })).options).toHaveLength(1);
    expect(
      (await search('quote-templates', { query: 'staples' })).options.map((o) => o.label),
    ).toContain(`${tag} Alpha`);
    expect(
      (await search('quote-templates', { query: 'wording' })).options.map((o) => o.label),
    ).toEqual([`${tag} Beta`]);
  });

  it('treats % and _ in the search text literally', async () => {
    const hit = await search('quote-templates', { query: '50%_off' });
    expect(hit.options.map((o) => o.label)).toEqual([`${tag} Beta`]);
    expect((await search('quote-templates', { query: '%' })).options).toHaveLength(1);
    expect((await search('quote-templates', { query: `${tag} _lpha` })).options).toHaveLength(0);
  });

  it('filters by status and rejects filters it does not offer', async () => {
    const archived = await search('quote-templates', {
      query: tag,
      filters: { status: 'archived' },
    });
    expect(archived.options.map((o) => o.label)).toEqual([`${tag} Gamma`]);
    await expect(search('quote-templates', { filters: { status: 'nope' } })).rejects.toThrow();
    await expect(search('quote-templates', { filters: { companyId: 'x' } })).rejects.toThrow();
  });

  it('pages by cursor without repeating or skipping, and says when it is done', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await search('quote-templates', {
        query: `${tag} Page`,
        limit: 3,
        after: cursor,
      });
      expect(page.options.length).toBeLessThanOrEqual(3);
      seen.push(...page.options.map((o) => o.label));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...seen].sort((a, b) => a.localeCompare(b)));
  });

  it('searches section templates by their section title too', async () => {
    const [created] = await db
      .insert(schema.salesSectionTemplates)
      .values({ companyId, name: `${tag} Kit`, sectionTitle: `Zebra ${tag}` })
      .returning();
    const hit = await search('section-templates', { query: `Zebra ${tag}` });
    expect(hit.options).toEqual([
      { id: created.id, label: `${tag} Kit`, description: `Section “Zebra ${tag}”`, badge: null },
    ]);
  });

  it('only knows the sources the server defines', () => {
    expect(sources.getLookupSource('users')).toBeUndefined();
    expect(sources.getLookupSource('__proto__')).toBeUndefined();
    expect(sources.getLookupSource('constructor')).toBeUndefined();
  });
});
