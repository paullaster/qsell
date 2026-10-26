'use client';

import { useId, useState } from 'react';
import { Download } from 'lucide-react';
import { exportNewsletterAction, newsletterPageAction } from '@/server/domains/newsletter/actions';
import { attempt, buttonClass, cardClass, fieldClass, Message, PageHeader, type Notice } from '@/components/ui/screen-kit';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { usePagedList } from '@/components/ui/usePagedList';

type Status = 'pending' | 'subscribed' | 'unsubscribed';
interface Row { id: string; email: string; status: Status; createdAt: string; confirmedAt: string | null }

const OPTIONS = [
  { value: 'subscribed', label: 'Subscribed' },
  { value: 'pending', label: 'Waiting to confirm' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
] as const;

/** The people who asked for the shop's news. Only addresses that confirmed are ever exported. */
export function AdminNewsletterClient() {
  const uid = useId();
  const [status, setStatus] = useState<Status>('subscribed');
  const [query, setQuery] = useState('');
  const [totals, setTotals] = useState<Record<Status, number> | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const list = usePagedList<Row, { status: Status; query: string }>({
    load: async (filters, cursor) => {
      const result = await newsletterPageAction({ status: filters.status, query: filters.query, cursor });
      if (!result.ok) return { ok: false, error: result.error };
      setTotals(result.data.totals);
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: { status, query: query.trim() },
  });

  const download = async () => {
    setBusy(true);
    setNotice(null);
    const result = await attempt(exportNewsletterAction());
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    const url = URL.createObjectURL(new Blob([result.data], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'newsletter-subscribers.csv';
    link.click();
    URL.revokeObjectURL(url);
    setNotice({ kind: 'ok', text: 'The confirmed addresses were downloaded.' });
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Newsletter"
        intro="People who asked for the shop's news. Each one confirms from a link in an email before they are counted, and can unsubscribe from any message."
        actions={<button type="button" className={buttonClass} disabled={busy} onClick={() => void download()}><Download className="mr-1.5 inline h-4 w-4" aria-hidden="true" />Download confirmed (CSV)</button>}
      />
      <Message notice={notice} />
      {totals === null ? null : <p role="status" className="text-sm text-fg-muted">{totals.subscribed} subscribed · {totals.pending} waiting to confirm · {totals.unsubscribed} unsubscribed</p>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <SegmentedChoice label="Show" value={status} options={OPTIONS} onChange={setStatus} />
        <div className="w-full sm:w-72">
          <label htmlFor={`${uid}-search`} className="sr-only">Search addresses</label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by email" className={fieldClass} autoComplete="off" />
        </div>
      </div>
      {list.phase === 'error' ? <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p> : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading…</p> : null}
      {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? <p className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">Nobody here yet.</p> : null}
      <ul className="space-y-2" aria-label="Subscribers">
        {list.rows.map((row) => (
          <li key={row.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2`}>
            <span className="min-w-0 truncate text-sm font-medium text-fg-strong">{row.email}</span>
            <time dateTime={row.createdAt} className="text-xs text-fg-muted">Asked {row.createdAt.slice(0, 10)}{row.confirmedAt === null ? '' : ` · confirmed ${row.confirmedAt.slice(0, 10)}`}</time>
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : <button type="button" className={buttonClass} disabled={list.phase === 'more'} onClick={list.loadMore}>{list.phase === 'more' ? 'Loading…' : 'Show more'}</button>}
    </div>
  );
}
