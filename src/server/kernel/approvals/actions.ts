'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { withAfterCommit } from '../after-commit';
import { approverGroups, roles, users } from '@/server/db/drizzle/schema';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { ReasonError } from '../reason-codes/service';
import { isMalformedId, NO_SUCH_RECORD } from '@/server/domains/settings/errors';
import { ApprovalConfigError } from './config-service';
import { ApprovalError, type Simulation } from './engine';
import type { DefinitionIssue } from './domain/definition';
import { triggerByCode, type TriggerDefinition } from './domain/triggers';
import type { PageInput } from '@/server/domains/settings/paging';
import { injectedDelay } from '@/server/domains/finance/action-runner';
import type { WorkflowDefinition } from './domain/types';
import type { PermissionKey } from '@/server/domains/access-control/permissions';

import { has, orElse, readText } from '@/lib/values';

export type ApprovalResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; issues?: DefinitionIssue[]; forbidden?: true };

/** Passes when the caller holds any one of the permissions. */
async function requireAny(permission: PermissionKey | readonly PermissionKey[]): Promise<string> {
  if (typeof permission === 'string') return requirePermission(permission);
  let denied: unknown;
  for (const key of permission) {
    try {
      return await requirePermission(key);
    } catch (error: unknown) {
      if (!(error instanceof AccessDeniedError)) throw error;
      denied = error;
    }
  }
  throw denied;
}

/** Server action errors are masked in production, so failures come back as data. */
async function run<T>(
  permission: PermissionKey | readonly PermissionKey[],
  fn: (ctx: {
    companyId: string;
    userId: string;
    actor: { type: 'user'; id: string };
  }) => Promise<T>,
): Promise<ApprovalResult<T>> {
  try {
    await injectedDelay();
    const userId = await requireAny(permission);
    const company = await getContainer().companySettings.ensureSeeded();
    await getContainer().reasonCodes.ensureSystemReasons(company.id);
    return {
      ok: true,
      data: await fn({ companyId: company.id, userId, actor: { type: 'user', id: userId } }),
    };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    }
    if (error instanceof ApprovalConfigError) {
      return { ok: false, error: error.message, code: error.code, issues: error.issues };
    }
    if (error instanceof ApprovalError || error instanceof ReasonError) {
      return { ok: false, error: error.message, code: error.code };
    }
    if (isMalformedId(error)) return NO_SUCH_RECORD;
    console.error('[approvals]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Names for a set of user ids, so screens never show raw ids. */
async function namesOf(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  // Actor ids are free text (a job or script may not be a user), so only look up real user ids.
  const unique = [...new Set(ids.filter((i): i is string => has(i) && UUID.test(i)))];
  if (unique.length === 0) return new Map();
  const rows = await drizzleDb
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, orElse(r.name, r.email)]));
}

/** The words for the people, groups, roles and branch a workflow names, keyed "user:id", "group:id", "role:key", "branch:id". */
async function labelsFor(companyId: string, def: WorkflowDefinition, branchId: string | null): Promise<Record<string, string>> {
  const rules = def.steps.map((st) => st.approver);
  const userIds = rules.flatMap((r) => (r.type === 'user' && has(r.userId) ? [r.userId] : []));
  const groupIds = rules.flatMap((r) => (r.type === 'group' && has(r.groupId) ? [r.groupId] : []));
  const roleKeys = rules.flatMap((r) => (r.type === 'role' && has(r.roleKey) ? [r.roleKey] : []));
  const out: Record<string, string> = {};
  const [names, groupRows, roleRows, branchLabels] = await Promise.all([
    namesOf(userIds),
    groupIds.length === 0 ? Promise.resolve([]) : drizzleDb.select({ id: approverGroups.id, name: approverGroups.name }).from(approverGroups).where(and(eq(approverGroups.companyId, companyId), inArray(approverGroups.id, groupIds))),
    roleKeys.length === 0 ? Promise.resolve([]) : drizzleDb.select({ key: roles.key, name: roles.name }).from(roles).where(inArray(roles.key, roleKeys)),
    getContainer().numbering.branchLabels(branchId === null ? [] : [branchId]),
  ]);
  for (const [id, name] of names) out[`user:${id}`] = name;
  for (const g of groupRows) out[`group:${g.id}`] = g.name;
  for (const r of roleRows) out[`role:${r.key}`] = r.name;
  for (const [id, label] of branchLabels) out[`branch:${id}`] = label;
  return out;
}

