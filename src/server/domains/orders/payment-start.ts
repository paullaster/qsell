import { headers } from 'next/headers';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { startOrderPayment } from '@/server/domains/payments/start-payment';
import type { PaymentProviderCode } from '@/server/domains/payments/types';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { orElse } from '@/lib/values';
import { OrderStages } from './stages';

/** What happens next for the person paying. */
export type CheckoutPayment =
  /** Nothing to pay now (the order is on the customer's account). */
  | { kind: 'none' }
  /** A prompt was sent to their phone. */
  | { kind: 'stk'; attemptId: string; message: string }
  /** They finish paying with the provider; the shop waits for it to answer. */
  | { kind: 'hosted'; attemptId: string; redirectUrl: string | null; message: string }
  | { kind: 'failed'; message: string };


export const PHONE_PROVIDERS: readonly PaymentProviderCode[] = ['mpesa_daraja', 'kcb_buni'];

/** A prompt to a phone is limited per address and per number, so nobody's phone can be flooded with requests. Returns the words to show, or null. */
export async function promptLimited(phone: string): Promise<string | null> {
  const h = await headers();
  for (const [rule, subject] of [['payment_prompt_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for'))], ['payment_prompt_phone', phone]] as const) {
    const verdict = await getContainer().rateLimits.hit(rule, subject);
    if (!verdict.allowed) return waitMessage(verdict.retryAfterSeconds);
  }
  return null;
}

export async function startPayment(orderId: string, providerCode: PaymentProviderCode, payerPhone: string | null): Promise<CheckoutPayment> {
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

