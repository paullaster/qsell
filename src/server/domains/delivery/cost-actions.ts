'use server';

import { getContainer } from '@/server/di/container';
import { idOf, objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'BAD_INPUT' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/costs', '/admin/delivery/deliveries'];

/** What riders are paid. */
export async function payRulesAction() {
  return await runDelivery('delivery_costs:manage', async (ctx) => await getContainer().deliveryCosts.pay(ctx.companyId));
}

export async function setPayRulesAction(raw: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => dataOf(await getContainer().deliveryCosts.setPay({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

/** Costs, newest first. */
export async function costsPageAction(raw?: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => await getContainer().deliveryCosts.list(ctx.companyId, objectOf(raw)));
}

/** The costs of one delivery, for its screen. Read with the delivery permission so the people who see the delivery see what it cost. */
export async function deliveryCostsAction(deliveryId: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => await getContainer().deliveryCosts.forDelivery(ctx.companyId, idOf(deliveryId, 'delivery')));
}

/** What a courier charged for a delivery. */
export async function recordCourierChargeAction(raw: unknown) {
  return await runDelivery(
    'delivery_costs:manage',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().deliveryCosts.recordCourier({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.deliveryId, 'delivery'), i));
    },
    PATHS,
  );
}

/** Takes a cost back, with a reason. */
export async function reverseCostAction(raw: unknown) {
  return await runDelivery(
    'delivery_costs:manage',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().deliveryCosts.reverse({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.costId, 'cost'), i));
    },
    PATHS,
  );
}
