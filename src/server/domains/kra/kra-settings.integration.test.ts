import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Sources from '@/server/domains/lookups/sources';
import type * as Request from '@/server/domains/lookups/request';
import type { AppContainer } from '@/server/di/container';

/**
 * The KRA and tax settings against a real database: the pickers' lists, the paged lists behind the
 * eTIMS items, signing log, branch modes and tax rules, and the facts the summary cards use.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('KRA and tax settings (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let sources: typeof Sources;
  let request: typeof Request;
  let c: AppContainer;
  let companyId = '';
  let itemTypeId = '';
  const tag = randomUUID().slice(0, 6).toUpperCase();

  const search = async (key: string, over: { query?: string; filters?: Record<string, string> } = {}) => {
    const parsed = request.parseLookupRequest({ source: key, query: over.query, filters: over.filters });
    if (!parsed.ok) throw new Error(parsed.error);
    const source = sources.getLookupSource(key);
    if (source === undefined) throw new Error(`no source ${key}`);
    const { query, limit, after, filters } = parsed.value;
    return await source.search({ companyId, query, limit, after, filters });
  };
  const product = async (n: number, over: Record<string, unknown> = {}) => {
    const id = `${tag}-p${String(n).padStart(2, '0')}`;
    await db.insert(schema.products).values({ id, sku: `${tag}-${String(n).padStart(2, '0')}`, stockCode: `S${tag}${String(n)}`, name: `${tag} Product ${String(n).padStart(2, '0')}`, slug: `p-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50', stockQuantity: n, taxRate: '16', isTaxInclusive: true, ...over });
    return id;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    sources = await import('@/server/domains/lookups/sources');
    request = await import('@/server/domains/lookups/request');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    itemTypeId = (await db.insert(schema.itemTypes).values({ id: `it-${tag}`, name: `Type ${tag}`, code: Math.floor(Math.random() * 1e9) } as never).returning())[0]?.id ?? '';
    const { encryptCredentials } = await import('@/server/domains/payments/crypto');
    await c.kraConfigs.upsertCompanyConfig(companyId, {
      mode: 'etims',
      isEnabled: true,
      allowEtimsSigning: false,
      allowTimsSigning: false,
      moduleSigning: {},
      environment: 'sandbox',
      apiBaseUrl: 'https://etims.example.test/api',
      settings: {},
      credentialsEncrypted: encryptCredentials({ username: 'u', password: 'p' }),
    });
  });

  describe('the fixed pickers', () => {
    it('offer environments, connections, results and tax choices', async () => {
      expect((await search('kra-environments')).options.map((o) => o.id)).toEqual(['production', 'sandbox']);
      expect((await search('kra-connections')).options.map((o) => o.id).sort()).toEqual(['com', 'tcp']);
      expect((await search('kra-signing-outcomes')).options).toHaveLength(4);
      expect((await search('tax-types')).options.map((o) => o.id)).toContain('vat');
      expect((await search('tax-pricing-models')).options.map((o) => o.id).sort()).toEqual(['exclusive', 'inclusive']);
      expect((await search('kra-tims-codes')).options.map((o) => o.id)).toContain('A');
      expect((await search('kra-etims-codes')).options.map((o) => o.id)).toContain('B');
    });

    it('word the branch choice by what the company has, and need to know it', async () => {
      const on = await search('kra-module-signing', { filters: { inherited: 'on' } });
      expect(on.options.map((o) => o.id).sort()).toEqual(['', 'off', 'on']);
      expect(on.options.find((o) => o.id === '')?.label).toBe('Use company setting (on)');
      await expect(search('kra-module-signing')).rejects.toThrow();
      await expect(search('kra-module-signing', { filters: { inherited: 'maybe' } })).rejects.toThrow();
    });

    it('all sit behind the permission to manage taxes', () => {
      for (const key of ['kra-environments', 'kra-connections', 'kra-signing-outcomes', 'kra-module-signing', 'etims-targets', 'etims-registrable-products', 'tax-types', 'tax-pricing-models', 'kra-tims-codes', 'kra-etims-codes', 'tax-categories']) {
        expect(sources.getLookupSource(key)?.permission).toBe('taxes:manage');
      }
    });
  });

  describe('tax rules', () => {
    it('are paged by name, narrowed by text, type and pricing model, with product counts', async () => {
      const rule = (n: number, over: Record<string, unknown> = {}) =>
        db.insert(schema.taxCategories).values({ id: `${tag}-t${String(n).padStart(2, '0')}`, name: `${tag} Rule ${String(n).padStart(2, '0')}`, code: `${tag}${String(n)}`, rate: String(n), type: 'vat', countryCode: 'KE', countryName: 'Kenya', ...over } as never);
      for (let i = 0; i < 27; i++) await rule(i, i % 2 === 0 ? { isInclusive: true } : { isInclusive: false, type: 'excise' });
      await product(90, { taxCategoryId: `${tag}-t00` });
      const first = await c.catalog.pageTaxCategories({ query: tag });
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await c.catalog.pageTaxCategories({ query: tag, cursor: first.nextCursor });
      expect(second.rows).toHaveLength(2);
      expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(27);
      expect(first.rows[0]?.productCount).toBe(1);
      expect((await c.catalog.pageTaxCategories({ query: tag, type: 'excise' })).rows.every((r) => r.type === 'excise')).toBe(true);
      expect((await c.catalog.pageTaxCategories({ query: tag, inclusive: true })).rows.every((r) => r.isInclusive)).toBe(true);
      expect((await c.catalog.pageTaxCategories({ query: `${tag} rule 07` })).rows).toHaveLength(1);
    });

    it('feed the summary cards from the database, and the picker with the default first as a tag', async () => {
      const summary = await c.catalog.taxSummary();
      expect(summary.total).toBeGreaterThanOrEqual(27);
      expect(summary.active).toBeLessThanOrEqual(summary.total);
      expect(summary.countries).toBeGreaterThanOrEqual(1);
      const found = await search('tax-categories', { query: `${tag} Rule 03` });
      expect(found.options).toHaveLength(1);
      expect(found.options[0]?.meta).toEqual({ rate: '3.0000', inclusive: '' });
    });
  });

  describe('eTIMS items', () => {
    it('offers the company as a place to register items, usable when its eTIMS setup is complete', async () => {
      const targets = await search('etims-targets');
      expect(targets.options.map((o) => o.id)).toContain('company');
      expect(targets.options.find((o) => o.id === 'company')?.meta?.usable).toBe('1');
    });

    it('offers products still to register, by name or SKU, a page at a time, with their facts', async () => {
      for (let i = 1; i <= 24; i++) await product(i);
      await product(25, { taxCategoryId: null });
      const first = await search('etims-registrable-products', { query: tag, filters: { scope: 'company' } });
      expect(first.options.length).toBeGreaterThan(0);
      expect(first.options[0]?.meta?.stock).toBeDefined();
      const none = await search('etims-registrable-products', { query: `${tag} Product 05`, filters: { scope: 'company' } });
      expect(none.options).toHaveLength(1);
      await expect(search('etims-registrable-products')).rejects.toThrow();
      await expect(search('etims-registrable-products', { filters: { scope: 'not-an-id' } })).rejects.toThrow();
    });

    it('pages registered items by name and finds them by text; registered ones are no longer offered', async () => {
      const target = { companyId, branchId: null };
      const pid = (n: number) => `${tag}-p${String(n).padStart(2, '0')}`;
      for (let i = 1; i <= 27; i++) {
        if (i > 24) await product(100 + i);
        await db.insert(schema.etimsItems).values({ productId: i <= 24 ? pid(i) : `${tag}-p${String(100 + i)}`, companyId, scope: 'company', branchId: null, kraItemCode: `KRA${tag}${String(i).padStart(2, '0')}`, status: 'registered', name: `${tag} Item ${String(i).padStart(2, '0')}`, itemTypeCode: '2', taxCode: 'B', qtyUnitCode: 'U', pkgUnitCode: 'CT', itemClassCode: '99000000', stockQuantity: i } as never);
      }
      const first = await c.etimsItems.pageLocal(target, { query: tag });
      expect(first.rows).toHaveLength(25);
      const second = await c.etimsItems.pageLocal(target, { query: tag, cursor: first.nextCursor });
      expect(second.rows).toHaveLength(2);
      expect(first.rows[0]?.name).toBe(`${tag} Item 01`);
      expect((await c.etimsItems.pageLocal(target, { query: `KRA${tag}12` })).rows).toHaveLength(1);
      const facts = await c.etimsItems.productFacts([pid(1)]);
      expect(facts.get(pid(1))).toMatchObject({ sku: `${tag}-01` });
      const left = await search('etims-registrable-products', { query: `${tag} Product 01`, filters: { scope: 'company' } });
      expect(left.options).toHaveLength(0);
    });
  });

  describe('the signing log', () => {
    it('pages documents by their latest event, newest first, narrowed by result and text', async () => {
      const event = (doc: string, outcome: string, at: Date, over: Record<string, unknown> = {}) =>
        db.insert(schema.kraSigningEvents).values({ companyId, documentKey: `order:${tag}-${doc}:tax_invoice`, documentType: 'tax_invoice', documentId: `${tag}-${doc}`, documentRef: `ORD-${tag}-${doc}`, module: 'sales_order', eventType: 'decision', outcome, reason: outcome === 'sign' ? 'SIGN' : 'KRA_NOT_CONFIGURED', createdAt: at, ...over } as never);
      const t0 = Date.now() - 3_600_000;
      for (let i = 0; i < 27; i++) {
        await event(String(i).padStart(2, '0'), 'skip', new Date(t0 + i * 1000));
        if (i % 3 === 0) await event(String(i).padStart(2, '0'), 'sign', new Date(t0 + i * 1000 + 500));
      }
      const first = await c.kraSigning.pageDocuments(companyId, { query: tag });
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await c.kraSigning.pageDocuments(companyId, { query: tag, cursor: first.nextCursor });
      expect(second.rows).toHaveLength(2);
      const keys = [...first.rows, ...second.rows].map((r) => r.documentKey);
      expect(new Set(keys).size).toBe(27);
      expect(first.rows[0]?.documentKey).toContain('-26:');
      // A document shows its latest event: the ones that were signed afterwards show as signed.
      const signed = await c.kraSigning.pageDocuments(companyId, { query: tag, outcome: 'sign' });
      expect(signed.rows).toHaveLength(9);
      expect(signed.rows.every((r) => r.outcome === 'sign')).toBe(true);
      const skipped = await c.kraSigning.pageDocuments(companyId, { query: tag, outcome: 'skip' });
      expect(skipped.rows).toHaveLength(18);
      expect((await c.kraSigning.pageDocuments(companyId, { query: `ORD-${tag}-05` })).rows).toHaveLength(1);
      expect((await c.kraSigning.pageDocuments(companyId, { query: 'no-such-order-zzz' })).rows).toHaveLength(0);
    });

    it('reads one document\'s whole story only for the company that owns it', async () => {
      const key = `order:${tag}-00:tax_invoice`;
      const own = await c.kraSigning.trace(key, companyId);
      expect(own.map((e) => e.outcome)).toEqual(['skip', 'sign']);
      expect(await c.kraSigning.trace(key, randomUUID())).toEqual([]);
    });
  });

  describe('branch modes', () => {
    it('lists a page of branches with their own KRA configuration where they have one', async () => {
      const [branch] = await db.insert(schema.branches).values({ companyId, code: `K${tag}`, name: `${tag} Independent`, actsIndependently: true }).returning();
      await c.kraConfigs.upsertBranchConfig(branch?.id ?? '', { mode: 'tims', isEnabled: false, allowEtimsSigning: false, allowTimsSigning: false, moduleSigning: { sales_order: true }, environment: 'sandbox', apiBaseUrl: null, settings: { cuSerial: 'CU1' } });
      const page = await c.branches.pageByCompany(companyId, { query: tag });
      const configs = await c.kraConfigs.getBranchConfigs(page.rows.map((b) => b.id));
      expect(configs.get(branch?.id ?? '')?.mode).toBe('tims');
      expect(configs.size).toBe(1);
      await db.delete(schema.branchKraConfigs).where(eq(schema.branchKraConfigs.branchId, branch?.id ?? ''));
    });
  });
});
