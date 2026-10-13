'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { listReceiptsAction } from '@/server/domains/finance/receivables/actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

type Page = Extract<Awaited<ReturnType<typeof listReceiptsAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export const RECEIPT_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  draft: { label: 'Draft', tone: 'amber' },
  posted: { label: 'Posted', tone: 'green' },
  reversed: { label: 'Reversed', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};
export const CHEQUE_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  received: { label: 'Cheque received', tone: 'sky' },
  deposited: { label: 'Cheque deposited', tone: 'amber' },
  cleared: { label: 'Cheque cleared', tone: 'green' },
  bounced: { label: 'Cheque bounced', tone: 'red' },
};

export function ReceiptsClient({ initial }: { initial: Page }) {
  const uid = useId();
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [next, setNext] = useState(initial.nextBefore);
  const [filter, setFilter] = useState({ status: '', q: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const query = (before?: string) =>
    attempt(listReceiptsAction({
      ...(filter.status ? { status: filter.status as Row['status'] } : {}),
      ...(filter.q.trim() ? { q: filter.q.trim() } : {}),
      ...(before ? { before } : {}),
    }));
  const apply = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await query();
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setRows(res.data.rows);
    setNext(res.data.nextBefore);
  };
  const more = async () => {
    if (!next) return;
    setBusy(true);
    const res = await query(next);
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setRows((r) => [...r, ...res.data.rows]);
    setNext(res.data.nextBefore);
  };

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Customer receipts"
        intro="Money received from customers: cash, bank, cheque, M-Pesa and other. A receipt is posted once, then applied to invoices; if it was wrong it is reversed with a reason, never edited."
        actions={initial.can.create ? <Link href="/admin/finance/receipts/new" className={primaryClass}>New receipt</Link> : null}
      />
      <form onSubmit={apply} className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-3`} aria-label="Filter receipts">
        <Field id={`${uid}-q`} label="Search" hint="Receipt number, reference, customer name or number.">
          <input id={`${uid}-q`} type="search" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} className={fieldClass} autoComplete="off" />
        </Field>
        <Field id={`${uid}-st`} label="Status">
          <select id={`${uid}-st`} value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} className={fieldClass}>
            <option value="">All</option>
            {Object.entries(RECEIPT_STATUS).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}
          </select>
        </Field>
        <div className="flex items-end"><button type="submit" className={buttonClass} disabled={busy}>Apply filter</button></div>
      </form>
      <Message notice={notice} />

      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No receipts match.</p>
      ) : (
        <>
          <ul className="space-y-2 md:hidden" aria-label="Receipts">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/finance/receipts/${r.id}`} className={`${cardClass} block min-h-10 hover:bg-hover`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-bold text-fg-strong">{r.number}</p>
                    <p className="text-sm font-bold tabular-nums text-fg-strong">{r.currency} {money(r.amount)}</p>
                  </div>
                  <p className="mt-0.5 text-xs text-fg">{r.customerName}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                    <Chip tone={RECEIPT_STATUS[r.status]?.tone ?? 'gray'}>{RECEIPT_STATUS[r.status]?.label ?? r.status}</Chip>
                    {r.chequeStatus ? <Chip tone={CHEQUE_STATUS[r.chequeStatus]?.tone ?? 'gray'}>{CHEQUE_STATUS[r.chequeStatus]?.label}</Chip> : null}
                    <span>{r.methodName}</span><span>{r.paymentDate}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Customer receipts, newest first</caption>
              <thead className="text-fg-muted">
                <tr>
                  <th scope="col" className="py-2 pr-3">Receipt</th><th scope="col" className="pr-3">Customer</th><th scope="col" className="pr-3">Method</th>
                  <th scope="col" className="pr-3">Reference</th><th scope="col" className="pr-3">Date</th><th scope="col" className="pr-3">Status</th><th scope="col" className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="py-2 pr-3 font-semibold"><Link href={`/admin/finance/receipts/${r.id}`} className="text-indigo-600 hover:underline">{r.number}</Link></td>
                    <td className="pr-3">{r.customerName} <span className="text-fg-muted">{r.customerNumber}</span></td>
                    <td className="pr-3">{r.methodName}</td>
                    <td className="pr-3">{r.reference ?? '—'}</td>
                    <td className="pr-3 whitespace-nowrap">{r.paymentDate}</td>
                    <td className="pr-3">
                      <span className="flex flex-wrap gap-1">
                        <Chip tone={RECEIPT_STATUS[r.status]?.tone ?? 'gray'}>{RECEIPT_STATUS[r.status]?.label ?? r.status}</Chip>
                        {r.chequeStatus ? <Chip tone={CHEQUE_STATUS[r.chequeStatus]?.tone ?? 'gray'}>{CHEQUE_STATUS[r.chequeStatus]?.label}</Chip> : null}
                      </span>
                    </td>
                    <td className="text-right font-semibold tabular-nums">{r.currency} {money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {next ? <button type="button" className={buttonClass} onClick={more} disabled={busy}>Show older receipts</button> : null}
    </div>
  );
}
