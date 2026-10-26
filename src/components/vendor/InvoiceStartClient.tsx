'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { type invoiceableOrdersAction, startInvoiceAction, startInvoiceFromUblAction } from '@/server/domains/vendors/invoice-portal-actions';
import { PO_STATUS } from '@/lib/purchase-order';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

export function InvoiceStartClient({ ordersPromise }: { ordersPromise: ReturnType<typeof invoiceableOrdersAction> }) {
  const res = use(ordersPromise);
  return res.ok ? <View orders={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ orders }: { orders: Extract<Awaited<ReturnType<typeof invoiceableOrdersAction>>, { ok: true }>['data'] }) {
  const uid = useId();
  const router = useRouter();
  const [no, setNo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [problem, setProblem] = useState('');
  const start = async (poId: string) => {
    setBusy(poId);
    setNotice(null);
    setProblem('');
    const res = await attempt(startInvoiceAction(poId, no));
    setBusy(null);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      setProblem('problems' in res ? (res.problems?.vendorInvoiceNo ?? '') : '');
      return;
    }
    router.push(`/vendor/invoices/${res.data.id}`);
  };
  const fromFile = async (file: File | undefined) => {
    if (file === undefined) return;
    setBusy('file');
    setNotice(null);
    if (file.size > 1_000_000) {
      setBusy(null);
      setNotice({ kind: 'error', text: 'That file is too large. A UBL invoice is a small text file.' });
      return;
    }
    const res = await attempt(startInvoiceFromUblAction(await file.text()));
    setBusy(null);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.push(`/vendor/invoices/${res.data.id}`);
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="New invoice" intro="Type the number printed on your invoice, then choose the order it is for. We fill in what was received and not yet invoiced, at the order’s prices." actions={<Link href="/vendor/invoices" className={buttonClass}>Cancel</Link>} />
      <Message notice={notice} />
      <div className={cardClass}>
        <Field id={`${uid}-no`} label="Your invoice number" hint={problem === '' ? 'As printed on your own invoice.' : problem}>
          <input id={`${uid}-no`} value={no} onChange={(e) => setNo(e.target.value)} maxLength={60} className={fieldClass} autoComplete="off" aria-invalid={problem !== ''} />
        </Field>
      </div>
      <div className={cardClass}>
        <label className="block text-xs font-semibold text-fg" htmlFor={`${uid}-ubl`}>Or start from a UBL 2.1 invoice file</label>
        <input id={`${uid}-ubl`} type="file" accept=".xml,application/xml,text/xml" className="block w-full text-sm" disabled={busy !== null} onChange={(e) => void fromFile(e.target.files?.[0])} />
        <p className="mt-1 text-xs text-fg-muted">The file must name our order number. You still add the delivery note and its scan before sending.</p>
      </div>
      {orders.length === 0 ? <p className="text-sm text-fg-muted">There is nothing to invoice yet. Orders can be invoiced once they have been sent to you.</p> : (
        <ul className="space-y-2" aria-label="Orders you can invoice">
          {orders.map((o) => {
            const s = PO_STATUS[o.status] ?? { label: o.status, tone: 'gray' as const };
            return (
              <li key={o.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2`}>
                <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{o.number}</span><span className="block text-xs text-fg-muted">{o.total} {o.currency}{o.advance ? ' · advance payment' : ''}</span></span>
                <span className="flex items-center gap-2"><Chip tone={s.tone}>{s.label}</Chip><button type="button" className={primaryClass} disabled={busy !== null || no.trim() === ''} onClick={() => void start(o.id)} aria-label={`Invoice order ${o.number}`}>{busy === o.id ? 'Starting…' : 'Invoice this order'}</button></span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
