'use server';

import { OrderStages } from './stages';
import { drizzleDb } from '@/server/db/drizzle/client';
import { CheckoutAttempts, cartSummaryOf, guestSessionRef } from './checkout-attempts';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import { startOrderPayment } from '@/server/domains/payments/start-payment';
import type { PaymentProviderCode } from '@/server/domains/payments/types';
import { CheckoutRefused, OrdersService } from './service';
import { parseCheckoutInput } from '@/lib/checkout-input';
import { orElse } from '@/lib/values';
import { paymentUsesPhone, resolvePaymentPhone } from '@/lib/payment-phone';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import type { Order } from '@/types/index';

/** Checkout answers as data: the text of a thrown server-action error is masked in production, so a shopper would never see the reason. */
export type CheckoutResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** What happens next for the person paying. */
export type CheckoutPayment =
  /** Nothing to pay now (the order is on the customer's account). */
  | { kind: 'none' }
  /** A prompt was sent to their phone. */
  | { kind: 'stk'; attemptId: string; message: string }
  /** They finish paying with the provider; the shop waits for it to answer. */
  | { kind: 'hosted'; attemptId: string; redirectUrl: string | null; message: string }
  | { kind: 'failed'; message: string };

export interface CheckoutPlaced {
  order: Order;
  payment: CheckoutPayment;
}

const GENERIC = 'We could not place your order just now. Please check your details and try again.';

const PHONE_PROVIDERS: readonly PaymentProviderCode[] = ['mpesa_daraja', 'kcb_buni'];

/** A prompt to a phone is limited per address and per number, so nobody's phone can be flooded with requests. Returns the words to show, or null. */
async function promptLimited(phone: string): Promise<string | null> {
  const h = await headers();
  for (const [rule, subject] of [['payment_prompt_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for'))], ['payment_prompt_phone', phone]] as const) {
    const verdict = await getContainer().rateLimits.hit(rule, subject);
    if (!verdict.allowed) return waitMessage(verdict.retryAfterSeconds);
  }
  return null;
}

