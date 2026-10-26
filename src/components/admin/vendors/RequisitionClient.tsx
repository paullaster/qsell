'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import {
  approveRequisitionAction,
  cancelRequisitionAction,
  convertToOrderAction,
  convertToRfqAction,
  rejectRequisitionAction,
  saveRequisitionAction,
  submitRequisitionAction,
  type requisitionAction,
} from '@/server/domains/vendors/requisition-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { REQUISITION_STATUS, emptyRequisitionLine, estimatedTotalCents, type RequisitionLineForm } from '@/lib/purchase-requisition';
import { fromCents } from '@/lib/vendor-payment';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof requisitionAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };
const EVENT_WORDS: Record<string, string> = { created: 'Written', submitted: 'Sent for approval', approved: 'Approved', sent_back: 'Sent back', rejected: 'Refused', cancelled: 'Cancelled', converted: 'Turned into a document' };

export function RequisitionClient({ viewPromise }: { viewPromise: ReturnType<typeof requisitionAction> }) {
  const res = use(viewPromise);
  return res.ok ? <View key={res.data.found?.req.id ?? 'new'} data={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ data }: { data: Data }) {
  const uid = useId();
  const router = useRouter();
  const found = data.found;
  const r = found?.req ?? null;
  const mine = r === null || r.requesterId === data.me;
  const editing = data.can.create && mine && (r === null || r.status === 'draft');
  const [title, setTitle] = useState(r?.title ?? '');
  const [purpose, setPurpose] = useState(r?.purpose ?? '');
  const [category, setCategory] = useState<Choice | null>(r === null ? null : { id: r.categoryId, label: r.category });
  const [currency, setCurrency] = useState<Choice | null>(r === null ? null : { id: r.currency, label: r.currency });
  const [neededBy, setNeededBy] = useState(r?.neededBy ?? '');
  const [rows, setRows] = useState<{ key: number; line: RequisitionLineForm }[]>((found === null ? [emptyRequisitionLine()] : found.lines.map((l) => ({ productId: l.productId ?? '', description: l.description, specification: l.specification, quantity: l.quantity, unit: l.unit, estimatedUnitPrice: Number(l.estimatedUnitPrice) === 0 ? '' : l.estimatedUnitPrice }))).map((line, key) => ({ key, line })));
  const [nextKey, setNextKey] = useState(rows.length);
  const lines = rows.map((x) => x.line);
  const [text, setText] = useState('');
  const [deadline, setDeadline] = useState('');
  const [vendor, setVendor] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const act = async (call: Promise<Result>, done: string, to?: (data: unknown) => string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: done });
    if (to !== undefined) router.push(to(res.data));
    else router.refresh();
  };
  const form = () => ({ title, purpose, categoryId: category?.id ?? '', currency: currency?.id ?? '', neededBy });
  const save = async (andSend: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveRequisitionAction(r?.id ?? null, form(), lines));
    if (!res.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    if (andSend) {
      const sent = await attempt(submitRequisitionAction(res.data.id));
      if (!sent.ok) setNotice({ kind: 'error', text: sent.error });
    }
    setBusy(false);
    if (r === null) router.push(`/admin/vendors/requisitions/${res.data.id}`);
    else router.refresh();
  };
  const setLine = (i: number, patch: Partial<RequisitionLineForm>) => setRows((p) => p.map((x, k) => (k === i ? { ...x, line: { ...x.line, ...patch } } : x)));
  const addLine = () => {
    setRows((p) => [...p, { key: nextKey, line: emptyRequisitionLine() }]);
    setNextKey((n) => n + 1);
  };
  const status = r === null ? null : REQUISITION_STATUS[r.status];
  const iWrote = r !== null && r.requesterId === data.me;
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title={r === null ? 'New purchase requisition' : `Requisition ${r.number ?? '(draft)'}`} intro={<span className="flex flex-wrap items-center gap-2">{status === null ? null : <Chip tone={status.tone}>{status.label}</Chip>}{found === null ? null : <span>Asked by {found.requesterName ?? 'someone'}</span>}</span>} actions={<Link href="/admin/vendors/requisitions" className={buttonClass}>All requisitions</Link>} />
      <Message notice={notice} />
      {r?.rejectReason == null ? null : <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">{r.status === 'rejected' ? 'Refused' : 'Sent back'}: {r.rejectReason}</p>}
      <form className={`${cardClass} space-y-4`} aria-label="Requisition" onSubmit={(e) => e.preventDefault()}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id={`${uid}-t`} label="What is it for (a short title)"><input id={`${uid}-t`} value={title} maxLength={150} disabled={!editing} onChange={(e) => setTitle(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <Field id={`${uid}-n`} label="Needed by (optional)"><input id={`${uid}-n`} type="date" value={neededBy} disabled={!editing} onChange={(e) => setNeededBy(e.target.value)} className={fieldClass} /></Field>
          <ChoicePicker label="Kind of purchase" source="procurement-categories" choice={category} onChoice={setCategory} disabled={!editing} required clearable={false} placeholder="Choose the category…" />
          <ChoicePicker label="Currency" source="rfq-currencies" choice={currency} onChoice={setCurrency} disabled={!editing} required clearable={false} placeholder="Choose the currency…" />
        </div>
        <Field id={`${uid}-p`} label="Why it is needed"><input id={`${uid}-p`} value={purpose} maxLength={1000} disabled={!editing} onChange={(e) => setPurpose(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-fg">What is wanted</legend>
          {rows.map(({ key, line: l }, i) => (
            <div key={key} className="grid grid-cols-1 gap-2 rounded-lg border border-line p-2 sm:grid-cols-6">
              <div className="sm:col-span-3"><Field id={`${uid}-d${String(i)}`} label={`Item ${String(i + 1)}`}><input id={`${uid}-d${String(i)}`} value={l.description} maxLength={300} disabled={!editing} onChange={(e) => setLine(i, { description: e.target.value })} className={fieldClass} autoComplete="off" /></Field></div>
              <Field id={`${uid}-q${String(i)}`} label={`Quantity ${String(i + 1)}`}><input id={`${uid}-q${String(i)}`} inputMode="decimal" value={l.quantity} disabled={!editing} onChange={(e) => setLine(i, { quantity: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
              <Field id={`${uid}-u${String(i)}`} label={`Unit ${String(i + 1)}`}><input id={`${uid}-u${String(i)}`} value={l.unit} maxLength={20} disabled={!editing} onChange={(e) => setLine(i, { unit: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
              <Field id={`${uid}-e${String(i)}`} label={`Estimated price each ${String(i + 1)}`}><input id={`${uid}-e${String(i)}`} inputMode="decimal" value={l.estimatedUnitPrice} disabled={!editing} onChange={(e) => setLine(i, { estimatedUnitPrice: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
              {editing && rows.length > 1 ? <button type="button" className={`${buttonClass} sm:col-span-6`} onClick={() => setRows((p) => p.filter((_, k) => k !== i))}>Remove item {i + 1}</button> : null}
            </div>
          ))}
          {editing ? <button type="button" className={buttonClass} onClick={addLine}>Add an item</button> : null}
          <p className="text-sm text-fg">Estimated total: <span className="font-semibold tabular-nums">{fromCents(estimatedTotalCents(lines.filter((l) => /^\d/.test(l.quantity))))} {currency?.id ?? ''}</span></p>
        </fieldset>
        {editing ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void save(true)}>Send for approval</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void save(false)}>Save as a draft</button>
          </div>
        ) : null}
      </form>

      {r?.status === 'submitted' && data.can.approve ? (
        <section className={`${cardClass} space-y-2`} aria-label="Decide">
          {iWrote ? <p className="text-xs text-amber-700">You wrote this requisition, so another person has to decide it.</p> : <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approveRequisitionAction(r.id), 'Approved.')}>Approve</button>}
          {iWrote ? null : (
            <div className="flex flex-wrap items-end gap-2">
              <Field id={`${uid}-why`} label="Or send it back or refuse it, saying why"><input id={`${uid}-why`} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
              <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void act(rejectRequisitionAction(r.id, text, true), 'Sent back.')}>Send back</button>
              <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void act(rejectRequisitionAction(r.id, text, false), 'Refused.')}>Refuse</button>
            </div>
          )}
        </section>
      ) : null}

      {r?.status === 'approved' && data.can.convert ? (
        <section className={`${cardClass} space-y-3`} aria-label="Turn it into">
          <h2 className="text-sm font-bold text-fg-strong">Turn it into</h2>
          {data.can.toRfq ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field id={`${uid}-dl`} label="Quotes due by"><input id={`${uid}-dl`} type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={fieldClass} /></Field>
              <button type="button" className={primaryClass} disabled={busy || deadline === ''} onClick={() => void act(convertToRfqAction(r.id, deadline), 'The request for quotation is written as a draft.', (d) => `/admin/vendors/rfqs/${(d as { rfqId: string }).rfqId}`)}>A request for quotation</button>
            </div>
          ) : null}
          {data.can.toOrder ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-64"><ChoicePicker label="Order from" source="vendors" createHref="/admin/vendors/new" createLabel="Add a vendor" listHref="/admin/vendors/browse" listLabel="View all vendors" choice={vendor} onChoice={setVendor} placeholder="Search by name or number" /></div>
              <button type="button" className={buttonClass} disabled={busy || vendor === null} onClick={() => void act(convertToOrderAction(r.id, vendor?.id ?? ''), 'The order is written as a draft.', (d) => `/admin/vendors/orders/${(d as { orderId: string }).orderId}`)}>An order</button>
            </div>
          ) : null}
        </section>
      ) : null}
      {r?.status === 'converted' ? <p className="text-sm text-fg">It became {r.convertedType === 'rfq' ? 'a request for quotation' : 'an order'}: <Link className="font-semibold underline" href={r.convertedType === 'rfq' ? `/admin/vendors/rfqs/${r.convertedId ?? ''}` : `/admin/vendors/orders/${r.convertedId ?? ''}`}>open it</Link>.</p> : null}

      {r !== null && ['draft', 'submitted', 'approved'].includes(r.status) && ((data.can.create && iWrote) || r.status === 'approved') && data.can.create ? (
        <section className={`${cardClass} flex flex-wrap items-end gap-2`} aria-label="Cancel the requisition">
          <Field id={`${uid}-cx`} label="Why cancel it?"><input id={`${uid}-cx`} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} disabled={busy || text.trim() === ''} onClick={() => void act(cancelRequisitionAction(r.id, text), 'Cancelled.')}>Cancel the requisition</button>
        </section>
      ) : null}

      {found === null ? null : (
        <section className={cardClass} aria-label="History">
          <h2 className="text-sm font-bold text-fg-strong">History</h2>
          <ol className="mt-1 space-y-1 text-sm text-fg">{found.events.map((e) => <li key={e.id}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {e.who ?? 'System'} · {new Date(e.at).toLocaleString()}</span>{e.reason === null || e.reason === '' ? null : <span className="block text-xs text-fg-muted">{e.reason}</span>}</li>)}</ol>
        </section>
      )}
    </div>
  );
}
