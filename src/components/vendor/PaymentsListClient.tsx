'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { vendorPaymentsAction } from '@/server/domains/vendors/payment-portal-actions';
import { LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof vendorPaymentsAction>>, { ok: true }>['data'];

export function PaymentsListClient({ initialPromise }: { initialPromise: ReturnType<typeof vendorPaymentsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ListView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ListView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const more = async () => {
    if (next === null) return;
    setBusy(true);
    const res = await attempt(vendorPaymentsAction(next));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => [...r, ...res.data.rows]);
    setNext(res.data.next);
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Payments" intro="What we have paid you. Each payment is your remittance advice." actions={<Link href="/vendor" className={buttonClass}>Back</Link>} />
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">We have not paid you yet through the portal.</p> : (
        <ul className="space-y-2" aria-label="Payments">
          {rows.map((r) => (
            <li key={r.id} className={`${cardClass} space-y-1`}>
              <p className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-bold text-fg-strong">{r.number} · {r.paidOn}</span><span className="font-semibold tabular-nums">{r.amount} {r.currency}</span></p>
              <p className="text-xs text-fg-muted">Reference {r.reference}{r.destination === null ? '' : ` · to ${r.destination}`}</p>
              {r.invoices.length === 0 ? <p className="text-sm text-fg">{r.kind === 'advance' ? 'An advance payment.' : ''}</p> : <ul className="text-sm text-fg" aria-label="Invoices paid">{r.invoices.map((i) => <li key={i.vendorInvoiceNo}>Invoice {i.vendorInvoiceNo}: {i.amount}</li>)}</ul>}
            </li>
          ))}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void more()}>Show older payments</button>}
    </div>
  );
}
