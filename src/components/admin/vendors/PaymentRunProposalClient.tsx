'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { runCreateAction, runSuggestAction } from '@/server/domains/vendors/payment-run-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { fromCents } from '@/lib/vendor-payment';
import type { Choice } from '@/lib/payment-options';
import { Field, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Proposal = Extract<Awaited<ReturnType<typeof runSuggestAction>>, { ok: true }>['data'];

export function PaymentRunProposalClient({ today }: { today: string }) {
  const uid = useId();
  const router = useRouter();
  const [method, setMethod] = useState<Choice | null>(null);
  const [vendor, setVendor] = useState<Choice | null>(null);
  const [dueOn, setDueOn] = useState(today);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [skip, setSkip] = useState<Record<string, boolean>>({});
  const [executionDate, setExecutionDate] = useState(today);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const suggest = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(runSuggestAction({ methodId: method?.id ?? '', dueOn, vendorId: vendor?.id ?? '', min, max }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setProposal(res.data);
    setSkip({});
  };
  const chosen = (proposal?.vendors ?? []).filter((v) => skip[v.vendorId] !== true);
  const total = chosen.reduce((n, v) => n + v.totalCents, 0);
  const make = async () => {
    setBusy(true);
    setNotice(null);
    const selections = chosen.map((v) => ({ vendorId: v.vendorId, allocations: v.items.map((i) => ({ purchaseInvoiceId: i.purchaseInvoiceId, amount: fromCents(i.availableCents) })) }));
    const res = await attempt(runCreateAction({ methodId: method?.id ?? '', executionDate, note, selections }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.push(`/admin/vendors/payments/runs/${res.data.id}`);
  };
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="New payment run" intro="Choose how you will pay and the date invoices are due by. We list what can be paid, and who is left out and why." actions={<Link href="/admin/vendors/payments/runs" className={buttonClass}>Cancel</Link>} />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-3`} aria-label="What to pay" onSubmit={(e) => { e.preventDefault(); void suggest(); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ChoicePicker label="How it will be paid" source="vendor-payment-methods" choice={method} onChoice={(c) => { setMethod(c); setProposal(null); }} placeholder="Choose a way of paying" />
          <Field id={`${uid}-due`} label="Pay invoices due on or before"><input id={`${uid}-due`} type="date" value={dueOn} onChange={(e) => { setDueOn(e.target.value); setProposal(null); }} className={fieldClass} /></Field>
          <ChoicePicker label="Only this vendor (optional)" source="vendors" choice={vendor} onChoice={(c) => { setVendor(c); setProposal(null); }} placeholder="All vendors" />
          <div className="grid grid-cols-2 gap-3">
            <Field id={`${uid}-min`} label="Smallest total"><input id={`${uid}-min`} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <Field id={`${uid}-max`} label="Largest total"><input id={`${uid}-max`} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          </div>
        </div>
        <button type="submit" className={primaryClass} disabled={busy || method === null}>{busy ? 'Working…' : 'Suggest payments'}</button>
      </form>

      {proposal === null ? null : (
        <>
          <section className={`${cardClass} space-y-2`} aria-label="Suggested payments">
            <h2 className="text-sm font-bold text-fg-strong">Suggested payments</h2>
            {proposal.vendors.length === 0 ? <p className="text-sm text-fg-muted">Nothing can be paid by that date with that way of paying.</p> : (
              <ul className="space-y-2">
                {proposal.vendors.map((v) => (
                  <li key={v.vendorId} className="rounded-lg border border-line p-3">
                    <label className="flex items-start gap-2 text-sm text-fg">
                      <input type="checkbox" className="mt-1 h-4 w-4" checked={skip[v.vendorId] !== true} onChange={(e) => setSkip((p) => ({ ...p, [v.vendorId]: !e.target.checked }))} aria-label={`Pay ${v.vendorName}`} />
                      <span className="min-w-0"><span className="font-semibold">{v.vendorName}</span> · {fromCents(v.totalCents)}<span className="block text-xs text-fg-muted">{v.items.map((i) => `${i.vendorInvoiceNo} ${fromCents(i.availableCents)}${i.dueDate === null ? '' : ` (due ${i.dueDate})`}`).join(' · ')}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {proposal.excluded.length === 0 ? null : (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-fg-muted">Left out</h3>
                <ul className="text-xs text-fg-muted" aria-label="Left out">{proposal.excluded.map((e) => <li key={`${e.vendorId}-${e.reason}`}>{e.vendorName}: {e.reason}</li>)}</ul>
              </div>
            )}
          </section>
          {chosen.length === 0 ? null : (
            <section className={`${cardClass} space-y-3`} aria-label="Make the run">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id={`${uid}-ex`} label="Payment date" hint="The day the bank should pay, up to 30 days ahead."><input id={`${uid}-ex`} type="date" value={executionDate} min={today} onChange={(e) => setExecutionDate(e.target.value)} className={fieldClass} /></Field>
                <Field id={`${uid}-note`} label="Note (optional)"><input id={`${uid}-note`} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
              </div>
              <p className="text-sm text-fg" aria-live="polite">{chosen.length} {chosen.length === 1 ? 'vendor' : 'vendors'}, <span className="font-semibold">{fromCents(total)}</span></p>
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void make()}>Make the run</button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
