'use client';

import Link from 'next/link';
import { use, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { cancelRefundAction, recordRefundPayoutAction, payRefundThroughMpesaAction, submitRefundAction, type refundDetailAction } from '@/server/domains/finance/refund-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { REFUND_STATUS, statusInfo } from '@/lib/finance-statuses';
import { needsComment } from '@/lib/receipt-detail';
import { has, historyDetail, historyHeadline, historyReason, submitMessage } from '@/lib/finance-history';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, today, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof refundDetailAction>>, { ok: true }>['data'];
const words = (s: string) => s.replace(/_/g, ' ');

export function RefundDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof refundDetailAction> }) {
  const res = use(viewPromise);
  return res.ok ? <RefundDetailView view={res.data} /> : <LoadFailed error={res.error} />;
}

function RefundDetailView({ view }: { view: View }) {
  const router = useRouter();
  const note = useSearchParams().get('note');
  const [panel, setPanel] = useState<null | 'cancel' | 'pay'>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(note !== null && note !== '' ? { kind: 'error', text: `Saved as a draft, but it could not be sent on: ${note}` } : null);
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [payFrom, setPayFrom] = useState<Choice | null>(null);
  const [ref, setRef] = useState('');
  const [when, setWhen] = useState(today());
  const fileRef = useRef<HTMLInputElement>(null);

  const done = (res: { ok: true } | { ok: false; error: string }, okText: string) => {
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: okText });
    setPanel(null);
    router.refresh();
  };
  const submit = async () => { setBusy(true); setNotice(null); const res = await attempt(submitRefundAction(view.id)); done(res, res.ok ? submitMessage(res.data.status) : ''); };
  const cancel = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const text = reasonText.trim();
    done(await attempt(cancelRefundAction(view.id, { code: reason?.id ?? '', text: text === '' ? undefined : text })), 'Cancelled.');
  };
  const pay = async (e: React.SyntheticEvent) => { e.preventDefault(); setBusy(true); setNotice(null); done(await attempt(recordRefundPayoutAction(view.id, { paidFromMethodId: payFrom?.id ?? '', reference: ref, payoutDate: when })), 'Payment recorded.'); };
  const sendMpesa = async () => { setBusy(true); setNotice(null); done(await attempt(payRefundThroughMpesaAction(view.id)), 'Sent for payment through M-Pesa. It is recorded as paid once Safaricom confirms it; follow it under Payment activity.'); };
  const upload = async (file: File) => {
    setBusy(true); setNotice(null);
    const body = new FormData(); body.set('file', file); body.set('refundId', view.id);
    try {
      const res = await fetch('/api/admin/finance/refund-evidence', { method: 'POST', body });
      const json = (await res.json()) as { ok: boolean; error?: string };
      setBusy(false);
      if (!json.ok) { setNotice({ kind: 'error', text: json.error ?? 'The file could not be saved.' }); return; }
      setNotice({ kind: 'ok', text: 'Evidence attached.' }); router.refresh();
    } catch { setBusy(false); setNotice({ kind: 'error', text: 'The file could not be sent. Check your connection and try again.' }); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  };

  const s = view.status;
  const canCancel = view.can.cancel && ['draft', 'pending_approval', 'approved'].includes(s);
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`Refund ${view.number}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={statusInfo(REFUND_STATUS, s).tone}>{statusInfo(REFUND_STATUS, s).label}</Chip>{view.detailsChanged ? <Chip tone="red">Different payout details</Chip> : null}{has(view.bankMatchedAt) ? <Chip tone="green">Seen on the bank statement</Chip> : null}{!has(view.bankMatchedAt) && s === 'paid' ? <Chip tone="gray">Not on a bank statement yet</Chip> : null}<span>to <Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/receivables/customer/${view.customer.id}`}>{view.customer.name}</Link> ({view.customer.number})</span></span>}
        actions={<Link href="/admin/finance/refunds" className={buttonClass}>All refunds</Link>}
      />
      <Message notice={notice} />
      <section className={`${cardClass} grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4`} aria-label="Refund details">
        {([['Amount', `${view.currency} ${money(view.amount)}`], ['Pay by', view.method.name], ['Owed from', view.source], ['Reason', `${words(view.reason)}${has(view.reasonText) ? ` — ${view.reasonText}` : ''}`], ['Asked by', view.requestedBy ?? '—'], ['Approved by', view.approvedBy ?? '—'], ['Paid by', view.paidBy ?? '—'], ['Payment reference', view.payoutReference ?? '—'], ...Object.entries(view.payoutDetails).map(([k, v]) => [words(k.replace(/([A-Z])/g, ' $1')), v] as [string, string])]).map(([k, v]) => (
          <div key={k}><dt className="text-xs text-fg-muted">{k}</dt><dd className="break-words font-semibold text-fg-strong">{v}</dd></div>
        ))}
      </section>

      <div className="flex flex-wrap gap-2">
        {s === 'draft' && view.can.submit ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void submit()}>Send on</button> : null}
        {s === 'approved' && view.method.automatic && view.can.payAutomatic ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void sendMpesa()}>Pay through M-Pesa</button> : null}
        {s === 'approved' && view.can.pay ? <button type="button" className={primaryClass} disabled={busy} aria-expanded={panel === 'pay'} onClick={() => setPanel('pay')}>Record payment</button> : null}
        {canCancel ? <button type="button" className={dangerClass} disabled={busy} aria-expanded={panel === 'cancel'} onClick={() => setPanel('cancel')}>Cancel refund</button> : null}
      </div>

      {panel === 'cancel' ? (
        <form onSubmit={(e) => void cancel(e)} className={`${cardClass} space-y-3`}>
          <h2 className="text-sm font-bold text-fg-strong">Cancel this refund{s === 'approved' ? ' (the money set aside goes back to where it came from)' : ''}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChoicePicker label="Reason" source="refund-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
            <Field id="c-t" label={needsComment(reason?.meta) ? 'Explain (required)' : 'Comment (optional)'}><input id="c-t" value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsComment(reason?.meta)} maxLength={300} autoComplete="off" /></Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || reason === null}>Cancel refund</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Keep it</button></div>
        </form>
      ) : null}

      <section className={`${cardClass} space-y-3`} aria-label="Evidence of payment">
        <h2 className="text-sm font-bold text-fg-strong">Evidence of payment</h2>
        <p className="text-xs text-fg-muted">A payment slip, bank confirmation, M-Pesa message or signed receipt. Payment cannot be recorded without at least one.</p>
        {view.attachments.length === 0 ? <p className="text-sm text-fg-muted">Nothing attached yet.</p> : <ul className="space-y-1 text-sm">{view.attachments.map((a) => <li key={a.id}>{has(a.url) ? <a className="font-semibold text-indigo-600 hover:underline" href={a.url} target="_blank" rel="noreferrer">{a.fileName}</a> : a.fileName} <span className="text-xs text-fg-muted">· {new Date(a.createdAt).toLocaleString()}</span></li>)}</ul>}
        {view.can.attach && s !== 'cancelled' && s !== 'rejected' ? (
          <div>
            <label htmlFor="ev-file" className="text-xs font-semibold text-fg-muted">Add a photo or screenshot</label>
            <input id="ev-file" ref={fileRef} type="file" accept="image/*" disabled={busy} className="mt-1 block min-h-10 text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          </div>
        ) : null}
      </section>

      {panel === 'pay' ? (
        <form onSubmit={(e) => void pay(e)} className={`${cardClass} space-y-3`}>
          <h2 className="text-sm font-bold text-fg-strong">Record that {view.currency} {money(view.amount)} was paid</h2>
          <p className="text-xs text-fg-muted">The person who approved this cannot record the payment.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ChoicePicker label="Paid out through" source="refund-payout-methods" filters={{ currency: view.currency }} choice={payFrom} onChoice={setPayFrom} clearable={false} required placeholder="Choose where it was paid from…" />
            <Field id="p-r" label="Payment reference"><input id="p-r" value={ref} onChange={(e) => setRef(e.target.value)} className={fieldClass} required maxLength={80} autoComplete="off" /></Field>
            <Field id="p-d" label="Date paid"><input id="p-d" type="date" max={today()} value={when} onChange={(e) => setWhen(e.target.value)} className={fieldClass} required /></Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy || payFrom === null}>Record payment</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Close</button></div>
        </form>
      ) : null}

      <section className={`${cardClass} space-y-2`} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="space-y-2 text-sm">
          {view.events.map((e) => (
            <li key={e.id} className="border-l-2 border-line pl-3">
              <p className="font-semibold text-fg-strong">{historyHeadline(e)}</p>
              <p className="text-xs text-fg-muted">{historyDetail(e, (iso) => new Date(iso).toLocaleString())}{has(e.reasonCode) ? ` · ${historyReason(e)}` : ''}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
