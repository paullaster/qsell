'use client';

import { use, useId, useState } from 'react';
import { createVanAction, setVanActiveAction, updateVanAction, vansPageAction, type VansPage } from '@/server/domains/van-sales/actions';
import type { VanView } from '@/server/domains/van-sales/vans';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { usePagedList } from '@/components/ui/usePagedList';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { NAME_LIMIT, VAN_STATUS_WORDS } from '@/lib/van-sales/people';
import { WhyPanel } from './WhyPanel';

type Loaded = Awaited<ReturnType<typeof vansPageAction>>;
type Status = 'active' | 'stopped' | 'all';
const FILTERS: { id: Status; label: string }[] = [
  { id: 'active', label: 'In use' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'all', label: 'All' },
];
const kes = (n: number): string => `KES ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;

export function VansClient({ firstPromise }: { firstPromise: ReturnType<typeof vansPageAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body first={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ first }: { first: VansPage }) {
  const uid = useId();
  const [status, setStatus] = useState<Status>('active');
  const [text, setText] = useState('');
  const query = useDebouncedValue(text.trim(), 300);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const list = usePagedList<VanView, { query: string; status: Status }>({
    load: (f, cursor) => vansPageAction({ query: f.query, status: f.status, cursor }),
    filters: { query, status },
    initialPage: { ok: true, data: { rows: first.rows, nextCursor: first.nextCursor } },
  });
  const done = (text2: string) => {
    setNotice({ kind: 'ok', text: text2 });
    list.reload();
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Vans"
        intro="A van is a place that holds stock and a till that holds cash, made together. Stock on a van is for that van's reps to sell; no shop, quote or warehouse order can take it."
        actions={first.canManage && !adding ? <button type="button" className={primaryClass} onClick={() => { setNotice(null); setAdding(true); }}>Add a van</button> : null}
      />
      <Message notice={notice} />
      {adding ? (
        <section className={`${cardClass} space-y-3`} aria-label="Add a van">
          <h2 className="text-sm font-bold text-fg-strong">Add a van</h2>
          <VanForm onCancel={() => setAdding(false)} onSaved={(v) => { setAdding(false); done(`${v.name} added. Its stock place is ${v.locationCode} and its till is ready.`); }} />
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <label htmlFor={`${uid}-q`} className="sr-only">Search vans</label>
          <input id={`${uid}-q`} type="search" className={fieldClass} placeholder="Search by name or stock code" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </div>
        <div role="group" aria-label="Show" className="flex gap-1">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`${buttonClass} ${status === f.id ? 'border-indigo-500 bg-indigo-500/10' : ''}`} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>{f.label}</button>
          ))}
        </div>
      </div>

      {list.phase === 'error' ? <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p> : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading…</p> : null}
      <ul className="space-y-3" aria-label="Vans">
        {list.rows.map((v) => <VanRow key={v.id} van={v} canManage={first.canManage} onDone={done} onError={(t) => setNotice({ kind: 'error', text: t })} />)}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
          {query === '' && status === 'active' ? 'No van yet. Add the first one to give a rep stock and a till to sell from.' : 'No van matches that.'}
        </p>
      ) : null}
      {list.cursor !== null ? <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>{list.phase === 'more' ? 'Loading…' : 'Show more'}</button> : null}
    </div>
  );
}

function VanRow({ van, canManage, onDone, onError }: { van: VanView; canManage: boolean; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'stop'>('view');
  const [busy, setBusy] = useState(false);
  const run = async (call: ReturnType<typeof setVanActiveAction>, text: string) => {
    setBusy(true);
    const r = await attempt(call);
    setBusy(false);
    if (r.ok) { setMode('view'); onDone(text); } else onError(r.error);
  };
  const stopped = van.status === 'stopped';
  return (
    <li className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-48 text-base font-semibold text-fg-strong">{van.name}</p>
        <Chip tone={stopped ? 'gray' : 'green'}>{VAN_STATUS_WORDS[van.status]}</Chip>
        {van.shiftOpen ? <Chip tone="sky">Till open</Chip> : null}
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2"><dt className="text-fg-muted">Branch</dt><dd>{van.branchName}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Stock place</dt><dd className="font-mono">{van.locationCode}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Vehicle</dt><dd>{van.vehicleName ?? 'None chosen'}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Till cash kept in</dt><dd>{van.cashAccountName ?? 'Not chosen'}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Cash limit</dt><dd>{van.maxCash === null ? 'No limit' : kes(van.maxCash)}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Stock on the van</dt><dd>{van.productsOnVan === 0 ? 'None' : `${String(van.productsOnVan)} product${van.productsOnVan === 1 ? '' : 's'}`}</dd></div>
      </dl>
      {stopped && van.statusReason !== null ? <p className="text-sm text-fg-muted">Stopped because: {van.statusReason}</p> : null}
      {canManage && mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          {stopped ? null : <button type="button" className={buttonClass} onClick={() => setMode('edit')} aria-label={`Change ${van.name}`}>Change</button>}
          {stopped ? (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(setVanActiveAction({ id: van.id, active: true, expectedVersion: van.version }), `${van.name} is in use again.`)}>Use again</button>
          ) : (
            <button type="button" className={buttonClass} onClick={() => setMode('stop')} aria-label={`Stop ${van.name}`}>Stop this van</button>
          )}
        </div>
      ) : null}
      {mode === 'edit' ? <VanForm van={van} onCancel={() => setMode('view')} onSaved={(v) => { setMode('view'); onDone(`${v.name} saved.`); }} /> : null}
      {mode === 'stop' ? (
        <WhyPanel label={`Stop ${van.name}`} action="Stop the van" busy={busy} onCancel={() => setMode('view')} onConfirm={(reason) => void run(setVanActiveAction({ id: van.id, active: false, reason, expectedVersion: van.version }), `${van.name} is stopped. Its stock place and till are stopped with it.`)} />
      ) : null}
    </li>
  );
}

function VanForm({ van, onSaved, onCancel }: { van?: VanView; onSaved: (van: VanView) => void; onCancel: () => void }) {
  const uid = useId();
  const [name, setName] = useState(van?.name ?? '');
  const [branch, setBranch] = useState<Choice | null>(van === undefined ? null : { id: van.branchId, label: van.branchName });
  const [vehicle, setVehicle] = useState<Choice | null>(van?.vehicleId === null || van === undefined ? null : { id: van.vehicleId, label: van.vehicleName ?? 'Vehicle' });
  const [cash, setCash] = useState<Choice | null>(van?.cashAccountId === null || van === undefined ? null : { id: van.cashAccountId, label: van.cashAccountName ?? 'Cash account' });
  const [maxCash, setMaxCash] = useState(van?.maxCash === null || van === undefined ? '' : String(van.maxCash));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submitWords = van === undefined ? 'Add the van' : 'Save';
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const body = { name, branchId: branch?.id ?? '', vehicleId: vehicle?.id ?? null, cashAccountId: cash?.id ?? null, maxCash: maxCash.trim() === '' ? null : Number(maxCash) };
    const r = await attempt(van === undefined ? createVanAction(body) : updateVanAction({ ...body, id: van.id, expectedVersion: van.version }));
    setBusy(false);
    if (r.ok) onSaved(r.data);
    else setProblem(r.error);
  };
  return (
    <form aria-label={van === undefined ? 'New van' : `Change ${van.name}`} className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field id={`${uid}-name`} label="Name or plate" hint={`${String(NAME_LIMIT.min)} to ${String(NAME_LIMIT.max)} characters, for example KDA 123X or Kiambu van`}>
        <input id={`${uid}-name`} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_LIMIT.max} autoComplete="off" autoFocus />
      </Field>
      {van === undefined ? (
        <ChoicePicker label="Branch" source="van-branches" choice={branch} onChoice={setBranch} placeholder="Choose the branch…" required />
      ) : (
        <Field id={`${uid}-branch`} label="Branch" hint="A van stays in its branch. To move it, add a new van there."><input id={`${uid}-branch`} className={fieldClass} value={van.branchName} readOnly /></Field>
      )}
      <ChoicePicker label="Vehicle (optional)" source="van-vehicles" choice={vehicle} onChoice={setVehicle} placeholder="Choose from the vehicles…" clearable />
      <ChoicePicker label="Cash account for the till (optional)" source="van-cash-accounts" choice={cash} onChoice={setCash} placeholder="Where the van's cash is kept…" clearable />
      <Field id={`${uid}-max`} label="Most cash the van should hold (KES, optional)" hint="Empty for no limit">
        <input id={`${uid}-max`} className={fieldClass} inputMode="decimal" value={maxCash} onChange={(e) => setMaxCash(e.target.value)} autoComplete="off" />
      </Field>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700 sm:col-span-2">{problem}</p>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : submitWords}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
