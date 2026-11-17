import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliverySlaEvents, deliverySlaPushes, pushSubscriptions } from '@/server/db/drizzle/schema';
import { lateAlert, readSubscription } from '@/lib/delivery-push';
import type { EscalationLevel } from '@/lib/delivery-sla';
import type { PushPort } from '@/server/ports/push';
import { retryWaitMinutes } from './messages';

/** An alert is tried this many times, with a longer wait each time, and then left as failed. */
const MAX_TRIES = 5;
const LEASE_MINUTES = 10;
/** One person keeps alerts on at most this many browsers; adding another drops the oldest. */
const MAX_BROWSERS = 5;

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface PushState {
  /** Whether this installation has been set up to send alerts; when not, nothing can be turned on. */
  available: boolean;
  /** The key a browser needs to subscribe. */
  publicKey: string | null;
  /** How many of this person's browsers are listening. */
  browsers: number;
}

export type PushDone = { ok: true } | { ok: false; error: string };

const arrayOf = (items: readonly string[]) => sql`array[${sql.join(items.map((i) => sql`${i}`), sql`, `)}]::text[]`;

/**
 * Alerts on a phone or computer for lateness. A person turns them on for the browser they are in; they are sent to those on the
 * company's lateness lists (matched by the email on their account) and to the rider whose run holds the delivery. They are queued in the
 * same step that raises the lateness, sent afterwards with retries, never carry an address, phone number or payment, and a browser that
 * says it has gone is forgotten. The mails go regardless: push is an addition, never a replacement.
 */
export class DeliveryPush {
  constructor(
    private readonly db: DrizzleDb,
    private readonly push: PushPort,
  ) {}

  async state(companyId: string, userId: string): Promise<PushState> {
    const key = this.push.publicKey();
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(pushSubscriptions).where(and(eq(pushSubscriptions.companyId, companyId), eq(pushSubscriptions.userId, userId)));
    return { available: key !== null, publicKey: key, browsers: row?.n ?? 0 };
  }

