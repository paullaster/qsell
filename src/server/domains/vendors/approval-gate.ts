import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { approvalEntries, approvalRequests } from '@/server/db/drizzle/schema';
import { FinanceError } from '@/server/domains/finance/errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export type VendorApprovalKind = 'rfq_award' | 'vendor_po' | 'vendor_invoice' | 'vendor_payment' | 'vendor_advance';

export interface GateInput {
  companyId: string;
  trigger: string;
  documentId: string;
  requestedBy: string;
  /** Base-currency amount, the figure approver limits are compared with. */
  amount: number;
  snapshot: Record<string, unknown>;
}

/**
 * Where the vendor documents meet the approval engine. A company may configure a workflow for a trigger (who approves, in what order,
 * with what limits, escalation after a delay). While one covers a document, only the engine's inbox can approve it. Where no workflow
 * is configured, the fixed rule each service already enforces stays: a different person approves, and the database refuses the rest.
 * Stateless: the engine is fetched when needed so the container can be built without it.
 */
export class VendorApprovalGate {
  /** `waiting`: the engine holds the document until its steps are approved. `fixed`: no workflow applies (or none needed a person). */
  async submit(tx: Tx, input: GateInput): Promise<'waiting' | 'fixed'> {
    const { getContainer } = await import('@/server/di/container');
    // A refusal sent the document back to its writer; sending it again starts a new request and keeps the refused one as history.
    await tx
      .update(approvalRequests)
      .set({ status: 'reopened' })
      .where(and(eq(approvalRequests.companyId, input.companyId), eq(approvalRequests.documentId, input.documentId), eq(approvalRequests.status, 'rejected')));
    const outcome = await getContainer().approvals.submit(
      { companyId: input.companyId, trigger: input.trigger, documentId: input.documentId, requestedBy: input.requestedBy, amount: input.amount, snapshot: input.snapshot },
      tx,
    );
    return outcome.required && !outcome.released ? 'waiting' : 'fixed';
  }

  /** Which of these documents an open engine request holds, for screens that show a list. */
  async heldSet(db: Tx | DrizzleDb, companyId: string, kind: VendorApprovalKind, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db
      .select({ id: approvalRequests.documentId })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.documentKind, kind), eq(approvalRequests.status, 'pending'), inArray(approvalRequests.documentId, ids)));
    return new Set(rows.map((r) => r.id));
  }

  /** Whether an open engine request holds this document. */
  async holds(tx: Tx, companyId: string, kind: VendorApprovalKind, id: string): Promise<boolean> {
    const [open] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.documentKind, kind), eq(approvalRequests.documentId, id), eq(approvalRequests.status, 'pending')))
      .limit(1);
    return open !== undefined;
  }

  /** Refuses a direct approval while a workflow holds the document, so the workflow cannot be bypassed. */
  async refuseIfHeld(tx: Tx, companyId: string, kind: VendorApprovalKind, id: string): Promise<void> {
    if (await this.holds(tx, companyId, kind, id)) {
      throw new FinanceError('USE_APPROVALS', 'An approval workflow covers this. Approve it from the Approvals inbox.');
    }
  }

  /** The person whose approval released the document, for the record it leaves. */
  async lastApprover(tx: Tx, kind: VendorApprovalKind, id: string): Promise<string | null> {
    const [last] = await tx
      .select({ by: approvalEntries.approverUserId })
      .from(approvalEntries)
      .innerJoin(approvalRequests, eq(approvalRequests.id, approvalEntries.requestId))
      .where(and(eq(approvalRequests.documentKind, kind), eq(approvalRequests.documentId, id), eq(approvalEntries.status, 'approved')))
      .orderBy(desc(approvalEntries.actedAt))
      .limit(1);
    return last?.by ?? null;
  }
}

export const vendorApprovals = new VendorApprovalGate();
