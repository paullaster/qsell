'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useRef, useState } from 'react';
import {
  approvePettyVoucherAction,
  cancelPettyVoucherAction,
  payPettyVoucherAction,
  reversePettyVoucherAction,
  savePettyVoucherAction,
  sendBackPettyVoucherAction,
  submitPettyVoucherAction,
  type pettyVoucherAction,
} from '@/server/domains/vendors/petty-cash-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { PETTY_STATUS, fmt } from '@/lib/petty-cash';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof pettyVoucherAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };

const EVENT_WORDS: Record<string, string> = { created: 'Written', receipt_added: 'Receipt added', submitted: 'Sent for approval', approved: 'Approved', sent_back: 'Sent back', cancelled: 'Cancelled', paid: 'Paid out', reversed: 'Reversed' };

export function PettyVoucherClient({ viewPromise }: { viewPromise: ReturnType<typeof pettyVoucherAction> }) {
  const res = use(viewPromise);
  // What the last action said is kept here, above the part that is rebuilt whenever the voucher changes: saving a voucher
  // changes it, the page then reloads and rebuilds the form, and a message held inside it (such as "Attach a picture of the
  // receipt first.") would vanish before anyone could read it.
  const [notice, setNotice] = useState<Notice>(null);
  return res.ok ? <Voucher key={res.data.found?.voucher.updatedAt ?? 'new'} data={res.data} notice={notice} setNotice={setNotice} /> : <LoadFailed error={res.error} />;
}

