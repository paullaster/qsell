'use client';

import { useId, useMemo, useState } from 'react';
import { simulateAction, type SimulationView } from '@/server/kernel/approvals/actions';
import { triggerByCode } from '@/server/kernel/approvals/domain/triggers';
import type { WorkflowDefinition } from '@/server/kernel/approvals/domain/types';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt } from '@/components/ui/screen-kit';
import { buildFacts, extraFields } from '@/lib/approval-forms';
import type { Choice } from '@/lib/payment-options';
import { emptyToNull, has, orElse } from '@/lib/values';
import { Notice, cardClass, fieldClass, labelClass, primaryButtonClass, type Message } from './shared';


/** Shows who would be asked for an example document, using the draft as it is on screen. Nothing is saved or sent. */
export function WorkflowTestPanel({ triggerCode, def }: { triggerCode: string; def: WorkflowDefinition }) {
  const uid = useId();
  const trigger = triggerByCode(triggerCode);
  const extra = useMemo(() => (trigger === undefined ? [] : extraFields(trigger.fields)), [trigger]);
  const [amount, setAmount] = useState(100000);
  const [requester, setRequester] = useState<Choice | null>(null);
  const [branch, setBranch] = useState<Choice | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [onlyDraft, setOnlyDraft] = useState(true);
  const [result, setResult] = useState<SimulationView | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (requester === null) return;
    setBusy(true);
    setMessage(null);
    const res = await attempt(simulateAction({ trigger: triggerCode, amount, requestedBy: requester.id, branchId: emptyToNull(branch?.id), facts: buildFacts(extra, values), draft: def, onlyDraft }));
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    setResult(res.data);
  };

  return (
    <section className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-t`}>
      <h3 id={`${uid}-t`} className="text-sm font-bold text-fg-strong">
        Try it on an example
      </h3>
      <p className="text-sm text-fg-muted">Nothing is saved or sent. This shows who would be asked, using today’s approvers and limits and your draft as it is on screen.</p>
      <form onSubmit={(e) => void run(e)} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor={`${uid}-a`} className={labelClass}>
              Amount (KES)
            </label>
            <input id={`${uid}-a`} type="number" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className={fieldClass} />
          </div>
          <ChoicePicker label="Requested by" source="approval-users" choice={requester} onChoice={setRequester} placeholder="Choose a person…" required />
          <ChoicePicker label="Branch" source="approval-branches" choice={branch} onChoice={setBranch} placeholder="Not specified" />
          {extra.map((f) =>
            f.type === 'boolean' ? (
              <ChoicePicker
                key={f.path}
                label={f.label}
                source="approval-yes-no"
                choice={has(values[f.path]) ? { id: orElse(values[f.path], ''), label: values[f.path] === 'true' ? 'Yes' : 'No' } : null}
                onChoice={(c) => setValues({ ...values, [f.path]: c?.id ?? '' })}
                placeholder="Not set"
              />
            ) : (
              <div key={f.path}>
                <label htmlFor={`${uid}-${f.path}`} className={labelClass}>
                  {f.label}
                </label>
                <input id={`${uid}-${f.path}`} type={f.type === 'number' ? 'number' : 'text'} value={values[f.path] ?? ''} onChange={(e) => setValues({ ...values, [f.path]: e.target.value })} className={fieldClass} />
              </div>
            ),
          )}
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="size-4" checked={onlyDraft} onChange={(e) => setOnlyDraft(e.target.checked)} />
          Test only this draft (untick to see it alongside the live workflows)
        </label>
        <button type="submit" className={primaryButtonClass} disabled={busy || requester === null}>
          {busy ? 'Testing…' : 'Test'}
        </button>
      </form>
      <Notice message={message} />
      {result === null ? null : <Outcome result={result} />}
    </section>
  );
}

function Outcome({ result }: { result: SimulationView }) {
  return (
    <div aria-live="polite" className="space-y-3">
      {result.enabled ? null : <p className="text-sm text-amber-700">Approvals are switched off for this module, so none of this would be asked.</p>}
      {result.workflows.map((w) => (
        <div key={w.code} className="rounded-lg border border-line p-3">
          <p className="text-sm font-semibold text-fg-strong">
            {w.name}
            {w.version === null || w.version === 0 ? '' : ` (version ${String(w.version)})`} · {w.matched ? <span className="text-emerald-700">applies</span> : <span className="text-fg-muted">does not apply</span>}
          </p>
          <details className="mt-1">
            <summary className="min-h-10 cursor-pointer text-xs text-fg-muted">Why</summary>
            <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">{w.why.length === 0 ? <li>No conditions: it always applies.</li> : w.why.map((x) => <li key={x}>{x}</li>)}</ul>
          </details>
          {w.matched ? (
            <ol className="mt-2 space-y-1.5">
              {w.steps.map((s) => (
                <li key={s.sequence} className="text-sm text-fg">
                  <span className="font-medium">
                    {s.sequence}. {s.name}
                  </span>{' '}
                  <StepOutcome step={s} />
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ))}
      {result.workflows.length === 0 ? <p className="text-sm text-fg-muted">No workflow applies, so the document would go ahead without approval.</p> : null}
    </div>
  );
}

function StepOutcome({ step: s }: { step: SimulationView['workflows'][number]['steps'][number] }) {
  if (s.skipped) return <span className="text-fg-muted">skipped for this example</span>;
  if (has(s.problem)) {
    return (
      <span role="alert" className="text-red-700">
        would fail: {s.problem}
      </span>
    );
  }
  return <span>→ {orElse(s.approvers.join(' → '), 'nobody')}</span>;
}
