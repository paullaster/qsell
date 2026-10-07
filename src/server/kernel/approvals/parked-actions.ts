import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { approvalParkedActions, type ApprovalParkedActionRow } from '@/server/db/drizzle/schema';
import { withAfterCommit } from '../after-commit';
import type { ApprovalEngine, DocumentHandler, SubmitInput, Tx } from './engine';
import { triggerByCode } from './domain/triggers';

/** Carries out a parked action, in the approver's transaction. Whatever it returns is kept as the result. */
export interface ParkedExecutor {
  execute(tx: Tx, row: ApprovalParkedActionRow): Promise<Record<string, unknown>>;
}

export type GateResult<T> =
  /** No approval was needed; the action ran straight away. */
  | { parked: false; value: T }
  /** The action was parked. It runs when it is approved. */
  | { parked: true; requestId: string; message: string };

export const PARKED_MESSAGE =
  'Sent for approval. It will be carried out as soon as it is approved, and you can follow it under My requests.';

/**
 * Lets an action that cannot be "created in a pending state" (issuing a credit note, changing
 * stock) wait for approval anyway: its inputs are kept, the approval is asked for, and the action
 * is carried out in the same transaction as the final approval. With no workflow configured it
 * simply runs, exactly as before.
 */
export class ParkedActions {
  private readonly executors = new Map<string, ParkedExecutor>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly engine: ApprovalEngine,
  ) {}

  /** Makes a document kind's approvals carry out its parked actions. */
  attach(documentKind: string, executors: Record<string, ParkedExecutor>) {
    for (const [action, executor] of Object.entries(executors)) {
      this.executors.set(`${documentKind}:${action}`, executor);
    }
    this.engine.registerDocument(documentKind, this.handler());
  }

  async gate<T>(
    args: {
      trigger: string;
      companyId: string;
      branchId?: string | null;
      requestedBy: string;
      /** In the company's base currency; what approver limits are compared with. */
      amount: number;
      /** The facts the workflow conditions look at. */
      facts: Record<string, unknown>;
      action: string;
      payload: Record<string, unknown>;
      summary: string;
    },
    now: () => Promise<T>,
  ): Promise<GateResult<T>> {
    const trigger = triggerByCode(args.trigger);
    if (!trigger) throw new Error(`Unknown approval trigger "${args.trigger}"`);
    const input: Omit<SubmitInput, 'documentId'> = {
      companyId: args.companyId,
      trigger: args.trigger,
      branchId: args.branchId ?? null,
      requestedBy: args.requestedBy,
      amount: args.amount,
      snapshot: args.facts,
    };
    if (!(await this.engine.wouldRequire({ ...input, documentId: 'check' }))) {
      return { parked: false, value: await now() };
    }

    const outcome = await withAfterCommit(this.db, async (tx) => {
      const [row] = await tx
        .insert(approvalParkedActions)
        .values({
          companyId: args.companyId,
          documentKind: trigger.documentKind,
          action: args.action,
          payload: args.payload,
          summary: args.summary,
          requestedBy: args.requestedBy,
        })
        .returning();
      const result = await this.engine.submit({ ...input, documentId: row!.id }, tx);
      if (!result.required) {
        // The configuration changed between the check and now: nothing needs approval after all.
        await tx.delete(approvalParkedActions).where(eq(approvalParkedActions.id, row!.id));
        return { skip: true as const };
      }
      return { skip: false as const, requestId: row!.id };
    });
    if (outcome.skip) return { parked: false, value: await now() };
    return { parked: true, requestId: outcome.requestId, message: PARKED_MESSAGE };
  }

  private handler(): DocumentHandler {
    const close = async (
      tx: Tx,
      id: string,
      status: 'applied' | 'rejected' | 'canceled',
      result?: Record<string, unknown>,
    ) => {
      await tx
        .update(approvalParkedActions)
        .set({ status, closedAt: new Date(), ...(result ? { result } : {}) })
        .where(eq(approvalParkedActions.id, id));
    };
    return {
      onReleased: async (id, tx) => {
        const [row] = await tx
          .select()
          .from(approvalParkedActions)
          .where(eq(approvalParkedActions.id, id))
          .for('update');
        if (!row || row.status !== 'parked') return;
        const executor = this.executors.get(`${row.documentKind}:${row.action}`);
        if (!executor) throw new Error(`Nothing knows how to carry out "${row.action}".`);
        // If this throws, the approval is not recorded either: the approver sees why and can reject instead.
        const result = await executor.execute(tx, row);
        await close(tx, id, 'applied', result);
      },
      onRejected: async (id, tx) => close(tx, id, 'rejected'),
      // The action never happened, so there is nothing to reopen: the requester just starts again.
      onReopened: async (id, tx) => close(tx, id, 'canceled'),
      onCanceled: async (id, tx) => close(tx, id, 'canceled'),
      describe: async (id) => {
        const [row] = await this.db
          .select({ summary: approvalParkedActions.summary })
          .from(approvalParkedActions)
          .where(eq(approvalParkedActions.id, id))
          .limit(1);
        return row ? { title: row.summary } : null;
      },
    };
  }
}
