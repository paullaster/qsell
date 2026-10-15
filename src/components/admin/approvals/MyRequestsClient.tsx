'use client';

import { use, useId, useState } from 'react';
import {
  cancelRequestAction,
  myRequestsPageAction,
  reopenRequestAction,
  type MyRequest,
} from '@/server/kernel/approvals/actions';
import { DOCUMENT_KIND_LABELS } from '@/server/kernel/approvals/domain/triggers';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import {
  EmptyState,
  Notice,
  PageHeader,
  StatusChip,
  When,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  money,
  primaryButtonClass,
  type Message,
} from './shared';

const FILTERS = [
  ['all', 'All'],
  ['pending', 'Waiting'],
  ['rejected', 'Rejected'],
  ['approved', 'Approved'],
] as const;

type FirstPage = Extract<Awaited<ReturnType<typeof myRequestsPageAction>>, { ok: true }>;

export function MyRequestsClient({ firstPage }: { firstPage: ReturnType<typeof myRequestsPageAction> }) {
  const first = use(firstPage);
  if (!first.ok) return <LoadFailed error={first.error} />;
  return <MyRequests first={first} />;
}

function MyRequests({ first }: { first: FirstPage }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [message, setMessage] = useState<Message>(null);

  const list = usePagedList<MyRequest, { status: string }>({
    load: (filters, cursor) => myRequestsPageAction({ status: filters.status, cursor }),
    filters: { status: filter },
    initialPage: first,
  });

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="My requests">
        Everything you have sent for approval. A rejected document must be reopened before it can be
        changed and sent again; it then starts a fresh request.
      </PageHeader>

      <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            className={`${buttonClass} ${filter === key ? 'border-indigo-500 bg-indigo-500/10' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      <Notice message={message} />

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
      {list.phase === 'idle' && list.rows.length === 0 ? (
        <EmptyState title="No requests here">Documents that need approval appear here after you submit them.</EmptyState>
      ) : null}
      {list.rows.length > 0 ? (
        <ul className="space-y-3" aria-label="Your requests">
          {list.rows.map((r) => (
            <li key={r.requestId}>
              <RequestCard
                request={r}
                onDone={(text) => {
                  setMessage({ kind: 'ok', text });
                  list.reload();
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more requests'}
        </button>
      )}
    </div>
  );
}

function RequestCard({
  request: r,
  onDone,
}: {
  request: MyRequest;
  onDone: (text: string) => void;
}) {
  const uid = useId();
  const [action, setAction] = useState<'withdraw' | 'reopen' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>(null);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await attempt(
      action === 'withdraw'
        ? cancelRequestAction(r.submissionId, reason)
        : reopenRequestAction(r.documentKind, r.documentId, reason),
    );
    setBusy(false);
    if (!res.ok) { setError({ kind: 'error', text: res.error }); return; }
    setAction(null);
    onDone(
      action === 'withdraw'
        ? 'The request was withdrawn.'
        : 'Reopened. You can change the document and send it again.',
    );
  };

  return (
    <article className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-fg-strong">{r.triggerLabel}</h3>
          <p className="mt-0.5 font-mono text-xs break-all text-fg-muted">
            {DOCUMENT_KIND_LABELS[r.documentKind] ?? r.documentKind} · {r.documentId}
          </p>
          <p className="mt-2 text-sm text-fg">
            {money(r.amount)} · sent <When iso={r.createdAt} />
            {r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}
          </p>
          {r.status === 'pending' && r.waitingOn.length > 0 ? (
            <p className="mt-1 text-sm text-fg-muted">Waiting on {r.waitingOn.join(', ')}</p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusChip status={r.status} />
          {r.status === 'pending' ? (
            <button type="button" className={buttonClass} onClick={() => setAction('withdraw')}>
              Withdraw…
            </button>
          ) : null}
          {r.status === 'rejected' ? (
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => setAction('reopen')}
            >
              Reopen…
            </button>
          ) : null}
        </div>
      </div>
      {action === null ? null : (
        <form onSubmit={submit} className="mt-4 space-y-3 border-t border-line pt-4">
          <div>
            <label htmlFor={`${uid}-r`} className={labelClass}>
              {action === 'withdraw'
                ? 'Why are you withdrawing this request?'
                : 'What will you change?'}
            </label>
            <textarea
              id={`${uid}-r`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              required
              className={fieldClass}
            />
          </div>
          <Notice message={error} />
          <div className="flex gap-2">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={busy || reason.trim() === ''}
            >
              {action === 'withdraw' ? 'Withdraw request' : 'Reopen document'}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
