import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  approvalEntries,
  approvalRequests,
  approvalSwitches,
  approvalWorkflowVersions,
  approvalWorkflows,
  approverGroupMembers,
  approverLimits,
  approverProfiles,
  roles,
  userRoles,
  users,
} from '@/server/db/drizzle/schema';
import type { Actor } from '../context';
import type { DecisionLog } from '../decision-log/service';
import type { ReasonCodes } from '../reason-codes/service';
import { businessDate } from '../numbering/business-date';
import { evaluateCondition } from './domain/conditions';
import { sortedSteps } from './domain/definition';
import {
  NoEligibleApprover,
  nextOffers,
  type ApproverDirectory,
  type StepEntryRecord,
} from './domain/resolve';
import { triggerByCode, TRIGGERS } from './domain/triggers';
import type { StepDefinition, WorkflowDefinition } from './domain/types';

import { has, required, trimToNull } from '@/lib/values';
import { decodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { pageOf, PAGE_SIZE, searchText, type PageInput } from '@/server/domains/settings/paging';

export type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export type ApprovalErrorCode =
  | 'UNKNOWN_TRIGGER'
  | 'ALREADY_PENDING'
  | 'REOPEN_REQUIRED'
  | 'NO_ELIGIBLE_APPROVER'
  | 'ENTRY_NOT_FOUND'
  | 'ALREADY_DECIDED'
  | 'NOT_PENDING'
  | 'NOT_APPROVER'
  | 'NOT_ALLOWED'
  | 'NOT_REJECTED'
  | 'COMMENT_REQUIRED';

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/**
 * How a module takes part. The engine decides; the module owns its document. Every method runs in
 * the transaction that records the decision, so the document and its approval state change together.
 */
export interface DocumentHandler {
  /** The document as it is now, to detect edits made after submission. */
  snapshot?(documentId: string, tx: Tx): Promise<Record<string, unknown>>;
  /** Every approval needed has been given. */
  onReleased(documentId: string, tx: Tx): Promise<void>;
  /** An approver rejected it. The document stays blocked until it is reopened. */
  onRejected(
    documentId: string,
    tx: Tx,
    info: { reasonCode: string; comment: string },
  ): Promise<void>;
  /** The rejection was reopened, or the submission was voided: the document is editable again. */
  onReopened(documentId: string, tx: Tx): Promise<void>;
  /** What the approver is being asked to approve, in plain words (shown in the inbox). */
  describe?(documentId: string): Promise<{ title: string; lines?: string[] } | null>;
  /** The requester or an administrator withdrew the request. */
  onCanceled?(documentId: string, tx: Tx): Promise<void>;
}

export interface SubmitInput {
  companyId: string;
  trigger: string;
  documentId: string;
  branchId?: string | null;
  requestedBy: string;
  /** Base-currency amount; what approver limits are compared with. */
  amount: number;
  /** The document's facts, for conditions. `amount`, `branchId` and `requestedBy` are added. */
  snapshot: Record<string, unknown>;
}

export type SubmitResult =
  | { required: false; reason: 'module_disabled' | 'no_matching_workflow' }
  | {
      required: true;
      submissionId: string;
      requests: { requestId: string; workflowCode: string; status: string }[];
      /** True when every step was skipped, so the document can go ahead immediately. */
      released: boolean;
    };

export interface SimulatedStep {
  sequence: number;
  name: string;
  skipped: boolean;
  approvers: { userId: string; onBehalfOfUserId: string | null }[];
  /** Why nobody could be found, if so; a real submit would fail with this. */
  problem: string | null;
}

export interface Simulation {
  /** False when approvals are switched off for this module or trigger. */
  enabled: boolean;
  workflows: {
    code: string;
    name: string;
    version: number | null;
    matched: boolean;
    trace: { node: string; result: boolean; detail?: string }[];
    steps: SimulatedStep[];
  }[];
}

export type ActResult =
  | { outcome: 'approved'; requestStatus: 'pending' | 'approved'; released: boolean }
  | { outcome: 'rejected' }
  | { outcome: 'superseded'; message: string };

/** The same JSON text for the same facts, whatever order the keys were written in. */
/** When an open entry becomes overdue: the step's due hours from `from`, or never. */
function dueTime(step: StepDefinition, from: Date): Date | null {
  const hours = step.dueAfterHours;
  return hours === undefined || hours === 0 ? null : new Date(from.getTime() + hours * 3_600_000);
}

/** How specifically a switch names the situation: the exact one, the whole area, or another (which does not apply). */
function switchRank(switchTrigger: string | null, trigger: string | null): number {
  if (switchTrigger === trigger) return 2;
  return switchTrigger === null ? 0 : -1;
}

/** How specifically a switch names the branch: all branches, this one, or another (which does not apply). */
function branchRank(switchBranch: string | null, branchId: string | null): number {
  if (switchBranch === null) return 0;
  return switchBranch === branchId ? 1 : -10;
}

export function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

export const hashSnapshot = (snapshot: Record<string, unknown>) =>
  createHash('sha256').update(stableJson(snapshot)).digest('hex');

/** A role asks everyone who holds it at once, so very large roles are capped (use a group instead). */
export const MAX_ROLE_HOLDERS = 25;

type RequestRow = typeof approvalRequests.$inferSelect;
/** Anything that can read: the database or a transaction. */
type Reader = Pick<DrizzleDb, 'select'>;

/**
 * The approval engine. Modules call `submit` at a trigger point; people call `approve`, `reject`,
 * `cancel` and `reopen`. All of it runs in the caller's transaction, so a failure anywhere leaves
 * the document and its approvals exactly as they were.
 */
export class ApprovalEngine {
  private readonly handlers = new Map<string, DocumentHandler>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
  ) {}

  /** A module registers how its documents are locked, released and reopened. */
  registerDocument(documentKind: string, handler: DocumentHandler) {
    this.handlers.set(documentKind, handler);
  }

  private handler(kind: string): DocumentHandler {
    const h = this.handlers.get(kind);
    if (!h)
      throw new ApprovalError('UNKNOWN_TRIGGER', `No module handles approvals for "${kind}".`);
    return h;
  }

  // ── Submitting ───────────────────────────────────────────────────────────

  async submit(input: SubmitInput, tx: Tx): Promise<SubmitResult> {
    const trigger = triggerByCode(input.trigger);
    if (!trigger)
      throw new ApprovalError('UNKNOWN_TRIGGER', `Unknown approval trigger "${input.trigger}".`);
    const { companyId, documentId } = input;
    const kind = trigger.documentKind;
    const subject = { type: kind, id: documentId };

    // One document is one conversation: wait for it, reopen it, or start over, but never both.
    const existing = await tx
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.documentKind, kind),
          eq(approvalRequests.documentId, documentId),
          inArray(approvalRequests.status, ['pending', 'rejected']),
        ),
      );
    if (existing.some((e) => e.status === 'pending')) {
      throw new ApprovalError('ALREADY_PENDING', 'This document is already waiting for approval.');
    }
    if (existing.some((e) => e.status === 'rejected')) {
      throw new ApprovalError(
        'REOPEN_REQUIRED',
        'This document was rejected. Reopen it, make the changes, then submit it again.',
      );
    }

    const facts = {
      ...input.snapshot,
      amount: input.amount,
      branchId: input.branchId ?? null,
      requestedBy: input.requestedBy,
    };

    if (
      !(await this.isEnabled(tx, companyId, trigger.module, trigger.code, input.branchId ?? null))
    ) {
      await this.decisions.record(
        {
          companyId,
          subject,
          action: 'approvals.not_required',
          reason: { text: 'Approvals are switched off for this module or trigger.' },
          inputs: { trigger: trigger.code, branchId: input.branchId ?? null },
        },
        tx,
      );
      return { required: false, reason: 'module_disabled' };
    }

    const candidates = await tx
      .select({ wf: approvalWorkflows, version: approvalWorkflowVersions })
      .from(approvalWorkflows)
      .innerJoin(
        approvalWorkflowVersions,
        eq(approvalWorkflowVersions.id, approvalWorkflows.currentVersionId),
      )
      .where(
        and(
          eq(approvalWorkflows.companyId, companyId),
          eq(approvalWorkflows.trigger, trigger.code),
          eq(approvalWorkflows.status, 'enabled'),
          has(input.branchId)
            ? or(isNull(approvalWorkflows.branchId), eq(approvalWorkflows.branchId, input.branchId))
            : isNull(approvalWorkflows.branchId),
        ),
      )
      .orderBy(asc(approvalWorkflows.priority), asc(approvalWorkflows.code));

    const matched: {
      wf: (typeof candidates)[number]['wf'];
      version: (typeof candidates)[number]['version'];
      matchedOn: unknown[];
    }[] = [];
    for (const c of candidates) {
      const def = c.version.definition as unknown as WorkflowDefinition;
      const trace: Parameters<typeof evaluateCondition>[2] = [];
      if (evaluateCondition(def.conditions, facts, trace)) matched.push({ ...c, matchedOn: trace });
    }

    if (matched.length === 0) {
      await this.decisions.record(
        {
          companyId,
          subject,
          action: 'approvals.not_required',
          reason: { text: 'No enabled workflow matched this document.' },
          inputs: { trigger: trigger.code, considered: candidates.map((c) => c.wf.code), facts },
        },
        tx,
      );
      return { required: false, reason: 'no_matching_workflow' };
    }

    const directory = await this.loadDirectory(
      tx,
      companyId,
      kind,
      matched.map((m) => m.version.definition as unknown as WorkflowDefinition),
    );
    const [previous] = await tx
      .select({ id: approvalRequests.id, attempt: approvalRequests.attempt })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.documentKind, kind),
          eq(approvalRequests.documentId, documentId),
        ),
      )
      .orderBy(sql`${approvalRequests.attempt} desc`, sql`${approvalRequests.createdAt} desc`)
      .limit(1);

    const submissionId = randomUUID();
    const hash = hashSnapshot(facts);
    const out: Extract<SubmitResult, { required: true }>['requests'] = [];
    let allApproved = true;

    for (const m of matched) {
      const def = m.version.definition as unknown as WorkflowDefinition;
      const steps = sortedSteps(def);
      const [request] = await tx
        .insert(approvalRequests)
        .values({
          companyId,
          submissionId,
          workflowId: m.wf.id,
          workflowVersionId: m.version.id,
          trigger: trigger.code,
          documentKind: kind,
          documentId,
          branchId: input.branchId ?? null,
          requestedBy: input.requestedBy,
          amount: input.amount.toFixed(2),
          snapshot: facts,
          documentHash: hash,
          currentStep: required(steps[0], 'the first step').sequence,
          previousRequestId: previous?.id ?? null,
          attempt: (previous?.attempt ?? 0) + 1,
        })
        .returning();
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'approval_request', id: required(request, 'the saved request').id },
          action: 'approvals.requested',
          to: 'pending',
          reason: {
            text: `Workflow "${m.wf.name}" (v${m.version.version}) applies to this document.`,
          },
          policy: { id: m.wf.code, version: String(m.version.version) },
          inputs: { document: subject, matchedOn: m.matchedOn, amount: input.amount },
        },
        tx,
      );
      const saved = required(request, 'the saved request');
      const state = await this.advance(tx, saved, def, directory);
      if (state !== 'approved') allApproved = false;
      out.push({
        requestId: saved.id,
        workflowCode: m.wf.code,
        status: state === 'approved' ? 'approved' : 'pending',
      });
    }

    if (allApproved) {
      await this.handler(kind).onReleased(documentId, tx);
      await this.decisions.record(
        {
          companyId,
          subject,
          action: 'approvals.released',
          reason: { text: 'Every step was skipped.' },
          outcome: { submissionId },
        },
        tx,
      );
    }
    return { required: true, submissionId, requests: out, released: allApproved };
  }

  // ── Acting ───────────────────────────────────────────────────────────────

  async approve(
    entryId: string,
    userId: string,
    comment: string | null,
    tx: Tx,
  ): Promise<ActResult> {
    const { entry, request } = await this.lockEntry(tx, entryId);
    this.assertCanAct(entry, request, userId);

    const changed = await this.changedSince(tx, request);
    if (changed) {
      await this.voidSubmission(
        tx,
        request,
        'The document was changed after it was submitted.',
        userId,
      );
      return {
        outcome: 'superseded',
        message:
          'The document changed after it was submitted, so this approval was voided. It must be submitted again.',
      };
    }

    const step = this.stepOf(await this.definitionOf(tx, request), request.currentStep);
    await tx
      .update(approvalEntries)
      .set({ status: 'approved', comment: trimToNull(comment), actedAt: new Date() })
      .where(eq(approvalEntries.id, entry.id));
    // "Any one" steps (a group, or everyone holding a role): the first to act decides and the
    // others' entries are withdrawn. "N of" steps finish once enough have approved.
    const rule = step.approver;
    let withdraw = rule.type === 'role' || (rule.type === 'group' && rule.require === 'any_one');
    if (rule.type === 'group' && rule.require === 'n_of') {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(approvalEntries)
        .where(
          and(
            eq(approvalEntries.requestId, request.id),
            eq(approvalEntries.stepSequence, request.currentStep),
            eq(approvalEntries.status, 'approved'),
          ),
        );
      withdraw = n >= (rule.count ?? 1);
    }
    if (withdraw) {
      await tx
        .update(approvalEntries)
        .set({
          status: 'canceled',
          actedAt: new Date(),
          comment: 'Enough approvals were already given.',
        })
        .where(
          and(
            eq(approvalEntries.requestId, request.id),
            eq(approvalEntries.stepSequence, request.currentStep),
            eq(approvalEntries.status, 'open'),
          ),
        );
    }
    await this.decisions.record(
      {
        companyId: request.companyId,
        subject: { type: 'approval_request', id: request.id },
        action: 'approvals.entry_approved',
        actor: { type: 'user', id: userId },
        reason: { text: trimToNull(comment) },
        inputs: {
          step: request.currentStep,
          entryId: entry.id,
          onBehalfOf: entry.onBehalfOfUserId,
        },
      },
      tx,
    );

    const def = await this.definitionOf(tx, request);
    const directory = await this.loadDirectory(tx, request.companyId, request.documentKind, [def]);
    const state = await this.advance(tx, request, def, directory);
    let released = false;
    if (state === 'approved') released = await this.releaseIfAllApproved(tx, request);
    return {
      outcome: 'approved',
      requestStatus: state === 'approved' ? 'approved' : 'pending',
      released,
    };
  }

  async reject(
    entryId: string,
    userId: string,
    input: { reasonCode: string; comment: string },
    tx: Tx,
  ): Promise<ActResult> {
    const { entry, request } = await this.lockEntry(tx, entryId);
    this.assertCanAct(entry, request, userId);
    const comment = input.comment.trim();
    if (!has(comment))
      throw new ApprovalError('COMMENT_REQUIRED', 'Say why you are rejecting this request.');
    const reason = await this.reasons.require(
      request.companyId,
      { code: input.reasonCode, text: comment },
      'approval_rejection',
    );

    const now = new Date();
    await tx
      .update(approvalEntries)
      .set({ status: 'rejected', comment, reasonCode: reason.code, actedAt: now })
      .where(eq(approvalEntries.id, entry.id));
    await this.closeRequest(tx, request, 'rejected', 'Rejected by an approver.');
    await this.decisions.record(
      {
        companyId: request.companyId,
        subject: { type: 'approval_request', id: request.id },
        action: 'approvals.entry_rejected',
        actor: { type: 'user', id: userId },
        from: 'pending',
        to: 'rejected',
        reason: { code: reason.code, text: comment },
        inputs: { step: request.currentStep, entryId: entry.id },
      },
      tx,
    );

    // Siblings in the same submission can no longer succeed: withdraw them.
    const siblings = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.submissionId, request.submissionId),
          eq(approvalRequests.status, 'pending'),
        ),
      );
    for (const s of siblings) {
      await this.closeRequest(
        tx,
        s,
        'canceled',
        'Another request in the same submission was rejected.',
      );
      await this.decisions.record(
        {
          companyId: s.companyId,
          subject: { type: 'approval_request', id: s.id },
          action: 'approvals.canceled',
          from: 'pending',
          to: 'canceled',
          reason: { text: 'Another request for this document was rejected.' },
        },
        tx,
      );
    }
    await this.handler(request.documentKind).onRejected(request.documentId, tx, {
      reasonCode: reason.code,
      comment,
    });
    return { outcome: 'rejected' };
  }

  /** Withdraws a pending submission. Only the requester, or an administrator, may. */
  async cancel(
    submissionId: string,
    actor: { userId: string; isAdmin?: boolean },
    reason: { text: string },
    tx: Tx,
  ): Promise<void> {
    const pending = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.submissionId, submissionId),
          eq(approvalRequests.status, 'pending'),
        ),
      )
      .for('update');
    if (pending.length === 0)
      throw new ApprovalError('NOT_PENDING', 'Nothing in this submission is waiting for approval.');
    const first = required(pending[0], 'the first pending request');
    if (actor.isAdmin !== true && first.requestedBy !== actor.userId) {
      throw new ApprovalError(
        'NOT_ALLOWED',
        'Only the person who submitted it, or an administrator, can withdraw this request.',
      );
    }
    if (!has(reason.text.trim()))
      throw new ApprovalError('COMMENT_REQUIRED', 'Say why the request is being withdrawn.');
    for (const r of pending) {
      await this.closeRequest(tx, r, 'canceled', reason.text.trim());
      await this.decisions.record(
        {
          companyId: r.companyId,
          subject: { type: 'approval_request', id: r.id },
          action: 'approvals.canceled',
          actor: { type: 'user', id: actor.userId },
          from: 'pending',
          to: 'canceled',
          reason: { text: reason.text.trim() },
        },
        tx,
      );
    }
    const h = this.handler(first.documentKind);
    await (h.onCanceled ?? h.onReopened)(first.documentId, tx);
  }

  /**
   * The document was edited while it waited, so what the approvers were shown no longer applies:
   * close the pending requests as superseded and tell nobody else. The caller (the module saving
   * the edit) sets the document's own state and then submits it afresh.
   */
  async supersedePending(
    companyId: string,
    documentKind: string,
    documentId: string,
    actor: { userId: string },
    why: string,
    tx: Tx,
    /**
     * Also close a refusal the author has moved past, so it does not block the next submit. Leave
     * false when the document will be submitted again: a refusal must then be reopened first.
     */
    closeRefusals = false,
  ): Promise<number> {
    const pending = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.documentKind, documentKind),
          eq(approvalRequests.documentId, documentId),
          eq(approvalRequests.status, 'pending'),
        ),
      )
      .for('update');
    for (const r of pending) {
      await this.closeRequest(tx, r, 'superseded', why);
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'approval_request', id: r.id },
          action: 'approvals.superseded',
          actor: { type: 'user', id: actor.userId },
          from: 'pending',
          to: 'superseded',
          reason: { text: why },
        },
        tx,
      );
    }
    const refused = closeRefusals
      ? await tx
          .update(approvalRequests)
          .set({ status: 'reopened' })
          .where(
            and(
              eq(approvalRequests.companyId, companyId),
              eq(approvalRequests.documentKind, documentKind),
              eq(approvalRequests.documentId, documentId),
              eq(approvalRequests.status, 'rejected'),
            ),
          )
          .returning({ id: approvalRequests.id })
      : [];
    for (const r of refused) {
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'approval_request', id: r.id },
          action: 'approvals.reopened',
          actor: { type: 'user', id: actor.userId },
          from: 'rejected',
          to: 'reopened',
          reason: { text: why },
        },
        tx,
      );
    }
    return pending.length;
  }

  /**
   * Opens a rejected document for editing. Nothing carries over: the next submit is a fresh
   * request, linked to this one so approvers can see the earlier rejection.
   */
  async reopen(
    documentKind: string,
    documentId: string,
    actor: { userId: string; isAdmin?: boolean },
    reason: { text: string },
    tx: Tx,
    companyId: string,
  ): Promise<void> {
    const rejected = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.documentKind, documentKind),
          eq(approvalRequests.documentId, documentId),
          eq(approvalRequests.status, 'rejected'),
        ),
      )
      .for('update');
    if (rejected.length === 0)
      throw new ApprovalError('NOT_REJECTED', 'This document has no rejected request to reopen.');
    if (actor.isAdmin !== true && !rejected.some((r) => r.requestedBy === actor.userId)) {
      throw new ApprovalError(
        'NOT_ALLOWED',
        'Only the person who submitted it, or an administrator, can reopen this request.',
      );
    }
    if (!has(reason.text.trim()))
      throw new ApprovalError('COMMENT_REQUIRED', 'Say why the request is being reopened.');
    for (const r of rejected) {
      await tx
        .update(approvalRequests)
        .set({ status: 'reopened' })
        .where(and(eq(approvalRequests.id, r.id), eq(approvalRequests.status, 'rejected')));
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'approval_request', id: r.id },
          action: 'approvals.reopened',
          actor: { type: 'user', id: actor.userId },
          from: 'rejected',
          to: 'reopened',
          reason: { text: reason.text.trim() },
        },
        tx,
      );
    }
    await this.handler(documentKind).onReopened(documentId, tx);
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Open entries waiting on this person, oldest first. */
  async inbox(userId: string, limit = 50) {
    return await this.db
      .select({
        entryId: approvalEntries.id,
        requestId: approvalRequests.id,
        documentKind: approvalRequests.documentKind,
        documentId: approvalRequests.documentId,
        trigger: approvalRequests.trigger,
        amount: approvalRequests.amount,
        requestedBy: approvalRequests.requestedBy,
        step: approvalEntries.stepSequence,
        onBehalfOfUserId: approvalEntries.onBehalfOfUserId,
        dueAt: approvalEntries.dueAt,
        replacesEntryId: approvalEntries.replacesEntryId,
        waitingSince: approvalEntries.createdAt,
      })
      .from(approvalEntries)
      .innerJoin(approvalRequests, eq(approvalRequests.id, approvalEntries.requestId))
      .where(and(eq(approvalEntries.approverUserId, userId), eq(approvalEntries.status, 'open')))
      .orderBy(asc(approvalEntries.createdAt))
      .limit(limit);
  }

  /**
   * One page of what waits on this person, oldest first. The text matches the document or the situation's
   * name; `overdueOnly` keeps entries past their due time. The cursor keeps the time to the microsecond.
   */
  async inboxPage(userId: string, input: PageInput & { overdueOnly?: boolean }) {
    const decoded = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const text = searchText(input);
    const pattern = `%${escapeLike(text)}%`;
    const triggers = text === '' ? [] : TRIGGERS.filter((t) => t.label.toLowerCase().includes(text.toLowerCase())).map((t) => t.code);
    const matches = text === ''
      ? undefined
      : or(ilike(approvalRequests.documentId, pattern), triggers.length > 0 ? inArray(approvalRequests.trigger, triggers) : undefined);
    const stamp = sql<string>`to_char(${approvalEntries.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const found = await this.db
      .select({
        entryId: approvalEntries.id,
        requestId: approvalRequests.id,
        documentKind: approvalRequests.documentKind,
        documentId: approvalRequests.documentId,
        trigger: approvalRequests.trigger,
        amount: approvalRequests.amount,
        requestedBy: approvalRequests.requestedBy,
        step: approvalEntries.stepSequence,
        onBehalfOfUserId: approvalEntries.onBehalfOfUserId,
        dueAt: approvalEntries.dueAt,
        replacesEntryId: approvalEntries.replacesEntryId,
        waitingSince: approvalEntries.createdAt,
        stamp,
      })
      .from(approvalEntries)
      .innerJoin(approvalRequests, eq(approvalRequests.id, approvalEntries.requestId))
      .where(
        and(
          eq(approvalEntries.approverUserId, userId),
          eq(approvalEntries.status, 'open'),
          input.overdueOnly === true ? sql`${approvalEntries.dueAt} is not null and ${approvalEntries.dueAt} < now()` : undefined,
          matches,
          decoded === null ? undefined : sql`(${approvalEntries.createdAt}, ${approvalEntries.id}) > (${decoded.k}::timestamptz, ${decoded.id}::uuid)`,
        ),
      )
      .orderBy(asc(approvalEntries.createdAt), asc(approvalEntries.id))
      .limit(PAGE_SIZE + 1);
    return pageOf(found, PAGE_SIZE, (r) => ({ k: r.stamp, id: r.entryId }));
  }

  /** How many approvals wait on this person, and how many of them are overdue. */
  async inboxCounts(userId: string): Promise<{ waiting: number; overdue: number }> {
    const [row] = await this.db
      .select({
        waiting: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${approvalEntries.dueAt} is not null and ${approvalEntries.dueAt} < now())::int`,
      })
      .from(approvalEntries)
      .where(and(eq(approvalEntries.approverUserId, userId), eq(approvalEntries.status, 'open')));
    return { waiting: row?.waiting ?? 0, overdue: row?.overdue ?? 0 };
  }

  /** One page of what this person has sent for approval, newest first, narrowed by status. */
  async requestsPage(companyId: string, userId: string, input: PageInput & { status?: 'pending' | 'rejected' | 'approved' }) {
    const decoded = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const stamp = sql<string>`to_char(${approvalRequests.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const found = await this.db
      .select({ request: approvalRequests, stamp })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.requestedBy, userId),
          input.status === undefined ? undefined : eq(approvalRequests.status, input.status),
          decoded === null ? undefined : sql`(${approvalRequests.createdAt}, ${approvalRequests.id}) < (${decoded.k}::timestamptz, ${decoded.id}::uuid)`,
        ),
      )
      .orderBy(sql`${approvalRequests.createdAt} desc`, sql`${approvalRequests.id} desc`)
      .limit(PAGE_SIZE + 1);
    const page = pageOf(found, PAGE_SIZE, (r) => ({ k: r.stamp, id: r.request.id }));
    return { rows: await this.withOpenEntries(page.rows.map((r) => r.request)), nextCursor: page.nextCursor };
  }

  /** What is going on with one document: its requests, entries and the reasons behind them. */
  async forDocument(companyId: string, documentKind: string, documentId: string) {
    const requests = await this.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.documentKind, documentKind),
          eq(approvalRequests.documentId, documentId),
        ),
      )
      .orderBy(asc(approvalRequests.createdAt));
    const entries = requests.length !== 0
      ? await this.db
          .select()
          .from(approvalEntries)
          .where(
            inArray(
              approvalEntries.requestId,
              requests.map((r) => r.id),
            ),
          )
          .orderBy(asc(approvalEntries.createdAt))
      : [];
    return requests.map((r) => ({ ...r, entries: entries.filter((e) => e.requestId === r.id) }));
  }

  /**
   * What would happen to a document, without writing anything: which workflows apply and who would
   * be asked at each step, using today's configuration. `draft` tries a definition that is not
   * published yet (and, with `onlyDraft`, ignores the published ones).
   */
  async simulate(
    input: SubmitInput & { draft?: WorkflowDefinition; onlyDraft?: boolean },
  ): Promise<Simulation> {
    const trigger = triggerByCode(input.trigger);
    if (!trigger)
      throw new ApprovalError('UNKNOWN_TRIGGER', `Unknown approval trigger "${input.trigger}".`);
    const facts = {
      ...input.snapshot,
      amount: input.amount,
      branchId: input.branchId ?? null,
      requestedBy: input.requestedBy,
    };
    const enabled = await this.isEnabled(
      this.db,
      input.companyId,
      trigger.module,
      trigger.code,
      input.branchId ?? null,
    );

    const candidates: {
      code: string;
      name: string;
      version: number | null;
      def: WorkflowDefinition;
    }[] = [];
    if (input.onlyDraft !== true) {
      const rows = await this.db
        .select({ wf: approvalWorkflows, version: approvalWorkflowVersions })
        .from(approvalWorkflows)
        .innerJoin(
          approvalWorkflowVersions,
          eq(approvalWorkflowVersions.id, approvalWorkflows.currentVersionId),
        )
        .where(
          and(
            eq(approvalWorkflows.companyId, input.companyId),
            eq(approvalWorkflows.trigger, trigger.code),
            eq(approvalWorkflows.status, 'enabled'),
            has(input.branchId)
              ? or(
                  isNull(approvalWorkflows.branchId),
                  eq(approvalWorkflows.branchId, input.branchId),
                )
              : isNull(approvalWorkflows.branchId),
          ),
        )
        .orderBy(asc(approvalWorkflows.priority), asc(approvalWorkflows.code));
      for (const r of rows) {
        candidates.push({
          code: r.wf.code,
          name: r.wf.name,
          version: r.version.version,
          def: r.version.definition as unknown as WorkflowDefinition,
        });
      }
    }
    if (input.draft)
      candidates.push({ code: 'DRAFT', name: 'This draft', version: null, def: input.draft });

    const directory = await this.loadDirectory(
      this.db,
      input.companyId,
      trigger.documentKind,
      candidates.map((c) => c.def),
    );
    const workflows: Simulation['workflows'] = candidates.map((c) => {
      const trace: Parameters<typeof evaluateCondition>[2] = [];
      const matched = evaluateCondition(c.def.conditions, facts, trace);
      const steps: SimulatedStep[] = [];
      if (matched) {
        for (const step of sortedSteps(c.def)) {
          if (step.skipIf && evaluateCondition(step.skipIf, facts)) {
            steps.push({
              sequence: step.sequence,
              name: step.name,
              skipped: true,
              approvers: [],
              problem: null,
            });
            continue;
          }
          const entries: StepEntryRecord[] = [];
          const approvers: SimulatedStep['approvers'] = [];
          let problem: string | null = null;
          try {
            for (let guard = 0; guard < 50; guard++) {
              const offer = nextOffers({
                step,
                directory: directory.directory,
                requesterId: input.requestedBy,
                documentKind: trigger.documentKind,
                amount: input.amount,
                entries,
              });
              if (offer.done) break;
              for (const o of offer.offers) {
                const cover = directory.substituteFor(
                  o.userId,
                  input.requestedBy,
                  step.allowSelfApproval === true,
                );
                approvers.push({
                  userId: cover ?? o.userId,
                  onBehalfOfUserId: has(cover) ? o.userId : null,
                });
                entries.push({
                  position: o.position,
                  approverUserId: cover ?? o.userId,
                  onBehalfOfUserId: has(cover) ? o.userId : null,
                  status: 'approved',
                });
              }
            }
          } catch (error) {
            if (!(error instanceof NoEligibleApprover)) throw error;
            problem = error.message;
          }
          steps.push({
            sequence: step.sequence,
            name: step.name,
            skipped: false,
            approvers,
            problem,
          });
        }
      }
      return { code: c.code, name: c.name, version: c.version, matched, trace, steps };
    });
    return { enabled, workflows };
  }

  /**
   * Would approval be needed for this? Reads only, so a module can decide whether to park an
   * action for approval before it writes anything.
   */
  async wouldRequire(input: SubmitInput): Promise<boolean> {
    const trigger = triggerByCode(input.trigger);
    if (!trigger)
      throw new ApprovalError('UNKNOWN_TRIGGER', `Unknown approval trigger "${input.trigger}".`);
    if (
      !(await this.isEnabled(
        this.db,
        input.companyId,
        trigger.module,
        trigger.code,
        input.branchId ?? null,
      ))
    ) {
      return false;
    }
    const facts = {
      ...input.snapshot,
      amount: input.amount,
      branchId: input.branchId ?? null,
      requestedBy: input.requestedBy,
    };
    const rows = await this.db
      .select({ definition: approvalWorkflowVersions.definition })
      .from(approvalWorkflows)
      .innerJoin(
        approvalWorkflowVersions,
        eq(approvalWorkflowVersions.id, approvalWorkflows.currentVersionId),
      )
      .where(
        and(
          eq(approvalWorkflows.companyId, input.companyId),
          eq(approvalWorkflows.trigger, trigger.code),
          eq(approvalWorkflows.status, 'enabled'),
          has(input.branchId)
            ? or(isNull(approvalWorkflows.branchId), eq(approvalWorkflows.branchId, input.branchId))
            : isNull(approvalWorkflows.branchId),
        ),
      );
    return rows.some((r) =>
      evaluateCondition((r.definition as unknown as WorkflowDefinition).conditions, facts),
    );
  }

  /** Everything the approver needs to decide: the facts as submitted, every step, and the reasons so far. */
  async requestDetail(companyId: string, requestId: string) {
    const [request] = await this.db
      .select({
        request: approvalRequests,
        workflowName: approvalWorkflows.name,
        workflowCode: approvalWorkflows.code,
        version: approvalWorkflowVersions.version,
        definition: approvalWorkflowVersions.definition,
      })
      .from(approvalRequests)
      .innerJoin(approvalWorkflows, eq(approvalWorkflows.id, approvalRequests.workflowId))
      .innerJoin(
        approvalWorkflowVersions,
        eq(approvalWorkflowVersions.id, approvalRequests.workflowVersionId),
      )
      .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.companyId, companyId)))
      .limit(1);
    if (!request) return null;
    const entries = await this.db
      .select()
      .from(approvalEntries)
      .where(eq(approvalEntries.requestId, requestId))
      .orderBy(asc(approvalEntries.createdAt), asc(approvalEntries.position));
    const timeline = await this.decisions.timeline('approval_request', requestId);
    const what = await this.handlers
      .get(request.request.documentKind)
      ?.describe?.(request.request.documentId);
    return { ...request, entries, timeline, what: what ?? null };
  }

  /** Requests this person submitted, newest first. */
  async requestsBy(companyId: string, userId: string, limit = 100) {
    const requests = await this.db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.requestedBy, userId)),
      )
      .orderBy(sql`${approvalRequests.createdAt} desc`)
      .limit(limit);
    return await this.withOpenEntries(requests);
  }

  /** Everything waiting on someone, oldest first (the administrator's monitor). */
  async pending(companyId: string, limit = 200) {
    const requests = await this.db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, 'pending')))
      .orderBy(asc(approvalRequests.createdAt))
      .limit(limit);
    return await this.withOpenEntries(requests);
  }

  /** One page of what is waiting, oldest first, with each request's open entries. */
  async pendingPage(companyId: string, input: PageInput & { overdueOnly?: boolean }) {
    const decoded = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const overdue = input.overdueOnly === true
      ? sql`exists (select 1 from approval_entries e where e.request_id = approval_requests.id and e.status = 'open' and e.due_at is not null and e.due_at < now())`
      : undefined;
    // The cursor keeps the time to the microsecond, as the database does; cut to milliseconds it would repeat rows.
    const stamp = sql<string>`to_char(${approvalRequests.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const found = await this.db
      .select({ request: approvalRequests, stamp })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.status, 'pending'),
          overdue,
          decoded === null ? undefined : sql`(${approvalRequests.createdAt}, ${approvalRequests.id}) > (${decoded.k}::timestamptz, ${decoded.id}::uuid)`,
        ),
      )
      .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id))
      .limit(PAGE_SIZE + 1);
    const page = pageOf(found, PAGE_SIZE, (r) => ({ k: r.stamp, id: r.request.id }));
    return { rows: await this.withOpenEntries(page.rows.map((r) => r.request)), nextCursor: page.nextCursor };
  }

  /** How many requests are waiting, and how many of them have an overdue entry. */
  async pendingCounts(companyId: string): Promise<{ waiting: number; overdue: number }> {
    const [row] = await this.db
      .select({
        waiting: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where exists (select 1 from approval_entries e where e.request_id = approval_requests.id and e.status = 'open' and e.due_at is not null and e.due_at < now()))::int`,
      })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, 'pending')));
    return { waiting: row?.waiting ?? 0, overdue: row?.overdue ?? 0 };
  }

  private async withOpenEntries(requests: RequestRow[]) {
    const open = requests.length !== 0
      ? await this.db
          .select()
          .from(approvalEntries)
          .where(
            and(
              inArray(
                approvalEntries.requestId,
                requests.map((r) => r.id),
              ),
              eq(approvalEntries.status, 'open'),
            ),
          )
      : [];
    return requests.map((r) => ({ ...r, openEntries: open.filter((e) => e.requestId === r.id) }));
  }

  // ── Overdue handling and rerouting ───────────────────────────────────────

  /**
   * Finds open entries that are past their due time and hands each to the approver's own approver,
   * the next person up their chain. Safe to run as often as you like, and from several workers at
   * once: each entry is decided under the request's lock and is only ever escalated once.
   */
  async sweepOverdue(
    opts: { now?: Date; limit?: number } = {},
  ): Promise<{ escalated: number; stuck: number; failed: number }> {
    const now = opts.now ?? new Date();
    const due = await this.db
      .select({ id: approvalEntries.id })
      .from(approvalEntries)
      .innerJoin(approvalRequests, eq(approvalRequests.id, approvalEntries.requestId))
      .where(
        and(
          eq(approvalEntries.status, 'open'),
          isNull(approvalEntries.escalatedAt),
          lt(approvalEntries.dueAt, now),
          eq(approvalRequests.status, 'pending'),
        ),
      )
      .orderBy(asc(approvalEntries.dueAt))
      .limit(opts.limit ?? 200);

    const result = { escalated: 0, stuck: 0, failed: 0 };
    for (const { id } of due) {
      try {
        const outcome = await this.db.transaction((tx) => this.escalateEntry(tx, id, now));
        if (outcome === 'escalated') result.escalated++;
        else if (outcome === 'stuck') result.stuck++;
      } catch (error) {
        // One bad entry must not stop the rest; it is tried again on the next sweep.
        result.failed++;
        console.error('[approvals] escalation failed', id, error);
      }
    }
    return result;
  }

  private async escalateEntry(
    tx: Tx,
    entryId: string,
    now: Date,
  ): Promise<'escalated' | 'stuck' | 'skipped'> {
    const { entry, request } = await this.lockEntry(tx, entryId);
    // Someone may have acted, or another worker got here first, since the sweep looked.
    if (entry.status !== 'open' || entry.escalatedAt !== null || request.status !== 'pending')
      return 'skipped';

    const def = await this.definitionOf(tx, request);
    const step = this.stepOf(def, entry.stepSequence);
    const directory = await this.loadDirectory(tx, request.companyId, request.documentKind, [def]);
    const stepEntries = await tx
      .select()
      .from(approvalEntries)
      .where(
        and(
          eq(approvalEntries.requestId, request.id),
          eq(approvalEntries.stepSequence, entry.stepSequence),
        ),
      );

    const allowSelf = step.allowSelfApproval === true;
    const asked = new Set(
      stepEntries.flatMap((e) => [e.approverUserId, e.onBehalfOfUserId ?? e.approverUserId]),
    );
    const visited = new Set<string>([request.requestedBy, ...asked]);
    const needsLimit =
      step.approver.type === 'first_qualified' || step.approver.type === 'chain_by_limit';
    let from = entry.onBehalfOfUserId ?? entry.approverUserId;
    let target: string | null = null;
    for (let hops = 0; hops < 100; hops++) {
      const next = directory.directory.approverOf(from);
      if (!has(next)) break;
      from = next;
      if (visited.has(next)) continue;
      visited.add(next);
      if (!directory.directory.isEligible(next) || (!allowSelf && next === request.requestedBy))
        continue;
      // A chain wants someone whose limit covers the amount; a plain step takes the next person.
      if (
        needsLimit &&
        step.approver.type === 'first_qualified' &&
        !directory.directory.qualifies(next, request.documentKind, Number(request.amount))
      )
        continue;
      target = next;
      break;
    }

    const subject = { type: 'approval_request', id: request.id };
    if (!has(target)) {
      await tx
        .update(approvalEntries)
        .set({ escalatedAt: now })
        .where(eq(approvalEntries.id, entry.id));
      await this.decisions.record(
        {
          companyId: request.companyId,
          actor: { type: 'job', id: 'approvals-sweep' },
          subject,
          action: 'approvals.escalation_failed',
          reason: {
            text: 'Overdue, but nobody above the approver can take it. An administrator needs to reroute it.',
          },
          inputs: { entryId: entry.id, step: entry.stepSequence },
        },
        tx,
      );
      return 'stuck';
    }

    const cover = directory.substituteFor(target, request.requestedBy, allowSelf);
    const approver = cover ?? target;
    await tx
      .update(approvalEntries)
      .set({
        status: 'canceled',
        actedAt: now,
        escalatedAt: now,
        comment: 'Escalated: not answered in time.',
      })
      .where(eq(approvalEntries.id, entry.id));
    await tx.insert(approvalEntries).values({
      requestId: request.id,
      stepSequence: entry.stepSequence,
      position: entry.position,
      approverUserId: approver,
      onBehalfOfUserId: has(cover) ? target : null,
      dueAt: dueTime(step, now),
      replacesEntryId: entry.id,
    });
    await this.decisions.record(
      {
        companyId: request.companyId,
        actor: { type: 'job', id: 'approvals-sweep' },
        subject,
        action: 'approvals.escalated',
        reason: { text: 'Not answered in time, so it went to the approver’s own approver.' },
        inputs: {
          entryId: entry.id,
          from: entry.approverUserId,
          to: approver,
          step: entry.stepSequence,
        },
      },
      tx,
    );
    return 'escalated';
  }

  /**
   * An administrator hands an open entry to someone else (the approver left, is unreachable, or
   * nobody was left to escalate to). The old entry is closed, the new one takes its place, and both
   * are on the record with the reason.
   */
  async reroute(
    entryId: string,
    toUserId: string,
    actor: { userId: string },
    reason: { code: string; text?: string | null },
    tx: Tx,
  ): Promise<void> {
    const { entry, request } = await this.lockEntry(tx, entryId);
    if (entry.status !== 'open')
      throw new ApprovalError('ALREADY_DECIDED', 'This approval has already been decided.');
    if (request.status !== 'pending')
      throw new ApprovalError('NOT_PENDING', 'This request is no longer waiting for approval.');
    const why = await this.reasons.require(request.companyId, reason, 'approval_reroute');

    const def = await this.definitionOf(tx, request);
    const step = this.stepOf(def, entry.stepSequence);
    const directory = await this.loadDirectory(tx, request.companyId, request.documentKind, [def]);
    if (!directory.directory.isEligible(toUserId)) {
      throw new ApprovalError(
        'NO_ELIGIBLE_APPROVER',
        'That person cannot approve (they are inactive or suspended).',
      );
    }
    if (toUserId === request.requestedBy && step.allowSelfApproval !== true) {
      throw new ApprovalError(
        'NO_ELIGIBLE_APPROVER',
        'A requester cannot approve their own request.',
      );
    }
    const [already] = await tx
      .select({ id: approvalEntries.id })
      .from(approvalEntries)
      .where(
        and(
          eq(approvalEntries.requestId, request.id),
          eq(approvalEntries.stepSequence, entry.stepSequence),
          eq(approvalEntries.approverUserId, toUserId),
          eq(approvalEntries.status, 'open'),
        ),
      )
      .limit(1);
    if (already)
      throw new ApprovalError('NOT_ALLOWED', 'That person is already asked to approve this step.');

    const now = new Date();
    await tx
      .update(approvalEntries)
      .set({
        status: 'canceled',
        actedAt: now,
        escalatedAt: now,
        comment: `Rerouted by an administrator: ${why.text ?? why.code}`,
      })
      .where(eq(approvalEntries.id, entry.id));
    await tx.insert(approvalEntries).values({
      requestId: request.id,
      stepSequence: entry.stepSequence,
      position: entry.position,
      approverUserId: toUserId,
      dueAt: dueTime(step, now),
      replacesEntryId: entry.id,
    });
    await this.decisions.record(
      {
        companyId: request.companyId,
        actor: { type: 'user', id: actor.userId },
        subject: { type: 'approval_request', id: request.id },
        action: 'approvals.rerouted',
        reason: { code: why.code, text: why.text },
        inputs: {
          entryId: entry.id,
          from: entry.approverUserId,
          to: toUserId,
          step: entry.stepSequence,
        },
      },
      tx,
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async isEnabled(
    tx: Reader,
    companyId: string,
    module: string,
    trigger: string,
    branchId: string | null,
  ) {
    const rows = await tx
      .select()
      .from(approvalSwitches)
      .where(and(eq(approvalSwitches.companyId, companyId), eq(approvalSwitches.module, module)));
    // The most specific switch wins: trigger+branch, trigger, module+branch, module.
    const rank = (r: (typeof rows)[number]) => switchRank(r.trigger, trigger) * 2 + branchRank(r.branchId, branchId);
    const applicable = rows.filter((r) => rank(r) >= 0).sort((a, b) => rank(b) - rank(a));
    return applicable[0]?.enabled ?? true;
  }

  private async lockEntry(tx: Tx, entryId: string) {
    const [probe] = await tx
      .select({ requestId: approvalEntries.requestId })
      .from(approvalEntries)
      .where(eq(approvalEntries.id, entryId))
      .limit(1);
    if (!probe) throw new ApprovalError('ENTRY_NOT_FOUND', 'That approval was not found.');
    // The request row is the lock: decisions on one request happen one at a time.
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, probe.requestId))
      .for('update');
    const [entry] = await tx
      .select()
      .from(approvalEntries)
      .where(eq(approvalEntries.id, entryId))
      .limit(1);
    return { entry: required(entry, 'the approval entry'), request: required(request, 'the approval request') };
  }

  private assertCanAct(
    entry: typeof approvalEntries.$inferSelect,
    request: RequestRow,
    userId: string,
  ) {
    if (entry.status !== 'open') {
      throw new ApprovalError('ALREADY_DECIDED', 'This approval has already been decided.');
    }
    if (request.status !== 'pending') {
      throw new ApprovalError('NOT_PENDING', 'This request is no longer waiting for approval.');
    }
    if (entry.approverUserId !== userId) {
      throw new ApprovalError('NOT_APPROVER', 'This approval is assigned to someone else.');
    }
  }

  private async changedSince(tx: Tx, request: RequestRow): Promise<boolean> {
    const h = this.handlers.get(request.documentKind);
    if (!h?.snapshot) return false;
    const now = await h.snapshot(request.documentId, tx);
    const submitted = request.snapshot;
    // Only the facts the module can still report are compared; the added request fields are kept.
    const keys = Object.keys(now);
    const projected = Object.fromEntries(keys.map((k) => [k, submitted[k]]));
    return hashSnapshot(projected) !== hashSnapshot(now);
  }

  /** The document changed: every request of the submission is void and must be submitted again. */
  private async voidSubmission(tx: Tx, request: RequestRow, why: string, userId: string) {
    const all = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.submissionId, request.submissionId),
          eq(approvalRequests.status, 'pending'),
        ),
      );
    for (const r of all) {
      await this.closeRequest(tx, r, 'superseded', why);
      await this.decisions.record(
        {
          companyId: r.companyId,
          subject: { type: 'approval_request', id: r.id },
          action: 'approvals.superseded',
          actor: { type: 'user', id: userId },
          from: 'pending',
          to: 'superseded',
          reason: { text: why },
        },
        tx,
      );
    }
    await this.handler(request.documentKind).onReopened(request.documentId, tx);
  }

  private async closeRequest(
    tx: Tx,
    request: RequestRow,
    status: RequestRow['status'],
    why: string,
  ) {
    await tx
      .update(approvalRequests)
      .set({ status, closedAt: new Date() })
      .where(eq(approvalRequests.id, request.id));
    await tx
      .update(approvalEntries)
      .set({ status: 'canceled', actedAt: new Date(), comment: why })
      .where(and(eq(approvalEntries.requestId, request.id), eq(approvalEntries.status, 'open')));
  }

  private async definitionOf(tx: Tx, request: RequestRow): Promise<WorkflowDefinition> {
    const [v] = await tx
      .select({ definition: approvalWorkflowVersions.definition })
      .from(approvalWorkflowVersions)
      .where(eq(approvalWorkflowVersions.id, request.workflowVersionId))
      .limit(1);
    return required(v, 'the workflow version').definition as unknown as WorkflowDefinition;
  }

  private stepOf(def: WorkflowDefinition, sequence: number): StepDefinition {
    return required(def.steps.find((s) => s.sequence === sequence), `step ${String(sequence)}`);
  }

  /** When every request in the submission is approved, the document is released, once. */
  private async releaseIfAllApproved(tx: Tx, request: RequestRow): Promise<boolean> {
    const all = await tx
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.submissionId, request.submissionId));
    if (!all.every((r) => r.status === 'approved')) return false;
    await this.handler(request.documentKind).onReleased(request.documentId, tx);
    await this.decisions.record(
      {
        companyId: request.companyId,
        subject: { type: request.documentKind, id: request.documentId },
        action: 'approvals.released',
        reason: { text: 'Every approval needed was given.' },
        outcome: { submissionId: request.submissionId },
      },
      tx,
    );
    return true;
  }

  /**
   * Moves a request forward: skip steps whose skip condition holds, then create the next
   * approver's entry (only now, so approvers added or reordered later still take effect).
   * Returns 'waiting' when someone has been asked, 'approved' when no steps remain.
   */
  private async advance(
    tx: Tx,
    request: RequestRow,
    def: WorkflowDefinition,
    directory: LoadedDirectory,
  ): Promise<'waiting' | 'approved'> {
    const steps = sortedSteps(def);
    const facts = request.snapshot;
    let current = request.currentStep;

    for (let guard = 0; guard < steps.length + 1; guard++) {
      const step = steps.find((s) => s.sequence === current);
      if (!step) break;

      if (step.skipIf && evaluateCondition(step.skipIf, facts)) {
        await this.decisions.record(
          {
            companyId: request.companyId,
            subject: { type: 'approval_request', id: request.id },
            action: 'approvals.step_skipped',
            reason: { text: `Step "${step.name}" does not apply to this document.` },
            inputs: { step: step.sequence },
          },
          tx,
        );
      } else {
        const rows = await tx
          .select()
          .from(approvalEntries)
          .where(
            and(
              eq(approvalEntries.requestId, request.id),
              eq(approvalEntries.stepSequence, step.sequence),
            ),
          )
          .orderBy(asc(approvalEntries.createdAt), asc(approvalEntries.position));
        const records: StepEntryRecord[] = rows.map((e) => ({
          position: e.position,
          approverUserId: e.approverUserId,
          onBehalfOfUserId: e.onBehalfOfUserId,
          status: e.status,
        }));
        let offer;
        try {
          offer = nextOffers({
            step,
            directory: directory.directory,
            requesterId: request.requestedBy,
            documentKind: request.documentKind,
            amount: Number(request.amount),
            entries: records,
          });
        } catch (error) {
          if (error instanceof NoEligibleApprover)
            throw new ApprovalError('NO_ELIGIBLE_APPROVER', error.message);
          throw error;
        }
        if (!offer.done) {
          // Others already asked are still being waited on (an "n of" step part way through).
          if (offer.offers.length === 0) return 'waiting';
          const dueAt = dueTime(step, new Date());
          const created = new Set<string>();
          for (const o of offer.offers) {
            const cover = directory.substituteFor(
              o.userId,
              request.requestedBy,
              step.allowSelfApproval === true,
            );
            const approver = cover ?? o.userId;
            if (created.has(approver)) continue;
            created.add(approver);
            await tx.insert(approvalEntries).values({
              requestId: request.id,
              stepSequence: step.sequence,
              position: o.position,
              approverUserId: approver,
              onBehalfOfUserId: has(cover) ? o.userId : null,
              dueAt,
            });
          }
          if (current !== request.currentStep || request.currentStep !== step.sequence) {
            await tx
              .update(approvalRequests)
              .set({ currentStep: step.sequence })
              .where(eq(approvalRequests.id, request.id));
            Object.assign(request, { currentStep: step.sequence });
          }
          await this.decisions.record(
            {
              companyId: request.companyId,
              subject: { type: 'approval_request', id: request.id },
              action: 'approvals.asked',
              reason: { text: `Step "${step.name}" needs approval.` },
              inputs: { step: step.sequence, approvers: [...created], rule: step.approver.type },
            },
            tx,
          );
          return 'waiting';
        }
      }
      const next = steps.find((s) => s.sequence > current);
      if (!next) break;
      current = next.sequence;
    }

    await tx
      .update(approvalRequests)
      .set({ status: 'approved', closedAt: new Date(), currentStep: current })
      .where(eq(approvalRequests.id, request.id));
    Object.assign(request, { status: 'approved' });
    await this.decisions.record(
      {
        companyId: request.companyId,
        subject: { type: 'approval_request', id: request.id },
        action: 'approvals.approved',
        from: 'pending',
        to: 'approved',
        reason: { text: 'Every step is complete.' },
      },
      tx,
    );
    return 'approved';
  }

  /** Reads who can approve what, for the people the workflows mention and everyone above them. */
  private async loadDirectory(
    tx: Reader,
    companyId: string,
    documentKind: string,
    defs: WorkflowDefinition[],
  ): Promise<LoadedDirectory> {
    const profiles = await tx
      .select()
      .from(approverProfiles)
      .where(eq(approverProfiles.companyId, companyId));
    const limits = profiles.length !== 0
      ? await tx
          .select()
          .from(approverLimits)
          .where(
            and(
              inArray(
                approverLimits.profileId,
                profiles.map((p) => p.id),
              ),
              eq(approverLimits.documentKind, documentKind),
            ),
          )
      : [];
    const groupIds = new Set<string>();
    const roleKeys = new Set<string>();
    const userIds = new Set<string>(profiles.map((p) => p.userId));
    for (const d of defs) {
      for (const s of d.steps) {
        if (s.approver.type === 'group') groupIds.add(s.approver.groupId);
        if (s.approver.type === 'role') roleKeys.add(s.approver.roleKey);
        if (s.approver.type === 'user') userIds.add(s.approver.userId);
      }
    }
    const members = groupIds.size !== 0
      ? await tx
          .select()
          .from(approverGroupMembers)
          .where(inArray(approverGroupMembers.groupId, [...groupIds]))
          .orderBy(asc(approverGroupMembers.groupId), asc(approverGroupMembers.sequence))
      : [];
    members.forEach((m) => userIds.add(m.userId));
    // Role holders: people with the role as an extra assignment, or as their main role.
    const roleHolders = new Map<string, string[]>();
    if (roleKeys.size !== 0) {
      const extra = await tx
        .select({ key: roles.key, userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(inArray(roles.key, [...roleKeys]), eq(roles.isActive, true)));
      const main = await tx
        .select({ key: users.role, userId: users.id })
        .from(users)
        .where(inArray(users.role, [...roleKeys]));
      for (const h of [...main, ...extra]) {
        const list = roleHolders.get(h.key) ?? [];
        if (!list.includes(h.userId)) list.push(h.userId);
        roleHolders.set(h.key, list);
        userIds.add(h.userId);
      }
    }
    const people = userIds.size !== 0
      ? await tx
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(inArray(users.id, [...userIds]))
      : [];
    const active = new Set(people.filter((u) => u.status === 'active').map((u) => u.id));
    const byUser = new Map(profiles.map((p) => [p.userId, p]));
    const limitOf = new Map(limits.map((l) => [l.profileId, l]));
    const today = businessDate();

    const profileActive = (id: string) => (byUser.get(id)?.isActive ?? true) && active.has(id);
    const directory: ApproverDirectory = {
      approverOf: (id) => byUser.get(id)?.approverUserId ?? null,
      qualifies: (id, _kind, amount) => {
        const p = byUser.get(id);
        const l = p ? limitOf.get(p.id) : undefined;
        if (!l) return false;
        return l.unlimited || (l.maxAmount !== null && Number(l.maxAmount) >= amount);
      },
      isEligible: (id) => profileActive(id),
      groupMembers: (groupId) => members.filter((m) => m.groupId === groupId).map((m) => m.userId),
      roleMembers: (key) => (roleHolders.get(key) ?? []).slice(0, MAX_ROLE_HOLDERS),
    };
    return {
      directory,
      substituteFor: (id, requesterId, allowSelf) => {
        const p = byUser.get(id);
        const sub = p?.substituteUserId;
        if (!p || !has(sub)) return null;
        if (has(p.substituteFrom) && today < p.substituteFrom) return null;
        if (has(p.substituteTo) && today > p.substituteTo) return null;
        if (!profileActive(sub) || (!allowSelf && sub === requesterId)) return null;
        return sub;
      },
    };
  }
}

interface LoadedDirectory {
  directory: ApproverDirectory;
  /** The substitute covering for `userId` today, if any. */
  substituteFor(userId: string, requesterId: string, allowSelf: boolean): string | null;
}

export type { Actor };
