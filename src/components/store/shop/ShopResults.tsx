'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { Loader2, PackageSearch } from 'lucide-react';
import type { PublicProduct } from '@/types/index';
import { productGridClassName } from '@/config/company-ui';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';
import { ProductCard } from '@/components/store/ProductCard';
import { searchStorefrontAction } from '@/server/domains/catalog/storefront-actions';
import { hasStorefrontFilters, storefrontHref, storefrontQueryString, type StorefrontPage, type StorefrontQuery } from '@/lib/storefront-search';

/**
 * The products of a search, a page at a time. More are loaded onto the end of the list without leaving the page;
 * the "show more" button is also a real link to the next page, so it works for a search engine or with no script.
 */
export function ShopResults({ pagePromise, query }: { pagePromise: Promise<StorefrontPage<PublicProduct>>; query: StorefrontQuery }) {
  const first = use(pagePromise);
  const { productGrid } = useCompanyUiConfig();
  const [more, setMore] = useState<PublicProduct[]>([]);
  // Until more are loaded, the next page is the one the server said; after, the one the last load said.
  const [loadedCursor, setLoadedCursor] = useState<string | null | undefined>(undefined);
  const nextCursor = loadedCursor === undefined ? first.nextCursor : loadedCursor;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const products = [...first.products, ...more.filter((item) => !first.products.some((seen) => seen.id === item.id))];

  const showMore = async () => {
    if (nextCursor === null || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const params = Object.fromEntries(new URLSearchParams(storefrontQueryString({ ...query, cursor: nextCursor })));
      const page = await searchStorefrontAction(params);
      setMore((current) => [...current, ...page.products]);
      setLoadedCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  if (products.length === 0) {
    return (
      <div className="space-y-3 rounded-xl border border-line bg-surface-raised p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-surface-sunken text-fg-muted">
          <PackageSearch className="h-6 w-6" aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold text-fg-strong">No products found</h2>
        <p className="mx-auto max-w-sm text-sm text-fg-muted">
          {hasStorefrontFilters(query) ? 'Nothing matches what you chose. Try fewer filters or different words.' : 'There is nothing for sale yet. Please check back soon.'}
        </p>
        {hasStorefrontFilters(query) ? (
          <Link href={storefrontHref({})} className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500">
            Clear search and filters
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ul className={productGridClassName(productGrid.desktopColumns)} aria-label="Products">
        {products.map((product, index) => (
          <li key={product.id} className="contents">
            <ProductCard product={product} preloadImage={index < 4} />
          </li>
        ))}
      </ul>
      <div className="flex flex-col items-center gap-2">
        <p role="status" className="text-sm text-fg-muted">
          Showing {products.length} of {first.total}
        </p>
        {failed ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">Could not load more products. Please try again.</p> : null}
        {nextCursor === null ? null : (
          <Link
            href={storefrontHref({ ...query, cursor: nextCursor })}
            rel="next"
            scroll={false}
            onClick={(event) => {
              event.preventDefault();
              void showMore();
            }}
            aria-disabled={loading}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface-raised px-6 text-sm font-semibold text-fg-strong hover:bg-hover"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {loading ? 'Loading…' : 'Show more products'}
          </Link>
        )}
      </div>
    </div>
  );
}
