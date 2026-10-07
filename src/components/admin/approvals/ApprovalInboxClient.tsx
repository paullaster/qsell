'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  approveEntryAction,
  getRequestDetailAction,
  listApprovalReasonsAction,
  rejectEntryAction,
  type InboxItem,
  type RequestDetail,
} from '@/server/kernel/approvals/actions';
import { DOCUMENT_KIND_LABELS } from '@/server/kernel/approvals/domain/triggers';
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

export function ApprovalInboxClient({ items: initial }: { items: InboxItem[] }) {
  const uid = useId();
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [search, setSearch] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(
      (i) =>
        (!overdueOnly || i.overdue) &&
        (q === '' ||
          `${i.documentId} ${i.requestedByName} ${i.triggerLabel}`.toLowerCase().includes(q)),
    );
  }, [items, search, overdueOnly]);

  const done = useCallback(
    (entryId: string, text: string) => {
      setItems((list) => list.filter((i) => i.entryId !== entryId));
      setOpen(null);
      setMessage({ kind: 'ok', text });
      router.refresh();
    },
    [router],
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
            placeholder="Document, requester or type"
            className={fieldClass}
          />
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            className="size-4"
          />
          Overdue only
        </label>
        <p className="ml-auto text-xs text-fg-muted" aria-live="polite">
          {shown.length} of {items.length} shown
        </p>
      </div>

      <Notice message={message} />

      {items.length === 0 ? (
        <EmptyState title="Nothing is waiting on you">
          New requests appear here as soon as someone submits something you are asked to approve.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="No requests match your search" />
      ) : (
        <ul className="space-y-3">
          {shown.map((item) => (
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
            {item.onBehalfOfName ? (
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mode) return;
    setBusy(true);
    setMessage(null);
    const res =
      mode === 'approve'
        ? await approveEntryAction(item.entryId, comment)
        : await rejectEntryAction(item.entryId, reason.code, comment || reason.text);
    setBusy(false);
    if (!res.ok) return setMessage({ kind: 'error', text: res.error });
    onDone(item.entryId, res.data.message);
  };

  if (loadError)
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
        {detail.what ? (
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
                  {s.entries.map((e, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 text-sm text-fg">
                      <span>
                        {e.approverName}
                        {e.onBehalfOfName ? ` (for ${e.onBehalfOfName})` : ''}
                      </span>
                      <StatusChip status={e.status} />
                      {e.comment ? (
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
          {detail.timeline.map((t, i) => (
            <li key={i} className="text-sm text-fg">
              <span className="font-medium">{actionLabel(t.action)}</span> · {t.actorName} ·{' '}
              <When iso={t.at} />
              {t.reason ? <span className="block text-xs text-fg-muted">{t.reason}</span> : null}
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
              load={listApprovalReasonsAction}
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
