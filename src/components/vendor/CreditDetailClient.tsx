'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useRef, useState } from 'react';
import { closeCreditAction, recallCreditAction, saveCreditAction, submitCreditAction, type vendorCreditAction } from '@/server/domains/vendors/credit-memo-portal-actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { CREDIT_STATE, checkCreditLine, creditAmounts, creditTotals, type CreditLineForm, type OriginalLine } from '@/lib/vendor-credit-memo';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof vendorCreditAction>>, { ok: true }>['data'];

const EVENT_WORDS: Record<string, string> = { submitted: 'Sent to us', picked_up: 'We started checking it', approved: 'Approved', posted: 'Booked: taken off what we owe you', returned: 'Returned to you', rejected: 'Refused', recalled: 'You took it back', closed: 'You closed it' };

export function CreditDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof vendorCreditAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Detail view={res.data} /> : <LoadFailed error={res.error} />;
}

async function upload(file: File): Promise<{ id: string; name: string } | string> {
  const body = new FormData();
  body.set('file', file);
  try {
    const response = await fetch('/api/vendor/credit-files', { method: 'POST', body });
    const result = (await response.json()) as { ok: boolean; error?: string; data?: { id: string; name: string } };
    if (result.ok && result.data !== undefined) return result.data;
    return result.error ?? 'The upload failed. Please try again.';
  } catch {
    return 'The upload failed. Check your connection and try again.';
  }
}

const asOriginal = (o: View['originals'][number]): OriginalLine => ({ id: o.id, description: o.description, quantity: o.quantity, unitPriceCents: Math.round(Number(o.unitPrice) * 100), taxRate: o.taxRate, netCents: Math.round(Number(o.net) * 100), creditedQuantity: o.creditedQuantity, creditedNetCents: Math.round(Number(o.creditedNet) * 100) });

