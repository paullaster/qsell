'use server';

import { headers } from 'next/headers';
import { getContainer } from '@/server/di/container';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { isWellFormedTrackingToken } from '@/lib/tracking-token';
import { fingerprintSecret } from '@/server/domains/payments/crypto';
import { recoveryClaim, recoveryOptions, recoveryPayAgain, recoveryRefresh, recoveryStatus, type Recovery } from './payment-recovery';
import type { Order } from '@/types/index';

/**
 * Finishing the payment of an order from the link in the shopper's own message (a shopper without an account). The link is the proof,
 * so it is looked up and limited by address and by link exactly as the tracking page does before anything is done. As everywhere,
 * what follows never changes the order: only how it is paid.
 */
async function orderOfLink(token: unknown): Promise<{ ok: true; order: Order } | { ok: false; error: string }> {
  if (!isWellFormedTrackingToken(token)) return { ok: false, error: 'This link is not valid.' };
  const c = getContainer();
  const h = await headers();
  const byAddress = await c.rateLimits.hit('tracking_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
  const byLink = await c.rateLimits.hit('tracking_token', fingerprintSecret(token).slice(0, 24));
  if (!byAddress.allowed || !byLink.allowed) return { ok: false, error: waitMessage(Math.max(byAddress.retryAfterSeconds, byLink.retryAfterSeconds)) };
  const link = await c.trackingLinks.resolve(token);
  const order = link === null ? null : await c.orders.getById(link.orderId);
  return order ? { ok: true, order } : { ok: false, error: 'This order was not found.' };
}

async function withLinkedOrder<T>(token: unknown, run: (order: Order) => Promise<Recovery<T>>): Promise<Recovery<T>> {
  try {
    const found = await orderOfLink(token);
    return found.ok ? await run(found.order) : found;
  } catch (error) {
    console.error('[track] finishing a payment', error);
    return { ok: false, error: 'This could not be done just now. Please try again.' };
  }
}

export async function trackPayOptionsAction(token: string) {
  return await withLinkedOrder(token, recoveryOptions);
}

export async function trackRefreshPaymentAction(token: string) {
  return await withLinkedOrder(token, recoveryRefresh);
}

export async function trackClaimPaymentAction(input: { token: string; method: string; code: string }) {
  const i = typeof input === 'object' ? input : { token: '', method: '', code: '' };
  return await withLinkedOrder(i.token, (order) => recoveryClaim(order, i.method, i.code));
}

export async function trackClaimStatusAction(input: { token: string; attemptId: string }) {
  const i = typeof input === 'object' ? input : { token: '', attemptId: '' };
  return await withLinkedOrder(i.token, (order) => recoveryStatus(order, i.attemptId));
}

export async function trackPayAgainAction(input: { token: string; method: string; paymentPhone?: string }) {
  const i = typeof input === 'object' ? input : { token: '', method: '', paymentPhone: '' };
  return await withLinkedOrder(i.token, (order) => recoveryPayAgain(order, i.method, i.paymentPhone));
}
