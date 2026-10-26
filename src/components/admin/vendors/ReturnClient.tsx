'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { cancelReturnAction, postReturnAction, type returnAction } from '@/server/domains/vendors/purchase-return-actions';
import { RETURN_REASONS, RETURN_STATUS } from '@/lib/purchase-return';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof returnAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };
const EVENT_WORDS: Record<string, string> = { created: 'Written', posted: 'Posted', cancelled: 'Cancelled' };

export function ReturnClient({ viewPromise }: { viewPromise: ReturnType<typeof returnAction> }) {
  const res = use(viewPromise);
  return res.ok ? <View data={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ data }: { data: Data }) {
  const uid = useId();
  const router = useRouter();
  const r = data.ret;
  const s = RETURN_STATUS[r.status];
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
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
  const iWrote = data.me !== null && data.me === r.createdBy;
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={`Return ${r.number ?? '(not posted yet)'}`} intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={s.tone}>{s.label}</Chip><span>{data.vendor}</span></span>} actions={<Link href="/admin/vendors/returns" className={buttonClass}>All returns</Link>} />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-2`} aria-label="The return">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-fg-muted">Date</dt><dd className="font-medium text-fg-strong">{r.returnDate}</dd></div>
          <div><dt className="text-xs text-fg-muted">Why</dt><dd className="font-medium text-fg-strong">{RETURN_REASONS.find((x) => x.id === r.reason)?.label ?? r.reason}</dd></div>
          <div><dt className="text-xs text-fg-muted">From note</dt><dd className="font-medium text-fg-strong"><Link className="underline" href={`/admin/vendors/receipts/${r.rgnId}`}>{data.note}</Link></dd></div>
          <div><dt className="text-xs text-fg-muted">Order</dt><dd className="font-medium text-fg-strong">{data.po}</dd></div>
        </dl>
        {r.vendorReference === null ? null : <p className="text-sm text-fg">The vendor’s reference: {r.vendorReference}</p>}
        {r.notes === null ? null : <p className="text-sm text-fg">{r.notes}</p>}
        {r.cancelReason === null ? null : <p className="text-sm text-fg">Cancelled: {r.cancelReason}</p>}
        <ul className="divide-y divide-line text-sm" aria-label="Goods going back">
          {data.lines.map((l) => <li key={l.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{l.description}</span><span className="tabular-nums">{l.quantity} {l.unit}{l.unitCost === null ? '' : ` at ${l.unitCost}`}</span></li>)}
        </ul>
        {r.status === 'posted' ? <p className="text-xs text-fg-muted">The vendor’s credit memo settles the money: record it under Credit memos from vendors.</p> : null}
      </section>
      {r.status === 'draft' && data.can.post ? (
        <section className={`${cardClass} space-y-2`} aria-label="Post the return">
          {iWrote ? <p className="text-xs text-amber-700">You wrote this return, so another person has to post it.</p> : <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(postReturnAction(r.id), 'Posted. The stock is out and the order’s received quantities are lower.')}>Post the return</button>}
        </section>
      ) : null}
      {r.status === 'draft' && data.can.create ? (
        <section className={`${cardClass} flex flex-wrap items-end gap-2`} aria-label="Cancel the return">
          <Field id={`${uid}-cx`} label="Why cancel it?"><input id={`${uid}-cx`} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || reason.trim() === ''} onClick={() => void act(cancelReturnAction(r.id, reason), 'Cancelled.')}>Cancel the return</button>
        </section>
      ) : null}
      <section className={cardClass} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="mt-1 space-y-1 text-sm text-fg">{data.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}</ol>
      </section>
    </div>
  );
}
