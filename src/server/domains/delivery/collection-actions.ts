'use server';

import { headers } from 'next/headers';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { showCollectionCode } from '@/lib/collection-code';
import { getContainer } from '@/server/di/container';
import { objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { CollectionOutcome, CollectionRefusal, CollectionView } from './collection';

const CODE_FOR: Record<CollectionRefusal, DeliveryErrorCode> = {
  not_found: 'NOT_FOUND',
  bad_input: 'BAD_INPUT',
  not_paid: 'NOT_ALLOWED',
  on_hold: 'NOT_ALLOWED',
  order_closed: 'NOT_ALLOWED',
  wrong_code: 'NOT_ALLOWED',
  locked: 'NOT_ALLOWED',
  already_collected: 'CONFLICT',
  not_collectable: 'NOT_ALLOWED',
};

/** A refusal shown in its words, with the order's own page re-read. */
function viewOf(outcome: CollectionOutcome): CollectionView {
  if (outcome.ok) return outcome.view;
  throw new DeliveryError(outcome.message, CODE_FOR[outcome.reason]);
}

const PATHS = ['/admin/orders'];

/** Staff: how an order's collection stands (never the code). Null when the order is not one for collection. */
export async function collectionOfOrderAction(orderId: unknown) {
  return await runDelivery('deliveries:handover', async (ctx) => await getContainer().orderCollections.view(ctx.companyId, idOfOrder(orderId)));
}

/** The order ids here are text ids, not UUIDs: only their size is checked, and the lookup is for this company alone. */
function idOfOrder(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) throw new DeliveryError('That order could not be found.', 'NOT_FOUND');
  return value;
}

export async function markReadyForCollectionAction(orderId: unknown) {
  return await runDelivery(
    'deliveries:handover',
    async (ctx) => viewOf(await getContainer().orderCollections.markReady({ companyId: ctx.companyId, userId: ctx.userId }, idOfOrder(orderId))),
    PATHS,
  );
}

/** The customer shows their code; the person at the counter types it. */
export async function collectOrderWithCodeAction(raw: unknown) {
  return await runDelivery(
    'deliveries:handover',
    async (ctx) => {
      const i = objectOf(raw);
      return viewOf(await getContainer().orderCollections.collectWithCode({ companyId: ctx.companyId, userId: ctx.userId }, idOfOrder(i.orderId), i.code));
    },
    PATHS,
  );
}

/** The customer has no code: the hand-over is on what ID was seen, which needs its own permission and is kept with the reason. */
export async function collectOrderAfterIdCheckAction(raw: unknown) {
  return await runDelivery(
    'deliveries:handover_override',
    async (ctx) => {
      const i = objectOf(raw);
      return viewOf(await getContainer().orderCollections.collectWithIdCheck({ companyId: ctx.companyId, userId: ctx.userId }, idOfOrder(i.orderId), { idSeen: i.idSeen, reason: i.reason }));
    },
    PATHS,
  );
}

/** A new code for an order whose customer lost it or whose code is locked; the old one stops working. The new code is shown once. */
export async function reissueCollectionCodeAction(raw: unknown) {
  return await runDelivery(
    'deliveries:handover_override',
    async (ctx) => {
      const i = objectOf(raw);
      const done = await getContainer().orderCollections.reissue({ companyId: ctx.companyId, userId: ctx.userId }, idOfOrder(i.orderId), i.reason);
      if (!done.ok) throw new DeliveryError(done.message, CODE_FOR[done.reason]);
      return { code: showCollectionCode(done.code), view: done.view };
    },
    PATHS,
  );
}

export interface CustomerCollection {
  view: CollectionView;
  /** What the customer shows at the counter, while there is still something to collect. */
  code: string | null;
}

/**
 * Public: the customer's own collection and its code, for someone who knows the order number and the phone or email it was placed
 * with (the same proof as tracking an order), and with a limit on tries by address and by order so the numbers cannot be guessed.
 */
export async function trackedCollectionAction(raw: unknown): Promise<{ ok: true; data: CustomerCollection | null } | { ok: false; error: string }> {
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
    const order = await c.orders.findByNumberAndContact(orderNumber, contact);
    if (order === null) return { ok: false, error: 'That order could not be found.' };
    const company = await c.companySettings.ensureSeeded();
    const view = await c.orderCollections.view(company.id, order.id);
    if (view === null) return { ok: true, data: null };
    const code = await c.orderCollections.codeFor(company.id, order.id);
    return { ok: true, data: { view, code: code === null ? null : showCollectionCode(code) } };
  } catch (error: unknown) {
    console.error('[delivery] tracked collection', error);
    return { ok: false, error: 'The order could not be checked just now.' };
  }
}

