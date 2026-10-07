'use client';

import { useId } from 'react';
import type { TriggerField } from '@/server/kernel/approvals/domain/triggers';
import type { Comparison, ConditionNode } from '@/server/kernel/approvals/domain/types';
import { buttonClass, fieldClass } from './shared';

type Group = { op: 'and' | 'or'; children: ConditionNode[] };

const isGroup = (n: ConditionNode): n is Group => n.op === 'and' || n.op === 'or';

const OPS: Record<TriggerField['type'], Array<[Comparison['op'], string]>> = {
  number: [
    ['gt', 'is more than'],
    ['gte', 'is at least'],
    ['lt', 'is less than'],
    ['lte', 'is at most'],
    ['eq', 'is exactly'],
    ['ne', 'is not'],
    ['between', 'is between'],
  ],
  text: [
    ['eq', 'is'],
    ['ne', 'is not'],
    ['in', 'is one of'],
    ['not_in', 'is none of'],
    ['contains', 'contains'],
    ['exists', 'is filled in'],
  ],
  boolean: [
    ['eq', 'is'],
    ['ne', 'is not'],
  ],
};

function blankFor(field: TriggerField): Comparison {
  if (field.type === 'boolean') return { op: 'eq', field: field.path, value: true };
  if (field.type === 'number') return { op: 'gt', field: field.path, value: 0 };
  return { op: 'eq', field: field.path, value: '' };
}

const list = (value: unknown) => (Array.isArray(value) ? value.join(', ') : '');
const parseList = (text: string, numeric: boolean) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => (numeric && Number.isFinite(Number(t)) ? Number(t) : t));

/**
 * Builds the "when does this apply?" tree: groups that match ALL or ANY of their rows, and rows
 * that compare one field of the document with a value (or with another field).
 * No conditions at all means "always".
 */
export function ConditionEditor({
  value,
  onChange,
  fields,
  label,
  emptyText,
}: {
  value: ConditionNode | undefined;
  onChange: (next: ConditionNode | undefined) => void;
  fields: TriggerField[];
  label: string;
  emptyText: string;
}) {
  const root: Group | null =
    value === undefined ? null : isGroup(value) ? value : { op: 'and', children: [value] };
  return (
    <div role="group" aria-label={label} className="space-y-3">
      {root === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg-muted">{emptyText}</p>
          <button
            type="button"
            className={buttonClass}
            onClick={() => onChange({ op: 'and', children: [blankFor(fields[0]!)] })}
          >
            Add a condition
          </button>
        </div>
      ) : (
        <GroupEditor
          group={root}
          fields={fields}
          depth={0}
          onChange={(g) => onChange(g.children.length === 0 ? undefined : g)}
          onRemove={() => onChange(undefined)}
        />
      )}
    </div>
  );
}

