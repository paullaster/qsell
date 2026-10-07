import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { salesQuoteEvents, salesQuotes } from '@/server/db/drizzle/schema';
import type { DocumentHandler } from '@/server/kernel/approvals/engine';

type Tx = Parameters<DocumentHandler['onReleased']>[1];

/**
 * What a quote's approvals do to the quote. Its status keeps the meaning it always had:
 * `pending_approval` while waiting, `approved` once released, back to `draft` otherwise, with
 * `approval_status` saying whether that is a refusal (`rejected`) or a reopened quote (`draft`).
 */
export function quoteApprovalHandler(db: DrizzleDb): DocumentHandler {
  const move =
    (
      status: 'approved' | 'draft',
      approvalStatus: 'approved' | 'rejected' | 'draft',
      event: string,
    ) =>
    async (quoteId: string, tx: Tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(salesQuotes)
        .set({
          status,
          approvalStatus,
          ...(approvalStatus === 'approved' ? { approvedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(salesQuotes.id, quoteId))
        .returning({ id: salesQuotes.id });
      if (updated) {
        await tx.insert(salesQuoteEvents).values({
          quoteId,
          eventType: event,
          actorId: 'approvals',
          details: { via: 'approval workflow' },
        });
      }
    };

  return {
    // The facts approvers were shown include the total: if it moves, the approval no longer applies.
    snapshot: async (quoteId, tx) => {
      const [q] = await tx
        .select({ total: salesQuotes.totalAmount })
        .from(salesQuotes)
        .where(eq(salesQuotes.id, quoteId))
        .limit(1);
      return { amount: Number(q?.total ?? 0) };
    },
    onReleased: move('approved', 'approved', 'approved'),
    onRejected: move('draft', 'rejected', 'approval_rejected'),
    onReopened: move('draft', 'draft', 'approval_reopened'),
    onCanceled: move('draft', 'draft', 'approval_withdrawn'),
    describe: async (quoteId) => {
      const [q] = await db
        .select({
          number: salesQuotes.quoteNumber,
          customer: salesQuotes.customerName,
          total: salesQuotes.totalAmount,
          currency: salesQuotes.currency,
          margin: salesQuotes.grossMarginPercent,
        })
        .from(salesQuotes)
        .where(eq(salesQuotes.id, quoteId))
        .limit(1);
      return q
        ? {
            title: `Quote ${q.number} for ${q.customer}: ${q.currency} ${Number(q.total).toLocaleString('en-KE')}, gross margin ${Number(q.margin).toFixed(1)}%.`,
          }
        : null;
    },
  };
}
