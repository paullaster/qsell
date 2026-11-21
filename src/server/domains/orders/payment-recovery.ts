import { headers } from 'next/headers';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { paymentAttempts } from '@/server/db/drizzle/schema';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import type { ClaimAnswer, PayOptions } from '@/server/domains/payments/payment-claims';
import { isClaimableMethod } from '@/lib/payment-claim';
import { paymentUsesPhone, resolvePaymentPhone } from '@/lib/payment-phone';
import { clientAddress } from '@/lib/rate-limit';
import { promptLimited, startPayment, type CheckoutPayment } from './payment-start';
import type { Order } from '@/types/index';

/**
 * A shopper whose order is waiting for its payment: the payment is completed or paid again, never the order changed. Everything here
 * takes an order that the caller has already proved is the shopper's (their account, or their own tracking link); nothing a browser
 * sends about the order, its amount or its contents is used. What the shopper chooses is only how they paid and the code they hold.
 */

export type Recovery<T> = { ok: true; data: T } | { ok: false; error: string };

/** A prompt sent a moment ago has not been answered yet: a second one now could take the money twice. */
const PROMPT_SETTLING_SECONDS = 90;

export async function recoveryOptions(order: Order): Promise<Recovery<PayOptions>> {
  try {
    return { ok: true, data: await getContainer().paymentClaims.options(order) };
  } catch (error) {
    console.error('[payment recovery] options', order.orderNumber, error);
    return { ok: false, error: 'We could not check this order just now. Please try again.' };
  }
}

/** Reads again the payments the shop started for this order and never heard the end of: a missed answer is often all that is wrong. */
export async function recoveryRefresh(order: Order): Promise<Recovery<{ paid: boolean }>> {
  try {
    return { ok: true, data: await getContainer().paymentClaims.refresh(order.id) };
  } catch (error) {
    console.error('[payment recovery] refresh', order.orderNumber, error);
    return { ok: false, error: 'We could not check your payment just now. Please try again.' };
  }
}

async function addressOfCaller(): Promise<string> {
  const h = await headers();
  return clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for'));
}

/** The shopper says they already paid, and gives the way they paid and the provider's code. */
export async function recoveryClaim(order: Order, method: unknown, code: unknown): Promise<Recovery<ClaimAnswer>> {
  try {
    const answer = await getContainer().paymentClaims.start({ order, method, code, address: await addressOfCaller() });
    return answer.stage === 'refused' ? { ok: false, error: answer.message } : { ok: true, data: answer };
  } catch (error) {
    console.error('[payment recovery] claim', order.orderNumber, error);
    return { ok: false, error: 'We could not check your payment just now. Please try again in a moment.' };
  }
}

/** Where a claim the shopper made has got to. The claim must be on this order. */
export async function recoveryStatus(order: Order, attemptId: unknown): Promise<Recovery<ClaimAnswer>> {
  if (typeof attemptId !== 'string' || attemptId.length > 60) return { ok: false, error: 'That payment could not be found.' };
  try {
    const answer = await getContainer().paymentClaims.status({ orderId: order.id, attemptId });
    return answer === null ? { ok: false, error: 'That payment could not be found.' } : { ok: true, data: answer };
  } catch (error) {
    console.error('[payment recovery] status', order.orderNumber, error);
    return { ok: false, error: 'We could not check your payment just now. Please try again.' };
  }
}

/**
 * Tries the payment again, from any way of paying the shop offers. Before a new prompt is sent the order's earlier payments are read
 * again (the money may have arrived after all), and a prompt sent only a moment ago is waited for, so the shopper is never charged twice.
 */
export async function recoveryPayAgain(order: Order, method: unknown, paymentPhone: unknown): Promise<Recovery<CheckoutPayment | { kind: 'paid' }>> {
  try {
    const c = getContainer();
    const options = await c.paymentClaims.options(order);
    if (!options.payable.ok) return { ok: false, error: options.payable.reason };
    if (!isClaimableMethod(method) || !options.methods.some((m) => m.code === method)) return { ok: false, error: 'Please choose how you will pay.' };
    const refreshed = await c.paymentClaims.refresh(order.id);
    if (refreshed.paid) return { ok: true, data: { kind: 'paid' } };

    const [latest] = await drizzleDb.select({ createdAt: paymentAttempts.createdAt }).from(paymentAttempts).where(and(eq(paymentAttempts.orderId, order.id), eq(paymentAttempts.source, 'checkout'), inArray(paymentAttempts.status, ['initiated', 'pending', 'awaiting_redirect']))).orderBy(desc(paymentAttempts.createdAt)).limit(1);
    if (latest !== undefined && Date.now() - latest.createdAt.getTime() < PROMPT_SETTLING_SECONDS * 1000) {
      return { ok: false, error: 'A payment was started a moment ago. Finish it on your phone or in the payment window, or wait a minute and try again.' };
    }

    let payerPhone: string | null = null;
    if (paymentUsesPhone(method)) {
      const typed = typeof paymentPhone === 'string' && paymentPhone.length <= 40 && paymentPhone.trim() !== '' ? paymentPhone : null;
      const resolved = resolvePaymentPhone({ method, contactPhone: order.customerPhone, paymentPhone: typed ?? order.paymentPhone });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      payerPhone = resolved.phone;
      if (payerPhone !== null) {
        const limited = await promptLimited(payerPhone);
        if (limited !== null) return { ok: false, error: limited };
      }
    }
    // A failed payment gave its stock back; paying without holding it again would sell the same stock twice.
    const held = await InventoryReservationService.reholdOrder(order.id);
    if (!held.ok) return { ok: false, error: held.error };
    return { ok: true, data: await startPayment(order.id, method, payerPhone) };
  } catch (error) {
    console.error('[payment recovery] pay again', order.orderNumber, error);
    return { ok: false, error: 'The payment could not be started. Please try again.' };
  }
}
