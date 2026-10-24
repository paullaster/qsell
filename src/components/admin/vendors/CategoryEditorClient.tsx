'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { addQuestionAction, removeQuestionAction, saveCategoryAction, setCategoryDocumentsAction, setCategoryStatusAction, type categoryAction } from '@/server/domains/vendors/prequal-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { emptyQuestion, QUESTION_KINDS, type CategoryForm, type QuestionForm } from '@/lib/prequalification';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof categoryAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string };

export function CategoryEditorClient({ viewPromise }: { viewPromise: ReturnType<typeof categoryAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Editor view={res.data} /> : <LoadFailed error={res.error} />;
}

function Check({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex min-h-10 cursor-pointer items-start gap-2 text-sm text-fg">
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>{label}{hint === undefined ? null : <span className="block text-xs text-fg-muted">{hint}</span>}</span>
    </label>
  );
}

function Editor({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [f, setF] = useState<CategoryForm>(view.form);
  const [parent, setParent] = useState<Choice | null>(view.parent);
  const [q, setQ] = useState<QuestionForm>(emptyQuestion());
  const [kind, setKind] = useState<Choice | null>({ id: 'yes_no', label: 'Yes or no' });
  const [docs, setDocs] = useState<string[]>(view.documentTypeIds);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const set = <K extends keyof CategoryForm>(k: K, v: CategoryForm[K]) => setF((p) => ({ ...p, [k]: v }));

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

  const locked = view.locked;
  const statusWords: Record<string, string> = { draft: 'Draft', open: 'Open for applications', closed: 'Closed', archived: 'Archived' };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={f.name === '' ? view.code : f.name}
        intro={<span className="flex flex-wrap items-center gap-2">{view.code}<Chip tone={view.status === 'open' ? 'green' : 'gray'}>{statusWords[view.status] ?? view.status}</Chip></span>}
        actions={<Link href="/admin/vendors/categories" className={buttonClass}>All categories</Link>}
      />
      <Message notice={notice} />

      <form onSubmit={(e) => { e.preventDefault(); void act(saveCategoryAction(view.id, { ...f, parentId: parent?.id ?? '' }), 'Saved.'); }} className={`${cardClass} space-y-3`} aria-label="Category details">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id={`${uid}-n`} label="Name"><input id={`${uid}-n`} value={f.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} required maxLength={120} autoComplete="off" /></Field>
          <ChoicePicker label="Inside category" source="procurement-categories" choice={parent} onChoice={setParent} placeholder="None: a top-level category" />
          <Field id={`${uid}-d`} label="Description"><input id={`${uid}-d`} value={f.description} onChange={(e) => set('description', e.target.value)} className={fieldClass} maxLength={1000} autoComplete="off" /></Field>
          <Field id={`${uid}-v`} label="A qualification lasts (months)" hint={locked ? 'Fixed once the category is open.' : undefined}><input id={`${uid}-v`} inputMode="numeric" value={f.validityMonths} onChange={(e) => set('validityMonths', e.target.value)} className={fieldClass} disabled={locked} required /></Field>
          <Field id={`${uid}-pm`} label="Pass mark (% of the highest score)" hint="Leave empty to decide without a score."><input id={`${uid}-pm`} inputMode="decimal" value={f.passMarkPercent} onChange={(e) => set('passMarkPercent', e.target.value)} className={fieldClass} disabled={locked} /></Field>
          <div />
          <Field id={`${uid}-wf`} label="Applications open from"><input id={`${uid}-wf`} type="date" value={f.windowFrom} onChange={(e) => set('windowFrom', e.target.value)} className={fieldClass} /></Field>
          <Field id={`${uid}-wt`} label="Applications close after"><input id={`${uid}-wt`} type="date" value={f.windowTo} onChange={(e) => set('windowTo', e.target.value)} className={fieldClass} /></Field>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-semibold text-fg-strong">Who decides, and what vendors see</legend>
          <Check id={`${uid}-4e`} label="Someone who did not evaluate must decide" checked={f.fourEyes} onChange={(v) => set('fourEyes', v)} disabled={locked} />
          <p className="text-xs text-fg-muted">The decision and its reason are always shown to the vendor. Choose what else:</p>
          <Check id={`${uid}-s1`} label="Their total score" checked={f.showTotalScore} onChange={(v) => set('showTotalScore', v)} />
          <Check id={`${uid}-s2`} label="The pass mark" checked={f.showPassMark} onChange={(v) => set('showPassMark', v)} />
          <Check id={`${uid}-s3`} label="The score for each question" checked={f.showQuestionScores} onChange={(v) => set('showQuestionScores', v)} />
          <Check id={`${uid}-s4`} label="The evaluators’ comments" checked={f.showEvaluatorComments} onChange={(v) => set('showEvaluatorComments', v)} />
        </fieldset>
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>
      </form>

      <section className={`${cardClass} space-y-3`} aria-label="Required documents">
        <h3 className="text-sm font-bold text-fg-strong">Documents the vendor must hold</h3>
        <p className="text-xs text-fg-muted">The vendor adds these on its attachments page. If a document marked “blocks when expired” runs out, the qualification is suspended until a good one is uploaded.</p>
        {view.documentTypes.map((t) => (
          <Check key={t.id} id={`${uid}-doc-${t.id}`} label={t.name} checked={docs.includes(t.id)} disabled={locked} onChange={(v) => setDocs((d) => (v ? [...d, t.id] : d.filter((x) => x !== t.id)))} />
        ))}
        {locked ? <p className="text-xs text-fg-muted">Fixed once the category is open.</p> : <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(setCategoryDocumentsAction(view.id, docs), 'Documents saved.')}>Save documents</button>}
      </section>

      <section className={`${cardClass} space-y-3`} aria-label="Questions">
        <h3 className="text-sm font-bold text-fg-strong">Questions</h3>
        {view.questions.length === 0 ? <p className="text-sm text-fg-muted">No questions yet.</p> : (
          <ol className="divide-y divide-line text-sm">
            {view.questions.map((x, i) => (
              <li key={x.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span className="min-w-0 break-words"><span className="font-semibold text-fg-strong">{i + 1}. {x.prompt}</span><span className="block text-xs text-fg-muted">{QUESTION_KINDS.find((k) => k.id === x.kind)?.label ?? x.kind}{x.kind === 'choice' ? `: ${x.choices.join(', ')}` : ''} · {x.weight === 0 ? 'not scored' : `${String(x.weight)} points`} · {x.required ? 'required' : 'optional'}</span></span>
                {locked ? null : <InlineConfirm label={`Remove question ${String(i + 1)}`} action="Remove" confirm="Yes, remove" busy={busy} onConfirm={() => void act(removeQuestionAction(view.id, x.id), 'Removed.')} />}
              </li>
            ))}
          </ol>
        )}
        {locked ? <p className="text-xs text-fg-muted">Vendors can apply under these questions, so they are fixed. To change them, close this category and make a new one.</p> : (
          <form className="grid grid-cols-1 gap-3 rounded-lg border border-line p-3 sm:grid-cols-2" aria-label="Add a question" onSubmit={(e) => { e.preventDefault(); void act(addQuestionAction(view.id, { ...q, kind: kind?.id ?? 'yes_no' }), 'Question added.').then((ok) => { if (ok) setQ(emptyQuestion()); }); }}>
            <div className="sm:col-span-2"><Field id={`${uid}-qp`} label="Question"><input id={`${uid}-qp`} value={q.prompt} onChange={(e) => setQ((p) => ({ ...p, prompt: e.target.value }))} className={fieldClass} required maxLength={300} autoComplete="off" /></Field></div>
            <ChoicePicker label="Kind of answer" source="prequal-question-kinds" choice={kind} onChoice={setKind} clearable={false} required />
            <Field id={`${uid}-qw`} label="Points it can earn" hint="0 means it is asked but not scored."><input id={`${uid}-qw`} inputMode="numeric" value={q.weight} onChange={(e) => setQ((p) => ({ ...p, weight: e.target.value }))} className={fieldClass} required /></Field>
            {kind?.id === 'choice' ? <div className="sm:col-span-2"><Field id={`${uid}-qc`} label="Choices" hint="One on each line."><textarea id={`${uid}-qc`} value={q.choices} onChange={(e) => setQ((p) => ({ ...p, choices: e.target.value }))} rows={3} className={fieldClass} /></Field></div> : null}
            <Check id={`${uid}-qr`} label="The vendor must answer it" checked={q.required} onChange={(v) => setQ((p) => ({ ...p, required: v }))} />
            <div className="flex items-end"><button type="submit" className={buttonClass} disabled={busy}>Add question</button></div>
          </form>
        )}
      </section>

      <section className={`${cardClass} space-y-2`} aria-label="Status">
        <h3 className="text-sm font-bold text-fg-strong">Taking applications</h3>
        <div className="flex flex-wrap gap-2">
          {view.status === 'draft' || view.status === 'closed' ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(setCategoryStatusAction(view.id, 'open'), view.status === 'draft' ? 'The category is open. Vendors can apply.' : 'The category is open again.')}>{view.status === 'draft' ? 'Open for applications' : 'Open again'}</button> : null}
          {view.status === 'open' ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(setCategoryStatusAction(view.id, 'closed'), 'Closed. Existing qualifications stand.')}>Close to new applications</button> : null}
          {view.status === 'draft' || view.status === 'closed' ? <InlineConfirm label={`Archive ${f.name}`} action="Archive" confirm="Yes, archive" busy={busy} onConfirm={() => void act(setCategoryStatusAction(view.id, 'archived'), 'Archived.')} /> : null}
        </div>
      </section>
    </div>
  );
}
