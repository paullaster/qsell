import { eq } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { users } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { layout } from '@/server/domains/auth/emails';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';
import { usableEmail } from '@/lib/order-emails';
import { cartReminderContent } from '@/lib/shop-cart';
import { orElse } from '@/lib/values';
import { ShopCartService } from './service';

export const REMINDER_SWEEP_BATCH = 100;

/** The carts that are due a reminder now, for the sweep to queue one job each. */
export async function dueCartReminders(now: Date): Promise<{ userId: string; updatedAt: Date }[]> {
  return await ShopCartService.abandoned(now, REMINDER_SWEEP_BATCH);
}

/**
 * Writes to one shopper about the cart they left. The rules are checked again at the moment of sending (the cart may have changed,
 * been emptied or ordered since it was queued), and the reminder is recorded only after the mail was accepted, so a mail server that
 * is down means a retry and never a lost reminder. `updatedAt` is the state of the cart the reminder was decided for.
 */
export async function sendCartReminder(userId: string, updatedAt: Date, now: Date): Promise<'sent' | 'not_due' | 'no_address' | 'nothing_to_show'> {
  const due = (await ShopCartService.abandoned(now, 1, drizzleDb, userId)).find((c) => Math.abs(c.updatedAt.getTime() - updatedAt.getTime()) < 1000);
  if (due === undefined) return 'not_due';
  const [user] = await drizzleDb.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId));
  const to = usableEmail(user?.email);
  // A cart that cannot be written about is settled, or the sweep would queue it again every time.
  if (user === undefined || to === null) {
    await ShopCartService.markReminded(userId, updatedAt, now);
    return 'no_address';
  }
  const lines = await ShopCartService.get(userId);
  const names = await ShopCartService.namesOf(lines.map((line) => line.productId));
  const items = lines.flatMap((line) => {
    const name = names.get(line.productId);
    return name === undefined ? [] : [{ name, quantity: String(line.quantity) }];
  });
  if (items.length === 0) {
    await ShopCartService.markReminded(userId, updatedAt, now);
    return 'nothing_to_show';
  }
  const token = await ShopCartService.optoutTokenOf(userId);
  if (token === null) return 'not_due';
  const c = getContainer();
  const settings = await c.companySettings.ensureSeeded();
  const base = resolvePublicBaseUrl(settings.publicBaseUrl);
  const cartUrl = `${base}/checkout`;
  const content = cartReminderContent({ tradingName: orElse(settings.tradingName, 'our shop'), customerName: user.name, items, cartUrl, stopUrl: `${base}/cart/reminders-off?token=${token}` });
  const html = layout({ heading: content.heading, greeting: content.greeting, body: content.body, cta: content.cta, actionUrl: cartUrl, footer: content.footer, details: content.details });
  const text = `${content.heading}\n\n${content.greeting}\n\n${content.body}\n\n${content.details.map(([k, v]) => `${k} ${v}`.trim()).join('\n')}\n\n${content.cta}: ${cartUrl}\n\n${content.footer}`;
  await c.email.send({ to, subject: content.subject, html, text });
  await ShopCartService.markReminded(userId, updatedAt, now);
  return 'sent';
}
