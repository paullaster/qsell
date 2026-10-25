'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { cancelRgnDraftAction, postRgnAction, reverseRgnAction, saveRgnAction, type rgnAction } from '@/server/domains/vendors/rgn-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { acceptedOf, REJECT_REASONS, RGN_STATUS, type RgnHeaderForm } from '@/lib/rgn';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof rgnAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string };

export function RgnEditorClient({ viewPromise }: { viewPromise: ReturnType<typeof rgnAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Editor view={res.data} /> : <LoadFailed error={res.error} />;
}

function Editor({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const draft = view.status === 'draft';
  const [f, setF] = useState<RgnHeaderForm>(view.form);
  const [rows, setRows] = useState(() => view.lines.map((l) => ({ ...l })));
  const [busy, setBusy] = useState(false);
  const posted = useSearchParams().get('posted') === '1';
  const [notice, setNotice] = useState<Notice>(posted ? { kind: 'ok', text: 'Posted. The accepted goods are in stock.' } : null);
  // A note that was saved on this screen keeps its id, so trying again updates it instead of writing another draft.
  const [noteId, setNoteId] = useState<string | null>(view.id);
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState('');
  const state = RGN_STATUS[view.status] ?? { label: view.status, tone: 'gray' as const };
  const reasonLabel = (id: string): Choice | null => {
    const r = REJECT_REASONS.find((x) => x.id === id);
    return r === undefined ? null : { id: r.id, label: r.label };
  };
  const patch = (id: string, p: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const data = () => rows.filter((r) => r.delivered.trim() !== '').map((r) => ({ poLineId: r.id, delivered: r.delivered, rejected: r.rejected, rejectReason: r.rejectReason }));

  const act = async (call: Promise<Result>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return false;
    }
    setNotice({ kind: 'ok', text: done });
    router.refresh();
    return true;
  };
  const save = async (leave: boolean): Promise<string | null> => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveRgnAction(noteId, view.po.id, f, data()));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return null;
    }
    setNoteId(res.data.id);
    setNotice({ kind: 'ok', text: 'Saved.' });
    if (leave && view.id === null) router.push(`/admin/vendors/receipts/${res.data.id}`);
    else if (leave) router.refresh();
    return res.data.id;
  };
  const post = async () => {
    const saved = await save(false);
    if (saved === null) return;
    setBusy(true);
    const res = await attempt(postRgnAction(saved));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    if (view.id === null) router.push(`/admin/vendors/receipts/${saved}?posted=1`);
    else {
      setNotice({ kind: 'ok', text: 'Posted. The accepted goods are in stock.' });
      router.refresh();
    }
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title={view.number ?? 'New received goods note'} intro={<span className="flex flex-wrap items-center gap-2">Order {view.po.number ?? ''}{view.vendorName === null ? '' : ` · ${view.vendorName}`}<Chip tone={state.tone}>{state.label}</Chip></span>} actions={<Link href="/admin/vendors/receipts" className={buttonClass}>All received goods</Link>} />
      <Message notice={notice} />
      {view.reverseReason === null ? null : <p role="status" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-fg">Reversed: {view.reverseReason}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void save(true); }} className={`${cardClass} space-y-3`} aria-label="Delivery details">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id={`${uid}-dn`} label="Vendor’s delivery note number" hint="The number printed on the paper the driver brought."><input id={`${uid}-dn`} value={f.deliveryNoteNo} onChange={(e) => setF((p) => ({ ...p, deliveryNoteNo: e.target.value }))} className={fieldClass} disabled={!draft} required maxLength={60} autoComplete="off" /></Field>
          <Field id={`${uid}-rd`} label="Date received"><input id={`${uid}-rd`} type="date" value={f.receivedDate} onChange={(e) => setF((p) => ({ ...p, receivedDate: e.target.value }))} className={fieldClass} disabled={!draft} required /></Field>
          <Field id={`${uid}-vh`} label="Vehicle or driver (optional)"><input id={`${uid}-vh`} value={f.vehicle} onChange={(e) => setF((p) => ({ ...p, vehicle: e.target.value }))} className={fieldClass} disabled={!draft} maxLength={80} autoComplete="off" /></Field>
          <Field id={`${uid}-nt`} label="Notes (optional)"><input id={`${uid}-nt`} value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} className={fieldClass} disabled={!draft} maxLength={2000} autoComplete="off" /></Field>
        </div>
      </form>

      <section className={`${cardClass} space-y-3`} aria-label="What arrived">
        <h3 className="text-sm font-bold text-fg-strong">What arrived</h3>
        <p className="text-xs text-fg-muted">Fill in only the lines that arrived. What you refuse does not go into stock; say why.</p>
        {rows.map((l, i) => (
          <fieldset key={l.id} className="grid grid-cols-2 gap-3 rounded-lg border border-line p-3 sm:grid-cols-4" disabled={!draft}>
            <legend className="px-1 text-sm font-semibold text-fg-strong">{i + 1}. {l.description}</legend>
            <p className="col-span-2 text-xs text-fg-muted sm:col-span-4">Ordered {l.ordered} {l.unit} · received so far {l.received} · still to come {l.toCome}{l.productId === null ? ' · not a stock item' : ''}</p>
            <Field id={`${uid}-d${String(i)}`} label="Arrived"><input id={`${uid}-d${String(i)}`} inputMode="decimal" value={l.delivered} onChange={(e) => patch(l.id, { delivered: e.target.value })} className={fieldClass} /></Field>
            <Field id={`${uid}-x${String(i)}`} label="Refused"><input id={`${uid}-x${String(i)}`} inputMode="decimal" value={l.rejected} onChange={(e) => patch(l.id, { rejected: e.target.value })} className={fieldClass} /></Field>
            <div className="col-span-2"><ChoicePicker label="Why refused" source="rgn-reject-reasons" choice={reasonLabel(l.rejectReason)} onChoice={(c) => patch(l.id, { rejectReason: c?.id ?? '' })} placeholder="Only if you refused some" disabled={!draft || l.rejected.trim() === ''} /></div>
            <p className="col-span-2 text-sm text-fg sm:col-span-4" aria-live="polite">Accepted: <span className="font-semibold">{l.delivered.trim() === '' ? '—' : String(acceptedOf(l))}</span></p>
          </fieldset>
        ))}
      </section>

      <section className={`${cardClass} space-y-2`} aria-label="Actions">
        {draft ? (
          <div className="flex flex-wrap gap-2">
            {view.can.create ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void save(true)}>Save draft</button> : null}
            {view.can.post ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void post()}>Post the note</button> : null}
            {view.id !== null && view.can.create ? <InlineConfirm label="Cancel this draft note" action="Cancel the draft" confirm="Yes, cancel it" busy={busy} onConfirm={() => void act(cancelRgnDraftAction(view.id ?? ''), 'The draft is cancelled.').then((ok) => { if (ok) router.push('/admin/vendors/receipts'); })} /> : null}
          </div>
        ) : null}
        {view.status === 'posted' && view.can.reverse && reversing ? (
            <form className="space-y-2 rounded-lg border border-line p-3" aria-label="Reverse the note" onSubmit={(e) => { e.preventDefault(); void act(reverseRgnAction(view.id ?? '', reason).then((r) => (r.ok ? { ok: true as const } : r)), 'Reversed. The stock is taken out again.'); }}>
              <Field id={`${uid}-rv`} label="Why is it reversed?" hint="The stock comes out again and the order’s received quantities go back. Not possible once invoiced."><input id={`${uid}-rv`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} required maxLength={500} autoComplete="off" /></Field>
              <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy}>Reverse the note</button><button type="button" className={buttonClass} onClick={() => setReversing(false)}>Back</button></div>
            </form>
        ) : null}
        {view.status === 'posted' && view.can.reverse && !reversing ? <button type="button" className={dangerClass} onClick={() => setReversing(true)}>Reverse this note…</button> : null}
        {view.status === 'posted' ? <p className="text-xs text-fg-muted">A posted note cannot be edited. Stock went in at the order’s cost, and the stock accounts follow from it.</p> : null}
      </section>
    </div>
  );
}
