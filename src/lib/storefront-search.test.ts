import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STOREFRONT_QUERY,
  hasStorefrontFilters,
  parseStorefrontQuery,
  storefrontHref,
  storefrontQueryString,
} from './storefront-search';

describe('parseStorefrontQuery', () => {
  it('gives the defaults for an empty address', () => {
    expect(parseStorefrontQuery({})).toEqual(DEFAULT_STOREFRONT_QUERY);
  });

  it('reads every filter', () => {
    expect(
      parseStorefrontQuery({
        q: ' fish ',
        category: 'Fresh-Fish',
        min: '10',
        max: '99.456',
        stock: '1',
        sort: 'price_desc',
        cursor: 'abc',
      }),
    ).toEqual({
      q: 'fish',
      category: 'fresh-fish',
      minPrice: 10,
      maxPrice: 99.46,
      inStock: true,
      sort: 'price_desc',
      cursor: 'abc',
    });
  });

  it('drops what does not make sense instead of failing', () => {
    const query = parseStorefrontQuery({
      category: '../etc',
      min: '-5',
      max: 'lots',
      stock: 'yes',
      sort: 'rating; drop table',
      cursor: 'x'.repeat(601),
    });
    expect(query).toEqual(DEFAULT_STOREFRONT_QUERY);
  });

  it('accepts a slug with an underscore', () => {
    expect(parseStorefrontQuery({ category: 'cat_e2e_1' }).category).toBe('cat_e2e_1');
  });

  it('swaps a minimum above the maximum', () => {
    const query = parseStorefrontQuery({ min: '50', max: '10' });
    expect([query.minPrice, query.maxPrice]).toEqual([10, 50]);
  });

  it('takes the first of a repeated value and strips control characters from the search', () => {
    const query = parseStorefrontQuery({ q: ['a\u0000b', 'c'], sort: ['newest', 'name'] });
    expect(query.q).toBe('a b');
    expect(query.sort).toBe('newest');
  });

  it('cuts a long search to 100 characters', () => {
    expect(parseStorefrontQuery({ q: 'a'.repeat(300) }).q).toHaveLength(100);
  });
});

describe('storefrontQueryString / storefrontHref', () => {
  it('leaves defaults out', () => {
    expect(storefrontQueryString(DEFAULT_STOREFRONT_QUERY)).toBe('');
    expect(storefrontHref(DEFAULT_STOREFRONT_QUERY)).toBe('/');
  });

  it('round-trips a query', () => {
    const query = { ...DEFAULT_STOREFRONT_QUERY, q: 'red shoes', category: 'shoes', minPrice: 5, inStock: true, sort: 'newest' as const };
    const text = storefrontQueryString(query);
    expect(parseStorefrontQuery(Object.fromEntries(new URLSearchParams(text)))).toEqual(query);
    expect(storefrontHref(query)).toBe(`/?${text}`);
  });
});

describe('hasStorefrontFilters', () => {
  it('ignores sorting and paging', () => {
    expect(hasStorefrontFilters({ ...DEFAULT_STOREFRONT_QUERY, sort: 'newest', cursor: 'c' })).toBe(false);
  });
  it('is true for any filter', () => {
    expect(hasStorefrontFilters({ ...DEFAULT_STOREFRONT_QUERY, inStock: true })).toBe(true);
    expect(hasStorefrontFilters({ ...DEFAULT_STOREFRONT_QUERY, maxPrice: 0 })).toBe(true);
  });
});
