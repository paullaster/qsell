'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { cancelRefundAction, recordRefundPayoutAction, submitRefundAction, type refundDetailAction } from '@/server/domains/finance/refund-actions';
import { REFUND_STATUS } from './RefundsClient';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, today, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof refundDetailAction>>, { ok: true }>['data'];
const words = (s: string) => s.replace(/_/g, ' ');

export function RefundDetailClient({ view }: { view: View }) {
  const router = useRouter();
  const note = useSearchParams().get('note');
  const [panel, setPanel] = useState<null | 'cancel' | 'pay'>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(note ? { kind: 'error', text: `Saved as a draft, but it could not be sent on: ${note}` } : null);
  const [reason, setReason] = useState({ code: '', text: '' });
  const [bankId, setBankId] = useState(view.payFrom[0]?.id ?? '');
  const [ref, setRef] = useState('');
  const [when, setWhen] = useState(today());
  const fileRef = useRef<HTMLInputElement>(null);
  const chosen = view.reasons.find((r) => r.code === reason.code);

  const done = (res: { ok: true } | { ok: false; error: string }, okText: string) => {
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: okText });
    setPanel(null);
    router.refresh();
  };
  const submit = async () => { setBusy(true); setNotice(null); const res = await attempt(submitRefundAction(view.id)); done(res, res.ok ? (res.data.status === 'approved' ? 'Approved: the money is set aside, ready to pay.' : 'Sent for approval.') : ''); };
  const cancel = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setNotice(null); done(await attempt(cancelRefundAction(view.id, { code: reason.code, text: reason.text.trim() || undefined })), 'Cancelled.'); };
  const pay = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setNotice(null); done(await attempt(recordRefundPayoutAction(view.id, { paidFromBankAccountId: bankId, reference: ref, payoutDate: when })), 'Payment recorded.'); };
  const upload = async (file: File) => {
    setBusy(true); setNotice(null);
    const body = new FormData(); body.set('file', file); body.set('refundId', view.id);
    try {
      const res = await fetch('/api/admin/finance/refund-evidence', { method: 'POST', body });
      const json = (await res.json()) as { ok: boolean; error?: string };
      setBusy(false);
      if (!json.ok) return setNotice({ kind: 'error', text: json.error ?? 'The file could not be saved.' });
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
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={REFUND_STATUS[s]?.tone ?? 'gray'}>{REFUND_STATUS[s]?.label ?? s}</Chip>{view.detailsChanged ? <Chip tone="red">Different payout details</Chip> : null}{view.bankMatchedAt ? <Chip tone="green">Seen on the bank statement</Chip> : s === 'paid' ? <Chip tone="gray">Not on a bank statement yet</Chip> : null}<span>to <Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/receivables/customer/${view.customer.id}`}>{view.customer.name}</Link> ({view.customer.number})</span></span>}
        actions={<Link href="/admin/finance/refunds" className={buttonClass}>All refunds</Link>}
      />
      <Message notice={notice} />
      <section className={`${cardClass} grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4`} aria-label="Refund details">
        {([['Amount', `${view.currency} ${money(view.amount)}`], ['Pay by', view.method.name], ['Owed from', view.source], ['Reason', `${words(view.reason)}${view.reasonText ? ` — ${view.reasonText}` : ''}`], ['Asked by', view.requestedBy ?? '—'], ['Approved by', view.approvedBy ?? '—'], ['Paid by', view.paidBy ?? '—'], ['Payment reference', view.payoutReference ?? '—'], ...Object.entries(view.payoutDetails).map(([k, v]) => [words(k.replace(/([A-Z])/g, ' $1')), v] as [string, string])]).map(([k, v]) => (
          <div key={k}><dt className="text-xs text-fg-muted">{k}</dt><dd className="break-words font-semibold text-fg-strong">{v}</dd></div>
        ))}
      </section>

      <div className="flex flex-wrap gap-2">
        {s === 'draft' && view.can.submit ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void submit()}>Send on</button> : null}
        {s === 'approved' && view.can.pay ? <button type="button" className={primaryClass} disabled={busy} aria-expanded={panel === 'pay'} onClick={() => setPanel('pay')}>Record payment</button> : null}
        {canCancel ? <button type="button" className={dangerClass} disabled={busy} aria-expanded={panel === 'cancel'} onClick={() => setPanel('cancel')}>Cancel refund</button> : null}
      </div>

      {panel === 'cancel' ? (
        <form onSubmit={(e) => void cancel(e)} className={`${cardClass} space-y-3`}>
          <h2 className="text-sm font-bold text-fg-strong">Cancel this refund{s === 'approved' ? ' (the money set aside goes back to where it came from)' : ''}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="c-r" label="Reason"><select id="c-r" value={reason.code} onChange={(e) => setReason({ ...reason, code: e.target.value })} className={fieldClass} required><option value="">Choose a reason…</option>{view.reasons.map((r) => <option key={r.code} value={r.code}>{r.description}</option>)}</select></Field>
            <Field id="c-t" label={chosen?.requiresComment ? 'Explain (required)' : 'Comment (optional)'}><input id="c-t" value={reason.text} onChange={(e) => setReason({ ...reason, text: e.target.value })} className={fieldClass} required={chosen?.requiresComment ?? false} maxLength={300} autoComplete="off" /></Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy}>Cancel refund</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Keep it</button></div>
        </form>
      ) : null}

      <section className={`${cardClass} space-y-3`} aria-label="Evidence of payment">
        <h2 className="text-sm font-bold text-fg-strong">Evidence of payment</h2>
        <p className="text-xs text-fg-muted">A payment slip, bank confirmation, M-Pesa message or signed receipt. Payment cannot be recorded without at least one.</p>
        {view.attachments.length === 0 ? <p className="text-sm text-fg-muted">Nothing attached yet.</p> : <ul className="space-y-1 text-sm">{view.attachments.map((a) => <li key={a.id}>{a.url ? <a className="font-semibold text-indigo-600 hover:underline" href={a.url} target="_blank" rel="noreferrer">{a.fileName}</a> : a.fileName} <span className="text-xs text-fg-muted">· {new Date(a.createdAt).toLocaleString()}</span></li>)}</ul>}
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
            <Field id="p-b" label="Paid from"><select id="p-b" value={bankId} onChange={(e) => setBankId(e.target.value)} className={fieldClass} required>{view.payFrom.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select></Field>
            <Field id="p-r" label="Payment reference"><input id="p-r" value={ref} onChange={(e) => setRef(e.target.value)} className={fieldClass} required maxLength={80} autoComplete="off" /></Field>
            <Field id="p-d" label="Date paid"><input id="p-d" type="date" max={today()} value={when} onChange={(e) => setWhen(e.target.value)} className={fieldClass} required /></Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Record payment</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Close</button></div>
        </form>
      ) : null}

      <section className={`${cardClass} space-y-2`} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="space-y-2 text-sm">
          {view.events.map((e) => (
            <li key={e.id} className="border-l-2 border-line pl-3">
              <p className="font-semibold text-fg-strong">{words(e.event)}{e.to && e.to !== e.from ? ` → ${words(e.to)}` : ''}</p>
              <p className="text-xs text-fg-muted">{e.by} · {new Date(e.at).toLocaleString()}{e.surface ? ` · from ${e.surface}` : ''}{e.permission ? ` · with ${e.permission}` : ''}{e.reasonCode ? ` · ${words(e.reasonCode)}${e.reasonText ? `: ${e.reasonText}` : ''}` : ''}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
