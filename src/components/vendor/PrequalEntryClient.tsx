'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveAnswersAction, submitEntryAction, withdrawEntryAction, type prequalEntryAction } from '@/server/domains/vendors/prequal-portal-actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { STATUS_WORDS } from '@/lib/prequalification';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof prequalEntryAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string; problems?: Record<string, string> };

export function PrequalEntryClient({ entryPromise }: { entryPromise: ReturnType<typeof prequalEntryAction> }) {
  const res = use(entryPromise);
  return res.ok ? <Entry view={res.data} /> : <LoadFailed error={res.error} />;
}

const DOC_CHIP = {
  valid: { tone: 'green', text: 'Checked' },
  submitted: { tone: 'amber', text: 'Uploaded' },
  missing: { tone: 'red', text: 'Not uploaded' },
} as const;

function DocChip({ held }: { held: 'valid' | 'submitted' | null }) {
  const c = DOC_CHIP[held ?? 'missing'];
  return <Chip tone={c.tone}>{c.text}</Chip>;
}

type Question = View['questions'][number];

/** One question, drawn by the kind of answer it takes. */
function QuestionField({ q, n, id, value, off, problem, onChange }: { q: Question; n: number; id: string; value: string; off: boolean; problem: string | undefined; onChange: (v: string) => void }) {
  const label = `${String(n)}. ${q.prompt}${q.required ? '' : ' (optional)'}`;
  if (q.kind === 'yes_no' || q.kind === 'choice') {
    const options = q.kind === 'yes_no' ? [{ v: 'yes', t: 'Yes' }, { v: 'no', t: 'No' }] : q.choices.map((c) => ({ v: c, t: c }));
    return (
      <fieldset disabled={off}>
        <legend className="text-sm font-medium text-fg-strong">{label}</legend>
        <div className={q.kind === 'yes_no' ? 'flex gap-4' : undefined}>
          {options.map((o) => <label key={o.v} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg"><input type="radio" className="h-5 w-5" name={id} checked={value === o.v} onChange={() => onChange(o.v)} />{o.t}</label>)}
        </div>
        {problem === undefined ? null : <p role="alert" className="text-sm text-red-600">{problem}</p>}
      </fieldset>
    );
  }
  return (
    <Field id={id} label={label} hint={problem}>
      {q.kind === 'text' ? <textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass} disabled={off} aria-invalid={problem !== undefined} /> : <input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass} disabled={off} aria-invalid={problem !== undefined} />}
    </Field>
  );
}

function Entry({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(view.questions.map((q) => [q.id, q.answer])));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const state = STATUS_WORDS[view.status] ?? { label: view.status, tone: 'gray' as const };
  const r = view.result;

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
  const send = async () => {
    if (await act(saveAnswersAction(view.id, answers), 'Saved.')) await act(submitEntryAction(view.id), 'Your application was sent. We will evaluate it.');
  };
  const missing = view.documents.filter((d) => d.held === null);

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={view.categoryName} intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={state.tone}>{state.label}</Chip>{r.validUntil === null ? null : <span>Qualified until {r.validUntil}</span>}</span>} actions={<Link href="/vendor/prequalification" className={buttonClass}>Back</Link>} />
      <Message notice={notice} />
      {view.description === null ? null : <p className="text-sm text-fg">{view.description}</p>}
      {r.comment === null && r.reasonCode === null ? null : <p role="note" className="rounded-lg border border-line bg-surface-sunken p-3 text-sm text-fg">{r.reasonCode === null ? '' : `Reason: ${r.reasonCode.replace(/^PQ_/, '').replace(/_/g, ' ').toLowerCase()}. `}{r.comment}{r.revisionDue === null ? '' : ` Please send it again by ${r.revisionDue}.`}</p>}
      {r.suspendedBecause === null ? null : <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">Paused: {r.suspendedBecause}. It comes back by itself once the document is replaced.</p>}
      {r.maxOrderValue === null && r.conditionsNote === null ? null : <p className="text-sm text-fg">Conditions: {r.maxOrderValue === null ? '' : `largest order ${r.maxOrderValue}. `}{r.conditionsNote}</p>}
      {r.totalScore === null ? null : <p className="text-sm text-fg">Your score: <span className="font-semibold">{r.totalScore} of {r.maxScore}</span>{r.passMarkPercent === null ? '' : ` (pass mark ${String(Number(r.passMarkPercent))}%)`}</p>}
      {r.evaluatorComments.length === 0 ? null : <ul className="list-disc space-y-1 pl-5 text-sm text-fg">{r.evaluatorComments.map((c) => <li key={c}>{c}</li>)}</ul>}

      {view.documents.length === 0 ? null : (
        <section className={cardClass} aria-label="Documents">
          <h2 className="text-sm font-bold text-fg-strong">Documents this category asks for</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {view.documents.map((d) => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span>{d.name}</span><DocChip held={d.held} /></li>)}
          </ul>
          {missing.length === 0 ? null : <p className="mt-2 text-sm text-fg-muted">Add the missing ones on your <Link href="/vendor/profile/attachments" className="font-semibold text-indigo-600 hover:underline">attachments page</Link>.</p>}
        </section>
      )}

      <form onSubmit={(e) => { e.preventDefault(); void act(saveAnswersAction(view.id, answers), 'Saved.'); }} noValidate className={`${cardClass} space-y-4`} aria-label="Questions">
        <h2 className="text-sm font-bold text-fg-strong">Questions</h2>
        {view.questions.map((q, i) => {
          const id = `${uid}-${q.id}`;
          const off = !view.canEdit;
          const problem = problems[q.id];
          return (
            <div key={q.id} className="space-y-1">
              <QuestionField q={q} n={i + 1} id={id} value={answers[q.id] ?? ''} off={off} problem={problem} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
              {q.score === null ? null : <p className="text-xs text-fg-muted">Score: {q.score}{q.weight > 0 ? ` of ${String(q.weight)}` : ''}</p>}
              {q.comments.map((c) => <p key={c} className="text-xs text-fg-muted">Evaluator: {c}</p>)}
            </div>
          );
        })}
        {view.canEdit ? (
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass} disabled={busy}>Save</button>
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void send()}>{view.status === 'revision_requested' ? 'Save and send again' : 'Save and send'}</button>
          </div>
        ) : null}
      </form>

      {['draft', 'submitted', 'in_review', 'revision_requested'].includes(view.status) ? (
        <InlineConfirm label={`Withdraw the application for ${view.categoryName}`} action="Withdraw this application" confirm="Yes, withdraw" busy={busy} onConfirm={() => void act(withdrawEntryAction(view.id), 'Withdrawn.').then((ok) => { if (ok) router.push('/vendor/prequalification'); })} />
      ) : null}
    </div>
  );
}
