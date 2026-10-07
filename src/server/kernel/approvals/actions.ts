'use server';

import { revalidatePath } from 'next/cache';
import { inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { withAfterCommit } from '../after-commit';
import { roles, users } from '@/server/db/drizzle/schema';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { ReasonError } from '../reason-codes/service';
import { ApprovalConfigError } from './config-service';
import { ApprovalError, type Simulation } from './engine';
import type { DefinitionIssue } from './domain/definition';
import { TRIGGERS, triggerByCode, type TriggerDefinition } from './domain/triggers';
import type { WorkflowDefinition } from './domain/types';
import type { PermissionKey } from '@/server/domains/access-control/permissions';

export type ApprovalResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; issues?: DefinitionIssue[]; forbidden?: true };

/** Server action errors are masked in production, so failures come back as data. */
async function run<T>(
  permission: PermissionKey,
  fn: (ctx: {
    companyId: string;
    userId: string;
    actor: { type: 'user'; id: string };
  }) => Promise<T>,
): Promise<ApprovalResult<T>> {
  try {
    const userId = await requirePermission(permission);
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
    console.error('[approvals]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Names for a set of user ids, so screens never show raw ids. */
async function namesOf(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  // Actor ids are free text (a job or script may not be a user), so only look up real user ids.
  const unique = [...new Set(ids.filter((i): i is string => !!i && UUID.test(i)))];
  if (unique.length === 0) return new Map();
  const rows = await drizzleDb
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name || r.email]));
}

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
  entries: Array<{
    approverName: string;
    onBehalfOfName: string | null;
    status: 'open' | 'approved' | 'rejected' | 'canceled';
    comment: string | null;
    actedAt: string | null;
  }>;
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
  timeline: Array<{ at: string; action: string; actorName: string; reason: string | null }>;
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
  else text = String(value);
  return { label: field.label, value: text };
}

function flatten(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v] as [string, unknown]],
  );
}

// ── approver and requester actions ───────────────────────────────────────

export async function listInboxAction(): Promise<ApprovalResult<InboxItem[]>> {
  return run('approvals:act', async ({ userId }) => {
    const rows = await getContainer().approvals.inbox(userId);
    const names = await namesOf(rows.flatMap((r) => [r.requestedBy, r.onBehalfOfUserId]));
    const now = Date.now();
    return rows.map((r) => ({
      entryId: r.entryId,
      requestId: r.requestId,
      documentKind: r.documentKind,
      documentId: r.documentId,
      triggerLabel: triggerLabel(r.trigger),
      amount: Number(r.amount),
      requestedByName: names.get(r.requestedBy) ?? 'Unknown',
      step: r.step,
      onBehalfOfName: r.onBehalfOfUserId ? (names.get(r.onBehalfOfUserId) ?? null) : null,
      dueAt: r.dueAt?.toISOString() ?? null,
      overdue: r.dueAt ? r.dueAt.getTime() < now : false,
      handedOver: r.replacesEntryId !== null,
      waitingSince: r.waitingSince.toISOString(),
    }));
  });
}

