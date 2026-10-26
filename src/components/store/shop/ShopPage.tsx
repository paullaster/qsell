'use client';

import { Suspense, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import type { PublicProduct } from '@/types/index';
import { SkeletonGrid } from '@/components/ui/Skeletons';
import { useStore } from '@/components/store/StoreContext';
import { ShopFilters } from '@/components/store/shop/ShopFilters';
import { ShopResults } from '@/components/store/shop/ShopResults';
import { ShopSort } from '@/components/store/shop/ShopSort';
import { hasStorefrontFilters, storefrontHref, storefrontQueryString, type StorefrontPage, type StorefrontQuery } from '@/lib/storefront-search';

interface ShopPageProps {
  queryPromise: Promise<StorefrontQuery>;
  pagePromise: Promise<StorefrontPage<PublicProduct>>;
  priceRangePromise: Promise<{ min: number; max: number } | null>;
}

/** What is being shown, in words, for the heading: the category, the search, or everything. */
function headingFor(query: StorefrontQuery, categoryName: string | null): string {
  if (query.q !== '') return `Results for “${query.q}”`;
  return categoryName ?? 'All products';
}

function Chip({ href, children }: { href: string; children: string }) {
  return (
    <li>
      <Link href={href} className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface-raised px-3 text-sm text-fg hover:bg-hover">
        {children}
        <X className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">Remove this filter</span>
      </Link>
    </li>
  );
}

function Toolbar({ query, pagePromise }: { query: StorefrontQuery; pagePromise: ShopPageProps['pagePromise'] }) {
  const router = useRouter();
  const page = use(pagePromise);
  const { money } = useStore();
  const go = (change: Partial<StorefrontQuery>) => router.push(storefrontHref({ ...query, ...change, cursor: null }), { scroll: false });
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p role="status" className="text-sm text-fg-muted">
          {page.total} {page.total === 1 ? 'product' : 'products'}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={query.inStock} onChange={(event) => go({ inStock: event.target.checked })} className="h-5 w-5 rounded border-line accent-indigo-600" />
            In stock only
          </label>
          <ShopSort value={query.sort} onChange={(sort) => go({ sort })} />
        </div>
      </div>
      {hasStorefrontFilters(query) ? (
        <ul aria-label="Active filters" className="flex flex-wrap items-center gap-2">
          {query.q === '' ? null : <Chip href={storefrontHref({ ...query, q: '', cursor: null })}>{`Search: ${query.q}`}</Chip>}
          {page.category === null ? null : <Chip href={storefrontHref({ ...query, category: '', cursor: null })}>{page.category.name}</Chip>}
          {query.minPrice === null ? null : <Chip href={storefrontHref({ ...query, minPrice: null, cursor: null })}>{`From ${money(query.minPrice)}`}</Chip>}
          {query.maxPrice === null ? null : <Chip href={storefrontHref({ ...query, maxPrice: null, cursor: null })}>{`Up to ${money(query.maxPrice)}`}</Chip>}
          {query.inStock ? <Chip href={storefrontHref({ ...query, inStock: false, cursor: null })}>In stock only</Chip> : null}
          <li>
            <Link href={storefrontHref({ sort: query.sort })} className="inline-flex min-h-9 items-center px-2 text-sm text-fg-muted underline hover:text-fg-strong">
              Clear all
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

export function ShopPage({ queryPromise, pagePromise, priceRangePromise }: ShopPageProps) {
  const query = use(queryPromise);
  const { categories } = useStore();
  const range = use(priceRangePromise);
  const category = categories.find((item) => item.slug === query.category) ?? null;
  return (
    <div className="space-y-4 pb-16 min-[1000px]:flex min-[1000px]:items-start min-[1000px]:gap-6 min-[1000px]:space-y-0">
      <ShopFilters query={query} categories={categories} range={range} />
      <div className="min-w-0 flex-1 space-y-4">
        <h1 className="text-2xl font-bold tracking-tight text-fg-strong sm:text-3xl">{headingFor(query, category?.name ?? null)}</h1>
        <Suspense fallback={<SkeletonGrid count={8} />}>
          <Toolbar query={query} pagePromise={pagePromise} />
          <ShopResults key={storefrontQueryString(query)} pagePromise={pagePromise} query={query} />
        </Suspense>
      </div>
    </div>
  );
}
