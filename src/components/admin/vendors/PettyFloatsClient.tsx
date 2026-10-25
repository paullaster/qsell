'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { saveFloatAction, setFloatActiveAction, type pettyFloatsAction } from '@/server/domains/vendors/petty-cash-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { fmt } from '@/lib/petty-cash';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof pettyFloatsAction>>, { ok: true }>['data'];

export function PettyFloatsClient({ initialPromise }: { initialPromise: ReturnType<typeof pettyFloatsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <Floats data={res.data} /> : <LoadFailed error={res.error} />;
}

function Floats({ data }: { data: Data }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const toggle = async (id: string, active: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(setFloatActiveAction(id, active));
    setBusy(false);
    if (!res.ok) setNotice({ kind: 'error', text: res.error });
    else router.refresh();
  };
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Petty cash" intro="Cash kept for small payments. Each float has one person looking after it, limits, and a level it is topped back up to." actions={data.can.manage ? <button type="button" className={primaryClass} onClick={() => setEditing(true)}>New float</button> : undefined} />
      <Message notice={notice} />
      {editing ? <FloatForm onDone={() => { setEditing(false); router.refresh(); }} /> : null}
      {data.floats.length === 0 ? <p className="text-sm text-fg-muted">There are no petty cash floats yet.</p> : (
        <ul className="space-y-2" aria-label="Floats">
          {data.floats.map((f) => (
            <li key={f.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
              <Link href={`/admin/vendors/petty-cash/${f.id}`} className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-fg-strong">{f.name} <span className="font-normal text-fg-muted">({f.code})</span></span>
                <span className="block text-xs text-fg-muted">Looked after by {f.custodianName} · limit {f.perVoucherLimit} a voucher, {f.dailyLimit} a day · topped up to {f.floatAmount}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg"><span>Cash in the float: <span className="font-semibold tabular-nums">{fmt(f.balanceCents)} {f.currency}</span></span>{f.low ? <Chip tone="red">Below its minimum</Chip> : null}{f.active ? null : <Chip tone="gray">Switched off</Chip>}{f.uncovered > 0 ? <Chip tone="amber">{String(f.uncovered)} paid, not yet topped up</Chip> : null}</span>
              </Link>
              {data.can.manage ? <FloatSwitch f={f} busy={busy} onToggle={toggle} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FloatForm({ onDone }: { onDone: () => void }) {
  const uid = useId();
  const [f, setF] = useState({ code: '', name: '', floatAmount: '', perVoucherLimit: '', dailyLimit: '', minimumBalance: '' });
  const [bank, setBank] = useState<Choice | null>(null);
  const [gl, setGl] = useState<Choice | null>(null);
  const [who, setWho] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveFloatAction(null, { ...f, bankAccountId: bank?.id ?? '', glAccountId: gl?.id ?? '', custodianId: who?.id ?? '' }));
    setBusy(false);
    if (!res.ok) setNotice({ kind: 'error', text: res.error });
    else onDone();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form className={`${cardClass} space-y-3`} aria-label="New float" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 className="text-sm font-bold text-fg-strong">New float</h2>
      <Message notice={notice} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-c`} label="Code"><input id={`${uid}-c`} value={f.code} maxLength={20} onChange={set('code')} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-n`} label="Name"><input id={`${uid}-n`} value={f.name} maxLength={120} onChange={set('name')} className={fieldClass} autoComplete="off" /></Field>
        <ChoicePicker label="Cash account the float is kept in" source="petty-cash-accounts" choice={bank} onChoice={setBank} placeholder="A cash account of its own" />
        <ChoicePicker label="Ledger account for the cash" source="petty-cash-gl-accounts" choice={gl} onChoice={setGl} placeholder="Search by number or name" />
        <ChoicePicker label="Looked after by" source="petty-custodians" choice={who} onChoice={setWho} placeholder="Search staff" />
        <Field id={`${uid}-fa`} label="Topped up to"><input id={`${uid}-fa`} inputMode="decimal" value={f.floatAmount} onChange={set('floatAmount')} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-pv`} label="Most one voucher may pay"><input id={`${uid}-pv`} inputMode="decimal" value={f.perVoucherLimit} onChange={set('perVoucherLimit')} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-dl`} label="Most that may be paid in a day"><input id={`${uid}-dl`} inputMode="decimal" value={f.dailyLimit} onChange={set('dailyLimit')} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-mb`} label="Minimum balance" hint="Below it, no new voucher can be written. Leave empty for none."><input id={`${uid}-mb`} inputMode="decimal" value={f.minimumBalance} onChange={set('minimumBalance')} className={fieldClass} autoComplete="off" /></Field>
      </div>
      <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Save the float</button><button type="button" className={buttonClass} onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function FloatSwitch({ f, busy, onToggle }: { f: { id: string; code: string; active: boolean }; busy: boolean; onToggle: (id: string, active: boolean) => Promise<void> }) {
  if (f.active) return <InlineConfirm label={`Switch off float ${f.code}`} action="Switch off" confirm="Yes, switch it off" busy={busy} onConfirm={() => void onToggle(f.id, false)} />;
  return <button type="button" className={buttonClass} disabled={busy} onClick={() => void onToggle(f.id, true)}>Switch on</button>;
}
