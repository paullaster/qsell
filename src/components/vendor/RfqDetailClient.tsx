'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { askRfqQuestionAction, declineRfqAction, saveQuoteAction, submitQuoteAction, withdrawQuoteAction, type vendorRfqAction } from '@/server/domains/vendors/rfq-portal-actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { blankQuoteLine, quoteTotals, VENDOR_STAGE, type QuoteLineInput } from '@/lib/rfq';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof vendorRfqAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string; problems?: Record<string, string> };
type Row = QuoteLineInput & { k: string };

const money = (cents: number): string => (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function RfqDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof vendorRfqAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Detail view={res.data} /> : <LoadFailed error={res.error} />;
}

function Detail({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const stage = VENDOR_STAGE[view.stage];
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [header, setHeader] = useState({ paymentTerms: view.editable?.paymentTerms ?? '', deliveryTerms: view.editable?.deliveryTerms ?? '', validUntil: view.editable?.validUntil ?? '', notes: view.editable?.notes ?? '' });
  const [rows, setRows] = useState<Row[]>(() => {
    const saved = view.editable?.lines ?? [];
    const primary = view.lines.map((l) => ({ ...(saved.find((s) => s.rfqLineId === l.id && !s.isAlternative) ?? blankQuoteLine(l.id, Number(l.quantity))), k: l.id }));
    const alts = saved.filter((s) => s.isAlternative).map((s) => ({ ...s, k: crypto.randomUUID() }));
    return [...primary, ...alts];
  });
  const [question, setQuestion] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const canWrite = view.canAnswer && view.window.open && !view.needsWithdrawal;

  const act = async (call: Promise<Result>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    setProblems({});
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      setProblems('problems' in res && res.problems !== undefined ? res.problems : {});
      return false;
    }
    setNotice({ kind: 'ok', text: done });
    router.refresh();
    return true;
  };
  const patch = (k: string, p: Partial<QuoteLineInput>) => setRows((r) => r.map((x) => (x.k === k ? { ...x, ...p } : x)));
  const quote = () => ({ ...header, lines: rows.map(({ k: _k, ...l }) => l) });
  const totals = quoteTotals(rows);
  const p = (row: Row, field: string): string | undefined => problems[`${row.rfqLineId}${row.isAlternative ? ':alt' : ''}.${field}`];
  const lineName = (id: string) => view.lines.find((l) => l.id === id)?.description ?? '';

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={`${view.number ?? ''} ${view.title}`} intro={<span className="flex flex-wrap items-center gap-2">{view.category}<Chip tone={stage.tone}>{stage.label}</Chip><span>Due {new Date(view.deadline).toLocaleString()}</span></span>} actions={<Link href="/vendor/rfqs" className={buttonClass}>All requests</Link>} />
      <Message notice={notice} />

      {view.decision.value === 'rejected' ? <p role="note" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-fg">Your quote was not accepted.{view.decision.reason === null ? '' : ` ${view.decision.reason}.`}{view.decision.comment === null ? '' : ` ${view.decision.comment}`}</p> : null}
      {view.decision.value === 'revision_requested' ? <p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">The buyer asks you to revise your quote: {view.decision.comment}{view.decision.revisionDue === null ? '' : ` Send it by ${new Date(view.decision.revisionDue).toLocaleString()}.`}</p> : null}
      {view.stage === 'awarded' ? <section className={cardClass} aria-label="Awarded to you"><h2 className="text-sm font-bold text-fg-strong">Awarded to you</h2><ul className="mt-2 divide-y divide-line text-sm">{view.awards.map((a) => <li key={a.rfqLineId} className="py-2">{lineName(a.rfqLineId)}: {a.quantity} at {a.unitPrice} {view.currency}</li>)}</ul><p className="mt-2 text-xs text-fg-muted">A purchase order will follow.</p></section> : null}

      <section className={`${cardClass} space-y-3`} aria-label="The request">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-fg-muted">Currency</dt><dd className="font-medium text-fg-strong">{view.currency}</dd></div>
          <div><dt className="text-xs text-fg-muted">Needed by</dt><dd className="font-medium text-fg-strong">{view.requiredBy ?? '—'}</dd></div>
          <div><dt className="text-xs text-fg-muted">A quote must hold</dt><dd className="font-medium text-fg-strong">{view.validityDays} days</dd></div>
          <div><dt className="text-xs text-fg-muted">Partial quotes</dt><dd className="font-medium text-fg-strong">{view.allowPartial ? 'Accepted' : 'Not accepted'}</dd></div>
          <div><dt className="text-xs text-fg-muted">Alternative offers</dt><dd className="font-medium text-fg-strong">{view.allowAlternatives ? 'Accepted' : 'Not accepted'}</dd></div>
        </dl>
        {view.description === null ? null : <p className="whitespace-pre-line text-sm text-fg">{view.description}</p>}
        {view.terms === null ? null : <div><h3 className="text-xs font-bold uppercase text-fg-muted">Terms</h3><p className="whitespace-pre-line text-sm text-fg">{view.terms}</p></div>}
        <ol className="divide-y divide-line text-sm" aria-label="Lines">
          {view.lines.map((l, i) => <li key={l.id} className="py-2"><span className="font-semibold text-fg-strong">{i + 1}. {l.description}</span> — {l.quantity} {l.unit}{l.requiredDate === null ? '' : `, by ${l.requiredDate}`}{l.specification === null ? null : <span className="block text-xs text-fg-muted">{l.specification}</span>}</li>)}
        </ol>
        {view.addenda.length === 0 ? null : <div><h3 className="text-xs font-bold uppercase text-fg-muted">Clarifications from the buyer</h3><ol className="mt-1 space-y-1 text-sm">{view.addenda.map((a) => <li key={a.number}>{a.number}. {a.body}{a.deadlineAfter === null ? '' : ` New deadline: ${new Date(a.deadlineAfter).toLocaleString()}.`}</li>)}</ol></div>}
      </section>

      {view.window.open && view.invitation.status !== 'declined' ? (
        <section className={`${cardClass} space-y-3`} aria-label="Your quote">
          <h2 className="text-sm font-bold text-fg-strong">Your quote</h2>
          {view.needsWithdrawal && view.submitted !== null ? (
            <div className="space-y-2 text-sm">
              <p className="text-fg">You sent version {view.submitted.version}: total <span className="font-semibold">{view.submitted.total} {view.currency}</span>. To change it, withdraw it first; you can send a new version until the deadline.</p>
              {view.canAnswer ? <InlineConfirm label="Withdraw your sent quote" action="Withdraw my quote" confirm="Yes, withdraw" busy={busy} onConfirm={() => void act(withdrawQuoteAction(view.id), 'Your quote is withdrawn. You can edit it and send a new version.')} /> : null}
            </div>
          ) : (
            <form noValidate aria-label="Quote" onSubmit={(e) => { e.preventDefault(); void act(saveQuoteAction(view.id, quote()), 'Saved. It has not been sent yet.'); }} className="space-y-4">
              {!view.canAnswer ? <p className="text-sm text-fg-muted">Only the owner or the sales person can write a quote.</p> : null}
              {rows.map((r, i) => (
                <fieldset key={r.k} className="grid grid-cols-1 gap-3 rounded-lg border border-line p-3 sm:grid-cols-3" disabled={!canWrite}>
                  <legend className="px-1 text-sm font-semibold text-fg-strong">{r.isAlternative ? 'Alternative: ' : `${String(i + 1)}. `}{lineName(r.rfqLineId)}</legend>
                  {p(r, 'line') === undefined ? null : <p role="alert" className="text-sm text-red-600 sm:col-span-3">{p(r, 'line')}</p>}
                  <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg sm:col-span-3"><input type="checkbox" className="h-5 w-5" checked={r.noBid} onChange={(e) => patch(r.k, { noBid: e.target.checked })} />Not bidding on this line</label>
                  {r.noBid ? null : (
                    <>
                      <Field id={`${uid}-p-${r.k}`} label="Price for one unit" hint={p(r, 'unitPrice')}><input id={`${uid}-p-${r.k}`} inputMode="decimal" value={r.unitPrice} onChange={(e) => patch(r.k, { unitPrice: e.target.value })} className={fieldClass} aria-invalid={p(r, 'unitPrice') !== undefined} /></Field>
                      <Field id={`${uid}-q-${r.k}`} label="Quantity you offer" hint={p(r, 'quantity')}><input id={`${uid}-q-${r.k}`} inputMode="decimal" value={r.quantity} onChange={(e) => patch(r.k, { quantity: e.target.value })} className={fieldClass} aria-invalid={p(r, 'quantity') !== undefined} /></Field>
                      <Field id={`${uid}-t-${r.k}`} label="Tax (%)" hint={p(r, 'taxRate')}><input id={`${uid}-t-${r.k}`} inputMode="decimal" value={r.taxRate} onChange={(e) => patch(r.k, { taxRate: e.target.value })} className={fieldClass} /></Field>
                      <Field id={`${uid}-l-${r.k}`} label="Lead time (days)" hint={p(r, 'leadTimeDays')}><input id={`${uid}-l-${r.k}`} inputMode="numeric" value={r.leadTimeDays} onChange={(e) => patch(r.k, { leadTimeDays: e.target.value })} className={fieldClass} /></Field>
                      <Field id={`${uid}-b-${r.k}`} label="Brand or model"><input id={`${uid}-b-${r.k}`} value={r.brand} onChange={(e) => patch(r.k, { brand: e.target.value })} className={fieldClass} maxLength={120} autoComplete="off" /></Field>
                      <Field id={`${uid}-w-${r.k}`} label="Warranty"><input id={`${uid}-w-${r.k}`} value={r.warranty} onChange={(e) => patch(r.k, { warranty: e.target.value })} className={fieldClass} maxLength={120} autoComplete="off" /></Field>
                    </>
                  )}
                  {r.isAlternative ? <div className="flex items-end"><button type="button" className={buttonClass} onClick={() => setRows((x) => x.filter((y) => y.k !== r.k))}>Remove this alternative</button></div> : null}
                </fieldset>
              ))}
              {view.allowAlternatives && canWrite ? (
                <div className="flex flex-wrap gap-2">
                  {view.lines.map((l) => <button key={l.id} type="button" className={buttonClass} onClick={() => setRows((x) => [...x, { ...blankQuoteLine(l.id, Number(l.quantity)), isAlternative: true, k: crypto.randomUUID() }])}>Offer an alternative for “{l.description}”</button>)}
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="group" aria-label="Terms of your quote">
                <Field id={`${uid}-pt`} label="Payment terms you offer"><input id={`${uid}-pt`} value={header.paymentTerms} onChange={(e) => setHeader((h) => ({ ...h, paymentTerms: e.target.value }))} className={fieldClass} disabled={!canWrite} maxLength={500} autoComplete="off" /></Field>
                <Field id={`${uid}-dt`} label="Delivery terms"><input id={`${uid}-dt`} value={header.deliveryTerms} onChange={(e) => setHeader((h) => ({ ...h, deliveryTerms: e.target.value }))} className={fieldClass} disabled={!canWrite} maxLength={500} autoComplete="off" /></Field>
                <Field id={`${uid}-vu`} label="Your quote holds until" hint={problems.validUntil ?? `At least ${String(view.validityDays)} days from today.`}><input id={`${uid}-vu`} type="date" value={header.validUntil} onChange={(e) => setHeader((h) => ({ ...h, validUntil: e.target.value }))} className={fieldClass} disabled={!canWrite} /></Field>
                <Field id={`${uid}-nt`} label="Notes"><input id={`${uid}-nt`} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} className={fieldClass} disabled={!canWrite} maxLength={2000} autoComplete="off" /></Field>
              </div>
              <p className="text-sm text-fg" aria-live="polite">Total: <span className="font-semibold">{money(totals.total)} {view.currency}</span> <span className="text-xs text-fg-muted">({money(totals.subtotal)} plus {money(totals.tax)} tax; the buyer sees the total worked out from your lines)</span></p>
              {canWrite ? (
                <div className="flex flex-wrap gap-2">
                  <button type="submit" className={buttonClass} disabled={busy}>Save draft</button>
                  <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(submitQuoteAction(view.id, quote()), 'Your quote was sent.')}>{view.decision.value === 'revision_requested' ? 'Send my revised quote' : 'Send my quote'}</button>
                </div>
              ) : null}
            </form>
          )}
        </section>
      ) : null}

      {view.submitted !== null && !view.window.open ? <section className={cardClass} aria-label="Your sent quote"><h2 className="text-sm font-bold text-fg-strong">Your sent quote</h2><p className="mt-1 text-sm text-fg">Version {view.submitted.version}, total {view.submitted.total} {view.currency}, sent {view.submitted.submittedAt === null ? '' : new Date(view.submitted.submittedAt).toLocaleString()}.</p></section> : null}
      {view.history.length > 1 ? <section className={cardClass} aria-label="Earlier versions"><h2 className="text-sm font-bold text-fg-strong">Your versions</h2><ul className="mt-1 text-sm">{view.history.map((h) => <li key={h.id}>Version {h.version}: {h.total} {view.currency} · {h.status === 'withdrawn' ? 'withdrawn' : 'sent'}</li>)}</ul></section> : null}

      <section className={`${cardClass} space-y-3`} aria-label="Questions">
        <h2 className="text-sm font-bold text-fg-strong">Questions</h2>
        {view.questions.length === 0 ? <p className="text-sm text-fg-muted">No questions yet.</p> : (
          <ul className="space-y-2 text-sm">{view.questions.map((q) => <li key={q.id}><p className="text-fg-strong">{q.mine ? 'You asked' : 'A vendor asked'}: {q.body}</p>{q.answer === null ? <p className="text-xs text-fg-muted">{q.mine ? 'Waiting for an answer.' : ''}</p> : <p className="text-fg">Answer: {q.answer}</p>}</li>)}</ul>
        )}
        {view.window.open && view.canAnswer && view.invitation.status !== 'declined' && view.status === 'issued' ? (
          <form className="space-y-2" aria-label="Ask a question" onSubmit={(e) => { e.preventDefault(); void act(askRfqQuestionAction(view.id, question), 'Your question was sent. An answer may be shared with every invited vendor, without your name.').then((ok) => { if (ok) setQuestion(''); }); }}>
            <Field id={`${uid}-ask`} label="Ask the buyer"><input id={`${uid}-ask`} value={question} onChange={(e) => setQuestion(e.target.value)} className={fieldClass} maxLength={1000} autoComplete="off" /></Field>
            <button type="submit" className={buttonClass} disabled={busy}>Send the question</button>
          </form>
        ) : null}
      </section>

      {view.status === 'issued' && view.invitation.status !== 'declined' && view.canAnswer && view.submitted === null ? (
        <section className={cardClass} aria-label="Not bidding">
          {declining ? (
            <form className="space-y-2" aria-label="Decline to bid" onSubmit={(e) => { e.preventDefault(); void act(declineRfqAction(view.id, reason), 'You declined this request.'); }}>
              <Field id={`${uid}-dr`} label="Why are you not bidding?"><input id={`${uid}-dr`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} required maxLength={500} autoComplete="off" /></Field>
              <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Decline to bid</button><button type="button" className={buttonClass} onClick={() => setDeclining(false)}>Cancel</button></div>
            </form>
          ) : <button type="button" className={buttonClass} onClick={() => setDeclining(true)}>I am not bidding…</button>}
        </section>
      ) : null}
      {view.invitation.declineReason === null ? null : <p className="text-sm text-fg-muted">You declined: {view.invitation.declineReason}</p>}
    </div>
  );
}