/** The name for an id looked up earlier, or nothing when there is no id or no such person. */
const nameOf = (names: Map<string, string>, id: string | null | undefined): string | null => (id === null || id === undefined ? null : (names.get(id) ?? null));

const triggerLabel = (code: string) => triggerByCode(code)?.label ?? code;
const revalidate = () => revalidatePath('/admin/approvals', 'layout');
const revalidateSettings = () => revalidatePath('/admin/settings/approvals', 'layout');

// ── views ────────────────────────────────────────────────────────────────

export interface InboxItem {
  entryId: string;
  requestId: string;
  documentKind: string;
  documentId: string;
  triggerLabel: string;
  amount: number;
  requestedByName: string;
  step: number;
  onBehalfOfName: string | null;
  dueAt: string | null;
  overdue: boolean;
  /** It reached you because the earlier approver did not answer in time, or an administrator sent it. */
  handedOver: boolean;
  waitingSince: string;
}

export interface Fact {
  label: string;
  value: string;
}

export interface StepProgress {
  sequence: number;
  name: string;
  entries: {
    approverName: string;
    onBehalfOfName: string | null;
    status: 'open' | 'approved' | 'rejected' | 'canceled';
    comment: string | null;
    actedAt: string | null;
  }[];
}

export interface RequestDetail {
  requestId: string;
  documentKind: string;
  documentId: string;
  triggerLabel: string;
  status: string;
  amount: number;
  requestedByName: string;
  workflowName: string;
  workflowVersion: number;
  attempt: number;
  createdAt: string;
  /** What the approver is being asked to approve, in plain words, when the module can say. */
  what: string | null;
  facts: Fact[];
  steps: StepProgress[];
  timeline: { at: string; action: string; actorName: string; reason: string | null }[];
}

export interface MyRequest {
  requestId: string;
  submissionId: string;
  documentKind: string;
  documentId: string;
  triggerLabel: string;
  amount: number;
  status: string;
  attempt: number;
  createdAt: string;
  waitingOn: string[];
}

export interface PendingRequest extends MyRequest {
  requestedByName: string;
  /** Each open entry, so an administrator can reroute it. */
  entries: {
    entryId: string;
    approverName: string;
    overdue: boolean;
    stuck: boolean;
    handedOver: boolean;
  }[];
  oldestWaitingSince: string | null;
  overdue: boolean;
}

function describeFact(
  trigger: TriggerDefinition | undefined,
  path: string,
  value: unknown,
): Fact | null {
  const field = trigger?.fields.find((f) => f.path === path);
  if (!field) return null;
  let text: string;
  if (value === null || value === undefined) text = '—';
  else if (typeof value === 'boolean') text = value ? 'Yes' : 'No';
  else if (typeof value === 'number')
    text = value.toLocaleString('en-KE', { maximumFractionDigits: 2 });
  else text = readText(value);
  return { label: field.label, value: text };
}

function flatten(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v] as [string, unknown]],
  );
}

// ── approver and requester actions ───────────────────────────────────────

/** A page of rows with where the next page begins. */
export interface Paged<Row> {
  rows: Row[];
  nextCursor: string | null;
}

