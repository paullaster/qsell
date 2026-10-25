'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveEntryAction, reinstateEntryAction, rejectEntryAction, reviseEntryAction, revokeEntryAction, saveScoresAction, suspendEntryAction, takeEntryAction, type prequalDetailAction } from '@/server/domains/vendors/prequal-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { QUESTION_KINDS, STATUS_WORDS } from '@/lib/prequalification';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof prequalDetailAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string };
type Panel = null | 'approve' | 'revise' | 'reject' | 'suspend' | 'revoke';

export function PrequalDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof prequalDetailAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Detail view={res.data} /> : <LoadFailed error={res.error} />;
}

const passWords = (passed: boolean | null): string => {
  if (passed === null) return 'not scored';
  return passed ? 'passing' : 'below the pass mark';
};

const DOC_CHIP = {
  valid: { tone: 'green', text: 'Checked, valid' },
  submitted: { tone: 'amber', text: 'Uploaded, not checked yet' },
  missing: { tone: 'red', text: 'Missing' },
} as const;

function DocChip({ held }: { held: 'valid' | 'submitted' | null }) {
  const c = DOC_CHIP[held ?? 'missing'];
  return <Chip tone={c.tone}>{c.text}</Chip>;
}

const PANEL = {
  reject: { label: 'Refuse this application', button: 'Refuse the application', done: 'The application is refused.' },
  suspend: { label: 'Suspend this qualification', button: 'Suspend', done: 'The qualification is suspended.' },
  revoke: { label: 'Revoke this qualification', button: 'Revoke', done: 'The qualification is revoked.' },
} as const;

const answerWords = (kind: string, answer: string): string => {
  if (answer === '') return 'No answer';
  if (kind !== 'yes_no') return answer;
  return answer === 'yes' ? 'Yes' : 'No';
};

