'use client';

import Link from 'next/link';
import { useState } from 'react';
import { listRefundsAction, type refundReportAction } from '@/server/domains/finance/refund-actions';
import { Chip, Message, PageHeader, buttonClass, cardClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

type Page = Extract<Awaited<ReturnType<typeof listRefundsAction>>, { ok: true }>['data'];
type Report = Extract<Awaited<ReturnType<typeof refundReportAction>>, { ok: true }>['data'];

export const REFUND_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved, not paid', tone: 'sky' },
  paid: { label: 'Paid', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};
const words = (s: string) => s.replace(/_/g, ' ');

export function RefundsClient({ initial, report, from, to }: { initial: Page; report: Report | null; from: string; to: string }) {
  const [rows, setRows] = useState(initial.rows);
  const [next, setNext] = useState(initial.nextBefore);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = async (more: boolean) => {
    setBusy(true);
    const res = await attempt(listRefundsAction({ status: (status || undefined) as never, q: q || undefined, before: more ? (next ?? undefined) : undefined }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice(null);
    setRows(more ? [...rows, ...res.data.rows] : res.data.rows);
    setNext(res.data.nextBefore);
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Refunds"
        intro="Money paid back to customers. Each one comes out of something the customer is owed, is approved when a workflow says so, and is paid with evidence by someone other than the approver."
        actions={initial.can.create ? <Link href="/admin/finance/refunds/new" className={primaryClass}>New refund</Link> : null}
      />
      <Message notice={notice} />

      {report ? (
        <section className={`${cardClass} space-y-4`} aria-label={`Refund report, ${from} to ${to}`}>
          <h2 className="text-sm font-bold text-fg-strong">Last 30 days ({from} to {to})</h2>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            {report.byStatus.map((s) => (
              <div key={s.status}><dt className="text-xs text-fg-muted">{REFUND_STATUS[s.status]?.label ?? s.status}</dt><dd className="font-bold text-fg-strong">{s.count} · {money(s.total)}</dd></div>
            ))}
            {report.byStatus.length === 0 ? <p className="col-span-full text-fg-muted">No refunds asked for in this period.</p> : null}
          </dl>
          {report.byReason.length > 0 || report.byMethod.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
              <div><h3 className="text-xs font-bold uppercase text-fg-muted">Paid, by reason</h3><ul>{report.byReason.map((x) => <li key={x.reason}>{words(x.reason)}: {x.count} · {money(x.total)}</li>)}</ul></div>
              <div><h3 className="text-xs font-bold uppercase text-fg-muted">Paid, by method</h3><ul>{report.byMethod.map((x) => <li key={x.method}>{x.method}: {x.count} · {money(x.total)}</li>)}</ul></div>
            </div>
          ) : null}
          {report.stuck.length > 0 ? (
            <div role="status">
              <h3 className="text-xs font-bold uppercase text-amber-700">Approved over 3 days ago and still not paid</h3>
              <ul className="text-sm">{report.stuck.map((x) => <li key={x.id}><Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/refunds/${x.id}`}>{x.number}</Link> · {x.customer} · {x.currency} {money(x.amount)}</li>)}</ul>
            </div>
          ) : null}
          {report.reconciliation.map((r) => (
            <p key={r.accountNo} className={`text-xs ${Number(r.diff) === 0 ? 'text-fg-muted' : 'font-bold text-red-700'}`} role={Number(r.diff) === 0 ? undefined : 'alert'}>
              Refunds payable {r.accountNo} {r.accountName}: books {money(r.gl)}, approved and unpaid {money(r.owed)}{Number(r.diff) === 0 ? ' — agree' : ` — DIFFERENCE ${money(r.diff)}`}
            </p>
          ))}
        </section>
      ) : null}

      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void load(false); }} role="search">
        <label className="text-xs font-semibold text-fg-muted">Status
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${fieldClass} mt-1 block`}>
            <option value="">All</option>
            {Object.entries(REFUND_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label className="min-w-40 flex-1 text-xs font-semibold text-fg-muted">Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, customer or reference" className={`${fieldClass} mt-1 block w-full`} autoComplete="off" />
        </label>
        <button type="submit" className={buttonClass} disabled={busy}>Show</button>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No refunds match.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/finance/refunds/${r.id}`} className={`${cardClass} block min-h-10 hover:bg-hover`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-bold text-fg-strong">{r.number} <span className="font-normal text-fg-muted">· {r.customer}</span></p>
                  <span className="flex items-center gap-2"><Chip tone={REFUND_STATUS[r.status]?.tone ?? 'gray'}>{REFUND_STATUS[r.status]?.label ?? r.status}</Chip></span>
                </div>
                <p className="mt-1 text-xs text-fg-muted">{r.currency} {money(r.amount)} · {r.method} · {words(r.reason)} · {new Date(r.createdAt).toLocaleDateString()}{r.detailsChanged ? ' · paid to different details' : ''}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {next ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(true)}>Show more</button> : null}
    </div>
  );
}
