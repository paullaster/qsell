'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { approveCreditAction, pickUpCreditAction, postCreditAction, rejectCreditAction, returnCreditAction, type creditMemoAction } from '@/server/domains/vendors/credit-memo-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { CREDIT_STAFF_RETURNABLE, CREDIT_STATE } from '@/lib/vendor-credit-memo';
import { reasonLabel } from '@/lib/supplier-invoice';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof creditMemoAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };

const EVENT_WORDS: Record<string, string> = { created: 'Started by the vendor', submitted: 'Sent by the vendor', picked_up: 'Picked up', approved: 'Approved', posted: 'Booked', returned: 'Returned to the vendor', rejected: 'Refused', recalled: 'Taken back by the vendor', closed: 'Closed by the vendor', file_opened: 'A file was opened', credit_applied: 'Set against an invoice' };

export function CreditWorkspaceClient({ viewPromise }: { viewPromise: ReturnType<typeof creditMemoAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Workspace key={`${res.data.memo.updatedAt}-${String(res.data.events.length)}`} view={res.data} /> : <LoadFailed error={res.error} />;
}

function Workspace({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const m = view.memo;
  const state = CREDIT_STATE[m.state];
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'return' | 'reject' | null>(null);
  const [reason, setReason] = useState<Choice | null>(null);
  const [text, setText] = useState('');
  const returnable = (CREDIT_STAFF_RETURNABLE as readonly string[]).includes(m.state);
  const act = async (call: Promise<Result>, done: string | ((d: unknown) => string)): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return false;
    }
    setNotice({ kind: 'ok', text: typeof done === 'string' ? done : done(res.data) });
    router.refresh();
    return true;
  };
  const close = (): void => { setPanel(null); setReason(null); setText(''); };
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={`Credit memo ${m.number ?? ''} from ${view.vendorName}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={state.tone}>{state.label}</Chip><span>Their number {m.vendorCreditNo}</span><span>For invoice {view.invoice.vendorInvoiceNo} ({view.invoice.number})</span>{m.revision > 1 ? <span>Version {m.revision}</span> : null}{view.assignedName === null ? null : <span>With {view.assignedName}</span>}</span>}
        actions={<Link href="/admin/vendors/credit-memos" className={buttonClass}>All credit memos</Link>}
      />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-2`} aria-label="The credit memo">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-fg-muted">Date</dt><dd className="font-medium text-fg-strong">{m.creditDate}</dd></div>
          <div><dt className="text-xs text-fg-muted">Net</dt><dd className="font-medium tabular-nums text-fg-strong">{m.subtotal} {m.currency}</dd></div>
          <div><dt className="text-xs text-fg-muted">Credit with tax</dt><dd className="font-medium tabular-nums text-fg-strong">{m.total} {m.currency}</dd></div>
          <div><dt className="text-xs text-fg-muted">Still open on the invoice</dt><dd className="font-medium tabular-nums text-fg-strong">{view.invoice.open} of {view.invoice.total}</dd></div>
        </dl>
        <p className="text-sm text-fg"><span className="font-semibold">Reason given:</span> {m.reason}</p>
        {m.notes === null ? null : <p className="whitespace-pre-line text-sm text-fg">{m.notes}</p>}
        <p className="text-sm text-fg">{view.file === null ? 'No credit note file.' : <>Their credit note: <a className="font-semibold underline" href={`/api/admin/vendors/credit-files/${view.file.id}`} target="_blank" rel="noreferrer">{view.file.name}</a></>}</p>
        <ol className="divide-y divide-line text-sm" aria-label="Lines credited">
          {view.lines.map((l) => (
            <li key={l.id} className="py-2">
              <p className="font-semibold text-fg-strong">{l.position}. {l.description}</p>
              <p className="text-fg">{l.mode === 'quantity' ? `Credits ${l.quantity} ${l.unit} at ${l.unitPrice}` : `Credits ${l.unitPrice} a unit billed too high, on ${l.quantity} ${l.unit}`} = <span className="font-semibold">{(Number(l.netAmount) + Number(l.taxAmount)).toFixed(2)}</span></p>
              <p className="text-xs text-fg-muted">The invoice billed {l.billedQuantity} at {l.billedPrice} (net {l.billedNet}).</p>
            </li>
          ))}
        </ol>
      </section>

      {m.state === 'submitted' ? (
        <section className={`${cardClass} space-y-2`} aria-label="Pick up">
          <p className="text-sm text-fg">This credit memo is waiting in the queue. Picking it up makes it yours and stops the vendor taking it back.</p>
          {view.can.process ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(pickUpCreditAction(m.id), 'Picked up. Check it against the invoice, then send it for approval by someone else.')}>Pick up this credit memo</button> : <p className="text-xs text-fg-muted">You are not allowed to process credit memos.</p>}
        </section>
      ) : null}

      {m.state === 'received' ? (
        <section className={`${cardClass} space-y-2`} aria-label="Approve">
          <p className="text-sm text-fg">Check the lines against what the invoice billed. Approval has to come from someone other than the person who picked it up.</p>
          {view.can.approve ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approveCreditAction(m.id), 'Approved.')}>Approve</button> : null}
          {view.can.approveBlockedBySeparation ? <p className="text-xs text-amber-700">You picked this credit memo up, so another person has to approve it.</p> : null}
        </section>
      ) : null}

      {m.state === 'approved' && view.can.post ? (
        <section className={`${cardClass} space-y-2`} aria-label="Book">
          <p className="text-sm text-fg">Booking takes {m.total} off what we owe {view.vendorName} and credits the lines back in the books. It cannot be undone.</p>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(postCreditAction(m.id), (d) => `Booked as ${(d as { number: string }).number}.`)}>Book this credit memo</button>
        </section>
      ) : null}

      {returnable && (view.can.process || view.can.reject) ? (
        <div className="flex flex-wrap gap-2">
          {view.can.process ? <button type="button" className={buttonClass} onClick={() => setPanel('return')}>Return to the vendor…</button> : null}
          {view.can.reject ? <button type="button" className={buttonClass} onClick={() => setPanel('reject')}>Refuse this credit memo…</button> : null}
        </div>
      ) : null}
      {panel === null ? null : (
        <div className={`${cardClass} space-y-2`} role="group" aria-label={panel === 'return' ? 'Return to the vendor' : 'Refuse this credit memo'}>
          <ChoicePicker label="Reason" source="credit-memo-reasons" choice={reason} onChoice={setReason} placeholder="Choose a reason" />
          <Field id={`${uid}-note`} label={panel === 'return' ? 'What does the vendor have to fix?' : 'Note (needed for “Something else”)'}><textarea id={`${uid}-note`} rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} /></Field>
          <div className="flex flex-wrap items-center gap-2">
            {panel === 'return'
              ? <button type="button" className={primaryClass} disabled={busy || reason === null || text.trim() === ''} onClick={() => void act(returnCreditAction(m.id, reason?.id ?? '', text), 'Returned to the vendor.').then((ok) => { if (ok) close(); })}>Return it</button>
              : <InlineConfirm label={`Refuse credit memo ${m.number ?? ''}`} action="Refuse it" confirm="Yes, refuse it" busy={busy || reason === null} onConfirm={() => void act(rejectCreditAction(m.id, reason?.id ?? '', text), 'The credit memo is refused.').then((ok) => { if (ok) close(); })} />}
            <button type="button" className={buttonClass} onClick={close}>Cancel</button>
          </div>
        </div>
      )}
      {m.state === 'returned' ? <p className="text-sm text-fg">Returned to the vendor: {reasonLabel(m.returnReasonCode ?? 'other')}. {m.returnNote}</p> : null}
      {m.state === 'rejected' ? <p className="text-sm text-fg">Refused: {reasonLabel(m.rejectReasonCode ?? 'other')}. {m.rejectNote}</p> : null}
      {m.state === 'posted' ? <p className="text-sm text-fg">Booked{m.postedAt === null ? '' : ` on ${new Date(m.postedAt).toLocaleDateString()}`}. It can no longer be changed.</p> : null}

      <section className={cardClass} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="mt-1 space-y-1 text-sm text-fg">
          {view.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}
        </ol>
      </section>
    </div>
  );
}