/** One page of what waits on the signed-in person, oldest first; text and `overdueOnly` narrow it in the database. */
export async function inboxPageAction(input: PageInput & { overdueOnly?: boolean }): Promise<ApprovalResult<Paged<InboxItem>>> {
  return run('approvals:act', async ({ userId }) => {
    const page = await getContainer().approvals.inboxPage(userId, { query: input.query, cursor: input.cursor, overdueOnly: input.overdueOnly === true });
    const names = await namesOf(page.rows.flatMap((r) => [r.requestedBy, r.onBehalfOfUserId]));
    const now = Date.now();
    return {
      nextCursor: page.nextCursor,
      rows: page.rows.map((r) => ({
        entryId: r.entryId,
        requestId: r.requestId,
        documentKind: r.documentKind,
        documentId: r.documentId,
        triggerLabel: triggerLabel(r.trigger),
        amount: Number(r.amount),
        requestedByName: names.get(r.requestedBy) ?? 'Unknown',
        step: r.step,
        onBehalfOfName: has(r.onBehalfOfUserId) ? (names.get(r.onBehalfOfUserId) ?? null) : null,
        dueAt: r.dueAt?.toISOString() ?? null,
        overdue: r.dueAt ? r.dueAt.getTime() < now : false,
        handedOver: r.replacesEntryId !== null,
        waitingSince: r.waitingSince.toISOString(),
      })),
    };
  });
}

/** How many approvals wait on the signed-in person, and how many are overdue, counted by the database. */
export async function inboxCountsAction(): Promise<ApprovalResult<{ waiting: number; overdue: number }>> {
  return run('approvals:act', ({ userId }) => getContainer().approvals.inboxCounts(userId));
}

export async function getRequestDetailAction(
  requestId: string,
): Promise<ApprovalResult<RequestDetail>> {
  return run(['approvals:act', 'approvals:request'], async ({ companyId }) => {
    const d = await getContainer().approvals.requestDetail(companyId, requestId);
    if (!d) throw new ApprovalError('ENTRY_NOT_FOUND', 'That request was not found.');
    const names = await namesOf([
      d.request.requestedBy,
      ...d.entries.flatMap((e) => [e.approverUserId, e.onBehalfOfUserId]),
    ]);
    const trigger = triggerByCode(d.request.trigger);
    const def = d.definition as unknown as WorkflowDefinition;
    const facts = flatten(d.request.snapshot)
      // Who asked is already in the header; an empty branch says nothing.
      .filter(([path, v]) => path !== 'requestedBy' && !(path === 'branchId' && v === null))
      .map(([path, v]) => describeFact(trigger, path, v))
      .filter((f): f is Fact => f !== null);
    const actorIds = d.timeline.map((t) => t.actorId);
    const actorNames = await namesOf(actorIds);
    return {
      requestId: d.request.id,
      documentKind: d.request.documentKind,
      documentId: d.request.documentId,
      triggerLabel: triggerLabel(d.request.trigger),
      status: d.request.status,
      amount: Number(d.request.amount),
      requestedByName: names.get(d.request.requestedBy) ?? 'Unknown',
      workflowName: d.workflowName,
      workflowVersion: d.version,
      attempt: d.request.attempt,
      createdAt: d.request.createdAt.toISOString(),
      what: d.what?.title ?? null,
      facts,
      steps: [...def.steps]
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => ({
          sequence: s.sequence,
          name: s.name,
          entries: d.entries
            .filter((e) => e.stepSequence === s.sequence)
            .map((e) => ({
              approverName: names.get(e.approverUserId) ?? 'Unknown',
              onBehalfOfName: has(e.onBehalfOfUserId) ? (names.get(e.onBehalfOfUserId) ?? null) : null,
              status: e.status,
              comment: e.comment,
              actedAt: e.actedAt?.toISOString() ?? null,
            })),
        })),
      timeline: d.timeline.map((t) => ({
        at: t.occurredAt.toISOString(),
        action: t.action,
        actorName:
          t.actorType === 'user' && has(t.actorId) ? (actorNames.get(t.actorId) ?? 'Someone') : 'System',
        reason: t.reasonText,
      })),
    };
  });
}

