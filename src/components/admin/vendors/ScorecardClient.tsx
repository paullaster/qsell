'use client';

import { use, useId, useState } from 'react';
import { reviewVendorAction, saveCriterionAction, scorecardsAction } from '@/server/domains/vendors/scorecard-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { SOURCE_WORDS } from '@/lib/vendor-scorecard';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof scorecardsAction>>, { ok: true }>['data'];

export function ScorecardClient({ initialPromise }: { initialPromise: ReturnType<typeof scorecardsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <Card initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Card({ initial }: { initial: Data }) {
  const uid = useId();
  const [data, setData] = useState(initial);
  const [from, setFrom] = useState(initial.range.from);
  const [to, setTo] = useState(initial.range.to);
  const [notice, setNotice] = useState<Notice>(null);
  const [rating, setRating] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const reload = async (f: string, t: string) => {
    const res = await attempt(scorecardsAction(f, t));
    if (res.ok) setData(res.data);
    else setNotice({ kind: 'error', text: res.error });
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Vendor scorecard" intro="One score per vendor from what the documents show and what people rate. A vendor with too little behind it gets no score, not a poor one." actions={data.can.manage ? <button type="button" className={buttonClass} onClick={() => setManaging((x) => !x)}>What it is made of</button> : undefined} />
      <Message notice={notice} />
      <div className={`${cardClass} flex flex-wrap items-end gap-3`}>
        <Field id={`${uid}-f`} label="From"><input id={`${uid}-f`} type="date" value={from} onChange={(e) => { setFrom(e.target.value); void reload(e.target.value, to); }} className={fieldClass} /></Field>
        <Field id={`${uid}-t`} label="To"><input id={`${uid}-t`} type="date" value={to} onChange={(e) => { setTo(e.target.value); void reload(from, e.target.value); }} className={fieldClass} /></Field>
      </div>
      {managing ? <Criteria data={data} onDone={() => { void reload(from, to); }} /> : null}
      {data.lines.length === 0 ? <p className="text-sm text-fg-muted">Nothing to score in this period.</p> : (
        <ul className="space-y-2" aria-label="Scorecards">
          {data.lines.map((l) => (
            <li key={l.vendorId} className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-bold text-fg-strong">{l.name}</span>
                <span className="flex items-center gap-2"><span className="text-lg font-bold tabular-nums text-fg-strong">{l.score === null ? 'No score' : l.score.toFixed(1)}</span><Chip tone={l.grade.tone}>{l.grade.letter} · {l.grade.label}</Chip></span>
              </div>
              <p className="text-xs text-fg-muted">Based on {String(l.coverage)}% of what the scorecard weighs</p>
              <ul className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-fg sm:grid-cols-2" aria-label={`Parts of ${l.name}`}>
                {l.parts.map((p) => <li key={p.criterionId} className="flex justify-between gap-2"><span>{p.name} <span className="text-fg-muted">(weight {String(p.weight)})</span></span><span className="tabular-nums">{p.value === null ? 'Not measured' : p.value.toFixed(1)}</span></li>)}
              </ul>
              {data.can.review ? <button type="button" className={`${buttonClass} mt-2`} aria-expanded={rating === l.vendorId} onClick={() => setRating((x) => (x === l.vendorId ? null : l.vendorId))}>Rate {l.name}</button> : null}
              {rating === l.vendorId ? <ReviewForm vendorId={l.vendorId} criteria={data.criteria.filter((c) => c.source === 'rating')} onDone={() => { setRating(null); setNotice({ kind: 'ok', text: 'Rating saved.' }); void reload(from, to); }} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewForm({ vendorId, criteria, onDone }: { vendorId: string; criteria: Data['criteria']; onDone: () => void }) {
  const uid = useId();
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  if (criteria.length === 0) return <p className="mt-2 text-sm text-fg-muted">Nothing on the scorecard is rated by people yet.</p>;
  return (
    <form className="mt-2 space-y-3 rounded-lg border border-line p-3" aria-label="Rate the vendor" onSubmit={(e) => { e.preventDefault(); setBusy(true); setNotice(null); void attempt(reviewVendorAction(vendorId, ratings, comment)).then((r) => { setBusy(false); if (r.ok) onDone(); else setNotice({ kind: 'error', text: r.error }); }); }}>
      <Message notice={notice} />
      {criteria.map((c) => (
        <fieldset key={c.id} className="flex flex-wrap items-center gap-2">
          <legend className="text-xs font-semibold text-fg">{c.name}</legend>
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="flex min-h-10 min-w-10 items-center justify-center gap-1 rounded-lg border border-line px-2 text-sm text-fg">
              <input type="radio" name={`${uid}-${c.id}`} value={n} checked={ratings[c.id] === String(n)} onChange={() => setRatings((p) => ({ ...p, [c.id]: String(n) }))} />
              <span>{n}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <Field id={`${uid}-c`} label="A comment (optional)"><input id={`${uid}-c`} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
      <button type="submit" className={primaryClass} disabled={busy || Object.keys(ratings).length === 0}>Save the rating</button>
    </form>
  );
}

function Criteria({ data, onDone }: { data: Data; onDone: () => void }) {
  const uid = useId();
  const [name, setName] = useState('');
  const [source, setSource] = useState<Choice | null>({ id: 'rating', label: SOURCE_WORDS.rating });
  const [weight, setWeight] = useState('10');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const act = async (call: ReturnType<typeof saveCriterionAction>, done: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) setNotice({ kind: 'error', text: res.error });
    else {
      setNotice({ kind: 'ok', text: done });
      onDone();
    }
  };
  return (
    <section className={`${cardClass} space-y-3`} aria-label="What the scorecard is made of">
      <h2 className="text-sm font-bold text-fg-strong">What it is made of</h2>
      <Message notice={notice} />
      <ul className="divide-y divide-line text-sm" aria-label="Criteria">
        {data.criteria.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{c.name} <span className="text-xs text-fg-muted">· {SOURCE_WORDS[c.source]} · weight {String(c.weight)}</span></span>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(saveCriterionAction(c.id, { name: c.name, source: c.source, weight: String(c.weight), active: false }), `${c.name} is switched off.`)}>Switch off {c.name}</button>
          </li>
        ))}
      </ul>
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Add a criterion" onSubmit={(e) => { e.preventDefault(); void act(saveCriterionAction(null, { name, source: source?.id ?? '', weight, active: true }), 'Added.'); }}>
        <Field id={`${uid}-n`} label="Name"><input id={`${uid}-n`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
        <ChoicePicker label="Scored on" source="scorecard-sources" choice={source} onChoice={setSource} required clearable={false} />
        <Field id={`${uid}-w`} label="Weight (1 to 100)"><input id={`${uid}-w`} inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
        <button type="submit" className={primaryClass} disabled={busy || name.trim() === ''}>Add a criterion</button>
      </form>
    </section>
  );
}
