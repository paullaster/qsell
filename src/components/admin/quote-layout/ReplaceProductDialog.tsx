'use client';

import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, ShoppingCart } from 'lucide-react';
import { AppImage } from '@/components/ui/AppImage';
import { Modal } from '@/components/ui/Modal';
import { isInventoryManaged } from '@/lib/inventory-kind';
import { searchCatalogue, type CatalogueIndexEntry, type CatalogueProduct } from '@/lib/catalogue-entry';

/** Rows drawn at once; the rest come with "Show more". */
const PAGE = 30;

const money = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the result count says: nothing found (and for what), or how many. */
function countText(count: number, typed: string): string {
  if (count > 0) return `${count.toLocaleString()} ${count === 1 ? 'product' : 'products'}${typed === '' ? '' : ' match'}.`;
  return typed === '' ? 'There are no other available products.' : `No available product matches “${typed}”.`;
}

/**
 * Chooses the product that takes the place of one on a quote line. One click (or Enter) on a result does it: no quantity, price or
 * discount to type here, because the line keeps its quantity and discount and is priced again for the new item.
 *
 * Keyboard: the search has focus on open; Arrow keys move through the results, Enter chooses, Escape closes.
 */
export function ReplaceProductDialog({
  index,
  currency,
  current,
  onHere,
  onChoose,
  onClose,
}: {
  /** The sellable catalogue, from `buildCatalogueIndex`. */
  index: CatalogueIndexEntry[];
  currency: string;
  /** The item being replaced. */
  current: { id: string; name: string };
  /** How much of a product this quote already holds, or null. */
  onHere: (productId: string) => number | null;
  onChoose: (product: CatalogueProduct) => void;
  onClose: () => void;
}) {
  const uid = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(search);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const matches = useMemo(() => searchCatalogue(index, deferred).filter((e) => e.product.id !== current.id), [index, deferred, current.id]);
  const visible = matches.slice(0, shown);
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0));
  const optionId = (i: number) => `${uid}-opt-${String(i)}`;

  return (
    <Modal title={`Replace ${current.name}`} onClose={onClose}>
      <p className="mb-3 text-sm text-fg-muted">
        Choose the item that takes its place. The line keeps its place, quantity and discount; the price comes from the price lists for the new item.
      </p>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-faint" aria-hidden />
        <input
          ref={searchRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-autocomplete="list"
          aria-activedescendant={visible.length > 0 ? optionId(activeIndex) : undefined}
          aria-label="Search products by name, SKU, stock code, brand or category"
          autoComplete="off"
          value={search}
          placeholder="Search name, SKU, brand…"
          onChange={(event) => {
            setSearch(event.target.value);
            setShown(PAGE);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive(Math.min(activeIndex + 1, visible.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive(Math.max(activeIndex - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const pick = visible[activeIndex];
              if (pick !== undefined) onChoose(pick.product);
            }
          }}
          className="min-h-10 w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
        />
      </div>
      <p className="mt-2 text-xs text-fg-muted" role="status" aria-live="polite">
        {countText(matches.length, deferred.trim())}
      </p>
      <ul id={`${uid}-list`} role="listbox" aria-label="Products to replace it with" className="mt-2 max-h-[55dvh] space-y-2 overflow-y-auto">
        {visible.map(({ product }, i) => {
          const here = onHere(product.id);
          return (
            <li
              key={product.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActive(i)}
              className={`rounded-xl border ${i === activeIndex ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40' : 'border-line bg-surface'}`}
            >
              <button type="button" tabIndex={-1} onClick={() => onChoose(product)} className="flex min-h-14 w-full cursor-pointer items-center gap-3 p-3 text-left">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-sunken">
                  {product.imageUrl !== '' ? (
                    <AppImage src={product.imageUrl} alt="" width={48} height={48} className="h-full w-full object-cover" />
                  ) : (
                    <ShoppingCart className="h-5 w-5 text-fg-faint" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold break-words text-fg-strong">{product.name}</span>
                  <span className="block text-xs text-fg-muted">{product.sku} · {product.category}</span>
                  <span className="block text-xs text-fg-muted">
                    <span className="font-mono font-semibold text-fg-strong">{product.price == null ? 'No catalogue price' : money(product.price, currency)}</span>
                    {' · '}
                    {isInventoryManaged(product) ? `${String(product.stockQuantity - product.reservedQuantity)} available` : 'Not stock-tracked'}
                  </span>
                  {here !== null ? (
                    <span className="mt-1 inline-flex rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                      Already on this quote: {here}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {matches.length > visible.length ? (
        <button type="button" onClick={() => setShown(shown + PAGE)} className="mt-2 min-h-10 w-full cursor-pointer rounded-lg border border-line px-3 text-sm font-medium text-indigo-600 hover:bg-surface-sunken">
          Show more ({matches.length - visible.length} more)
        </button>
      ) : null}
    </Modal>
  );
}