export async function approveEntryAction(
  entryId: string,
  comment: string,
): Promise<ApprovalResult<{ message: string }>> {
  const result = await run('approvals:act', async ({ userId }) =>
    withAfterCommit(drizzleDb, (tx) =>
      getContainer().approvals.approve(entryId, userId, comment, tx),
    ),
  );
  if (!result.ok) return result;
  revalidate();
  const r = result.data;
  if (r.outcome === 'superseded') return { ok: false, error: r.message, code: 'DOCUMENT_CHANGED' };
  return {
    ok: true,
    data: {
      message:
        r.outcome === 'approved' && r.released
          ? 'Approved. That was the last approval, so the document has been released.'
          : 'Approved. It now goes to the next approver, if there is one.',
    },
  };
}

export async function rejectEntryAction(
  entryId: string,
  reasonCode: string,
  comment: string,
): Promise<ApprovalResult<{ message: string }>> {
  const result = await run('approvals:act', async ({ userId }) =>
    withAfterCommit(drizzleDb, (tx) =>
      getContainer().approvals.reject(entryId, userId, { reasonCode, comment }, tx),
    ),
  );
  if (!result.ok) return result;
  revalidate();
  return {
    ok: true,
    data: { message: 'Rejected. The requester has been told why and can reopen the document.' },
  };
}

function toMine(
  r: Awaited<ReturnType<ReturnType<typeof getContainer>['approvals']['requestsPage']>>['rows'][number],
  names: Map<string, string>,
): MyRequest {
  return {
    requestId: r.id,
    submissionId: r.submissionId,
    documentKind: r.documentKind,
    documentId: r.documentId,
    triggerLabel: triggerLabel(r.trigger),
    amount: Number(r.amount),
    status: r.status,
    attempt: r.attempt,
    createdAt: r.createdAt.toISOString(),
    waitingOn: r.openEntries.map(
      (e) => names.get(e.onBehalfOfUserId ?? e.approverUserId) ?? 'Unknown',
    ),
  };
}

const REQUEST_STATUSES = ['pending', 'rejected', 'approved'] as const;

/** One page of what the signed-in person has sent for approval, newest first; an unknown status shows all. */
export async function myRequestsPageAction(input: PageInput & { status?: string }): Promise<ApprovalResult<Paged<MyRequest>>> {
  return run('approvals:request', async ({ companyId, userId }) => {
    const status = REQUEST_STATUSES.find((s) => s === input.status);
    const page = await getContainer().approvals.requestsPage(companyId, userId, { cursor: input.cursor, status });
    const names = await namesOf(page.rows.flatMap((r) => r.openEntries.flatMap((e) => [e.approverUserId, e.onBehalfOfUserId])));
    return { nextCursor: page.nextCursor, rows: page.rows.map((r) => toMine(r, names)) };
  });
}

export async function cancelRequestAction(
  submissionId: string,
  reason: string,
): Promise<ApprovalResult<null>> {
  const result = await run('approvals:request', async ({ userId }) =>
    withAfterCommit(drizzleDb, (tx) =>
      getContainer().approvals.cancel(submissionId, { userId }, { text: reason }, tx),
    ),
  );
  if (!result.ok) return result;
  revalidate();
  return { ok: true, data: null };
}

export async function reopenRequestAction(
  documentKind: string,
  documentId: string,
  reason: string,
): Promise<ApprovalResult<null>> {
  const result = await run('approvals:request', async ({ userId, companyId }) =>
    withAfterCommit(drizzleDb, (tx) =>
      getContainer().approvals.reopen(
        documentKind,
        documentId,
        { userId },
        { text: reason },
        tx,
        companyId,
      ),
    ),
  );
  if (!result.ok) return result;
  revalidate();
  return { ok: true, data: null };
}

// ── administrator actions ────────────────────────────────────────────────

export interface WorkflowSummary {
  id: string;
  code: string;
  name: string;
  module: string;
  triggerCode: string;
  triggerLabel: string;
  status: 'draft' | 'enabled' | 'disabled' | 'retired';
  priority: number;
  branchId: string | null;
  branchLabel: string | null;
  version: number | null;
  stepCount: number;
  hasUnpublishedChanges: boolean;
}

