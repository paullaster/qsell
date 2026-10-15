'use client';

import { use, useId, useState } from 'react';
import { billsOverviewAction, cancelInvoicesAction, sendInvoicesAction } from '@/server/domains/payments/bill-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { billRequestLabel, shortReason, when, words } from '@/lib/payment-activity-format';
import { Chip, Field, LoadFailed, Message, PageHeader, cardClass, fieldClass, primaryClass, buttonClass, type Notice, attempt } from '../finance/ui';

type Data = Extract<Awaited<ReturnType<typeof billsOverviewAction>>, { ok: true }>['data'];
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
      <section className={cardClass} aria-label="Recent requests">
        <h2 className="text-sm font-bold text-fg-strong">Recent requests</h2>
        <p className="text-xs text-fg-muted">{data.notices} payment notice{data.notices === 1 ? '' : 's'} received from Bill Manager (kept as a record; customers&apos; payments are credited through the paybill&apos;s own confirmed payments).</p>
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
