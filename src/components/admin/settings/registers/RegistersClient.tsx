'use client';

import { use, useId, useState } from 'react';
import { saveRegisterAction, saveShiftSettingsAction, type registersScreenAction, type RegistersScreen } from '@/server/domains/selling/shifts/shift-actions';
import type { RegisterRow } from '@/server/domains/selling/shifts/shift-service';
import type { SupervisorClose } from '@/server/domains/selling/shifts/shift-rules';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { ReasonField, type ReasonValue } from '../numbering/ReasonField';

type Loaded = Awaited<ReturnType<typeof registersScreenAction>>;

export function RegistersClient({ firstPromise }: { firstPromise: ReturnType<typeof registersScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: RegistersScreen }) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const done = (next: RegistersScreen, text: string) => {
    setData(next);
    setEditing(null);
    setNotice({ kind: 'ok', text });
  };
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Registers" intro="The tills of each branch, where cash sales are rung up in a shift. A person opens a shift on a till with the float counted and closes it with the cash counted; a till that is out by more than the limit below can only be closed by a supervisor." />
      <Message notice={notice} />
      <section className="space-y-3" aria-label="Tills">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-wider text-fg-subtle uppercase">Tills</h2>
          {editing === null ? <button type="button" className={primaryClass} onClick={() => { setNotice(null); setEditing('new'); }}>Add a till</button> : null}
        </div>
        {editing === 'new' ? <TillEditor key="new" onCancel={() => setEditing(null)} onSaved={done} /> : null}
        {data.registers.length === 0 && editing !== 'new' ? <p className="rounded-xl border border-line bg-surface-raised p-6 text-sm text-fg-muted" data-testid="registers-empty">No tills yet. Add one to start taking cash sales.</p> : null}
        <ul className="space-y-2" aria-label="Tills" data-testid="registers">
          {data.registers.map((r) => (
            <li key={r.id} className={cardClass} data-testid="register">
              {editing === r.id ? <TillEditor register={r} onCancel={() => setEditing(null)} onSaved={done} /> : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold break-words text-fg-strong">{r.name}</p>
                    <p className="text-sm text-fg-muted">{r.branchName} · {r.cashAccountName === null ? 'no cash account yet' : `cash kept in ${r.cashAccountName}`}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={r.isActive ? 'green' : 'gray'}>{r.isActive ? 'In use' : 'Switched off'}</Chip>
                    {r.openBy === null ? null : <Chip tone="amber">{`Shift open: ${r.openBy}`}</Chip>}
                    <button type="button" className={buttonClass} aria-label={`Change ${r.name}`} onClick={() => { setNotice(null); setEditing(r.id); }}>Change</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <ToleranceForm data={data} onSaved={done} />
    </div>
  );
}

function TillEditor({ register, onCancel, onSaved }: { register?: RegisterRow; onCancel: () => void; onSaved: (next: RegistersScreen, text: string) => void }) {
  const uid = useId();
  const [name, setName] = useState(register?.name ?? '');
  const [branch, setBranch] = useState<Choice | null>(register === undefined ? null : { id: register.branchId, label: register.branchName });
  const [active, setActive] = useState(register?.isActive ?? true);
  const [cash, setCash] = useState<Choice | null>(register?.cashAccountId === null || register === undefined ? null : { id: register.cashAccountId, label: register.cashAccountName ?? '' });
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    if (branch === null) return;
    setBusy(true);
    setProblem(null);
    const r = await attempt(saveRegisterAction({ ...(register === undefined ? {} : { id: register.id }), name, branchId: branch.id, isActive: active, cashAccountId: cash?.id ?? null }, reason));
    setBusy(false);
    if (r.ok) onSaved(r.data, register === undefined ? 'Till added.' : 'Till saved.');
    else setProblem(r.error);
  };
  return (
    <form aria-label={register === undefined ? 'Add a till' : `Change ${register.name}`} className={`${register === undefined ? cardClass : ''} space-y-3`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${uid}-name`} label="Name of the till"><input id={`${uid}-name`} className={fieldClass} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required /></Field>
        <ChoicePicker label="Branch" source="register-branches" choice={branch} onChoice={setBranch} placeholder="Choose the branch…" required />
      </div>
      <ChoicePicker label="Cash account (in the books)" source="register-cash-accounts" choice={cash} onChoice={setCash} placeholder="Where this till's cash is kept…" />
      <p className="text-sm text-fg-muted">A difference at the close is written against this account, so it can be put right in the books.</p>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={active} onChange={(e) => setActive(e.target.checked)} />
        In use (a till that is switched off cannot have a shift opened on it)
      </label>
      <ReasonField value={reason} onChange={setReason} source="shift-reasons" />
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy || reason.code === '' || branch === null || name.trim() === ''}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function ToleranceForm({ data, onSaved }: { data: RegistersScreen; onSaved: (next: RegistersScreen, text: string) => void }) {
  const uid = useId();
  const [amount, setAmount] = useState(String(data.tolerance.amount));
  const [percent, setPercent] = useState(String(data.tolerance.percent));
  const [mode, setMode] = useState<SupervisorClose>(data.supervisorClose);
  const [varianceGl, setVarianceGl] = useState<Choice | null>(data.varianceGlAccountId === null ? null : { id: data.varianceGlAccountId, label: data.varianceGlAccountName ?? '' });
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const r = await attempt(saveShiftSettingsAction({ amount: Number(amount), percent: Number(percent), supervisorClose: mode, varianceGlAccountId: varianceGl?.id ?? null }, reason));
    setBusy(false);
    if (r.ok) onSaved(r.data, 'Saved. It applies to the next shift that is closed.');
    else setProblem(r.error);
  };
  return (
    <form aria-label="How far a till may be out" className={`${cardClass} space-y-3`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 className="text-base font-bold text-fg-strong">How far a till may be out, and who closes it when it is</h2>
      <p className="text-sm text-fg-muted">A difference up to either of these is only given a reason. Beyond both, it needs a supervisor, or an approval, as chosen below.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${uid}-amount`} label="An amount (KES)"><input id={`${uid}-amount`} type="number" min={0} step="0.01" className={fieldClass} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field id={`${uid}-percent`} label="Or a percent of what the till should hold"><input id={`${uid}-percent`} type="number" min={0} max={100} step="0.1" className={fieldClass} value={percent} onChange={(e) => setPercent(e.target.value)} /></Field>
      </div>
      <ChoicePicker label="Account for till differences (cash over and short)" source="variance-gl-accounts" choice={varianceGl} onChoice={setVarianceGl} placeholder="An expense account, for example Cash over and short…" />
      <p className="text-sm text-fg-muted">The difference of a shift is written to the books at the close: a short till is an expense here, an over till income. Until this account and the cash account of the till are chosen, the difference waits (the shift is closed all the same) and is written as soon as they are.</p>
      <SegmentedChoice
        label="When a till is out by more than that"
        value={mode}
        options={[{ value: 'direct', label: 'A supervisor closes it' }, { value: 'approval', label: 'It goes to approval' }]}
        onChange={setMode}
      />
      <p className="text-sm text-fg-muted" data-testid="supervisor-close-help">
        {mode === 'direct'
          ? 'Someone with the supervisor permission closes the shift on the spot, with the reason, and it is recorded who did.'
          : 'The cashier asks for the close, the shift is held (no cash moves) and the approval workflow for "Till shift closed with a difference beyond the allowance" decides. Set that workflow up in Approvals first; until you do, a close beyond the allowance is refused with a message saying so. A supervisor still closes another person\'s shift on the spot.'}
      </p>
      <ReasonField value={reason} onChange={setReason} source="shift-reasons" />
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <button type="submit" className={primaryClass} disabled={busy || reason.code === ''}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}