/** One page of workflows in code order, each with its branch and published version named. */
export async function workflowsPageAction(input: PageInput): Promise<ApprovalResult<{ rows: WorkflowSummary[]; nextCursor: string | null }>> {
  return run('approvals:manage', async ({ companyId }) => {
    const { approvalConfig, numbering } = getContainer();
    const page = await approvalConfig.pageWorkflows(companyId, input);
    const versions = await approvalConfig.versionsByIds(page.rows.flatMap((w) => (w.currentVersionId === null ? [] : [w.currentVersionId])));
    const branchLabels = await numbering.branchLabels(page.rows.flatMap((w) => (w.branchId === null ? [] : [w.branchId])));
    const rows = page.rows.map((w): WorkflowSummary => {
      const current = versions.find((v) => v.id === w.currentVersionId);
      const draft = w.draft as unknown as WorkflowDefinition | undefined;
      return {
        id: w.id,
        code: w.code,
        name: w.name,
        module: w.module,
        triggerCode: w.trigger,
        triggerLabel: triggerLabel(w.trigger),
        status: w.status,
        priority: w.priority,
        branchId: w.branchId,
        branchLabel: w.branchId === null ? null : (branchLabels.get(w.branchId) ?? null),
        version: current?.version ?? null,
        stepCount: draft?.steps.length ?? 0,
        hasUnpublishedChanges: current === undefined ? true : JSON.stringify(current.definition) !== JSON.stringify(w.draft),
      };
    });
    return { rows, nextCursor: page.nextCursor };
  });
}

export interface WorkflowDetail {
  id: string;
  code: string;
  name: string;
  description: string | null;
  triggerCode: string;
  status: WorkflowSummary['status'];
  priority: number;
  branchId: string | null;
  /** The words for every person, group, role and branch the workflow names, so the screen never shows an id. */
  labels: Record<string, string>;
  draft: WorkflowDefinition;
  versions: {
    version: number;
    publishedAt: string;
    publishedByName: string;
    reason: string | null;
  }[];
}

export async function getWorkflowAction(id: string): Promise<ApprovalResult<WorkflowDetail>> {
  return run('approvals:manage', async ({ companyId }) => {
    const { workflow: w, versions } = await getContainer().approvalConfig.getWorkflow(
      companyId,
      id,
    );
    const names = await namesOf(versions.map((v) => v.publishedBy));
    const draft = ((w.draft as unknown as WorkflowDefinition | undefined)?.steps ? w.draft : { steps: [] }) as unknown as WorkflowDefinition;
    return {
      id: w.id,
      code: w.code,
      name: w.name,
      description: w.description,
      triggerCode: w.trigger,
      status: w.status,
      priority: w.priority,
      branchId: w.branchId,
      labels: await labelsFor(companyId, draft, w.branchId),
      draft,
      versions: versions.map((v) => ({
        version: v.version,
        publishedAt: v.publishedAt.toISOString(),
        publishedByName: orElse(v.publishedBy === null ? null : names.get(v.publishedBy), 'Unknown'),
        reason: v.reason,
      })),
    };
  });
}

export async function createWorkflowAction(input: {
  code: string;
  name: string;
  trigger: string;
  branchId?: string | null;
}): Promise<ApprovalResult<{ id: string }>> {
  const r = await run('approvals:manage', async ({ companyId, actor }) => ({
    id: (await getContainer().approvalConfig.createWorkflow(companyId, input, actor)).id,
  }));
  if (r.ok) revalidateSettings();
  return r;
}

export async function updateWorkflowMetaAction(
  id: string,
  input: { name: string; description?: string | null; priority: number; branchId?: string | null },
): Promise<ApprovalResult<null>> {
  const r = await run('approvals:manage', async ({ companyId, actor }) => {
    await getContainer().approvalConfig.updateWorkflowMeta(companyId, id, input, actor);
    return null;
  });
  if (r.ok) revalidateSettings();
  return r;
}

