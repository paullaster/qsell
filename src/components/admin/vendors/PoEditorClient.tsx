'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  amendPoAction, approveAdvanceAction, approvePoAction, cancelAdvanceAction, cancelPoAction, closePoAction, createAdvanceAction, decideAmendmentAction, recordPoConfirmationAction, rejectAdvanceAction, rejectPoAction, reopenPoAction, savePoAction, sendPoAction, submitAdvanceAction, submitPoAction, type poAction,
} from '@/server/domains/vendors/po-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { ADVANCE_STATUS, emptyPoHeader, emptyPoLine, orderTotals, PO_STATUS, toMoney, type PoHeaderForm, type PoLineForm } from '@/lib/purchase-order';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof poAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string };
type Panel = null | 'reject' | 'reopen' | 'cancel' | 'close' | 'confirm' | 'amend' | 'advance';
type Row = PoLineForm & { k: string; id?: string; productLabel?: string };

export function NewPoClient({ today }: { today: string }) {
  return <Editor view={null} today={today} />;
}

export function PoEditorClient({ viewPromise, today }: { viewPromise: ReturnType<typeof poAction>; today: string }) {
  const res = use(viewPromise);
  return res.ok ? <Editor view={res.data} today={today} /> : <LoadFailed error={res.error} />;
}

function Check({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex min-h-10 cursor-pointer items-start gap-2 text-sm text-fg">
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>{label}{hint === undefined ? null : <span className="block text-xs text-fg-muted">{hint}</span>}</span>
    </label>
  );
}

