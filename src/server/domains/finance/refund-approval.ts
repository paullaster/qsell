import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, paymentMethods, refundRequests } from '@/server/db/drizzle/schema';
import type { DocumentHandler } from '@/server/kernel/approvals/engine';

import { has } from '@/lib/values';

/** How approvals hold, release, reject and reopen a refund. The refund service does the work. */
export function refundApprovalHandler(db: DrizzleDb): DocumentHandler {
  const service = async () => {
    const { getContainer } = await import('@/server/di/container');
    return getContainer().finance.refunds;
  };
  return {
    onReleased: async (id, tx) => await (await service()).onApproved(tx, id),
    onRejected: async (id, tx, info) => await (await service()).onRejected(tx, id, info),
    onReopened: async (id, tx) => await (await service()).onReopened(tx, id),
    onCanceled: async (id, tx) => await (await service()).onCanceled(tx, id),
    describe: async (id) => {
      const [row] = await db
        .select({ r: refundRequests, customer: customers.name, method: paymentMethods.name })
        .from(refundRequests)
        .innerJoin(customers, eq(customers.id, refundRequests.customerId))
        .innerJoin(paymentMethods, eq(paymentMethods.id, refundRequests.paymentMethodId))
        .where(eq(refundRequests.id, id));
      if (!row) return null;
      const where = Object.entries(row.r.payoutDetails).map(([k, v]) => `${k}: ${v}`).join(', ');
      return {
        title: `Refund ${row.r.currency} ${Number(row.r.amount).toLocaleString('en-KE', { minimumFractionDigits: 2 })} to ${row.customer} (${row.method}).`,
        lines: [
          `Reason: ${row.r.reasonCode.replace(/_/g, ' ')}${has(row.r.reasonText) ? ` — ${row.r.reasonText}` : ''}. Owed from ${row.r.sourceKind.replace(/_/g, ' ')}.`,
          has(where) ? `Paid to: ${where}.` : '',
          row.r.detailsChanged ? 'THE DESTINATION IS NOT WHAT IS ON THE CUSTOMER\'S RECORD.' : '',
        ].filter(Boolean),
      };
    },
  };
}
