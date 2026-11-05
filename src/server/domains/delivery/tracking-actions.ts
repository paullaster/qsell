'use server';

import { headers } from 'next/headers';
import { getContainer } from '@/server/di/container';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';
import type { TrackedOrder } from '@/lib/tracking-view';
import { objectOf, runDelivery } from './action-support';
import { DeliveryError } from './errors';

export interface CustomerTracking {
  order: TrackedOrder;
  /** The page the customer can keep and share with the person receiving the order; null when it has been turned off. */
  link: string | null;
}

/**
 * Public: the customer's own order and its deliveries, for someone who knows the order number and the phone or email it was placed
 * with (the same proof as the collection code), with a limit on tries by address and by order so the numbers cannot be guessed.
 */
export async function trackedDeliveryAction(raw: unknown): Promise<{ ok: true; data: CustomerTracking | null } | { ok: false; error: string }> {
  const input = objectOf(raw);
  const { orderNumber, contact } = input;
  if (typeof orderNumber !== 'string' || typeof contact !== 'string' || orderNumber.length > 60 || contact.length > 254) return { ok: false, error: 'That order could not be found.' };
  try {
    const c = getContainer();
    const h = await headers();
    const byAddress = await c.rateLimits.hit('collection_lookup_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
    if (!byAddress.allowed) return { ok: false, error: waitMessage(byAddress.retryAfterSeconds) };
    const byOrder = await c.rateLimits.hit('collection_lookup_order', orderNumber.trim().toUpperCase());
    if (!byOrder.allowed) return { ok: false, error: waitMessage(byOrder.retryAfterSeconds) };
    const found = await c.orders.findByNumberAndContact(orderNumber, contact);
    if (found === null) return { ok: false, error: 'That order could not be found.' };
    const company = await c.companySettings.ensureSeeded();
    const order = await c.trackedOrders.forOrder(company.id, found.id);
    if (order === null) return { ok: true, data: null };
    const token = await c.trackingLinks.tokenFor(company.id, found.id);
    return { ok: true, data: { order, link: token === null ? null : `${resolvePublicBaseUrl(company.publicBaseUrl)}/track/${token}` } };
  } catch (error: unknown) {
    console.error('[delivery] tracked delivery', error);
    return { ok: false, error: 'The order could not be checked just now.' };
  }
}

export interface TrackingLinkView {
  url: string | null;
  active: boolean;
  views: number;
  lastViewedAt: string | null;
  canManage: boolean;
}

/** An order's tracking link as the shop sees it: the address to send, and how often it has been opened. */
export async function trackingLinkAction(orderId: unknown) {
  return await runDelivery('deliveries:read', async (ctx): Promise<TrackingLinkView> => {
    if (typeof orderId !== 'string' || orderId.length === 0 || orderId.length > 100) throw new DeliveryError('That order could not be found.', 'NOT_FOUND');
    const c = getContainer();
    const [state, token, settings] = await Promise.all([c.trackingLinks.describe(ctx.companyId, orderId), c.trackingLinks.tokenFor(ctx.companyId, orderId), c.companySettings.ensureSeeded()]);
    const { canPermission } = await import('@/server/domains/access-control/guard');
    return { ...state, url: token === null ? null : `${resolvePublicBaseUrl(settings.publicBaseUrl)}/track/${token}`, canManage: await canPermission('deliveries:fulfil') };
  });
}

/** Turns an order's link off, or turns it off and makes a new one (when it was shared with someone it should not have been). */
export async function replaceTrackingLinkAction(raw: unknown) {
  return await runDelivery(
    'deliveries:fulfil',
    async (ctx) => {
      const i = objectOf(raw);
      if (typeof i.orderId !== 'string' || i.orderId.length === 0 || i.orderId.length > 100) throw new DeliveryError('That order could not be found.', 'NOT_FOUND');
      const done = await getContainer().trackingLinks.replace({ companyId: ctx.companyId, userId: ctx.userId }, i.orderId, { reason: i.reason, renew: i.renew === true });
      if (!done.ok) throw new DeliveryError(done.message, 'BAD_INPUT');
      return { renewed: done.token !== null };
    },
    ['/admin/orders'],
  );
}

/**
 * Public: the customer chooses another day for a delivery that could not be made, from their own tracking page. The link is the proof
 * (as for viewing), limited by address and by link; only a delivery of that order that failed with tries left can be moved, to a day
 * after today within two weeks. The change is recorded as the customer's, with no account behind it.
 */
export async function rescheduleByLinkAction(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const input = objectOf(raw);
  const { token, deliveryNumber, day } = input;
  if (typeof deliveryNumber !== 'string' || deliveryNumber.length > 60) return { ok: false, error: 'That delivery could not be found.' };
  try {
    const { isWellFormedTrackingToken } = await import('@/lib/tracking-token');
    if (!isWellFormedTrackingToken(token)) return { ok: false, error: 'That link is not valid.' };
    const { fingerprintSecret } = await import('@/server/domains/payments/crypto');
    const c = getContainer();
    const h = await headers();
    const byAddress = await c.rateLimits.hit('tracking_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
    const byLink = await c.rateLimits.hit('tracking_token', fingerprintSecret(token).slice(0, 24));
    if (!byAddress.allowed || !byLink.allowed) return { ok: false, error: waitMessage(Math.max(byAddress.retryAfterSeconds, byLink.retryAfterSeconds)) };
    const link = await c.trackingLinks.resolve(token);
    if (link === null) return { ok: false, error: 'That link is not valid.' };
    const found = await c.deliveryDocuments.idForOrderNumber(link.companyId, link.orderId, deliveryNumber);
    if (found === null) return { ok: false, error: 'That delivery could not be found.' };
    const done = await c.deliveryDocuments.reattempt({ companyId: link.companyId, userId: 'customer', kind: 'customer' }, found, { day, note: 'Asked for by the customer on their tracking page' });
    return done.ok ? { ok: true } : { ok: false, error: done.message };
  } catch (error: unknown) {
    console.error('[delivery] reschedule by link', error);
    return { ok: false, error: 'The change could not be made just now. Please try again.' };
  }
}
