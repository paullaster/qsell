import type { TriggerField } from '@/server/kernel/approvals/domain/triggers';
import type { ApproverRule, Comparison, ConditionNode, StepDefinition } from '@/server/kernel/approvals/domain/types';
import { emptyToNull, has } from '@/lib/values';

/* ── fixed choices (also offered by the server as lookup lists) ───────────────────────────── */

export type LimitMode = 'none' | 'up_to' | 'unlimited';

export const AUTHORITY_MODES: readonly { id: LimitMode; label: string }[] = [
  { id: 'none', label: 'Cannot cover amounts' },
  { id: 'up_to', label: 'Up to…' },
  { id: 'unlimited', label: 'Any amount' },
];

export const RULE_TYPES: readonly { id: ApproverRule['type']; label: string; help: string }[] = [
  { id: 'user', label: 'A specific person', help: 'The same person approves every time.' },
  { id: 'group', label: 'A group of people', help: 'Everyone in order, whoever responds first, or a set number of them.' },
  { id: 'role', label: 'Everyone who holds a role', help: 'Everyone with the role is asked at once, and the first to respond decides.' },
  { id: 'owner_approver', label: 'The requester’s own approver', help: 'Whoever is set above the person who submitted it.' },
  { id: 'chain_by_limit', label: 'Up the approval chain, level by level', help: 'Starts with the requester’s approver and goes up until someone’s limit covers the amount. Every level approves.' },
  { id: 'first_qualified', label: 'The first person up the chain who can cover it', help: 'Skips straight to the first person whose limit covers the amount, and asks only them.' },
];

export const GROUP_QUORUM: readonly { id: 'all' | 'any_one' | 'n_of'; label: string }[] = [
  { id: 'all', label: 'Everyone, one after another' },
  { id: 'any_one', label: 'Anyone: the first to respond decides' },
  { id: 'n_of', label: 'A number of them: all are asked, enough must approve' },
];

export const CONDITION_MATCH: readonly { id: 'and' | 'or'; label: string }[] = [
  { id: 'and', label: 'all of these are true' },
  { id: 'or', label: 'any of these is true' },
];

export const YES_NO: readonly { id: 'true' | 'false'; label: string }[] = [
  { id: 'true', label: 'Yes' },
  { id: 'false', label: 'No' },
];

const OPS: Record<TriggerField['type'], readonly { id: Comparison['op']; label: string }[]> = {
  number: [
    { id: 'gt', label: 'is more than' },
    { id: 'gte', label: 'is at least' },
    { id: 'lt', label: 'is less than' },
    { id: 'lte', label: 'is at most' },
    { id: 'eq', label: 'is exactly' },
    { id: 'ne', label: 'is not' },
    { id: 'between', label: 'is between' },
  ],
  text: [
    { id: 'eq', label: 'is' },
    { id: 'ne', label: 'is not' },
    { id: 'in', label: 'is one of' },
    { id: 'not_in', label: 'is none of' },
    { id: 'contains', label: 'contains' },
    { id: 'exists', label: 'is filled in' },
  ],
  boolean: [
    { id: 'eq', label: 'is' },
    { id: 'ne', label: 'is not' },
  ],
};

export const comparisonChoices = (type: TriggerField['type']): readonly { id: Comparison['op']; label: string }[] => OPS[type];

export const labelIn = (list: readonly { id: string; label: string }[], id: string): string => list.find((c) => c.id === id)?.label ?? id;

/* ── conditions ───────────────────────────────────────────────────────────────────────────── */

export interface ConditionGroup {
  op: 'and' | 'or';
  children: ConditionNode[];
}

export const isGroup = (n: ConditionNode): n is ConditionGroup => n.op === 'and' || n.op === 'or';

/** The condition as a group to edit (a single comparison becomes a group of one); nothing means "always". */
export const asRoot = (value: ConditionNode | undefined): ConditionGroup | null => {
  if (value === undefined) return null;
  return isGroup(value) ? value : { op: 'and', children: [value] };
};

