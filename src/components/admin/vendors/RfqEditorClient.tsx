'use client';

import Link from 'next/link';
import { use, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  answerRfqQuestionAction, cancelRfqAction, closeRfqEarlyAction, eligibleVendorsAction, extendRfqAction, issueRfqAction, rfqAddendumAction, saveRfqAction, setRfqInviteesAction, type rfqAction,
} from '@/server/domains/vendors/rfq-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { emptyRfqHeader, emptyRfqLine, RFQ_STATUS, type RfqHeaderForm, type RfqLineForm } from '@/lib/rfq';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof rfqAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string };
type Eligible = { id: string; name: string; number: string | null }[];

/** A request that does not exist yet. */
export function NewRfqClient() {
  return <Editor view={null} />;
}

export function RfqEditorClient({ viewPromise }: { viewPromise: ReturnType<typeof rfqAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Editor view={res.data} /> : <LoadFailed error={res.error} />;
}

const INVITE_CHIP = { declined: { tone: 'gray', text: 'Declined' }, opened: { tone: 'sky', text: 'Opened' }, invited: { tone: 'gray', text: 'Not opened' } } as const;

function InviteChip({ status }: { status: string }) {
  const c = status === 'declined' || status === 'opened' ? INVITE_CHIP[status] : INVITE_CHIP.invited;
  return <Chip tone={c.tone}>{c.text}</Chip>;
}

function Check({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex min-h-10 cursor-pointer items-start gap-2 text-sm text-fg">
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>{label}{hint === undefined ? null : <span className="block text-xs text-fg-muted">{hint}</span>}</span>
    </label>
  );
}

function Editor({ view }: { view: View | null }) {
  const uid = useId();
  const router = useRouter();
  const draft = view === null || view.status === 'draft';
  const [f, setF] = useState<RfqHeaderForm>(view?.form ?? emptyRfqHeader());
  const [category, setCategory] = useState<Choice | null>(view?.category ?? null);
  const [currency, setCurrency] = useState<Choice | null>(view === null || view.form.currency === '' ? null : { id: view.form.currency, label: view.form.currency });
  const [lines, setLines] = useState<(RfqLineForm & { k: string })[]>(() => (view === null || view.lines.length === 0 ? [emptyRfqLine()] : view.lines).map((l) => ({ ...emptyRfqLine(), ...l, k: crypto.randomUUID() })));
  const [eligible, setEligible] = useState<Eligible | null>(null);
  const [invited, setInvited] = useState<string[]>(view?.invitations.map((i) => i.vendorId) ?? []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [panel, setPanel] = useState<null | 'extend' | 'close' | 'addendum'>(null);
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const set = <K extends keyof RfqHeaderForm>(k: K, v: RfqHeaderForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const id = view?.id ?? null;

  useEffect(() => {
    if (id === null || !draft) return;
    void eligibleVendorsAction(id).then((r) => { if (r.ok) setEligible(r.data); });
  }, [id, draft, category?.id]);

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
    setWhen('');
    router.refresh();
    return true;
  };

  const header = (): RfqHeaderForm => ({ ...f, categoryId: category?.id ?? '', currency: currency?.id ?? '' });
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveRfqAction(id, header(), lines.map(({ k: _k, ...l }) => l)));
    if (!res.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: res.error });
      return null;
    }
    if (id !== null && eligible !== null) {
      const inv = await attempt(setRfqInviteesAction(id, invited));
      if (!inv.ok) {
        setBusy(false);
        setNotice({ kind: 'error', text: inv.error });
        return null;
      }
    }
    setBusy(false);
    setNotice({ kind: 'ok', text: 'Saved.' });
    if (id === null) router.push(`/admin/vendors/rfqs/${res.data.id}`);
    else router.refresh();
    return res.data.id;
  };
  const issue = async () => {
    const saved = await save();
    if (saved !== null) await act(issueRfqAction(saved).then((r) => (r.ok ? { ok: true as const } : r)), 'Issued. The invited vendors have been told.');
  };

  const status = view === null ? RFQ_STATUS.draft : (RFQ_STATUS[view.status] ?? { label: view.status, tone: 'gray' as const });
  const patchLine = (i: number, p: Partial<RfqLineForm>) => setLines((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={view?.number ?? (view === null ? 'New request for quotation' : 'Draft request')}
        intro={<span className="flex flex-wrap items-center gap-2">{f.title === '' ? 'Not named yet' : f.title}<Chip tone={status.tone}>{status.label}</Chip></span>}
        actions={<span className="flex items-center gap-3">{view !== null && view.can.evaluate && view.status !== 'draft' ? <Link href={`/admin/vendors/rfqs/${view.id}/quotes`} className="text-sm font-semibold text-indigo-600 hover:underline">Quotes</Link> : null}<Link href="/admin/vendors/rfqs" className={buttonClass}>All requests</Link></span>}
      />
      <Message notice={notice} />
      {view?.closeReason == null ? null : <p className="text-sm text-fg">Closed: {view.closeReason}</p>}
      {view?.cancelReason == null ? null : <p role="status" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-fg">Cancelled: {view.cancelReason}</p>}

      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className={`${cardClass} space-y-3`} aria-label="Request details">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field id={`${uid}-t`} label="Title"><input id={`${uid}-t`} value={f.title} onChange={(e) => set('title', e.target.value)} className={fieldClass} disabled={!draft} required maxLength={200} autoComplete="off" /></Field></div>
          <ChoicePicker label="Category" source="procurement-categories" choice={category} onChoice={setCategory} disabled={!draft} required clearable={false} placeholder="Choose the category…" />
          <ChoicePicker label="Currency" source="rfq-currencies" choice={currency} onChoice={setCurrency} disabled={!draft} required clearable={false} placeholder="Choose the currency…" />
          <Field id={`${uid}-d`} label="Quotes are due" hint="Your local date and time."><input id={`${uid}-d`} type="datetime-local" value={f.deadline} onChange={(e) => set('deadline', e.target.value)} className={fieldClass} disabled={!draft} required /></Field>
          <Field id={`${uid}-rb`} label="Needed by (optional)"><input id={`${uid}-rb`} type="date" value={f.requiredBy} onChange={(e) => set('requiredBy', e.target.value)} className={fieldClass} disabled={!draft} /></Field>
          <Field id={`${uid}-v`} label="A quote must hold (days)"><input id={`${uid}-v`} inputMode="numeric" value={f.validityDays} onChange={(e) => set('validityDays', e.target.value)} className={fieldClass} disabled={!draft} required /></Field>
          <Field id={`${uid}-ev`} label="Estimated value (optional)" hint="For your own planning. Vendors never see it."><input id={`${uid}-ev`} inputMode="decimal" value={f.estimatedValue} onChange={(e) => set('estimatedValue', e.target.value)} className={fieldClass} disabled={!draft} autoComplete="off" /></Field>
          <div className="sm:col-span-2"><Field id={`${uid}-ds`} label="What this is about"><textarea id={`${uid}-ds`} rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} className={fieldClass} disabled={!draft} maxLength={4000} /></Field></div>
          <div className="sm:col-span-2"><Field id={`${uid}-tm`} label="Terms and conditions"><textarea id={`${uid}-tm`} rows={3} value={f.terms} onChange={(e) => set('terms', e.target.value)} className={fieldClass} disabled={!draft} maxLength={4000} /></Field></div>
        </div>
        <fieldset className="space-y-1" disabled={!draft}>
          <legend className="text-sm font-semibold text-fg-strong">How quotes are taken</legend>
          <Check id={`${uid}-sl`} label="Keep quotes sealed until the deadline" hint="Nobody here can read a quote before it opens." checked={f.sealed} onChange={(v) => set('sealed', v)} disabled={!draft} />
          <Check id={`${uid}-pp`} label="Accept partial quotes" hint="A vendor may offer less than the quantity asked." checked={f.allowPartial} onChange={(v) => set('allowPartial', v)} disabled={!draft} />
          <Check id={`${uid}-al`} label="Accept alternative offers" checked={f.allowAlternatives} onChange={(v) => set('allowAlternatives', v)} disabled={!draft} />
        </fieldset>
        {draft ? <button type="submit" className={buttonClass} disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button> : null}
      </form>

      <section className={`${cardClass} space-y-3`} aria-label="Lines">
        <h3 className="text-sm font-bold text-fg-strong">What you want to buy</h3>
        {lines.map((l, i) => (
          <fieldset key={l.k} className="grid grid-cols-1 gap-3 rounded-lg border border-line p-3 sm:grid-cols-4" disabled={!draft}>
            <legend className="px-1 text-xs font-semibold text-fg-muted">Line {i + 1}</legend>
            <div className="sm:col-span-4"><Field id={`${uid}-l${String(i)}d`} label="Description"><input id={`${uid}-l${String(i)}d`} value={l.description} onChange={(e) => patchLine(i, { description: e.target.value })} className={fieldClass} maxLength={300} autoComplete="off" /></Field></div>
            <Field id={`${uid}-l${String(i)}q`} label="Quantity"><input id={`${uid}-l${String(i)}q`} inputMode="decimal" value={l.quantity} onChange={(e) => patchLine(i, { quantity: e.target.value })} className={fieldClass} /></Field>
            <Field id={`${uid}-l${String(i)}u`} label="Unit"><input id={`${uid}-l${String(i)}u`} value={l.unit} onChange={(e) => patchLine(i, { unit: e.target.value })} className={fieldClass} maxLength={20} autoComplete="off" /></Field>
            <Field id={`${uid}-l${String(i)}r`} label="Needed by"><input id={`${uid}-l${String(i)}r`} type="date" value={l.requiredDate} onChange={(e) => patchLine(i, { requiredDate: e.target.value })} className={fieldClass} /></Field>
            <div className="flex items-end">{draft && lines.length > 1 ? <button type="button" className={buttonClass} onClick={() => setLines((x) => x.filter((_, j) => j !== i))} aria-label={`Remove line ${String(i + 1)}`}>Remove</button> : null}</div>
            <div className="sm:col-span-4"><Field id={`${uid}-l${String(i)}s`} label="Specification (optional)"><input id={`${uid}-l${String(i)}s`} value={l.specification} onChange={(e) => patchLine(i, { specification: e.target.value })} className={fieldClass} maxLength={2000} autoComplete="off" /></Field></div>
          </fieldset>
        ))}
        {draft ? <button type="button" className={buttonClass} onClick={() => setLines((x) => [...x, { ...emptyRfqLine(), k: crypto.randomUUID() }])}>Add a line</button> : null}
      </section>

      {view === null ? <p className="text-sm text-fg-muted">Save the draft to choose who to invite.</p> : (
        <section className={`${cardClass} space-y-2`} aria-label="Invited vendors">
          <h3 className="text-sm font-bold text-fg-strong">Invited vendors</h3>
          {draft && eligible === null ? <p className="text-sm text-fg-muted">Loading the vendors qualified in this category…</p> : null}
          {draft && eligible !== null && eligible.length === 0 ? <p className="text-sm text-fg-muted">No vendor is qualified in this category yet. Qualify vendors under Prequalification first.</p> : null}
          {draft && eligible !== null && eligible.length > 0 ? (
              <ul className="space-y-1">
                {eligible.map((v) => <li key={v.id}><Check id={`${uid}-iv-${v.id}`} label={`${v.name}${v.number === null ? '' : ` · ${v.number}`}`} checked={invited.includes(v.id)} onChange={(on) => setInvited((l) => (on ? [...l, v.id] : l.filter((x) => x !== v.id)))} /></li>)}
              </ul>
          ) : null}
          {!draft ? (
            <ul className="divide-y divide-line text-sm">
              {view.invitations.map((i) => (
                <li key={i.vendorId} className="flex flex-wrap items-center justify-between gap-2 py-2"><span>{i.name}{i.number === null ? '' : ` · ${i.number}`}</span><span className="flex items-center gap-2 text-xs text-fg-muted"><InviteChip status={i.status} />{i.declineReason === null ? null : <span>{i.declineReason}</span>}</span></li>
              ))}
            </ul>
          ) : null}
        </section>
      )}

      {view !== null && draft && view.can.issue ? (
        <section className={cardClass} aria-label="Issue">
          <p className="text-sm text-fg">Issuing gives the request its number and sends it to the invited vendors. After that its lines cannot change; you can send addenda.</p>
          <button type="button" className={`${primaryClass} mt-2`} disabled={busy} onClick={() => void issue()}>Save and issue to the invited vendors</button>
        </section>
      ) : null}

      {view !== null && !draft ? (
        <>
          <section className={`${cardClass} space-y-3`} aria-label="Running the request">
            <h3 className="text-sm font-bold text-fg-strong">Running the request</h3>
            <p className="text-xs text-fg-muted">Due {new Date(view.deadlineIso).toLocaleString()}{view.opensAt === null ? '' : ` · quotes open ${new Date(view.opensAt).toLocaleString()}`}</p>
            {panel === null ? (
              <div className="flex flex-wrap gap-2">
                {view.status === 'issued' && view.can.create ? <button type="button" className={buttonClass} onClick={() => setPanel('addendum')}>Send a clarification…</button> : null}
                {(view.status === 'issued' || view.status === 'closed') && view.can.close ? <button type="button" className={buttonClass} onClick={() => setPanel('extend')}>{view.status === 'closed' ? 'Reopen…' : 'Move the deadline…'}</button> : null}
                {view.status === 'issued' && view.can.close ? <button type="button" className={buttonClass} onClick={() => setPanel('close')}>Close early…</button> : null}
                {view.status !== 'awarded' && view.status !== 'cancelled' && view.can.close ? <button type="button" className={buttonClass} onClick={() => setPanel('close')}>Cancel the request…</button> : null}
              </div>
            ) : null}
            {panel === 'addendum' ? (
              <form className="space-y-2 rounded-lg border border-line p-3" aria-label="Send a clarification" onSubmit={(e) => { e.preventDefault(); void act(rfqAddendumAction(view.id, text, when).then((r) => (r.ok ? { ok: true as const } : r)), 'The clarification was sent to every invited vendor.'); }}>
                <Field id={`${uid}-ab`} label="Clarification"><textarea id={`${uid}-ab`} rows={3} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} required maxLength={2000} /></Field>
                <Field id={`${uid}-ad`} label="New deadline (optional)"><input id={`${uid}-ad`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={fieldClass} /></Field>
                <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Send to all vendors</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
              </form>
            ) : null}
            {panel === 'extend' ? (
              <form className="space-y-2 rounded-lg border border-line p-3" aria-label="Move the deadline" onSubmit={(e) => { e.preventDefault(); void act(extendRfqAction(view.id, when, text), 'The deadline moved and every vendor was told.'); }}>
                <Field id={`${uid}-xd`} label="New deadline"><input id={`${uid}-xd`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={fieldClass} required /></Field>
                <Field id={`${uid}-xr`} label="Why"><input id={`${uid}-xr`} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} required maxLength={500} autoComplete="off" /></Field>
                <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Move the deadline</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
              </form>
            ) : null}
            {panel === 'close' ? (
              <form className="space-y-2 rounded-lg border border-line p-3" aria-label="Close or cancel" onSubmit={(e) => { e.preventDefault(); }}>
                <Field id={`${uid}-cr`} label="Why" hint="Every invited vendor is told."><input id={`${uid}-cr`} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} required maxLength={500} autoComplete="off" /></Field>
                <div className="flex flex-wrap gap-2">
                  {view.status === 'issued' ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(closeRfqEarlyAction(view.id, text), 'Closed. The quotes can now be opened.')}>Close early</button> : null}
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(cancelRfqAction(view.id, text), 'The request is cancelled.')}>Cancel the request</button>
                  <button type="button" className={buttonClass} onClick={() => setPanel(null)}>Back</button>
                </div>
              </form>
            ) : null}
          </section>

          <section className={`${cardClass} space-y-3`} aria-label="Questions from vendors">
            <h3 className="text-sm font-bold text-fg-strong">Questions from vendors</h3>
            {view.questions.length === 0 ? <p className="text-sm text-fg-muted">No questions.</p> : (
              <ul className="space-y-3 text-sm">
                {view.questions.map((q) => (
                  <li key={q.id} className="space-y-1 border-t border-line pt-2 first:border-0 first:pt-0">
                    <p className="text-fg-strong"><span className="font-semibold">{q.vendor}:</span> {q.body}</p>
                    {q.answer === null && view.status === 'issued' && view.can.create ? (
                        <div className="space-y-1">
                          <Field id={`${uid}-qa-${q.id}`} label={`Answer for ${q.vendor}`}><input id={`${uid}-qa-${q.id}`} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} className={fieldClass} maxLength={2000} autoComplete="off" /></Field>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(answerRfqQuestionAction(q.id, answers[q.id] ?? '', true), 'Answered, and sent to every invited vendor without saying who asked.')}>Answer all vendors</button>
                            <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(answerRfqQuestionAction(q.id, answers[q.id] ?? '', false), 'Answer kept private.')}>Keep private</button>
                          </div>
                        </div>
                    ) : null}
                    {q.answer === null ? null : <p className="text-fg-muted">Answer ({q.published ? 'sent to all' : 'private'}): {q.answer}</p>}                  </li>
                ))}
              </ul>
            )}
            {view.addenda.length === 0 ? null : (
              <div><h4 className="text-xs font-bold uppercase text-fg-muted">Addenda sent</h4><ol className="mt-1 space-y-1 text-sm">{view.addenda.map((a) => <li key={a.number}>{a.number}. {a.body} <span className="text-xs text-fg-muted">({new Date(a.at).toLocaleString()})</span></li>)}</ol></div>
            )}
          </section>
        </>
      ) : null}

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
