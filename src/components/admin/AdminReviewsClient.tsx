'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { BadgeCheck, Star } from 'lucide-react';
import { moderateReviewAction, reviewQueueAction, type ReviewQueuePage } from '@/server/domains/reviews/actions';
import { attempt, buttonClass, cardClass, fieldClass, Message, PageHeader, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { usePagedList } from '@/components/ui/usePagedList';

type Row = ReviewQueuePage['rows'][number];
type Status = 'pending' | 'approved' | 'rejected';

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Waiting' },
  { value: 'approved', label: 'Published' },
  { value: 'rejected', label: 'Turned down' },
] as const;

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex" role="img" aria-label={`${String(value)} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} className={`h-4 w-4 ${n <= value ? 'fill-amber-400 text-amber-500' : 'text-fg-faint'}`} aria-hidden="true" />)}
    </span>
  );
}

function ReviewCard({ row, busy, onDecide }: { row: Row; busy: boolean; onDecide: (decision: 'approve' | 'reject' | 'delete', note: string) => void }) {
  const id = useId();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  return (
    <li className={`${cardClass} space-y-2`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/product/${row.productSlug}`} className="text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400">{row.productName}</Link>
        <time dateTime={row.createdAt} className="text-xs text-fg-muted">{row.createdAt.slice(0, 16).replace('T', ' ')}</time>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Stars value={row.rating} />
        {row.title === '' ? null : <span className="text-sm font-semibold text-fg-strong">{row.title}</span>}
      </div>
      <p className="text-sm whitespace-pre-line text-fg">{row.body}</p>
      <p className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
        <span>{row.reviewerName}</span>
        {row.verifiedPurchase ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />Verified purchase</span> : null}
        {row.status === 'rejected' && row.moderationNote !== '' ? <span>Reason given: {row.moderationNote}</span> : null}
      </p>
      {rejecting ? (
        <div className="space-y-2 rounded-lg border border-line bg-surface p-3">
          <label htmlFor={`${id}-note`} className="block text-sm font-medium text-fg">Why is this review being turned down? The reviewer will see it.</label>
          <textarea id={`${id}-note`} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className={fieldClass} />
          <div className="flex gap-2">
            <button type="button" className={primaryClass} disabled={busy || note.trim() === ''} onClick={() => onDecide('reject', note)}>Turn it down</button>
            <button type="button" className={buttonClass} onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {row.status === 'approved' ? null : <button type="button" className={primaryClass} disabled={busy} onClick={() => onDecide('approve', '')}>Publish</button>}
          {row.status === 'rejected' ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => setRejecting(true)}>Turn down</button>}
          <InlineConfirm label={`Delete the review of ${row.productName} by ${row.reviewerName}`} action="Delete" confirm="Delete for good" busy={busy} onConfirm={() => onDecide('delete', '')} />
        </div>
      )}
    </li>
  );
}

/** Product reviews waiting to be checked, and those already decided. Nothing a shopper writes is shown until someone here publishes it. */
export function AdminReviewsClient() {
  const uid = useId();
  const [status, setStatus] = useState<Status>('pending');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [waiting, setWaiting] = useState<number | null>(null);

  const list = usePagedList<Row, { status: Status; query: string }>({
    load: async (filters, cursor) => {
      const result = await reviewQueueAction({ status: filters.status, query: filters.query, cursor });
      if (!result.ok) return { ok: false, error: result.error };
      setWaiting(result.data.waiting);
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: { status, query: query.trim() },
  });

  const decide = async (row: Row, decision: 'approve' | 'reject' | 'delete', note: string) => {
    setBusy(true);
    setNotice(null);
    const result = await attempt(moderateReviewAction({ id: row.id, decision, note }));
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setNotice({ kind: 'ok', text: { approve: 'The review is published.', reject: 'The review was turned down.', delete: 'The review was deleted.' }[decision] });
    list.reload();
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Product reviews" intro="Shoppers who have received a product can review it. A review is shown in the shop only after you publish it, and the product's rating follows what is published." />
      <Message notice={notice} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <SegmentedChoice label="Show" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        <div className="w-full sm:w-72">
          <label htmlFor={`${uid}-search`} className="sr-only">Search reviews</label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by product, person or words" className={fieldClass} autoComplete="off" />
        </div>
      </div>
      {waiting === null ? null : <p role="status" className="text-sm text-fg-muted">{waiting} waiting to be checked.</p>}
      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p>
      ) : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading reviews…</p> : null}
      {list.phase !== 'loading' && list.rows.length === 0 && list.phase !== 'error' ? <p className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">{status === 'pending' ? 'Nothing is waiting. New reviews will appear here.' : 'No reviews here.'}</p> : null}
      <ul className="space-y-3" aria-label="Reviews">
        {list.rows.map((row) => <ReviewCard key={row.id} row={row} busy={busy} onDecide={(decision, note) => void decide(row, decision, note)} />)}
      </ul>
      {list.cursor === null ? null : <button type="button" className={buttonClass} disabled={list.phase === 'more'} onClick={list.loadMore}>{list.phase === 'more' ? 'Loading…' : 'Show more'}</button>}
    </div>
  );
}