/** The value a fresh comparison on this kind of field starts with. */
const defaultValueFor = (type: TriggerField['type']): number | string => (type === 'number' ? 0 : '');

/** A fact typed in the "try it" form, as the kind of value its field holds. */
function factValue(type: TriggerField['type'], raw: string): unknown {
  if (type === 'number') return Number(raw);
  return type === 'boolean' ? raw === 'true' : raw;
}

export function blankFor(field: TriggerField): Comparison {
  if (field.type === 'boolean') return { op: 'eq', field: field.path, value: true };
  if (field.type === 'number') return { op: 'gt', field: field.path, value: 0 };
  return { op: 'eq', field: field.path, value: '' };
}

export const listText = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : '');

export const parseList = (text: string, numeric: boolean): (string | number)[] =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => (numeric && Number.isFinite(Number(t)) ? Number(t) : t));

/** The field another field is compared with, when the comparison is field-to-field. */
export function comparedField(row: Comparison): string | null {
  if (!('value' in row)) return null;
  const v = row.value;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v.field : null;
}

/** The row after the field it looks at is changed: kept when the new field suits the old comparison, else started afresh. */
export function withField(row: Comparison, current: TriggerField, next: TriggerField): Comparison {
  return next.type === current.type && OPS[current.type].some((o) => o.id === row.op) ? { ...row, field: next.path } : blankFor(next);
}

/** The row after its comparison is changed, with a value that suits the new comparison. */
export function withOp(row: Comparison, op: Comparison['op'], fieldType: TriggerField['type']): Comparison {
  const field = row.field;
  if (op === 'between') return { op, field, value: [0, 0] };
  if (op === 'in' || op === 'not_in') return { op, field, value: [] };
  if (op === 'exists') return { op, field, value: true };
  if (op === 'contains') return { op, field, value: '' };
  const keep = 'value' in row && !Array.isArray(row.value) ? row.value : defaultValueFor(fieldType);
  return { op, field, value: keep };
}

/** The row switched between "a value" and "another field". */
export function withComparedField(row: Comparison, on: boolean, fieldType: TriggerField['type'], otherPath: string | undefined): Comparison {
  const value = on && otherPath !== undefined ? { field: otherPath } : defaultValueFor(fieldType);
  return { ...row, value } as Comparison;
}

export const replaceAt = <T>(items: readonly T[], index: number, next: T): T[] => items.map((x, i) => (i === index ? next : x));
export const removeAt = <T>(items: readonly T[], index: number): T[] => items.filter((_, i) => i !== index);

/** A group with nothing left in it is no condition at all. */
export const emptyToNothing = (group: ConditionGroup): ConditionGroup | undefined => (group.children.length === 0 ? undefined : group);

/* ── workflow steps ───────────────────────────────────────────────────────────────────────── */

export function blankStep(sequence: number): StepDefinition {
  return { sequence, name: `Step ${String(sequence)}`, approver: { type: 'owner_approver' } };
}

export const renumber = (steps: readonly StepDefinition[]): StepDefinition[] => steps.map((s, i) => ({ ...s, sequence: i + 1 }));

export function moveStep(steps: readonly StepDefinition[], index: number, by: -1 | 1): StepDefinition[] {
  const target = index + by;
  const here = steps[index];
  const there = steps[target];
  if (here === undefined || there === undefined) return [...steps];
  const next = [...steps];
  next[index] = there;
  next[target] = here;
  return renumber(next);
}

/** A fresh approver rule of this type, with the fields that type needs empty. */
export function ruleOfType(type: ApproverRule['type']): ApproverRule {
  switch (type) {
    case 'user':
      return { type, userId: '' };
    case 'group':
      return { type, groupId: '', require: 'all' };
    case 'role':
      return { type, roleKey: '' };
    case 'owner_approver':
    case 'chain_by_limit':
    case 'first_qualified':
      return { type };
  }
}

export interface IssueLike {
  path: string;
  message: string;
}

