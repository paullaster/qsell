'use client';

import Link from 'next/link';
import { use, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cancelRefundFileAction, confirmRefundFileAction, type refundFileDetailAction } from '@/server/domains/finance/refund-file-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { REFUND_FILE_STATUS, statusInfo } from '@/lib/finance-statuses';
import { confirmProblem, itemTone, itemWords } from '@/lib/refund-file-form';
import { needsComment } from '@/lib/receipt-detail';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, today, type Notice } from './ui';

type View = Extract<Awaited<ReturnType<typeof refundFileDetailAction>>, { ok: true }>['data'];

export function RefundFileDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof refundFileDetailAction> }) {
  const res = use(viewPromise);
  return res.ok ? <RefundFileView view={res.data} /> : <LoadFailed error={res.error} />;
}

function RefundFileView({ view }: { view: View }) {
  const router = useRouter();
  const [panel, setPanel] = useState<null | 'confirm' | 'cancel'>(null);
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const done = (res: { ok: true } | { ok: false; error: string }, okText: string) => {
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: okText });
    setPanel(null);
    router.refresh();
  };
  const confirm = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = confirmProblem({ reference, evidence: view.attachments.length });
    if (problem !== null) { setNotice({ kind: 'error', text: problem }); return; }
    setBusy(true);
    setNotice(null);
    const res = await attempt(confirmRefundFileAction(view.id, { bankReference: reference, paidOn }));
    done(res, res.ok ? `Recorded: ${String(res.data.paid)} ${res.data.paid === 1 ? 'refund is' : 'refunds are'} now paid.` : '');
  };
  const cancel = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const text = reasonText.trim();
    done(await attempt(cancelRefundFileAction(view.id, { code: reason?.id ?? '', text: text === '' ? undefined : text })), 'Cancelled. Its refunds can go into another file or be paid another way.');
  };
  const upload = async (file: File) => {
    setBusy(true);
    setNotice(null);
    const body = new FormData();
    body.set('file', file);
    body.set('fileId', view.id);
    try {
      const res = await fetch('/api/admin/finance/refund-file-evidence', { method: 'POST', body });
      const json = (await res.json()) as { ok: boolean; error?: string };
      setBusy(false);
      if (!json.ok) { setNotice({ kind: 'error', text: json.error ?? 'The file could not be saved.' }); return; }
      setNotice({ kind: 'ok', text: 'Confirmation attached.' });
      router.refresh();
    } catch {
      setBusy(false);
      setNotice({ kind: 'error', text: 'The file could not be sent. Check your connection and try again.' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const status = statusInfo(REFUND_FILE_STATUS, view.status);
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`Payment file ${view.number}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={status.tone}>{status.label}</Chip><span>{view.count} {view.count === 1 ? 'refund' : 'refunds'} · {view.currency} {money(view.total)} · {view.format === 'csv' ? 'CSV' : 'ISO 20022'} · from {view.method}</span></span>}
        actions={<Link href="/admin/finance/refunds/files" className={buttonClass}>All files</Link>}
      />
      <Message notice={notice} />
      <section className={`${cardClass} grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4`} aria-label="File details">
        {([['Made by', view.createdBy ?? '—'], ['Made on', new Date(view.createdAt).toLocaleString()], ['Downloaded', `${String(view.downloads)} ${view.downloads === 1 ? 'time' : 'times'}`], ['Bank reference', view.bankReference ?? '—'], ['Confirmed by', view.confirmedBy ?? '—'], ['Fingerprint', view.fingerprint.slice(0, 16)]] as [string, string][]).map(([k, v]) => (
          <div key={k}><dt className="text-xs text-fg-muted">{k}</dt><dd className="break-words font-semibold text-fg-strong">{v}</dd></div>
        ))}
        {view.cancelReason !== null ? <div className="col-span-full"><dt className="text-xs text-fg-muted">Cancelled because</dt><dd className="font-semibold text-fg-strong">{view.cancelReason}</dd></div> : null}
      </section>

      <div className="flex flex-wrap gap-2">
        {view.can.download ? <a className={primaryClass} href={`/api/admin/finance/refund-files/${view.id}/download`} download>Download the file</a> : null}
        {view.can.confirm ? <button type="button" className={primaryClass} disabled={busy} aria-expanded={panel === 'confirm'} onClick={() => setPanel('confirm')}>The bank paid it…</button> : null}
        {view.can.cancel ? <button type="button" className={dangerClass} disabled={busy} aria-expanded={panel === 'cancel'} onClick={() => setPanel('cancel')}>Cancel the file…</button> : null}
      </div>

      {panel === 'confirm' ? (
        <form onSubmit={(e) => void confirm(e)} className={`${cardClass} space-y-3`} aria-label="Record that the bank paid the file">
          <h2 className="text-sm font-bold text-fg-strong">Record that the bank paid all {view.count} {view.count === 1 ? 'refund' : 'refunds'}</h2>
          <p className="text-xs text-fg-muted">Every refund in the file is recorded as paid together, or none is. The person who made the file, and anyone who approved a refund in it, cannot do this. Attach the bank&apos;s confirmation first.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="f-ref" label="Bank reference for the file"><input id="f-ref" value={reference} onChange={(e) => setReference(e.target.value)} className={fieldClass} required maxLength={80} autoComplete="off" /></Field>
            <Field id="f-on" label="Date paid"><input id="f-on" type="date" max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={fieldClass} required /></Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Record all as paid</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Close</button></div>
        </form>
      ) : null}

      {panel === 'cancel' ? (
        <form onSubmit={(e) => void cancel(e)} className={`${cardClass} space-y-3`} aria-label="Cancel the file">
          <h2 className="text-sm font-bold text-fg-strong">Cancel this file (only if the bank has not paid it)</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChoicePicker label="Reason" source="refund-file-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
            <Field id="c-t" label={needsComment(reason?.meta) ? 'Explain (required)' : 'Comment (optional)'}><input id="c-t" value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsComment(reason?.meta)} maxLength={300} autoComplete="off" /></Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || reason === null}>Cancel the file</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Keep it</button></div>
        </form>
      ) : null}

      <section className={`${cardClass} space-y-3`} aria-label="Refunds in the file">
        <h2 className="text-sm font-bold text-fg-strong">Refunds in the file</h2>
        <ul className="divide-y divide-line text-sm">
          {view.items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/refunds/${i.refundId}`}>{i.number}</Link>
              <span className="min-w-0 flex-1 break-words text-fg-muted">{i.customer} · {i.bank} {i.account}</span>
              <span className="font-semibold">{view.currency} {money(i.amount)}</span>
              <Chip tone={itemTone(i.state)}>{itemWords(i.state)}</Chip>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${cardClass} space-y-3`} aria-label="The bank's confirmation">
        <h2 className="text-sm font-bold text-fg-strong">The bank&apos;s confirmation</h2>
        <p className="text-xs text-fg-muted">A screenshot or statement showing the bank paid the file. It must be attached before the file can be recorded as paid.</p>
        {view.attachments.length === 0 ? <p className="text-sm text-fg-muted">Nothing attached yet.</p> : <ul className="space-y-1 text-sm">{view.attachments.map((a) => <li key={a.id}>{a.url !== null ? <a className="font-semibold text-indigo-600 hover:underline" href={a.url} target="_blank" rel="noreferrer">{a.fileName}</a> : a.fileName} <span className="text-xs text-fg-muted">· {new Date(a.createdAt).toLocaleString()}</span></li>)}</ul>}
        {view.can.attach ? (
          <div>
            <label htmlFor="pf-file" className="text-xs font-semibold text-fg-muted">Add a photo or screenshot</label>
            <input id="pf-file" ref={fileRef} type="file" accept="image/*" disabled={busy} className="mt-1 block min-h-10 text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
