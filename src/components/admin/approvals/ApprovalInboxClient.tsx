'use client';

import { use, useCallback, useEffect, useId, useState } from 'react';
import {
  approveEntryAction,
  getRequestDetailAction,
  inboxCountsAction,
  inboxPageAction,
  rejectEntryAction,
  type InboxItem,
  type RequestDetail,
} from '@/server/kernel/approvals/actions';
import { DOCUMENT_KIND_LABELS } from '@/server/kernel/approvals/domain/triggers';
import { usePagedList } from '@/components/ui/usePagedList';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  StatusChip,
  When,
  actionLabel,
  buttonClass,
  cardClass,
  dangerButtonClass,
  fieldClass,
  labelClass,
  money,
  primaryButtonClass,
  type Message,
} from './shared';

import { has, orElse } from '@/lib/values';

type FirstPage = Extract<Awaited<ReturnType<typeof inboxPageAction>>, { ok: true }>;
type Counts = Extract<Awaited<ReturnType<typeof inboxCountsAction>>, { ok: true }>['data'];

interface Props {
  firstPage: ReturnType<typeof inboxPageAction>;
  counts: ReturnType<typeof inboxCountsAction>;
}

export function ApprovalInboxClient({ firstPage, counts }: Props) {
  const first = use(firstPage);
  const total = use(counts);
  if (!first.ok) return <LoadFailed error={first.error} />;
  if (!total.ok) return <LoadFailed error={total.error} />;
  return <Inbox first={first} initialCounts={total.data} />;
}

