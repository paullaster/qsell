'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { stockCountsPageAction, type CountRowView } from '@/server/domains/stock/count-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { buttonClass, Chip, fieldClass, LoadFailed, PageHeader, primaryClass } from '@/components/ui/screen-kit';
import { COUNT_STATE_WORDS, isCountState } from '@/lib/stock-documents';
import type { Choice } from '@/lib/payment-options';

type FirstPage = Extract<Awaited<ReturnType<typeof stockCountsPageAction>>, { ok: true }>;

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

export function CountsClient({ firstPage, canCount }: { firstPage: ReturnType<typeof stockCountsPageAction>; canCount: Promise<boolean> }) {
  const first = use(firstPage);
  const may = use(canCount);
  return first.ok ? <CountsView first={first} may={may} /> : <LoadFailed error={first.error} />;
}

function CountsView({ first, may }: { first: FirstPage; may: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<Choice | null>(null);
  const list = usePagedList<CountRowView, { query: string; state: string }>({
    load: (filters, cursor) => stockCountsPageAction({ query: filters.query, cursor, ...(filters.state === '' ? {} : { state: filters.state }) }),
    filters: { query: query.trim(), state: state?.id ?? '' },
    initialPage: first,
  });

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Stock counts"
        intro="Count what is on the shelves of one location and bring the system in line with it. Sales can carry on while you count: a sale made meanwhile is not mistaken for a loss. A large difference needs a second person to agree."
        actions={
          may && first.data.ledgerOn ? (
            <Link href="/admin/inventory/counts/new" className={primaryClass}>
              New count
            </Link>
          ) : null
        }
      />
      {first.data.ledgerOn ? null : (
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">
          Counts work on the new stock ledger, which is not switched on for this company yet. Existing counts can still be read.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,20rem)_minmax(0,18rem)] sm:items-end">
        <div>
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search counts
          </label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by count number" className={fieldClass} autoComplete="off" />
        </div>
        <ChoicePicker label="State" source="stock-count-states" choice={state} onChoice={setState} placeholder="Any state" clearable />
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

      <ul className="space-y-2" aria-label="Stock counts">
        {list.rows.map((row) => {
          const words = isCountState(row.state) ? COUNT_STATE_WORDS[row.state] : { label: row.state, tone: 'gray' as const };
          return (
            <li key={row.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
              <Link href={`/admin/inventory/counts/${row.id}`} className="flex min-h-10 flex-wrap items-start justify-between gap-3" aria-label={`Open count ${row.number}`}>
                <span className="min-w-0">
                  <span className="block text-sm font-bold break-words text-fg-strong">
                    <span className="font-mono">{row.number}</span> · {row.locationCode}
                  </span>
                  <span className="mt-1 block text-xs text-fg-muted">
                    {row.mode === 'full' ? 'Full count' : 'Cycle count'}
                    {row.blind ? ', blind' : ''} · {row.counted} of {row.lines} {row.lines === 1 ? 'product' : 'products'} counted · opened by {row.createdByName} on {when(row.createdAt)}
                  </span>
                </span>
                <Chip tone={words.tone}>{words.label}</Chip>
              </Link>
            </li>
          );
        })}
      </ul>

      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-fg-muted">{query.trim() === '' && state === null ? 'No counts yet.' : 'No count matches that.'}</p>
      ) : null}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}
