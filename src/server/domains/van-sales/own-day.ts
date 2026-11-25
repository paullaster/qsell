import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { salesReps, vanDays, vans } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import { isId } from '@/lib/van-sales/people';
import { VanSalesError } from './errors';

/**
 * The day and its rep and van, when the person is that rep and may sell. Everything done during a day (sending it out, the visits, the sales)
 * is the rep's own: the stock and the cash are in their care, so nobody else does it for them.
 */
export async function ownDay(db: Pick<DrizzleDb, 'select'>, companyId: string, actor: Actor, dayId: string, maySell: boolean) {
  if (!isId(dayId)) throw new VanSalesError('That day could not be found.');
  const [row] = await db
    .select({
      d: vanDays,
      repName: salesReps.name,
      repUser: salesReps.userId,
      repStatus: salesReps.status,
      limits: { maxDiscountPercent: salesReps.maxDiscountPercent, maxCreditPerDay: salesReps.maxCreditPerDay, mayOverridePrice: salesReps.mayOverridePrice, maySellOnCredit: salesReps.maySellOnCredit },
      registerId: vans.registerId,
      vanLocationId: vans.locationId,
    })
    .from(vanDays)
    .innerJoin(salesReps, eq(salesReps.id, vanDays.repId))
    .leftJoin(vans, eq(vans.id, vanDays.vanId))
    .where(and(eq(vanDays.companyId, companyId), eq(vanDays.id, dayId)))
    .limit(1);
  if (row === undefined) throw new VanSalesError('That day could not be found.');
  if (row.repUser !== actor.id) throw new VanSalesError(`Only ${row.repName} runs their own day: the stock and the cash are in their care.`);
  if (!maySell) throw new VanSalesError('You are not allowed to sell from a van.');
  if (row.repStatus !== 'active') throw new VanSalesError('You are not selling at the moment, so you cannot run a day.');
  return row;
}