export const issuesOfStep = <T extends IssueLike>(issues: readonly T[], index: number): T[] => issues.filter((x) => x.path === `steps[${String(index)}]` || x.path.startsWith(`steps[${String(index)}].`));
export const generalIssues = <T extends IssueLike>(issues: readonly T[]): T[] => issues.filter((x) => !/^steps\[\d+\]/.test(x.path));

export type WorkflowStatus = 'enabled' | 'disabled' | 'retired';

export const statusChangedWords = (status: WorkflowStatus): string => {
  if (status === 'enabled') return 'Turned on.';
  return status === 'disabled' ? 'Turned off. New documents will not use it; requests already waiting continue.' : 'Retired.';
};

export interface WorkflowMeta {
  name: string;
  description: string;
  priority: number;
}

/** What is sent when the workflow's details are saved; the order defaults to 100. */
export const metaPayload = (meta: WorkflowMeta, branchId: string | null) => ({
  name: meta.name,
  description: meta.description,
  priority: Number.isFinite(meta.priority) && meta.priority !== 0 ? meta.priority : 100,
  branchId: emptyToNull(branchId),
});

/** The facts typed into the "try it" form, as the nested object the server tests (a.b.c becomes { a: { b: { c } } }). */
export function buildFacts(fields: readonly TriggerField[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.path];
    if (raw === undefined || raw === '') continue;
    const value = factValue(f.type, raw);
    const parts = f.path.split('.');
    const last = parts.at(-1);
    if (last === undefined) continue;
    let cursor = out;
    for (const part of parts.slice(0, -1)) {
      const existing = cursor[part];
      const child: Record<string, unknown> = typeof existing === 'object' && existing !== null ? (existing as Record<string, unknown>) : {};
      cursor[part] = child;
      cursor = child;
    }
    cursor[last] = value;
  }
  return out;
}

/** The fields the "try it" form asks for one by one (the amount, branch and requester have their own inputs). */
export const extraFields = (fields: readonly TriggerField[]): TriggerField[] => fields.filter((f) => !['amount', 'branchId', 'requestedBy'].includes(f.path));

/* ── approvers ────────────────────────────────────────────────────────────────────────────── */

export interface LimitInput {
  mode: LimitMode;
  amount: string;
}

export interface ProfileLimit {
  documentKind: string;
  maxAmount: number | null;
  unlimited: boolean;
}

export function limitsFrom(kinds: readonly string[], limits: readonly ProfileLimit[]): Record<string, LimitInput> {
  return Object.fromEntries(
    kinds.map((k): [string, LimitInput] => {
      const l = limits.find((x) => x.documentKind === k);
      if (l === undefined) return [k, { mode: 'none', amount: '' }];
      return [k, l.unlimited ? { mode: 'unlimited', amount: '' } : { mode: 'up_to', amount: String(l.maxAmount ?? 0) }];
    }),
  );
}

export interface ProfileForm {
  approverUserId: string;
  substituteUserId: string;
  substituteFrom: string;
  substituteTo: string;
  isActive: boolean;
}

/** The approver settings as they are sent, or what is wrong with them. */
export function profilePayload(
  userId: string,
  form: ProfileForm,
  kinds: readonly string[],
  limits: Record<string, LimitInput>,
):
  | { ok: true; payload: { userId: string; approverUserId: string | null; substituteUserId: string | null; substituteFrom: string | null; substituteTo: string | null; isActive: boolean; limits: ProfileLimit[] } }
  | { ok: false; error: string } {
  const out: ProfileLimit[] = [];
  for (const k of kinds) {
    const l = limits[k];
    if (l === undefined || l.mode === 'none') continue;
    if (l.mode === 'unlimited') {
      out.push({ documentKind: k, unlimited: true, maxAmount: null });
      continue;
    }
    const amount = Number(l.amount);
    if (l.amount.trim() === '' || !Number.isFinite(amount) || amount < 0) return { ok: false, error: 'Give each “up to” limit an amount of zero or more.' };
    out.push({ documentKind: k, unlimited: false, maxAmount: amount });
  }
  const covered = has(form.substituteUserId);
  return {
    ok: true,
    payload: {
      userId,
      approverUserId: emptyToNull(form.approverUserId),
      substituteUserId: emptyToNull(form.substituteUserId),
      substituteFrom: covered ? emptyToNull(form.substituteFrom) : null,
      substituteTo: covered ? emptyToNull(form.substituteTo) : null,
      isActive: form.isActive,
      limits: out,
    },
  };
}

