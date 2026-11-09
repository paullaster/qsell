import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveries, deliverySlaEvents, deliverySlaNotices, orders } from '@/server/db/drizzle/schema';
import { LEVEL_WORDS, lateWords, windowWords } from '@/lib/delivery-sla';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';
import { layout } from '@/server/domains/auth/emails';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { EmailPort } from '@/server/ports/communications';
import { retryWaitMinutes } from './messages';

/** A notice is tried this many times, with a longer wait each time, and then left as failed for a person to see. */
const MAX_TRIES = 5;
const LEASE_MINUTES = 10;

export interface SlaNoticeView {
  recipient: string;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  sentAt: string | null;
}

/**
 * The mails the staff get when a delivery is at risk, late or has been late too long. The mail is queued in the same step that raises the
 * lateness; this sends what is due, a few at a time, leased so two senders never send the same one together, and tries again later when the
 * mail server does not answer. A mail that cannot be sent never holds back the scan. The mail carries the delivery, the customer's first
 * name and the window, but no address, phone number or payment detail.
 */
export class DeliverySlaNotices {
  constructor(
    private readonly db: DrizzleDb,
    private readonly email: EmailPort,
    private readonly company: CompanySettingsRepository,
  ) {}

  /** Sends what is due. Safe to call any number of times from anywhere. Returns how many went. */
  async flush(limit = 20): Promise<number> {
    const claimed = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: deliverySlaNotices.id })
        .from(deliverySlaNotices)
        .where(and(inArray(deliverySlaNotices.status, ['queued', 'failed']), lte(deliverySlaNotices.nextTryAt, new Date()), sql`${deliverySlaNotices.attempts} < ${MAX_TRIES}`))
        .orderBy(deliverySlaNotices.nextTryAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      return await tx
        .update(deliverySlaNotices)
        .set({ attempts: sql`${deliverySlaNotices.attempts} + 1`, nextTryAt: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
        .where(inArray(deliverySlaNotices.id, due.map((d) => d.id)))
        .returning();
    });
    let sent = 0;
    for (const n of claimed) {
      try {
        await this.send(n);
        await this.db.update(deliverySlaNotices).set({ status: 'sent', sentAt: new Date(), lastError: null }).where(eq(deliverySlaNotices.id, n.id));
        sent += 1;
      } catch (error) {
        const why = (error instanceof Error ? error.message : 'The mail could not be sent.').slice(0, 300);
        console.error('[delivery.sla-notices] not sent', { id: n.id, why });
        await this.db
          .update(deliverySlaNotices)
          .set({ status: 'failed', lastError: why, nextTryAt: sql`now() + make_interval(mins => ${retryWaitMinutes(n.attempts)})` })
          .where(eq(deliverySlaNotices.id, n.id));
      }
    }
    return sent;
  }

  private async send(n: typeof deliverySlaNotices.$inferSelect): Promise<void> {
    const [row] = await this.db
      .select({ level: deliverySlaEvents.level, minutesLate: deliverySlaEvents.minutesLate, d: deliveries, orderNumber: orders.orderNumber, customerName: orders.customerName, branchName: branches.name })
      .from(deliverySlaEvents)
      .innerJoin(deliveries, eq(deliveries.id, deliverySlaEvents.deliveryId))
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .innerJoin(branches, eq(branches.id, deliveries.branchId))
      .where(eq(deliverySlaEvents.id, n.eventId));
    if (row === undefined) throw new Error('The delivery of this notice is gone.');
    const settings = await this.company.ensureSeeded();
    const url = `${resolvePublicBaseUrl(settings.publicBaseUrl)}/admin/delivery/late`;
    const windowText = row.d.windowStart !== null && row.d.windowEnd !== null ? windowWords(row.d.windowStart, row.d.windowEnd) : 'no window';
    const headline = LEVEL_WORDS[row.level];
    const late = row.level === 'at_risk' ? 'Not late yet' : `Late by ${lateWords(row.minutesLate)}`;
    const firstName = row.customerName.trim().split(/\s+/)[0] ?? '';
    const subject = `${row.level === 'at_risk' ? 'At risk' : 'Late'}: delivery ${row.d.number} (${windowText})`.slice(0, 200);
    const details: [string, string][] = [
      ['Delivery', row.d.number],
      ['Order', row.orderNumber],
      ['Customer', firstName],
      ['Leaves from', row.branchName],
      ['Promised', windowText],
      ['Where it stands', late],
    ];
    const body = `${headline}. Open the Late deliveries screen to see what is being done and to acknowledge it with a note.`;
    const footer = `You are receiving this because your address is on the list for delivery lateness at ${settings.tradingName}.`;
    const html = layout({ heading: `Delivery ${row.d.number} is ${row.level === 'at_risk' ? 'at risk' : 'late'}`, greeting: 'Hello,', body, cta: 'Open Late deliveries', actionUrl: url, footer, details });
    const text = `Delivery ${row.d.number}\n\n${body}\n\n${details.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen Late deliveries: ${url}\n\n${footer}`;
    await this.email.send({ to: n.recipient, subject, html, text });
  }

  /** The notices an event has caused, for the Late deliveries screen. */
  async forEvents(eventIds: string[]): Promise<Map<string, SlaNoticeView[]>> {
    const out = new Map<string, SlaNoticeView[]>();
    if (eventIds.length === 0) return out;
    const rows = await this.db.select().from(deliverySlaNotices).where(inArray(deliverySlaNotices.eventId, eventIds));
    for (const r of rows) out.set(r.eventId, [...(out.get(r.eventId) ?? []), { recipient: r.recipient, status: r.status, attempts: r.attempts, sentAt: r.sentAt === null ? null : r.sentAt.toISOString() }]);
    return out;
  }
}
