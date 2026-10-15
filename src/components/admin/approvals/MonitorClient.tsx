'use client';

import { use, useCallback, useId, useState } from 'react';
import { adminCancelRequestAction, pendingCountsAction, pendingPageAction, rerouteEntryAction, sweepOverdueNowAction, type PendingRequest } from '@/server/kernel/approvals/actions';
import { DOCUMENT_KIND_LABELS } from '@/server/kernel/approvals/domain/triggers';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import { Chip, EmptyState, Notice, PageHeader, When, buttonClass, cardClass, fieldClass, labelClass, money, primaryButtonClass, type Message } from './shared';

type FirstPage = Extract<Awaited<ReturnType<typeof pendingPageAction>>, { ok: true }>;
type Counts = Extract<Awaited<ReturnType<typeof pendingCountsAction>>, { ok: true }>['data'];

interface Props {
  firstPage: ReturnType<typeof pendingPageAction>;
  counts: ReturnType<typeof pendingCountsAction>;
}

export function MonitorClient({ firstPage, counts }: Props) {
  const first = use(firstPage);
  const total = use(counts);
  if (!first.ok) return <LoadFailed error={first.error} />;
  if (!total.ok) return <LoadFailed error={total.error} />;
  return <Monitor first={first} initialCounts={total.data} />;
}

function Monitor({ first, initialCounts }: { first: FirstPage; initialCounts: Counts }) {
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [counts, setCounts] = useState(initialCounts);
  const [message, setMessage] = useState<Message>(null);
  const [sweeping, setSweeping] = useState(false);

  const list = usePagedList<PendingRequest, { overdueOnly: boolean }>({
    load: (filters, cursor) => pendingPageAction({ cursor, overdueOnly: filters.overdueOnly }),
    filters: { overdueOnly },
    initialPage: first,
  });

  const refresh = useCallback(async () => {
    const fresh = await attempt(pendingCountsAction());
    if (fresh.ok) setCounts(fresh.data);
    list.reload();
  }, [list]);

  const sweep = async () => {
    setSweeping(true);
    setMessage(null);
    const res = await attempt(sweepOverdueNowAction());
    setSweeping(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    const { escalated, stuck } = res.data;
    setMessage({ kind: 'ok', text: escalated + stuck === 0 ? 'Nothing was overdue.' : `${String(escalated)} handed to the next approver up. ${String(stuck)} had nobody above to take it: reroute those below.` });
    await refresh();
  };

  const done = (text: string) => {
    setMessage({ kind: 'ok', text });
    void refresh();
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Approval monitor">
        Everything waiting on someone, oldest first. Overdue approvals are handed to the approver’s own approver automatically, every five minutes. If nobody is above them, reroute the request
        here.
      </PageHeader>
      <div className="flex flex-wrap items-center gap-4">
        <p className="text-sm text-fg" aria-live="polite">
          {counts.waiting} waiting · {counts.overdue} overdue
        </p>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="size-4" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          Overdue only
        </label>
        <button type="button" className={`${buttonClass} ml-auto`} disabled={sweeping} onClick={() => void sweep()}>
          {sweeping ? 'Checking…' : 'Escalate overdue now'}
        </button>
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
      {list.phase === 'idle' && list.rows.length === 0 ? <EmptyState title={overdueOnly ? 'Nothing is overdue' : 'Nothing is waiting for approval'} /> : null}
      <ul className="space-y-3" aria-label="Waiting requests">
        {list.rows.map((r) => (
          <li key={r.requestId}>
            <Row request={r} onDone={done} />
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more requests'}
        </button>
      )}
    </div>
  );
}

function Row({ request: r, onDone }: { request: PendingRequest; onDone: (text: string) => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>(null);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await attempt(adminCancelRequestAction(r.submissionId, reason));
    setBusy(false);
    if (!res.ok) {
      setError({ kind: 'error', text: res.error });
      return;
    }
    onDone('The request was withdrawn.');
  };

  return (
    <article className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-fg-strong">{r.triggerLabel}</h3>
          <p className="font-mono text-xs break-all text-fg-muted">
            {DOCUMENT_KIND_LABELS[r.documentKind] ?? r.documentKind} · {r.documentId}
          </p>
          <p className="mt-2 text-sm text-fg">
            {money(r.amount)} · from {r.requestedByName}
            {has(r.oldestWaitingSince) ? (
              <>
                {' '}
                · waiting <When iso={r.oldestWaitingSince} />
              </>
            ) : null}
          </p>
          <ul className="mt-2 space-y-2">
            {r.entries.length === 0 ? <li className="text-sm text-red-700">Waiting on nobody: check this one.</li> : r.entries.map((e) => <EntryLine key={e.entryId} entry={e} onDone={onDone} />)}
          </ul>
        </div>
        <button type="button" className={buttonClass} aria-expanded={open} onClick={() => setOpen(!open)}>
          Withdraw…
        </button>
      </div>
      {open ? (
        <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3 border-t border-line pt-4">
          <div>
            <label htmlFor={`${uid}-r`} className={labelClass}>
              Why is this being withdrawn?
            </label>
            <textarea id={`${uid}-r`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required className={fieldClass} />
          </div>
          <Notice message={error} />
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy || reason.trim() === ''}>
              Withdraw request
            </button>
            <button type="button" className={buttonClass} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}

function EntryLine({ entry, onDone }: { entry: PendingRequest['entries'][number]; onDone: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<Choice | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>(null);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (to === null) return;
    setBusy(true);
    setError(null);
    const res = await attempt(rerouteEntryAction(entry.entryId, to.id, reason));
    setBusy(false);
    if (!res.ok) {
      setError({ kind: 'error', text: res.error });
      return;
    }
    setOpen(false);
    onDone(`Rerouted from ${entry.approverName}.`);
  };

  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg">Waiting on {entry.approverName}</span>
        {entry.handedOver ? <Chip tone="amber">Handed over</Chip> : null}
        {entry.overdue ? <Chip tone="red">Overdue</Chip> : null}
        {entry.stuck ? <Chip tone="red">Nobody above to escalate to</Chip> : null}
        <button type="button" className={`${buttonClass} ml-auto`} aria-expanded={open} onClick={() => setOpen(!open)}>
          Reroute…
        </button>
      </div>
      {open ? (
        <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3" aria-label={`Reroute from ${entry.approverName}`}>
          <ChoicePicker label="Hand it to" source="approval-users" choice={to} onChoice={setTo} placeholder="Choose a person…" required />
          <ReasonField value={reason} onChange={setReason} source="approval-config-reasons" />
          <Notice message={error} />
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy || to === null || reason.code === ''}>
              {busy ? 'Rerouting…' : 'Reroute'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