export const moveMember = (members: readonly string[], index: number, by: -1 | 1): string[] => {
  const target = index + by;
  const here = members[index];
  const there = members[target];
  if (here === undefined || there === undefined) return [...members];
  const next = [...members];
  next[index] = there;
  next[target] = here;
  return next;
};

/** A group as it is sent, or what is wrong with it. */
export function groupPayload(id: string | undefined, form: { code: string; name: string }, members: readonly string[]) {
  const code = form.code.trim().toUpperCase();
  const name = form.name.trim();
  if (!has(code) || !has(name)) return { ok: false as const, error: 'A group needs a name and a code.' };
  return { ok: true as const, payload: { ...(id === undefined ? {} : { id }), code, name, memberUserIds: [...members] } };
}

/* ── switches ─────────────────────────────────────────────────────────────────────────────── */

export const ON_OFF: readonly { id: 'true' | 'false'; label: string }[] = [
  { id: 'false', label: 'Off' },
  { id: 'true', label: 'On' },
];

export interface SwitchLike {
  module: string;
  trigger: string | null;
  branchId: string | null;
  enabled: boolean;
}

/** The company-wide switch set for this area (or situation), if any. */
export const explicitSwitch = (list: readonly SwitchLike[], module: string, trigger: string | null): SwitchLike | undefined =>
  list.find((s) => s.module === module && s.trigger === trigger && s.branchId === null);

/** Whether approvals are on for an area or situation, and whether that is only inherited from the area (or default). */
export function effectiveSwitch(list: readonly SwitchLike[], module: string, trigger: string | null): { on: boolean; inherited: boolean } {
  const own = trigger === null ? undefined : explicitSwitch(list, module, trigger);
  if (own !== undefined) return { on: own.enabled, inherited: false };
  const area = explicitSwitch(list, module, null);
  if (area !== undefined) return { on: area.enabled, inherited: trigger !== null };
  return { on: true, inherited: true };
}

/** "sales|sales_order.submitted" or "sales|" (the whole area), as chosen from the scope picker. */
export const scopeId = (module: string, trigger: string | null): string => `${module}|${trigger ?? ''}`;

export function parseScope(id: string): { module: string; trigger: string | null } | null {
  const [module, trigger = ''] = id.split('|');
  if (module === undefined || module === '') return null;
  return { module, trigger: trigger === '' ? null : trigger };
}

/** "Turn approvals off for Sales order submitted at Nairobi?" */
export function switchQuestion(change: { enabled: boolean; areaLabel: string; triggerLabel: string | null; branchLabel: string | null }): string {
  const where = change.triggerLabel ?? `all of ${change.areaLabel}`;
  const at = change.branchLabel === null ? '' : ` at ${change.branchLabel}`;
  return `Turn approvals ${change.enabled ? 'on' : 'off'} for ${where}${at}?`;
}

/* ── new workflow ─────────────────────────────────────────────────────────────────────────── */

/** A new workflow's form as it is sent, or what is wrong with it. */
export function newWorkflowPayload(form: { code: string; name: string }, trigger: string | null, branchId: string | null) {
  const code = form.code.trim().toUpperCase();
  const name = form.name.trim();
  if (!has(name)) return { ok: false as const, error: 'Give the workflow a name.' };
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) return { ok: false as const, error: 'The code can use letters, numbers, "-" and "_" (up to 40).' };
  if (trigger === null) return { ok: false as const, error: 'Choose when approval is asked for.' };
  return { ok: true as const, payload: { code, name, trigger, branchId: emptyToNull(branchId) } };
}
