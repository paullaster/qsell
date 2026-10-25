'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { confirmOrderAction, type vendorOrderAction } from '@/server/domains/vendors/po-portal-actions';
import { ADVANCE_STATUS, PO_STATUS } from '@/lib/purchase-order';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof vendorOrderAction>>, { ok: true }>['data'];

export function OrderDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof vendorOrderAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Detail view={res.data} /> : <LoadFailed error={res.error} />;
}

function Detail({ view }: { view: View }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const s = PO_STATUS[view.status] ?? { label: view.status, tone: 'gray' as const };
  const latest = view.versions[0];
  const confirm = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(confirmOrderAction(view.id));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'Thank you. The order is confirmed.' });
    router.refresh();
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={`Order ${view.number ?? ''}`} intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={s.tone}>{s.label}</Chip>{view.version > 1 ? <span>Version {view.version}</span> : null}</span>} actions={<Link href="/vendor/orders" className={buttonClass}>All orders</Link>} />
      <Message notice={notice} />
      {view.cancelReason === null ? null : <p role="status" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-fg">This order was cancelled: {view.cancelReason}</p>}
      {view.status === 'sent' ? (
        <section className={`${cardClass} space-y-2`} aria-label="Confirm">
          <p className="text-sm text-fg">{view.version > 1 ? 'This order was changed. Read what changed below, then confirm again.' : 'Read the order, then confirm that you accept it.'}</p>
          {view.canConfirm ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void confirm()}>{view.version > 1 ? 'Confirm the changed order' : 'Confirm this order'}</button> : <p className="text-xs text-fg-muted">Only the owner or the sales person can confirm.</p>}
        </section>
      ) : null}
      {view.version > 1 && latest !== undefined && latest.changes.length > 0 ? <section className={cardClass} aria-label="What changed"><h2 className="text-sm font-bold text-fg-strong">What changed in version {latest.version}</h2>{latest.reason === null ? null : <p className="text-xs text-fg-muted">Reason: {latest.reason}</p>}<ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-fg">{latest.changes.map((c) => <li key={c}>{c}</li>)}</ul></section> : null}
      <section className={`${cardClass} space-y-3`} aria-label="The order">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-fg-muted">Order date</dt><dd className="font-medium text-fg-strong">{view.orderDate}</dd></div>
          <div><dt className="text-xs text-fg-muted">Expected delivery</dt><dd className="font-medium text-fg-strong">{view.expectedDate ?? 'To be agreed'}</dd></div>
          <div><dt className="text-xs text-fg-muted">Payment terms</dt><dd className="font-medium text-fg-strong">{view.paymentTerms ?? '—'}</dd></div>
          <div><dt className="text-xs text-fg-muted">Delivery terms</dt><dd className="font-medium text-fg-strong">{view.deliveryTerms ?? '—'}</dd></div>
        </dl>
        {view.notes === null ? null : <p className="whitespace-pre-line text-sm text-fg">{view.notes}</p>}
        <ol className="divide-y divide-line text-sm" aria-label="Lines">
          {view.lines.map((l, i) => (
            <li key={l.id} className="py-2"><p className="font-semibold text-fg-strong">{i + 1}. {l.description}</p><p className="text-fg">{l.quantity} {l.unit} at {l.unitPrice}{l.discountPercent === '0.00' ? '' : ` less ${l.discountPercent}%`}{l.taxRate === '0.00' ? '' : `, tax ${l.taxRate}%`} = <span className="font-semibold">{l.lineTotal}</span></p><p className="text-xs text-fg-muted">Received {l.received} · invoiced {l.invoiced}{l.expectedDate === null ? '' : ` · by ${l.expectedDate}`}</p></li>
          ))}
        </ol>
        <p className="text-sm text-fg">Total: <span className="font-semibold">{view.total} {view.currency}</span> <span className="text-xs text-fg-muted">({view.subtotal} plus {view.taxTotal} tax)</span></p>
      </section>
      {view.deliveries.length === 0 ? null : (
        <section className={cardClass} aria-label="Deliveries">
          <h2 className="text-sm font-bold text-fg-strong">What we received</h2>
          <ul className="mt-2 space-y-3 text-sm">
            {view.deliveries.map((d) => (
              <li key={d.number ?? d.deliveryNoteNo}>
                <p className="font-semibold text-fg-strong">{d.number} · your delivery note {d.deliveryNoteNo} · {d.receivedDate}{d.status === 'reversed' ? ' (reversed)' : ''}</p>
                <ul className="ml-4 list-disc text-fg">{d.lines.map((l) => <li key={l.description}>{l.description}: {l.accepted} {l.unit} accepted{Number(l.rejected) > 0 ? `, ${l.rejected} refused (${l.rejectReason?.replace(/_/g, ' ') ?? 'no reason given'})` : ''}</li>)}</ul>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.requiresAdvancePayment ? (
        <section className={cardClass} aria-label="Advance payment">
          <h2 className="text-sm font-bold text-fg-strong">Advance payment</h2>
          {view.advance === null ? <p className="mt-1 text-sm text-fg-muted">This order needs an advance payment. It has not been approved yet.</p> : <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg">{view.advance.amount} {view.currency}{view.advance.dueDate === null ? '' : `, due ${view.advance.dueDate}`}<Chip tone={ADVANCE_STATUS[view.advance.status]?.tone ?? 'gray'}>{ADVANCE_STATUS[view.advance.status]?.label ?? view.advance.status}</Chip></p>}
        </section>
      ) : null}
    </div>
  );
}
