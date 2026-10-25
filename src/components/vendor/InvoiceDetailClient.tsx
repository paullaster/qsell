'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useRef, useState } from 'react';
import { closeInvoiceAction, recallInvoiceAction, saveInvoiceAction, submitInvoiceAction, type vendorInvoiceAction } from '@/server/domains/vendors/invoice-portal-actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { INVOICE_STATE, invoiceTotals, type InvoiceState } from '@/lib/supplier-invoice';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof vendorInvoiceAction>>, { ok: true }>['data'];

const EVENT_WORDS: Record<string, string> = {
  submitted: 'Sent to us',
  picked_up: 'We started checking it',
  linked: 'Linked to what we received',
  matched: 'Checked against the order',
  approved: 'Approved',
  posted: 'Booked for payment',
  returned: 'Returned to you',
  rejected: 'Refused',
  recalled: 'You took it back',
  closed: 'You closed it',
};

export function InvoiceDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof vendorInvoiceAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Detail view={res.data} /> : <LoadFailed error={res.error} />;
}

interface NoteRow {
  noteNo: string;
  noteDate: string;
  fileId: string;
  fileName: string;
}

async function upload(file: File): Promise<{ id: string; name: string } | string> {
  const body = new FormData();
  body.set('file', file);
  try {
    const response = await fetch('/api/vendor/invoice-files', { method: 'POST', body });
    const result = (await response.json()) as { ok: boolean; error?: string; data?: { id: string; name: string } };
    if (result.ok && result.data !== undefined) return result.data;
    return result.error ?? 'The upload failed. Please try again.';
  } catch {
    return 'The upload failed. Check your connection and try again.';
  }
}