export async function getRequestDetailAction(
  requestId: string,
): Promise<ApprovalResult<RequestDetail>> {
  return run('approvals:act', async ({ companyId }) => {
    const d = await getContainer().approvals.requestDetail(companyId, requestId);
    if (!d) throw new ApprovalError('ENTRY_NOT_FOUND', 'That request was not found.');
    const names = await namesOf([
      d.request.requestedBy,
      ...d.entries.flatMap((e) => [e.approverUserId, e.onBehalfOfUserId]),
    ]);
    const trigger = triggerByCode(d.request.trigger);
    const def = d.definition as unknown as WorkflowDefinition;
    const facts = flatten(d.request.snapshot as Record<string, unknown>)
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
              onBehalfOfName: e.onBehalfOfUserId ? (names.get(e.onBehalfOfUserId) ?? null) : null,
              status: e.status,
              comment: e.comment,
              actedAt: e.actedAt?.toISOString() ?? null,
            })),
        })),
      timeline: d.timeline.map((t) => ({
        at: t.occurredAt.toISOString(),
        action: t.action,
        actorName:
          t.actorType === 'user' && t.actorId ? (actorNames.get(t.actorId) ?? 'Someone') : 'System',
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

export async function listApprovalReasonsAction(): Promise<
  ApprovalResult<{ code: string; description: string; requiresComment: boolean }[]>
> {
  return run('approvals:act', async ({ companyId }) =>
    (await getContainer().reasonCodes.list(companyId))
      .filter((r) => r.isActive)
      .map((r) => ({
        code: r.code,
        description: r.description,
        requiresComment: r.requiresComment,
      })),
  );
}

export async function listConfigReasonsAction(): Promise<
  ApprovalResult<{ code: string; description: string; requiresComment: boolean }[]>
> {
  return run('approvals:manage', async ({ companyId }) =>
    (await getContainer().reasonCodes.list(companyId))
      .filter((r) => r.isActive)
      .map((r) => ({
        code: r.code,
        description: r.description,
        requiresComment: r.requiresComment,
      })),
  );
}

function toMine(
  r: Awaited<ReturnType<ReturnType<typeof getContainer>['approvals']['requestsBy']>>[number],
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

export async function listMyRequestsAction(): Promise<ApprovalResult<MyRequest[]>> {
  return run('approvals:act', async ({ companyId, userId }) => {
    const rows = await getContainer().approvals.requestsBy(companyId, userId);
    const names = await namesOf(
      rows.flatMap((r) => r.openEntries.flatMap((e) => [e.approverUserId, e.onBehalfOfUserId])),
    );
    return rows.map((r) => toMine(r, names));
  });
}

export async function cancelRequestAction(
  submissionId: string,
  reason: string,
): Promise<ApprovalResult<null>> {
  const result = await run('approvals:act', async ({ userId }) =>
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
  const result = await run('approvals:act', async ({ userId, companyId }) =>
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

export interface Lookups {
  users: { id: string; name: string; email: string }[];
  groups: { id: string; code: string; name: string; memberIds: string[] }[];
  branches: { id: string; code: string; name: string }[];
  roles: { key: string; name: string }[];
  triggers: TriggerDefinition[];
}

export async function getLookupsAction(): Promise<ApprovalResult<Lookups>> {
  return run('approvals:manage', async ({ companyId }) => {
    const { approvalConfig, branches } = getContainer();
    const [people, groups, branchRows, roleRows] = await Promise.all([
      drizzleDb
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          status: users.status,
        })
        .from(users),
      approvalConfig.listGroups(companyId),
      branches.listByCompany(companyId),
      drizzleDb.select({ key: roles.key, name: roles.name, isActive: roles.isActive }).from(roles),
    ]);
    return {
      users: people
        .filter((u) => u.role !== 'customer' && u.status === 'active')
        .map((u) => ({ id: u.id, name: u.name || u.email, email: u.email }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      groups: groups.map((g) => ({
        id: g.id,
        code: g.code,
        name: g.name,
        memberIds: g.members.map((m) => m.userId),
      })),
      branches: branchRows.map((b) => ({ id: b.id, code: b.code, name: b.name })),
      roles: roleRows
        .filter((r) => r.isActive && r.key !== 'customer')
        .map((r) => ({ key: r.key, name: r.name }))
        .sort((x, y) => x.name.localeCompare(y.name)),
      triggers: TRIGGERS,
    };
  });
}

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
  version: number | null;
  stepCount: number;
  hasUnpublishedChanges: boolean;
}

export async function listWorkflowsAction(): Promise<ApprovalResult<WorkflowSummary[]>> {
  return run('approvals:manage', async ({ companyId }) => {
    const list = await getContainer().approvalConfig.listWorkflows(companyId);
    return Promise.all(
      list.map(async (w) => {
        const { versions } = await getContainer().approvalConfig.getWorkflow(companyId, w.id);
        const current = versions.find((v) => v.id === w.currentVersionId);
        const draft = w.draft as unknown as WorkflowDefinition;
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
          version: current?.version ?? null,
          stepCount: draft?.steps?.length ?? 0,
          hasUnpublishedChanges:
            current === undefined
              ? true
              : JSON.stringify(current.definition) !== JSON.stringify(w.draft),
        };
      }),
    );
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
    return {
      id: w.id,
      code: w.code,
      name: w.name,
      description: w.description,
      triggerCode: w.trigger,
      status: w.status,
      priority: w.priority,
      branchId: w.branchId,
      draft: ((w.draft as unknown as WorkflowDefinition)?.steps
        ? w.draft
        : { steps: [] }) as unknown as WorkflowDefinition,
      versions: versions.map((v) => ({
        version: v.version,
        publishedAt: v.publishedAt.toISOString(),
        publishedByName: (v.publishedBy && names.get(v.publishedBy)) || 'Unknown',
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
  workflows: Array<{
    code: string;
    name: string;
    version: number | null;
    matched: boolean;
    why: string[];
    steps: Array<{
      sequence: number;
      name: string;
      skipped: boolean;
      approvers: string[];
      problem: string | null;
    }>;
  }>;
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
          (t) => `${t.result ? '✓' : '✗'} ${t.node}${t.detail ? ` (${t.detail})` : ''}`,
        ),
        steps: w.steps.map((s) => ({
          sequence: s.sequence,
          name: s.name,
          skipped: s.skipped,
          problem: s.problem,
          approvers: s.approvers.map((a) => {
            const who = names.get(a.userId) ?? 'Unknown';
            return a.onBehalfOfUserId
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

export async function listProfilesAction(): Promise<ApprovalResult<ProfileView[]>> {
  return run('approvals:manage', async ({ companyId }) =>
    (await getContainer().approvalConfig.listProfiles(companyId)).map((p) => ({
      userId: p.userId,
      approverUserId: p.approverUserId,
      substituteUserId: p.substituteUserId,
      substituteFrom: p.substituteFrom,
      substituteTo: p.substituteTo,
      isActive: p.isActive,
      limits: p.limits.map((l) => ({
        documentKind: l.documentKind,
        maxAmount: l.maxAmount === null ? null : Number(l.maxAmount),
        unlimited: l.unlimited,
      })),
    })),
  );
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

export async function listSwitchesAction(): Promise<ApprovalResult<SwitchView[]>> {
  return run('approvals:manage', async ({ companyId }) =>
    (await getContainer().approvalConfig.listSwitches(companyId)).map((s) => ({
      module: s.module,
      trigger: s.trigger,
      branchId: s.branchId,
      enabled: s.enabled,
    })),
  );
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

export async function listPendingAction(): Promise<ApprovalResult<PendingRequest[]>> {
  return run('approvals:manage', async ({ companyId }) => {
    const rows = await getContainer().approvals.pending(companyId);
    const names = await namesOf([
      ...rows.map((r) => r.requestedBy),
      ...rows.flatMap((r) => r.openEntries.flatMap((e) => [e.approverUserId, e.onBehalfOfUserId])),
    ]);
    const now = Date.now();
    return rows.map((r) => ({
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
    }));
  });
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