function Editor({ view, today }: { view: View | null; today: string }) {
  const uid = useId();
  const router = useRouter();
  const draft = view === null || view.status === 'draft';
  const [f, setF] = useState<PoHeaderForm>(view?.form ?? emptyPoHeader(today));
  const [vendor, setVendor] = useState<Choice | null>(view?.vendor ?? null);
  const [category, setCategory] = useState<Choice | null>(view?.category ?? null);
  const [currency, setCurrency] = useState<Choice | null>(view === null || view.form.currency === '' ? null : { id: view.form.currency, label: view.form.currency });
  const [rows, setRows] = useState<Row[]>(() => (view === null || view.lines.length === 0 ? [emptyPoLine()] : view.lines).map((l) => ({ ...emptyPoLine(), ...l, k: crypto.randomUUID() })));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [text, setText] = useState('');
  const [adv, setAdv] = useState({ amount: '', dueDate: '', reason: '' });
  const [override, setOverride] = useState('');
  const set = <K extends keyof PoHeaderForm>(k: K, v: PoHeaderForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const patch = (k: string, p: Partial<Row>) => setRows((r) => r.map((x) => (x.k === k ? { ...x, ...p } : x)));
  const id = view?.id ?? null;
  const totals = orderTotals(rows);
  const amending = panel === 'amend';
  const editableLines = draft || amending;

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
    setPanel(null);
    setText('');
    router.refresh();
    return true;
  };
  const header = (): PoHeaderForm => ({ ...f, vendorId: vendor?.id ?? '', categoryId: category?.id ?? '', currency: currency?.id ?? '' });
  const lineData = () => rows.map(({ k: _k, productLabel: _p, ...l }) => l);
  const save = async (): Promise<string | null> => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(savePoAction(id, header(), lineData()));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return null;
    }
    setNotice({ kind: 'ok', text: 'Saved.' });
    if (id === null) router.push(`/admin/vendors/orders/${res.data.id}`);
    else router.refresh();
    return res.data.id;
  };
  const submit = async () => {
    const saved = await save();
    if (saved !== null) await act(submitPoAction(saved, override), 'Sent for approval.');
  };

  const status = view === null ? PO_STATUS.draft : (PO_STATUS[view.status] ?? { label: view.status, tone: 'gray' as const });
  const released = view !== null && ['approved', 'sent', 'confirmed'].includes(view.status);
  const pendingAmendment = view?.amendments.find((a) => a.status === 'pending_approval');
  const liveAdvance = view?.advances.find((a) => ['draft', 'pending_approval', 'approved', 'paid'].includes(a.status));

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={view?.number ?? (view === null ? 'New purchase order' : 'Draft order')}
        intro={<span className="flex flex-wrap items-center gap-2">{view === null ? 'Not saved yet' : view.vendor.label}<Chip tone={status.tone}>{status.label}</Chip>{view !== null && view.version > 1 ? <span>Version {view.version}</span> : null}</span>}
        actions={<Link href="/admin/vendors/orders" className={buttonClass}>All orders</Link>}
      />
      <Message notice={notice} />
      {view?.cancelReason == null ? null : <p role="status" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-fg">Cancelled: {view.cancelReason}</p>}
      {view?.rfqNumber == null ? null : <p className="text-sm text-fg">Made from request {view.rfqNumber}.</p>}
      {view !== null && view.noRfq && !draft ? <p className="text-xs text-fg-muted">Not from a request for quotation. {view.form.noRfqReason}</p> : null}
      {view?.qualificationOverrideReason == null ? null : <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">Ordered from a vendor not qualified in this category. Reason: {view.qualificationOverrideReason}</p>}
      {view !== null && view.status === 'draft' && !view.qualified ? <p role="note" className="text-xs text-amber-700 dark:text-amber-400">This vendor is not qualified in the category now. {view.can.overrideQualification ? 'You can send it with a reason.' : 'It cannot be sent for approval until it is.'}</p> : null}

      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className={`${cardClass} space-y-3`} aria-label="Order details">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ChoicePicker label="Vendor" source="vendors" choice={vendor} onChoice={setVendor} disabled={!draft} required clearable={false} placeholder="Choose the vendor…" />
          <ChoicePicker label="Category" source="procurement-categories" choice={category} onChoice={setCategory} disabled={!draft} required clearable={false} placeholder="Choose the category…" />
          <ChoicePicker label="Currency" source="po-currencies" choice={currency} onChoice={setCurrency} disabled={!draft} required clearable={false} placeholder="Choose the currency…" />
          <Field id={`${uid}-od`} label="Order date"><input id={`${uid}-od`} type="date" value={f.orderDate} onChange={(e) => set('orderDate', e.target.value)} className={fieldClass} disabled={!draft} required /></Field>
          <Field id={`${uid}-ed`} label="Expected delivery"><input id={`${uid}-ed`} type="date" value={f.expectedDate} onChange={(e) => set('expectedDate', e.target.value)} className={fieldClass} disabled={!draft && !amending} /></Field>
          <Field id={`${uid}-pt`} label="Payment terms"><input id={`${uid}-pt`} value={f.paymentTerms} onChange={(e) => set('paymentTerms', e.target.value)} className={fieldClass} disabled={!draft && !amending} maxLength={500} autoComplete="off" /></Field>
          <Field id={`${uid}-dt`} label="Delivery terms"><input id={`${uid}-dt`} value={f.deliveryTerms} onChange={(e) => set('deliveryTerms', e.target.value)} className={fieldClass} disabled={!draft && !amending} maxLength={500} autoComplete="off" /></Field>
          <Field id={`${uid}-nv`} label="Notes for the vendor"><input id={`${uid}-nv`} value={f.notesToVendor} onChange={(e) => set('notesToVendor', e.target.value)} className={fieldClass} disabled={!draft && !amending} maxLength={3000} autoComplete="off" /></Field>
          {draft && view?.rfqId == null ? <div className="sm:col-span-2"><Field id={`${uid}-nr`} label="Why this order is not from a request for quotation" hint={view?.rfqRequiredAbove == null ? undefined : `An order above ${view.rfqRequiredAbove} needs a request unless someone allowed to skip it sends it.`}><input id={`${uid}-nr`} value={f.noRfqReason} onChange={(e) => set('noRfqReason', e.target.value)} className={fieldClass} maxLength={500} autoComplete="off" /></Field></div> : null}
        </div>
        {(view === null || view.can.flag) ? <Check id={`${uid}-adv`} label="Requires an advance payment" hint="Only people allowed to flag it can change this. It is approved with the order." checked={f.requiresAdvancePayment} onChange={(v) => set('requiresAdvancePayment', v)} disabled={!draft && !amending} /> : <p className="text-sm text-fg">{f.requiresAdvancePayment ? 'An advance payment is required.' : 'No advance payment is required.'}</p>}
        {draft ? <button type="submit" className={buttonClass} disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button> : null}
      </form>

      <section className={`${cardClass} space-y-3`} aria-label="Lines">
        <h3 className="text-sm font-bold text-fg-strong">What is ordered</h3>
        {rows.map((l, i) => (
          <fieldset key={l.k} className="grid grid-cols-2 gap-3 rounded-lg border border-line p-3 sm:grid-cols-6" disabled={!editableLines}>
            <legend className="px-1 text-xs font-semibold text-fg-muted">Line {i + 1}</legend>
            <div className="col-span-2 sm:col-span-6"><ChoicePicker label="Stock item (optional)" source="po-products" choice={l.productId === '' ? null : { id: l.productId, label: l.productLabel ?? l.productId }} onChoice={(c) => patch(l.k, { productId: c?.id ?? '', productLabel: c?.label ?? undefined, ...(c !== null && l.description.trim() === '' ? { description: c.label } : {}) })} placeholder="Not a stock item" disabled={!editableLines} /></div>
            <div className="col-span-2 sm:col-span-6"><Field id={`${uid}-l${String(i)}d`} label="Description"><input id={`${uid}-l${String(i)}d`} value={l.description} onChange={(e) => patch(l.k, { description: e.target.value })} className={fieldClass} maxLength={300} autoComplete="off" /></Field></div>
            <Field id={`${uid}-l${String(i)}q`} label="Quantity"><input id={`${uid}-l${String(i)}q`} inputMode="decimal" value={l.quantity} onChange={(e) => patch(l.k, { quantity: e.target.value })} className={fieldClass} /></Field>
            <Field id={`${uid}-l${String(i)}u`} label="Unit"><input id={`${uid}-l${String(i)}u`} value={l.unit} onChange={(e) => patch(l.k, { unit: e.target.value })} className={fieldClass} maxLength={20} autoComplete="off" /></Field>
            <Field id={`${uid}-l${String(i)}p`} label="Unit price"><input id={`${uid}-l${String(i)}p`} inputMode="decimal" value={l.unitPrice} onChange={(e) => patch(l.k, { unitPrice: e.target.value })} className={fieldClass} /></Field>
            <Field id={`${uid}-l${String(i)}x`} label="Discount (%)"><input id={`${uid}-l${String(i)}x`} inputMode="decimal" value={l.discountPercent} onChange={(e) => patch(l.k, { discountPercent: e.target.value })} className={fieldClass} /></Field>
            <Field id={`${uid}-l${String(i)}t`} label="Tax (%)"><input id={`${uid}-l${String(i)}t`} inputMode="decimal" value={l.taxRate} onChange={(e) => patch(l.k, { taxRate: e.target.value })} className={fieldClass} /></Field>
            <div className="flex items-end">{editableLines && rows.length > 1 ? <button type="button" className={buttonClass} onClick={() => setRows((x) => x.filter((y) => y.k !== l.k))} aria-label={`Remove line ${String(i + 1)}`}>Remove</button> : null}</div>
          </fieldset>
        ))}
        {editableLines ? <button type="button" className={buttonClass} onClick={() => setRows((x) => [...x, { ...emptyPoLine(), k: crypto.randomUUID() }])}>Add a line</button> : null}
        <p className="text-sm text-fg" aria-live="polite">Total: <span className="font-semibold">{toMoney(totals.total)} {currency?.id ?? ''}</span> <span className="text-xs text-fg-muted">({toMoney(totals.subtotal)} plus {toMoney(totals.tax)} tax)</span></p>
      </section>

      {view === null ? null : (
        <section className={`${cardClass} space-y-3`} aria-label="Actions">
          <h3 className="text-sm font-bold text-fg-strong">What happens next</h3>
          {panel === null ? (
            <div className="flex flex-wrap gap-2">
              {view.status === 'draft' && view.can.create && view.createdByMe ? (
                <>
                  {!view.qualified && view.can.overrideQualification ? <Field id={`${uid}-ov`} label="Why this vendor is not qualified (reported)"><input id={`${uid}-ov`} value={override} onChange={(e) => setOverride(e.target.value)} className={fieldClass} maxLength={500} autoComplete="off" /></Field> : null}
                  <button type="button" className={primaryClass} disabled={busy} onClick={() => void submit()}>Save and send for approval</button>
                </>
              ) : null}
              {view.status === 'pending_approval' && view.can.approve && !view.createdByMe ? (
                <>
                  <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approvePoAction(view.id).then((r) => (r.ok ? { ok: true as const } : r)), 'Approved. The order has its number.')}>Approve</button>
                  <button type="button" className={dangerClass} disabled={busy} onClick={() => setPanel('reject')}>Send back…</button>
                </>
              ) : null}
              {view.status === 'pending_approval' && view.createdByMe ? <p className="text-sm text-fg-muted">You wrote this order, so someone else must approve it.</p> : null}
              {['sent', 'confirmed', 'partially_received'].includes(view.status) ? <Link href={`/admin/vendors/receipts/new?po=${view.id}`} className={primaryClass}>Receive goods…</Link> : null}
              {view.status === 'approved' && view.can.release ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(sendPoAction(view.id), 'Sent to the vendor.')}>Send to the vendor</button> : null}
              {view.status === 'sent' && view.can.release ? <button type="button" className={buttonClass} onClick={() => setPanel('confirm')}>Record the vendor’s confirmation…</button> : null}
              {released && view.can.amend ? <button type="button" className={buttonClass} onClick={() => { setPanel('amend'); setText(''); }}>Change this order…</button> : null}
              {(view.status === 'pending_approval' || view.status === 'approved') && view.can.cancel ? <button type="button" className={buttonClass} onClick={() => setPanel('reopen')}>Take back to draft…</button> : null}
              {view.can.cancel && !['cancelled', 'closed', 'draft'].includes(view.status) ? <button type="button" className={dangerClass} onClick={() => setPanel('cancel')}>Cancel the order…</button> : null}
              {view.can.cancel && ['confirmed', 'sent'].includes(view.status) ? <button type="button" className={buttonClass} onClick={() => setPanel('close')}>Close the order…</button> : null}
              {view.status === 'draft' && view.can.cancel && view.number === null ? null : null}
            </div>
          ) : null}
          {panel !== null && panel !== 'amend' && panel !== 'advance' ? (
            <form className="space-y-2 rounded-lg border border-line p-3" aria-label={{ reject: 'Send the order back', reopen: 'Take the order back to draft', cancel: 'Cancel the order', close: 'Close the order', confirm: 'Record the confirmation' }[panel]} onSubmit={(e) => { e.preventDefault(); const calls = { reject: () => rejectPoAction(view.id, text), reopen: () => reopenPoAction(view.id, text), cancel: () => cancelPoAction(view.id, text), close: () => closePoAction(view.id, text), confirm: () => recordPoConfirmationAction(view.id, text) }; void act(calls[panel]().then((r) => (r.ok ? { ok: true as const } : r)), 'Done.'); }}>
              <Field id={`${uid}-why`} label={panel === 'confirm' ? 'How the vendor confirmed (who, and how)' : 'Why'}><input id={`${uid}-why`} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} required maxLength={500} autoComplete="off" /></Field>
              <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Confirm</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Back</button></div>
            </form>
          ) : null}
          {panel === 'amend' ? (
            <form className="space-y-2 rounded-lg border border-line p-3" aria-label="Change the order" onSubmit={(e) => { e.preventDefault(); void act(amendPoAction(view.id, header(), lineData(), text).then((r) => (r.ok ? { ok: true as const } : r)), 'The change was recorded.'); }}>
              <p className="text-sm text-fg">Edit the fields and lines above, then say why. A change to any price, or a rise beyond the tolerance, waits for someone else to approve it; otherwise it applies at once and the vendor is asked to confirm again.</p>
              <Field id={`${uid}-am`} label="Why the order changes"><input id={`${uid}-am`} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} required maxLength={500} autoComplete="off" /></Field>
              <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Record the change</button><button type="button" className={buttonClass} onClick={() => { setPanel(null); router.refresh(); }}>Back</button></div>
            </form>
          ) : null}
          {pendingAmendment === undefined ? null : (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3" role="group" aria-label="A change is waiting">
              <p className="text-sm text-fg">A change is waiting for approval: {pendingAmendment.reason}</p>
              {view.can.approve && !pendingAmendment.mine ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(decideAmendmentAction(pendingAmendment.id, true, ''), 'The change is applied. The vendor was asked to confirm again.')}>Approve the change</button>
                  <button type="button" className={dangerClass} disabled={busy} onClick={() => { setText('Not agreed'); void act(decideAmendmentAction(pendingAmendment.id, false, 'Not agreed'), 'The change is refused.'); }}>Refuse the change</button>
                </div>
              ) : <p className="text-xs text-fg-muted">{pendingAmendment.mine ? 'You proposed it, so someone else must decide.' : ''}</p>}
            </div>
          )}
        </section>
      )}

      {view !== null && view.form.requiresAdvancePayment && released ? (
        <section className={`${cardClass} space-y-3`} aria-label="Advance payment">
          <h3 className="text-sm font-bold text-fg-strong">Advance payment</h3>
          {view.advances.length === 0 ? <p className="text-sm text-fg-muted">No advance payment document yet.</p> : (
            <ul className="divide-y divide-line text-sm">
              {view.advances.map((a) => {
                const s = ADVANCE_STATUS[a.status] ?? { label: a.status, tone: 'gray' as const };
                return (
                  <li key={a.id} className="space-y-1 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-fg-strong">{a.amount} {a.currency}{a.dueDate === null ? '' : ` · due ${a.dueDate}`}</span><Chip tone={s.tone}>{s.label}</Chip></div>
                    <p className="text-xs text-fg-muted">{a.reason}{a.decisionNote === null ? '' : ` — ${a.decisionNote}`}</p>
                    <div className="flex flex-wrap gap-2">
                      {a.status === 'draft' && view.can.advanceCreate && a.mine ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(submitAdvanceAction(a.id), 'Sent for approval.')}>Send for approval</button> : null}
                      {a.status === 'pending_approval' && view.can.advanceApprove && !a.mine ? (
                        <>
                          <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approveAdvanceAction(a.id), 'The advance payment is approved.')}>Approve the advance</button>
                          <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(rejectAdvanceAction(a.id, 'Sent back for changes'), 'Sent back.')}>Send back</button>
                        </>
                      ) : null}
                      {['draft', 'pending_approval', 'approved'].includes(a.status) && view.can.advanceCreate ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(cancelAdvanceAction(a.id, 'Not needed'), 'Cancelled.')}>Cancel it</button> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {liveAdvance === undefined && view.can.advanceCreate ? (
            <form className="grid grid-cols-1 gap-3 rounded-lg border border-line p-3 sm:grid-cols-3" aria-label="Ask for an advance payment" onSubmit={(e) => { e.preventDefault(); void act(createAdvanceAction(view.id, adv).then((r) => (r.ok ? { ok: true as const } : r)), 'The advance payment document was written.'); }}>
              <Field id={`${uid}-aa`} label="Advance amount"><input id={`${uid}-aa`} inputMode="decimal" value={adv.amount} onChange={(e) => setAdv((p) => ({ ...p, amount: e.target.value }))} className={fieldClass} required autoComplete="off" /></Field>
              <Field id={`${uid}-ad`} label="Due date (optional)"><input id={`${uid}-ad`} type="date" value={adv.dueDate} onChange={(e) => setAdv((p) => ({ ...p, dueDate: e.target.value }))} className={fieldClass} /></Field>
              <Field id={`${uid}-ar`} label="Why an advance"><input id={`${uid}-ar`} value={adv.reason} onChange={(e) => setAdv((p) => ({ ...p, reason: e.target.value }))} className={fieldClass} required maxLength={500} autoComplete="off" /></Field>
              <div className="sm:col-span-3"><button type="submit" className={primaryClass} disabled={busy}>Write the advance payment</button></div>
            </form>
          ) : null}
          <p className="text-xs text-fg-muted">The advance is paid by a payment voucher that names this document. No other way to pay an advance exists.</p>
        </section>
      ) : null}

      {view === null || view.versions.length <= 1 ? null : (
        <section className={cardClass} aria-label="Versions"><h3 className="text-sm font-bold text-fg-strong">Versions</h3><ul className="mt-1 text-sm">{view.versions.map((v) => <li key={v.version}>Version {v.version}: {v.reason ?? ''} <span className="text-xs text-fg-muted">({new Date(v.at).toLocaleString()})</span></li>)}</ul></section>
      )}
      {view === null ? null : (
        <section aria-label="History" className={cardClass}>
          <h3 className="text-sm font-bold text-fg-strong">History</h3>
          <ol className="mt-2 space-y-2 text-xs">
            {view.events.map((e) => <li key={e.id} className="border-t border-line pt-2 first:border-0 first:pt-0"><p className="font-semibold text-fg-strong">{e.event.replace(/_/g, ' ')}</p><p className="text-fg-muted">{new Date(e.at).toLocaleString()} · {e.actor}{e.reason === null ? '' : ` · ${e.reason}`}</p></li>)}
          </ol>
        </section>
      )}
    </div>
  );
}
