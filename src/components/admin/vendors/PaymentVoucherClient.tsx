'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import {
  approveVoucherAction,
  cancelVoucherAction,
  payVoucherAction,
  paymentCandidatesAction,
  reverseVoucherAction,
  saveVoucherAction,
  sendBackVoucherAction,
  submitVoucherAction,
  type paymentAction,
} from '@/server/domains/vendors/payment-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { VOUCHER_KIND, VOUCHER_STATUS, fromCents, needsThreePeople, toCents } from '@/lib/vendor-payment';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof paymentAction>>, { ok: true }>['data'];
type Candidates = Extract<Awaited<ReturnType<typeof paymentCandidatesAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };

const EVENT_WORDS: Record<string, string> = { created: 'Prepared', submitted: 'Sent for approval', approved: 'Approved', sent_back: 'Sent back', cancelled: 'Cancelled', paid: 'Paid', reversed: 'Reversed', advance_applied: 'Advance set against an invoice' };

export function PaymentVoucherClient({ viewPromise }: { viewPromise: ReturnType<typeof paymentAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Voucher key={res.data.found?.voucher.updatedAt ?? 'new'} view={res.data} /> : <LoadFailed error={res.error} />;
}

function Voucher({ view }: { view: View }) {
  const found = view.found;
  const editing = view.can.create && (found === null || found.voucher.status === 'draft');
  return (
    <div className="max-w-4xl space-y-5">
      {found === null ? <PageHeader title="New payment" intro="Choose the vendor and what to pay. Another person will approve it before it can be paid." actions={<Link href="/admin/vendors/payments" className={buttonClass}>Cancel</Link>} /> : null}
      {editing ? <Editor view={view} /> : null}
      {!editing && found === null ? <p className="text-sm text-fg-muted">You are not allowed to prepare payments.</p> : null}
      {!editing && found !== null ? <Reader view={view} found={found} /> : null}
    </div>
  );
}

function Editor({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const found = view.found;
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'invoices' | 'advance'>(found?.voucher.kind ?? 'invoices');
  const [vendor, setVendor] = useState<Choice | null>(() => {
    if (found !== null) return { id: found.voucher.vendorId, label: found.vendorName };
    return view.prefill === null ? null : { id: view.prefill.vendorId, label: view.prefill.vendorName };
  });
  const [method, setMethod] = useState<Choice | null>(found === null ? null : { id: found.voucher.methodId, label: found.methodName });
  const [narration, setNarration] = useState(found?.voucher.narration ?? '');
  const [cand, setCand] = useState<Candidates>({ items: view.candidates.items, advances: view.candidates.advances });
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    if (found !== null) return Object.fromEntries(found.lines.map((l) => [l.purchaseInvoiceId, l.amount]));
    const wanted = view.candidates.items.find((i) => i.purchaseInvoiceId === view.prefill?.purchaseInvoiceId);
    return wanted === undefined ? {} : { [wanted.purchaseInvoiceId]: wanted.available };
  });
  const [advanceId, setAdvanceId] = useState(found?.voucher.advanceId ?? '');

  const loadCandidates = async (v: Choice | null) => {
    if (v === null) return;
    const res = await attempt(paymentCandidatesAction(v.id, found?.voucher.id ?? null));
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setCand(res.data);
  };
  const chosen = Object.entries(amounts).filter(([, a]) => a.trim() !== '');
  const total = chosen.reduce((s, [, a]) => s + (Number.isFinite(Number(a)) ? toCents(a) : 0), 0);
  const advance = cand.advances.find((a) => a.id === advanceId);
  const advanceCents = advance === undefined ? 0 : toCents(advance.amount);
  const amountCents = kind === 'advance' ? advanceCents : total;

  const save = async (): Promise<string | null> => {
    const header = { kind, vendorId: vendor?.id ?? '', methodId: method?.id ?? '', narration, advanceId: kind === 'advance' ? advanceId : '' };
    const res = await attempt(saveVoucherAction(found?.voucher.id ?? null, header, kind === 'advance' ? [] : chosen.map(([purchaseInvoiceId, amount]) => ({ purchaseInvoiceId, amount }))));
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return null;
    }
    return res.data.id;
  };
  const saveOnly = async () => {
    setBusy(true);
    setNotice(null);
    const id = await save();
    setBusy(false);
    if (id === null) return;
    if (found === null) router.push(`/admin/vendors/payments/${id}`);
    else setNotice({ kind: 'ok', text: 'Saved.' });
  };
  const send = async () => {
    setBusy(true);
    setNotice(null);
    const id = await save();
    if (id !== null) {
      const res = await attempt(submitVoucherAction(id));
      if (!res.ok) setNotice({ kind: 'error', text: res.error });
      else if (found === null) router.push(`/admin/vendors/payments/${id}`);
      else router.refresh();
    }
    setBusy(false);
  };
  return (
    <section className="space-y-4" aria-label="Payment voucher">
      {found === null ? null : <PageHeader title="Payment voucher (draft)" intro={found.voucher.sendBackReason === null ? undefined : `Sent back: ${found.voucher.sendBackReason}`} actions={<Link href="/admin/vendors/payments" className={buttonClass}>All payments</Link>} />}
      <Message notice={notice} />
      <div className={`${cardClass} space-y-3`}>
        <div role="group" aria-label="What to pay" className="flex flex-wrap gap-2">
          {(['invoices', 'advance'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} disabled={found !== null} className={`${buttonClass} ${kind === k ? 'ring-2 ring-indigo-500' : ''}`} onClick={() => setKind(k)}>{VOUCHER_KIND[k]}</button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ChoicePicker label="Vendor" source="vendors" choice={vendor} onChoice={(c) => { setVendor(c); setAmounts({}); setAdvanceId(''); setCand({ items: [], advances: [] }); void loadCandidates(c); }} placeholder="Search by name or number" disabled={found !== null} />
          <ChoicePicker label="How it will be paid" source="vendor-payment-methods" choice={method} onChoice={setMethod} placeholder="Choose a way of paying" />
        </div>
        <Field id={`${uid}-n`} label="Note (optional)"><input id={`${uid}-n`} value={narration} maxLength={500} onChange={(e) => setNarration(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
      </div>

      {vendor !== null && kind === 'invoices' ? (
        <div className={`${cardClass} space-y-2`} aria-label="Invoices to pay">
          <h2 className="text-sm font-bold text-fg-strong">Invoices to pay</h2>
          {cand.items.length === 0 ? <p className="text-sm text-fg-muted">This vendor has no booked invoice waiting to be paid.</p> : (
            <ul className="space-y-2">
              {cand.items.map((i) => (
                <li key={i.purchaseInvoiceId} className="grid grid-cols-1 items-end gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_10rem]">
                  <span className="text-sm text-fg"><span className="font-semibold">{i.vendorInvoiceNo}</span> ({i.number}) · due {i.dueDate ?? 'on receipt'} · open {i.remaining}{Number(i.held) > 0 ? ` · held by other vouchers ${i.held}` : ''} · <span className="font-semibold">available {i.available}</span></span>
                  <Field id={`${uid}-a-${i.purchaseInvoiceId}`} label="Amount to pay"><input id={`${uid}-a-${i.purchaseInvoiceId}`} inputMode="decimal" value={amounts[i.purchaseInvoiceId] ?? ''} disabled={i.availableCents === 0} onChange={(e) => setAmounts((p) => ({ ...p, [i.purchaseInvoiceId]: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {vendor !== null && kind === 'advance' ? (
        <div className={`${cardClass} space-y-2`} aria-label="Advance to pay">
          <h2 className="text-sm font-bold text-fg-strong">Advance payment to pay</h2>
          {cand.advances.length === 0 ? <p className="text-sm text-fg-muted">This vendor has no approved advance payment waiting to be paid.</p> : (
            <div role="group" aria-label="Advance payments" className="space-y-2">
              {cand.advances.map((a) => (
                <button key={a.id} type="button" aria-pressed={advanceId === a.id} onClick={() => setAdvanceId(a.id)} className={`${buttonClass} w-full justify-start text-left ${advanceId === a.id ? 'ring-2 ring-indigo-500' : ''}`}>Order {a.orderNumber} · {a.amount} {a.currency} · {a.reason}</button>
              ))}
            </div>
          )}
        </div>
      ) : null}
      <div className={`${cardClass} space-y-2`}>
        <p className="text-sm text-fg" aria-live="polite">Total to pay: <span className="font-semibold">{fromCents(amountCents)}</span>{needsThreePeople(amountCents, view.thresholdCents) ? <span className="block text-xs text-amber-700">This is large enough that a third person, who neither prepares nor approves it, has to pay it.</span> : null}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void send()}>Send for approval</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void saveOnly()}>Save as a draft</button>
          {found === null ? null : <CancelBox id={found.voucher.id} />}
        </div>
      </div>
    </section>
  );
}

function CancelBox({ id }: { id: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input aria-label="Why cancel it?" placeholder="Why cancel it?" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={`${fieldClass} w-48`} autoComplete="off" />
      <InlineConfirm label="Cancel this payment voucher" action="Cancel voucher" confirm="Yes, cancel it" busy={reason.trim() === ''} onConfirm={() => void attempt(cancelVoucherAction(id, reason)).then((r) => { if (r.ok) router.push('/admin/vendors/payments'); else setError(r.error); })} />
      {error === '' ? null : <span role="alert" className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

function Reader({ view, found }: { view: View; found: NonNullable<View['found']> }) {
  const uid = useId();
  const router = useRouter();
  const v = found.voucher;
  const s = VOUCHER_STATUS[v.status];
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(view.today);
  const [panel, setPanel] = useState<'back' | 'reverse' | null>(null);
  const act = async (call: Promise<Result>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return false;
    }
    setNotice({ kind: 'ok', text: done });
    router.refresh();
    return true;
  };
  const mine = view.me;
  const iPrepared = mine !== null && mine === v.createdBy;
  return (
    <section className="space-y-4" aria-label="Payment voucher">
      <PageHeader
        title={`Payment ${v.number ?? '(not numbered yet)'} to ${found.vendorName}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={s.tone}>{s.label}</Chip><span>{VOUCHER_KIND[v.kind]}</span><span>{found.methodName}</span>{v.needsThree ? <span>Three people</span> : null}</span>}
        actions={<Link href="/admin/vendors/payments" className={buttonClass}>All payments</Link>}
      />
      <Message notice={notice} />
      <div className={`${cardClass} space-y-2`}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-fg-muted">Amount</dt><dd className="font-medium text-fg-strong">{v.amount} {v.currency}</dd></div>
          <div><dt className="text-xs text-fg-muted">Prepared by</dt><dd className="font-medium text-fg-strong">{found.createdName ?? '—'}</dd></div>
          <div><dt className="text-xs text-fg-muted">Approved by</dt><dd className="font-medium text-fg-strong">{found.approvedName ?? '—'}</dd></div>
          <div><dt className="text-xs text-fg-muted">Paid by</dt><dd className="font-medium text-fg-strong">{found.paidName ?? '—'}</dd></div>
        </dl>
        {v.destination === null ? null : <p className="text-sm text-fg">Goes to: {v.destination}</p>}
        {v.narration === null ? null : <p className="text-sm text-fg">{v.narration}</p>}
        {v.status === 'paid' ? <p className="text-sm text-fg">Paid on {v.paidOn}, reference <span className="font-semibold">{v.paymentReference}</span>.</p> : null}
        {v.status === 'reversed' ? <p className="text-sm text-fg">Reversed: {v.reverseReason}</p> : null}
        {v.status === 'cancelled' ? <p className="text-sm text-fg">Cancelled: {v.cancelReason}</p> : null}
        {found.advance === null ? null : <p className="text-sm text-fg">Advance for order {found.advance.orderNumber}: {found.advance.reason}</p>}
        {found.lines.length === 0 ? null : (
          <ul className="divide-y divide-line text-sm" aria-label="Invoices paid">
            {found.lines.map((l) => <li key={l.purchaseInvoiceId} className="flex flex-wrap justify-between gap-2 py-2"><span>{l.vendorInvoiceNo} <span className="text-xs text-fg-muted">({l.number}, total {l.invoiceTotal})</span></span><span className="font-semibold">{l.amount}</span></li>)}
          </ul>
        )}
      </div>

      {v.status === 'pending_approval' && view.can.approve ? (
        <div className={`${cardClass} space-y-2`} aria-label="Approve">
          {iPrepared ? <p className="text-xs text-amber-700">You prepared this payment, so another person has to approve it.</p> : <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approveVoucherAction(v.id), 'Approved. It can be paid now.')}>Approve</button>}
          <button type="button" className={`${buttonClass} ml-2`} onClick={() => setPanel('back')}>Send back…</button>
          {panel === 'back' ? (
            <div role="group" aria-label="Send back" className="space-y-2 rounded-lg border border-line p-3">
              <Field id={`${uid}-sb`} label="Why is it sent back?"><input id={`${uid}-sb`} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
              <button type="button" className={primaryClass} disabled={busy || text.trim() === ''} onClick={() => void act(sendBackVoucherAction(v.id, text), 'Sent back to the person who prepared it.').then((ok) => { if (ok) setPanel(null); })}>Send it back</button>
            </div>
          ) : null}
        </div>
      ) : null}

      {v.status === 'approved' && view.can.release ? (
        <form className={`${cardClass} space-y-3`} aria-label="Record the payment" onSubmit={(e) => { e.preventDefault(); void act(payVoucherAction(v.id, reference, paidOn), 'Paid. The payment is booked and the vendor has its remittance.'); }}>
          <h2 className="text-sm font-bold text-fg-strong">Record the payment</h2>
          <p className="text-xs text-fg-muted">Pay the money first, by the way chosen, then record it here with the reference you were given.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-ref`} label="Payment reference"><input id={`${uid}-ref`} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <Field id={`${uid}-on`} label="Date paid"><input id={`${uid}-on`} type="date" value={paidOn} max={view.today} onChange={(e) => setPaidOn(e.target.value)} className={fieldClass} /></Field>
          </div>
          <button type="submit" className={primaryClass} disabled={busy || reference.trim() === ''}>Record the payment</button>
        </form>
      ) : null}

      {(v.status === 'approved' || v.status === 'pending_approval') && view.can.create ? <div className={cardClass}><CancelBox id={v.id} /></div> : null}

      {v.status === 'paid' && view.can.reverse ? (
        <div className={`${cardClass} space-y-2`}>
          <button type="button" className={buttonClass} onClick={() => setPanel('reverse')}>Reverse this payment…</button>
          {panel === 'reverse' ? (
            <form role="group" aria-label="Reverse the payment" className="space-y-2 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); void act(reverseVoucherAction(v.id, text), 'Reversed. The invoices are open again.').then((ok) => { if (ok) setPanel(null); }); }}>
              <Field id={`${uid}-rv`} label="Why is it reversed?"><input id={`${uid}-rv`} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
              <button type="submit" className={primaryClass} disabled={busy || text.trim() === ''}>Reverse the payment</button>
            </form>
          ) : null}
        </div>
      ) : null}

      <section className={cardClass} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="mt-1 space-y-1 text-sm text-fg">
          {found.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}
        </ol>
      </section>
    </section>
  );
}
