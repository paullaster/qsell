'use client';

import { useId } from 'react';
import type { DefinitionIssue } from '@/server/kernel/approvals/domain/definition';
import type { TriggerField } from '@/server/kernel/approvals/domain/triggers';
import type { ApproverRule, StepDefinition } from '@/server/kernel/approvals/domain/types';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { GROUP_QUORUM, labelIn, RULE_TYPES, ruleOfType } from '@/lib/approval-forms';
import type { Choice } from '@/lib/payment-options';
import { ConditionEditor } from './ConditionEditor';
import { buttonClass, cardClass, fieldClass, labelClass } from './shared';

export function IssueList({ title, issues }: { title: string; issues: DefinitionIssue[] }) {
  return (
    <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
      <p className="text-sm font-semibold text-red-700">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-red-700">
        {issues.map((x) => (
          <li key={`${x.path}-${x.message}`}>{x.message}</li>
        ))}
      </ul>
    </div>
  );
}

interface Props {
  step: StepDefinition;
  index: number;
  count: number;
  issues: DefinitionIssue[];
  trigger: string;
  fields: TriggerField[];
  /** The words for the people, groups and roles the workflow already names, keyed "user:id" and so on. */
  labels: Record<string, string>;
  remember: (key: string, label: string) => void;
  disabled: boolean;
  onChange: (next: StepDefinition) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

const choiceFor = (labels: Record<string, string>, key: string, id: string): Choice | null => (id === '' ? null : { id, label: labels[key] ?? id });

export function StepCard({ step, index, count, issues, trigger, fields, labels, remember, disabled, onChange, onMove, onRemove }: Props) {
  const uid = useId();
  const rule = step.approver;
  const help = RULE_TYPES.find((t) => t.id === rule.type)?.help;
  const setRule = (approver: ApproverRule) => onChange({ ...step, approver });

  return (
    <div className={`${cardClass} space-y-4`} role="group" aria-label={`Step ${String(index + 1)}: ${step.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white" aria-hidden="true">
          {index + 1}
        </span>
        <div className="min-w-40 flex-1">
          <label htmlFor={`${uid}-n`} className="sr-only">
            Step name
          </label>
          <input id={`${uid}-n`} value={step.name} onChange={(e) => onChange({ ...step, name: e.target.value })} className={fieldClass} disabled={disabled} />
        </div>
        <button type="button" className={buttonClass} disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label={`Move step ${String(index + 1)} up`}>
          ↑
        </button>
        <button type="button" className={buttonClass} disabled={disabled || index === count - 1} onClick={() => onMove(1)} aria-label={`Move step ${String(index + 1)} down`}>
          ↓
        </button>
        <button type="button" className={buttonClass} disabled={disabled} onClick={onRemove} aria-label={`Remove step ${String(index + 1)}`}>
          Remove
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <ChoicePicker
            label="Who approves"
            source="approval-rule-types"
            choice={{ id: rule.type, label: labelIn(RULE_TYPES, rule.type) }}
            onChoice={(c) => {
              const picked = RULE_TYPES.find((t) => t.id === c?.id);
              if (picked !== undefined) setRule(ruleOfType(picked.id));
            }}
            clearable={false}
            disabled={disabled}
          />
          {help === undefined ? null : <p className="mt-1 text-xs text-fg-muted">{help}</p>}
        </div>

        {rule.type === 'user' ? (
          <div className="sm:col-span-2">
            <ChoicePicker
              label="Person"
              source="approval-users"
              choice={choiceFor(labels, `user:${rule.userId}`, rule.userId)}
              onChoice={(c) => {
                if (c !== null) remember(`user:${c.id}`, c.label);
                setRule({ type: 'user', userId: c?.id ?? '' });
              }}
              placeholder="Choose a person…"
              disabled={disabled}
              required
            />
          </div>
        ) : null}

        {rule.type === 'group' ? (
          <>
            <ChoicePicker
              label="Group"
              source="approval-groups"
              choice={choiceFor(labels, `group:${rule.groupId}`, rule.groupId)}
              onChoice={(c) => {
                if (c !== null) remember(`group:${c.id}`, c.label);
                setRule({ ...rule, groupId: c?.id ?? '' });
              }}
              placeholder="Choose a group…"
              disabled={disabled}
              required
            />
            <ChoicePicker
              label="Who in the group"
              source="approval-group-quorum"
              choice={{ id: rule.require, label: labelIn(GROUP_QUORUM, rule.require) }}
              onChoice={(c) => {
                const picked = GROUP_QUORUM.find((q) => q.id === c?.id);
                if (picked !== undefined) setRule({ ...rule, require: picked.id });
              }}
              clearable={false}
              disabled={disabled}
            />
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
                  onChange={(e) => setRule({ ...rule, count: e.target.value === '' ? undefined : Number(e.target.value) })}
                  className={fieldClass}
                  disabled={disabled}
                />
              </div>
            ) : null}
          </>
        ) : null}

        {rule.type === 'role' ? (
          <div className="sm:col-span-2">
            <ChoicePicker
              label="Role"
              source="approval-roles"
              choice={choiceFor(labels, `role:${rule.roleKey}`, rule.roleKey)}
              onChoice={(c) => {
                if (c !== null) remember(`role:${c.id}`, c.label);
                setRule({ type: 'role', roleKey: c?.id ?? '' });
              }}
              placeholder="Choose a role…"
              disabled={disabled}
              required
            />
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
            onChange={(e) => onChange({ ...step, dueAfterHours: e.target.value === '' ? undefined : Number(e.target.value) })}
            className={fieldClass}
            disabled={disabled}
          />
          <p className="mt-1 text-xs text-fg-muted">An overdue request is handed to the approver’s own approver, checked every five minutes.</p>
        </div>
        <div className="flex items-end">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="size-4" checked={step.allowSelfApproval === true} onChange={(e) => onChange({ ...step, allowSelfApproval: e.target.checked })} disabled={disabled} />
            Let people approve their own requests
          </label>
        </div>

        <div className="sm:col-span-2">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="size-4"
              checked={step.skipIf !== undefined}
              onChange={(e) => onChange({ ...step, skipIf: e.target.checked ? { op: 'lt', field: 'amount', value: 0 } : undefined })}
              disabled={disabled}
            />
            Skip this step in some cases
          </label>
          {step.skipIf === undefined ? null : (
            <div className="mt-2">
              <ConditionEditor value={step.skipIf} onChange={(c) => onChange({ ...step, skipIf: c })} trigger={trigger} fields={fields} label={`Skip step ${String(index + 1)} when`} emptyText="Never skipped." />
            </div>
          )}
        </div>
      </div>
      {issues.length > 0 ? <IssueList title="This step has a problem" issues={issues} /> : null}
    </div>
  );
}
