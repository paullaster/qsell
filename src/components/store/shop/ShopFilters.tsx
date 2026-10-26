'use client';

import { useId, useState } from 'react';
import Form from 'next/form';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { hasStorefrontFilters, storefrontHref, type StorefrontCategory, type StorefrontQuery } from '@/lib/storefront-search';
import { useStore } from '@/components/store/StoreContext';

const inputClass =
  'h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';

function CategoryLinks({ categories, query }: { categories: StorefrontCategory[]; query: StorefrontQuery }) {
  // Changing the category keeps the search and other filters, and starts again at the first page.
  const hrefFor = (slug: string) => storefrontHref({ ...query, category: slug, cursor: null });
  const linkClass = (active: boolean) =>
    `flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 text-sm transition-colors ${active ? 'bg-indigo-600 font-semibold text-white' : 'text-fg hover:bg-hover hover:text-fg-strong'}`;
  return (
    <ul className="space-y-0.5">
      <li>
        <Link href={hrefFor('')} aria-current={query.category === '' ? 'page' : undefined} className={linkClass(query.category === '')}>
          All products
        </Link>
      </li>
      {categories.map((category) => (
        <li key={category.id}>
          <Link
            href={hrefFor(category.slug)}
            aria-current={query.category === category.slug ? 'page' : undefined}
            style={{ paddingInlineStart: `${String(0.75 + category.depth)}rem` }}
            className={linkClass(query.category === category.slug)}
          >
            <span className="min-w-0 truncate">{category.name}</span>
            <span className={`shrink-0 text-xs ${query.category === category.slug ? 'text-white/80' : 'text-fg-muted'}`}>{category.count}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** What was typed in a form field, trimmed; nothing for a field that is not text. */
function fieldText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function PriceForm({ query, range }: { query: StorefrontQuery; range: { min: number; max: number } | null }) {
  const id = useId();
  const { currency } = useStore();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <Form
      action="/"
      className="space-y-2"
      onSubmit={(event) => {
        // Checked here for convenience; the address is parsed again on the server.
        const data = new FormData(event.currentTarget);
        const min = fieldText(data, 'min');
        const max = fieldText(data, 'max');
        const bad = [min, max].some((value) => value !== '' && !(Number(value) >= 0));
        if (bad) {
          event.preventDefault();
          setError('Enter prices as numbers, such as 500.');
          return;
        }
        setError(null);
      }}
    >
      {query.q === '' ? null : <input type="hidden" name="q" value={query.q} />}
      {query.category === '' ? null : <input type="hidden" name="category" value={query.category} />}
      {query.inStock ? <input type="hidden" name="stock" value="1" /> : null}
      {query.sort === 'name' ? null : <input type="hidden" name="sort" value={query.sort} />}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${id}-min`} className="mb-1 block text-xs font-semibold text-fg-muted">Lowest price</label>
          <input id={`${id}-min`} name="min" inputMode="decimal" defaultValue={query.minPrice ?? ''} placeholder={range === null ? '0' : String(Math.floor(range.min))} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`${id}-max`} className="mb-1 block text-xs font-semibold text-fg-muted">Highest price</label>
          <input id={`${id}-max`} name="max" inputMode="decimal" defaultValue={query.maxPrice ?? ''} placeholder={range === null ? '' : String(Math.ceil(range.max))} className={inputClass} />
        </div>
      </div>
      {error === null ? null : <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="min-h-11 flex-1 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 text-sm font-semibold text-fg-strong hover:bg-hover">
          Apply{currency === null ? '' : ` (${currency.code})`}
        </button>
        {query.minPrice !== null || query.maxPrice !== null ? (
          <button type="button" onClick={() => router.push(storefrontHref({ ...query, minPrice: null, maxPrice: null, cursor: null }))} className="min-h-11 cursor-pointer rounded-lg px-3 text-sm text-fg-muted underline hover:text-fg-strong">
            Clear
          </button>
        ) : null}
      </div>
    </Form>
  );
}

/** The side panel: categories and price. On a phone it folds into one "Filters" button. */
export function ShopFilters({ query, categories, range }: { query: StorefrontQuery; categories: StorefrontCategory[]; range: { min: number; max: number } | null }) {
  const panel = (
    <div className="space-y-6">
      {categories.length > 0 ? (
        <nav aria-label="Categories">
          <h2 className="mb-2 px-1 text-xs font-bold tracking-wider text-fg-subtle uppercase">Categories</h2>
          <CategoryLinks categories={categories} query={query} />
        </nav>
      ) : null}
      <section aria-label="Price">
        <h2 className="mb-2 px-1 text-xs font-bold tracking-wider text-fg-subtle uppercase">Price</h2>
        <PriceForm query={query} range={range} />
      </section>
    </div>
  );
  return (
    <>
      <details className="rounded-xl border border-line bg-surface-raised min-[1000px]:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-semibold text-fg-strong">
          Filters{hasStorefrontFilters(query) ? ' (on)' : ''}
        </summary>
        <div className="border-t border-line p-3">{panel}</div>
      </details>
      <aside className="sticky top-24 hidden w-56 shrink-0 self-start rounded-xl border border-line bg-surface-raised p-3 min-[1000px]:block lg:w-60">{panel}</aside>
    </>
  );
}
