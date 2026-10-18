'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { recordRefundReturnAction } from '@/server/domains/finance/refund-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { payoutFields, startingDetails } from '@/lib/refund-form';
import { returnInput, returnProblem, type ReturnForm } from '@/lib/refund-return-form';
import { needsComment } from '@/lib/receipt-detail';
import { metaValue } from '@/lib/receipt-form';
import type { Choice } from '@/lib/payment-options';
import { Field, Message, attempt, buttonClass, cardClass, fieldClass, money, primaryClass, today, type Notice } from './ui';

export interface ReturnRow {
  id: string;
  amount: string;
  reference: string;
  on: string;
  replacementId: string | null;
}

/** Money from a paid refund came back (a wrong account, a closed number): the record, and the replacement refund it starts. */
export function RefundReturnPanel({ id, currency, returnable, returns, customerPhone, canRecord, canChangeDestination }: { id: string; currency: string; returnable: string; returns: ReturnRow[]; customerPhone: string | null; canRecord: boolean; canChangeDestination: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [when, setWhen] = useState(today());
  const [into, setInto] = useState<Choice | null>(null);
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [method, setMethod] = useState<Choice | null>(null);
  const [details, setDetails] = useState<Record<string, string>>(startingDetails(customerPhone));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const canStart = canRecord && Number(returnable) > 0;
  if (returns.length === 0 && !canStart) return null;

  const form: ReturnForm = { amount, reference, returnedOn: when, intoMethodId: into?.id ?? null, reasonCode: reason?.id ?? null, reasonText, replacementMethodId: method?.id ?? null, replacementDetails: details };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = returnProblem(form, returnable, today());
    if (problem !== null) { setNotice({ kind: 'error', text: problem }); return; }
    setBusy(true);
    setNotice(null);
    const res = await attempt(recordRefundReturnAction(id, returnInput(form)));
    if (!res.ok) { setBusy(false); setNotice({ kind: 'error', text: res.error }); return; }
    router.push(`/admin/finance/refunds/${res.data.replacementId}`);
  };

  return (
    <section className={`${cardClass} space-y-3`} aria-label="Money that came back">
      <h2 className="text-sm font-bold text-fg-strong">Money that came back</h2>
      {returns.length === 0 ? <p className="text-sm text-fg-muted">If the bank or M-Pesa sent this money back (a wrong account, a closed number), record it here. The customer is owed it again, and a new refund is started for it.</p> : (
        <ul className="space-y-1 text-sm">
          {returns.map((r) => (
            <li key={r.id}>{currency} {money(r.amount)} came back on {r.on} <span className="font-mono text-xs text-fg-muted">{r.reference}</span>{r.replacementId !== null ? <> · <Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/refunds/${r.replacementId}`}>replacement refund</Link></> : null}</li>
          ))}
        </ul>
      )}
      <Message notice={notice} />
      {canStart && !open ? <button type="button" className={buttonClass} onClick={() => setOpen(true)}>Record money that came back…</button> : null}
      {open ? (
        <form onSubmit={(e) => void save(e)} className="space-y-3" aria-label="Record money that came back">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field id={`${uid}-a`} label={`Amount (${currency})`} hint={`Leave empty for all ${money(returnable)}`}><input id={`${uid}-a`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} placeholder={money(returnable)} /></Field>
            <Field id={`${uid}-r`} label="Reference it came back with"><input id={`${uid}-r`} value={reference} onChange={(e) => setReference(e.target.value)} className={fieldClass} required maxLength={80} autoComplete="off" /></Field>
            <Field id={`${uid}-d`} label="Date it came back"><input id={`${uid}-d`} type="date" max={today()} value={when} onChange={(e) => setWhen(e.target.value)} className={fieldClass} required /></Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChoicePicker label="It came back into" source="refund-return-methods" filters={{ currency }} choice={into} onChoice={setInto} clearable={false} required placeholder="Choose where it arrived…" />
            <ChoicePicker label="Why it came back" source="refund-return-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
          </div>
          <Field id={`${uid}-t`} label={needsComment(reason?.meta) ? 'Explain (required)' : 'Comment (optional)'}><input id={`${uid}-t`} value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsComment(reason?.meta)} maxLength={300} autoComplete="off" /></Field>
          <h3 className="pt-2 text-xs font-bold uppercase text-fg-muted">Pay it again to</h3>
          <ChoicePicker label="Pay by" source="refund-replacement-methods" choice={method} onChoice={(c) => { setMethod(c); setDetails(startingDetails(customerPhone)); }} clearable={false} required placeholder="How will the customer be paid this time?" />
          {method !== null ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {payoutFields(metaValue(method.meta, 'kind')).map((f) => (
                <Field key={f.key} id={`${uid}-p-${f.key}`} label={f.label} hint={f.key === 'phone' && !canChangeDestination ? 'Only the number on the customer’s record can be used.' : undefined}>
                  <input id={`${uid}-p-${f.key}`} type={f.type ?? 'text'} value={details[f.key] ?? ''} onChange={(e) => setDetails({ ...details, [f.key]: e.target.value })} className={fieldClass} required maxLength={120} autoComplete="off" />
                </Field>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy}>Record it and start the replacement</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setOpen(false)}>Not now</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
