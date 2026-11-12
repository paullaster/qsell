import { and, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliverySlaEvents, deliverySlaTexts } from '@/server/db/drizzle/schema';
import { lateText } from '@/lib/delivery-sla';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { SmsAccounts } from '@/server/domains/sms/accounts';
import { SmsSendError } from '@/server/ports/sms';
import { retryWaitMinutes } from './messages';

/** A text is tried this many times, with a longer wait each time, and then left as failed for a person to see. */
const MAX_TRIES = 5;
const LEASE_MINUTES = 10;
/** A lateness text that could not go for this long is no use any more, and is left unsent rather than arriving hours late. */
const STALE_HOURS = 3;

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface TextSummary {
  sent: number;
  waiting: number;
  failed: number;
}

const arrayOf = (items: readonly string[]) => sql`array[${sql.join(items.map((i) => sql`${i}`), sql`, `)}]::text[]`;

/**
 * The text messages sent when a delivery is at risk, late or has been late too long: to the numbers on the dispatcher and supervisor lists,
 * and, when the company has chosen it, to the rider whose run holds the delivery. Queued in the step that raises the lateness, sent
 * afterwards through the company's default SMS connection with retries, and never carrying a customer's name, address, phone or payment.
 * With no SMS connection set up nothing is sent and the screen says why; the mails and alerts still go.
 */
export class DeliverySlaTexts {
  constructor(
    private readonly db: DrizzleDb,
    private readonly sms: SmsAccounts,
    private readonly company: CompanySettingsRepository,
  ) {}

  /** Queues the texts new events cause, inside the scan's own transaction. */
  async queue(tx: Tx, input: { companyId: string; deliveryId: string; events: readonly { id: string; level: 'at_risk' | 'late' | 'escalated' }[]; staffNumbers: (level: 'at_risk' | 'late' | 'escalated') => readonly string[]; textTheRider: boolean }): Promise<void> {
    for (const e of input.events) {
      const numbers = input.staffNumbers(e.level);
      if (numbers.length > 0) {
        await tx.execute(sql`
          insert into delivery_sla_texts (company_id, event_id, recipient, audience)
          select ${input.companyId}::uuid, ${e.id}::uuid, n, 'staff' from unnest(${arrayOf(numbers)}) as n
          on conflict do nothing`);
      }
      if (input.textTheRider && e.level !== 'escalated') {
        await tx.execute(sql`
          insert into delivery_sla_texts (company_id, event_id, recipient, audience)
          select ${input.companyId}::uuid, ${e.id}::uuid, dr.phone, 'rider'
          from delivery_run_stops st
          join delivery_runs r on r.id = st.run_id and r.status in ('planned', 'started')
          join delivery_riders dr on dr.id = r.rider_id
          where st.delivery_id = ${input.deliveryId}::uuid and st.left_at is null and dr.phone ~ '^\\+[1-9][0-9]{7,14}$'
          on conflict do nothing`);
      }
    }
  }

  /** Sends what is due, leased so two senders never send the same text. Safe to call anywhere. Returns how many went. */
  async flush(limit = 20): Promise<number> {
    await this.db
      .update(deliverySlaTexts)
      .set({ status: 'failed', attempts: MAX_TRIES, lastError: 'Not sent: it was too late to be useful.' })
      .where(and(inArray(deliverySlaTexts.status, ['queued', 'failed']), sql`${deliverySlaTexts.attempts} < ${MAX_TRIES}`, lt(deliverySlaTexts.createdAt, sql`now() - make_interval(hours => ${STALE_HOURS})`)));
    const claimed = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: deliverySlaTexts.id })
        .from(deliverySlaTexts)
        .where(and(inArray(deliverySlaTexts.status, ['queued', 'failed']), lte(deliverySlaTexts.nextTryAt, new Date()), sql`${deliverySlaTexts.attempts} < ${MAX_TRIES}`))
        .orderBy(deliverySlaTexts.nextTryAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      return await tx
        .update(deliverySlaTexts)
        .set({ attempts: sql`${deliverySlaTexts.attempts} + 1`, nextTryAt: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
        .where(inArray(deliverySlaTexts.id, due.map((d) => d.id)))
        .returning();
    });
    if (claimed.length === 0) return 0;
    const shop = (await this.company.ensureSeeded()).tradingName;
    let sent = 0;
    for (const n of claimed) {
      try {
        const sender = await this.sms.defaultSender(n.companyId);
        if (sender === null) throw new SmsSendError('No SMS provider is set up, so the text could not be sent. Connect one in Settings > SMS providers.', true);
        const [row] = await this.db
          .select({ level: deliverySlaEvents.level, minutesLate: deliverySlaEvents.minutesLate, d: deliveries })
          .from(deliverySlaEvents)
          .innerJoin(deliveries, eq(deliveries.id, deliverySlaEvents.deliveryId))
          .where(eq(deliverySlaEvents.id, n.eventId));
        if (row === undefined) throw new SmsSendError('The delivery of this text is gone.', false);
        await sender.send({ to: n.recipient, text: lateText({ level: row.level, number: row.d.number, windowStart: row.d.windowStart, windowEnd: row.d.windowEnd, minutesLate: row.minutesLate, shop }) });
        await this.db.update(deliverySlaTexts).set({ status: 'sent', sentAt: new Date(), lastError: null }).where(eq(deliverySlaTexts.id, n.id));
        sent += 1;
      } catch (error) {
        const known = error instanceof SmsSendError;
        const why = (known ? error.message : 'The text could not be sent.').slice(0, 300);
        if (!known) console.error('[delivery.sla-texts] not sent', { id: n.id, error });
        // A refusal that asking again cannot change (a wrong key, no balance, a number the provider will not use) is not tried again.
        await this.db
          .update(deliverySlaTexts)
          .set({ status: 'failed', lastError: why, attempts: known && !error.retry ? MAX_TRIES : n.attempts, nextTryAt: sql`now() + make_interval(mins => ${retryWaitMinutes(n.attempts)})` })
          .where(eq(deliverySlaTexts.id, n.id));
      }
    }
    return sent;
  }

  /** The texts an event has caused, counted for the Late deliveries screen. */
  async summaryFor(eventIds: readonly string[]): Promise<Map<string, TextSummary>> {
    const out = new Map<string, TextSummary>();
    if (eventIds.length === 0) return out;
    const rows = await this.db.select({ eventId: deliverySlaTexts.eventId, status: deliverySlaTexts.status, attempts: deliverySlaTexts.attempts }).from(deliverySlaTexts).where(inArray(deliverySlaTexts.eventId, [...eventIds]));
    for (const r of rows) {
      const s = out.get(r.eventId) ?? { sent: 0, waiting: 0, failed: 0 };
      if (r.status === 'sent') s.sent += 1;
      else if (r.status === 'failed' && r.attempts >= MAX_TRIES) s.failed += 1;
      else s.waiting += 1;
      out.set(r.eventId, s);
    }
    return out;
  }
}
