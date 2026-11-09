import { headers } from 'next/headers';
import { getContainer } from '@/server/di/container';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import type { Order } from '@/types/index';

export type OrderProof = { ok: true; order: Order | null } | { ok: false; error: string };

/**
 * Finds an order for someone who knows its number and the phone or email it was placed with. Limited per address and per order
 * number first, so the pair cannot be guessed. A wrong pair and a missing order answer the same (`order: null`).
 */
export async function proveOrder(orderNumber: string, contact: string): Promise<OrderProof> {
  const h = await headers();
  const rateLimits = getContainer().rateLimits;
  for (const [rule, subject] of [['order_lookup_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for'))], ['order_lookup_order', orderNumber.trim().toUpperCase()]] as const) {
    const verdict = await rateLimits.hit(rule, subject);
    if (!verdict.allowed) return { ok: false, error: waitMessage(verdict.retryAfterSeconds) };
  }
  return { ok: true, order: await getContainer().orders.findByNumberAndContact(orderNumber, contact) };
}