function Detail({ view }: { view: View }) {
  const router = useRouter();
  const uid = useId();
  const state = CREDIT_STATE[view.state];
  const [notice, setNotice] = useState<Notice>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [header, setHeader] = useState({ vendorCreditNo: view.vendorCreditNo, creditDate: view.creditDate, reason: view.reason, notes: view.notes });
  const [lines, setLines] = useState<Record<string, CreditLineForm | undefined>>(() => Object.fromEntries(view.lines.map((l) => [l.invoiceLineId, { invoiceLineId: l.invoiceLineId, mode: l.mode, quantity: l.mode === 'quantity' ? l.quantity : '', unitPrice: l.mode === 'price' ? l.unitPrice : '' }])));
  const [file, setFile] = useState<{ id: string; name: string } | null>(view.file);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [closing, setClosing] = useState('');
  const editor = view.editable && view.canWrite;
  const err = (key: string): string => problems[key] ?? '';
  const chosen = view.originals.flatMap((o, index) => {
    const l = lines[o.id];
    return l === undefined ? [] : [{ o, l, index }];
  });
  const preview = chosen.map(({ o, l }) => {
    const original = asOriginal(o);
    return Object.keys(checkCreditLine(l, original)).length > 0 ? null : creditAmounts(l, original);
  });
  const totals = creditTotals(preview.filter((x): x is NonNullable<typeof x> => x !== null));
  const money = (c: number): string => (c / 100).toFixed(2);

  const payload = () => ({ header, lines: chosen.map(({ l }) => l), fileId: file?.id ?? '' });
  const save = async (): Promise<boolean> => {
    const res = await attempt(saveCreditAction(view.id, payload()));
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
      const res = await attempt(submitCreditAction(view.id));
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
  const act = async (call: ReturnType<typeof recallCreditAction>  , done: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: done });
    router.refresh();
  };
  const pickFile = async (f: File | undefined) => {
    if (f === undefined) return;
    setBusy(true);
    const out = await upload(f);
    setBusy(false);
    if (typeof out === 'string') setNotice({ kind: 'error', text: out });
    else setFile(out);
    if (fileInput.current !== null) fileInput.current.value = '';
  };
  const setLine = (id: string, patch: Partial<CreditLineForm> | null) =>
    setLines((p) => ({ ...p, [id]: patch === null ? undefined : { invoiceLineId: id, mode: 'quantity', quantity: '', unitPrice: '', ...(p[id] ?? {}), ...patch } }));
  const messages = Object.values(problems);

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={`Credit note ${view.vendorCreditNo}`} intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={state.tone}>{state.label}</Chip>{view.number === null ? null : <span>Our number {view.number}</span>}<span>For invoice {view.invoiceNo}</span>{view.revision > 1 ? <span>Version {view.revision}</span> : null}</span>} actions={<Link href="/vendor/credits" className={buttonClass}>All credit notes</Link>} />
      <Message notice={notice} />
      <p className="text-sm text-fg">{view.stateWords}</p>
      {view.returnReason === null ? null : <section role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg"><p className="font-semibold">We sent this back: {view.returnReason.label}</p><p className="whitespace-pre-line">{view.returnReason.note}</p></section>}
      {view.rejectReason === null ? null : <section role="status" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-fg"><p className="font-semibold">We cannot accept this credit note: {view.rejectReason.label}</p>{view.rejectReason.note === '' ? null : <p className="whitespace-pre-line">{view.rejectReason.note}</p>}</section>}
      {messages.length > 0 ? <ul role="alert" className="list-disc space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 p-3 pl-7 text-sm text-fg">{messages.map((m, i) => <li key={`${m}-${String(i)}`}>{m}</li>)}</ul> : null}

      {editor ? (
        <form className="space-y-5" aria-label="Credit note" onSubmit={(e) => e.preventDefault()}>
          <section className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-2`} aria-label="About your credit note">
            <Field id={`${uid}-no`} label="Your credit note number" hint={err('vendorCreditNo')}><input id={`${uid}-no`} value={header.vendorCreditNo} maxLength={60} onChange={(e) => setHeader((h) => ({ ...h, vendorCreditNo: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
            <Field id={`${uid}-d`} label="Date on your credit note" hint={err('creditDate')}><input id={`${uid}-d`} type="date" value={header.creditDate} onChange={(e) => setHeader((h) => ({ ...h, creditDate: e.target.value }))} className={fieldClass} /></Field>
            <div className="sm:col-span-2"><Field id={`${uid}-r`} label="Why are you crediting this invoice?" hint={err('reason')}><input id={`${uid}-r`} value={header.reason} maxLength={500} onChange={(e) => setHeader((h) => ({ ...h, reason: e.target.value }))} className={fieldClass} autoComplete="off" /></Field></div>
            <div className="sm:col-span-2"><Field id={`${uid}-n`} label="Notes (optional)" hint={err('notes')}><textarea id={`${uid}-n`} rows={2} maxLength={1000} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} className={fieldClass} /></Field></div>
          </section>

          <section className={`${cardClass} space-y-2`} aria-label="Your own credit note">
            <h2 className="text-sm font-bold text-fg-strong">Your own credit note</h2>
            <p className="text-xs text-fg-muted">Attach the credit note you printed or exported (a PDF or a picture).</p>
            {file === null ? null : <p className="text-sm text-fg">Attached: <a className="font-semibold underline" href={`/api/vendor/files/${file.id}`} target="_blank" rel="noreferrer">{file.name}</a></p>}
            <label className="block text-xs font-semibold text-fg" htmlFor={`${uid}-file`}>{file === null ? 'Choose the file' : 'Replace the file'}</label>
            <input id={`${uid}-file`} ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="block w-full text-sm" disabled={busy} onChange={(e) => void pickFile(e.target.files?.[0])} />
            {err('file') === '' ? null : <p className="text-xs text-red-600">{err('file')}</p>}
          </section>

          <section className={`${cardClass} space-y-3`} aria-label="What you are crediting">
            <h2 className="text-sm font-bold text-fg-strong">What you are crediting</h2>
            {err('lines') === '' ? null : <p className="text-xs text-red-600">{err('lines')}</p>}
            <ol className="space-y-3">
              {view.originals.map((o, i) => {
                const l = lines[o.id];
                const key = `line.${String(chosen.findIndex((c) => c.o.id === o.id))}`;
                const left = Math.round((o.quantity - o.creditedQuantity) * 1000) / 1000;
                return (
                  <li key={o.id} className="rounded-lg border border-line p-3">
                    <label className="flex items-start gap-2 text-sm font-semibold text-fg-strong">
                      <input type="checkbox" className="mt-1 h-4 w-4" checked={l !== undefined} onChange={(e) => setLine(o.id, e.target.checked ? {} : null)} aria-label={`Credit line ${String(i + 1)}: ${o.description}`} />
                      <span>{i + 1}. {o.description}</span>
                    </label>
                    <p className="text-xs text-fg-muted">Billed {o.quantity} at {o.unitPrice} (net {o.net}, tax {o.taxRate}%) · credited so far {o.creditedQuantity} / {o.creditedNet}</p>
                    {l === undefined ? null : (
                      <div className="mt-2 space-y-2">
                        <div role="group" aria-label={`How to credit line ${String(i + 1)}`} className="flex flex-wrap gap-2">
                          <button type="button" aria-pressed={l.mode === 'quantity'} className={`${buttonClass} ${l.mode === 'quantity' ? 'ring-2 ring-indigo-500' : ''}`} onClick={() => setLine(o.id, { mode: 'quantity' })}>Some of the goods</button>
                          <button type="button" aria-pressed={l.mode === 'price'} className={`${buttonClass} ${l.mode === 'price' ? 'ring-2 ring-indigo-500' : ''}`} onClick={() => setLine(o.id, { mode: 'price' })}>A price that was too high</button>
                        </div>
                        {l.mode === 'quantity' ? (
                          <Field id={`${uid}-q${o.id}`} label={`Quantity to credit (up to ${String(left)})`} hint={err(`${key}.quantity`)}><input id={`${uid}-q${o.id}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(o.id, { quantity: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
                        ) : (
                          <Field id={`${uid}-p${o.id}`} label="How much a unit was billed too high" hint={err(`${key}.unitPrice`)}><input id={`${uid}-p${o.id}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(o.id, { unitPrice: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
                        )}
                        {err(`${key}.invoiceLineId`) === '' ? null : <p className="text-xs text-red-600">{err(`${key}.invoiceLineId`)}</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="text-sm text-fg" aria-live="polite">Credit total: <span className="font-semibold">{money(totals.total)} {view.currency}</span> <span className="text-xs text-fg-muted">({money(totals.subtotal)} plus {money(totals.tax)} tax; we work out the final figures when you send it)</span></p>
          </section>

          <section className={`${cardClass} flex flex-wrap items-center gap-2`} aria-label="Send">
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void send()}>{busy ? 'Working…' : 'Send credit note'}</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void saveOnly()}>Save for later</button>
          </section>

          <section className={`${cardClass} space-y-2`} aria-label="Close this credit note">
            <h2 className="text-sm font-bold text-fg-strong">Close this credit note</h2>
            <Field id={`${uid}-cr`} label="Why are you closing it?"><input id={`${uid}-cr`} value={closing} maxLength={500} onChange={(e) => setClosing(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <InlineConfirm label={`Close credit note ${view.vendorCreditNo}`} action="Close this credit note" confirm="Yes, close it" busy={busy || closing.trim() === ''} onConfirm={() => void act(closeCreditAction(view.id, closing), 'The credit note is closed.')} />
          </section>
        </form>
      ) : (
        <section className={`${cardClass} space-y-3`} aria-label="The credit note">
          <p className="text-sm text-fg">{view.reason}</p>
          <ol className="divide-y divide-line text-sm" aria-label="Lines">
            {view.lines.map((l, i) => <li key={l.id} className="py-2"><p className="font-semibold text-fg-strong">{i + 1}. {l.description}</p><p className="text-fg">{l.mode === 'quantity' ? `${l.quantity} ${l.unit} at ${l.unitPrice}` : `${l.unitPrice} a unit too high on ${l.quantity} ${l.unit}`} = <span className="font-semibold">{(Number(l.netAmount) + Number(l.taxAmount)).toFixed(2)}</span></p></li>)}
          </ol>
          <p className="text-sm text-fg">Total: <span className="font-semibold">{view.total} {view.currency}</span> <span className="text-xs text-fg-muted">({view.subtotal} plus {view.taxTotal} tax)</span></p>
          {view.file === null ? null : <p className="text-sm text-fg">Your credit note: <a className="font-semibold underline" href={`/api/vendor/files/${view.file.id}`} target="_blank" rel="noreferrer">{view.file.name}</a></p>}
          {view.canRecall ? <div className="space-y-1"><p className="text-xs text-fg-muted">Nobody has opened this credit note yet, so you can take it back, change it and send it again.</p><InlineConfirm label={`Take back credit note ${view.vendorCreditNo}`} action="Take it back" confirm="Yes, take it back" busy={busy} onConfirm={() => void act(recallCreditAction(view.id), 'You took the credit note back. It is a draft again.')} /></div> : null}
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
