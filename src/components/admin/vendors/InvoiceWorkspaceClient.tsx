'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import {
  approveInvoiceAction,
  autoLinkInvoiceAction,
  matchInvoiceAction,
  overrideInvoiceMatchAction,
  pickUpInvoiceAction,
  postInvoiceAction,
  rejectInvoiceAction,
  returnInvoiceAction,
  saveInvoiceLinksAction,
  sendInvoiceForApprovalAction,
  type invoiceAction,
} from '@/server/domains/vendors/invoice-actions';
import { applyAdvanceAction, applyCreditAction } from '@/server/domains/vendors/payment-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { INVOICE_STATE, STAFF_RETURNABLE, reasonLabel } from '@/lib/supplier-invoice';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof invoiceAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };

const EVENT_WORDS: Record<string, string> = {
  picked_up: 'Picked up',
  linked: 'Goods linked',
  matched: 'Checked: no differences',
  match_exceptions: 'Checked: differences found',
  match_overridden: 'Differences accepted',
  sent_for_approval: 'Sent for approval',
  approved: 'Approved',
  posted: 'Booked',
  returned: 'Returned to the vendor',
  rejected: 'Refused',
  submitted: 'Sent by the vendor',
  recalled: 'Taken back by the vendor',
  file_opened: 'A file was opened',
  created: 'Started by the vendor',
  closed: 'Closed by the vendor',
};

