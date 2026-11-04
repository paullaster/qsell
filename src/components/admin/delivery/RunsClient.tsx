'use client';

import { useState } from 'react';
import Link from 'next/link';
import { runsPageAction } from '@/server/domains/delivery/run-actions';
import type { RunListItem } from '@/server/domains/delivery/runs';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, PageHeader, buttonClass, cardClass } from '@/components/ui/screen-kit';
import { usePagedList } from '@/components/ui/usePagedList';
import type { Choice } from '@/lib/payment-options';
import type { RunStatus } from '@/lib/dispatch-run';

const TONE: Record<RunStatus, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { planned: 'sky', started: 'amber', completed: 'green', cancelled: 'gray' };

/** Every run, newest first, by state, a page at a time. */
export function RunsClient() {
  const [status, setStatus] = useState<Choice | null>(null);
  const list = usePagedList<RunListItem, { status: string }>({
    load: async (filters, cursor) => {
      const result = await runsPageAction({ status: filters.status, cursor });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: { status: status?.id ?? '' },
  });

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Delivery runs" intro="A rider’s trips. Plan one on the dispatch board, put ready deliveries on it, and send it out." actions={<Link href="/admin/delivery/dispatch" className={buttonClass}>Dispatch board</Link>} />
      <div className="max-w-xs">
        <ChoicePicker label="State" source="delivery-run-statuses" choice={status} onChoice={setStatus} placeholder="All states" clearable />
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
          Loading runs…
        </p>
      ) : null}
      {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
          {status === null ? 'No runs yet. Plan one on the dispatch board.' : 'No run is in that state.'}
        </p>
      ) : null}
      <ul className="space-y-3" aria-label="Runs">
        {list.rows.map((r) => (
          <li key={r.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
            <div className="min-w-0">
              <Link href={`/admin/delivery/runs/${r.id}`} className="min-h-10 py-2 font-mono text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                {r.number}
              </Link>
              <p className="text-xs text-fg-muted">
                {r.riderName} · {r.runDate} · from {r.branchName} · {r.stops} {r.stops === 1 ? 'stop' : 'stops'}
              </p>
            </div>
            <Chip tone={TONE[r.status]}>{r.statusWords}</Chip>
          </li>
        ))}
      </ul>
      {list.cursor !== null ? (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
