import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as SchemaModule from '@/server/db/drizzle/schema';
import { DEFAULT_STOREFRONT_QUERY, type StorefrontQuery } from '@/lib/storefront-search';
import { has, nth } from '@/lib/values';
import type { StorefrontCatalog as Catalog } from './storefront-service';

/** The public shop's catalog reads against a real database:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('storefront catalog (database)', () => {
  let db: typeof drizzleDb;
  let schema: typeof SchemaModule;
  let StorefrontCatalog: typeof Catalog;
  let itemTypeId: string;
  const run = randomUUID().slice(0, 8);
  const tag = `zz${run}`; // every product of this run carries it, so a shared database does not disturb the counts

  const category = async (name: string, parentId: string | null = null, over: Record<string, unknown> = {}) => {
    const id = `cat_${randomUUID()}`;
    await db.insert(schema.categories).values({ id, name: `${name} ${run}`, slug: `${name.toLowerCase()}-${run}`, parentId, ...over });
    return { id, slug: `${name.toLowerCase()}-${run}`, name: `${name} ${run}` };
  };
  const product = async (name: string, over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `${tag}-${randomUUID().slice(0, 6)}`.toUpperCase(),
      stockCode: `SC-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `${tag} ${name}`,
      slug: `${tag}-${randomUUID()}`,
      itemTypeId,
      price: '100',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 10,
      ...over,
    });
    return id;
  };
  const search = (over: Partial<StorefrontQuery> = {}) => StorefrontCatalog.search({ ...DEFAULT_STOREFRONT_QUERY, q: tag, ...over });
  const names = (page: { products: { name: string }[] }) => page.products.map((p) => p.name.replace(`${tag} `, ''));

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ StorefrontCatalog } = await import('./storefront-service'));
    itemTypeId = `it_shop_${run}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  it('shows only live products, never the cost, and counts them in all', async () => {
    await product('Live');
    await product('Hidden', { isActive: false });
    await product('Service', { isSellable: false });
    await product('Deleted', { deletedAt: new Date() });
    const page = await search();
    expect(names(page)).toEqual(['Live']);
    expect(page.total).toBe(1);
    expect(page.products[0]).not.toHaveProperty('costPrice');
  });

  it('sorts by name, price (both ways) and newest, equal prices tie-break on id', async () => {
    const stamp = (n: number) => new Date(Date.UTC(2031, 0, n));
    await product('Cheap', { price: '5', createdAt: stamp(1) });
    await product('Mid', { price: '50', createdAt: stamp(2) });
    await product('Dear', { price: '500', createdAt: stamp(3) });
    await product('Dear twin', { price: '500', createdAt: stamp(3) });
    const q = `${tag} `; // matches the four above and "Live"
    const some = async (sort: StorefrontQuery['sort']) => names(await search({ q, sort, minPrice: 5 })).filter((n) => n !== 'Live');
    expect(await some('name')).toEqual(['Cheap', 'Dear', 'Dear twin', 'Mid']);
    const ascending = await some('price_asc');
    expect(ascending.slice(0, 2)).toEqual(['Cheap', 'Mid']);
    expect(ascending.slice(2).sort()).toEqual(['Dear', 'Dear twin']); // equal prices: ordered by id
    expect((await some('price_desc')).slice(0, 2).sort()).toEqual(['Dear', 'Dear twin']);
    expect((await some('newest')).slice(0, 2).sort()).toEqual(['Dear', 'Dear twin']);
  });

  it('pages by key with no repeats or gaps, whichever way it is sorted', async () => {
    const total = 60;
    for (let i = 0; i < total; i += 1) {
      await product(`Page ${String(i).padStart(2, '0')}`, { price: String(10 + (i % 7)), createdAt: new Date(Date.UTC(2032, 0, 1, 0, 0, i % 5)) });
    }
    for (const sort of ['name', 'price_asc', 'price_desc', 'newest'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof search>> = await search({ q: `${tag} Page`, sort, cursor });
        expect(page.total).toBe(total);
        seen.push(...page.products.map((p) => p.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      expect(pages).toBe(3); // 24 + 24 + 12
    }
  });

  it('ignores a cursor that was tampered with and starts from the top', async () => {
    const first = await search({ q: `${tag} Page`, cursor: null });
    const forged = await search({ q: `${tag} Page`, cursor: 'not-a-cursor' });
    expect(forged.products.map((p) => p.id)).toEqual(first.products.map((p) => p.id));
  });

  it('finds every word in the name, SKU or category, and treats % and _ as plain letters', async () => {
    await product('Red running shoe');
    await product('Blue running shoe');
    expect(names(await search({ q: `${tag} red shoe` }))).toEqual(['Red running shoe']);
    expect(names(await search({ q: `${tag} RUNNING` }))).toEqual(['Blue running shoe', 'Red running shoe']);
    expect((await search({ q: '%' })).products.every((p) => p.name.includes('%'))).toBe(true);
    expect(await search({ q: `${tag} nothing-like-this` })).toMatchObject({ total: 0, products: [], nextCursor: null });
  });

  it('also finds a word from the description or the tags, including the start of a word', async () => {
    await product('Plain pot', { description: 'Heavy cast iron, seasoned', tags: ['cookware', 'kitchen'] });
    expect(names(await search({ q: `${tag} cast` }))).toEqual(['Plain pot']);
    expect(names(await search({ q: `${tag} iron seasoned` }))).toEqual(['Plain pot']);
    expect(names(await search({ q: `${tag} kitch` }))).toEqual(['Plain pot']);
    expect(await search({ q: `${tag} cast aluminium` })).toMatchObject({ total: 0 });
    // Punctuation and operator characters are only text, never part of the query language.
    expect(await search({ q: `${tag} cast&|!():*` })).toMatchObject({ total: 1 });
  });

  it('filters by price range and by stock', async () => {
    await product('Range low', { price: '20', stockQuantity: 0 });
    await product('Range high', { price: '80', stockQuantity: 5, reservedQuantity: 5 });
    await product('Range ok', { price: '50', stockQuantity: 5 });
    expect(names(await search({ q: `${tag} Range`, minPrice: 30, maxPrice: 90, sort: 'price_asc' }))).toEqual(['Range ok', 'Range high']);
    expect(names(await search({ q: `${tag} Range`, inStock: true }))).toEqual(['Range ok']);
  });

  it('a category includes its sub-categories; an unknown or inactive one is empty, never everything', async () => {
    const shoes = await category('Shoes');
    const boots = await category('Boots', shoes.id);
    const hats = await category('Hats');
    const off = await category('Retired', null, { isActive: false });
    await product('Cat shoe', { categoryId: shoes.id, categoryName: shoes.name });
    await product('Cat boot', { categoryId: boots.id, categoryName: boots.name });
    await product('Cat hat', { categoryId: hats.id, categoryName: hats.name });
    await product('Cat retired', { categoryId: off.id, categoryName: off.name });

    expect(names(await search({ q: `${tag} Cat`, category: shoes.slug }))).toEqual(['Cat boot', 'Cat shoe']);
    expect(names(await search({ q: `${tag} Cat`, category: boots.slug }))).toEqual(['Cat boot']);
    expect(await search({ q: `${tag} Cat`, category: 'no-such-category' })).toMatchObject({ total: 0, products: [], category: null });
    expect(await search({ q: `${tag} Cat`, category: off.slug })).toMatchObject({ total: 0 });

    const listed = await StorefrontCatalog.categories();
    const mine = listed.filter((c) => c.slug.endsWith(run));
    expect(mine.map((c) => [c.name.replace(` ${run}`, ''), c.count, c.depth])).toEqual([
      ['Hats', 1, 0],
      ['Shoes', 2, 0],
      ['Boots', 1, 1],
    ]);
  });

  it('reads the current state of cart lines and drops products that are no longer for sale', async () => {
    const keep = await product('Cart keep', { price: '75' });
    const gone = await product('Cart gone', { isActive: false });
    const lines = await StorefrontCatalog.productsByIds([keep, gone, keep, 'prod_missing']);
    expect(lines.map((p) => p.id)).toEqual([keep]);
    expect(lines[0]).toMatchObject({ price: 75 });
    expect(await StorefrontCatalog.productsByIds([])).toEqual([]);
  });

  it('lists related products from the same category, not the product itself', async () => {
    const group = await category('Related');
    const a = await product('Rel a', { categoryId: group.id, categoryName: group.name });
    const b = await product('Rel b', { categoryId: group.id, categoryName: group.name });
    await product('Rel hidden', { categoryId: group.id, categoryName: group.name, isActive: false });
    const related = await StorefrontCatalog.related({ id: a });
    expect(related.map((p) => p.id)).toEqual([b]);
    expect(await StorefrontCatalog.related({ id: await product('Rel none') })).toEqual([]);
  });

  it('finds a product by its readable address or its id, only while it is for sale', async () => {
    const { CatalogService } = await import('./service');
    const id = await product('By key');
    const hidden = await product('By key hidden', { isActive: false });
    const row = nth(await db.select().from(schema.products).where(eq(schema.products.id, id)), 0);
    const hiddenRow = nth(await db.select().from(schema.products).where(eq(schema.products.id, hidden)), 0);
    expect((await CatalogService.getPublicProductByKey(row.slug))?.id).toBe(id);
    expect((await CatalogService.getPublicProductByKey(id))?.id).toBe(id);
    expect(await CatalogService.getPublicProductByKey(hiddenRow.slug)).toBeUndefined();
    expect(await CatalogService.getPublicProductByKey(hidden)).toBeUndefined();
    expect(await CatalogService.getPublicProductByKey('no-such-product')).toBeUndefined();
    expect(await CatalogService.getPublicProductByKey(row.slug)).not.toHaveProperty('costPrice');
  });

  it('uses the shop indexes for the first page of each order', async () => {
    await db.execute(sql.raw('analyze products')); // the planner needs to know the table has rows by now
    const plan = async (order: string) =>
      JSON.stringify(
        await db.execute(sql.raw(`explain select id from products where is_active and is_sellable and deleted_at is null order by ${order} limit 25`)),
      );
    expect(await plan('name, id')).toContain('products_shop_name_idx');
    expect(await plan('coalesce(price, 0), id')).toContain('products_shop_price_idx');
    expect(await plan('created_at desc, id desc')).toContain('products_shop_newest_idx');
  });
});
