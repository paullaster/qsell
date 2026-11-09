import { and, desc, eq, gte, inArray, notExists, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliveryCosts, deliveryPayPayoutItems, deliveryPayPayouts, paymentMethods } from '@/server/db/drizzle/schema';
import { COST_WORDS, PAYS_RIDERS, money } from '@/lib/delivery-cost';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { RiderSelf } from './riders';

const cents = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
const RECENT = 30;
const PAYOUTS = 10;
const TZ = 'Africa/Nairobi';

export interface RiderPayView {
  currency: string;
  /** Earned and not yet paid out, less anything taken back. */
  owed: string;
  /** Earned this month, less anything taken back, whether or not it has been paid. */
  earnedThisMonth: string;
  monthFrom: string;
  entries: { id: string; when: string; words: string; amount: string; deliveryNumber: string | null; takenBack: boolean; paid: boolean }[];
  /** More entries exist than are listed. */
  moreEntries: boolean;
  payouts: { number: string; paidOn: string; amount: string; method: string; reference: string | null }[];
}

/**
 * A rider's own pay: what they are owed now, what they earned this month, the latest entries and what has been paid to them. The rider is
 * the signed-in account's own row (set by the server, never by the phone), so one rider can never be shown another's pay. A reason the
 * office gave for taking a pay entry back is the office's note and is not shown; the entry says it was taken back.
 */
export class RiderPay {
  constructor(private readonly db: DrizzleDb) {}

  async mine(self: RiderSelf, today: string = businessDate()): Promise<RiderPayView> {
    const monthFrom = `${today.slice(0, 7)}-01`;
    const mine = and(eq(deliveryCosts.companyId, self.companyId), eq(deliveryCosts.riderId, self.riderId), inArray(deliveryCosts.kind, [...PAYS_RIDERS]));
    const [totals, entries, payouts] = await Promise.all([
      this.db
        .select({
          owed: sql<string>`COALESCE(sum(${deliveryCosts.amount}) FILTER (WHERE ${notExists(this.db.select({ x: sql`1` }).from(deliveryPayPayoutItems).where(eq(deliveryPayPayoutItems.costId, deliveryCosts.id)))}), 0)`,
          month: sql<string>`COALESCE(sum(${deliveryCosts.amount}) FILTER (WHERE ${gte(deliveryCosts.createdAt, sql`(${monthFrom}::date)::timestamp AT TIME ZONE ${TZ}`)}), 0)`,
          currency: sql<string | null>`max(${deliveryCosts.currency})`,
        })
        .from(deliveryCosts)
        .where(mine),
      this.db
        .select({ c: deliveryCosts, number: deliveries.number, paid: sql<boolean>`EXISTS (SELECT 1 FROM ${deliveryPayPayoutItems} WHERE ${deliveryPayPayoutItems.costId} = ${deliveryCosts.id})` })
        .from(deliveryCosts)
        .leftJoin(deliveries, eq(deliveries.id, deliveryCosts.deliveryId))
        .where(mine)
        .orderBy(desc(deliveryCosts.createdAt), desc(deliveryCosts.id))
        .limit(RECENT + 1),
      this.db
        .select({ p: deliveryPayPayouts, method: paymentMethods.name })
        .from(deliveryPayPayouts)
        .leftJoin(paymentMethods, eq(paymentMethods.id, deliveryPayPayouts.paymentMethodId))
        .where(and(eq(deliveryPayPayouts.companyId, self.companyId), eq(deliveryPayPayouts.riderId, self.riderId)))
        .orderBy(desc(deliveryPayPayouts.paidOn), desc(deliveryPayPayouts.createdAt))
        .limit(PAYOUTS),
    ]);
    const t = totals[0];
    return {
      currency: t?.currency ?? 'KES',
      owed: money(cents(t?.owed)),
      earnedThisMonth: money(cents(t?.month)),
      monthFrom,
      entries: entries.slice(0, RECENT).map((e) => ({
        id: e.c.id,
        when: e.c.createdAt.toISOString(),
        words: Number(e.c.amount) < 0 ? 'Taken back by the office' : COST_WORDS[e.c.kind],
        amount: e.c.amount,
        deliveryNumber: e.number,
        takenBack: Number(e.c.amount) < 0,
        paid: e.paid,
      })),
      moreEntries: entries.length > RECENT,
      payouts: payouts.map((p) => ({ number: p.p.number, paidOn: p.p.paidOn, amount: p.p.amount, method: p.method ?? 'Payout', reference: p.p.reference })),
    };
  }
}
