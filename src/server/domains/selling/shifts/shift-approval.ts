import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { registers, shiftCloseRequests, shifts } from '@/server/db/drizzle/schema';
import type { DocumentHandler } from '@/server/kernel/approvals/engine';

/** How the approval queue holds, releases, rejects and withdraws the close of a till shift. The shift service does the work. */
export function shiftApprovalHandler(db: DrizzleDb): DocumentHandler {
  const service = async () => {
    const { getContainer } = await import('@/server/di/container');
    return getContainer().shifts;
  };
  const money = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    onReleased: async (id, tx) => await (await service()).onCloseApproved(tx, id),
    onRejected: async (id, tx, info) => await (await service()).onCloseRejected(tx, id, info),
    onReopened: async () => await Promise.resolve(),
    onCanceled: async (id, tx) => await (await service()).onCloseCanceled(tx, id),
    describe: async (id) => {
      const [row] = await db
        .select({ r: shiftCloseRequests, registerName: registers.name })
        .from(shiftCloseRequests)
        .innerJoin(shifts, eq(shifts.id, shiftCloseRequests.shiftId))
        .innerJoin(registers, eq(registers.id, shifts.registerId))
        .where(eq(shiftCloseRequests.shiftId, id))
        .orderBy(shiftCloseRequests.createdAt)
        .limit(1);
      if (row === undefined) return null;
      const variance = Number(row.r.variance);
      return {
        title: `Close the shift on ${row.registerName}: ${money(Math.abs(variance))} ${variance < 0 ? 'short' : 'over'}.`,
        lines: [`The till should hold ${money(Number(row.r.expectedCash))}; ${money(Number(row.r.declaredCash))} was counted.`, `Reason given: ${row.r.varianceReason}`],
      };
    },
  };
}
