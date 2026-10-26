'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { cancelLandedCostAction, postLandedCostAction, type landedCostAction } from '@/server/domains/vendors/landed-cost-actions';
import { LANDED_KINDS, LANDED_STATUS } from '@/lib/landed-cost';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof landedCostAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };
const EVENT_WORDS: Record<string, string> = { created: 'Entered', posted: 'Posted', cancelled: 'Cancelled' };

export function LandedCostClient({ viewPromise }: { viewPromise: ReturnType<typeof landedCostAction> }) {
  const res = use(viewPromise);
  return res.ok ? <View data={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ data }: { data: Data }) {
  const uid = useId();
  const router = useRouter();
  const r = data.cost;
  const s = LANDED_STATUS[r.status];
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
  const iEntered = data.me !== null && data.me === r.createdBy;
  const rows = r.status === 'posted' ? data.lines : (data.preview ?? []).map((l) => ({ id: l.rgnLineId, description: l.description, unit: l.unit, quantity: String(l.quantity), share: l.share, costBefore: null, costAfter: null, capitalised: null }));
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={`Landed cost ${r.number ?? '(not posted yet)'}`} intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={s.tone}>{s.label}</Chip><span>{LANDED_KINDS.find((k) => k.id === r.kind)?.label ?? r.kind} · {r.amount}</span></span>} actions={<Link href="/admin/vendors/landed-costs" className={buttonClass}>All charges</Link>} />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-2`} aria-label="The charge">
        <p className="text-sm text-fg">{r.description} · document {r.reference} · from {data.vendor} · on note <Link className="underline" href={`/admin/vendors/receipts/${r.rgnId}`}>{data.note}</Link> · spread {r.method === 'quantity' ? 'by quantity' : 'by value'}</p>
        {r.cancelReason === null ? null : <p className="text-sm text-fg">Cancelled: {r.cancelReason}</p>}
        <ul className="divide-y divide-line text-sm" aria-label="How it is spread">
          {rows.map((l) => <li key={l.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{l.description} <span className="text-xs text-fg-muted">{l.quantity} {l.unit}</span></span><span className="tabular-nums">{l.costBefore === null ? '' : `cost ${l.costBefore} → ${l.costAfter ?? ''} · `}<span className="font-semibold">{l.share}</span></span></li>)}
        </ul>
        {r.status === 'posted' ? <p className="text-xs text-fg-muted">The cost of each product is kept to the cent, so what reached the stock value can differ from the charge by a few cents.</p> : null}
      </section>
      {r.status === 'draft' && data.can.post ? (
        <section className={`${cardClass} space-y-2`} aria-label="Post the charge">
          {iEntered ? <p className="text-xs text-amber-700">You entered this charge, so another person has to post it.</p> : <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(postLandedCostAction(r.id), 'Posted. The goods now cost more.')}>Post the charge</button>}
        </section>
      ) : null}
      {r.status === 'draft' && data.can.create ? (
        <section className={`${cardClass} flex flex-wrap items-end gap-2`} aria-label="Cancel the charge">
          <Field id={`${uid}-cx`} label="Why cancel it?"><input id={`${uid}-cx`} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || reason.trim() === ''} onClick={() => void act(cancelLandedCostAction(r.id, reason), 'Cancelled.')}>Cancel the charge</button>
        </section>
      ) : null}
      <section className={cardClass} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="mt-1 space-y-1 text-sm text-fg">{data.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span></li>)}</ol>
      </section>
    </div>
  );
}
