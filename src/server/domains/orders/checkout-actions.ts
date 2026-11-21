'use server';

import { CheckoutAttempts, cartSummaryOf, guestSessionRef } from './checkout-attempts';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import { promptLimited, startPayment, type CheckoutPayment } from './payment-start';
import type { PaymentProviderCode } from '@/server/domains/payments/types';
import { CheckoutRefused, OrdersService } from './service';
import { parseCheckoutInput } from '@/lib/checkout-input';
import { paymentUsesPhone, resolvePaymentPhone } from '@/lib/payment-phone';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { proveOrder } from './order-proof';
import { enqueueOrderEmail } from '@/server/queue/worker';
import { auth } from '@/auth';
import { ShopCartService } from '@/server/domains/cart/service';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import type { Order } from '@/types/index';

/** Checkout answers as data: the text of a thrown server-action error is masked in production, so a shopper would never see the reason. */
export type CheckoutResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type { CheckoutPayment } from './payment-start';

export interface CheckoutPlaced {
  order: Order;
  payment: CheckoutPayment;
}

const GENERIC = 'We could not place your order just now. Please check your details and try again.';

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
  // Placing an order holds stock, so it is limited per address and per phone: one visitor cannot hold everything on the shelves.
  const address = clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for'));
  for (const [rule, subject] of [['checkout_ip', address], ['checkout_contact', input.value.customerPhone.replace(/\D/g, '')]] as const) {
    const verdict = await getContainer().rateLimits.hit(rule, subject);
    if (!verdict.allowed) {
      const limited = waitMessage(verdict.retryAfterSeconds);
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
  revalidatePath('/admin/customers/list');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  // The order holds the cart's stock, so a signed-in shopper's saved cart is spent too (it must not come back on another device or be sent as a reminder).
  try {
    const user = (await auth())?.user;
    if (user?.role === 'customer') await ShopCartService.clear(user.id);
  } catch (error) {
    console.error('[checkout] could not clear the saved cart', error);
  }
  // The shopper is written to that the order is held, and the company's people are told if they chose to be (who is decided when it is sent); a queue that is down never stops the order.
  await enqueueOrderEmail(order.id, 'placed').catch((error: unknown) => console.error('[checkout] could not queue the order mail', error));
  // An order on account is invoiced as it is placed, so its tax invoice is issued now (numbering is once per order; KRA signing follows the company's rules).
  if (method === 'on_account') void getContainer().invoices.generatePdf(order.id, 'tax_invoice').catch((error: unknown) => console.error('[checkout] tax invoice not issued', order.id, error));
  // On account is paid on its invoice; pay on delivery is paid to the rider at the door. Neither starts a payment now.
  if (method === 'on_account' || method === 'pay_on_delivery') return { ok: true, data: { order, payment: { kind: 'none' } } };
  // Card payments go through the hosted checkout, as before.
  const provider: PaymentProviderCode = method === 'card_direct' ? 'pesapal_v3' : method;
  return { ok: true, data: { order, payment: await startPayment(order.id, provider, payerPhone ?? promptTo) } };
}

/**
 * Public: tries the payment of an order again (a declined prompt, a closed window), optionally from a different phone number. The
 * caller proves the order with its number and the phone or email it was placed with, and the stock is held again first: a failed
 * payment gives its hold back, and paying without it would sell the same stock twice.
 */
export async function retryPaymentAction(raw: unknown): Promise<CheckoutResult<CheckoutPayment>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const { orderNumber, contact, providerCode, paymentPhone } = input;
  if (typeof orderNumber !== 'string' || typeof contact !== 'string' || orderNumber.length > 60 || contact.length > 254) return { ok: false, error: 'That order could not be found.' };
  const code = (['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni'] as const).find((value) => value === providerCode);
  if (code === undefined) return { ok: false, error: 'Please choose how you will pay.' };
  const proof = await proveOrder(orderNumber, contact);
  if (!proof.ok) return { ok: false, error: proof.error };
  const order = proof.order;
  if (order === null) return { ok: false, error: 'That order could not be found.' };
  let payerPhone: string | null = null;
  if (paymentUsesPhone(code)) {
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
  const held = await InventoryReservationService.reholdOrder(order.id);
  if (!held.ok) return { ok: false, error: held.error };
  return { ok: true, data: await startPayment(order.id, code, payerPhone) };
}

/** Public: the order as the shop has it now, for someone who knows its number and the phone or email it was placed with. */
export async function confirmedOrderAction(raw: unknown): Promise<CheckoutResult<Order | null>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const { orderNumber, contact } = input;
  if (typeof orderNumber !== 'string' || typeof contact !== 'string' || orderNumber.length > 60 || contact.length > 254) return { ok: false, error: 'That order could not be found.' };
  try {
    const proof = await proveOrder(orderNumber, contact);
    return proof.ok ? { ok: true, data: proof.order } : { ok: false, error: proof.error };
  } catch (error) {
    console.error('[checkout] confirm order', error);
    return { ok: false, error: 'The order could not be checked just now.' };
  }
}
