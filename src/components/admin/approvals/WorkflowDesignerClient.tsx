'use client';

import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  listConfigReasonsAction,
  publishWorkflowAction,
  saveWorkflowDraftAction,
  setWorkflowStatusAction,
  simulateAction,
  updateWorkflowMetaAction,
  type Lookups,
  type SimulationView,
  type WorkflowDetail,
} from '@/server/kernel/approvals/actions';
import type { DefinitionIssue } from '@/server/kernel/approvals/domain/definition';
import { MODULE_LABELS, triggerByCode } from '@/server/kernel/approvals/domain/triggers';
import type {
  ApproverRule,
  StepDefinition,
  WorkflowDefinition,
} from '@/server/kernel/approvals/domain/types';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import { ConditionEditor } from './ConditionEditor';
import {
  Chip,
  Notice,
  PageHeader,
  StatusChip,
  When,
  buttonClass,
  cardClass,
  dangerButtonClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from './shared';

const RULES: Array<[ApproverRule['type'], string, string]> = [
  ['user', 'A specific person', 'The same person approves every time.'],
  [
    'group',
    'A group of people',
    'Everyone in order, whoever responds first, or a set number of them.',
  ],
  [
    'role',
    'Everyone who holds a role',
    'Everyone with the role is asked at once, and the first to respond decides.',
  ],
  [
    'owner_approver',
    'The requester’s own approver',
    'Whoever is set above the person who submitted it.',
  ],
  [
    'chain_by_limit',
    'Up the approval chain, level by level',
    'Starts with the requester’s approver and goes up until someone’s limit covers the amount. Every level approves.',
  ],
  [
    'first_qualified',
    'The first person up the chain who can cover it',
    'Skips straight to the first person whose limit covers the amount, and asks only them.',
  ],
];

function blankStep(sequence: number): StepDefinition {
  return { sequence, name: `Step ${sequence}`, approver: { type: 'owner_approver' } };
}

const renumber = (steps: StepDefinition[]): StepDefinition[] =>
  steps.map((s, i) => ({ ...s, sequence: i + 1 }));

export function WorkflowDesignerClient({
  workflow,
  lookups,
}: {
  workflow: WorkflowDetail;
  lookups: Lookups;
}) {
  const uid = useId();
  const router = useRouter();
  const trigger = triggerByCode(workflow.triggerCode)!;
  const [meta, setMeta] = useState({
    name: workflow.name,
    description: workflow.description ?? '',
    priority: workflow.priority,
    branchId: workflow.branchId ?? '',
  });
  const [def, setDef] = useState<WorkflowDefinition>(workflow.draft);
  const [savedSnapshot, setSavedSnapshot] = useState(JSON.stringify({ meta, def }));
  const [issues, setIssues] = useState<DefinitionIssue[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });

  const dirty = JSON.stringify({ meta, def }) !== savedSnapshot;
  const setStep = (i: number, next: StepDefinition) =>
    setDef({ ...def, steps: def.steps.map((s, j) => (j === i ? next : s)) });
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= def.steps.length) return;
    const steps = [...def.steps];
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    setDef({ ...def, steps: renumber(steps) });
  };

  const saveAll = async (): Promise<'failed' | 'issues' | 'clean'> => {
    const m = await updateWorkflowMetaAction(workflow.id, {
      name: meta.name,
      description: meta.description,
      priority: Number(meta.priority) || 100,
      branchId: meta.branchId || null,
    });
    if (!m.ok) {
      setMessage({ kind: 'error', text: m.error });
      return 'failed';
    }
    const d = await saveWorkflowDraftAction(workflow.id, def);
    if (!d.ok) {
      setMessage({ kind: 'error', text: d.error });
      return 'failed';
    }
    setIssues(d.data.issues);
    setSavedSnapshot(JSON.stringify({ meta, def }));
    return d.data.issues.length === 0 ? 'clean' : 'issues';
  };

  const saveDraft = async () => {
    setBusy(true);
    setMessage(null);
    const state = await saveAll();
    setBusy(false);
    if (state === 'clean')
      setMessage({ kind: 'ok', text: 'Draft saved. It is not live until you publish it.' });
    if (state === 'issues')
      setMessage({
        kind: 'error',
        text: 'Draft saved, but it has problems that must be fixed before it can be published.',
      });
    router.refresh();
  };

  const publish = async () => {
    setBusy(true);
    setMessage(null);
    const state = await saveAll();
    if (state !== 'clean') {
      setBusy(false);
      if (state === 'issues')
        setMessage({ kind: 'error', text: 'Fix the problems listed below, then publish.' });
      return;
    }
    const res = await publishWorkflowAction(workflow.id, reason);
    setBusy(false);
    if (!res.ok) {
      if (res.issues) setIssues(res.issues);
      return setMessage({ kind: 'error', text: res.error });
    }
    setReason({ code: '', text: '' });
    setMessage({
      kind: 'ok',
      text: `Published as version ${res.data.version}. Requests already waiting keep the version they started with.`,
    });
    router.refresh();
  };

  const changeStatus = async (status: 'enabled' | 'disabled' | 'retired') => {
    setBusy(true);
    setMessage(null);
    const res = await setWorkflowStatusAction(workflow.id, status, reason);
    setBusy(false);
    if (!res.ok) return setMessage({ kind: 'error', text: res.error });
    setReason({ code: '', text: '' });
    setMessage({
      kind: 'ok',
      text:
        status === 'enabled'
          ? 'Turned on.'
          : status === 'disabled'
            ? 'Turned off. New documents will not use it; requests already waiting continue.'
            : 'Retired.',
    });
    router.refresh();
  };

  const stepIssues = (i: number) =>
    issues.filter((x) => x.path === `steps[${i}]` || x.path.startsWith(`steps[${i}].`));
  const generalIssues = issues.filter((x) => !/^steps\[\d+\]/.test(x.path));
  const retired = workflow.status === 'retired';

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={meta.name || workflow.code}
        actions={
          <Link href="/admin/settings/approvals/workflows" className={buttonClass}>
            All workflows
          </Link>
        }
      >
        <span className="font-mono">{workflow.code}</span> ·{' '}
        {MODULE_LABELS[trigger.module] ?? trigger.module} · {trigger.label}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={workflow.status} />
        {dirty ? <Chip tone="amber">Unsaved changes</Chip> : null}
        {workflow.versions[0] ? (
          <Chip tone="grey">Live version {workflow.versions[0].version}</Chip>
        ) : (
          <Chip tone="grey">Never published</Chip>
        )}
      </div>

      <Notice message={message} />

      {generalIssues.length > 0 ? (
        <IssueList title="Fix before publishing" issues={generalIssues} />
      ) : null}

      <section className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-details`}>
        <h3 id={`${uid}-details`} className="text-sm font-bold text-fg-strong">
          Details
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-name`} className={labelClass}>
              Name
            </label>
            <input
              id={`${uid}-name`}
              value={meta.name}
              onChange={(e) => setMeta({ ...meta, name: e.target.value })}
              className={fieldClass}
              disabled={retired}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-branch`} className={labelClass}>
              Branch
            </label>
            <select
              id={`${uid}-branch`}
              value={meta.branchId}
              onChange={(e) => setMeta({ ...meta, branchId: e.target.value })}
              className={fieldClass}
              disabled={retired}
            >
              <option value="">All branches</option>
              {lookups.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-desc`} className={labelClass}>
              What is this for?
            </label>
            <input
              id={`${uid}-desc`}
              value={meta.description}
              onChange={(e) => setMeta({ ...meta, description: e.target.value })}
              className={fieldClass}
              disabled={retired}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-prio`} className={labelClass}>
              Order (lower is asked first)
            </label>
            <input
              id={`${uid}-prio`}
              type="number"
              value={meta.priority}
              onChange={(e) => setMeta({ ...meta, priority: Number(e.target.value) })}
              className={fieldClass}
              disabled={retired}
            />
          </div>
        </div>
      </section>

      <section className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-when`}>
        <h3 id={`${uid}-when`} className="text-sm font-bold text-fg-strong">
          When does it apply?
        </h3>
        <ConditionEditor
          value={def.conditions}
          onChange={(c) => setDef({ ...def, conditions: c })}
          fields={trigger.fields}
          label="When this workflow applies"
          emptyText="It applies to every document of this kind."
        />
      </section>

      <section className="space-y-3" aria-labelledby={`${uid}-steps`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${uid}-steps`} className="text-sm font-bold text-fg-strong">
            Who approves, in order
          </h3>
          <button
            type="button"
            className={buttonClass}
            disabled={retired}
            onClick={() =>
              setDef({ ...def, steps: renumber([...def.steps, blankStep(def.steps.length + 1)]) })
            }
          >
            Add a step
          </button>
        </div>
        {def.steps.length === 0 ? (
          <p className="text-sm text-fg-muted">No steps yet. Add the first approval step.</p>
        ) : (
          <ol className="space-y-3">
            {def.steps.map((step, i) => (
              <li key={i}>
                <StepCard
                  step={step}
                  index={i}
                  count={def.steps.length}
                  issues={stepIssues(i)}
                  lookups={lookups}
                  fields={trigger.fields}
                  disabled={retired}
                  onChange={(s) => setStep(i, s)}
                  onMove={(by) => move(i, by)}
                  onRemove={() =>
                    setDef({ ...def, steps: renumber(def.steps.filter((_, j) => j !== i)) })
                  }
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      <TestPanel workflow={workflow} def={def} lookups={lookups} />

      {!retired ? (
        <section className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-publish`}>
          <h3 id={`${uid}-publish`} className="text-sm font-bold text-fg-strong">
            Save and publish
          </h3>
          <p className="text-sm text-fg-muted">
            Saving keeps your work as a draft. Publishing makes it live for new documents as a new
            version; requests already waiting finish under the version they started with.
          </p>
          <ReasonField value={reason} onChange={setReason} load={listConfigReasonsAction} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy || !dirty}
              onClick={saveDraft}
            >
              Save draft
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={busy || reason.code === ''}
              onClick={publish}
            >
              {busy ? 'Working…' : 'Save and publish'}
            </button>
            {workflow.status === 'enabled' ? (
              <button
                type="button"
                className={buttonClass}
                disabled={busy || reason.code === ''}
                onClick={() => changeStatus('disabled')}
              >
                Turn off
              </button>
            ) : null}
            {workflow.status === 'disabled' ? (
              <button
                type="button"
                className={buttonClass}
                disabled={busy || reason.code === ''}
                onClick={() => changeStatus('enabled')}
              >
                Turn on
              </button>
            ) : null}
            <button
              type="button"
              className={dangerButtonClass}
              disabled={busy || reason.code === ''}
              onClick={() => changeStatus('retired')}
            >
              Retire
            </button>
          </div>
          {reason.code === '' ? (
            <p className="text-xs text-fg-muted">
              Choose a reason to enable publishing and status changes.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className={`${cardClass}`} aria-labelledby={`${uid}-versions`}>
        <h3 id={`${uid}-versions`} className="text-sm font-bold text-fg-strong">
          Version history
        </h3>
        {workflow.versions.length === 0 ? (
          <p className="mt-2 text-sm text-fg-muted">Nothing published yet.</p>
        ) : (
          <ol className="mt-2 space-y-2">
            {workflow.versions.map((v) => (
              <li key={v.version} className="text-sm text-fg">
                <span className="font-semibold">Version {v.version}</span> · {v.publishedByName} ·{' '}
                <When iso={v.publishedAt} />
                {v.reason ? <span className="block text-xs text-fg-muted">{v.reason}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function IssueList({ title, issues }: { title: string; issues: DefinitionIssue[] }) {
  return (
    <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
      <p className="text-sm font-semibold text-red-700">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-red-700">
        {issues.map((x, i) => (
          <li key={i}>{x.message}</li>
        ))}
      </ul>
    </div>
  );
}

function StepCard({
  step,
  index,
  count,
  issues,
  lookups,
  fields,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  step: StepDefinition;
  index: number;
  count: number;
  issues: DefinitionIssue[];
  lookups: Lookups;
  fields: Lookups['triggers'][number]['fields'];
  disabled: boolean;
  onChange: (next: StepDefinition) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const uid = useId();
  const rule = step.approver;
  const help = RULES.find(([t]) => t === rule.type)?.[2];

  const setRule = (type: ApproverRule['type']) => {
    const next: ApproverRule =
      type === 'user'
        ? { type, userId: '' }
        : type === 'group'
          ? { type, groupId: '', require: 'all' }
          : type === 'role'
            ? { type, roleKey: '' }
            : ({ type } as ApproverRule);
    onChange({ ...step, approver: next });
  };

  return (
    <div
      className={`${cardClass} space-y-4`}
      role="group"
      aria-label={`Step ${index + 1}: ${step.name}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white"
          aria-hidden="true"
        >
          {index + 1}
        </span>
        <div className="min-w-40 flex-1">
          <label htmlFor={`${uid}-n`} className="sr-only">
            Step name
          </label>
          <input
            id={`${uid}-n`}
            value={step.name}
            onChange={(e) => onChange({ ...step, name: e.target.value })}
            className={fieldClass}
            disabled={disabled}
          />
        </div>
        <button
          type="button"
          className={buttonClass}
          disabled={disabled || index === 0}
          onClick={() => onMove(-1)}
          aria-label={`Move step ${index + 1} up`}
        >
          ↑
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={disabled || index === count - 1}
          onClick={() => onMove(1)}
          aria-label={`Move step ${index + 1} down`}
        >
          ↓
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={disabled}
          onClick={onRemove}
          aria-label={`Remove step ${index + 1}`}
        >
          Remove
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-r`} className={labelClass}>
            Who approves
          </label>
          <select
            id={`${uid}-r`}
            value={rule.type}
            onChange={(e) => setRule(e.target.value as ApproverRule['type'])}
            className={fieldClass}
            disabled={disabled}
          >
            {RULES.map(([t, label]) => (
              <option key={t} value={t}>
                {label}
              </option>
            ))}
          </select>
          {help ? <p className="mt-1 text-xs text-fg-muted">{help}</p> : null}
        </div>

        {rule.type === 'user' ? (
          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-u`} className={labelClass}>
              Person
            </label>
            <select
              id={`${uid}-u`}
              value={rule.userId}
              onChange={(e) =>
                onChange({ ...step, approver: { type: 'user', userId: e.target.value } })
              }
              className={fieldClass}
              disabled={disabled}
            >
              <option value="">Choose a person…</option>
              {lookups.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {rule.type === 'group' ? (
          <>
            <div>
              <label htmlFor={`${uid}-g`} className={labelClass}>
                Group
              </label>
              <select
                id={`${uid}-g`}
                value={rule.groupId}
                onChange={(e) =>
                  onChange({ ...step, approver: { ...rule, groupId: e.target.value } })
                }
                className={fieldClass}
                disabled={disabled}
              >
                <option value="">Choose a group…</option>
                {lookups.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.memberIds.length})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-q`} className={labelClass}>
                Who in the group
              </label>
              <select
                id={`${uid}-q`}
                value={rule.require}
                onChange={(e) =>
                  onChange({
                    ...step,
                    approver: { ...rule, require: e.target.value as 'all' | 'any_one' },
                  })
                }
                className={fieldClass}
                disabled={disabled}
              >
                <option value="all">Everyone, one after another</option>
                <option value="any_one">Anyone: the first to respond decides</option>
                <option value="n_of">A number of them: all are asked, enough must approve</option>
              </select>
            </div>
            {rule.require === 'n_of' ? (
              <div>
                <label htmlFor={`${uid}-cnt`} className={labelClass}>
                  How many must approve
                </label>
                <input
                  id={`${uid}-cnt`}
                  type="number"
                  min={1}
                  value={rule.count ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...step,
                      approver: {
                        ...rule,
                        count: e.target.value === '' ? undefined : Number(e.target.value),
                      },
                    })
                  }
                  className={fieldClass}
                  disabled={disabled}
                />
              </div>
            ) : null}
          </>
        ) : null}

        {rule.type === 'role' ? (
          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-role`} className={labelClass}>
              Role
            </label>
            <select
              id={`${uid}-role`}
              value={rule.roleKey}
              onChange={(e) =>
                onChange({ ...step, approver: { type: 'role', roleKey: e.target.value } })
              }
              className={fieldClass}
              disabled={disabled}
            >
              <option value="">Choose a role…</option>
              {lookups.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label htmlFor={`${uid}-d`} className={labelClass}>
            Overdue after (hours, optional)
          </label>
          <input
            id={`${uid}-d`}
            type="number"
            min={1}
            value={step.dueAfterHours ?? ''}
            onChange={(e) =>
              onChange({
                ...step,
                dueAfterHours: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className={fieldClass}
            disabled={disabled}
          />
          <p className="mt-1 text-xs text-fg-muted">
            An overdue request is handed to the approver’s own approver, checked every five minutes.
          </p>
        </div>
        <div className="flex items-end">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="size-4"
              checked={step.allowSelfApproval === true}
              onChange={(e) => onChange({ ...step, allowSelfApproval: e.target.checked })}
              disabled={disabled}
            />
            Let people approve their own requests
          </label>
        </div>

        <div className="sm:col-span-2">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="size-4"
              checked={step.skipIf !== undefined}
              onChange={(e) =>
                onChange({
                  ...step,
                  skipIf: e.target.checked ? { op: 'lt', field: 'amount', value: 0 } : undefined,
                })
              }
              disabled={disabled}
            />
            Skip this step in some cases
          </label>
          {step.skipIf ? (
            <div className="mt-2">
              <ConditionEditor
                value={step.skipIf}
                onChange={(c) => onChange({ ...step, skipIf: c })}
                fields={fields}
                label={`Skip step ${index + 1} when`}
                emptyText="Never skipped."
              />
            </div>
          ) : null}
        </div>
      </div>
      {issues.length > 0 ? <IssueList title="This step has a problem" issues={issues} /> : null}
    </div>
  );
}

function TestPanel({
  workflow,
  def,
  lookups,
}: {
  workflow: WorkflowDetail;
  def: WorkflowDefinition;
  lookups: Lookups;
}) {
  const uid = useId();
  const trigger = triggerByCode(workflow.triggerCode)!;
  const extra = useMemo(
    () => trigger.fields.filter((f) => !['amount', 'branchId', 'requestedBy'].includes(f.path)),
    [trigger],
  );
  const [amount, setAmount] = useState(100000);
  const [requester, setRequester] = useState(lookups.users[0]?.id ?? '');
  const [branchId, setBranchId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [onlyDraft, setOnlyDraft] = useState(true);
  const [result, setResult] = useState<SimulationView | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const facts = () => {
    const out: Record<string, unknown> = {};
    for (const f of extra) {
      const raw = values[f.path];
      if (raw === undefined || raw === '') continue;
      const v = f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw;
      const parts = f.path.split('.');
      let cur = out;
      parts.slice(0, -1).forEach((p) => {
        cur = (cur[p] ??= {}) as Record<string, unknown>;
      });
      cur[parts.at(-1)!] = v;
    }
    return out;
  };

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await simulateAction({
      trigger: workflow.triggerCode,
      amount,
      requestedBy: requester,
      branchId: branchId || null,
      facts: facts(),
      draft: def,
      onlyDraft,
    });
    setBusy(false);
    if (!res.ok) return setMessage({ kind: 'error', text: res.error });
    setResult(res.data);
  };

  return (
    <section className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-t`}>
      <h3 id={`${uid}-t`} className="text-sm font-bold text-fg-strong">
        Try it on an example
      </h3>
      <p className="text-sm text-fg-muted">
        Nothing is saved or sent. This shows who would be asked, using today’s approvers and limits
        and your draft as it is on screen.
      </p>
      <form onSubmit={run} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor={`${uid}-a`} className={labelClass}>
              Amount (KES)
            </label>
            <input
              id={`${uid}-a`}
              type="number"
              min={0}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-rq`} className={labelClass}>
              Requested by
            </label>
            <select
              id={`${uid}-rq`}
              value={requester}
              onChange={(e) => setRequester(e.target.value)}
              className={fieldClass}
              required
            >
              {lookups.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-br`} className={labelClass}>
              Branch
            </label>
            <select
              id={`${uid}-br`}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className={fieldClass}
            >
              <option value="">Not specified</option>
              {lookups.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          {extra.map((f) => (
            <div key={f.path}>
              <label htmlFor={`${uid}-${f.path}`} className={labelClass}>
                {f.label}
              </label>
              {f.type === 'boolean' ? (
                <select
                  id={`${uid}-${f.path}`}
                  value={values[f.path] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.path]: e.target.value })}
                  className={fieldClass}
                >
                  <option value="">Not set</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <input
                  id={`${uid}-${f.path}`}
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={values[f.path] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.path]: e.target.value })}
                  className={fieldClass}
                />
              )}
            </div>
          ))}
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="size-4"
            checked={onlyDraft}
            onChange={(e) => setOnlyDraft(e.target.checked)}
          />
          Test only this draft (untick to see it alongside the live workflows)
        </label>
        <button type="submit" className={primaryButtonClass} disabled={busy || requester === ''}>
          {busy ? 'Testing…' : 'Test'}
        </button>
      </form>
      <Notice message={message} />
      {result ? (
        <div aria-live="polite" className="space-y-3">
          {!result.enabled ? (
            <p className="text-sm text-amber-700">
              Approvals are switched off for this module, so none of this would be asked.
            </p>
          ) : null}
          {result.workflows.map((w) => (
            <div key={w.code} className="rounded-lg border border-line p-3">
              <p className="text-sm font-semibold text-fg-strong">
                {w.name}
                {w.version ? ` (version ${w.version})` : ''} ·{' '}
                {w.matched ? (
                  <span className="text-emerald-700">applies</span>
                ) : (
                  <span className="text-fg-muted">does not apply</span>
                )}
              </p>
              <details className="mt-1">
                <summary className="min-h-10 cursor-pointer text-xs text-fg-muted">Why</summary>
                <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
                  {w.why.length === 0 ? (
                    <li>No conditions: it always applies.</li>
                  ) : (
                    w.why.map((x, i) => <li key={i}>{x}</li>)
                  )}
                </ul>
              </details>
              {w.matched ? (
                <ol className="mt-2 space-y-1.5">
                  {w.steps.map((s) => (
                    <li key={s.sequence} className="text-sm text-fg">
                      <span className="font-medium">
                        {s.sequence}. {s.name}
                      </span>{' '}
                      {s.skipped ? (
                        <span className="text-fg-muted">skipped for this example</span>
                      ) : s.problem ? (
                        <span role="alert" className="text-red-700">
                          would fail: {s.problem}
                        </span>
                      ) : (
                        <span>→ {s.approvers.join(' → ') || 'nobody'}</span>
                      )}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ))}
          {result.workflows.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No workflow applies, so the document would go ahead without approval.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
