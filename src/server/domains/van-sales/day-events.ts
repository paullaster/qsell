import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vanDayEvents } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DayStatus } from '@/lib/van-sales/days';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface DayEventEntry {
  from?: DayStatus;
  to?: DayStatus;
  reason?: string;
  detail?: Record<string, unknown>;
}

/**
 * Writes one step of a van day to its append-only history (with the server's time, who did it and why) and to the decision log, in the
 * same transaction as the change. Everything that happens to a day goes through here, so no step is ever left without its entry.
 */
export async function recordDayEvent(tx: Tx, decisions: DecisionLog, companyId: string, dayId: string, actor: Actor, action: string, entry: DayEventEntry = {}): Promise<void> {
  await tx.insert(vanDayEvents).values({ companyId, dayId, action, actorType: actor.type, actorId: actor.id ?? null, fromStatus: entry.from ?? null, toStatus: entry.to ?? null, reason: entry.reason ?? null, detail: entry.detail ?? {} });
  await decisions.record({ companyId, actor, subject: { type: 'van_day', id: dayId }, action, reason: { text: entry.reason ?? action }, inputs: entry.from === undefined ? {} : { status: entry.from }, outcome: { ...(entry.to === undefined ? {} : { status: entry.to }), ...(entry.detail ?? {}) } }, tx);
}
