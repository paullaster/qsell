import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliveryEvents, deliveryMessages, orders } from '@/server/db/drizzle/schema';
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/delivery-document';
import { isMessageKind, messageContent, textContent, type MessageFacts, type MessageKind } from '@/lib/delivery-messages';
import { internationalPhone, maskedPhone } from '@/lib/sms-providers';
import { maskEmail } from '@/lib/tracking-token';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';
import { layout } from '@/server/domains/auth/emails';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { EmailPort } from '@/server/ports/communications';
import { SmsSendError, type SmsPort } from '@/server/ports/sms';
import type { DeliveryTextSettings } from './text-settings';
import type { TrackingLinks } from './tracking-links';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** A message is tried this many times, with a longer wait each time, and then left as failed for a person to see. */
const MAX_TRIES = 5;
const LEASE_MINUTES = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MessageView {
  id: string;
  kind: string;
  /** `email` or `sms`. */
  channel: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  recipient: string;
  attempts: number;
  note: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Where a message went, with most of it hidden: the first letter and the mail host of an address, or the ends of a number. */
function shownRecipient(channel: string, recipient: string | null): string {
  if (channel !== 'sms') return maskEmail(recipient);
  return recipient === null ? '' : maskedPhone(recipient);
}

/** The wait before another try: 5 minutes, then 10, 20, 40. */
export const retryWaitMinutes = (attempts: number): number => 5 * 2 ** Math.max(0, attempts - 1);

/**
 * What customers are told as their delivery moves. A message is queued in the same transaction as the step that causes it (one for
 * each thing that happened, so a retried step is not a second message), and sent afterwards by whoever gets there first: the step
 * itself, and the background sweep. Sending is claimed with a lease, so two senders never send the same message together; a mail that
 * cannot be sent is tried again later and, in the end, left visible as failed. A message never undoes the step, and never carries an
 * address, a phone number or a payment detail.
 */
export class DeliveryMessages {
  constructor(
    private readonly db: DrizzleDb,
    private readonly email: EmailPort,
    private readonly company: CompanySettingsRepository,
    private readonly links: Pick<TrackingLinks, 'tokenFor'>,
    /** Texting customers is optional: with no settings or sender given the messages go by email only, as before. */
    private readonly texting: { settings: Pick<DeliveryTextSettings, 'get'>; sender: (companyId: string) => Promise<SmsPort | null> } | null = null,
  ) {}

  /**
   * Queues a message in the caller's transaction. No address (or one that cannot be right) is recorded as skipped, with why. When the
   * company has turned texting on for this kind of message, the same message is also queued by text to the customer's number, as its own
   * row (the key ends in `:sms`), so a mail that fails never holds back the text, or the other way round.
   */
  async enqueueIn(tx: Tx, input: { companyId: string; orderId: string; deliveryId: string; kind: MessageKind; key: string }): Promise<void> {
    const [order] = await tx.select({ email: orders.customerEmail, phone: orders.customerPhone }).from(orders).where(eq(orders.id, input.orderId));
    const address = order?.email.trim().toLowerCase() ?? '';
    const usable = EMAIL.test(address);
    await tx
      .insert(deliveryMessages)
      .values({ companyId: input.companyId, orderId: input.orderId, deliveryId: input.deliveryId, kind: input.kind, messageKey: input.key, recipient: usable ? address : null, status: usable ? 'queued' : 'skipped', lastError: usable ? null : 'The order has no email address to send to.' })
      .onConflictDoNothing();
    if (this.texting === null) return;
    const settings = await this.texting.settings.get(input.companyId, tx);
    if (!settings.enabled || !settings.kinds.includes(input.kind)) return;
    const phone = internationalPhone(order?.phone);
    await tx
      .insert(deliveryMessages)
      .values({ companyId: input.companyId, orderId: input.orderId, deliveryId: input.deliveryId, kind: input.kind, channel: 'sms', messageKey: `${input.key}:sms`, recipient: phone, status: phone === null ? 'skipped' : 'queued', lastError: phone === null ? 'The order has no usable mobile number.' : null })
      .onConflictDoNothing();
  }

  /** Sends what is due, a few at a time. Safe to call from anywhere, any number of times. Returns how many went. */
  async flush(limit = 10): Promise<number> {
    const claimed = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: deliveryMessages.id })
        .from(deliveryMessages)
        .where(and(inArray(deliveryMessages.status, ['queued', 'failed']), lte(deliveryMessages.nextTryAt, new Date()), sql`${deliveryMessages.attempts} < ${MAX_TRIES}`))
        .orderBy(deliveryMessages.nextTryAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      // The lease: until it passes, nobody else sends these.
      return await tx
        .update(deliveryMessages)
        .set({ attempts: sql`${deliveryMessages.attempts} + 1`, nextTryAt: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
        .where(inArray(deliveryMessages.id, due.map((d) => d.id)))
        .returning();
    });
    let sent = 0;
    for (const m of claimed) {
      try {
        await this.send(m);
        await this.db.update(deliveryMessages).set({ status: 'sent', sentAt: new Date(), lastError: null }).where(eq(deliveryMessages.id, m.id));
        sent += 1;
      } catch (error) {
        const why = (error instanceof Error ? error.message : 'The message could not be sent.').slice(0, 300);
        console.error('[delivery.messages] not sent', { id: m.id, kind: m.kind, channel: m.channel, why });
        // A text the provider refuses for good (a wrong key, no balance, a number it will not use) is not tried again.
        const final = error instanceof SmsSendError && !error.retry;
        await this.db
          .update(deliveryMessages)
          .set({ status: 'failed', lastError: why, ...(final ? { attempts: MAX_TRIES } : {}), nextTryAt: sql`now() + make_interval(mins => ${retryWaitMinutes(m.attempts)})` })
          .where(eq(deliveryMessages.id, m.id));
      }
    }
    return sent;
  }

  private async send(m: typeof deliveryMessages.$inferSelect): Promise<void> {
    if (m.recipient === null || m.deliveryId === null || !isMessageKind(m.kind)) throw new Error('This message has nothing to send.');
    const [row] = await this.db
      .select({ d: deliveries, orderNumber: orders.orderNumber, customerName: orders.customerName })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .where(eq(deliveries.id, m.deliveryId));
    if (row === undefined) throw new Error('The delivery of this message is gone.');
    const [failed] = await this.db
      .select({ reason: deliveryEvents.reasonCode })
      .from(deliveryEvents)
      .where(and(eq(deliveryEvents.deliveryId, m.deliveryId), eq(deliveryEvents.action, 'fail_attempt')))
      .orderBy(desc(deliveryEvents.sequence))
      .limit(1);
    const settings = await this.company.ensureSeeded();
    const token = await this.links.tokenFor(m.companyId, m.orderId);
    const base = resolvePublicBaseUrl(settings.publicBaseUrl);
    // With the link turned off the message still goes, pointing at the shop's own "Track my order".
    const url = token === null ? `${base}/` : `${base}/track/${token}`;
    const facts: MessageFacts = {
      tradingName: settings.tradingName,
      firstName: row.customerName.trim().split(/\s+/)[0] ?? '',
      orderNumber: row.orderNumber,
      deliveryNumber: row.d.number,
      trackUrl: url,
      courierName: row.d.method === 'courier' ? row.d.courierName : null,
      receivedBy: row.d.receivedBy,
      handoverCode: m.kind === 'out_for_delivery' ? row.d.handoverCode : null,
      reasonCode: failed?.reason ?? null,
      triesLeft: Math.max(0, MAX_DELIVERY_ATTEMPTS - row.d.failedAttempts),
    };
    const content = messageContent(m.kind, facts);
    if (m.channel === 'sms') {
      const sender = await this.texting?.sender(m.companyId);
      if (sender === null || sender === undefined) throw new SmsSendError('No SMS provider is set up, so the text could not be sent. Connect one in Settings > SMS providers.', true);
      await sender.send({ to: m.recipient, text: textContent(m.kind, facts) });
      return;
    }
    const footer = `You are receiving this because you placed order ${row.orderNumber}. Please do not forward it: the link shows your order.`;
    const html = layout({ heading: content.heading, greeting: content.greeting, body: content.body, cta: content.cta, actionUrl: url, footer, details: content.details });
    const text = `${content.heading}\n\n${content.greeting}\n\n${content.body}\n\n${content.details.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${content.cta}: ${url}\n\n${footer}`;
    await this.email.send({ to: m.recipient, subject: content.subject, html, text });
  }

  /** The messages a delivery has caused, newest first, with the address hidden but for its first letter. */
  async forDelivery(companyId: string, deliveryId: string): Promise<MessageView[]> {
    const rows = await this.db.select().from(deliveryMessages).where(and(eq(deliveryMessages.companyId, companyId), eq(deliveryMessages.deliveryId, deliveryId))).orderBy(desc(deliveryMessages.createdAt)).limit(50);
    return rows.map((r) => ({ id: r.id, kind: r.kind, channel: r.channel, status: r.status, recipient: shownRecipient(r.channel, r.recipient), attempts: r.attempts, note: r.lastError, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null }));
  }
}
