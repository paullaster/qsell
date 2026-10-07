import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  approvalSwitches,
  approvalWorkflowVersions,
  approvalWorkflows,
  approverGroupMembers,
  approverGroups,
  approverLimits,
  approverProfiles,
  roles,
  userRoles,
  users,
} from '@/server/db/drizzle/schema';
import type { Actor } from '../context';
import type { DecisionLog } from '../decision-log/service';
import type { ReasonCodes, ReasonInput } from '../reason-codes/service';
import { validateDefinition, type DefinitionIssue } from './domain/definition';
import { MAX_ROLE_HOLDERS } from './engine';
import { triggerByCode } from './domain/triggers';
import type { WorkflowDefinition } from './domain/types';

export class ApprovalConfigError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'DUPLICATE_CODE'
      | 'INVALID_DEFINITION'
      | 'INVALID_PROFILE'
      | 'INVALID_GROUP'
      | 'NOT_EDITABLE',
    message: string,
    readonly issues: DefinitionIssue[] = [],
  ) {
    super(message);
    this.name = 'ApprovalConfigError';
  }
}

type Reason = ReasonInput;

/**
 * Everything an administrator can change about approvals at runtime. Each change needs a reason
 * and is written to the decision log; none of them edits a request already in flight (workflows
 * are versioned, and later approvers are only resolved when their turn comes).
 */
