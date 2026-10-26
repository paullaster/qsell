'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { saveReturnAction, type returnableAction } from '@/server/domains/vendors/purchase-return-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof returnableAction>>, { ok: true }>['data'];

export function ReturnEditorClient({ viewPromise }: { viewPromise: ReturnType<typeof returnableAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Editor view={res.data} /> : <LoadFailed error={res.error} />;
}

function Editor({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [date, setDate] = useState(view.today);
  const [reason, setReason] = useState<Choice | null>(null);
  const [vendorReference, setVendorReference] = useState('');
  const [notes, setNotes] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const lines = view.lines.filter((l) => (qty[l.rgnLineId] ?? '').trim() !== '');
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveReturnAction(null, view.note.id, { returnDate: date, reason: reason?.id ?? '', vendorReference, notes }, lines.map((l) => ({ rgnLineId: l.rgnLineId, quantity: qty[l.rgnLineId] ?? '' }))));
    setBusy(false);
    if (!res.ok) setNotice({ kind: 'error', text: res.error });
    else router.push(`/admin/vendors/returns/${res.data.id}`);
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Send goods back" intro={`From received goods note ${view.note.number ?? ''}, delivery note ${view.note.deliveryNoteNo}. Another person posts the return, which takes the stock out.`} actions={<Link href={`/admin/vendors/receipts/${view.note.id}`} className={buttonClass}>Back to the note</Link>} />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-4`} aria-label="Return of goods" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id={`${uid}-d`} label="Date they go back"><input id={`${uid}-d`} type="date" value={date} max={view.today} onChange={(e) => setDate(e.target.value)} className={fieldClass} /></Field>
          <ChoicePicker label="Why" source="purchase-return-reasons" choice={reason} onChoice={setReason} placeholder="Choose a reason" />
          <Field id={`${uid}-r`} label="The vendor’s reference (optional)"><input id={`${uid}-r`} value={vendorReference} maxLength={80} onChange={(e) => setVendorReference(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <Field id={`${uid}-n`} label="Notes (optional)"><input id={`${uid}-n`} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-fg">How much of each line goes back</legend>
          {view.lines.map((l) => (
            <div key={l.rgnLineId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-2">
              <span className="min-w-0 text-sm text-fg">{l.description}<span className="block text-xs text-fg-muted">Accepted {l.accepted} {l.unit} · invoiced {l.invoiced} · already sent back {l.returned} · can go back {String(l.roomAfterDrafts)}</span></span>
              <Field id={`${uid}-q-${l.rgnLineId}`} label={`Quantity of ${l.description}`}><input id={`${uid}-q-${l.rgnLineId}`} inputMode="decimal" value={qty[l.rgnLineId] ?? ''} disabled={l.roomAfterDrafts <= 0} onChange={(e) => setQty((p) => ({ ...p, [l.rgnLineId]: e.target.value }))} className={`${fieldClass} w-28`} autoComplete="off" /></Field>
            </div>
          ))}
        </fieldset>
        <p className="text-xs text-fg-muted">Goods that were invoiced can go back once the vendor’s credit memo has been booked: it opens them again.</p>
        <button type="submit" className={primaryClass} disabled={busy || lines.length === 0 || reason === null}>Save the return</button>
      </form>
    </div>
  );
}

