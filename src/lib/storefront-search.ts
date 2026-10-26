import { has } from '@/lib/values';

/** How many products the shop shows at a time. */
export const STOREFRONT_PAGE_SIZE = 24;

export const STOREFRONT_SORTS = ['name', 'price_asc', 'price_desc', 'newest'] as const;
export type StorefrontSort = (typeof STOREFRONT_SORTS)[number];

export const STOREFRONT_SORT_LABELS: Record<StorefrontSort, string> = {
  name: 'Name: A to Z',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  newest: 'Newest first',
};

/** What a shopper asked to see. Every field is already cleaned: it is safe to hand to the database layer. */
export interface StorefrontQuery {
  /** Words typed in the search box. */
  q: string;
  /** A category's address (slug); its sub-categories are included. Empty for all. */
  category: string;
  minPrice: number | null;
  maxPrice: number | null;
  inStock: boolean;
  sort: StorefrontSort;
  /** Where the next page begins. */
  cursor: string | null;
}

export const DEFAULT_STOREFRONT_QUERY: StorefrontQuery = {
  q: '',
  category: '',
  minPrice: null,
  maxPrice: null,
  inStock: false,
  sort: 'name',
  cursor: null,
};

export type SearchParamsInput = Record<string, string | string[] | undefined>;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const MAX_QUERY_LENGTH = 100;
const MAX_PRICE = 1_000_000_000;
const MAX_CURSOR_LENGTH = 600;

const single = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));

/** Text from the address bar with control characters removed, trimmed and cut to length. */
function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- the point is to strip them
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function priceOf(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_PRICE) return null;
  return Math.round(parsed * 100) / 100;
}

/**
 * Reads the shop's address (`?q=…&category=…`) into a query. Anything that does not make sense is
 * dropped rather than rejected: a shopper with an old or hand-edited link still gets a page.
 */
export function parseStorefrontQuery(params: SearchParamsInput): StorefrontQuery {
  const category = single(params.category).trim().toLowerCase();
  const sort = single(params.sort);
  let minPrice = priceOf(single(params.min));
  let maxPrice = priceOf(single(params.max));
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  const cursor = single(params.cursor);
  return {
    q: cleanText(single(params.q), MAX_QUERY_LENGTH),
    category: SLUG.test(category) ? category : '',
    minPrice,
    maxPrice,
    inStock: single(params.stock) === '1',
    sort: STOREFRONT_SORTS.find((s) => s === sort) ?? DEFAULT_STOREFRONT_QUERY.sort,
    cursor: has(cursor) && cursor.length <= MAX_CURSOR_LENGTH ? cursor : null,
  };
}

/** The address-bar text (without `?`) for a query. Defaults are left out so addresses stay short and stable. */
export function storefrontQueryString(query: Partial<StorefrontQuery>): string {
  const params = new URLSearchParams();
  if (has(query.q)) params.set('q', query.q);
  if (has(query.category)) params.set('category', query.category);
  if (query.minPrice !== null && query.minPrice !== undefined) params.set('min', String(query.minPrice));
  if (query.maxPrice !== null && query.maxPrice !== undefined) params.set('max', String(query.maxPrice));
  if (query.inStock === true) params.set('stock', '1');
  if (query.sort !== undefined && query.sort !== DEFAULT_STOREFRONT_QUERY.sort) params.set('sort', query.sort);
  if (has(query.cursor)) params.set('cursor', query.cursor);
  return params.toString();
}

/** The shop's address for a query: `/` or `/?q=…`. Changing any filter starts again at the first page. */
export function storefrontHref(query: Partial<StorefrontQuery>): string {
  const text = storefrontQueryString(query);
  return text === '' ? '/' : `/?${text}`;
}

/** True when any filter or search text is set (paging and sorting alone do not count). */
export function hasStorefrontFilters(query: StorefrontQuery): boolean {
  return has(query.q) || has(query.category) || query.minPrice !== null || query.maxPrice !== null || query.inStock;
}

/** A category as the shop lists it: only those with something to buy, counts include sub-categories. */
export interface StorefrontCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  imageUrl: string | null;
  /** Live products in this category and everything under it. */
  count: number;
  /** 0 for a top-level category. */
  depth: number;
}

/** One page of the shop. */
export interface StorefrontPage<Product> {
  products: Product[];
  nextCursor: string | null;
  /** Products matching in all, not just on this page. */
  total: number;
  /** The category asked for, when it exists and has been shown. */
  category: StorefrontCategory | null;
}