export class ApprovalConfigService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
  ) {}

  private async why(companyId: string, reason: Reason) {
    return this.reasons.require(companyId, reason, 'approval_configuration');
  }

  // ── Switches ─────────────────────────────────────────────────────────────

  async setSwitch(
    companyId: string,
    input: { module: string; trigger?: string | null; branchId?: string | null; enabled: boolean },
    actor: Actor,
    reason: Reason,
  ) {
    const why = await this.why(companyId, reason);
    if (input.trigger && !triggerByCode(input.trigger)) {
      throw new ApprovalConfigError('NOT_FOUND', `Unknown trigger "${input.trigger}".`);
    }
    await this.db.transaction(async (tx) => {
      await tx
        .delete(approvalSwitches)
        .where(
          and(
            eq(approvalSwitches.companyId, companyId),
            eq(approvalSwitches.module, input.module),
            input.trigger
              ? eq(approvalSwitches.trigger, input.trigger)
              : isNull(approvalSwitches.trigger),
            input.branchId
              ? eq(approvalSwitches.branchId, input.branchId)
              : isNull(approvalSwitches.branchId),
          ),
        );
      await tx.insert(approvalSwitches).values({
        companyId,
        module: input.module,
        trigger: input.trigger ?? null,
        branchId: input.branchId ?? null,
        enabled: input.enabled,
        changedBy: actor.id,
      });
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: {
            type: 'approval_switch',
            id: `${input.module}:${input.trigger ?? '*'}:${input.branchId ?? '*'}`,
          },
          action: input.enabled ? 'approvals.switched_on' : 'approvals.switched_off',
          reason: { code: why.code, text: why.text },
          outcome: { ...input },
        },
        tx,
      );
    });
  }

  async listSwitches(companyId: string) {
    return this.db.select().from(approvalSwitches).where(eq(approvalSwitches.companyId, companyId));
  }

  // ── Workflows ────────────────────────────────────────────────────────────

  async createWorkflow(
    companyId: string,
    input: {
      code: string;
      name: string;
      trigger: string;
      branchId?: string | null;
      priority?: number;
      description?: string;
    },
    actor: Actor,
  ) {
    const trigger = triggerByCode(input.trigger);
    if (!trigger) throw new ApprovalConfigError('NOT_FOUND', `Unknown trigger "${input.trigger}".`);
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) {
      throw new ApprovalConfigError(
        'INVALID_DEFINITION',
        'The code can use letters, numbers, "-" and "_" (up to 40).',
      );
    }
    const [dup] = await this.db
      .select({ id: approvalWorkflows.id })
      .from(approvalWorkflows)
      .where(and(eq(approvalWorkflows.companyId, companyId), eq(approvalWorkflows.code, code)))
      .limit(1);
    if (dup)
      throw new ApprovalConfigError(
        'DUPLICATE_CODE',
        `A workflow with the code ${code} already exists.`,
      );
    const [row] = await this.db
      .insert(approvalWorkflows)
      .values({
        companyId,
        code,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        module: trigger.module,
        trigger: trigger.code,
        branchId: input.branchId ?? null,
        priority: input.priority ?? 100,
        draft: { steps: [] },
      })
      .returning();
    await this.decisions.record({
      companyId,
      actor,
      subject: { type: 'approval_workflow', id: row!.id },
      action: 'approvals.workflow_created',
      to: 'draft',
      outcome: { code },
    });
    return row!;
  }

  async saveDraft(
    companyId: string,
    workflowId: string,
    definition: WorkflowDefinition,
    actor: Actor,
  ) {
    const wf = await this.workflow(companyId, workflowId);
    if (wf.status === 'retired')
      throw new ApprovalConfigError('NOT_EDITABLE', 'A retired workflow cannot be edited.');
    await this.db
      .update(approvalWorkflows)
      .set({ draft: definition as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(approvalWorkflows.id, wf.id));
    await this.decisions.record({
      companyId,
      actor,
      subject: { type: 'approval_workflow', id: wf.id },
      action: 'approvals.workflow_draft_saved',
    });
    return this.check(companyId, wf.trigger, definition);
  }

  async updateWorkflowMeta(
    companyId: string,
    workflowId: string,
    input: {
      name: string;
      description?: string | null;
      priority: number;
      branchId?: string | null;
    },
    actor: Actor,
  ) {
    const wf = await this.workflow(companyId, workflowId);
    if (!input.name.trim())
      throw new ApprovalConfigError('INVALID_DEFINITION', 'Name the workflow.');
    await this.db
      .update(approvalWorkflows)
      .set({
        name: input.name.trim(),
        description: input.description?.trim() || null,
        priority: Math.trunc(input.priority),
        branchId: input.branchId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(approvalWorkflows.id, wf.id));
    await this.decisions.record({
      companyId,
      actor,
      subject: { type: 'approval_workflow', id: wf.id },
      action: 'approvals.workflow_updated',
      outcome: { ...input },
    });
  }

  async getWorkflow(companyId: string, id: string) {
    const wf = await this.workflow(companyId, id);
    const versions = await this.db
      .select()
      .from(approvalWorkflowVersions)
      .where(eq(approvalWorkflowVersions.workflowId, wf.id))
      .orderBy(sql`${approvalWorkflowVersions.version} desc`);
    return { workflow: wf, versions };
  }

  async listProfiles(companyId: string) {
    const profiles = await this.db
      .select()
      .from(approverProfiles)
      .where(eq(approverProfiles.companyId, companyId));
    const limits = profiles.length
      ? await this.db
          .select()
          .from(approverLimits)
          .where(
            inArray(
              approverLimits.profileId,
              profiles.map((p) => p.id),
            ),
          )
      : [];
    return profiles.map((p) => ({ ...p, limits: limits.filter((l) => l.profileId === p.id) }));
  }

  async listGroups(companyId: string) {
    const groups = await this.db
      .select()
      .from(approverGroups)
      .where(eq(approverGroups.companyId, companyId))
      .orderBy(asc(approverGroups.code));
    const members = groups.length
      ? await this.db
          .select()
          .from(approverGroupMembers)
          .where(
            inArray(
              approverGroupMembers.groupId,
              groups.map((g) => g.id),
            ),
          )
          .orderBy(asc(approverGroupMembers.sequence))
      : [];
    return groups.map((g) => ({ ...g, members: members.filter((m) => m.groupId === g.id) }));
  }

  /** Everything wrong with a definition: structure first, then people, groups and chains. */
  async check(
    companyId: string,
    trigger: string,
    def: WorkflowDefinition,
  ): Promise<DefinitionIssue[]> {
    const issues = validateDefinition(trigger, def);
    const t = triggerByCode(trigger);
    if (!t || !Array.isArray(def.steps)) return issues;

    const userIds = def.steps.flatMap((s) =>
      s.approver?.type === 'user' ? [s.approver.userId] : [],
    );
    const groupIds = def.steps.flatMap((s) =>
      s.approver?.type === 'group' ? [s.approver.groupId] : [],
    );
    const found = userIds.length
      ? await this.db
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const groups = groupIds.length
      ? await this.db
          .select({ groupId: approverGroupMembers.groupId, n: sql<number>`count(*)::int` })
          .from(approverGroupMembers)
          .where(inArray(approverGroupMembers.groupId, groupIds))
          .groupBy(approverGroupMembers.groupId)
      : [];
    const groupExists = groupIds.length
      ? await this.db
          .select({ id: approverGroups.id })
          .from(approverGroups)
          .where(and(eq(approverGroups.companyId, companyId), inArray(approverGroups.id, groupIds)))
      : [];

    // How many people hold each role the workflow names (undefined = no such role).
    const roleKeys = [
      ...new Set(
        def.steps.flatMap((s) => (s.approver?.type === 'role' ? [s.approver.roleKey] : [])),
      ),
    ];
    const roleHolderCount = new Map<string, number>();
    if (roleKeys.length) {
      const known = await this.db
        .select({ id: roles.id, key: roles.key })
        .from(roles)
        .where(and(inArray(roles.key, roleKeys), eq(roles.isActive, true)));
      for (const r of known) {
        const [extra] = await this.db
          .select({ n: sql<number>`count(distinct ${userRoles.userId})::int` })
          .from(userRoles)
          .where(eq(userRoles.roleId, r.id));
        const [main] = await this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(eq(users.role, r.key));
        roleHolderCount.set(r.key, (extra?.n ?? 0) + (main?.n ?? 0));
      }
    }

    def.steps.forEach((s, i) => {
      const at = `steps[${i}]`;
      const a = s.approver;
      if (a?.type === 'user') {
        const u = found.find((f) => f.id === a.userId);
        if (!u) issues.push({ path: at, message: 'The chosen approver does not exist.' });
        else if (u.status !== 'active')
          issues.push({ path: at, message: 'The chosen approver is suspended.' });
      }
      if (a?.type === 'group') {
        if (!groupExists.some((g) => g.id === a.groupId))
          issues.push({ path: at, message: 'The chosen approver group does not exist.' });
        else if (!groups.some((g) => g.groupId === a.groupId && g.n > 0))
          issues.push({ path: at, message: 'The chosen approver group has no members.' });
        else if (a.require === 'n_of') {
          const size = groups.find((g) => g.groupId === a.groupId)?.n ?? 0;
          if ((a.count ?? 0) > size)
            issues.push({
              path: at,
              message: `${a.count} approvals are needed but the group only has ${size} member${size === 1 ? '' : 's'}.`,
            });
        }
      }
      if (a?.type === 'role') {
        const holders = roleHolderCount.get(a.roleKey);
        if (holders === undefined)
          issues.push({ path: at, message: `The role "${a.roleKey}" does not exist.` });
        else if (holders === 0)
          issues.push({ path: at, message: `Nobody holds the role "${a.roleKey}" yet.` });
        else if (holders > MAX_ROLE_HOLDERS)
          issues.push({
            path: at,
            message: `${holders} people hold the role "${a.roleKey}". A role step asks everyone at once, so use a group of up to ${MAX_ROLE_HOLDERS} instead.`,
          });
      }
    });

    // A chain must be able to end somewhere: someone must be allowed to approve any amount.
    if (def.steps.some((s) => ['chain_by_limit', 'first_qualified'].includes(s.approver?.type))) {
      const [top] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(approverLimits)
        .innerJoin(approverProfiles, eq(approverProfiles.id, approverLimits.profileId))
        .where(
          and(
            eq(approverProfiles.companyId, companyId),
            eq(approverProfiles.isActive, true),
            eq(approverLimits.documentKind, t.documentKind),
            eq(approverLimits.unlimited, true),
          ),
        );
      if (!top || top.n === 0) {
        issues.push({
          path: 'steps',
          message: `Nobody can approve unlimited ${t.label.toLowerCase()} amounts, so large amounts would have nobody to approve them. Give someone an unlimited limit first.`,
        });
      }
    }
    return issues;
  }

  /** Freezes the draft into a new immutable version and turns the workflow on. */
  async publish(companyId: string, workflowId: string, actor: Actor, reason: Reason) {
    const why = await this.why(companyId, reason);
    const wf = await this.workflow(companyId, workflowId);
    if (wf.status === 'retired')
      throw new ApprovalConfigError('NOT_EDITABLE', 'A retired workflow cannot be published.');
    const def = wf.draft as unknown as WorkflowDefinition;
    const issues = await this.check(companyId, wf.trigger, def);
    if (issues.length > 0) {
      throw new ApprovalConfigError(
        'INVALID_DEFINITION',
        `Fix ${issues.length} problem${issues.length === 1 ? '' : 's'} before publishing.`,
        issues,
      );
    }
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(approvalWorkflows)
        .where(eq(approvalWorkflows.id, wf.id))
        .for('update');
      const [latest] = await tx
        .select({ v: sql<number>`coalesce(max(${approvalWorkflowVersions.version}), 0)::int` })
        .from(approvalWorkflowVersions)
        .where(eq(approvalWorkflowVersions.workflowId, wf.id));
      const version = (latest?.v ?? 0) + 1;
      const [created] = await tx
        .insert(approvalWorkflowVersions)
        .values({
          workflowId: wf.id,
          version,
          definition: def as unknown as Record<string, unknown>,
          publishedBy: actor.id,
          reason: why.text ?? why.code,
        })
        .returning();
      await tx
        .update(approvalWorkflows)
        .set({ currentVersionId: created!.id, status: 'enabled', updatedAt: new Date() })
        .where(eq(approvalWorkflows.id, wf.id));
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'approval_workflow', id: wf.id },
          action: 'approvals.workflow_published',
          from: locked!.status,
          to: 'enabled',
          reason: { code: why.code, text: why.text },
          policy: { id: wf.code, version: String(version) },
          outcome: { version, steps: def.steps.length },
        },
        tx,
      );
      return { version, versionId: created!.id };
    });
  }

  async setWorkflowStatus(
    companyId: string,
    workflowId: string,
    status: 'enabled' | 'disabled' | 'retired',
    actor: Actor,
    reason: Reason,
  ) {
    const why = await this.why(companyId, reason);
    const wf = await this.workflow(companyId, workflowId);
    if (status === 'enabled' && !wf.currentVersionId) {
      throw new ApprovalConfigError('NOT_EDITABLE', 'Publish the workflow before turning it on.');
    }
    await this.db
      .update(approvalWorkflows)
      .set({ status, updatedAt: new Date() })
      .where(eq(approvalWorkflows.id, wf.id));
    await this.decisions.record({
      companyId,
      actor,
      subject: { type: 'approval_workflow', id: wf.id },
      action: `approvals.workflow_${status}`,
      from: wf.status,
      to: status,
      reason: { code: why.code, text: why.text },
    });
  }

  async listWorkflows(companyId: string) {
    return this.db
      .select()
      .from(approvalWorkflows)
      .where(eq(approvalWorkflows.companyId, companyId))
      .orderBy(asc(approvalWorkflows.module), asc(approvalWorkflows.priority));
  }

  private async workflow(companyId: string, id: string) {
    const [wf] = await this.db
      .select()
      .from(approvalWorkflows)
      .where(and(eq(approvalWorkflows.companyId, companyId), eq(approvalWorkflows.id, id)))
      .limit(1);
    if (!wf) throw new ApprovalConfigError('NOT_FOUND', 'Workflow not found.');
    return wf;
  }

  // ── Approvers ────────────────────────────────────────────────────────────

  /** Sets one person's place in the chain, their cover, and what they may approve per document kind. */
  async saveProfile(
    companyId: string,
    input: {
      userId: string;
      approverUserId?: string | null;
      substituteUserId?: string | null;
      substituteFrom?: string | null;
      substituteTo?: string | null;
      isActive?: boolean;
      limits: Array<{ documentKind: string; maxAmount?: number | null; unlimited?: boolean }>;
    },
    actor: Actor,
    reason: Reason,
  ) {
    const why = await this.why(companyId, reason);
    if (input.approverUserId === input.userId) {
      throw new ApprovalConfigError('INVALID_PROFILE', 'Someone cannot be their own approver.');
    }
    if (input.substituteUserId === input.userId) {
      throw new ApprovalConfigError('INVALID_PROFILE', 'Someone cannot be their own substitute.');
    }
    if (input.substituteFrom && input.substituteTo && input.substituteFrom > input.substituteTo) {
      throw new ApprovalConfigError(
        'INVALID_PROFILE',
        'The substitute period ends before it starts.',
      );
    }
    const ids = [input.userId, input.approverUserId, input.substituteUserId].filter(
      (x): x is string => !!x,
    );
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ids));
    if (existing.length !== new Set(ids).size)
      throw new ApprovalConfigError('INVALID_PROFILE', 'One of the people chosen does not exist.');
    for (const l of input.limits) {
      if (!l.unlimited && (l.maxAmount == null || !(l.maxAmount >= 0))) {
        throw new ApprovalConfigError(
          'INVALID_PROFILE',
          `Set a limit (or unlimited) for ${l.documentKind}.`,
        );
      }
    }

    // The chain must not loop back to this person.
    if (input.approverUserId) {
      const seen = new Set<string>([input.userId]);
      let next: string | null = input.approverUserId;
      while (next) {
        if (seen.has(next))
          throw new ApprovalConfigError(
            'INVALID_PROFILE',
            'That would make the approval chain loop back on itself.',
          );
        seen.add(next);
        const [p] = await this.db
          .select({ up: approverProfiles.approverUserId })
          .from(approverProfiles)
          .where(and(eq(approverProfiles.companyId, companyId), eq(approverProfiles.userId, next)))
          .limit(1);
        next = p?.up ?? null;
      }
    }

    await this.db.transaction(async (tx) => {
      const values = {
        approverUserId: input.approverUserId ?? null,
        substituteUserId: input.substituteUserId ?? null,
        substituteFrom: input.substituteFrom ?? null,
        substituteTo: input.substituteTo ?? null,
        isActive: input.isActive ?? true,
        updatedAt: new Date(),
      };
      const [profile] = await tx
        .insert(approverProfiles)
        .values({ companyId, userId: input.userId, ...values })
        .onConflictDoUpdate({
          target: [approverProfiles.companyId, approverProfiles.userId],
          set: values,
        })
        .returning();
      await tx.delete(approverLimits).where(eq(approverLimits.profileId, profile!.id));
      if (input.limits.length) {
        await tx.insert(approverLimits).values(
          input.limits.map((l) => ({
            profileId: profile!.id,
            documentKind: l.documentKind,
            unlimited: l.unlimited === true,
            maxAmount: l.unlimited ? null : String(l.maxAmount),
          })),
        );
      }
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'approver_profile', id: input.userId },
          action: 'approvals.profile_saved',
          reason: { code: why.code, text: why.text },
          outcome: { ...input },
        },
        tx,
      );
    });
  }

  /** Replaces a group's members, in the order given (the order they are asked in). */
  async saveGroup(
    companyId: string,
    input: { id?: string; code: string; name: string; memberUserIds: string[] },
    actor: Actor,
    reason: Reason,
  ) {
    const why = await this.why(companyId, reason);
    const members = [...new Set(input.memberUserIds)];
    if (members.length) {
      const ok = await this.db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, members));
      if (ok.length !== members.length)
        throw new ApprovalConfigError('INVALID_GROUP', 'One of the members does not exist.');
    }
    const code = input.code.trim().toUpperCase();
    return this.db.transaction(async (tx) => {
      let id = input.id;
      if (id) {
        const updated = await tx
          .update(approverGroups)
          .set({ code, name: input.name.trim(), updatedAt: new Date() })
          .where(and(eq(approverGroups.id, id), eq(approverGroups.companyId, companyId)))
          .returning({ id: approverGroups.id });
        if (updated.length === 0) throw new ApprovalConfigError('NOT_FOUND', 'Group not found.');
      } else {
        const [g] = await tx
          .insert(approverGroups)
          .values({ companyId, code, name: input.name.trim() })
          .returning({ id: approverGroups.id });
        id = g!.id;
      }
      await tx.delete(approverGroupMembers).where(eq(approverGroupMembers.groupId, id));
      if (members.length) {
        await tx
          .insert(approverGroupMembers)
          .values(members.map((userId, i) => ({ groupId: id!, userId, sequence: i + 1 })));
      }
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'approver_group', id },
          action: 'approvals.group_saved',
          reason: { code: why.code, text: why.text },
          outcome: { code, members },
        },
        tx,
      );
      return { id };
    });
  }
}
