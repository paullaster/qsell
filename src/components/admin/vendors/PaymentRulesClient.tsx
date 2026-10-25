'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { savePaymentAccountsAction, saveWithholdingCodeAction, type paymentRulesAction } from '@/server/domains/vendors/payment-terms-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Rules = Extract<Awaited<ReturnType<typeof paymentRulesAction>>, { ok: true }>['data'];

export function PaymentRulesClient({ initialPromise }: { initialPromise: ReturnType<typeof paymentRulesAction> }) {
  const res = use(initialPromise);
  return res.ok ? <Rules rules={res.data} /> : <LoadFailed error={res.error} />;
}

function Rules({ rules }: { rules: Rules }) {
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Payment rules" intro="How vendors are paid: the tax withheld, and the accounts payments are booked to." actions={<Link href="/admin/vendors/certificates" className={buttonClass}>Withholding certificates</Link>} />
      <CodesPanel codes={rules.codes} />
      <AccountsPanel accounts={rules.accounts} />
    </div>
  );
}

const BASES: Choice[] = [{ id: 'net', label: 'The net amount (before tax)' }, { id: 'gross', label: 'Everything that is paid' }];

function CodesPanel({ codes }: { codes: Rules['codes'] }) {
  const uid = useId();
  const [rows, setRows] = useState(codes);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ code: '', name: '', ratePercent: '', base: 'net', active: true });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const edit = (c: Rules['codes'][number] | null) => {
    setEditing(c === null ? 'new' : c.id);
    setForm(c === null ? { code: '', name: '', ratePercent: '', base: 'net', active: true } : { code: c.code, name: c.name, ratePercent: c.ratePercent, base: c.base, active: c.active });
    setNotice(null);
  };
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveWithholdingCodeAction(editing === 'new' ? null : editing, form));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    const saved = { id: res.data.id, ...form, base: form.base === 'gross' ? ('gross' as const) : ('net' as const) };
    setRows((r) => (editing === 'new' ? [...r, saved] : r.map((x) => (x.id === saved.id ? saved : x))));
    setEditing(null);
    setNotice({ kind: 'ok', text: 'Saved.' });
  };
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Withholding tax codes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-fg-strong">Withholding tax codes</h2>
        <button type="button" className={buttonClass} onClick={() => edit(null)}>Add a code</button>
      </div>
      <p className="text-xs text-fg-muted">A code is a rate and what it is taken on. Give a vendor a code on its card, and tax is withheld from every payment to it.</p>
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">No codes yet.</p> : (
        <ul className="divide-y divide-line" aria-label="Codes">
          {rows.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-fg">
              <span><span className="font-semibold">{c.code}</span> · {c.name} · {c.ratePercent}% of {c.base === 'net' ? 'the net amount' : 'what is paid'} {c.active ? null : <Chip tone="gray">Off</Chip>}</span>
              <button type="button" className={buttonClass} onClick={() => edit(c)} aria-label={`Edit code ${c.code}`}>Edit</button>
            </li>
          ))}
        </ul>
      )}
      {editing === null ? null : (
        <form className="space-y-3 rounded-lg border border-line p-3" aria-label="Withholding code" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-c`} label="Code"><input id={`${uid}-c`} value={form.code} maxLength={20} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
            <Field id={`${uid}-n`} label="Name"><input id={`${uid}-n`} value={form.name} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
            <Field id={`${uid}-r`} label="Rate (%)"><input id={`${uid}-r`} inputMode="decimal" value={form.ratePercent} onChange={(e) => setForm((f) => ({ ...f, ratePercent: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
            <ChoicePicker label="Taken on" source="withholding-bases" choice={BASES.find((b) => b.id === form.base) ?? null} onChoice={(c) => setForm((f) => ({ ...f, base: c?.id ?? 'net' }))} placeholder="Choose" />
          </div>
          <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" className="h-4 w-4" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />In use</label>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Save the code</button><button type="button" className={buttonClass} onClick={() => setEditing(null)}>Cancel</button></div>
        </form>
      )}
    </section>
  );
}

function AccountsPanel({ accounts }: { accounts: Rules['accounts'] }) {
  const uid = useId();
  const [payables, setPayables] = useState<Choice | null>(accounts.payables);
  const [prepayments, setPrepayments] = useState<Choice | null>(accounts.prepayments);
  const [discount, setDiscount] = useState<Choice | null>(accounts.paymentDiscount);
  const [tolerance, setTolerance] = useState<Choice | null>(accounts.paymentTolerance);
  const [withholding, setWithholding] = useState<Choice | null>(accounts.withholdingPayable);
  const [amount, setAmount] = useState(accounts.toleranceAmount);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(savePaymentAccountsAction({ payables: payables?.id ?? '', prepayments: prepayments?.id ?? '', paymentDiscount: discount?.id ?? '', paymentTolerance: tolerance?.id ?? '', withholdingPayable: withholding?.id ?? '', toleranceAmount: amount }));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: 'Saved.' } : { kind: 'error', text: res.error });
  };
  return (
    <form className={`${cardClass} space-y-3`} aria-label="Payment accounts" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 className="text-sm font-bold text-fg-strong">Accounts payments are booked to</h2>
      <p className="text-xs text-fg-muted">These are the accounts of the vendor group “{accounts.groupName}”, which every vendor uses.</p>
      <Message notice={notice} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="What we owe vendors (payables)" source="payment-gl-accounts" choice={payables} onChoice={setPayables} placeholder="Search by number or name" />
        <ChoicePicker label="Advances paid (prepayments)" source="payment-gl-accounts" choice={prepayments} onChoice={setPrepayments} placeholder="Search by number or name" />
        <ChoicePicker label="Tax withheld (payable to the tax authority)" source="payment-gl-accounts" choice={withholding} onChoice={setWithholding} placeholder="Search by number or name" />
        <ChoicePicker label="Early-payment discounts received" source="payment-gl-accounts" choice={discount} onChoice={setDiscount} placeholder="Search by number or name" />
        <ChoicePicker label="Leftovers closed as tolerance" source="payment-gl-accounts" choice={tolerance} onChoice={setTolerance} placeholder="Search by number or name" />
        <Field id={`${uid}-tol`} label="Largest leftover that may be closed as tolerance" hint="0 turns it off."><input id={`${uid}-tol`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
      </div>
      <button type="submit" className={primaryClass} disabled={busy}>Save</button>
    </form>
  );
}