export function InvoiceWorkspaceClient({ viewPromise }: { viewPromise: ReturnType<typeof invoiceAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Workspace key={`${res.data.invoice.updatedAt}-${String(res.data.events.length)}`} view={res.data} /> : <LoadFailed error={res.error} />;
}

function Workspace({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const inv = view.invoice;
  const etimsMissing = Number(inv.taxTotal) > 0 ? 'None given' : '—';
  const state = INVOICE_STATE[inv.state];
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<Record<string, Record<string, string>>>(() => {
    const out: Record<string, Record<string, string>> = {};
    for (const l of view.lines) out[l.id] = Object.fromEntries(l.links.map((k) => [k.rgnLineId, String(Number(k.quantity))]));
    return out;
  });
  const [accounts, setAccounts] = useState<Record<string, Choice | null>>(() => Object.fromEntries(view.lines.map((l) => [l.id, l.glAccountId === null ? null : { id: l.glAccountId, label: l.glAccountLabel }])));
  const [noteRgn, setNoteRgn] = useState<Record<string, string | null>>(() => Object.fromEntries(view.deliveryNotes.map((n) => [n.id, n.matchedRgnId])));
  const [panel, setPanel] = useState<'override' | 'return' | 'reject' | null>(null);
  const [reason, setReason] = useState<Choice | null>(null);
  const [text, setText] = useState('');
  const linkable = view.can.process && ['received', 'rgn_linked', 'matched'].includes(inv.state);
  const returnable = (STAFF_RETURNABLE as readonly string[]).includes(inv.state);
  const exceptions = view.lines.filter((l) => l.match?.status === 'exception').length;

  const act = async (call: Promise<Result>, done: string | ((data: unknown) => string)): Promise<boolean> => {
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
  const linkPayload = () => ({
    links: view.lines.flatMap((l) => Object.entries(links[l.id] ?? {}).filter(([, q]) => q.trim() !== '' && Number(q) > 0).map(([rgnLineId, quantity]) => ({ lineId: l.id, rgnLineId, quantity }))),
    accounts: view.lines.map((l) => ({ lineId: l.id, glAccountId: accounts[l.id]?.id ?? null })),
    notes: view.deliveryNotes.map((n) => ({ noteId: n.id, rgnId: noteRgn[n.id] ?? null })),
  });
  const linkSummary = (data: unknown): string => {
    const d = data as { complete?: boolean; missing?: string[] };
    return d.complete === true ? 'Linked. The goods and delivery notes are complete.' : `Saved, but not complete yet: ${(d.missing ?? []).join(' ')}`;
  };
  const rgnChoices = [...new Map(view.candidates.map((c) => [c.rgnId, c])).values()];
  const done = (): void => { setPanel(null); setReason(null); setText(''); };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`Invoice ${inv.number ?? ''} from ${view.vendorName}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={state.tone}>{state.label}</Chip><span>Their number {inv.vendorInvoiceNo}</span><span>Order {view.order.number}</span>{inv.revision > 1 ? <span>Version {inv.revision}</span> : null}{view.assignedName === null ? null : <span>With {view.assignedName}</span>}</span>}
        actions={<Link href="/admin/vendors/invoices" className={buttonClass}>All invoices</Link>}
      />
      <Message notice={notice} />
      {inv.advanceBasis ? <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">This invoice has no delivery note. It was accepted because the order is set up for an advance payment and one was approved. It is checked against the advance. It is not booked: the advance is paid with an advance payment voucher, and set against the final invoice when that is booked.</p> : null}
      {inv.matchOverrideReason === null ? null : <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">Differences were accepted{view.matchedName === null ? '' : ` by ${view.matchedName}`}: {inv.matchOverrideReason}</p>}

      <section className={`${cardClass} space-y-2`} aria-label="The invoice">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-fg-muted">Invoice date</dt><dd className="font-medium text-fg-strong">{inv.invoiceDate}</dd></div>
          <div><dt className="text-xs text-fg-muted">Due</dt><dd className="font-medium text-fg-strong">{inv.dueDate ?? '—'}</dd></div>
          <div><dt className="text-xs text-fg-muted">Net</dt><dd className="font-medium text-fg-strong">{inv.subtotal} {inv.currency}</dd></div>
          <div><dt className="text-xs text-fg-muted">Total with tax</dt><dd className="font-medium text-fg-strong">{inv.total} {inv.currency}</dd></div>
          <div><dt className="text-xs text-fg-muted">eTIMS invoice number</dt><dd className="font-medium text-fg-strong">{inv.etimsInvoiceNo ?? etimsMissing}{inv.etimsVerificationUrl === null ? null : <> · <a className="underline" href={inv.etimsVerificationUrl} target="_blank" rel="noreferrer noopener">Verify</a></>}</dd></div>
        </dl>
        <p className="text-sm text-fg">
          {view.invoiceFile === null ? 'No invoice file.' : <>Their invoice: <a className="font-semibold underline" href={`/api/admin/vendors/invoice-files/${view.invoiceFile.id}`} target="_blank" rel="noreferrer">{view.invoiceFile.name}</a></>}
        </p>
        {inv.notes === null ? null : <p className="whitespace-pre-line text-sm text-fg">{inv.notes}</p>}
      </section>

      {inv.state === 'submitted' ? (
        <section className={`${cardClass} space-y-2`} aria-label="Pick up">
          <p className="text-sm text-fg">This invoice is waiting in the queue. Picking it up makes it yours and stops the vendor taking it back.</p>
          {view.can.process ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(pickUpInvoiceAction(inv.id), 'Picked up. Link the received goods next.')}>Pick up this invoice</button> : <p className="text-xs text-fg-muted">You are not allowed to process invoices.</p>}
        </section>
      ) : null}

      <section className={`${cardClass} space-y-3`} aria-label="Lines and received goods">
        <h2 className="text-sm font-bold text-fg-strong">1. Link the received goods</h2>
        <ol className="space-y-3">
          {view.lines.map((l) => {
            const goods = view.candidates.filter((c) => c.poLineId === l.poLineId);
            const m = l.match;
            return (
              <li key={l.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-fg-strong">{l.position}. {l.description}</p>
                  {m === null ? null : <Chip tone={m.status === 'ok' ? 'green' : 'red'}>{m.status === 'ok' ? 'No difference' : 'Difference'}</Chip>}
                </div>
                <p className="text-xs text-fg-muted">Invoice: {l.quantity} {l.unit} at {l.unitPrice} · order price {l.orderPrice} · tax {l.taxRate}%</p>
                {m === null || m.problems.length === 0 ? null : <ul className="mt-1 list-disc pl-5 text-xs text-red-700" aria-label={`Differences on line ${String(l.position)}`}>{m.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
                {inv.advanceBasis ? <p className="mt-2 text-xs text-fg-muted">No goods to link: this invoice is for the advance.</p> : null}
                {!inv.advanceBasis && goods.length === 0 ? <p className="mt-2 text-xs text-amber-700">Nothing has been received for this line yet. Receive the goods first, or return the invoice.</p> : null}
                {!inv.advanceBasis && goods.length > 0 ? (
                  <ul className="mt-2 space-y-2" aria-label={`Received goods for line ${String(l.position)}`}>
                    {goods.map((g) => (
                      <li key={g.rgnLineId} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_9rem]">
                        <span className="text-sm text-fg">{g.rgnNumber} · delivery note {g.noteNo} · {g.receivedDate} · accepted {Number(g.accepted)}, invoiced {Number(g.invoiced)}, free for this invoice {g.room}</span>
                        <Field id={`${uid}-${l.id}-${g.rgnLineId}`} label="Quantity to link"><input id={`${uid}-${l.id}-${g.rgnLineId}`} inputMode="decimal" disabled={!linkable} value={links[l.id]?.[g.rgnLineId] ?? ''} onChange={(e) => setLinks((p) => ({ ...p, [l.id]: { ...(p[l.id] ?? {}), [g.rgnLineId]: e.target.value } }))} className={fieldClass} autoComplete="off" /></Field>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {l.stock || inv.advanceBasis ? null : (
                  <div className="mt-2 max-w-sm"><ChoicePicker label="Book this line to the account" source="invoice-gl-accounts" choice={accounts[l.id] ?? null} onChoice={(c) => setAccounts((p) => ({ ...p, [l.id]: c }))} placeholder="Search by number or name" disabled={!linkable} /></div>
                )}
              </li>
            );
          })}
        </ol>

        {view.deliveryNotes.length === 0 ? null : (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-fg-strong">The vendor’s delivery notes</h3>
            <ul className="space-y-2" aria-label="Delivery notes">
              {view.deliveryNotes.map((n) => (
                <li key={n.id} className="rounded-lg border border-line p-3 text-sm text-fg">
                  <p>Delivery note <span className="font-semibold">{n.noteNo}</span> ({n.noteDate}) · <a className="font-semibold underline" href={`/api/admin/vendors/invoice-files/${n.fileId}`} target="_blank" rel="noreferrer">{n.fileName}</a></p>
                  <div role="group" aria-label={`Received goods note for delivery note ${n.noteNo}`} className="mt-2 flex flex-wrap items-center gap-2">
                    {rgnChoices.length === 0 ? <span className="text-xs text-amber-700">No goods have been received for this order yet.</span> : rgnChoices.map((r) => (
                      <button key={r.rgnId} type="button" disabled={!linkable} aria-pressed={noteRgn[n.id] === r.rgnId} onClick={() => setNoteRgn((p) => ({ ...p, [n.id]: p[n.id] === r.rgnId ? null : r.rgnId }))} className={`${buttonClass} ${noteRgn[n.id] === r.rgnId ? 'ring-2 ring-indigo-500' : ''}`}>{r.rgnNumber} (note {r.noteNo})</button>
                    ))}
                    {noteRgn[n.id] === null || noteRgn[n.id] === undefined ? <Chip tone="amber">Not matched</Chip> : <Chip tone="green">Matched</Chip>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {linkable ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(autoLinkInvoiceAction(inv.id), linkSummary)}>Link automatically</button>
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(saveInvoiceLinksAction(inv.id, linkPayload()), linkSummary)}>Save the links</button>
          </div>
        ) : null}
      </section>

      <section className={`${cardClass} space-y-3`} aria-label="Check and approve">
        <h2 className="text-sm font-bold text-fg-strong">2. Check, approve and book</h2>
        <p className="text-xs text-fg-muted">The check compares each line with the order and the goods linked. A price may be above the order by up to {view.tolerances.pricePercent}% or {(view.tolerances.priceAmountCents / 100).toFixed(2)} on the line; quantities may be {view.tolerances.quantityPercent}% above what is linked.</p>
        {inv.linkedBy === null ? null : <p className="text-xs text-fg-muted">Linked by {view.linkedName ?? 'someone'}{view.matchedName === null ? '' : `, checked by ${view.matchedName}`}{view.approvedName === null ? '' : `, approved by ${view.approvedName}`}.</p>}
        <div className="flex flex-wrap gap-2">
          {inv.state === 'rgn_linked' && view.can.process ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(matchInvoiceAction(inv.id), (d) => ((d as { ok?: boolean }).ok === true ? 'Checked. No differences.' : 'Checked. There are differences to look at.'))}>Run the check</button> : null}
          {inv.state === 'matched' && view.can.process ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(sendInvoiceForApprovalAction(inv.id), 'Sent for approval.')}>Send for approval</button> : null}
          {inv.state === 'matched' && view.can.process ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(matchInvoiceAction(inv.id), 'Checked again.')}>Check again</button> : null}
          {inv.state === 'pending_approval' && view.can.approve ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approveInvoiceAction(inv.id), 'Approved.')}>Approve</button> : null}
          {inv.state === 'approved' && view.can.post ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(postInvoiceAction(inv.id), (d) => `Booked as ${(d as { number: string }).number}.`)}>Book this invoice</button> : null}
        </div>
        {inv.state === 'pending_approval' && view.inWorkflow ? <p role="status" className="text-sm text-fg-muted">Waiting in the Approvals inbox: an approval workflow covers this, so it is approved there.</p> : null}
        {inv.state === 'pending_approval' && view.can.approveBlockedBySeparation ? <p className="text-xs text-amber-700">You linked or checked this invoice, so another person has to approve it.</p> : null}
        {inv.state === 'rgn_linked' && exceptions > 0 && view.can.override ? <button type="button" className={buttonClass} onClick={() => setPanel('override')}>Accept the differences…</button> : null}
        {inv.state === 'rgn_linked' && exceptions > 0 && !view.can.override ? <p className="text-xs text-fg-muted">The differences can be accepted only by someone allowed to, or the invoice can be returned to the vendor.</p> : null}

        {panel === 'override' ? (
          <div className="space-y-2 rounded-lg border border-line p-3" role="group" aria-label="Accept the differences">
            <Field id={`${uid}-ov`} label="Why are the differences accepted?"><input id={`${uid}-ov`} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <div className="flex gap-2"><button type="button" className={primaryClass} disabled={busy || text.trim() === ''} onClick={() => void act(overrideInvoiceMatchAction(inv.id, text), 'The differences are accepted.').then((ok) => { if (ok) done(); })}>Accept them</button><button type="button" className={buttonClass} onClick={done}>Cancel</button></div>
          </div>
        ) : null}

        {returnable && (view.can.return || view.can.reject) ? (
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {view.can.return ? <button type="button" className={buttonClass} onClick={() => setPanel('return')}>Return to the vendor…</button> : null}
            {view.can.reject ? <button type="button" className={buttonClass} onClick={() => setPanel('reject')}>Refuse this invoice…</button> : null}
          </div>
        ) : null}
        {panel === 'return' || panel === 'reject' ? (
          <div className="space-y-2 rounded-lg border border-line p-3" role="group" aria-label={panel === 'return' ? 'Return to the vendor' : 'Refuse this invoice'}>
            <ChoicePicker label="Reason" source="invoice-reasons" choice={reason} onChoice={setReason} placeholder="Choose a reason" />
            <Field id={`${uid}-note`} label={panel === 'return' ? 'What does the vendor have to fix?' : 'Note (needed for “Something else”)'}><textarea id={`${uid}-note`} rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} /></Field>
            <div className="flex flex-wrap items-center gap-2">
              {panel === 'return'
                ? <button type="button" className={primaryClass} disabled={busy || reason === null || text.trim() === ''} onClick={() => void act(returnInvoiceAction(inv.id, reason?.id ?? '', text), 'Returned to the vendor.').then((ok) => { if (ok) done(); })}>Return it</button>
                : <InlineConfirm label={`Refuse invoice ${inv.number ?? ''}`} action="Refuse it" confirm="Yes, refuse it" busy={busy || reason === null} onConfirm={() => void act(rejectInvoiceAction(inv.id, reason?.id ?? '', text), 'The invoice is refused.').then((ok) => { if (ok) done(); })} />}
              <button type="button" className={buttonClass} onClick={done}>Cancel</button>
            </div>
          </div>
        ) : null}
        {inv.state === 'returned' ? <p className="text-sm text-fg">Returned to the vendor: {reasonLabel(inv.returnReasonCode ?? 'other')}. {inv.returnNote}</p> : null}
        {inv.state === 'rejected' ? <p className="text-sm text-fg">Refused: {reasonLabel(inv.rejectReasonCode ?? 'other')}. {inv.rejectNote}</p> : null}
        {inv.state === 'posted' ? <p className="text-sm text-fg">Booked{inv.postedAt === null ? '' : ` on ${new Date(inv.postedAt).toLocaleDateString()}`}. It can no longer be changed. A correction is a credit memo.</p> : null}
        {inv.state === 'posted' && view.bookedInvoice !== null ? (
          <div className="flex flex-wrap gap-2">
            {view.can.pay ? <Link href={`/admin/vendors/payments/new?invoice=${view.bookedInvoice.id}`} className={primaryClass}>Pay this invoice</Link> : null}
            {view.can.applyAdvance ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(applyAdvanceAction(view.bookedInvoice?.id ?? ''), (d) => `The advance is set against this invoice: ${((d as { appliedCents: number }).appliedCents / 100).toFixed(2)}.`)}>Set a paid advance against it</button> : null}
            {view.can.applyAdvance ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(applyCreditAction(view.bookedInvoice?.id ?? ''), (d) => `Payments on account are set against this invoice: ${((d as { appliedCents: number }).appliedCents / 100).toFixed(2)}.`)}>Set payments on account against it</button> : null}
          </div>
        ) : null}
      </section>

      <section className={cardClass} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="mt-1 space-y-1 text-sm text-fg">
          {view.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}
        </ol>
      </section>
    </div>
  );
}
