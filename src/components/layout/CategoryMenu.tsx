'use client';

import { useCallback, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, LayoutGrid } from 'lucide-react';
import { storefrontHref, type StorefrontCategory } from '@/lib/storefront-search';
import { useDismiss } from '@/components/ui/useDismiss';

/** "Shop by category": one button that opens the list, sub-categories indented under their parents. */
export function CategoryMenu({ categories }: { categories: StorefrontCategory[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close);
  if (categories.length === 0) return null;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 cursor-pointer touch-manipulation items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 text-sm font-medium text-fg hover:border-line-strong hover:bg-hover"
      >
        <LayoutGrid className="h-4 w-4 text-indigo-500" aria-hidden />
        <span>Categories</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open ? (
        <nav id={panel} aria-label="Shop by category" className="absolute left-0 z-50 mt-2 max-h-[70dvh] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-line bg-surface-raised p-1 shadow-xl">
          <Link href={storefrontHref({})} onClick={close} className="flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-fg-strong hover:bg-hover">
            All products
          </Link>
          {categories.map((category) => (
            <Link
              key={category.id}
              href={storefrontHref({ category: category.slug })}
              onClick={close}
              style={{ paddingInlineStart: `${String(0.75 + category.depth)}rem` }}
              className="flex min-h-11 items-center justify-between gap-3 rounded-lg pe-3 text-sm text-fg hover:bg-hover"
            >
              <span className="min-w-0 truncate">{category.name}</span>
              <span className="shrink-0 text-xs text-fg-muted">{category.count}</span>
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
