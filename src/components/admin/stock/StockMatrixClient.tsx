'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { stockMatrixAction, type MatrixRow, type StockMatrix } from '@/server/domains/stock/matrix-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { buttonClass, fieldClass, LoadFailed, PageHeader } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

type First = Extract<Awaited<ReturnType<typeof stockMatrixAction>>, { ok: true }>;

const SOURCE_NOTE: Record<StockMatrix['source'], string | null> = {
  ledger: null,
  shadow: 'The new stock ledger is being filled alongside the old counts and is not the truth yet. These figures are a copy of the old counts, at one location.',
  off: 'The new stock ledger is not switched on yet, so there are no figures by location to show.',
};

export function StockMatrixClient({ firstPage }: { firstPage: ReturnType<typeof stockMatrixAction> }) {
  const first = use(firstPage);
  return first.ok ? <MatrixView first={first} /> : <LoadFailed error={first.error} />;
}

const figure = (n: number): string => String(Math.round(n * 1000) / 1000);

function MatrixView({ first }: { first: First }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [place, setPlace] = useState<Choice | null>(null);
  const [withStock, setWithStock] = useState(false);
  const [columns, setColumns] = useState(first.data.columns);
  const [source, setSource] = useState(first.data.source);
  const [more, setMore] = useState(first.data.moreLocations);

  const list = usePagedList<MatrixRow, { query: string; place: string; withStock: boolean }>({
    load: async (filters, cursor) => {
      const res = await stockMatrixAction({ query: filters.query, cursor, withStock: filters.withStock, ...(filters.place === '' ? {} : { locationId: filters.place }) });
      if (!res.ok) return res;
      // The columns follow the filter; the rows are the page.
      setColumns(res.data.columns);
      setSource(res.data.source);
      setMore(res.data.moreLocations);
      return { ok: true as const, data: { rows: res.data.rows, nextCursor: res.data.nextCursor } };
    },
    filters: { query: query.trim(), place: place?.id ?? '', withStock },
    initialPage: { ok: true, data: { rows: first.data.rows, nextCursor: first.data.nextCursor } },
  });
  const note = SOURCE_NOTE[source];

  return (
    <div className="max-w-7xl space-y-5">
      <PageHeader
        title="Stock by location"
        intro="How much of each product is held where. On hand is what is physically there; promised is what is held for customers' orders. The total counts every location."
        actions={
          <Link href="/admin/inventory/transfers/new" className={buttonClass}>
            Transfer stock
          </Link>
        }
      />
      {note === null ? null : (
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">
          {note}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,20rem)_minmax(0,18rem)_auto] sm:items-end">
        <div>
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search products
          </label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, SKU or stock code" className={fieldClass} autoComplete="off" />
        </div>
        <ChoicePicker label="Only this location" source="stock-locations" choice={place} onChoice={setPlace} placeholder="All locations" clearable />
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={withStock} onChange={(e) => setWithStock(e.target.checked)} />
          Only products with stock
        </label>
      </div>
      {more ? <p className="text-xs text-fg-muted">There are more locations than fit as columns. Choose one location to see it.</p> : null}

      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {list.phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}

      <div className="hidden md:block">
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm" aria-label="Stock by location">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col" className="w-[26%] border-b border-line p-2">Product</th>
              {columns.map((c) => (
                <th key={c.id} scope="col" className="border-b border-line p-2 text-right" title={c.name}>
                  <span className="font-mono">{c.code}</span>
                </th>
              ))}
              <th scope="col" className="border-b border-line p-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((r) => (
              <tr key={r.productId} data-product={r.productId}>
                <th scope="row" className="border-b border-line p-2 text-left font-medium break-words text-fg-strong">
                  {r.name}
                  <span className="block text-[11px] font-normal text-fg-muted">{r.sku}</span>
                </th>
                {columns.map((c) => {
                  const cell = r.cells[c.id];
                  return (
                    <td key={c.id} className="border-b border-line p-2 text-right tabular-nums">
                      {cell === undefined ? <span className="text-fg-muted">·</span> : figure(cell.onHand)}
                      {cell !== undefined && cell.reserved > 0 ? <span className="block text-[11px] text-amber-700">{figure(cell.reserved)} promised</span> : null}
                    </td>
                  );
                })}
                <td className="border-b border-line p-2 text-right font-semibold tabular-nums">
                  {figure(r.total)}
                  {r.totalReserved > 0 ? <span className="block text-[11px] font-normal text-amber-700">{figure(r.totalReserved)} promised</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden" aria-label="Stock by location">
        {list.rows.map((r) => (
          <li key={r.productId} className="rounded-xl border border-line bg-surface-raised p-3" data-product={r.productId}>
            <p className="text-sm font-bold break-words text-fg-strong">{r.name}</p>
            <p className="text-[11px] text-fg-muted">{r.sku}</p>
            <ul className="mt-2 space-y-1 text-xs">
              {columns.flatMap((c) => {
                const cell = r.cells[c.id];
                return cell === undefined ? [] : [
                  <li key={c.id} className="flex justify-between gap-3">
                    <span><span className="font-mono">{c.code}</span> · {c.name}</span>
                    <span className="tabular-nums">{figure(cell.onHand)}{cell.reserved > 0 ? `, ${figure(cell.reserved)} promised` : ''}</span>
                  </li>,
                ];
              })}
              <li className="flex justify-between gap-3 border-t border-line pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{figure(r.total)}</span>
              </li>
            </ul>
          </li>
        ))}
      </ul>

      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-fg-muted">{query.trim() === '' && !withStock ? 'No products yet.' : 'No product matches that.'}</p>
      ) : null}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}
