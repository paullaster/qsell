'use client';

import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Search, ShoppingCart, X } from 'lucide-react';
import { QuantityInput } from './QuantityInput';
import { useModalKeys } from './useModalKeys';
import type { CatalogueEntry } from '@/lib/quote-layout';
import {
  blankDraft,
  readDraft,
  searchCatalogue,
  type CatalogueIndexEntry,
  type CatalogueProduct,
  type Draft,
} from '@/lib/catalogue-entry';

/** Rows drawn at once. A catalogue can run to thousands; the rest come with "Show more". */
const PAGE = 40;

const money = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const inputClass =
  'mt-1 block min-h-10 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500';

/**
 * Picks catalogue items for a quote or a quote template. It stays open so many items can be added
 * in a row, and each item's quantity, price and discount are set right here, so nobody has to hunt
 * for the new line afterwards.
 *
 * Keyboard: Enter in the search moves to the first result; Enter in a result's field adds it and
 * returns to the search. Escape closes.
 */
export function CataloguePicker({
  index,
  currency,
  destination,
  title,
  showCost = false,
  priceHint,
  quantityHere,
  onAdd,
  onClose,
}: {
  /** The sellable catalogue, from `buildCatalogueIndex`. */
  index: CatalogueIndexEntry[];
  currency: string;
  /** Where the items will go, in words. */
  destination: string;
  title: string;
  /** Templates are internal, so they show what an item costs. */
  showCost?: boolean;
  /** What an empty price field means. */
  priceHint: string;
  /** How much of the item the destination already holds, or null. */
  quantityHere: (productId: string) => number | null;
  /** Everything added in one go, so the caller can apply it as a single change. */
  onAdd: (entries: Omit<CatalogueEntry, 'sectionId'>[]) => void;
  onClose: () => void;
}) {
  const uid = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<{ name: string; quantity: number }[]>([]);
  const [said, setSaid] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const deferred = useDeferredValue(search);

  const dialogRef = useModalKeys<HTMLElement>(onClose);

  const categories = useMemo(
    () => [...new Set(index.map((e) => e.product.category))].filter(Boolean).sort(),
    [index],
  );
  const matches = useMemo(
    () => searchCatalogue(index, deferred, category),
    [index, deferred, category],
  );

  // A new search starts from the top again.
  useEffect(() => setShown(PAGE), [deferred, category]);

  const draftOf = (id: string) => drafts[id] ?? blankDraft;
  const patch = (id: string, change: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? blankDraft), ...change } }));
    setErrors((current) => {
      if (!current[id]) return current;
      const { [id]: _gone, ...rest } = current;
      return rest;
    });
  };

  const add = (product: CatalogueProduct) => {
    const result = readDraft(draftOf(product.id), product);
    if ('error' in result) {
      setErrors((current) => ({ ...current, [product.id]: result.error }));
      return;
    }
    onAdd([result.entry]);
    setSelected((current) => {
      const next = new Set(current);
      next.delete(product.id);
      return next;
    });
    setDrafts(({ [product.id]: _used, ...rest }) => rest);
    setAdded((current) => [{ name: product.name, quantity: result.entry.quantity }, ...current]);
    setSaid(`${result.entry.quantity} × ${product.name} added to ${destination}.`);
    // Straight back to the search, ready for the next item.
    searchRef.current?.focus();
    searchRef.current?.select();
  };

  const visible = matches.slice(0, shown);
  const byId = useMemo(() => new Map(index.map((e) => [e.product.id, e.product])), [index]);

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allShownSelected = visible.length > 0 && visible.every((e) => selected.has(e.product.id));

  /** Adds every ticked item with the values typed on its row. Rows with a problem stay ticked. */
  const addSelected = () => {
    const entries: Omit<CatalogueEntry, 'sectionId'>[] = [];
    const problems: Record<string, string> = {};
    const done: string[] = [];
    for (const id of selected) {
      const product = byId.get(id);
      if (!product) continue;
      const result = readDraft(draftOf(id), product);
      if ('error' in result) problems[id] = result.error;
      else {
        entries.push(result.entry);
        done.push(id);
      }
    }
    setErrors((current) => ({ ...current, ...problems }));
    if (entries.length === 0) {
      setSaid('Nothing was added. Fix the items marked in red.');
      return;
    }
    onAdd(entries);
    setSelected((current) => new Set([...current].filter((id) => !done.includes(id))));
    setDrafts((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !done.includes(id))),
    );
    setAdded((current) => [
      ...done
        .map((id) => ({
          name: byId.get(id)!.name,
          quantity: entries[done.indexOf(id)]!.quantity,
        }))
        .reverse(),
      ...current,
    ]);
    const skipped = Object.keys(problems).length;
    setSaid(
      `${entries.length} items added to ${destination}.${skipped ? ` ${skipped} need fixing.` : ''}`,
    );
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-backdrop/70 p-2 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[96dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line p-3 sm:p-4">
          <div className="min-w-0">
            <h2 className="font-semibold text-fg-strong">{title}</h2>
            <p className="text-xs text-fg-muted">
              Adding to <strong className="text-fg-strong">{destination}</strong>. Set the quantity,
              price and discount, then press Enter. The catalogue stays open for the next item.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
            aria-label="Close catalogue"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="flex flex-col gap-2 border-b border-line p-3 sm:flex-row sm:p-4">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden
            />
            <input
              ref={searchRef}
              autoFocus
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const first = visible[0]?.product;
                if (first) document.getElementById(`${uid}-qty-${first.id}`)?.focus();
              }}
              aria-label="Search products by name, SKU, stock code, brand or category"
              placeholder="Search name, SKU, brand…"
              className="min-h-10 w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
            />
          </div>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Category"
            className="min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <option value="all">All categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-fg-muted">
              {matches.length.toLocaleString()} {matches.length === 1 ? 'product' : 'products'}
              {deferred.trim() || category !== 'all' ? ' match' : ''}. Tick several to add them
              together.
            </p>
            {visible.length > 0 && (
              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-xs font-medium text-fg">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={allShownSelected}
                  onChange={(e) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      for (const entry of visible) {
                        if (e.target.checked) next.add(entry.product.id);
                        else next.delete(entry.product.id);
                      }
                      return next;
                    })
                  }
                />
                Select the {visible.length} shown
              </label>
            )}
          </div>
          {matches.length === 0 ? (
            <p className="p-10 text-center text-sm text-fg-muted">
              No available products match this search.
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map(({ product }) => {
                const draft = draftOf(product.id);
                const error = errors[product.id];
                const here = quantityHere(product.id);
                const errorId = `${uid}-err-${product.id}`;
                const onEnter = (event: React.KeyboardEvent) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  add(product);
                };
                return (
                  <li
                    key={product.id}
                    className={`rounded-xl border bg-surface p-3 ${error ? 'border-red-400' : 'border-line'}`}
                  >
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                      <div className="flex min-w-0 gap-3">
                        <label className="flex min-h-10 w-8 shrink-0 cursor-pointer items-start justify-center pt-3">
                          <input
                            type="checkbox"
                            className="size-4"
                            checked={selected.has(product.id)}
                            onChange={(e) => toggle(product.id, e.target.checked)}
                            aria-label={`Select ${product.name}`}
                          />
                        </label>
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-sunken">
                          {product.imageUrl ? (
                            <img
                              src={product.imageUrl}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <ShoppingCart className="h-5 w-5 text-fg-faint" aria-hidden />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold break-words text-fg-strong">{product.name}</p>
                          <p className="text-xs text-fg-muted">
                            {product.sku} · {product.category}
                          </p>
                          <p className="text-xs text-fg-muted">
                            <span className="font-mono font-semibold text-fg-strong">
                              {product.price == null
                                ? 'No catalogue price'
                                : money(product.price, currency)}
                            </span>
                            {showCost && <> · cost {money(product.costPrice, currency)}</>} ·{' '}
                            {product.stockQuantity - product.reservedQuantity} available · tax{' '}
                            {product.taxRate ?? 0}%
                          </p>
                          {here !== null && (
                            <p className="mt-1 inline-flex rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                              Already here: {here}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-[8rem_1fr_1fr] gap-2 md:w-[30rem] md:grid-cols-[8.5rem_1fr_5.5rem_auto]">
                        <div className="text-xs font-medium text-fg">
                          Qty
                          <div className="mt-1">
                            <QuantityInput
                              id={`${uid}-qty-${product.id}`}
                              label={`Quantity of ${product.name}`}
                              value={draft.quantity}
                              onChange={(value) => patch(product.id, { quantity: value })}
                              onKeyDown={onEnter}
                              invalid={Boolean(error)}
                              describedBy={error ? errorId : undefined}
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
                            placeholder={product.price == null ? 'Required' : String(product.price)}
                            onChange={(e) => patch(product.id, { price: e.target.value })}
                            onKeyDown={onEnter}
                            aria-describedby={`${uid}-price-hint`}
                            className={inputClass}
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
                            onChange={(e) => patch(product.id, { discount: e.target.value })}
                            onKeyDown={onEnter}
                            className={inputClass}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => add(product)}
                          aria-label={`Add ${product.name}`}
                          className="col-span-3 inline-flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 md:col-span-1 md:mt-5"
                        >
                          <Plus className="h-4 w-4" aria-hidden /> Add
                        </button>
                      </div>
                    </div>
                    {error && (
                      <p
                        id={errorId}
                        role="alert"
                        className="mt-2 text-xs font-semibold text-red-700"
                      >
                        {error}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p id={`${uid}-price-hint`} className="mt-3 text-xs text-fg-muted">
            {priceHint}
          </p>
          {matches.length > visible.length && (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE)}
                className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                Show more ({(matches.length - visible.length).toLocaleString()} left)
              </button>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-raised p-3 sm:p-4">
          <div className="min-w-0 text-sm text-fg">
            {added.length === 0 ? (
              <span className="text-fg-muted">Nothing added yet.</span>
            ) : (
              <>
                <strong className="text-fg-strong">{added.length} added this visit</strong>
                <span className="ml-2 text-xs text-fg-muted">
                  Latest:{' '}
                  {added
                    .slice(0, 3)
                    .map((a) => `${a.quantity} × ${a.name}`)
                    .join(', ')}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selected.size > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
                >
                  Clear {selected.size} ticked
                </button>
                <button
                  type="button"
                  onClick={addSelected}
                  className="min-h-10 cursor-pointer rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                >
                  Add {selected.size} ticked
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Done{added.length > 0 ? ` (${added.length})` : ''}
            </button>
          </div>
        </footer>
        <p role="status" aria-live="polite" className="sr-only">
          {said}
        </p>
      </section>
    </div>
  );
}
