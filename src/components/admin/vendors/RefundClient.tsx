'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { cancelRefundAction, postRefundAction, reverseRefundAction, type refundAction } from '@/server/domains/vendors/refund-actions';
import { REFUND_STATUS } from '@/lib/vendor-refund';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof refundAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };
const EVENT_WORDS: Record<string, string> = { requested: 'Asked for', posted: 'Booked', cancelled: 'Cancelled', reversed: 'Reversed' };

export function RefundClient({ viewPromise }: { viewPromise: ReturnType<typeof refundAction> }) {
  const res = use(viewPromise);
  return res.ok ? <View data={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ data }: { data: Data }) {
  const uid = useId();
  const router = useRouter();
  const r = data.refund;
  const s = REFUND_STATUS[r.status];
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(data.today);
  const [reason, setReason] = useState('');
  const act = async (call: Promise<Result>, done: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) setNotice({ kind: 'error', text: res.error });
    else {
      setNotice({ kind: 'ok', text: done });
      router.refresh();
    }
  };
  const iAsked = data.me !== null && data.me === r.createdBy;
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={`Refund ${r.number ?? '(not booked yet)'}`} intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={s.tone}>{s.label}</Chip><span>{data.vendor}</span></span>} actions={<Link href="/admin/vendors/refunds" className={buttonClass}>All refunds</Link>} />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-2`} aria-label="The refund">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-fg-muted">Amount</dt><dd className="font-semibold tabular-nums text-fg-strong">{r.amount} {r.currency}</dd></div>
          <div><dt className="text-xs text-fg-muted">Returns</dt><dd className="font-medium text-fg-strong">{r.creditNo}</dd></div>
          <div><dt className="text-xs text-fg-muted">Came in by</dt><dd className="font-medium text-fg-strong">{data.method}</dd></div>
          <div><dt className="text-xs text-fg-muted">Asked by</dt><dd className="font-medium text-fg-strong">{data.createdName ?? '—'}</dd></div>
        </dl>
        {r.reference === null ? null : <p className="text-sm text-fg">Reference {r.reference}, received {r.receivedOn}{data.postedName === null ? '' : `, booked by ${data.postedName}`}.</p>}
        {r.note === null ? null : <p className="text-sm text-fg">{r.note}</p>}
        {r.cancelReason === null ? null : <p className="text-sm text-fg">Cancelled: {r.cancelReason}</p>}
        {r.reverseReason === null ? null : <p className="text-sm text-fg">Reversed: {r.reverseReason}</p>}
      </section>
      {r.status === 'pending' && data.can.post ? (
        <section className={`${cardClass} space-y-3`} aria-label="Book the refund">
          {iAsked ? <p className="text-xs text-amber-700">You asked for this refund, so another person has to book it.</p> : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id={`${uid}-ref`} label="Reference of the transfer or receipt"><input id={`${uid}-ref`} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
                <Field id={`${uid}-on`} label="Date the money arrived"><input id={`${uid}-on`} type="date" value={receivedOn} max={data.today} onChange={(e) => setReceivedOn(e.target.value)} className={fieldClass} /></Field>
              </div>
              <button type="button" className={primaryClass} disabled={busy || reference.trim() === ''} onClick={() => void act(postRefundAction(r.id, { reference, receivedOn }), 'Booked.')}>Book the refund</button>
            </>
          )}
        </section>
      ) : null}
      {r.status === 'pending' && data.can.create ? (
        <section className={`${cardClass} flex flex-wrap items-end gap-2`} aria-label="Cancel the refund">
          <Field id={`${uid}-cx`} label="Why cancel it?"><input id={`${uid}-cx`} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || reason.trim() === ''} onClick={() => void act(cancelRefundAction(r.id, reason), 'Cancelled.')}>Cancel the refund</button>
        </section>
      ) : null}
      {r.status === 'posted' && data.can.reverse ? (
        <section className={`${cardClass} flex flex-wrap items-end gap-2`} aria-label="Reverse the refund">
          <Field id={`${uid}-rv`} label="Why is it reversed?"><input id={`${uid}-rv`} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || reason.trim() === ''} onClick={() => void act(reverseRefundAction(r.id, reason), 'Reversed. The credit is open again.')}>Reverse the refund</button>
        </section>
      ) : null}
      <section className={cardClass} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="mt-1 space-y-1 text-sm text-fg">{data.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}</ol>
      </section>
    </div>
  );
}