export async function saveWorkflowDraftAction(
  id: string,
  definition: WorkflowDefinition,
): Promise<ApprovalResult<{ issues: DefinitionIssue[] }>> {
  const r = await run('approvals:manage', async ({ companyId, actor }) => ({
    issues: await getContainer().approvalConfig.saveDraft(companyId, id, definition, actor),
  }));
  if (r.ok) revalidateSettings();
  return r;
}

export async function publishWorkflowAction(
  id: string,
  reason: { code: string; text: string },
): Promise<ApprovalResult<{ version: number }>> {
  const r = await run('approvals:manage', async ({ companyId, actor }) => ({
    version: (await getContainer().approvalConfig.publish(companyId, id, actor, reason)).version,
  }));
  if (r.ok) revalidateSettings();
  return r;
}

export async function setWorkflowStatusAction(
  id: string,
  status: 'enabled' | 'disabled' | 'retired',
  reason: { code: string; text: string },
): Promise<ApprovalResult<null>> {
  const r = await run('approvals:manage', async ({ companyId, actor }) => {
    await getContainer().approvalConfig.setWorkflowStatus(companyId, id, status, actor, reason);
    return null;
  });
  if (r.ok) revalidateSettings();
  return r;
}

export interface SimulationView {
  enabled: boolean;
  workflows: {
    code: string;
    name: string;
    version: number | null;
    matched: boolean;
    why: string[];
    steps: {
      sequence: number;
      name: string;
      skipped: boolean;
      approvers: string[];
      problem: string | null;
    }[];
  }[];
}

export async function simulateAction(input: {
  trigger: string;
  amount: number;
  requestedBy: string;
  branchId?: string | null;
  facts: Record<string, unknown>;
  draft?: WorkflowDefinition;
  onlyDraft?: boolean;
}): Promise<ApprovalResult<SimulationView>> {
  return run('approvals:manage', async ({ companyId }) => {
    const sim: Simulation = await getContainer().approvals.simulate({
      companyId,
      trigger: input.trigger,
      documentId: 'simulation',
      requestedBy: input.requestedBy,
      amount: input.amount,
      branchId: input.branchId ?? null,
      snapshot: input.facts,
      draft: input.draft,
      onlyDraft: input.onlyDraft,
    });
    const names = await namesOf(
      sim.workflows.flatMap((w) =>
        w.steps.flatMap((s) => s.approvers.flatMap((a) => [a.userId, a.onBehalfOfUserId])),
      ),
    );
    return {
      enabled: sim.enabled,
      workflows: sim.workflows.map((w) => ({
        code: w.code,
        name: w.name,
        version: w.version,
        matched: w.matched,
        why: w.trace.map(
          (t) => `${t.result ? '✓' : '✗'} ${t.node}${has(t.detail) ? ` (${t.detail})` : ''}`,
        ),
        steps: w.steps.map((s) => ({
          sequence: s.sequence,
          name: s.name,
          skipped: s.skipped,
          problem: s.problem,
          approvers: s.approvers.map((a) => {
            const who = names.get(a.userId) ?? 'Unknown';
            return has(a.onBehalfOfUserId)
              ? `${who} (covering for ${names.get(a.onBehalfOfUserId) ?? 'Unknown'})`
              : who;
          }),
        })),
      })),
    };
  });
}

export interface ProfileView {
  userId: string;
  approverUserId: string | null;
  substituteUserId: string | null;
  substituteFrom: string | null;
  substituteTo: string | null;
  isActive: boolean;
  limits: { documentKind: string; maxAmount: number | null; unlimited: boolean }[];
}

export interface PersonView {
  id: string;
  name: string;
  email: string;
  profile: ProfileView | null;
}

const toProfile = (p: Awaited<ReturnType<ReturnType<typeof getContainer>['approvalConfig']['profilesFor']>>[number]): ProfileView => ({
  userId: p.userId,
  approverUserId: p.approverUserId,
  substituteUserId: p.substituteUserId,
  substituteFrom: p.substituteFrom,
  substituteTo: p.substituteTo,
  isActive: p.isActive,
  limits: p.limits.map((l) => ({ documentKind: l.documentKind, maxAmount: l.maxAmount === null ? null : Number(l.maxAmount), unlimited: l.unlimited })),
});