async function startPayment(orderId: string, providerCode: PaymentProviderCode, payerPhone: string | null): Promise<CheckoutPayment> {
  try {
    const result = await startOrderPayment({ orderId, providerCode, payerPhone, source: 'shop' });
    if (result.status === 'failed') return { kind: 'failed', message: orElse(result.errorMessage, 'The payment could not be started.') };
    if (PHONE_PROVIDERS.includes(providerCode)) {
      return { kind: 'stk', attemptId: result.attemptId, message: orElse(result.customerMessage, 'Enter your PIN on your phone to complete the payment.') };
    }
    return { kind: 'hosted', attemptId: result.attemptId, redirectUrl: result.redirectUrl ?? null, message: orElse(result.customerMessage, 'Complete the payment in the provider window.') };
  } catch (error) {
    console.error('[checkout] payment start', error);
    // The order is saved and can be tried again; the failed start is on its timeline with its time and what went wrong (for staff).
    await OrderStages.move(drizzleDb, orderId, 'payment_started', 'failed', {
      source: 'shop',
      reasonCode: 'payment_start_failed',
      message: 'The payment could not be started.',
      detail: { provider: providerCode, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' },
    }).catch((recordError: unknown) => console.error('[checkout] could not record the failed start', recordError));
    return { kind: 'failed', message: 'The payment could not be started.' };
  }
}

/**
 * Public: places an order and starts its payment in one step. Prices, stock, the customer and the payment method are
 * all decided here from the shop's own data; nothing the browser says about money is used.
 */
export async function placeOrderAction(raw: unknown): Promise<CheckoutResult<CheckoutPlaced>> {
  // The checkout is on record from the moment the shopper presses pay, so a refusal leaves its time and reason behind.
  const h = await headers();
  const attempt = await CheckoutAttempts.start({
    sessionRef: guestSessionRef(clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')), h.get('user-agent') ?? ''),
    cart: cartSummaryOf(raw),
  });
  const input = parseCheckoutInput(raw);
  if (!input.ok) {
    await CheckoutAttempts.refuse(attempt, { stage: 'input', code: 'invalid_input', message: input.error });
    return { ok: false, error: input.error };
  }
  // The number the payment is made from: the one the customer chose, else their contact number. Checked before anything is reserved.
  const method = input.value.paymentMethod;
  const payerPhone = paymentUsesPhone(method) ? (input.value.paymentPhone ?? null) : null;
  const resolved = resolvePaymentPhone({ method, contactPhone: input.value.customerPhone, paymentPhone: input.value.paymentPhone });
  const promptTo = resolved.ok ? resolved.phone : null;
  if (promptTo !== null && paymentUsesPhone(method)) {
    const limited = await promptLimited(promptTo);
    if (limited !== null) {
      await CheckoutAttempts.refuse(attempt, { stage: 'rate_limit', code: 'rate_limited', message: limited });
      return { ok: false, error: limited };
    }
  }
  let order: Order;
  try {
    order = await OrdersService.createCheckout({ ...input.value, checkoutStartedAt: attempt?.startedAt ?? null });
  } catch (error) {
    if (error instanceof CheckoutRefused) {
      await CheckoutAttempts.refuse(attempt, { stage: 'placement', code: error.code, message: error.message });
      return { ok: false, error: error.message };
    }
    console.error('[checkout] place order', error);
    await CheckoutAttempts.refuse(attempt, { stage: 'placement', code: 'other', message: GENERIC });
    return { ok: false, error: GENERIC };
  }
  await CheckoutAttempts.placed(attempt, order.id);
  revalidatePath('/admin/orders');
  revalidatePath('/admin/customers');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  if (method === 'on_account') return { ok: true, data: { order, payment: { kind: 'none' } } };
  // Card payments go through the hosted checkout, as before.
  const provider: PaymentProviderCode = method === 'card_direct' ? 'pesapal_v3' : method;
  return { ok: true, data: { order, payment: await startPayment(order.id, provider, payerPhone ?? promptTo) } };
}

/** Public: tries the payment of an order again (a declined prompt, a closed window), optionally from a different phone number. */
export async function retryPaymentAction(raw: unknown): Promise<CheckoutResult<CheckoutPayment>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const { orderId, providerCode, paymentPhone } = input;
  if (typeof orderId !== 'string' || orderId === '' || orderId.length > 100) return { ok: false, error: 'That order could not be found.' };
  const code = (['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni'] as const).find((value) => value === providerCode);
  if (code === undefined) return { ok: false, error: 'Please choose how you will pay.' };
  let payerPhone: string | null = null;
  if (paymentUsesPhone(code)) {
    const order = await getContainer().orders.getById(orderId);
    if (!order) return { ok: false, error: 'That order could not be found.' };
    // A number typed now wins; otherwise the one the order was last paid from, else the contact number.
    const typed = typeof paymentPhone === 'string' && paymentPhone.length <= 40 && paymentPhone.trim() !== '' ? paymentPhone : null;
    const resolved = resolvePaymentPhone({ method: code, contactPhone: order.customerPhone, paymentPhone: typed ?? order.paymentPhone });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    payerPhone = resolved.phone;
    if (payerPhone !== null) {
      const limited = await promptLimited(payerPhone);
      if (limited !== null) return { ok: false, error: limited };
    }
  }
  return { ok: true, data: await startPayment(orderId, code, payerPhone) };
}

/** Public: the order as the shop has it now, for someone who knows its number and the phone or email it was placed with. */
export async function confirmedOrderAction(raw: unknown): Promise<CheckoutResult<Order | null>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const { orderNumber, contact } = input;
  if (typeof orderNumber !== 'string' || typeof contact !== 'string' || orderNumber.length > 60 || contact.length > 254) return { ok: false, error: 'That order could not be found.' };
  try {
    return { ok: true, data: await getContainer().orders.findByNumberAndContact(orderNumber, contact) };
  } catch (error) {
    console.error('[checkout] confirm order', error);
    return { ok: false, error: 'The order could not be checked just now.' };
  }
}
