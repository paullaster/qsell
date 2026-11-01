'use client';

import { use, useId, useState } from 'react';
import { deliveryMethodsPageAction, setDeliveryMethodAction, type BranchMethodsView } from '@/server/domains/delivery/actions';
import { METHOD_WORDS, leadTimeWords } from '@/lib/delivery-methods';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, buttonClass, Chip, Field, fieldClass, LoadFailed, Message, PageHeader, primaryClass, type Notice } from '@/components/ui/screen-kit';

type FirstPage = Awaited<ReturnType<typeof deliveryMethodsPageAction>>;
type MethodRow = BranchMethodsView['methods'][number];

export function DeliveryMethodsClient({ firstPage, canManage }: { firstPage: ReturnType<typeof deliveryMethodsPageAction>; canManage: Promise<boolean> }) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <MethodsView first={first} may={may} /> : <LoadFailed error={first.error} />;
}

function MethodsView({ first, may }: { first: FirstPage; may: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const list = usePagedList<BranchMethodsView, { query: string }>({
    load: (filters, cursor) => deliveryMethodsPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Delivery methods" intro="How each branch gets an order to the customer. A method a branch does not offer is not offered for the orders that branch processes. The time is the least it takes from the order to the goods being ready or on their way." />
      <Message notice={notice} />
      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search branches
        </label>
        <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or name" className={fieldClass} autoComplete="off" />
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
      <ul className="space-y-3" aria-label="Branches">
        {list.rows.map((b) => (
          <li key={b.branchId} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <p className="text-sm font-bold break-words text-fg-strong">
              <span className="font-mono">{b.code}</span> · {b.name} {b.isActive ? null : <Chip tone="gray">Closed</Chip>}
            </p>
            <ul className="mt-3 space-y-3" aria-label={`Methods for ${b.name}`}>
              {b.methods.map((m) => (
                <MethodLine key={`${b.branchId}-${m.method}`} branch={b} row={m} may={may} onDone={(n) => { setNotice(n); if (n?.kind === 'ok') list.reload(); }} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted">{query.trim() === '' ? 'No branches yet.' : `No branches match “${query.trim()}”.`}</p> : null}
      {list.cursor !== null ? (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more branches'}
        </button>
      ) : null}
    </div>
  );
}

/** One method of one branch: offered or not, how long it takes to get ready, and a note for staff. Saved with its own button. */
function MethodLine({ branch, row, may, onDone }: { branch: BranchMethodsView; row: MethodRow; may: boolean; onDone: (n: Notice) => void }) {
  const uid = useId();
  const words = METHOD_WORDS[row.method];
  const [on, setOn] = useState(row.isActive);
  const [lead, setLead] = useState(String(row.leadTimeMinutes));
  const [note, setNote] = useState(row.note ?? '');
  const [busy, setBusy] = useState(false);
  const leadMinutes = Number.isFinite(Number(lead)) ? Number(lead) : 0;
  const changed = on !== row.isActive || lead !== String(row.leadTimeMinutes) || note.trim() !== (row.note ?? '');

  const save = async () => {
    setBusy(true);
    const res = await attempt(setDeliveryMethodAction(branch.branchId, row.method, { isActive: on, leadTimeMinutes: lead, note }));
    setBusy(false);
    onDone(res.ok ? { kind: 'ok', text: `${words.name} at ${branch.name} saved.` } : { kind: 'error', text: res.error });
  };

  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_9rem_minmax(0,1.4fr)_auto] sm:items-end"
        aria-label={`${words.name} at ${branch.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-fg-strong">
            <input type="checkbox" className="h-5 w-5 rounded border-line-strong" checked={on} disabled={!may || busy} onChange={(e) => setOn(e.target.checked)} />
            {words.name}
          </label>
          <p className="text-[11px] text-fg-muted">{words.means}</p>
        </div>
        <Field id={`${uid}-lead`} label="Time to prepare (minutes)" hint={on ? leadTimeWords(leadMinutes) : undefined}>
          <input id={`${uid}-lead`} inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value)} className={fieldClass} disabled={!may || busy || !on} autoComplete="off" />
        </Field>
        <Field id={`${uid}-note`} label="Note for staff (optional)">
          <input id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} className={fieldClass} disabled={!may || busy || !on} maxLength={200} autoComplete="off" />
        </Field>
        {may ? (
          <button type="submit" className={primaryClass} disabled={busy || !changed} aria-label={`Save ${words.name} at ${branch.name}`}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        ) : null}
      </form>
    </li>
  );
}