function GroupEditor({
  group,
  fields,
  depth,
  onChange,
  onRemove,
}: {
  group: Group;
  fields: TriggerField[];
  depth: number;
  onChange: (next: Group) => void;
  onRemove: () => void;
}) {
  const uid = useId();
  const set = (children: ConditionNode[]) => onChange({ ...group, children });
  return (
    <div
      className={`space-y-2 rounded-lg border border-line p-3 ${depth > 0 ? 'bg-surface-sunken' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${uid}-op`} className="text-sm text-fg">
          Applies when
        </label>
        <select
          id={`${uid}-op`}
          value={group.op}
          onChange={(e) => onChange({ ...group, op: e.target.value as 'and' | 'or' })}
          className={`${fieldClass} w-auto`}
        >
          <option value="and">all of these are true</option>
          <option value="or">any of these is true</option>
        </select>
        <button type="button" className={`${buttonClass} ml-auto`} onClick={onRemove}>
          {depth === 0 ? 'Remove all conditions' : 'Remove group'}
        </button>
      </div>
      <ul className="space-y-2">
        {group.children.map((child, i) => (
          <li key={i}>
            {isGroup(child) ? (
              <GroupEditor
                group={child}
                fields={fields}
                depth={depth + 1}
                onChange={(g) => set(group.children.map((c, j) => (j === i ? g : c)))}
                onRemove={() => set(group.children.filter((_, j) => j !== i))}
              />
            ) : child.op === 'not' ? (
              <p className="text-sm text-fg-muted">
                A “not” condition made elsewhere is kept as it is.{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => set(group.children.filter((_, j) => j !== i))}
                >
                  Remove it
                </button>
              </p>
            ) : (
              <RowEditor
                row={child}
                fields={fields}
                onChange={(r) => set(group.children.map((c, j) => (j === i ? r : c)))}
                onRemove={() => set(group.children.filter((_, j) => j !== i))}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          onClick={() => set([...group.children, blankFor(fields[0]!)])}
        >
          Add a condition
        </button>
        {depth < 2 ? (
          <button
            type="button"
            className={buttonClass}
            onClick={() => set([...group.children, { op: 'or', children: [blankFor(fields[0]!)] }])}
          >
            Add a group
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RowEditor({
  row,
  fields,
  onChange,
  onRemove,
}: {
  row: Comparison;
  fields: TriggerField[];
  onChange: (next: Comparison) => void;
  onRemove: () => void;
}) {
  const uid = useId();
  const field = fields.find((f) => f.path === row.field) ?? fields[0]!;
  const unknown = !fields.some((f) => f.path === row.field);
  const ops = OPS[field.type];
  const compareFields = fields.filter((f) => f.type === field.type && f.path !== field.path);
  const against =
    'value' in row &&
    row.value !== null &&
    typeof row.value === 'object' &&
    !Array.isArray(row.value)
      ? (row.value as { field: string }).field
      : null;

  const changeField = (path: string) => {
    const next = fields.find((f) => f.path === path)!;
    // A new field may not support the old operator or value type, so start that row afresh.
    onChange(
      next.type === field.type && ops.some(([o]) => o === row.op)
        ? { ...row, field: path }
        : blankFor(next),
    );
  };
  const changeOp = (op: Comparison['op']) => {
    const f = row.field;
    if (op === 'between') onChange({ op, field: f, value: [0, 0] });
    else if (op === 'in' || op === 'not_in') onChange({ op, field: f, value: [] });
    else if (op === 'exists') onChange({ op, field: f, value: true });
    else if (op === 'contains') onChange({ op, field: f, value: '' });
    else {
      const keep =
        'value' in row && !Array.isArray(row.value)
          ? (row.value as never)
          : field.type === 'number'
            ? 0
            : '';
      onChange({ op, field: f, value: keep } as Comparison);
    }
  };

  let valueInput: React.ReactNode;
  if (field.type === 'boolean') {
    valueInput = (
      <select
        aria-label="Value"
        value={String((row as { value: unknown }).value === true)}
        onChange={(e) => onChange({ ...row, value: e.target.value === 'true' } as Comparison)}
        className={`${fieldClass} w-auto`}
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  } else if (row.op === 'exists') {
    valueInput = (
      <select
        aria-label="Value"
        value={String(row.value)}
        onChange={(e) => onChange({ ...row, value: e.target.value === 'true' })}
        className={`${fieldClass} w-auto`}
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  } else if (row.op === 'between') {
    valueInput = (
      <span className="flex items-center gap-2">
        <input
          type="number"
          aria-label="From"
          value={row.value[0]}
          onChange={(e) => onChange({ ...row, value: [Number(e.target.value), row.value[1]] })}
          className={`${fieldClass} w-28`}
        />
        <span className="text-sm text-fg-muted">and</span>
        <input
          type="number"
          aria-label="To"
          value={row.value[1]}
          onChange={(e) => onChange({ ...row, value: [row.value[0], Number(e.target.value)] })}
          className={`${fieldClass} w-28`}
        />
      </span>
    );
  } else if (row.op === 'in' || row.op === 'not_in') {
    valueInput = (
      <input
        type="text"
        aria-label="Values, separated by commas"
        placeholder="a, b, c"
        defaultValue={list(row.value)}
        onBlur={(e) =>
          onChange({ ...row, value: parseList(e.target.value, field.type === 'number') })
        }
        className={`${fieldClass} min-w-40 flex-1`}
      />
    );
  } else if (against !== null) {
    valueInput = (
      <select
        aria-label="Compare with field"
        value={against}
        onChange={(e) => onChange({ ...row, value: { field: e.target.value } } as Comparison)}
        className={`${fieldClass} w-auto`}
      >
        {compareFields.map((f) => (
          <option key={f.path} value={f.path}>
            {f.label}
          </option>
        ))}
      </select>
    );
  } else {
    valueInput = (
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        aria-label="Value"
        value={String((row as { value: unknown }).value ?? '')}
        onChange={(e) =>
          onChange({
            ...row,
            value: field.type === 'number' ? Number(e.target.value) : e.target.value,
          } as Comparison)
        }
        className={`${fieldClass} min-w-32 flex-1`}
      />
    );
  }

  const canCompareField =
    compareFields.length > 0 &&
    ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(row.op) &&
    field.type !== 'boolean';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Field"
        value={field.path}
        onChange={(e) => changeField(e.target.value)}
        className={`${fieldClass} w-auto max-w-full`}
      >
        {unknown ? <option value={row.field}>{row.field} (not available)</option> : null}
        {fields.map((f) => (
          <option key={f.path} value={f.path}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Comparison"
        value={row.op}
        onChange={(e) => changeOp(e.target.value as Comparison['op'])}
        className={`${fieldClass} w-auto`}
      >
        {ops.map(([o, text]) => (
          <option key={o} value={o}>
            {text}
          </option>
        ))}
      </select>
      {valueInput}
      {canCompareField ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-1.5 text-xs text-fg">
          <input
            type="checkbox"
            className="size-4"
            checked={against !== null}
            onChange={(e) =>
              onChange({
                ...row,
                value: e.target.checked
                  ? { field: compareFields[0]!.path }
                  : field.type === 'number'
                    ? 0
                    : '',
              } as Comparison)
            }
            id={`${uid}-f`}
          />
          another field
        </label>
      ) : null}
      <button
        type="button"
        className={buttonClass}
        onClick={onRemove}
        aria-label={`Remove condition on ${field.label}`}
      >
        Remove
      </button>
    </div>
  );
}
