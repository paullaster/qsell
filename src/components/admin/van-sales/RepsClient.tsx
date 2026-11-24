'use client';

import { use, useId, useState } from 'react';
import { createRepAction, repsPageAction, setRepStatusAction, updateRepAction, type RepsPage } from '@/server/domains/van-sales/actions';
import type { RepView } from '@/server/domains/van-sales/reps';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { usePagedList } from '@/components/ui/usePagedList';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { REP_MODES, REP_MODE_WORDS, REP_STATUS_WORDS, modesWords, type RepMode } from '@/lib/van-sales/people';
import { WhyPanel } from './WhyPanel';

type Loaded = Awaited<ReturnType<typeof repsPageAction>>;
type Filter = 'active' | 'paused' | 'ended' | 'all';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'active', label: 'Selling' },
  { id: 'paused', label: 'Paused' },
  { id: 'ended', label: 'Ended' },
  { id: 'all', label: 'All' },
];
const TONE = { active: 'green', paused: 'amber', ended: 'gray' } as const;
const kes = (n: number): string => `KES ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;

const creditWords = (rep: Pick<RepView, 'maySellOnCredit' | 'maxCreditPerDay'>): string => {
  if (!rep.maySellOnCredit) return 'Not allowed';
  return rep.maxCreditPerDay === 0 ? 'No limit' : kes(rep.maxCreditPerDay);
};

export function RepsClient({ firstPromise }: { firstPromise: ReturnType<typeof repsPageAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body first={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ first }: { first: RepsPage }) {
  const uid = useId();
  const [status, setStatus] = useState<Filter>('active');
  const [text, setText] = useState('');
  const query = useDebouncedValue(text.trim(), 300);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const list = usePagedList<RepView, { query: string; status: Filter }>({
    load: (f, cursor) => repsPageAction({ query: f.query, status: f.status, cursor }),
    filters: { query, status },
    initialPage: { ok: true, data: { rows: first.rows, nextCursor: first.nextCursor } },
  });
  const done = (message: string) => {
    setNotice({ kind: 'ok', text: message });
    list.reload();
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Sales reps"
        intro="The people who sell outside: from a van, by taking orders, or both. Each has limits for what they may do on their own, such as the most discount they may give and the most credit in a day."
        actions={first.canManage && !adding ? <button type="button" className={primaryClass} onClick={() => { setNotice(null); setAdding(true); }}>Add a sales rep</button> : null}
      />
      <Message notice={notice} />
      {adding ? (
        <section className={`${cardClass} space-y-3`} aria-label="Add a sales rep">
          <h2 className="text-sm font-bold text-fg-strong">Add a sales rep</h2>
          <RepForm onCancel={() => setAdding(false)} onSaved={(r) => { setAdding(false); done(`${r.name} is now a sales rep.`); }} />
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <label htmlFor={`${uid}-q`} className="sr-only">Search sales reps</label>
          <input id={`${uid}-q`} type="search" className={fieldClass} placeholder="Search by name, email or phone" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </div>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`${buttonClass} ${status === f.id ? 'border-indigo-500 bg-indigo-500/10' : ''}`} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>{f.label}</button>
          ))}
        </div>
      </div>

      {list.phase === 'error' ? <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p> : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading…</p> : null}
      <ul className="space-y-3" aria-label="Sales reps">
        {list.rows.map((r) => <RepRow key={r.id} rep={r} canManage={first.canManage} onDone={done} onError={(t) => setNotice({ kind: 'error', text: t })} />)}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
          {query === '' && status === 'active' ? 'No sales rep yet. Add a member of staff to let them sell from a van or take orders on a route.' : 'No sales rep matches that.'}
        </p>
      ) : null}
      {list.cursor !== null ? <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>{list.phase === 'more' ? 'Loading…' : 'Show more'}</button> : null}
    </div>
  );
}

function RepRow({ rep, canManage, onDone, onError }: { rep: RepView; canManage: boolean; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'pause' | 'end'>('view');
  const [busy, setBusy] = useState(false);
  const run = async (status: 'active' | 'paused' | 'ended', reason: string | undefined, text: string) => {
    setBusy(true);
    const r = await attempt(setRepStatusAction({ id: rep.id, status, reason, expectedVersion: rep.version }));
    setBusy(false);
    if (r.ok) { setMode('view'); onDone(text); } else onError(r.error);
  };
  return (
    <li className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-48 text-base font-semibold text-fg-strong">{rep.name}</p>
        <Chip tone={TONE[rep.status]}>{REP_STATUS_WORDS[rep.status]}</Chip>
        <Chip tone="sky">{modesWords(rep.modes)}</Chip>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2"><dt className="text-fg-muted">Email</dt><dd className="break-all">{rep.email ?? 'None'}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Phone</dt><dd>{rep.phone ?? 'Not given'}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Home branch</dt><dd>{rep.homeBranchName ?? 'Any branch'}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Discount up to</dt><dd>{rep.maxDiscountPercent === 0 ? 'None allowed' : `${String(rep.maxDiscountPercent)}%`}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Credit a day</dt><dd>{creditWords(rep)}</dd></div>
        <div className="flex gap-2"><dt className="text-fg-muted">Change a price</dt><dd>{rep.mayOverridePrice ? 'Allowed' : 'Not allowed'}</dd></div>
      </dl>
      {rep.status !== 'active' && rep.statusReason !== null ? <p className="text-sm text-fg-muted">{rep.status === 'paused' ? 'Paused' : 'Ended'} because: {rep.statusReason}</p> : null}
      {canManage && mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          {rep.status === 'ended' ? null : <button type="button" className={buttonClass} onClick={() => setMode('edit')} aria-label={`Change ${rep.name}`}>Change</button>}
          {rep.status === 'active' ? <button type="button" className={buttonClass} onClick={() => setMode('pause')} aria-label={`Pause ${rep.name}`}>Pause</button> : null}
          {rep.status === 'active' || rep.status === 'paused' ? <button type="button" className={buttonClass} onClick={() => setMode('end')} aria-label={`End ${rep.name}`}>End work as a rep</button> : null}
          {rep.status === 'active' ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void run('active', undefined, `${rep.name} is selling again.`)}>Put back to work</button>}
        </div>
      ) : null}
      {mode === 'edit' ? <RepForm rep={rep} onCancel={() => setMode('view')} onSaved={(r) => { setMode('view'); onDone(`${r.name} saved.`); }} /> : null}
      {mode === 'pause' ? <WhyPanel label={`Pause ${rep.name}`} action="Pause" busy={busy} onCancel={() => setMode('view')} onConfirm={(reason) => void run('paused', reason, `${rep.name} is paused and cannot sell until put back to work.`)} /> : null}
      {mode === 'end' ? <WhyPanel label={`End ${rep.name}`} action="End their work as a rep" busy={busy} onCancel={() => setMode('view')} onConfirm={(reason) => void run('ended', reason, `${rep.name} no longer sells. Their past days keep their name.`)} /> : null}
    </li>
  );
}

function RepForm({ rep, onSaved, onCancel }: { rep?: RepView; onSaved: (rep: RepView) => void; onCancel: () => void }) {
  const uid = useId();
  const [person, setPerson] = useState<Choice | null>(null);
  const [phone, setPhone] = useState(rep?.phone ?? '');
  const [branch, setBranch] = useState<Choice | null>(rep?.homeBranchId === null || rep === undefined ? null : { id: rep.homeBranchId, label: rep.homeBranchName ?? 'Branch' });
  const [modes, setModes] = useState<RepMode[]>(rep?.modes ?? ['van_sell', 'pre_sell']);
  const [discount, setDiscount] = useState(String(rep?.maxDiscountPercent ?? 0));
  const [credit, setCredit] = useState(String(rep?.maxCreditPerDay ?? 0));
  const [price, setPrice] = useState(rep?.mayOverridePrice ?? false);
  const [onCredit, setOnCredit] = useState(rep?.maySellOnCredit ?? false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submitWords = rep === undefined ? 'Add the sales rep' : 'Save';
  const toggle = (m: RepMode) => setModes((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : REP_MODES.filter((x) => x === m || cur.includes(x))));
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const body = { phone, homeBranchId: branch?.id ?? null, modes, limits: { maxDiscountPercent: Number(discount), maxCreditPerDay: Number(credit), mayOverridePrice: price, maySellOnCredit: onCredit } };
    const r = await attempt(rep === undefined ? createRepAction({ ...body, userId: person?.id ?? '' }) : updateRepAction({ ...body, id: rep.id, expectedVersion: rep.version }));
    setBusy(false);
    if (r.ok) onSaved(r.data);
    else setProblem(r.error);
  };
  return (
    <form aria-label={rep === undefined ? 'New sales rep' : `Change ${rep.name}`} className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {rep === undefined ? (
        <ChoicePicker label="Member of staff" source="van-staff" choice={person} onChoice={setPerson} placeholder="Search staff by name or email…" required />
      ) : (
        <Field id={`${uid}-who`} label="Member of staff" hint="The person stays the same. To use another person, add them as a new rep."><input id={`${uid}-who`} className={fieldClass} value={rep.name} readOnly /></Field>
      )}
      <Field id={`${uid}-phone`} label="Phone (optional)" hint="Shown to the office and on the rep's days">
        <input id={`${uid}-phone`} className={fieldClass} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
      </Field>
      <ChoicePicker label="Home branch (optional)" source="van-branches" choice={branch} onChoice={setBranch} placeholder="Any branch" clearable />
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-semibold text-fg-strong">What the rep does</legend>
        {REP_MODES.map((m) => (
          <label key={m} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={modes.includes(m)} onChange={() => toggle(m)} />
            {REP_MODE_WORDS[m]}
          </label>
        ))}
      </fieldset>
      <Field id={`${uid}-disc`} label="Most discount the rep may give (%)" hint="0 for none">
        <input id={`${uid}-disc`} className={fieldClass} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} autoComplete="off" />
      </Field>
      <Field id={`${uid}-credit`} label="Most credit in one day (KES)" hint="0 for no limit, when they may sell on credit">
        <input id={`${uid}-credit`} className={fieldClass} inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} autoComplete="off" />
      </Field>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={onCredit} onChange={(e) => setOnCredit(e.target.checked)} />
        May sell on credit
      </label>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={price} onChange={(e) => setPrice(e.target.checked)} />
        May change a price
      </label>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700 sm:col-span-2">{problem}</p>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : submitWords}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
