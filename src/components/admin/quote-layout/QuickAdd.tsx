'use client';

import { useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { QuantityInput } from './QuantityInput';
import type { CatalogueEntry } from '@/lib/quote-layout';
import {
  blankDraft,
  readDraft,
  searchCatalogue,
  type CatalogueIndexEntry,
  type CatalogueProduct,
  type Draft,
} from '@/lib/catalogue-entry';

/** Results listed under the box. More come by typing more. */
const RESULTS = 8;

const money = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const field =
  'mt-1 block min-h-10 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500';

/**
 * Adds an item to one place without opening the catalogue: type a name or code, pick a result
 * (Enter takes the first), set the quantity, price and discount, press Enter. Focus then returns
 * to the search so the next item can follow at once, which suits a long list or a barcode scanner.
 */
export function QuickAdd({
  index,
  currency,
  destination,
  countHere,
  quantityHere,
  onAdd,
}: {
  index: CatalogueIndexEntry[];
  currency: string;
  /** The place, in words. */
  destination: string;
  /** How many lines the place holds. */
  countHere: () => number;
  /** How much of the product the place already holds, or null. */
  quantityHere: (productId: string) => number | null;
  onAdd: (entry: Omit<CatalogueEntry, 'sectionId'>) => void;
}) {
  const uid = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<CatalogueProduct | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const deferred = useDeferredValue(query);

  const found = useMemo(
    () => (deferred.trim() ? searchCatalogue(index, deferred) : []),
    [index, deferred],
  );
  const results = found.slice(0, RESULTS);
  const listing = open && !chosen && query.trim() !== '';

  const choose = (product: CatalogueProduct) => {
    setChosen(product);
    setQuery(product.name);
    setOpen(false);
    setError(null);
    setDraft(blankDraft);
    // The quantity is what usually comes next.
    requestAnimationFrame(() => {
      qtyRef.current?.focus();
      qtyRef.current?.select();
    });
  };

  const add = () => {
    if (!chosen) {
      setError('Pick an item first: type a name or code and choose a result.');
      searchRef.current?.focus();
      return;
    }
    const result = readDraft(draft, chosen);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onAdd(result.entry);
    setSaid(
      `${result.entry.quantity} × ${chosen.name} added to ${destination}. It now has ${countHere() + 1} lines.`,
    );
    setChosen(null);
    setQuery('');
    setDraft(blankDraft);
    setError(null);
    searchRef.current?.focus();
  };

  const onEnter = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  };

  const optionId = (i: number) => `${uid}-opt-${i}`;

  return (
    <div className="space-y-2 border-b border-line bg-surface p-3">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_8.5rem_7rem_5.5rem_auto] md:items-end">
        <label className="text-xs font-medium text-fg">
          Quick add to {destination}
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded={listing}
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            aria-activedescendant={listing && results[active] ? optionId(active) : undefined}
            autoComplete="off"
            value={query}
            placeholder="Type a name or code, e.g. PAN-550"
            onChange={(event) => {
              setQuery(event.target.value);
              setChosen(null);
              setOpen(true);
              setActive(0);
              setError(null);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && results.length > 0) {
                event.preventDefault();
                setOpen(true);
                setActive((current) => Math.min(current + 1, results.length - 1));
              } else if (event.key === 'ArrowUp' && results.length > 0) {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              } else if (event.key === 'Escape' && listing) {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const pick = results[active]?.product;
                if (listing && pick) choose(pick);
                else if (chosen) add();
              }
            }}
            className={field}
          />
        </label>
        <div className="text-xs font-medium text-fg">
          Qty
          <div className="mt-1">
            <QuantityInput
              inputRef={qtyRef}
              label={chosen ? `Quantity of ${chosen.name}` : 'Quantity'}
              value={draft.quantity}
              onChange={(value) => setDraft({ ...draft, quantity: value })}
              onKeyDown={onEnter}
            />
          </div>
        </div>
        <label className="text-xs font-medium text-fg">
          Price
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={draft.price}
            placeholder={chosen?.price == null ? '' : String(chosen.price)}
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            onKeyDown={onEnter}
            className={field}
          />
        </label>
        <label className="text-xs font-medium text-fg">
          Disc %
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="0.1"
            value={draft.discount}
            placeholder="0"
            onChange={(e) => setDraft({ ...draft, discount: e.target.value })}
            onKeyDown={onEnter}
            className={field}
          />
        </label>
        <button
          type="button"
          onClick={add}
          className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        >
          <Plus className="h-4 w-4" aria-hidden /> Add
        </button>
      </div>

      {listing && (
        <div>
          <ul
            id={`${uid}-list`}
            role="listbox"
            aria-label="Matching products"
            className="max-h-64 overflow-y-auto rounded-lg border border-line bg-surface-raised"
          >
            {results.length === 0 ? (
              <li role="presentation" className="p-3 text-sm text-fg-muted">
                No product matches “{query.trim()}”.
              </li>
            ) : (
              results.map(({ product }, i) => {
                const here = quantityHere(product.id);
                return (
                  <li
                    key={product.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    // Chosen on mouse down, before the box loses focus and closes the list.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(product);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={`flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line px-3 py-2 text-sm last:border-b-0 ${i === active ? 'bg-indigo-50 dark:bg-indigo-950/40' : ''}`}
                  >
                    <span className="min-w-0">
                      <span className="font-medium break-words text-fg-strong">{product.name}</span>
                      <span className="ml-2 text-xs text-fg-muted">{product.sku}</span>
                      {here !== null && (
                        <span className="ml-2 rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                          Already here: {here}
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-xs text-fg-muted">
                      {product.price == null
                        ? 'No catalogue price'
                        : money(product.price, currency)}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
          {found.length > results.length && (
            <p className="mt-1 text-xs text-fg-muted">
              Showing {results.length} of {found.length.toLocaleString()}. Keep typing to narrow
              them down.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <p
        role="status"
        aria-live="polite"
        className="text-xs text-emerald-800 dark:text-emerald-300"
      >
        {said}
      </p>
    </div>
  );
}
