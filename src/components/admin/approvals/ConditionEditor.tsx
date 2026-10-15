'use client';

import { useId } from 'react';
import type { TriggerField } from '@/server/kernel/approvals/domain/triggers';
import type { Comparison, ConditionNode } from '@/server/kernel/approvals/domain/types';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import {
  asRoot,
  blankFor,
  comparedField,
  comparisonChoices,
  CONDITION_MATCH,
  emptyToNothing,
  isGroup,
  labelIn,
  listText,
  parseList,
  removeAt,
  replaceAt,
  withComparedField,
  withField,
  withOp,

  type ConditionGroup,
} from '@/lib/approval-forms';
import type { Choice } from '@/lib/payment-options';
import { readText } from '@/lib/values';
import { buttonClass, fieldClass } from './shared';

interface EditorProps {
  value: ConditionNode | undefined;
  onChange: (next: ConditionNode | undefined) => void;
  /** The situation the conditions are about; its fields are what can be compared. */
  trigger: string;
  fields: TriggerField[];
  label: string;
  emptyText: string;
}

/**
 * Builds the "when does this apply?" tree: groups that match ALL or ANY of their rows, and rows
 * that compare one field of the document with a value (or with another field).
 * No conditions at all means "always".
 */
export function ConditionEditor({ value, onChange, trigger, fields, label, emptyText }: EditorProps) {
  const root = asRoot(value);
  const first = fields[0];
  return (
    <div role="group" aria-label={label} className="space-y-3">
      {root === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg-muted">{emptyText}</p>
          {first === undefined ? null : (
            <button type="button" className={buttonClass} onClick={() => onChange({ op: 'and', children: [blankFor(first)] })}>
              Add a condition
            </button>
          )}
        </div>
      ) : (
        <GroupEditor group={root} trigger={trigger} fields={fields} depth={0} onChange={(g) => onChange(emptyToNothing(g))} onRemove={() => onChange(undefined)} />
      )}
    </div>
  );
}

interface GroupProps {
  group: ConditionGroup;
  trigger: string;
  fields: TriggerField[];
  depth: number;
  onChange: (next: ConditionGroup) => void;
  onRemove: () => void;
}

