import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';
import { layout } from '@/server/domains/auth/emails';
import type { EmailPort } from '@/server/ports/communications';
import { durationWords } from '@/lib/order-sla';
import { ORDER_STAGES, isOrderStage } from '@/lib/order-stages';

export interface LateOrder {
  orderNumber: string;
  stage: string;
  waitedMinutes: number;
}

const LISTED = 20;

/**
 * The mail about orders that waited too long. One message per sweep and level, listing the oldest orders and how many more there
 * are, so a bad hour is one mail and not hundreds. A mail that cannot be sent is logged and never undoes the breach: it is on the
 * Order flow panel regardless.
 */
export class OrderSlaNotifier {
  constructor(
    private readonly email: EmailPort,
    private readonly company: CompanySettingsRepository,
  ) {}

  async send(level: 'raised' | 'escalated', orders: readonly LateOrder[], to: readonly string[]): Promise<void> {
    if (orders.length === 0) return;
    try {
      const settings = await this.company.ensureSeeded();
      const recipients = [...new Set((to.length === 0 ? [settings.email] : [...to]).map((a) => a.trim().toLowerCase()).filter((a) => a !== ''))];
      if (recipients.length === 0) return;
      const store = settings.tradingName.trim() === '' ? 'our store' : settings.tradingName;
      const url = `${resolvePublicBaseUrl(settings.publicBaseUrl)}/admin/orders`;
      const many = orders.length === 1 ? '1 order has' : `${String(orders.length)} orders have`;
      const heading = level === 'raised' ? `${many} waited too long` : `${many} still not moved on`;
      const body = level === 'raised' ? 'These orders have been in one stage for longer than its target. Open Orders, then Order flow, to see and acknowledge them.' : 'These orders were reported late earlier and are still in the same stage. Please look at them now.';
      const details: (readonly [string, string])[] = orders.slice(0, LISTED).map((o) => [o.orderNumber, `${isOrderStage(o.stage) ? ORDER_STAGES[o.stage].label : o.stage}, ${durationWords(o.waitedMinutes)}`] as const);
      if (orders.length > LISTED) details.push(['And', `${String(orders.length - LISTED)} more`]);
      const footer = 'You are receiving this because your address is on the order target list.';
      const html = layout({ heading, greeting: 'Hello,', body, cta: 'Open orders', actionUrl: url, footer, details });
      const text = `${heading}\n\n${body}\n\n${details.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen orders: ${url}\n\n${footer}`;
      for (const to1 of recipients) await this.email.send({ to: to1, subject: `${heading} · ${store}`, html, text });
    } catch (error) {
      console.error('[orders.sla] mail not sent', { level, error });
    }
  }
}
