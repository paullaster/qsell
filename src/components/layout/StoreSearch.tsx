'use client';

import { useEffect, useRef, useState } from 'react';
import Form from 'next/form';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { parseStorefrontQuery, storefrontHref } from '@/lib/storefront-search';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';

/**
 * The search box in the header. It is a real form (it works before the page is wired up and with no
 * script at all), and on the shop page it also searches as you type, a moment after you stop.
 */
export function StoreSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = parseStorefrontQuery(Object.fromEntries(params.entries()));
  const [text, setText] = useState(current.q);
  const debounced = useDebouncedValue(text, 400);
  const input = useRef<HTMLInputElement>(null);

  // Typing in the box searches, a moment after the last key.
  useEffect(() => {
    const typed = debounced.trim();
    if (pathname !== '/' || typed === current.q) return;
    router.replace(storefrontHref({ ...current, q: typed, cursor: null }), { scroll: false });
    // Only a change of the typed text should search; `current` is read for the other filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // A change of address made some other way (a link, Back) shows in the box, unless the person is typing in it.
  useEffect(() => {
    if (document.activeElement !== input.current) {
      setText(current.q);
    }
  }, [current.q]);

  return (
    <Form action="/" role="search" className="relative w-full">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle sm:left-3.5" aria-hidden />
      <input
        ref={input}
        type="text"
        name="q"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search products"
        aria-label="Search products, brands, or SKU"
        autoComplete="off"
        enterKeyHint="search"
        maxLength={100}
        className="h-11 w-full rounded-xl border border-line bg-surface-raised py-2 pr-11 pl-9 text-sm text-fg-strong placeholder-fg-subtle transition-all focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none sm:pl-10"
      />
      {text === '' ? null : (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setText('')}
          className="absolute top-1/2 right-1 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-fg-muted hover:text-fg-strong"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </Form>
  );
}
