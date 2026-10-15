'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  adminCancelRequestAction, rerouteEntryAction,
  sweepOverdueNowAction,
  type Lookups,
  type PendingRequest,
} from '@/server/kernel/approvals/actions';
import { DOCUMENT_KIND_LABELS } from '@/server/kernel/approvals/domain/triggers';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  When,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  money,
  primaryButtonClass,
  type Message,
} from './shared';

import { has } from '@/lib/values';

export function MonitorClient({
  requests,
  people,
}: {
  requests: PendingRequest[];
  people: Lookups['users'];
}) {
  const router = useRouter();
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [sweeping, setSweeping] = useState(false);
  const shown = requests.filter((r) => !overdueOnly || r.overdue);
  const overdue = requests.filter((r) => r.overdue).length;

  const sweep = async () => {
    setSweeping(true);
    setMessage(null);
    const res = await sweepOverdueNowAction();
    setSweeping(false);
    if (!res.ok) { setMessage({ kind: 'error', text: res.error }); return; }
    const { escalated, stuck } = res.data;
    setMessage({
      kind: 'ok',
      text:
        escalated + stuck === 0
          ? 'Nothing was overdue.'
          : `${escalated} handed to the next approver up. ${stuck} had nobody above to take it: reroute those below.`,
    });
    router.refresh();
  };

  const done = (text: string) => {
    setMessage({ kind: 'ok', text });
    router.refresh();
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Approval monitor">
        Everything waiting on someone, oldest first. Overdue approvals are handed to the approver’s
        own approver automatically, every five minutes. If nobody is above them, reroute the request
        here.
      </PageHeader>
      <div className="flex flex-wrap items-center gap-4">
        <p className="text-sm text-fg" aria-live="polite">
          {requests.length} waiting · {overdue} overdue
        </p>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="size-4"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />
          Overdue only
        </label>
        <button
          type="button"
          className={`${buttonClass} ml-auto`}
          disabled={sweeping}
          onClick={sweep}
        >
          {sweeping ? 'Checking…' : 'Escalate overdue now'}
        </button>
      </div>
      <Notice message={message} />
      {shown.length === 0 ? (
        <EmptyState
          title={requests.length === 0 ? 'Nothing is waiting for approval' : 'Nothing is overdue'}
        />
      ) : (
        <ul className="space-y-3">
          {shown.map((r) => (
            <li key={r.requestId}>
              <Row request={r} people={people} onDone={done} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  request: r,
  people,
  onDone,
}: {
  request: PendingRequest;
  people: Lookups['users'];
  onDone: (text: string) => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await adminCancelRequestAction(r.submissionId, reason);
    setBusy(false);
    if (!res.ok) { setError({ kind: 'error', text: res.error }); return; }
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
            {r.entries.length === 0 ? (
              <li className="text-sm text-red-700">Waiting on nobody: check this one.</li>
            ) : (
              r.entries.map((e) => (
                <EntryLine key={e.entryId} entry={e} people={people} onDone={onDone} />
              ))
            )}
          </ul>
        </div>
        <button
          type="button"
          className={buttonClass}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Withdraw…
        </button>
      </div>
      {open ? (
        <form onSubmit={submit} className="mt-4 space-y-3 border-t border-line pt-4">
          <div>
            <label htmlFor={`${uid}-r`} className={labelClass}>
              Why is this being withdrawn?
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

function EntryLine({
  entry,
  people,
  onDone,
}: {
  entry: PendingRequest['entries'][number];
  people: Lookups['users'];
  onDone: (text: string) => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await rerouteEntryAction(entry.entryId, to, reason);
    setBusy(false);
    if (!res.ok) { setError({ kind: 'error', text: res.error }); return; }
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
        <button
          type="button"
          className={`${buttonClass} ml-auto`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Reroute…
        </button>
      </div>
      {open ? (
        <form
          onSubmit={submit}
          className="mt-3 space-y-3"
          aria-label={`Reroute from ${entry.approverName}`}
        >
          <div>
            <label htmlFor={`${uid}-to`} className={labelClass}>
              Hand it to
            </label>
            <select
              id={`${uid}-to`}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              className={fieldClass}
            >
              <option value="">Choose a person…</option>
              {people.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <ReasonField value={reason} onChange={setReason} source="approval-config-reasons" />
          <Notice message={error} />
          <div className="flex gap-2">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={busy || to === '' || reason.code === ''}
            >
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
