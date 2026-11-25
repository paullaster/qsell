import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vanDays } from '@/server/db/drizzle/schema';
import { DAY_STATUSES, isOpenDay } from '@/lib/van-sales/days';

type Reader = Pick<DrizzleDb, 'select'>;

const OPEN = DAY_STATUSES.filter(isOpenDay);

const COLUMN = { repId: vanDays.repId, vanId: vanDays.vanId, routeId: vanDays.routeId } as const;

/**
 * The earliest day of a rep, van or route that is not yet closed or cancelled, if there is one. A day holds its rep, van and route, so
 * each of them refuses to be stopped, paused or ended while it has one, and says which day it is.
 */
export async function openDayOf(db: Reader, companyId: string, by: Partial<Record<keyof typeof COLUMN, string>>): Promise<{ number: string; date: string } | null> {
  const [kind] = (Object.keys(COLUMN) as (keyof typeof COLUMN)[]).filter((k) => typeof by[k] === 'string');
  if (kind === undefined) return null;
  const [row] = await db
    .select({ number: vanDays.number, date: vanDays.dayDate })
    .from(vanDays)
    .where(and(eq(vanDays.companyId, companyId), eq(COLUMN[kind], by[kind] ?? ''), inArray(vanDays.status, OPEN)))
    .orderBy(asc(vanDays.dayDate))
    .limit(1);
  return row ?? null;
}

/** The sentence a refusal gives: which day, and what to do. */
export const openDayWords = (what: string, day: { number: string; date: string }): string => `${what} has a day that is not finished: ${day.number} on ${day.date}. Cancel or close it first.`;
