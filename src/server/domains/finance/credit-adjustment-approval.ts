import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { creditAdjustments, customers } from '@/server/db/drizzle/schema';
import type { DocumentHandler } from '@/server/kernel/approvals/engine';

import { has } from '@/lib/values';

const KIND_WORDS: Record<string, string> = {
  waive_excess: 'Give up credit owed to',
  wallet_increase: 'Add to the wallet of',
  wallet_decrease: 'Take off the wallet of',
  wallet_expiry: 'Lapse the wallet balance of',
};

/** How approvals hold, release, reject and reopen a credit adjustment. The service does the work. */
export function creditAdjustmentApprovalHandler(db: DrizzleDb): DocumentHandler {
  const service = async () => {
    const { getContainer } = await import('@/server/di/container');
    return getContainer().finance.creditAdjustments;
  };
  return {
    onReleased: async (id, tx) => await (await service()).onApproved(tx, id),
    onRejected: async (id, tx, info) => await (await service()).onRejected(tx, id, info),
    onReopened: async (id, tx) => await (await service()).onReopened(tx, id),
    onCanceled: async (id, tx) => await (await service()).onCanceled(tx, id),
    describe: async (id) => {
      const [row] = await db
        .select({ a: creditAdjustments, customer: customers.name })
        .from(creditAdjustments)
        .innerJoin(customers, eq(customers.id, creditAdjustments.customerId))
        .where(eq(creditAdjustments.id, id));
      if (!row) return null;
      return {
        title: `${KIND_WORDS[row.a.kind] ?? 'Change the credit of'} ${row.customer}: ${row.a.currency} ${Number(row.a.amount).toLocaleString('en-KE', { minimumFractionDigits: 2 })}.`,
        lines: [`Reason: ${row.a.reasonCode.replace(/_/g, ' ')}${has(row.a.reasonText) ? ` — ${row.a.reasonText}` : ''}.`],
      };
    },
  };
}
