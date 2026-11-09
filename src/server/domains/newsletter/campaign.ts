import { getContainer } from '@/server/di/container';
import { siteBaseUrl } from '@/server/domains/storefront/site';
import { newsletterMessageEmail } from './emails';
import { NewsletterService } from './service';

const BATCH = 25;

export interface CampaignStep {
  campaignId: string;
  subject: string;
  body: string;
  after: { k: string; id: string } | null;
  sent: number;
  failed: number;
}

/**
 * Sends one slice of a newsletter to the people who confirmed, and says where the next slice starts (null when the list is done).
 * A message that cannot be sent is counted and the rest go on; when none of a slice could be sent the mail server is down, so this
 * throws and the worker tries the slice again later.
 */
export async function sendCampaignSlice(step: CampaignStep): Promise<{ sent: number; failed: number; next: CampaignStep | null }> {
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const base = await siteBaseUrl();
  const { rows, next } = await NewsletterService.batchAfter(step.after, BATCH);
  let sent = 0;
  let failed = 0;
  let lastError: unknown = null;
  for (const row of rows) {
    try {
      await c.email.send(newsletterMessageEmail({ to: row.email, storeName: company.tradingName, subject: step.subject, body: step.body, unsubscribeUrl: `${base}/newsletter/unsubscribe?token=${row.token}` }));
      sent += 1;
    } catch (error) {
      failed += 1;
      lastError = error;
    }
  }
  if (rows.length > 0 && sent === 0) throw lastError instanceof Error ? lastError : new Error('The newsletter could not be sent.');
  const totals = { sent: step.sent + sent, failed: step.failed + failed };
  return { ...totals, next: next === null ? null : { ...step, after: next, ...totals } };
}
