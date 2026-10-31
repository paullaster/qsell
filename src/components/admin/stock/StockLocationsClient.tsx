'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeDefaultStockLocationAction, setStockLocationActiveAction, stockLocationsPageAction, type LocationView } from '@/server/domains/stock/location-actions';
import { StockLocationForm } from './StockLocationForm';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, buttonClass, cardClass, Chip, fieldClass, LoadFailed, Message, PageHeader, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { has } from '@/lib/values';

type FirstPage = Awaited<ReturnType<typeof stockLocationsPageAction>>;

const KIND_WORDS: Record<string, string> = { warehouse: 'Warehouse', store: 'Shop or store', van: 'Van or vehicle', quarantine: 'Quarantine', damaged: 'Damaged or scrap', consignment_in: 'Consignment' };
const CHANNEL_WORDS: Record<string, string> = { ecommerce: 'Web shop', sales_order: 'Sales orders', credit_sale: 'Credit sales', pos_cash_sale: 'Point of sale' };

const channelWords = (channels: string[]): string => (channels.length === 0 ? 'no channel' : channels.map((c) => CHANNEL_WORDS[c] ?? c).join(', '));

export function StockLocationsClient({ firstPage, canManage }: { firstPage: ReturnType<typeof stockLocationsPageAction>; canManage: Promise<boolean> }) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <LocationsView first={first} may={may} /> : <LoadFailed error={first.error} />;
}

function LocationsView({ first, may }: { first: FirstPage; may: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [showStopped, setShowStopped] = useState(false);
  const [editing, setEditing] = useState<LocationView | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<LocationView, { query: string; showStopped: boolean }>({
    load: (filters, cursor) => stockLocationsPageAction({ query: filters.query, cursor, status: filters.showStopped ? 'all' : 'active' }),
    filters: { query: query.trim(), showStopped },
    initialPage: first,
  });

  const done = (ok: boolean, text: string) => {
    setBusy(false);
    setNotice({ kind: ok ? 'ok' : 'error', text });
    if (ok) {
      list.reload();
      router.refresh();
    }
  };
  const run = async (call: Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    done(res.ok, res.ok ? success : (res.error ?? 'Something went wrong. Please try again.'));
  };

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Stock locations"
        intro="The places your stock is held: warehouses, shops, vans. Every quantity of stock sits in one of them. A place that holds stock cannot be stopped; move or sell the stock first."
        actions={
          may && editing === null ? (
            <button type="button" className={primaryClass} onClick={() => { setNotice(null); setEditing('new'); }}>
              New location
            </button>
          ) : null
        }
      />
      <Message notice={notice} />

      {may && editing !== null ? (
        <section className={`${cardClass} space-y-3`} aria-label={editing === 'new' ? 'New stock location' : `Edit ${editing.code}`}>
          <h3 className="text-sm font-bold text-fg-strong">{editing === 'new' ? 'New stock location' : `Edit ${editing.code}`}</h3>
          <StockLocationForm
            key={editing === 'new' ? 'new' : editing.id}
            location={editing === 'new' ? null : editing}
            autoFocus
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              const created = editing === 'new';
              setEditing(null);
              done(true, `${saved.code} ${created ? 'added' : 'saved'}.`);
            }}
          />
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end">
        <div>
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search locations
          </label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or name" className={fieldClass} autoComplete="off" />
        </div>
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} />
          Show stopped locations
        </label>
      </div>

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

      <ul className="space-y-2" aria-label="Stock locations">
        {list.rows.map((row) => (
          <li key={row.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold break-words text-fg-strong">
                  <span className="font-mono">{row.code}</span> · {row.name}
                </p>
                {has(row.address) ? <p className="mt-1 text-xs break-words text-fg-muted">{row.address}</p> : null}
                <p className="mt-1.5 flex flex-wrap gap-1.5">
                  <Chip tone="gray">{KIND_WORDS[row.kind] ?? row.kind}</Chip>
                  {row.isDefault ? <Chip tone="sky">Default</Chip> : null}
                  {row.isActive ? null : <Chip tone="amber">Stopped</Chip>}
                  {has(row.branchName) ? <Chip tone="gray">Branch: {row.branchName}</Chip> : <Chip tone="gray">Company stock</Chip>}
                  {row.isSellable ? <Chip tone="green">Sells: {channelWords(row.sellsChannels)}</Chip> : <Chip tone="gray">Not for sale</Chip>}
                  {row.allowNegative ? <Chip tone="amber">May go below zero</Chip> : null}
                  <Chip tone="gray">{row.productsWithStock === 0 ? 'No stock' : `Stock of ${String(row.productsWithStock)} product${row.productsWithStock === 1 ? '' : 's'}`}</Chip>
                </p>
                {row.isActive && row.stopBlocker !== null ? <p className="mt-1.5 text-[11px] text-fg-muted">Cannot be stopped: {row.stopBlocker}</p> : null}
              </div>
              {may ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => { setNotice(null); setEditing(row); }} aria-label={`Edit ${row.code}`}>
                    Edit
                  </button>
                  {row.isActive && !row.isDefault ? (
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(makeDefaultStockLocationAction(row.id), `${row.code} is now the default location.`)} aria-label={`Make ${row.code} the default`}>
                      Make default
                    </button>
                  ) : null}
                  {row.isActive && row.stopBlocker === null ? (
                    <InlineConfirm label={`Stop ${row.code}`} action="Stop" confirm="Yes, stop it" busy={busy} onConfirm={() => void run(setStockLocationActiveAction(row.id, false), `${row.code} stopped.`)} />
                  ) : null}
                  {row.isActive ? null : (
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(setStockLocationActiveAction(row.id, true), `${row.code} is in use again.`)} aria-label={`Restart ${row.code}`}>
                      Restart
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-fg-muted">
          {query.trim() === '' ? 'No stock locations yet.' : 'No location matches that search.'}
        </p>
      ) : null}
      {list.cursor !== null ? (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
