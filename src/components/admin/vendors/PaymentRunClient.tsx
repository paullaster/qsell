'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import {
  runApproveAction,
  runCancelAction,
  runConfirmAction,
  runDownloadAction,
  runReleaseAction,
  runSubmitAction,
  type runAction,
} from '@/server/domains/vendors/payment-run-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { RUN_STATUS } from '@/lib/vendor-payment-run';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof runAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };

const EVENT_WORDS: Record<string, string> = { created: 'Made', submitted: 'Sent for approval', approved: 'Approved', released: 'Released', downloaded: 'File downloaded', confirmed: 'Confirmed as paid', cancelled: 'Cancelled' };
const FORMATS: Choice[] = [{ id: 'csv', label: 'CSV' }, { id: 'pain001', label: 'ISO 20022 (pain.001)' }];

export function PaymentRunClient({ viewPromise }: { viewPromise: ReturnType<typeof runAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Run key={res.data.batch.updatedAt} view={res.data} /> : <LoadFailed error={res.error} />;
}

function Run({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const b = view.batch;
  const s = RUN_STATUS[b.status];
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState<Record<string, boolean>>(() => Object.fromEntries(view.vouchers.map((v) => [v.id, true])));
  const [reason, setReason] = useState('');
  const [format, setFormat] = useState<Choice | null>(FORMATS[0] ?? null);
  const [firstCheque, setFirstCheque] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(view.today);
  const act = async (call: Promise<Result>, done: string | ((d: unknown) => string)): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return false;
    }
    setNotice({ kind: 'ok', text: typeof done === 'string' ? done : done(res.data) });
    router.refresh();
    return true;
  };
  const download = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(runDownloadAction(b.id));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    const url = URL.createObjectURL(new Blob([res.data.content], { type: res.data.mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = res.data.fileName;
    a.click();
    URL.revokeObjectURL(url);
    setNotice({ kind: 'ok', text: `Saved ${res.data.fileName}. Fingerprint ${res.data.sha256.slice(0, 12)}…` });
    router.refresh();
  };
  const approveIds = view.vouchers.filter((v) => ticked[v.id] === true).map((v) => v.id);
  const leaving = view.vouchers.length - approveIds.length;
  const kind = view.method?.kind ?? '';
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={`Payment run ${b.number ?? ''}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={s.tone}>{s.label}</Chip><span>{view.method?.name ?? ''}</span><span>{b.itemCount} {b.itemCount === 1 ? 'voucher' : 'vouchers'}</span><span>{b.total} {b.currency}</span><span>pay on {b.executionDate}</span></span>}
        actions={<Link href="/admin/vendors/payments/runs" className={buttonClass}>All runs</Link>}
      />
      <Message notice={notice} />
      {b.note === null ? null : <p className="text-sm text-fg">{b.note}</p>}
      {b.status === 'cancelled' ? <p role="status" className="text-sm text-fg">Cancelled: {b.cancelReason}</p> : null}
      {b.status === 'confirmed' ? <p role="status" className="text-sm text-fg">Paid. Bank reference <span className="font-semibold">{b.bankReference}</span>, confirmed by {view.confirmedName ?? 'someone'}.</p> : null}

      <section className={`${cardClass} space-y-2`} aria-label="Vouchers in the run">
        <h2 className="text-sm font-bold text-fg-strong">Vouchers</h2>
        {view.vouchers.length === 0 ? <p className="text-sm text-fg-muted">No vouchers in this run.</p> : (
          <ul className="divide-y divide-line">
            {view.vouchers.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-fg">
                <label className="flex items-start gap-2">
                  {b.status === 'pending_approval' && view.can.approve ? <input type="checkbox" className="mt-1 h-4 w-4" checked={ticked[v.id] === true} onChange={(e) => setTicked((p) => ({ ...p, [v.id]: e.target.checked }))} aria-label={`Approve the payment to ${v.vendorName}`} /> : null}
                  <span><span className="font-semibold">{v.vendorName}</span> · {v.invoices} {v.invoices === 1 ? 'invoice' : 'invoices'}{v.destination === null ? '' : ` · ${v.destination}`}{v.chequeNo === null ? '' : ` · cheque ${v.chequeNo}`}<span className="block text-xs text-fg-muted">{v.number ?? 'Not numbered yet'} · {v.status.replace('_', ' ')}</span></span>
                </label>
                <span className="font-semibold tabular-nums">{v.amount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {b.status === 'draft' && view.can.create ? (
        <section className={`${cardClass} space-y-2`} aria-label="Send for approval">
          <p className="text-sm text-fg">The vouchers are drafts. Send the whole run for approval.</p>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(runSubmitAction(b.id), 'Sent for approval.')}>Send for approval</button>
        </section>
      ) : null}

      {b.status === 'pending_approval' && view.can.approve ? (
        <section className={`${cardClass} space-y-3`} aria-label="Approve the run">
          <p className="text-sm text-fg">Tick the vouchers to approve. Any you leave out are sent back and taken out of the run.</p>
          {leaving === 0 ? null : <Field id={`${uid}-back`} label="Why are the others sent back?"><input id={`${uid}-back`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" /></Field>}
          <button type="button" className={primaryClass} disabled={busy || (leaving > 0 && reason.trim() === '')} onClick={() => void act(runApproveAction(b.id, approveIds, reason), (d) => { const r = d as { approved: number; sentBack: number }; return `Approved ${String(r.approved)}, sent back ${String(r.sentBack)}.`; })}>{approveIds.length === 0 ? 'Send them all back' : `Approve ${String(approveIds.length)}`}</button>
        </section>
      ) : null}

      {b.status === 'approved' && view.can.release ? (
        <section className={`${cardClass} space-y-3`} aria-label="Release the run">
          <h2 className="text-sm font-bold text-fg-strong">Release</h2>
          {kind === 'bank_transfer' ? <ChoicePicker label="File format" source="bank-file-formats" choice={format} onChoice={setFormat} placeholder="Choose a format" /> : null}
          {kind === 'cheque' ? <Field id={`${uid}-chq`} label="Number of the first cheque" hint="The others follow in a row."><input id={`${uid}-chq`} inputMode="numeric" value={firstCheque} maxLength={12} onChange={(e) => setFirstCheque(e.target.value)} className={fieldClass} autoComplete="off" /></Field> : null}
          {kind !== 'bank_transfer' && kind !== 'cheque' ? <p className="text-xs text-fg-muted">This way of paying has no file. Pay by hand, then confirm below.</p> : null}
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(runReleaseAction(b.id, format?.id ?? '', firstCheque), 'Released.')}>Release the run</button>
        </section>
      ) : null}

      {b.status === 'released' && view.can.release ? (
        <section className={`${cardClass} space-y-3`} aria-label="Confirm the run was paid">
          {b.format === 'none' ? null : <div><button type="button" className={buttonClass} disabled={busy} onClick={() => void download()}>{b.format === 'cheque' ? 'Download the cheque list' : 'Download the bank file'}</button><p className="mt-1 text-xs text-fg-muted">Downloaded {b.downloads} {b.downloads === 1 ? 'time' : 'times'}. Released by {view.releasedName ?? 'someone'}.</p></div>}
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void act(runConfirmAction(b.id, reference, paidOn), (d) => `Paid: ${String((d as { paid: number }).paid)} vouchers.`); }} aria-label="Confirm payment">
            <p className="text-xs text-fg-muted">When the bank has paid (or the cheques are out), someone other than the person who released the run records it here. Every voucher is then paid together.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${uid}-ref`} label="Bank reference"><input id={`${uid}-ref`} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
              <Field id={`${uid}-on`} label="Date paid"><input id={`${uid}-on`} type="date" max={view.today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={fieldClass} /></Field>
            </div>
            <button type="submit" className={primaryClass} disabled={busy || reference.trim() === ''}>Confirm it was paid</button>
          </form>
        </section>
      ) : null}

      {(b.status === 'draft' || b.status === 'pending_approval' || b.status === 'approved' || b.status === 'released') && view.can.create ? (
        <section className={`${cardClass} space-y-2`} aria-label="Cancel the run">
          <Field id={`${uid}-cx`} label="Why cancel this run?"><input id={`${uid}-cx`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || reason.trim() === ''} onClick={() => void act(runCancelAction(b.id, reason), 'The run is cancelled.')}>Cancel this run</button>
        </section>
      ) : null}

      <section className={cardClass} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="mt-1 space-y-1 text-sm text-fg">
          {view.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}
        </ol>
      </section>
    </div>
  );
}
