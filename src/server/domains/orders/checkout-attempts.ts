import { createHmac } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import { auth } from '@/auth';
import { drizzleDb } from '@/server/db/drizzle/client';
import { checkoutAttempts } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import type { CheckoutRefusal } from '@/lib/order-stages';

/** How long refused and abandoned attempts are kept. Attempts that became orders live on in the order's timeline. */
export const CHECKOUT_ATTEMPT_RETENTION_MONTHS = 13;

export interface StartedAttempt {
  id: string;
  startedAt: Date;
}

/** A guest, as an opaque value that cannot be turned back into an address or a phone: a keyed hash of what the connection showed. */
export function guestSessionRef(address: string, userAgent: string, key = process.env.DATA_ENCRYPTION_KEY ?? process.env.AUTH_SECRET ?? 'qsell'): string {
  return createHmac('sha256', key).update(`${address}\u0000${userAgent}`).digest('hex').slice(0, 24);
}

/** A cart in the few words that reproduce why a checkout was refused: product ids and quantities, never names, contacts or addresses. */
export function cartSummaryOf(raw: unknown): Record<string, unknown> {
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  const lines = items.flatMap((item) => {
    const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
    const productId = typeof record?.productId === 'string' ? record.productId.slice(0, 100) : null;
    const quantity = Number(record?.quantity);
    return productId === null || !Number.isFinite(quantity) ? [] : [{ productId, quantity }];
  });
  return { lines, paymentMethod: typeof body.paymentMethod === 'string' ? body.paymentMethod.slice(0, 40) : null };
}

/**
 * The record of a checkout from the moment the shopper presses pay, before any order exists, so a refusal leaves its time and
 * reason behind. Recording must never stop a checkout: every call here answers null or nothing if the record cannot be written.
 */
export const CheckoutAttempts = {
  async start(input: { channel?: string; sessionRef: string | null; cart: Record<string, unknown> }): Promise<StartedAttempt | null> {
    try {
      const company = await getContainer().companySettings.ensureSeeded();
      const customerId = await shopperCustomerId();
      const [row] = await drizzleDb
        .insert(checkoutAttempts)
        .values({
          companyId: company.id,
          channel: input.channel ?? 'ecommerce',
          customerId,
          // A signed-in shopper is their customer record; only a guest is a hash.
          sessionRef: customerId === null ? input.sessionRef : null,
          cartSummary: input.cart,
        })
        .returning({ id: checkoutAttempts.id, startedAt: checkoutAttempts.startedAt });
      return row ?? null;
    } catch (error) {
      console.error('[checkout] could not record the attempt', error);
      return null;
    }
  },

  async refuse(attempt: StartedAttempt | null, why: { stage: 'input' | 'rate_limit' | 'placement'; code: CheckoutRefusal; message: string }): Promise<void> {
    if (attempt === null) return;
    try {
      await drizzleDb
        .update(checkoutAttempts)
        .set({ outcome: 'refused', refusedStage: why.stage, reasonCode: why.code, message: why.message.slice(0, 500), finishedAt: new Date() })
        .where(and(eq(checkoutAttempts.id, attempt.id), eq(checkoutAttempts.outcome, 'started')));
    } catch (error) {
      console.error('[checkout] could not record the refusal', error);
    }
  },

  async placed(attempt: StartedAttempt | null, orderId: string): Promise<void> {
    if (attempt === null) return;
    try {
      await drizzleDb
        .update(checkoutAttempts)
        .set({ outcome: 'placed', orderId, finishedAt: new Date() })
        .where(and(eq(checkoutAttempts.id, attempt.id), eq(checkoutAttempts.outcome, 'started')));
    } catch (error) {
      console.error('[checkout] could not record the order', error);
    }
  },

  /** Removes refused and abandoned attempts older than the retention period; attempts that became orders are kept. */
  async purge(now = new Date()): Promise<number> {
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - CHECKOUT_ATTEMPT_RETENTION_MONTHS);
    const gone = await drizzleDb
      .delete(checkoutAttempts)
      .where(and(lt(checkoutAttempts.startedAt, cutoff), ne(checkoutAttempts.outcome, 'placed')))
      .returning({ id: checkoutAttempts.id });
    return gone.length;
  },
};

async function shopperCustomerId(): Promise<string | null> {
  try {
    return (await auth())?.user.customerStoreId ?? null;
  } catch {
    return null;
  }
}