/** One page of staff with their approver settings, and the names of the people they report to or are covered by. */
export async function peoplePageAction(input: PageInput): Promise<ApprovalResult<{ rows: (PersonView & { reportsToName: string | null; coveredByName: string | null })[]; nextCursor: string | null }>> {
  return run('approvals:manage', async ({ companyId }) => {
    const { approvalConfig } = getContainer();
    const page = await approvalConfig.pageStaff(input);
    const profiles = await approvalConfig.profilesFor(companyId, page.rows.map((r) => r.id));
    const names = await namesOf(profiles.flatMap((p) => [p.approverUserId, p.substituteUserId]));
    return {
      rows: page.rows.map((u) => {
        const found = profiles.find((p) => p.userId === u.id);
        const profile = found === undefined ? null : toProfile(found);
        return {
          id: u.id,
          name: orElse(u.name, u.email),
          email: u.email,
          profile,
          reportsToName: nameOf(names, profile?.approverUserId),
          coveredByName: nameOf(names, profile?.substituteUserId),
        };
      }),
      nextCursor: page.nextCursor,
    };
  });
}

export interface ApproverGroupView {
  id: string;
  code: string;
  name: string;
  members: { id: string; name: string }[];
}

/** One page of approver groups, each with its members named in the order they are asked. */
export async function groupsPageAction(input: PageInput): Promise<ApprovalResult<{ rows: ApproverGroupView[]; nextCursor: string | null }>> {
  return run('approvals:manage', async ({ companyId }) => {
    const page = await getContainer().approvalConfig.pageGroups(companyId, input);
    const names = await namesOf(page.rows.flatMap((g) => g.members.map((m) => m.userId)));
    return {
      rows: page.rows.map((g) => ({ id: g.id, code: g.code, name: g.name, members: g.members.map((m) => ({ id: m.userId, name: names.get(m.userId) ?? 'Unknown' })) })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function saveProfileAction(
  input: ProfileView,
  reason: { code: string; text: string },
): Promise<ApprovalResult<null>> {
  const r = await run('approvals:manage', async ({ companyId, actor }) => {
    await getContainer().approvalConfig.saveProfile(companyId, input, actor, reason);
    return null;
  });
  if (r.ok) revalidateSettings();
  return r;
}

export async function saveGroupAction(
  input: { id?: string; code: string; name: string; memberUserIds: string[] },
  reason: { code: string; text: string },
): Promise<ApprovalResult<{ id: string }>> {
  const r = await run('approvals:manage', async ({ companyId, actor }) =>
    getContainer().approvalConfig.saveGroup(companyId, input, actor, reason),
  );
  if (r.ok) revalidateSettings();
  return r;
}

export interface SwitchView {
  module: string;
  trigger: string | null;
  branchId: string | null;
  enabled: boolean;
}

export interface SwitchesView {
  /** The company-wide switches that were set (few: one per area and situation). */
  company: SwitchView[];
}

export async function companySwitchesAction(): Promise<ApprovalResult<SwitchesView>> {
  return run('approvals:manage', async ({ companyId }) => ({
    company: (await getContainer().approvalConfig.companySwitches(companyId)).map((s) => ({ module: s.module, trigger: s.trigger, branchId: s.branchId, enabled: s.enabled })),
  }));
}

export interface BranchSwitchView extends SwitchView {
  branchLabel: string;
}

/** One page of the exceptions set for a single branch. */
export async function branchSwitchesPageAction(input: PageInput): Promise<ApprovalResult<{ rows: BranchSwitchView[]; nextCursor: string | null }>> {
  return run('approvals:manage', async ({ companyId }) => {
    const page = await getContainer().approvalConfig.pageBranchSwitches(companyId, input);
    const labels = await getContainer().numbering.branchLabels(page.rows.flatMap((s) => (s.branchId === null ? [] : [s.branchId])));
    return {
      rows: page.rows.map((s) => ({ module: s.module, trigger: s.trigger, branchId: s.branchId, enabled: s.enabled, branchLabel: s.branchId === null ? 'Unknown branch' : (labels.get(s.branchId) ?? 'Unknown branch') })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function setSwitchAction(
  input: SwitchView,
  reason: { code: string; text: string },
): Promise<ApprovalResult<null>> {
  const r = await run('approvals:manage', async ({ companyId, actor }) => {
    await getContainer().approvalConfig.setSwitch(companyId, input, actor, reason);
    return null;
  });
  if (r.ok) revalidateSettings();
  return r;
}

export interface PendingPage {
  rows: PendingRequest[];
  nextCursor: string | null;
}

/** One page of what is waiting, oldest first; `overdueOnly` keeps just the requests with an overdue entry. */
export async function pendingPageAction(input: PageInput & { overdueOnly?: boolean }): Promise<ApprovalResult<PendingPage>> {
  return run('approvals:manage', async ({ companyId }) => {
    const page = await getContainer().approvals.pendingPage(companyId, input);
    const rows = page.rows;
    const names = await namesOf([
      ...rows.map((r) => r.requestedBy),
      ...rows.flatMap((r) => r.openEntries.flatMap((e) => [e.approverUserId, e.onBehalfOfUserId])),
    ]);
    const now = Date.now();
    return {
      nextCursor: page.nextCursor,
      rows: rows.map((r) => ({
        ...toMine(r, names),
        requestedByName: names.get(r.requestedBy) ?? 'Unknown',
        oldestWaitingSince: r.openEntries.map((e) => e.createdAt.toISOString()).sort()[0] ?? null,
        overdue: r.openEntries.some((e) => e.dueAt !== null && e.dueAt.getTime() < now),
        entries: r.openEntries.map((e) => ({
          entryId: e.id,
          approverName: names.get(e.approverUserId) ?? 'Unknown',
          overdue: e.dueAt !== null && e.dueAt.getTime() < now,
          // Overdue and already looked at by the sweep, yet still open: nobody above could take it.
          stuck: e.escalatedAt !== null,
          handedOver: e.replacesEntryId !== null,
        })),
      })),
    };
  });
}

/** How many requests wait, and how many of them are overdue, counted by the database. */
export async function pendingCountsAction(): Promise<ApprovalResult<{ waiting: number; overdue: number }>> {
  return run('approvals:manage', ({ companyId }) => getContainer().approvals.pendingCounts(companyId));
}

export async function adminCancelRequestAction(
  submissionId: string,
  reason: string,
): Promise<ApprovalResult<null>> {
  const result = await run('approvals:manage', async ({ userId }) =>
    withAfterCommit(drizzleDb, (tx) =>
      getContainer().approvals.cancel(
        submissionId,
        { userId, isAdmin: true },
        { text: reason },
        tx,
      ),
    ),
  );
  if (!result.ok) return result;
  revalidate();
  revalidateSettings();
  return { ok: true, data: null };
}

export async function rerouteEntryAction(
  entryId: string,
  toUserId: string,
  reason: { code: string; text: string },
): Promise<ApprovalResult<null>> {
  const result = await run('approvals:manage', async ({ userId }) =>
    withAfterCommit(drizzleDb, (tx) =>
      getContainer().approvals.reroute(entryId, toUserId, { userId }, reason, tx),
    ),
  );
  if (!result.ok) return result;
  revalidate();
  revalidateSettings();
  return { ok: true, data: null };
}

/** Runs the overdue sweep now instead of waiting for the five-minute schedule. */
export async function sweepOverdueNowAction(): Promise<
  ApprovalResult<{ escalated: number; stuck: number; failed: number }>
> {
  const result = await run('approvals:manage', async () => getContainer().approvals.sweepOverdue());
  if (result.ok) {
    revalidate();
    revalidateSettings();
  }
  return result;
}