function Detail({ view }: { view: View }) {
  const router = useRouter();
  const uid = useId();
  const state = INVOICE_STATE[view.state];
  const [notice, setNotice] = useState<Notice>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [header, setHeader] = useState({ vendorInvoiceNo: view.vendorInvoiceNo, invoiceDate: view.invoiceDate, dueDate: view.dueDate, notes: view.notes, declaration: view.declaration });
  const [lines, setLines] = useState(view.lines.map((l) => ({ poLineId: l.poLineId, description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, orderPrice: l.orderPrice, goodsRoom: l.goodsRoom, advanceRoom: l.advanceRoom })));
  const [notes, setNotes] = useState<NoteRow[]>(view.deliveryNotes.map((n) => ({ noteNo: n.noteNo, noteDate: n.noteDate, fileId: n.fileId, fileName: n.fileName })));
  const [scan, setScan] = useState<{ id: string; name: string } | null>(view.invoiceFile);
  const scanInput = useRef<HTMLInputElement | null>(null);
  const [closing, setClosing] = useState('');
  const editor = view.editable && view.canWrite;
  const err = (key: string): string => problems[key] ?? '';
  const totals = invoiceTotals(lines.map((l) => ({ quantity: l.quantity === '' ? '0' : l.quantity, unitPrice: l.unitPrice === '' ? '0' : l.unitPrice, taxRate: l.taxRate })));
  const money = (c: number): string => (c / 100).toFixed(2);

  const payload = () => ({ header, lines: lines.map((l) => ({ poLineId: l.poLineId, quantity: l.quantity, unitPrice: l.unitPrice })), deliveryNotes: notes.map((n) => ({ noteNo: n.noteNo, noteDate: n.noteDate, fileId: n.fileId })), invoiceFileId: scan?.id ?? '' });
  const save = async (): Promise<boolean> => {
    const res = await attempt(saveInvoiceAction(view.id, payload()));
    if (!res.ok) {
      setProblems('problems' in res ? (res.problems ?? {}) : {});
      setNotice({ kind: 'error', text: res.error });
      return false;
    }
    setProblems({});
    return true;
  };
  const saveOnly = async () => {
    setBusy(true);
    setNotice(null);
    if (await save()) setNotice({ kind: 'ok', text: 'Saved. You can come back and finish later.' });
    setBusy(false);
  };
  const send = async () => {
    setBusy(true);
    setNotice(null);
    if (await save()) {
      const res = await attempt(submitInvoiceAction(view.id));
      if (res.ok) {
        router.refresh();
        setNotice({ kind: 'ok', text: `Sent. Our number for it is ${res.data.number}.` });
      } else {
        setProblems('problems' in res ? (res.problems ?? {}) : {});
        setNotice({ kind: 'error', text: res.error });
      }
    }
    setBusy(false);
  };
  const act = async (call: ReturnType<typeof recallInvoiceAction>  , okText: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      setProblems('problems' in res ? (res.problems ?? {}) : {});
      return;
    }
    setNotice({ kind: 'ok', text: okText });
    router.refresh();
  };
  const pickScan = async (file: File | undefined) => {
    if (file === undefined) return;
    setBusy(true);
    const out = await upload(file);
    setBusy(false);
    if (typeof out === 'string') setNotice({ kind: 'error', text: out });
    else setScan(out);
    if (scanInput.current !== null) scanInput.current.value = '';
  };
  const pickNote = async (i: number, file: File | undefined) => {
    if (file === undefined) return;
    setBusy(true);
    const out = await upload(file);
    setBusy(false);
    if (typeof out === 'string') setNotice({ kind: 'error', text: out });
    else setNotes((p) => p.map((n, k) => (k === i ? { ...n, fileId: out.id, fileName: out.name } : n)));
  };
  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) => setLines((p) => p.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const messages = Object.values(problems);

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title={`Invoice ${view.vendorInvoiceNo}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={state.tone}>{state.label}</Chip>{view.number === null ? null : <span>Our number {view.number}</span>}<span>Order {view.orderNumber}</span>{view.revision > 1 ? <span>Version {view.revision}</span> : null}</span>}
        actions={<Link href="/vendor/invoices" className={buttonClass}>All invoices</Link>}
      />
      <Message notice={notice} />
      <p className="text-sm text-fg">{view.stateWords}</p>
      {view.returnReason === null ? null : <section role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg"><p className="font-semibold">We sent this back: {view.returnReason.label}</p><p className="whitespace-pre-line">{view.returnReason.note}</p></section>}
      {view.rejectReason === null ? null : <section role="status" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-fg"><p className="font-semibold">We cannot accept this invoice: {view.rejectReason.label}</p>{view.rejectReason.note === '' ? null : <p className="whitespace-pre-line">{view.rejectReason.note}</p>}</section>}
      {messages.length > 0 ? <ul role="alert" className="list-disc space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 p-3 pl-7 text-sm text-fg">{messages.map((m, i) => <li key={`${m}-${String(i)}`}>{m}</li>)}</ul> : null}

      {editor ? (
        <form className="space-y-5" aria-label="Invoice" onSubmit={(e) => e.preventDefault()}>
          <section className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-2`} aria-label="About your invoice">
            <Field id={`${uid}-no`} label="Your invoice number" hint={err('vendorInvoiceNo')}><input id={`${uid}-no`} value={header.vendorInvoiceNo} maxLength={60} onChange={(e) => setHeader((h) => ({ ...h, vendorInvoiceNo: e.target.value }))} className={fieldClass} autoComplete="off" aria-invalid={err('vendorInvoiceNo') !== ''} /></Field>
            <Field id={`${uid}-d`} label="Invoice date" hint={err('invoiceDate')}><input id={`${uid}-d`} type="date" value={header.invoiceDate} onChange={(e) => setHeader((h) => ({ ...h, invoiceDate: e.target.value }))} className={fieldClass} aria-invalid={err('invoiceDate') !== ''} /></Field>
            <Field id={`${uid}-due`} label="Payment due (optional)" hint={err('dueDate')}><input id={`${uid}-due`} type="date" value={header.dueDate} onChange={(e) => setHeader((h) => ({ ...h, dueDate: e.target.value }))} className={fieldClass} aria-invalid={err('dueDate') !== ''} /></Field>
            <div className="sm:col-span-2"><Field id={`${uid}-n`} label="Notes (optional)" hint={err('notes')}><textarea id={`${uid}-n`} rows={2} maxLength={1000} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} className={fieldClass} /></Field></div>
          </section>

          <section className={`${cardClass} space-y-2`} aria-label="Your own invoice">
            <h2 className="text-sm font-bold text-fg-strong">Your own invoice</h2>
            <p className="text-xs text-fg-muted">Attach the invoice you printed or exported (a PDF or a picture). We need it to accept this one.</p>
            {scan === null ? null : <p className="text-sm text-fg">Attached: <a className="font-semibold underline" href={`/api/vendor/files/${scan.id}`} target="_blank" rel="noreferrer">{scan.name}</a></p>}
            <label className="block text-xs font-semibold text-fg" htmlFor={`${uid}-scan`}>{scan === null ? 'Choose the file' : 'Replace the file'}</label>
            <input id={`${uid}-scan`} ref={scanInput} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="block w-full text-sm" disabled={busy} onChange={(e) => void pickScan(e.target.files?.[0])} />
            {err('invoiceFile') === '' ? null : <p className="text-xs text-red-600">{err('invoiceFile')}</p>}
          </section>

          <section className={`${cardClass} space-y-3`} aria-label="What you are charging for">
            <h2 className="text-sm font-bold text-fg-strong">What you are charging for</h2>
            {err('lines') === '' ? null : <p className="text-xs text-red-600">{err('lines')}</p>}
            <ol className="space-y-3">
              {lines.map((l, i) => (
                <li key={l.poLineId} className="rounded-lg border border-line p-3">
                  <p className="text-sm font-semibold text-fg-strong">{i + 1}. {l.description}</p>
                  <p className="text-xs text-fg-muted">Order price {l.orderPrice} per {l.unit} · received and not yet invoiced: {l.goodsRoom}{Number(l.advanceRoom) > 0 && Number(l.goodsRoom) === 0 ? ` · open on the order: ${l.advanceRoom}` : ''} · tax {l.taxRate}%</p>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <Field id={`${uid}-q${String(i)}`} label="Quantity" hint={err(`line.${String(i)}.quantity`)}><input id={`${uid}-q${String(i)}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className={fieldClass} autoComplete="off" aria-invalid={err(`line.${String(i)}.quantity`) !== ''} /></Field>
                    <Field id={`${uid}-p${String(i)}`} label={`Price per ${l.unit}`} hint={err(`line.${String(i)}.unitPrice`)}><input id={`${uid}-p${String(i)}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} className={fieldClass} autoComplete="off" aria-invalid={err(`line.${String(i)}.unitPrice`) !== ''} /></Field>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-sm text-fg" aria-live="polite">Total: <span className="font-semibold">{money(totals.total)} {view.currency}</span> <span className="text-xs text-fg-muted">({money(totals.subtotal)} plus {money(totals.tax)} tax; we work out the final figures when you send it)</span></p>
          </section>

          <section className={`${cardClass} space-y-3`} aria-label="Delivery notes">
            <h2 className="text-sm font-bold text-fg-strong">Delivery notes</h2>
            <p className="text-xs text-fg-muted">Add the delivery note for each delivery this invoice is for, with the signed copy.</p>
            {notes.length === 0 && view.noteRuleReason !== '' ? <p className="text-xs text-amber-700">{view.noteRuleReason}</p> : null}
            {err('notes') === '' ? null : <p className="text-xs text-red-600">{err('notes')}</p>}
            <ul className="space-y-3">
              {notes.map((n, i) => (
                <li key={String(i)} className="rounded-lg border border-line p-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field id={`${uid}-dn${String(i)}`} label="Delivery note number" hint={err(`note.${String(i)}.noteNo`)}><input id={`${uid}-dn${String(i)}`} value={n.noteNo} maxLength={60} onChange={(e) => setNotes((p) => p.map((x, k) => (k === i ? { ...x, noteNo: e.target.value } : x)))} className={fieldClass} autoComplete="off" /></Field>
                    <Field id={`${uid}-dd${String(i)}`} label="Date on the delivery note" hint={err(`note.${String(i)}.noteDate`)}><input id={`${uid}-dd${String(i)}`} type="date" value={n.noteDate} onChange={(e) => setNotes((p) => p.map((x, k) => (k === i ? { ...x, noteDate: e.target.value } : x)))} className={fieldClass} /></Field>
                  </div>
                  <div className="mt-2 space-y-1">
                    {n.fileId === '' ? null : <p className="text-sm text-fg">Attached: <a className="font-semibold underline" href={`/api/vendor/files/${n.fileId}`} target="_blank" rel="noreferrer">{n.fileName}</a></p>}
                    <label className="block text-xs font-semibold text-fg" htmlFor={`${uid}-df${String(i)}`}>{n.fileId === '' ? 'Signed copy' : 'Replace the signed copy'}</label>
                    <input id={`${uid}-df${String(i)}`} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="block w-full text-sm" disabled={busy} onChange={(e) => void pickNote(i, e.target.files?.[0])} />
                    {err(`note.${String(i)}.fileId`) === '' ? null : <p className="text-xs text-red-600">{err(`note.${String(i)}.fileId`)}</p>}
                  </div>
                  <button type="button" className={`${buttonClass} mt-2`} onClick={() => setNotes((p) => p.filter((_, k) => k !== i))} aria-label={`Remove delivery note ${n.noteNo === '' ? String(i + 1) : n.noteNo}`}>Remove</button>
                </li>
              ))}
            </ul>
            <button type="button" className={buttonClass} onClick={() => setNotes((p) => [...p, { noteNo: '', noteDate: view.invoiceDate, fileId: '', fileName: '' }])}>Add a delivery note</button>
          </section>

          <section className={`${cardClass} space-y-3`} aria-label="Send">
            <label className="flex items-start gap-2 text-sm text-fg">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={header.declaration} onChange={(e) => setHeader((h) => ({ ...h, declaration: e.target.checked }))} />
              <span>I confirm that this invoice is for goods and services that were delivered.</span>
            </label>
            {err('declaration') === '' ? null : <p className="text-xs text-red-600">{err('declaration')}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void send()}>{busy ? 'Working…' : 'Send invoice'}</button>
              <button type="button" className={buttonClass} disabled={busy} onClick={() => void saveOnly()}>Save for later</button>
            </div>
          </section>

          <section className={`${cardClass} space-y-2`} aria-label="Close this invoice">
            <h2 className="text-sm font-bold text-fg-strong">Close this invoice</h2>
            <p className="text-xs text-fg-muted">If you do not need it, close it. We keep it on record and you can use the number again.</p>
            <Field id={`${uid}-cr`} label="Why are you closing it?"><input id={`${uid}-cr`} value={closing} maxLength={500} onChange={(e) => setClosing(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <InlineConfirm label={`Close invoice ${view.vendorInvoiceNo}`} action="Close this invoice" confirm="Yes, close it" busy={busy || closing.trim() === ''} onConfirm={() => void act(closeInvoiceAction(view.id, closing), 'The invoice is closed.')} />
          </section>
        </form>
      ) : (
        <section className={`${cardClass} space-y-3`} aria-label="The invoice">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-fg-muted">Invoice date</dt><dd className="font-medium text-fg-strong">{view.invoiceDate}</dd></div>
            <div><dt className="text-xs text-fg-muted">Payment due</dt><dd className="font-medium text-fg-strong">{view.dueDate === '' ? '—' : view.dueDate}</dd></div>
          </dl>
          <ol className="divide-y divide-line text-sm" aria-label="Lines">
            {view.lines.map((l, i) => (
              <li key={l.id} className="py-2"><p className="font-semibold text-fg-strong">{i + 1}. {l.description}</p><p className="text-fg">{l.quantity} {l.unit} at {l.unitPrice} = <span className="font-semibold">{(Number(l.netAmount) + Number(l.taxAmount)).toFixed(2)}</span> <span className="text-xs text-fg-muted">(tax {l.taxRate}%)</span></p></li>
            ))}
          </ol>
          <p className="text-sm text-fg">Total: <span className="font-semibold">{view.total} {view.currency}</span> <span className="text-xs text-fg-muted">({view.subtotal} plus {view.taxTotal} tax)</span></p>
          {view.invoiceFile === null ? null : <p className="text-sm text-fg">Your invoice: <a className="font-semibold underline" href={`/api/vendor/files/${view.invoiceFile.id}`} target="_blank" rel="noreferrer">{view.invoiceFile.name}</a></p>}
          {view.deliveryNotes.length === 0 ? null : <ul className="text-sm text-fg" aria-label="Delivery notes">{view.deliveryNotes.map((n) => <li key={n.id}>Delivery note {n.noteNo} ({n.noteDate}): <a className="font-semibold underline" href={`/api/vendor/files/${n.fileId}`} target="_blank" rel="noreferrer">{n.fileName}</a></li>)}</ul>}
          {view.canRecall ? <div className="space-y-1"><p className="text-xs text-fg-muted">Nobody has opened this invoice yet, so you can take it back, change it and send it again.</p><InlineConfirm label={`Take back invoice ${view.vendorInvoiceNo}`} action="Take it back" confirm="Yes, take it back" busy={busy} onConfirm={() => void act(recallInvoiceAction(view.id), 'You took the invoice back. It is a draft again.')} /></div> : null}
        </section>
      )}

      <section className={cardClass} aria-label="Progress">
        <h2 className="text-sm font-bold text-fg-strong">Progress</h2>
        {view.timeline.length === 0 ? <p className="text-sm text-fg-muted">Nothing has happened yet.</p> : (
          <ol className="mt-1 space-y-1 text-sm text-fg">
            {view.timeline.map((e) => <li key={`${e.event}-${e.at}`}>{EVENT_WORDS[e.event] ?? e.event} <span className="text-xs text-fg-muted">· {new Date(e.at).toLocaleString()}</span>{e.note === '' ? null : <span className="block text-xs text-fg-muted">{e.note}</span>}</li>)}
          </ol>
        )}
      </section>
    </div>
  );
}
