'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  publishWorkflowAction,
  saveWorkflowDraftAction,
  setWorkflowStatusAction,
  updateWorkflowMetaAction,
  type getWorkflowAction,
  type WorkflowDetail,
} from '@/server/kernel/approvals/actions';
import type { DefinitionIssue } from '@/server/kernel/approvals/domain/definition';
import { MODULE_LABELS, triggerByCode } from '@/server/kernel/approvals/domain/triggers';
import type { StepDefinition, WorkflowDefinition } from '@/server/kernel/approvals/domain/types';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import { blankStep, generalIssues, issuesOfStep, metaPayload, moveStep, removeAt, renumber, replaceAt, statusChangedWords, type WorkflowStatus } from '@/lib/approval-forms';
import type { Choice } from '@/lib/payment-options';
import { has, orElse } from '@/lib/values';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import { ConditionEditor } from './ConditionEditor';
import { Chip, Notice, PageHeader, StatusChip, When, buttonClass, cardClass, dangerButtonClass, fieldClass, labelClass, primaryButtonClass, type Message } from './shared';
import { IssueList, StepCard } from './WorkflowStepCard';
import { WorkflowTestPanel } from './WorkflowTestPanel';

export function WorkflowDesignerClient({ workflowPromise }: { workflowPromise: ReturnType<typeof getWorkflowAction> }) {
  const res = use(workflowPromise);
  return res.ok ? <Designer workflow={res.data} /> : <LoadFailed error={res.error} />;
}

