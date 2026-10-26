'use server';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import { initiateBranchPaymentAction } from '@/server/domains/payments/actions';
import type { PaymentProviderCode } from '@/server/domains/payments/types';
import { CheckoutRefused, OrdersService } from './service';
import { parseCheckoutInput } from '@/lib/checkout-input';
import { orElse } from '@/lib/values';
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

async function startPayment(orderId: string, providerCode: PaymentProviderCode): Promise<CheckoutPayment> {
  try {
    const result = await initiateBranchPaymentAction({ orderId, providerCode });
    if (result.status === 'failed') return { kind: 'failed', message: orElse(result.errorMessage, 'The payment could not be started.') };
    if (PHONE_PROVIDERS.includes(providerCode)) {
      return { kind: 'stk', attemptId: result.attemptId, message: orElse(result.customerMessage, 'Enter your PIN on your phone to complete the payment.') };
    }
    return { kind: 'hosted', attemptId: result.attemptId, redirectUrl: result.redirectUrl ?? null, message: orElse(result.customerMessage, 'Complete the payment in the provider window.') };
  } catch (error) {
    console.error('[checkout] payment start', error);
    return { kind: 'failed', message: 'The payment could not be started.' };
  }
}

/**
 * Public: places an order and starts its payment in one step. Prices, stock, the customer and the payment method are
 * all decided here from the shop's own data; nothing the browser says about money is used.
 */
export async function placeOrderAction(raw: unknown): Promise<CheckoutResult<CheckoutPlaced>> {
  const input = parseCheckoutInput(raw);
  if (!input.ok) return { ok: false, error: input.error };
  let order: Order;
  try {
    order = await OrdersService.createCheckout(input.value);
  } catch (error) {
    if (error instanceof CheckoutRefused) return { ok: false, error: error.message };
    console.error('[checkout] place order', error);
    return { ok: false, error: GENERIC };
  }
  revalidatePath('/admin/orders');
  revalidatePath('/admin/customers');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  const method = input.value.paymentMethod;
  if (method === 'on_account') return { ok: true, data: { order, payment: { kind: 'none' } } };
  // Card payments go through the hosted checkout, as before.
  const provider: PaymentProviderCode = method === 'card_direct' ? 'pesapal_v3' : method;
  return { ok: true, data: { order, payment: await startPayment(order.id, provider) } };
}

/** Public: tries the payment of an order again (a declined prompt, a closed window). */
export async function retryPaymentAction(raw: unknown): Promise<CheckoutResult<CheckoutPayment>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const { orderId, providerCode } = input;
  if (typeof orderId !== 'string' || orderId === '' || orderId.length > 100) return { ok: false, error: 'That order could not be found.' };
  const code = (['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni'] as const).find((value) => value === providerCode);
  if (code === undefined) return { ok: false, error: 'Please choose how you will pay.' };
  return { ok: true, data: await startPayment(orderId, code) };
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
