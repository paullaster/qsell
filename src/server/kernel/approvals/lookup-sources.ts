import { and, eq, ne, sql } from 'drizzle-orm';
import { approverGroupMembers, approverGroups, branches, roles, users } from '@/server/db/drizzle/schema';
import { acceptFilters, LookupFilterError, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { AUTHORITY_MODES, CONDITION_MATCH, GROUP_QUORUM, ON_OFF, RULE_TYPES, YES_NO, comparisonChoices, scopeId } from '@/lib/approval-forms';
import { MODULE_LABELS, TRIGGERS, triggerByCode } from './domain/triggers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const PERMISSION = 'approvals:manage' as const;

/** One optional filter that must be an id; anything else sent is refused. */
function onlyId(filters: Record<string, string>, name: string): string | undefined {
  const { [name]: id, ...rest } = filters;
  if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
  if (id === undefined) return undefined;
  if (!UUID.test(id)) throw new LookupFilterError('That is not a valid choice.');
  return id;
}

/**
 * Staff who can be asked to approve: active, not customers. The `exclude` filter leaves out one
 * person (the one whose approver is being chosen).
 */
const staff = tableSource({
  key: 'approval-users',
  permission: PERMISSION,
  table: users,
  id: users.id,
  label: users.name,
  searchColumns: [users.name, users.email],
  select: { email: users.email },
  scope: ({ filters }) => {
    const exclude = onlyId(filters, 'exclude');
    return [ne(users.role, 'customer'), eq(users.status, 'active'), ...(exclude === undefined ? [] : [ne(users.id, exclude)])];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.email), badge: null }),
});

/** Groups of approvers, with how many people are in each. */
const groups = tableSource({
  key: 'approval-groups',
  permission: PERMISSION,
  table: approverGroups,
  id: approverGroups.id,
  label: approverGroups.name,
  searchColumns: [approverGroups.name, approverGroups.code],
  select: { code: approverGroups.code, members: sql<number>`(select count(*)::int from ${approverGroupMembers} where ${approverGroupMembers.groupId} = ${approverGroups.id})` },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(approverGroups.companyId, companyId)];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: `${String(row.members)} ${row.members === 1 ? 'person' : 'people'}`, badge: null, meta: { members: String(row.members) } }),
});

const roleList = tableSource({
  key: 'approval-roles',
  permission: PERMISSION,
  table: roles,
  id: roles.key,
  label: roles.name,
  searchColumns: [roles.name, roles.key],
  select: {},
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [eq(roles.isActive, true), ne(roles.key, 'customer')];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: null, badge: null }),
});

const branchList = tableSource({
  key: 'approval-branches',
  permission: PERMISSION,
  table: branches,
  id: branches.id,
  label: branches.name,
  searchColumns: [branches.name, branches.code],
  select: { code: branches.code },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [and(eq(branches.companyId, companyId), eq(branches.isActive, true)) ?? eq(branches.companyId, companyId)];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: null }),
});

const fixed = (key: string, list: readonly { id: string; label: string }[]) =>
  staticSource({
    key,
    permission: PERMISSION,
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return list.map((c) => ({ ...c, description: null }));
    },
  });

/** The fields of one trigger (the `trigger` filter); `type` keeps one kind of field, `exclude` leaves one out. */
const triggerFields = staticSource({
  key: 'approval-trigger-fields',
  permission: PERMISSION,
  items: ({ filters }) => {
    const { trigger, type, exclude, ...rest } = filters;
    if (Object.keys(rest).length > 0 || trigger === undefined) throw new LookupFilterError('Choose the trigger first.');
    const found = triggerByCode(trigger);
    if (found === undefined) throw new LookupFilterError('That is not a known trigger.');
    if (type !== undefined && type !== 'number' && type !== 'text' && type !== 'boolean') throw new LookupFilterError('That is not a kind of field.');
    return found.fields.filter((f) => (type === undefined || f.type === type) && f.path !== exclude).map((f) => ({ id: f.path, label: f.label, description: null, meta: { type: f.type } }));
  },
});

/** The ways a field can be compared, for one kind of field (the `type` filter). */
const comparisons = staticSource({
  key: 'approval-comparisons',
  permission: PERMISSION,
  items: ({ filters }) => {
    const { type, ...rest } = filters;
    if (Object.keys(rest).length > 0 || (type !== 'number' && type !== 'text' && type !== 'boolean')) throw new LookupFilterError('Choose the kind of field first.');
    return comparisonChoices(type).map((c) => ({ ...c, description: null }));
  },
});

/** Every area as a whole, then each situation in it: what a switch can be set for. */
function switchScopes(): { id: string; label: string }[] {
  const modules = [...new Set(TRIGGERS.map((t) => t.module))];
  return modules.flatMap((m) => [
    { id: scopeId(m, null), label: `All of ${MODULE_LABELS[m] ?? m}` },
    ...TRIGGERS.filter((t) => t.module === m).map((t) => ({ id: scopeId(m, t.code), label: `${MODULE_LABELS[m] ?? m} · ${t.label}` })),
  ]);
}

export const APPROVAL_LOOKUP_SOURCES: LookupSource[] = [
  staff,
  groups,
  roleList,
  branchList,
  fixed('approval-triggers', TRIGGERS.map((t) => ({ id: t.code, label: t.label }))),
  fixed('approval-authority-modes', AUTHORITY_MODES),
  fixed('approval-rule-types', RULE_TYPES),
  fixed('approval-group-quorum', GROUP_QUORUM),
  fixed('approval-condition-match', CONDITION_MATCH),
  fixed('approval-yes-no', YES_NO),
  fixed('approval-on-off', ON_OFF),
  fixed('approval-switch-scopes', switchScopes()),
  triggerFields,
  comparisons,
];
