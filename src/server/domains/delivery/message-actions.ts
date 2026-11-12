'use server';

import { getContainer } from '@/server/di/container';
import { objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'NOT_ALLOWED' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/messages'];

/** Whether customers are also texted about their delivery, which messages, and which SMS connection the texts would go through. */
export async function customerMessagesAction() {
  return await runDelivery('deliveries:manage', async (ctx) => {
    const [settings, textsGoThrough] = await Promise.all([getContainer().deliveryTextSettings.get(ctx.companyId), getContainer().smsAccounts.defaultName(ctx.companyId)]);
    return { settings, textsGoThrough };
  });
}

export async function setCustomerTextsAction(raw: unknown) {
  return await runDelivery('deliveries:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliveryTextSettings.set({ companyId: ctx.companyId, userId: ctx.userId }, { enabled: i.enabled, kinds: i.kinds, quietFrom: i.quietFrom, quietUntil: i.quietUntil, expectedVersion: i.expectedVersion }));
  }, PATHS);
}
