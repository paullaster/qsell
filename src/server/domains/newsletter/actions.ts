'use server';

import { headers } from 'next/headers';
import { getContainer } from '@/server/di/container';
import { runSetting, type SettingsResult } from '@/server/domains/settings/action-runner';
import { SettingsError } from '@/server/domains/settings/errors';
import { siteBaseUrl } from '@/server/domains/storefront/site';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { csvCell, isNewsletterToken, newsletterEmail, parseNewsletterDraft } from '@/lib/newsletter';
import { auth } from '@/auth';
import { enqueueNewsletterSlice } from '@/server/queue/worker';
import { newsletterConfirmEmail, newsletterMessageEmail } from './emails';
import { NewsletterService, type SubscriberStatus } from './service';

type Result = { ok: true; message: string } | { ok: false; error: string };

const SAME_ANSWER = 'Thank you. If that address can receive mail, we have sent it a link to confirm your subscription.';

/** Public: ask for the news. The answer is the same whether or not the address is already on the list. */
export async function subscribeNewsletterAction(raw: unknown): Promise<Result> {
  const email = newsletterEmail(typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).email : null);
  if (email === null) return { ok: false, error: 'Please enter a valid email address.' };
  const h = await headers();
  for (const [rule, subject] of [['newsletter_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for'))], ['newsletter_email', email]] as const) {
    const verdict = await getContainer().rateLimits.hit(rule, subject);
    if (!verdict.allowed) return { ok: false, error: waitMessage(verdict.retryAfterSeconds) };
  }
  try {
    const token = await NewsletterService.request(email);
    if (token !== null) {
      const company = await getContainer().companySettings.ensureSeeded();
      const base = await siteBaseUrl();
      await getContainer().email.send(newsletterConfirmEmail({ to: email, storeName: company.tradingName, confirmUrl: `${base}/newsletter/confirm?token=${token}` }));
    }
    return { ok: true, message: SAME_ANSWER };
  } catch (error) {
    // Even a failure to send gives the same answer to the visitor; it is logged for the team.
    console.error('[newsletter] subscribe', error);
    return { ok: true, message: SAME_ANSWER };
  }
}

/** Public: the person followed the link in the confirmation message (and pressed the button on the page it leads to). */
export async function confirmNewsletterAction(token: unknown): Promise<Result> {
  if (!isNewsletterToken(token)) return { ok: false, error: 'This link is not valid.' };
  try {
    return (await NewsletterService.confirm(token)) ? { ok: true, message: 'You are subscribed. Thank you.' } : { ok: false, error: 'This link is not valid any more. Please sign up again.' };
  } catch (error) {
    console.error('[newsletter] confirm', error);
    return { ok: false, error: 'We could not confirm that just now. Please try again.' };
  }
}

export async function unsubscribeNewsletterAction(token: unknown): Promise<Result> {
  if (!isNewsletterToken(token)) return { ok: false, error: 'This link is not valid.' };
  try {
    return (await NewsletterService.unsubscribe(token)) ? { ok: true, message: 'You are unsubscribed. You will not receive any more news from us.' } : { ok: false, error: 'This link is not valid.' };
  } catch (error) {
    console.error('[newsletter] unsubscribe', error);
    return { ok: false, error: 'We could not do that just now. Please try again.' };
  }
}

// ── For the people who run the list ──────────────────────────────────────

const STATUSES: readonly SubscriberStatus[] = ['pending', 'subscribed', 'unsubscribed'];

export async function newsletterPageAction(raw: unknown): Promise<SettingsResult<Awaited<ReturnType<typeof NewsletterService.page>>>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const status = STATUSES.find((value) => value === input.status) ?? 'subscribed';
  return runSetting('newsletter:manage', () =>
    NewsletterService.page({ status, query: typeof input.query === 'string' ? input.query : '', cursor: typeof input.cursor === 'string' && input.cursor.length <= 600 ? input.cursor : null }),
  );
}

/** The confirmed addresses as a CSV file's text. */
export async function exportNewsletterAction(): Promise<SettingsResult<string>> {
  return runSetting('newsletter:manage', async () => {
    const rows = await NewsletterService.confirmedEmails();
    if (rows.length > 100_000) throw new SettingsError('The list is too large to export here.');
    return ['Email,Confirmed', ...rows.map((row) => `${csvCell(row.email)},${csvCell(row.confirmedAt?.toISOString() ?? '')}`)].join('\r\n');
  });
}

/**
 * Writes the news. `test` sends one copy to the person writing it, to see it as a reader will. `all` queues it for everyone who
 * confirmed, a slice at a time; the campaign id comes from the screen so pressing twice sends once. Plain text only.
 */
export async function sendNewsletterAction(raw: unknown): Promise<SettingsResult<{ queued: boolean; sentTo: string | null }>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return runSetting('newsletter:manage', async (ctx) => {
    const draft = parseNewsletterDraft(input);
    if (!draft.ok) throw new SettingsError(draft.error);
    const base = await siteBaseUrl();
    if (input.mode === 'test') {
      const to = (await auth())?.user.email ?? '';
      if (newsletterEmail(to) === null) throw new SettingsError('Your account has no email address to send the test to.');
      await getContainer().email.send(newsletterMessageEmail({ to, storeName: ctx.company.tradingName, ...draft.value, unsubscribeUrl: `${base}/newsletter/unsubscribe?token=${'x'.repeat(43)}` }));
      return { queued: false, sentTo: to };
    }
    const campaignId = typeof input.campaignId === 'string' && /^[0-9a-f-]{36}$/i.test(input.campaignId) ? input.campaignId : null;
    if (campaignId === null) throw new SettingsError('This message could not be sent. Reload the page and try again.');
    await enqueueNewsletterSlice({ campaignId, ...draft.value, after: null, sent: 0, failed: 0 });
    await getContainer().decisionLog.record({ companyId: ctx.companyId, subject: { type: 'newsletter', id: campaignId }, action: 'newsletter.queued', actor: { type: 'user', id: ctx.userId }, from: '', to: draft.value.subject, reason: { text: `Newsletter "${draft.value.subject}" was queued for everyone who confirmed.` } });
    return { queued: true, sentTo: null };
  });
}