function GroupEditor({ group, trigger, fields, depth, onChange, onRemove }: GroupProps) {
  const set = (children: ConditionNode[]) => onChange({ ...group, children });
  const first = fields[0];
  return (
    <div className={`space-y-2 rounded-lg border border-line p-3 ${depth > 0 ? 'bg-surface-sunken' : ''}`}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48">
          <ChoicePicker
            label="Applies when"
            source="approval-condition-match"
            choice={{ id: group.op, label: labelIn(CONDITION_MATCH, group.op) }}
            onChoice={(c) => onChange({ ...group, op: c?.id === 'or' ? 'or' : 'and' })}
            clearable={false}
          />
        </div>
        <button type="button" className={`${buttonClass} ml-auto`} onClick={onRemove}>
          {depth === 0 ? 'Remove all conditions' : 'Remove group'}
        </button>
      </div>
      <ul className="space-y-2">
        {group.children.map((child, i) => (
          // Conditions have no identity of their own: a row is only its position, and everything in it comes from the value.
          // eslint-disable-next-line react/no-array-index-key
          <li key={i}>
            <ChildEditor child={child} trigger={trigger} fields={fields} depth={depth} onChange={(next) => set(replaceAt(group.children, i, next))} onRemove={() => set(removeAt(group.children, i))} />
          </li>
        ))}
      </ul>
      {first === undefined ? null : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => set([...group.children, blankFor(first)])}>
            Add a condition
          </button>
          {depth < 2 ? (
            <button type="button" className={buttonClass} onClick={() => set([...group.children, { op: 'or', children: [blankFor(first)] }])}>
              Add a group
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface ChildProps {
  child: ConditionNode;
  trigger: string;
  fields: TriggerField[];
  depth: number;
  onChange: (next: ConditionNode) => void;
  onRemove: () => void;
}

/** One entry of a group: another group, a comparison, or a "not" made elsewhere (kept as it is). */
function ChildEditor({ child, trigger, fields, depth, onChange, onRemove }: ChildProps) {
  if (isGroup(child)) {
    return <GroupEditor group={child} trigger={trigger} fields={fields} depth={depth + 1} onChange={onChange} onRemove={onRemove} />;
  }
  if (child.op === 'not') {
    return (
      <p className="text-sm text-fg-muted">
        A “not” condition made elsewhere is kept as it is.{' '}
        <button type="button" className="underline" onClick={onRemove}>
          Remove it
        </button>
      </p>
    );
  }
  return <RowEditor row={child} trigger={trigger} fields={fields} onChange={onChange} onRemove={onRemove} />;
}

interface RowProps {
  row: Comparison;
  trigger: string;
  fields: TriggerField[];
  onChange: (next: Comparison) => void;
  onRemove: () => void;
}

function RowEditor({ row, trigger, fields, onChange, onRemove }: RowProps) {
  const uid = useId();
  const known = fields.find((f) => f.path === row.field);
  const field = known ?? fields[0];
  if (field === undefined) return null;
  const compareFields = fields.filter((f) => f.type === field.type && f.path !== field.path);
  const against = comparedField(row);
  const op = comparisonChoices(field.type).find((c) => c.id === row.op);
  const canCompareField = compareFields.length > 0 && ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(row.op) && field.type !== 'boolean';

  const fieldChoice: Choice = { id: row.field, label: known === undefined ? `${row.field} (not available)` : known.label };
  const yesNo = (v: unknown): Choice => ({ id: v === true ? 'true' : 'false', label: v === true ? 'Yes' : 'No' });

  let valueInput: React.ReactNode;
  if (field.type === 'boolean' || row.op === 'exists') {
    valueInput = (
      <ChoicePicker
        label="Value"
        source="approval-yes-no"
        choice={yesNo('value' in row ? row.value : false)}
        onChoice={(c) => onChange({ ...row, value: c?.id === 'true' } as Comparison)}
        clearable={false}
        hideLabel
      />
    );
  } else if (row.op === 'between') {
    valueInput = (
      <span className="flex items-center gap-2">
        <input type="number" aria-label="From" value={row.value[0]} onChange={(e) => onChange({ ...row, value: [Number(e.target.value), row.value[1]] })} className={`${fieldClass} w-28`} />
        <span className="text-sm text-fg-muted">and</span>
        <input type="number" aria-label="To" value={row.value[1]} onChange={(e) => onChange({ ...row, value: [row.value[0], Number(e.target.value)] })} className={`${fieldClass} w-28`} />
      </span>
    );
  } else if (row.op === 'in' || row.op === 'not_in') {
    valueInput = (
      <input
        aria-label="Values, separated by commas"
        value={listText(row.value)}
        onChange={(e) => onChange({ ...row, value: parseList(e.target.value, field.type === 'number') })}
        placeholder="a, b, c"
        className={`${fieldClass} min-w-40 flex-1`}
      />
    );
  } else if (against !== null) {
    const other = fields.find((f) => f.path === against);
    valueInput = (
      <ChoicePicker
        label="Compare with field"
        source="approval-trigger-fields"
        filters={{ trigger, type: field.type, exclude: field.path }}
        choice={{ id: against, label: other?.label ?? against }}
        onChoice={(c) => onChange({ ...row, value: { field: c?.id ?? against } } as Comparison)}
        clearable={false}
        hideLabel
      />
    );
  } else {
    valueInput = (
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        aria-label="Value"
        value={readText('value' in row ? row.value : '', '')}
        onChange={(e) => onChange({ ...row, value: field.type === 'number' ? Number(e.target.value) : e.target.value } as Comparison)}
        className={`${fieldClass} min-w-32 flex-1`}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-52">
        <ChoicePicker
          label="Field"
          source="approval-trigger-fields"
          filters={{ trigger }}
          choice={fieldChoice}
          onChoice={(c) => {
            const next = fields.find((f) => f.path === c?.id);
            if (next !== undefined) onChange(withField(row, field, next));
          }}
          clearable={false}
          hideLabel
        />
      </div>
      <div className="min-w-44">
        <ChoicePicker
          label="Comparison"
          source="approval-comparisons"
          filters={{ type: field.type }}
          choice={op === undefined ? { id: row.op, label: row.op } : { id: op.id, label: op.label }}
          onChoice={(c) => {
            const picked = comparisonChoices(field.type).find((o) => o.id === c?.id);
            if (picked !== undefined) onChange(withOp(row, picked.id, field.type));
          }}
          clearable={false}
          hideLabel
        />
      </div>
      {valueInput}
      {canCompareField ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-1.5 text-xs text-fg" htmlFor={`${uid}-f`}>
          <input
            type="checkbox"
            className="size-4"
            checked={against !== null}
            onChange={(e) => onChange(withComparedField(row, e.target.checked, field.type, compareFields[0]?.path))}
            id={`${uid}-f`}
          />
          another field
        </label>
      ) : null}
      <button type="button" className={buttonClass} onClick={onRemove} aria-label={`Remove condition on ${field.label}`}>
        Remove
      </button>
    </div>
  );
}