function Voucher({ data, notice, setNotice }: { data: Data; notice: Notice; setNotice: (notice: Notice) => void }) {
  const uid = useId();
  const router = useRouter();
  const found = data.found;
  const v = found?.voucher ?? null;
  const float = data.float;
  const editing = data.can.create && (v === null || v.status === 'draft');
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'expense' | 'vendor_invoice'>(v?.kind ?? 'expense');
  const [payee, setPayee] = useState(v?.payeeName ?? '');
  const [description, setDescription] = useState(v?.description ?? '');
  const [receiptRef, setReceiptRef] = useState(v?.receiptRef ?? '');
  const [amount, setAmount] = useState(v?.amount ?? '');
  const [account, setAccount] = useState<Choice | null>(null);
  const [invoice, setInvoice] = useState<Choice | null>(null);
  const [text, setText] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
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
  const form = () => ({ floatId: float?.id ?? v?.floatId ?? '', kind, payeeName: payee, description, receiptRef, amount, expenseAccountId: kind === 'expense' ? (account?.id ?? v?.expenseAccountId ?? '') : '', purchaseInvoiceId: kind === 'vendor_invoice' ? (invoice?.id ?? v?.purchaseInvoiceId ?? '') : '' });
  const save = async (): Promise<string | null> => {
    const res = await attempt(savePettyVoucherAction(v?.id ?? null, form()));
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
    if (v === null) router.push(`/admin/vendors/petty-cash/vouchers/${id}`);
    else {
      setNotice({ kind: 'ok', text: 'Saved.' });
      router.refresh();
    }
  };
  const send = async () => {
    setBusy(true);
    setNotice(null);
    const id = await save();
    if (id !== null) {
      const res = await attempt(submitPettyVoucherAction(id));
      if (!res.ok) {
        setNotice({ kind: 'error', text: res.error });
        if (v === null) router.push(`/admin/vendors/petty-cash/vouchers/${id}`);
      } else if (v === null) router.push(`/admin/vendors/petty-cash/vouchers/${id}`);
      else router.refresh();
    }
    setBusy(false);
  };
  const upload = async (file: File | undefined) => {
    if (file === undefined || v === null) return;
    setBusy(true);
    setNotice(null);
    const body = new FormData();
    body.set('file', file);
    body.set('voucherId', v.id);
    try {
      const response = await fetch('/api/admin/vendors/petty-cash-receipt', { method: 'POST', body });
      const result = (await response.json()) as { ok: boolean; error?: string };
      setNotice(result.ok ? { kind: 'ok', text: 'Receipt added.' } : { kind: 'error', text: result.error ?? 'The upload failed. Please try again.' });
      if (result.ok) router.refresh();
    } catch {
      setNotice({ kind: 'error', text: 'The upload failed. Check your connection and try again.' });
    } finally {
      setBusy(false);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  };
  const status = v === null ? null : PETTY_STATUS[v.status];
  const iWrote = v !== null && data.me !== null && data.me === v.createdBy;

  if (float === null && v === null) return <p className="text-sm text-fg-muted">Choose a float first.</p>;
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title={v === null ? 'New petty cash voucher' : `Petty cash ${v.number ?? '(not numbered yet)'}`}
        intro={<span className="flex flex-wrap items-center gap-2">{status === null ? null : <Chip tone={status.tone}>{status.label}</Chip>}<span>{found?.floatName ?? float?.name}</span>{float === null ? null : <span>Cash in the float {fmt(float.balanceCents)}, one voucher at most {float.perVoucherLimit}</span>}</span>}
        actions={<Link href={`/admin/vendors/petty-cash/${float?.id ?? v?.floatId ?? ''}`} className={buttonClass}>Back to the float</Link>}
      />
      <Message notice={notice} />
      {v?.sendBackReason == null ? null : <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">Sent back: {v.sendBackReason}</p>}

      {editing ? (
        <form className={`${cardClass} space-y-3`} aria-label="Petty cash voucher" onSubmit={(e) => e.preventDefault()}>
          <div role="group" aria-label="What it pays" className="flex flex-wrap gap-2">
            {(['expense', 'vendor_invoice'] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} disabled={v !== null} className={`${buttonClass} ${kind === k ? 'ring-2 ring-indigo-500' : ''}`} onClick={() => setKind(k)}>{k === 'expense' ? 'An expense' : 'A small vendor invoice'}</button>)}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-payee`} label="Who is paid"><input id={`${uid}-payee`} value={payee} maxLength={120} onChange={(e) => setPayee(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <Field id={`${uid}-amount`} label="Amount"><input id={`${uid}-amount`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <div className="sm:col-span-2"><Field id={`${uid}-desc`} label="What it is for"><input id={`${uid}-desc`} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} className={fieldClass} autoComplete="off" /></Field></div>
            <Field id={`${uid}-rr`} label="Number on the receipt"><input id={`${uid}-rr`} value={receiptRef} maxLength={60} onChange={(e) => setReceiptRef(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            {kind === 'expense'
              ? <ChoicePicker label="Booked to the expense" source="petty-expense-accounts" choice={account} onChoice={setAccount} placeholder="Search by number or name" />
              : <ChoicePicker label="The vendor invoice" source="payable-invoices" choice={invoice} onChoice={(c) => { setInvoice(c); if (c !== null && amount === '' && c.meta?.open !== undefined) setAmount(c.meta.open); }} placeholder="Search by the vendor’s invoice number" />}
          </div>
          {v === null ? <p className="text-xs text-fg-muted">Save the voucher first, then add a picture of the receipt. A voucher cannot be sent for approval without one.</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void send()}>Send for approval</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void saveOnly()}>Save as a draft</button>
          </div>
        </form>
      ) : null}
      {!editing && v === null ? <p className="text-sm text-fg-muted">You are not allowed to write petty cash vouchers.</p> : null}
      {!editing && v !== null ? (
        <section className={`${cardClass} space-y-2`} aria-label="The voucher">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-fg-muted">Paid to</dt><dd className="font-medium text-fg-strong">{v.payeeName}</dd></div>
            <div><dt className="text-xs text-fg-muted">Amount</dt><dd className="font-medium tabular-nums text-fg-strong">{v.amount} {v.currency}</dd></div>
            <div><dt className="text-xs text-fg-muted">Receipt number</dt><dd className="font-medium text-fg-strong">{v.receiptRef}</dd></div>
            <div><dt className="text-xs text-fg-muted">Written by</dt><dd className="font-medium text-fg-strong">{found?.createdName ?? '—'}</dd></div>
          </dl>
          <p className="text-sm text-fg">{v.description}</p>
          <p className="text-xs text-fg-muted">{v.kind === 'vendor_invoice' ? 'Pays a booked vendor invoice.' : 'An expense with no vendor.'}{found?.approvedName == null ? '' : ` Approved by ${found.approvedName}.`}{found?.paidName == null ? '' : ` Paid out by ${found.paidName}.`}</p>
          {v.status === 'reversed' ? <p className="text-sm text-fg">Reversed: {v.reverseReason}</p> : null}
          {v.status === 'cancelled' ? <p className="text-sm text-fg">Cancelled: {v.cancelReason}</p> : null}
        </section>
      ) : null}

      {v === null ? null : (
        <section className={`${cardClass} space-y-2`} aria-label="Receipts">
          <h2 className="text-sm font-bold text-fg-strong">Receipts</h2>
          {found?.attachments.length === 0 ? <p className="text-sm text-fg-muted">No receipt yet.</p> : (
            <ul className="text-sm text-fg" aria-label="Receipt pictures">{found?.attachments.map((a) => <li key={a.id}>{a.url === null ? a.fileName : <a className="font-semibold underline" href={a.url} target="_blank" rel="noreferrer">{a.fileName}</a>}</li>)}</ul>
          )}
          {data.can.create && v.status !== 'cancelled' && v.status !== 'reversed' && v.status !== 'paid' ? (
            <div><label className="block text-xs font-semibold text-fg" htmlFor={`${uid}-file`}>Add a picture of the receipt</label><input id={`${uid}-file`} ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="block w-full text-sm" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} /></div>
          ) : null}
        </section>
      )}

      {v?.status === 'pending_approval' && data.can.approve ? (
        <section className={`${cardClass} space-y-2`} aria-label="Approve">
          {iWrote ? <p className="text-xs text-amber-700">You wrote this voucher, so another person has to approve it.</p> : <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approvePettyVoucherAction(v.id), 'Approved.')}>Approve</button>}
          <div className="flex flex-wrap items-end gap-2">
            <Field id={`${uid}-sb`} label="Or send it back, saying why"><input id={`${uid}-sb`} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void act(sendBackPettyVoucherAction(v.id, text), 'Sent back.')}>Send back</button>
          </div>
        </section>
      ) : null}

      {v?.status === 'approved' && data.can.pay ? (
        <section className={`${cardClass} space-y-2`} aria-label="Pay out">
          <p className="text-sm text-fg">Hand over the cash, then record it. It comes out of the float and is booked.</p>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(payPettyVoucherAction(v.id), 'Paid out.')}>Record the cash as paid out</button>
        </section>
      ) : null}

      {v !== null && (v.status === 'draft' || v.status === 'pending_approval' || v.status === 'approved') && data.can.create ? (
        <section className={`${cardClass} flex flex-wrap items-end gap-2`} aria-label="Cancel the voucher">
          <Field id={`${uid}-cx`} label="Why cancel it?"><input id={`${uid}-cx`} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void act(cancelPettyVoucherAction(v.id, text), 'Cancelled.')}>Cancel the voucher</button>
        </section>
      ) : null}

      {v?.status === 'paid' && data.can.reverse ? (
        <section className={`${cardClass} flex flex-wrap items-end gap-2`} aria-label="Reverse the payment">
          <Field id={`${uid}-rv`} label="Why is it reversed?"><input id={`${uid}-rv`} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void act(reversePettyVoucherAction(v.id, text), 'Reversed. The cash is back in the float.')}>Reverse the payment</button>
        </section>
      ) : null}

      {found === null ? null : (
        <section className={cardClass} aria-label="History">
          <h2 className="text-sm font-bold text-fg-strong">History</h2>
          <ol className="mt-1 space-y-1 text-sm text-fg">{found.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}</ol>
        </section>
      )}
    </div>
  );
}
