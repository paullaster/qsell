'use server';

import type { PublicProduct } from '@/types/index';
import { parseStorefrontQuery, type StorefrontCategory, type StorefrontPage, type SearchParamsInput } from '@/lib/storefront-search';
import { MAX_CART_LOOKUP, StorefrontCatalog } from './storefront-service';

/** Reads a plain object of text values from the browser; anything else is treated as an empty request. */
function searchParamsOf(raw: unknown): SearchParamsInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: SearchParamsInput = {};
  for (const [key, value] of Object.entries(raw).slice(0, 20)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Public: one page of the shop for a filter, so the browser can load "more" without leaving the page. */
export async function searchStorefrontAction(raw: unknown): Promise<StorefrontPage<PublicProduct>> {
  return await StorefrontCatalog.search(parseStorefrontQuery(searchParamsOf(raw)));
}

/** Public: the categories that have something to buy. */
export async function storefrontCategoriesAction(): Promise<StorefrontCategory[]> {
  return await StorefrontCatalog.categories();
}

/** Public: the current price and stock of these products (a cart, recently viewed). Products no longer for sale are left out. */
export async function productsByIdsAction(raw: unknown): Promise<PublicProduct[]> {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100).slice(0, MAX_CART_LOOKUP);
  return await StorefrontCatalog.productsByIds(ids);
}