function Detail({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [mine, setMine] = useState<Record<string, { score: string; comment: string }>>(() =>
    Object.fromEntries(view.questions.map((q) => {
      const own = q.scores.find((s) => s.mine);
      return [q.id, { score: own === undefined ? '' : String(own.score), comment: own?.comment ?? '' }];
    })),
  );
  const [cond, setCond] = useState({ maxOrderValue: '', note: '' });
  const [revise, setRevise] = useState({ note: '', due: '' });
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const state = STATUS_WORDS[view.status] ?? { label: view.status, tone: 'gray' as const };
  const decidable = view.status === 'submitted' || view.status === 'in_review';
  const needsComment = reason?.meta?.requiresComment === '1';

  const act = async (call: Promise<Result>, done: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: done });
    setPanel(null);
    setReason(null);
    setReasonText('');
    router.refresh();
  };
  const open = (p: Panel) => { setPanel(p); setNotice(null); setReason(null); setReasonText(''); };
  const saveScores = () => {
    const scores = view.questions.filter((q) => q.weight > 0 && (mine[q.id]?.score ?? '') !== '').map((q) => ({ questionId: q.id, score: Number(mine[q.id]?.score), comment: mine[q.id]?.comment ?? '' }));
    void act(saveScoresAction(view.id, scores), 'Your scores are saved.');
  };
  const reasonFields = (label: string) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ChoicePicker label="Reason" source="prequal-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
      <Field id={`${uid}-rt`} label={needsComment ? 'Explain (required)' : 'Comment (optional)'} hint={label}>
        <input id={`${uid}-rt`} value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsComment} maxLength={500} autoComplete="off" />
      </Field>
    </div>
  );
  const why = { code: reason?.id ?? '', text: reasonText };
  const standing = (p: 'reject' | 'suspend' | 'revoke'): Promise<Result> => {
    if (p === 'reject') return rejectEntryAction(view.id, why);
    return p === 'suspend' ? suspendEntryAction(view.id, why) : revokeEntryAction(view.id, why);
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={view.vendorName}
        intro={<span className="flex flex-wrap items-center gap-2">{view.categoryName}<Chip tone={state.tone}>{state.label}</Chip>{view.validUntil === null ? null : <span>Qualified until {view.validUntil}</span>}</span>}
        actions={<span className="flex items-center gap-3"><Link href={`/admin/vendors/${view.vendorId}`} className="text-sm font-semibold text-indigo-600 hover:underline">Vendor card</Link><Link href="/admin/vendors/prequalification" className={buttonClass}>All applications</Link></span>}
      />
      <Message notice={notice} />
      {view.suspendedBecause === null ? null : <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-fg">Suspended: {view.suspendedBecause}</p>}
      {view.reasonCode === null && view.decisionComment === null ? null : <p className="text-sm text-fg">{view.reasonCode === null ? '' : `Reason: ${view.reasonCode.replace(/^PQ_/, '').replace(/_/g, ' ').toLowerCase()}. `}{view.decisionComment}</p>}
      {view.maxOrderValue === null && view.conditionsNote === null ? null : <p className="text-sm text-fg">Conditions: {view.maxOrderValue === null ? '' : `largest order ${view.maxOrderValue}. `}{view.conditionsNote}</p>}

      <section className={`${cardClass} space-y-3`} aria-label="Answers and scores">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-fg-strong">Answers and scores</h3>
          <span className="text-xs text-fg-muted">Evaluators: {view.evaluators.length === 0 ? 'none yet' : view.evaluators.join(', ')}</span>
        </div>
        <ol className="divide-y divide-line text-sm">
          {view.questions.map((q, i) => (
            <li key={q.id} className="space-y-2 py-3">
              <p className="font-semibold text-fg-strong">{i + 1}. {q.prompt} <span className="text-xs font-normal text-fg-muted">({QUESTION_KINDS.find((k) => k.id === q.kind)?.label}{q.weight === 0 ? ', not scored' : `, up to ${String(q.weight)}`})</span></p>
              <p className="break-words text-fg">{answerWords(q.kind, q.answer)}</p>
              {q.scores.filter((s) => !s.mine).map((s) => <p key={s.evaluator} className="text-xs text-fg-muted">{s.evaluator}: {s.score}{s.comment === null ? '' : ` — ${s.comment}`}</p>)}
              {view.status === 'in_review' && view.me.isEvaluator && view.can.evaluate && q.weight > 0 ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]">
                  <Field id={`${uid}-s-${q.id}`} label={`Your score for question ${String(i + 1)}`}><input id={`${uid}-s-${q.id}`} inputMode="numeric" value={mine[q.id]?.score ?? ''} onChange={(e) => setMine((m) => ({ ...m, [q.id]: { score: e.target.value, comment: m[q.id]?.comment ?? '' } }))} className={fieldClass} /></Field>
                  <Field id={`${uid}-c-${q.id}`} label="Comment"><input id={`${uid}-c-${q.id}`} value={mine[q.id]?.comment ?? ''} onChange={(e) => setMine((m) => ({ ...m, [q.id]: { score: m[q.id]?.score ?? '', comment: e.target.value } }))} className={fieldClass} maxLength={500} autoComplete="off" /></Field>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        {view.status === 'in_review' && view.me.isEvaluator && view.can.evaluate ? <button type="button" className={buttonClass} disabled={busy} onClick={saveScores}>Save my scores</button> : null}
        <p className="text-sm text-fg" aria-live="polite">Score so far: <span className="font-semibold">{view.totals.total} of {view.totals.max}</span>{view.totals.passMarkPercent === null ? '' : ` · pass mark ${String(view.totals.passMarkPercent)}% · ${passWords(view.totals.passed)}`}</p>
      </section>

      <section className={cardClass} aria-label="Documents">
        <h3 className="text-sm font-bold text-fg-strong">Documents this category asks for</h3>
        {view.documents.length === 0 ? <p className="mt-1 text-sm text-fg-muted">None.</p> : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {view.documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span>{d.name}</span><DocChip held={d.held} /></li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-fg-muted">Documents are checked on the <Link href={`/admin/vendors/${view.vendorId}`} className="font-semibold text-indigo-600 hover:underline">vendor card</Link>.</p>
      </section>

      <section className={cardClass} aria-label="Decision">
        <h3 className="text-sm font-bold text-fg-strong">Decision</h3>
        {panel === null ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {view.status === 'submitted' && view.can.evaluate ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(takeEntryAction(view.id), 'You are now an evaluator of this application.')}>Take for evaluation</button> : null}
            {view.status === 'in_review' && !view.me.isEvaluator && view.can.evaluate ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(takeEntryAction(view.id), 'You are now an evaluator of this application.')}>Join the evaluation</button> : null}
            {decidable && view.can.decideNow ? (
              <>
                <button type="button" className={primaryClass} disabled={busy} onClick={() => open('approve')}>Approve…</button>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => open('revise')}>Ask for changes…</button>
                <button type="button" className={dangerClass} disabled={busy} onClick={() => open('reject')}>Refuse…</button>
              </>
            ) : null}
            {decidable && view.can.decide && !view.can.decideNow ? <p className="text-sm text-fg-muted">You evaluated this application, so someone else must decide it.</p> : null}
            {view.status === 'approved' && view.can.decide ? (
              <>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => open('suspend')}>Suspend…</button>
                <button type="button" className={dangerClass} disabled={busy} onClick={() => open('revoke')}>Revoke…</button>
              </>
            ) : null}
            {view.status === 'suspended' && view.can.decide ? (
              <>
                <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(reinstateEntryAction(view.id), 'The qualification is back in force.')}>Reinstate</button>
                <button type="button" className={dangerClass} disabled={busy} onClick={() => open('revoke')}>Revoke…</button>
              </>
            ) : null}
            {!(decidable || view.status === 'approved' || view.status === 'suspended') ? <p className="text-sm text-fg-muted">Nothing more to decide.</p> : null}
          </div>
        ) : null}
        {panel === 'approve' ? (
          <form className="mt-3 space-y-3 rounded-lg border border-line p-3" aria-label="Approve this application" onSubmit={(e) => { e.preventDefault(); void act(approveEntryAction(view.id, cond), 'Approved. The vendor is qualified.'); }}>
            <p className="text-sm text-fg">Approving qualifies the vendor for this category from today for the period the category sets. A required document must be checked first.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${uid}-mo`} label="Largest order value (optional)" hint="A condition checked when an order is raised."><input id={`${uid}-mo`} inputMode="decimal" value={cond.maxOrderValue} onChange={(e) => setCond((p) => ({ ...p, maxOrderValue: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
              <Field id={`${uid}-cn`} label="Conditions (optional)"><input id={`${uid}-cn`} value={cond.note} onChange={(e) => setCond((p) => ({ ...p, note: e.target.value }))} className={fieldClass} maxLength={500} autoComplete="off" /></Field>
            </div>
            <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Approve this vendor for the category</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Not yet</button></div>
          </form>
        ) : null}
        {panel === 'revise' ? (
          <form className="mt-3 space-y-3 rounded-lg border border-line p-3" aria-label="Ask for changes" onSubmit={(e) => { e.preventDefault(); void act(reviseEntryAction(view.id, revise.note, revise.due), 'Sent back to the vendor.'); }}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${uid}-rn`} label="What must change"><input id={`${uid}-rn`} value={revise.note} onChange={(e) => setRevise((p) => ({ ...p, note: e.target.value }))} className={fieldClass} required maxLength={1000} autoComplete="off" /></Field>
              <Field id={`${uid}-rd`} label="Due date (optional)"><input id={`${uid}-rd`} type="date" value={revise.due} onChange={(e) => setRevise((p) => ({ ...p, due: e.target.value }))} className={fieldClass} /></Field>
            </div>
            <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Send back</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
          </form>
        ) : null}
        {panel === 'reject' || panel === 'suspend' || panel === 'revoke' ? (
          <form className="mt-3 space-y-3 rounded-lg border border-line p-3" aria-label={PANEL[panel].label} onSubmit={(e) => { e.preventDefault(); void act(standing(panel), PANEL[panel].done); }}>
            {reasonFields('Kept with your name and the time. The vendor is told the reason.')}
            <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || reason === null}>{PANEL[panel].button}</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
