'use client';

import { use, useId, useState } from 'react';
import { has } from '@/lib/values';
import { billsOverviewAction, cancelInvoicesAction, listBillInvoicesAction, sendInvoicesAction } from '@/server/domains/payments/bill-actions';
import { billStatus, invoiceNote, isOverdue, stillDue } from '@/lib/bill-invoices';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { billRequestLabel, shortReason, when, words } from '@/lib/payment-activity-format';
import { Chip, Field, LoadFailed, Message, PageHeader, cardClass, fieldClass, money, primaryClass, buttonClass, today, type Notice, attempt } from '../finance/ui';

type Data = Extract<Awaited<ReturnType<typeof billsOverviewAction>>, { ok: true }>['data'];
type InvoicePage = Extract<Awaited<ReturnType<typeof listBillInvoicesAction>>, { ok: true }>['data'];
const TONE: Record<string, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { succeeded: 'green', accepted: 'sky', submitted: 'sky', queued: 'amber', failed: 'red', in_doubt: 'red', timed_out: 'amber' };

/** Send, cancel and follow M-Pesa Bill Manager invoices for a paybill. */
export function BillsClient({ initialPromise }: { initialPromise: ReturnType<typeof billsOverviewAction> }) {
  const res = use(initialPromise);
  return res.ok ? <BillsView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function BillsView({ initial }: { initial: Data }) {
  const uid = useId();
  const [data, setData] = useState(initial);
  const first = initial.methods.at(0);
  const [paybill, setPaybill] = useState<Choice | null>(first === undefined ? null : { id: first.id, label: `${first.name} · paybill ${first.channel ?? ''}` });
  const methodId = paybill?.id ?? '';
  const [send, setSend] = useState('');
  const [cancel, setCancel] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const reload = async () => {
    const r = await attempt(billsOverviewAction());
    if (r.ok) setData(r.data);
  };
  const doSend = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const r = await attempt(sendInvoicesAction({ methodId, text: send }));
    setBusy(false);
    if (!r.ok) { setNotice({ kind: 'error', text: r.error }); return; }
    setNotice({ kind: r.data.status === 'failed' ? 'error' : 'ok', text: r.data.status === 'failed' ? (r.data.failureReason ?? 'Safaricom refused the invoices.') : `${r.data.count} invoice${r.data.count === 1 ? '' : 's'} sent to Bill Manager.` });
    if (r.data.status !== 'failed') setSend('');
    void reload();
  };
  const doCancel = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const r = await attempt(cancelInvoicesAction({ methodId, text: cancel }));
    setBusy(false);
    if (!r.ok) { setNotice({ kind: 'error', text: r.error }); return; }
    setNotice({ kind: r.data.status === 'failed' ? 'error' : 'ok', text: r.data.status === 'failed' ? (r.data.failureReason ?? 'Safaricom refused the request.') : `Cancellation of ${r.data.count} invoice${r.data.count === 1 ? '' : 's'} sent.` });
    if (r.data.status !== 'failed') setCancel('');
    void reload();
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Bill Manager invoices" intro="Send customers invoices and payment reminders from your paybill, and cancel invoices that are no longer due. Sign the paybill up first under Settings → Payments → Run an operation → Bill Manager: sign up." />
      <Message notice={notice} />
      {data.methods.length === 0 ? <p className={`${cardClass} text-sm`} role="status">No M-Pesa paybill is set up. Add a payment method with a paybill number under an M-Pesa provider (Settings → Payments).</p> : (
        <>
          <div className={`${cardClass} max-w-md`}>
            <ChoicePicker label="Paybill" source="bill-paybills" choice={paybill} onChoice={setPaybill} clearable={false} required />
          </div>
          {data.can.run ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <form onSubmit={(e) => void doSend(e)} className={`${cardClass} space-y-3`} aria-label="Send invoices">
                <h2 className="text-sm font-bold text-fg-strong">Send invoices</h2>
                <p className="text-xs text-fg-muted">One invoice per line, separated by commas or tabs, up to 1,000: <span className="font-mono">invoice number, customer name, phone, billing period, what it is for, due date (YYYY-MM-DD), account number, amount</span>.</p>
                <Field id={`${uid}-s`} label="Invoices"><textarea id={`${uid}-s`} value={send} onChange={(e) => setSend(e.target.value)} rows={7} className={`${fieldClass} font-mono`} placeholder="INV-1001, Jane Wanjiru, 0712345678, October 2026, Rent, 2026-10-31, C0001, 1500" required /></Field>
                <button type="submit" className={primaryClass} disabled={busy || send.trim() === ''}>{busy ? 'Sending…' : 'Send invoices'}</button>
              </form>
              <form onSubmit={(e) => void doCancel(e)} className={`${cardClass} space-y-3`} aria-label="Cancel invoices">
                <h2 className="text-sm font-bold text-fg-strong">Cancel invoices</h2>
                <p className="text-xs text-fg-muted">Invoice numbers to cancel, separated by spaces, commas or new lines. Paid invoices cannot be cancelled.</p>
                <Field id={`${uid}-c`} label="Invoice numbers"><textarea id={`${uid}-c`} value={cancel} onChange={(e) => setCancel(e.target.value)} rows={4} className={`${fieldClass} font-mono`} required /></Field>
                <button type="submit" className={buttonClass} disabled={busy || cancel.trim() === ''}>{busy ? 'Working…' : 'Cancel invoices'}</button>
              </form>
            </div>
          ) : null}
        </>
      )}
      <InvoiceList counts={data.counts} />
      <section className={cardClass} aria-label="Recent requests">
        <h2 className="text-sm font-bold text-fg-strong">Recent requests</h2>
        <p className="text-xs text-fg-muted">{data.notices} payment notice{data.notices === 1 ? '' : 's'} received from Bill Manager. A notice is a claim: the payment is credited only after Safaricom itself confirms it.</p>
        {data.recent.length === 0 ? <p className="py-3 text-sm text-fg-muted">Nothing sent yet.</p> : (
          <ul className="divide-y divide-line text-sm">
            {data.recent.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{billRequestLabel(o)} · {when(o.at)}</span>
                <span className="flex items-center gap-2"><Chip tone={TONE[o.status] ?? 'gray'}>{words(o.status)}</Chip>{o.failureReason !== null && o.failureReason !== '' ? <span className="text-red-700">{shortReason(o.failureReason, 100)}</span> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Every invoice sent, one page at a time, with what became of it: sent, paid, part paid, refused, cancelled. */
function InvoiceList({ counts }: { counts: Record<string, number> }) {
  const [status, setStatus] = useState<Choice | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState<InvoicePage | null>(null);
  const [rows, setRows] = useState<InvoicePage['rows']>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const day = today();

  const load = async (more: boolean) => {
    setBusy(true);
    setNotice(null);
    const query = q.trim();
    const res = await attempt(listBillInvoicesAction({ status: (status?.id ?? undefined) as never, q: query === '' ? undefined : query, before: more ? (page?.nextBefore ?? undefined) : undefined }));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setPage(res.data);
    setRows(more ? [...rows, ...res.data.rows] : res.data.rows);
  };
  const total = Object.values(counts).reduce((n, c) => n + c, 0);

  return (
    <section className={`${cardClass} space-y-3`} aria-label="Invoices">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-fg-strong">Invoices ({total})</h2>
        <p className="text-xs text-fg-muted">{counts.sent ?? 0} waiting for payment · {counts.part_paid ?? 0} part paid · {counts.paid ?? 0} paid · {counts.failed ?? 0} refused</p>
      </div>
      <Message notice={notice} />
      <form className="flex flex-wrap items-end gap-2" role="search" onSubmit={(e) => { e.preventDefault(); void load(false); }}>
        <div className="min-w-48"><ChoicePicker label="State" source="bill-invoice-statuses" choice={status} onChoice={setStatus} placeholder="All" /></div>
        <label className="min-w-40 flex-1 text-xs font-semibold text-fg-muted">Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice, customer or account number" className={`${fieldClass} mt-1 block w-full`} autoComplete="off" />
        </label>
        <button type="submit" className={buttonClass} disabled={busy}>Show</button>
      </form>
      {page === null ? <p className="text-sm text-fg-muted">Choose Show to list the invoices.</p> : null}
      {page !== null && rows.length === 0 ? <p className="text-sm text-fg-muted">No invoices match.</p> : null}
      {page !== null && rows.length > 0 ? (
        <ul className="divide-y divide-line text-sm">
          {rows.map((i) => {
            const s = billStatus(i.status);
            const note = invoiceNote(i);
            return (
              <li key={i.id} className="space-y-1 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 break-words font-semibold text-fg-strong">{i.reference} <span className="font-normal text-fg-muted">· {i.billedName} · account {i.accountReference}</span></p>
                  <span className="flex items-center gap-2">{isOverdue(i, day) ? <Chip tone="red">Overdue</Chip> : null}<Chip tone={s.tone}>{s.label}</Chip></span>
                </div>
                <p className="text-xs text-fg-muted">{money(i.amount)} · due {i.dueDate}{Number(i.paidAmount) > 0 ? ` · paid ${money(i.paidAmount)}${i.status === 'paid' ? '' : `, ${money(stillDue(i.amount, i.paidAmount))} to go`}` : ''} · {i.invoiceName}</p>
                {note === null ? null : <p className="break-words text-xs text-amber-700">{note}</p>}
              </li>
            );
          })}
        </ul>
      ) : null}
      {has(page?.nextBefore) ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(true)}>Show more</button> : null}
    </section>
  );
}
