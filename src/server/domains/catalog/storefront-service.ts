import { getContainer } from '@/server/di/container';
import type { PublicProduct } from '@/types/index';
import { STOREFRONT_PAGE_SIZE, type StorefrontCategory, type StorefrontPage, type StorefrontQuery } from '@/lib/storefront-search';
import { descendantsOf } from './category-tree';
import { toPublicProduct, toProduct } from './mappers';
import { withShopPrices } from './shop-prices';
import { withShopAvailability } from './shop-availability';

/** The most lines a cart check or a related list will look at. */
export const MAX_CART_LOOKUP = 100;
export const SITEMAP_LIMIT = 50_000;

const repo = () => getContainer().catalog;

/** Everything the public shop reads from the catalog. Nothing here needs a signed-in person. */
export const StorefrontCatalog = {
  /** Categories that have something to buy, in display order with their sub-categories under them. */
  async categories(): Promise<StorefrontCategory[]> {
    const rows = await repo().listShopCategories();
    const parents = new Map<string, string | null>(rows.map((row) => [row.id, row.parentId]));
    const direct = new Map(rows.map((row) => [row.id, row.direct]));
    const total = (id: string) => descendantsOf(id, parents).reduce((sum, at) => sum + (direct.get(at) ?? 0), 0);

    const childrenOf = new Map<string | null, typeof rows>();
    for (const row of rows) {
      // A sub-category whose parent is inactive is not reachable from the top, so it is not listed.
      const key = row.parentId !== null && !parents.has(row.parentId) ? '\u0000orphan' : row.parentId;
      childrenOf.set(key, [...(childrenOf.get(key) ?? []), row]);
    }
    const out: StorefrontCategory[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const row of childrenOf.get(parentId) ?? []) {
        const count = total(row.id);
        if (count === 0) continue;
        out.push({ id: row.id, name: row.name, slug: row.slug, parentId: row.parentId, imageUrl: row.imageUrl, count, depth });
        walk(row.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  },

  /** One page of live products for what the shopper asked for. */
  async search(query: StorefrontQuery, categories?: StorefrontCategory[]): Promise<StorefrontPage<PublicProduct>> {
    let categoryIds: string[] | null = null;
    let category: StorefrontCategory | null = null;
    if (query.category !== '') {
      const list = categories ?? (await StorefrontCatalog.categories());
      category = list.find((item) => item.slug === query.category) ?? null;
      const parents = new Map<string, string | null>(list.map((item) => [item.id, item.parentId]));
      // An unknown or empty category is an empty shop page, never "everything".
      categoryIds = category === null ? [] : descendantsOf(category.id, parents);
    }
    const page = await repo().searchStorefront(query, categoryIds, STOREFRONT_PAGE_SIZE);
    return {
      products: await withShopPrices(await withShopAvailability(page.rows.map((row) => toPublicProduct(toProduct(row))))),
      nextCursor: page.nextCursor,
      total: page.total,
      category,
    };
  },

  priceRange(): Promise<{ min: number; max: number } | null> {
    return repo().shopPriceRange();
  },

  /** The current state of these products as the shop would sell them now; sold-out and withdrawn ones are simply absent from the page they ask for. */
  async productsByIds(ids: string[], quantities: ReadonlyMap<string, number> = new Map()): Promise<PublicProduct[]> {
    const unique = [...new Set(ids)].slice(0, MAX_CART_LOOKUP);
    const rows = await repo().listLiveProductsByIds(unique);
    return await withShopPrices(await withShopAvailability(rows.map((row) => toPublicProduct(toProduct(row)))), quantities);
  },

  async related(product: Pick<PublicProduct, 'id'>, limit = 4): Promise<PublicProduct[]> {
    const row = await repo().getProductById(product.id);
    if (row?.categoryId == null) return [];
    const rows = await repo().listRelatedLive(product.id, row.categoryId, limit);
    return await withShopPrices(await withShopAvailability(rows.map((item) => toPublicProduct(toProduct(item)))));
  },

  sitemapProducts(): Promise<{ id: string; slug: string; updatedAt: Date; imageUrl: string }[]> {
    return repo().listLiveForSitemap(SITEMAP_LIMIT);
  },
};
