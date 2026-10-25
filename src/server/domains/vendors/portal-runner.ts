import * as Sentry from '@sentry/nextjs';
import { randomUUID } from 'node:crypto';
import { getContainer } from '@/server/di/container';
import { PortalAccessError, requirePortalVendor } from './portal-session';
import { ProfileError, type PortalActor } from './profile-service';
import { waitMessage, type RateRuleName } from '@/lib/rate-limit';

export type PortalResult<T> = { ok: true; data: T } | { ok: false; error: string; problems?: Record<string, string>; signedOut?: true };

export interface PortalContext extends PortalActor {
  companyId: string;
  name: string;
}

/**
 * Every vendor-portal action runs through here: the vendor comes from the session (never from the request), a refusal that
 * is the person's to fix is returned as data with the field it is about, and anything unexpected is logged and shown only as a
 * reference number. Server-action errors are masked in production, so nothing is ever thrown to the browser.
 */
export async function portal<T>(action: string, fn: (me: PortalContext) => Promise<T>, limit?: RateRuleName): Promise<PortalResult<T>> {
  try {
    const me = await requirePortalVendor();
    if (limit !== undefined) {
      const verdict = await getContainer().rateLimits.hit(limit, me.userId);
      if (!verdict.allowed) throw new ProfileError('RATE_LIMITED', waitMessage(verdict.retryAfterSeconds));
    }
    const company = await getContainer().companySettings.ensureSeeded();
    return { ok: true, data: await fn({ vendorId: me.vendorId, userId: me.userId, portalRole: me.portalRole, name: me.name, companyId: company.id }) };
  } catch (error) {
    if (error instanceof PortalAccessError) return { ok: false, error: error.message, signedOut: true };
    if (error instanceof ProfileError) return { ok: false, error: error.message, problems: error.problems };
    const reference = randomUUID();
    console.error('[vendor.portal]', { action, reference, error });
    Sentry.captureException(error, { tags: { area: 'vendor', action }, extra: { reference } });
    return { ok: false, error: `Something went wrong. Please try again. If it continues, tell us this reference: ${reference}.` };
  }
}
