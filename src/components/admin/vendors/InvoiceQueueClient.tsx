'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { invoiceQueueAction } from '@/server/domains/vendors/invoice-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { INVOICE_STATE, type InvoiceState } from '@/lib/supplier-invoice';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof invoiceQueueAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function InvoiceQueueClient({ initialPromise }: { initialPromise: ReturnType<typeof invoiceQueueAction> }) {
  const res = use(initialPromise);
  return res.ok ? <QueueView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function QueueView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [state, setState] = useState<Choice | null>(null);
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const load = async (s: Choice | null, m: boolean, before: Page['next'], append: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(invoiceQueueAction({ state: s?.id, mine: m, before }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => (append ? [...r, ...res.data.rows] : res.data.rows));
    setNext(res.data.next);
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Supplier invoices" intro="Invoices vendors sent. Open one to pick it up, link the goods it is for, check it and move it on." />
      <Message notice={notice} />
      <div className={`${cardClass} flex flex-wrap items-end gap-4`}>
        <div className="min-w-48 flex-1"><ChoicePicker label="Stage" source="invoice-states" choice={state} onChoice={(c) => { setState(c); void load(c, mine, null, false); }} placeholder="All open invoices" /></div>
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" className="h-4 w-4" checked={mine} onChange={(e) => { setMine(e.target.checked); void load(state, e.target.checked, null, false); }} />Only the ones I picked up</label>
      </div>
      {rows.length === 0 ? <p className="text-sm text-fg-muted">{busy ? 'Loading…' : 'No invoices here.'}</p> : (
        <ul className="space-y-2" aria-label="Invoices">
          {rows.map((r) => {
            const s = INVOICE_STATE[r.state];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/invoices/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number ?? 'No number'} · {r.vendorName}</span><span className="block text-xs text-fg-muted">Their number {r.vendorInvoiceNo} · order {r.orderNumber} · {r.total} {r.currency}{r.revision > 1 ? ` · version ${String(r.revision)}` : ''}{r.assignedTo === null ? '' : ` · with ${r.assignedTo}`}</span></span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(state, mine, next, true)}>Show older invoices</button>}
    </div>
  );
}