function Designer({ workflow }: { workflow: WorkflowDetail }) {
  const uid = useId();
  const router = useRouter();
  const trigger = triggerByCode(workflow.triggerCode);
  const [meta, setMeta] = useState({ name: workflow.name, description: workflow.description ?? '', priority: workflow.priority });
  const [branch, setBranch] = useState<Choice | null>(workflow.branchId === null ? null : { id: workflow.branchId, label: workflow.labels[`branch:${workflow.branchId}`] ?? workflow.branchId });
  const [labels, setLabels] = useState(workflow.labels);
  const [def, setDef] = useState<WorkflowDefinition>(workflow.draft);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify({ meta, branch: workflow.branchId, def: workflow.draft }));
  const [issues, setIssues] = useState<DefinitionIssue[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });

  if (trigger === undefined) return <LoadFailed error="This workflow is about a situation that no longer exists." />;
  const dirty = JSON.stringify({ meta, branch: branch?.id ?? null, def }) !== savedSnapshot;
  const retired = workflow.status === 'retired';
  const setStep = (i: number, next: StepDefinition) => setDef({ ...def, steps: replaceAt(def.steps, i, next) });
  const remember = (key: string, label: string) => setLabels((prev) => ({ ...prev, [key]: label }));

  const saveAll = async (): Promise<'failed' | 'issues' | 'clean'> => {
    const m = await attempt(updateWorkflowMetaAction(workflow.id, metaPayload(meta, branch?.id ?? null)));
    if (!m.ok) {
      setMessage({ kind: 'error', text: m.error });
      return 'failed';
    }
    const d = await attempt(saveWorkflowDraftAction(workflow.id, def));
    if (!d.ok) {
      setMessage({ kind: 'error', text: d.error });
      return 'failed';
    }
    setIssues(d.data.issues);
    setSavedSnapshot(JSON.stringify({ meta, branch: branch?.id ?? null, def }));
    return d.data.issues.length === 0 ? 'clean' : 'issues';
  };

  const saveDraft = async () => {
    setBusy(true);
    setMessage(null);
    const state = await saveAll();
    setBusy(false);
    if (state === 'clean') setMessage({ kind: 'ok', text: 'Draft saved. It is not live until you publish it.' });
    if (state === 'issues') setMessage({ kind: 'error', text: 'Draft saved, but it has problems that must be fixed before it can be published.' });
    router.refresh();
  };

  const publish = async () => {
    setBusy(true);
    setMessage(null);
    const state = await saveAll();
    if (state !== 'clean') {
      setBusy(false);
      if (state === 'issues') setMessage({ kind: 'error', text: 'Fix the problems listed below, then publish.' });
      return;
    }
    const res = await attempt(publishWorkflowAction(workflow.id, reason));
    setBusy(false);
    if (!res.ok) {
      if ('issues' in res && Array.isArray(res.issues)) setIssues(res.issues);
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    setReason({ code: '', text: '' });
    setMessage({ kind: 'ok', text: `Published as version ${String(res.data.version)}. Requests already waiting keep the version they started with.` });
    router.refresh();
  };

  const changeStatus = async (status: WorkflowStatus) => {
    setBusy(true);
    setMessage(null);
    const res = await attempt(setWorkflowStatusAction(workflow.id, status, reason));
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    setReason({ code: '', text: '' });
    setMessage({ kind: 'ok', text: statusChangedWords(status) });
    router.refresh();
  };

  const general = generalIssues(issues);
  const live = workflow.versions[0];
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={orElse(meta.name, workflow.code)}
        actions={
          <Link href="/admin/settings/approvals/workflows" className={buttonClass}>
            All workflows
          </Link>
        }
      >
        <span className="font-mono">{workflow.code}</span> · {MODULE_LABELS[trigger.module] ?? trigger.module} · {trigger.label}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={workflow.status} />
        {dirty ? <Chip tone="amber">Unsaved changes</Chip> : null}
        {live === undefined ? <Chip tone="grey">Never published</Chip> : <Chip tone="grey">Live version {live.version}</Chip>}
      </div>

      <Notice message={message} />
      {general.length > 0 ? <IssueList title="Fix before publishing" issues={general} /> : null}

      <section className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-details`}>
        <h3 id={`${uid}-details`} className="text-sm font-bold text-fg-strong">
          Details
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-name`} className={labelClass}>
              Name
            </label>
            <input id={`${uid}-name`} value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} className={fieldClass} disabled={retired} />
          </div>
          <ChoicePicker label="Branch" source="approval-branches" choice={branch} onChoice={setBranch} placeholder="All branches" disabled={retired} />
          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-desc`} className={labelClass}>
              What is this for?
            </label>
            <input id={`${uid}-desc`} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} className={fieldClass} disabled={retired} />
          </div>
          <div>
            <label htmlFor={`${uid}-prio`} className={labelClass}>
              Order (lower is asked first)
            </label>
            <input id={`${uid}-prio`} type="number" value={meta.priority} onChange={(e) => setMeta({ ...meta, priority: Number(e.target.value) })} className={fieldClass} disabled={retired} />
          </div>
        </div>
      </section>

      <section className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-when`}>
        <h3 id={`${uid}-when`} className="text-sm font-bold text-fg-strong">
          When does it apply?
        </h3>
        <ConditionEditor value={def.conditions} onChange={(c) => setDef({ ...def, conditions: c })} trigger={trigger.code} fields={trigger.fields} label="When this workflow applies" emptyText="It applies to every document of this kind." />
      </section>

      <section className="space-y-3" aria-labelledby={`${uid}-steps`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${uid}-steps`} className="text-sm font-bold text-fg-strong">
            Who approves, in order
          </h3>
          <button type="button" className={buttonClass} disabled={retired} onClick={() => setDef({ ...def, steps: renumber([...def.steps, blankStep(def.steps.length + 1)]) })}>
            Add a step
          </button>
        </div>
        {def.steps.length === 0 ? (
          <p className="text-sm text-fg-muted">No steps yet. Add the first approval step.</p>
        ) : (
          <ol className="space-y-3">
            {def.steps.map((step, i) => (
              <li key={step.sequence}>
                <StepCard
                  step={step}
                  index={i}
                  count={def.steps.length}
                  issues={issuesOfStep(issues, i)}
                  trigger={trigger.code}
                  fields={trigger.fields}
                  labels={labels}
                  remember={remember}
                  disabled={retired}
                  onChange={(s) => setStep(i, s)}
                  onMove={(by) => setDef({ ...def, steps: moveStep(def.steps, i, by) })}
                  onRemove={() => setDef({ ...def, steps: renumber(removeAt(def.steps, i)) })}
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      <WorkflowTestPanel triggerCode={workflow.triggerCode} def={def} />

      {retired ? null : (
        <section className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-publish`}>
          <h3 id={`${uid}-publish`} className="text-sm font-bold text-fg-strong">
            Save and publish
          </h3>
          <p className="text-sm text-fg-muted">Saving keeps your work as a draft. Publishing makes it live for new documents as a new version; requests already waiting finish under the version they started with.</p>
          <ReasonField value={reason} onChange={setReason} source="approval-config-reasons" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy || !dirty} onClick={() => void saveDraft()}>
              Save draft
            </button>
            <button type="button" className={primaryButtonClass} disabled={busy || reason.code === ''} onClick={() => void publish()}>
              {busy ? 'Working…' : 'Save and publish'}
            </button>
            {workflow.status === 'enabled' ? (
              <button type="button" className={buttonClass} disabled={busy || reason.code === ''} onClick={() => void changeStatus('disabled')}>
                Turn off
              </button>
            ) : null}
            {workflow.status === 'disabled' ? (
              <button type="button" className={buttonClass} disabled={busy || reason.code === ''} onClick={() => void changeStatus('enabled')}>
                Turn on
              </button>
            ) : null}
            <button type="button" className={dangerButtonClass} disabled={busy || reason.code === ''} onClick={() => void changeStatus('retired')}>
              Retire
            </button>
          </div>
          {reason.code === '' ? <p className="text-xs text-fg-muted">Choose a reason to enable publishing and status changes.</p> : null}
        </section>
      )}

      <section className={cardClass} aria-labelledby={`${uid}-versions`}>
        <h3 id={`${uid}-versions`} className="text-sm font-bold text-fg-strong">
          Version history
        </h3>
        {workflow.versions.length === 0 ? (
          <p className="mt-2 text-sm text-fg-muted">Nothing published yet.</p>
        ) : (
          <ol className="mt-2 space-y-2">
            {workflow.versions.map((v) => (
              <li key={v.version} className="text-sm text-fg">
                <span className="font-semibold">Version {v.version}</span> · {v.publishedByName} · <When iso={v.publishedAt} />
                {has(v.reason) ? <span className="block text-xs text-fg-muted">{v.reason}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
