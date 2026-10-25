'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { vendorInvoicesAction } from '@/server/domains/vendors/invoice-portal-actions';
import { INVOICE_STATE, type InvoiceState } from '@/lib/supplier-invoice';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof vendorInvoicesAction>>, { ok: true }>['data'];

export function InvoicesListClient({ initialPromise }: { initialPromise: ReturnType<typeof vendorInvoicesAction> }) {
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
    const res = await attempt(vendorInvoicesAction(next));
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
      <PageHeader title="Invoices" intro="Invoice us for what we ordered and received. We check each one against the order and the goods." actions={<><Link href="/vendor" className={buttonClass}>Back</Link><Link href="/vendor/invoices/new" className={primaryClass}>New invoice</Link></>} />
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">You have not made an invoice yet.</p> : (
        <ul className="space-y-2" aria-label="Invoices">
          {rows.map((r) => {
            const s = INVOICE_STATE[r.state];
            return (
              <li key={r.id}>
                <Link href={`/vendor/invoices/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.vendorInvoiceNo}</span><span className="block text-xs text-fg-muted">{r.number === null ? 'Not sent yet' : `Our number ${r.number}`} · order {r.orderNumber} · {r.total} {r.currency}</span></span>
                  <span className="flex items-center gap-2">{r.needsAction ? <Chip tone="amber">Please correct</Chip> : null}<Chip tone={s.tone}>{s.label}</Chip></span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void more()}>Show older invoices</button>}
    </div>
  );
}
