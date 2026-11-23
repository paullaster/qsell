import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { pushSubscriptions, users } from '@/server/db/drizzle/schema';
import { acceptanceNotice, type AcceptanceFacts, type AcceptanceSettings } from '@/lib/quote-acceptance';
import { internationalPhone } from '@/lib/sms-providers';
import { addressing } from '@/server/domains/email-routing/email-routes';
import type { EmailRouteService } from '@/server/domains/email-routing/email-route-service';
import type { SmsAccounts } from '@/server/domains/sms/accounts';
import type { EmailPort } from '@/server/ports/communications';
import type { PushPort } from '@/server/ports/push';
import { SmsSendError } from '@/server/ports/sms';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What happened on one way of telling staff, in words for the quote's history. */
export interface ChannelResult {
  channel: 'email' | 'sms' | 'push';
  status: 'sent' | 'off' | 'skipped' | 'failed';
  detail: string;
}

export interface NoticeInput {
  companyId: string;
  /** The staff member who made the quote and the one who sent it: always among those told, with whoever Email routing names. */
  ownerUserId: string | null;
  senderUserId: string | null;
  customerEmail: string | null;
  settings: AcceptanceSettings;
  facts: AcceptanceFacts;
  /** The shop's own address for its mail, for the "from" line. */
  sender: { name: string; address: string };
}

/**
 * Tells the staff concerned that a customer accepted a quote, by email, text message and browser alert, as the company chose. The
 * three are independent: one that is off, not set up, or fails never stops the others, and nothing here can make the acceptance fail.
 * Each way's outcome is returned to be written to the quote's history.
 */
export class QuoteAcceptanceNotices {
  constructor(
    private readonly db: DrizzleDb,
    private readonly email: EmailPort,
    private readonly routes: EmailRouteService,
    private readonly sms: SmsAccounts,
    private readonly push: PushPort,
  ) {}

  async send(input: NoticeInput): Promise<ChannelResult[]> {
    const notice = acceptanceNotice(input.facts);
    const own = (id: string | null): string | null => (id !== null && UUID.test(id) ? id : null);
    const owner = own(input.ownerUserId);
    const sender = own(input.senderUserId);
    // Who is told by text and alert: the people the point names, the one who made the quote and the one who sent it.
    const named = await this.routes.staffIds(input.companyId, 'quote_accepted_staff', { actorUserId: null, ownerUserId: owner }).catch(() => []);
    const people = [...new Set([...named, ...(owner === null ? [] : [owner]), ...(sender === null ? [] : [sender])])];

    const results: ChannelResult[] = [];
    results.push(await this.byEmail(input, notice, owner, sender));
    results.push(await this.byText(input, notice, people));
    results.push(await this.byAlert(input, notice, people));
    return results;
  }

  private async byEmail(input: NoticeInput, notice: ReturnType<typeof acceptanceNotice>, owner: string | null, sender: string | null): Promise<ChannelResult> {
    if (!input.settings.notifyEmail) return { channel: 'email', status: 'off', detail: 'Email is switched off for this.' };
    try {
      const route = await this.routes.resolve(input.companyId, 'quote_accepted_staff', { customerEmail: input.customerEmail, actorUserId: null, ownerUserId: owner });
      if (!route.send) return { channel: 'email', status: 'skipped', detail: route.reason ?? 'There is nobody to write to. Choose who is told in Settings, Email routing.' };
      const to = [...route.to];
      // Whoever sent the quote is told too, once, even when the list does not name them.
      if (sender !== null && sender !== owner) {
        const [row] = await this.db.select({ email: users.email }).from(users).where(and(eq(users.id, sender), eq(users.status, 'active'))).limit(1);
        if (row !== undefined && !to.some((a) => a.toLowerCase() === row.email.toLowerCase()) && !route.cc.some((a) => a.toLowerCase() === row.email.toLowerCase())) to.push(row.email);
      }
      await this.email.send({ ...addressing({ ...route, to }), subject: notice.subject, html: notice.html, text: notice.text, sender: input.sender });
      return { channel: 'email', status: 'sent', detail: `Written to ${String(to.length + route.cc.length + route.bcc.length)} ${to.length + route.cc.length + route.bcc.length === 1 ? 'address' : 'addresses'}.` };
    } catch (error) {
      console.error('[quote acceptance] the email was not sent', error);
      return { channel: 'email', status: 'failed', detail: 'The email could not be sent.' };
    }
  }

  private async byText(input: NoticeInput, notice: ReturnType<typeof acceptanceNotice>, people: string[]): Promise<ChannelResult> {
    if (!input.settings.notifySms) return { channel: 'sms', status: 'off', detail: 'Text messages are switched off for this.' };
    try {
      const sender = await this.sms.defaultSender(input.companyId);
      if (sender === null) return { channel: 'sms', status: 'skipped', detail: 'No text message provider is connected yet (Settings, Text messages).' };
      if (people.length === 0) return { channel: 'sms', status: 'skipped', detail: 'There is nobody to text.' };
      const rows = await this.db.select({ phone: users.phone }).from(users).where(and(inArray(users.id, people), eq(users.status, 'active')));
      const numbers = [...new Set(rows.map((r) => internationalPhone(r.phone)).filter((p): p is string => p !== null))];
      if (numbers.length === 0) return { channel: 'sms', status: 'skipped', detail: 'None of the staff concerned has a phone number on their account.' };
      let sent = 0;
      let lastError = '';
      for (const to of numbers) {
        try {
          await sender.send({ to, text: notice.sms });
          sent += 1;
        } catch (error) {
          lastError = error instanceof SmsSendError ? error.message : 'A text message could not be sent.';
        }
      }
      if (sent === 0) return { channel: 'sms', status: 'failed', detail: lastError };
      return { channel: 'sms', status: 'sent', detail: `Texted ${String(sent)} of ${String(numbers.length)}.${lastError === '' ? '' : ` One failed: ${lastError}`}` };
    } catch (error) {
      console.error('[quote acceptance] the texts were not sent', error);
      return { channel: 'sms', status: 'failed', detail: 'The text messages could not be sent.' };
    }
  }

  private async byAlert(input: NoticeInput, notice: ReturnType<typeof acceptanceNotice>, people: string[]): Promise<ChannelResult> {
    if (!input.settings.notifyPush) return { channel: 'push', status: 'off', detail: 'Browser alerts are switched off for this.' };
    if (this.push.publicKey() === null) return { channel: 'push', status: 'skipped', detail: 'Browser alerts are not set up on this installation yet.' };
    try {
      if (people.length === 0) return { channel: 'push', status: 'skipped', detail: 'There is nobody to alert.' };
      const subs = await this.db.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.companyId, input.companyId), inArray(pushSubscriptions.userId, people)));
      if (subs.length === 0) return { channel: 'push', status: 'skipped', detail: 'None of the staff concerned has turned browser alerts on.' };
      let sent = 0;
      for (const sub of subs) {
        try {
          const outcome = await this.push.send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, notice.push);
          if (outcome === 'gone') await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          else sent += 1;
        } catch (error) {
          console.error('[quote acceptance] an alert was not sent', error);
        }
      }
      return sent === 0 ? { channel: 'push', status: 'failed', detail: 'The alerts could not be sent.' } : { channel: 'push', status: 'sent', detail: `Alerted ${String(sent)} ${sent === 1 ? 'browser' : 'browsers'}.` };
    } catch (error) {
      console.error('[quote acceptance] the alerts were not sent', error);
      return { channel: 'push', status: 'failed', detail: 'The alerts could not be sent.' };
    }
  }
}