function Inbox({ first, initialCounts }: { first: FirstPage; initialCounts: Counts }) {
  const uid = useId();
  const [search, setSearch] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [counts, setCounts] = useState(initialCounts);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const query = useDebouncedValue(search.trim());

  const list = usePagedList<InboxItem, { query: string; overdueOnly: boolean }>({
    load: (filters, cursor) => inboxPageAction({ query: filters.query, overdueOnly: filters.overdueOnly, cursor }),
    filters: { query, overdueOnly },
    initialPage: first,
  });

  const done = useCallback(
    (_entryId: string, text: string) => {
      setOpen(null);
      setMessage({ kind: 'ok', text });
      list.reload();
      void attempt(inboxCountsAction()).then((fresh) => {
        if (fresh.ok) setCounts(fresh.data);
      });
    },
    [list],
  );

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Approvals waiting on you">
        Each request shows why it needs approval and what has happened so far. Rejecting needs a
        reason, and the person who asked is told.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-xs">
          <label htmlFor={`${uid}-q`} className={labelClass}>
            Search
          </label>
          <input
            id={`${uid}-q`}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Document or type"
            className={fieldClass}
            autoComplete="off"
          />
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} className="size-4" />
          Overdue only
        </label>
        <p className="ml-auto text-xs text-fg-muted" aria-live="polite">
          {counts.waiting} waiting · {counts.overdue} overdue
        </p>
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
      {list.phase === 'idle' && list.rows.length === 0 && query === '' && !overdueOnly ? (
        <EmptyState title="Nothing is waiting on you">
          New requests appear here as soon as someone submits something you are asked to approve.
        </EmptyState>
      ) : null}
      {list.phase === 'idle' && list.rows.length === 0 && (query !== '' || overdueOnly) ? <EmptyState title="No requests match" /> : null}
      {list.rows.length > 0 ? (
        <ul className="space-y-3" aria-label="Requests waiting on you">
          {list.rows.map((item) => (
            <li key={item.entryId}>
              <InboxCard
                item={item}
                expanded={open === item.entryId}
                onToggle={() => setOpen((cur) => (cur === item.entryId ? null : item.entryId))}
                onDone={done}
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

function InboxCard({
  item,
  expanded,
  onToggle,
  onDone,
}: {
  item: InboxItem;
  expanded: boolean;
  onToggle: () => void;
  onDone: (entryId: string, text: string) => void;
}) {
  const panelId = useId();
  return (
    <article className={cardClass} aria-label={`${item.triggerLabel}, ${item.documentId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-fg-strong">{item.triggerLabel}</h3>
          <p className="mt-0.5 font-mono text-xs break-all text-fg-muted">
            {DOCUMENT_KIND_LABELS[item.documentKind] ?? item.documentKind} · {item.documentId}
          </p>
          <p className="mt-2 text-sm text-fg">
            {money(item.amount)} · requested by {item.requestedByName} ·{' '}
            <When iso={item.waitingSince} />
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {has(item.onBehalfOfName) ? (
              <Chip tone="sky">Covering for {item.onBehalfOfName}</Chip>
            ) : null}
            {item.handedOver ? <Chip tone="amber">Handed over to you</Chip> : null}
            {item.overdue ? <Chip tone="red">Overdue</Chip> : null}
          </div>
        </div>
        <button
          type="button"
          className={primaryButtonClass}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
        >
          {expanded ? 'Close' : 'Review'}
        </button>
      </div>
      {expanded ? (
        <div id={panelId} className="mt-4 border-t border-line pt-4">
          <Review item={item} onDone={onDone} />
        </div>
      ) : null}
    </article>
  );
}

function Review({
  item,
  onDone,
}: {
  item: InboxItem;
  onDone: (entryId: string, text: string) => void;
}) {
  const uid = useId();
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  // Loaded once, when the card is opened.
  useEffect(() => {
    let live = true;
    void getRequestDetailAction(item.requestId).then((r) => {
      if (!live) return;
      if (r.ok) setDetail(r.data);
      else setLoadError(r.error);
    });
    return () => {
      live = false;
    };
  }, [item.requestId]);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (mode === null) return;
    setBusy(true);
    setMessage(null);
    const res =
      mode === 'approve'
        ? await approveEntryAction(item.entryId, comment)
        : await rejectEntryAction(item.entryId, reason.code, orElse(comment, reason.text));
    setBusy(false);
    if (!res.ok) { setMessage({ kind: 'error', text: res.error }); return; }
    onDone(item.entryId, res.data.message);
  };

  if (has(loadError))
    return (
      <p role="alert" className="text-sm text-red-700">
        {loadError}
      </p>
    );
  if (!detail)
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading the details…
      </p>
    );

  return (
    <div className="space-y-5">
      <section aria-labelledby={`${uid}-why`}>
        <h4 id={`${uid}-why`} className="text-xs font-bold tracking-wide text-fg-muted uppercase">
          Why this needs approval
        </h4>
        {has(detail.what) ? (
          <p className="mt-1 rounded-lg border border-line bg-surface-sunken p-3 text-sm font-medium text-fg-strong">
            {detail.what}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-fg">
          Workflow “{detail.workflowName}” (version {detail.workflowVersion})
          {detail.attempt > 1 ? `, attempt ${detail.attempt}` : ''}.
        </p>
        {detail.facts.length > 0 ? (
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {detail.facts.map((f) => (
              <div
                key={f.label}
                className="flex justify-between gap-3 border-b border-line py-1 text-sm"
              >
                <dt className="text-fg-muted">{f.label}</dt>
                <dd className="text-right font-medium text-fg-strong">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      <section aria-labelledby={`${uid}-steps`}>
        <h4 id={`${uid}-steps`} className="text-xs font-bold tracking-wide text-fg-muted uppercase">
          Approval steps
        </h4>
        <ol className="mt-2 space-y-2">
          {detail.steps.map((s) => (
            <li key={s.sequence} className="rounded-lg border border-line p-3">
              <p className="text-sm font-semibold text-fg-strong">
                {s.sequence}. {s.name}
              </p>
              {s.entries.length === 0 ? (
                <p className="mt-1 text-xs text-fg-muted">Not reached yet.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {s.entries.map((e) => (
                    <li key={`${e.approverName}-${e.status}-${e.actedAt ?? ''}`} className="flex flex-wrap items-center gap-2 text-sm text-fg">
                      <span>
                        {e.approverName}
                        {has(e.onBehalfOfName) ? ` (for ${e.onBehalfOfName})` : ''}
                      </span>
                      <StatusChip status={e.status} />
                      {has(e.comment) ? (
                        <span className="text-xs text-fg-muted">“{e.comment}”</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </section>

      <details className="rounded-lg border border-line p-3">
        <summary className="min-h-10 cursor-pointer text-sm font-semibold text-fg-strong">
          History ({detail.timeline.length})
        </summary>
        <ol className="mt-2 space-y-1.5">
          {detail.timeline.map((t) => (
            <li key={`${t.at}-${t.action}`} className="text-sm text-fg">
              <span className="font-medium">{actionLabel(t.action)}</span> · {t.actorName} ·{' '}
              <When iso={t.at} />
              {has(t.reason) ? <span className="block text-xs text-fg-muted">{t.reason}</span> : null}
            </li>
          ))}
        </ol>
      </details>

      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryButtonClass} onClick={() => setMode('approve')}>
            Approve
          </button>
          <button type="button" className={buttonClass} onClick={() => setMode('reject')}>
            Reject…
          </button>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="space-y-3 rounded-lg border border-line-strong p-3"
          aria-label={mode === 'approve' ? 'Approve this request' : 'Reject this request'}
        >
          {mode === 'reject' ? (
            <ReasonField
              value={reason}
              onChange={setReason}
              source="approval-reasons"
              showComment={false}
            />
          ) : null}
          <div>
            <label htmlFor={`${uid}-c`} className={labelClass}>
              {mode === 'reject'
                ? 'What should the requester change? (required)'
                : 'Comment (optional)'}
            </label>
            <textarea
              id={`${uid}-c`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              required={mode === 'reject'}
              className={fieldClass}
            />
          </div>
          <Notice message={message} />
          <div className="flex flex-wrap gap-2">
            {mode === 'approve' ? (
              <button type="submit" className={primaryButtonClass} disabled={busy}>
                {busy ? 'Approving…' : 'Confirm approval'}
              </button>
            ) : (
              <button
                type="submit"
                className={dangerButtonClass}
                disabled={busy || reason.code === ''}
              >
                {busy ? 'Rejecting…' : 'Confirm rejection'}
              </button>
            )}
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setMode(null)}
            >
              Back
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