  /** Turns alerts on for the browser the person is in. The same browser again is the same subscription, now theirs. */
  async subscribe(actor: { companyId: string; userId: string }, raw: unknown): Promise<PushDone> {
    if (this.push.publicKey() === null) return { ok: false, error: 'Alerts are not set up on this installation yet. Ask whoever runs it to add the push keys.' };
    const read = readSubscription(raw);
    if (!read.ok) return read;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(pushSubscriptions)
        .values({ companyId: actor.companyId, userId: actor.userId, ...read.value })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { companyId: actor.companyId, userId: actor.userId, p256dh: read.value.p256dh, auth: read.value.auth } });
      const mine = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(and(eq(pushSubscriptions.companyId, actor.companyId), eq(pushSubscriptions.userId, actor.userId))).orderBy(sql`${pushSubscriptions.createdAt} desc`, pushSubscriptions.id);
      const extra = mine.slice(MAX_BROWSERS).map((m) => m.id);
      if (extra.length > 0) await tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, extra));
    });
    return { ok: true };
  }

  /** Turns alerts off for one browser of this person. Another person's browser is never touched. */
  async unsubscribe(actor: { companyId: string; userId: string }, endpoint: unknown): Promise<PushDone> {
    if (typeof endpoint !== 'string' || endpoint.length < 10 || endpoint.length > 2048) return { ok: false, error: 'This browser did not give a valid subscription.' };
    await this.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.companyId, actor.companyId), eq(pushSubscriptions.userId, actor.userId), eq(pushSubscriptions.endpoint, endpoint)));
    return { ok: true };
  }

  /**
   * Queues the alerts a scan's new events cause, inside the scan's own transaction. Staff: browsers of the people on the list for the
   * event's audience. The rider: the browsers of the rider whose live run holds the delivery, for the levels meant for dispatch.
   */
  async queue(tx: Tx, input: { companyId: string; deliveryId: string; events: readonly { id: string; level: EscalationLevel }[]; staffEmails: (level: EscalationLevel) => readonly string[] }): Promise<void> {
    if (this.push.publicKey() === null) return;
    for (const e of input.events) {
      const emails = input.staffEmails(e.level).map((x) => x.trim().toLowerCase());
      if (emails.length > 0) {
        await tx.execute(sql`
          insert into delivery_sla_pushes (company_id, event_id, subscription_id, audience)
          select ${input.companyId}::uuid, ${e.id}::uuid, s.id, 'staff'
          from push_subscriptions s join users u on u.id = s.user_id
          where s.company_id = ${input.companyId}::uuid and lower(u.email) = any(${arrayOf(emails)})
          on conflict do nothing`);
      }
      if (e.level !== 'escalated') {
        await tx.execute(sql`
          insert into delivery_sla_pushes (company_id, event_id, subscription_id, audience)
          select ${input.companyId}::uuid, ${e.id}::uuid, s.id, 'rider'
          from delivery_run_stops st
          join delivery_runs r on r.id = st.run_id and r.status in ('planned', 'started')
          join delivery_riders dr on dr.id = r.rider_id
          join push_subscriptions s on s.user_id = dr.user_id and s.company_id = ${input.companyId}::uuid
          where st.delivery_id = ${input.deliveryId}::uuid and st.left_at is null
          on conflict do nothing`);
      }
    }
  }

  /** Sends what is due, leased so two senders never send the same alert. Safe to call anywhere, any number of times. Returns how many went. */
  async flush(limit = 50): Promise<number> {
    if (this.push.publicKey() === null) return 0;
    const claimed = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: deliverySlaPushes.id })
        .from(deliverySlaPushes)
        .where(and(inArray(deliverySlaPushes.status, ['queued', 'failed']), lte(deliverySlaPushes.nextTryAt, new Date()), sql`${deliverySlaPushes.attempts} < ${MAX_TRIES}`))
        .orderBy(deliverySlaPushes.nextTryAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      return await tx
        .update(deliverySlaPushes)
        .set({ attempts: sql`${deliverySlaPushes.attempts} + 1`, nextTryAt: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
        .where(inArray(deliverySlaPushes.id, due.map((d) => d.id)))
        .returning();
    });
    let sent = 0;
    for (const n of claimed) {
      try {
        if (await this.deliver(n)) sent += 1;
      } catch (error) {
        const why = (error instanceof Error ? error.message : 'The alert could not be sent.').slice(0, 300);
        console.error('[delivery.push] not sent', { id: n.id, why });
        await this.db
          .update(deliverySlaPushes)
          .set({ status: 'failed', lastError: why, nextTryAt: sql`now() + make_interval(mins => ${retryWaitMinutes(n.attempts)})` })
          .where(eq(deliverySlaPushes.id, n.id));
      }
    }
    return sent;
  }

  private async deliver(n: typeof deliverySlaPushes.$inferSelect): Promise<boolean> {
    const [row] = await this.db
      .select({ sub: pushSubscriptions, level: deliverySlaEvents.level, minutesLate: deliverySlaEvents.minutesLate, d: deliveries })
      .from(deliverySlaPushes)
      .innerJoin(pushSubscriptions, eq(pushSubscriptions.id, deliverySlaPushes.subscriptionId))
      .innerJoin(deliverySlaEvents, eq(deliverySlaEvents.id, deliverySlaPushes.eventId))
      .innerJoin(deliveries, eq(deliveries.id, deliverySlaEvents.deliveryId))
      .where(eq(deliverySlaPushes.id, n.id));
    if (row === undefined) {
      // The browser was forgotten while the alert waited: nothing is left to send to.
      await this.db.update(deliverySlaPushes).set({ status: 'sent', sentAt: new Date(), lastError: 'The browser is gone.' }).where(eq(deliverySlaPushes.id, n.id));
      return false;
    }
    const alert = lateAlert({ level: row.level, number: row.d.number, windowStart: row.d.windowStart, windowEnd: row.d.windowEnd, minutesLate: row.minutesLate });
    const outcome = await this.push.send({ endpoint: row.sub.endpoint, p256dh: row.sub.p256dh, auth: row.sub.auth }, { ...alert, url: n.audience === 'rider' ? '/rider' : '/admin/delivery/late', tag: `delivery-${row.d.id}` });
    if (outcome === 'gone') {
      await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.sub.id));
      return false;
    }
    await this.db.update(pushSubscriptions).set({ lastSentAt: new Date() }).where(eq(pushSubscriptions.id, row.sub.id));
    await this.db.update(deliverySlaPushes).set({ status: 'sent', sentAt: new Date(), lastError: null }).where(eq(deliverySlaPushes.id, n.id));
    return true;
  }
}
