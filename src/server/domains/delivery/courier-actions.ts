'use server';

import { getContainer } from '@/server/di/container';
import { idOf, objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'NOT_ALLOWED' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/couriers', '/admin/delivery/deliveries', '/admin/delivery/dispatch'];

/** The couriers the company has connected, for their screen. Nothing secret is in what comes back. */
export async function couriersScreenAction() {
  return await runDelivery('couriers:manage', async (ctx) => await getContainer().courierAccounts.list(ctx.companyId));
}

/** Connects a courier. The secret its news is signed with comes back once, here, and is never shown again. */
export async function createCourierAction(raw: unknown) {
  return await runDelivery('couriers:manage', async (ctx) => dataOf(await getContainer().courierAccounts.create({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

export async function updateCourierAction(raw: unknown) {
  return await runDelivery('couriers:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().courierAccounts.update({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id, 'courier'), i));
  }, PATHS);
}

export async function setCourierActiveAction(raw: unknown) {
  return await runDelivery('couriers:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().courierAccounts.setActive({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id, 'courier'), i.isActive === true, typeof i.expectedVersion === 'number' ? i.expectedVersion : undefined));
  }, PATHS);
}

/** Books a parcel marked as a test with the courier's own system, then cancels it, and says what happened. */
export async function testCourierParcelAction(raw: unknown) {
  return await runDelivery('couriers:manage', async (ctx) => dataOf(await getContainer().courierAccounts.testParcel({ companyId: ctx.companyId, userId: ctx.userId }, idOf(objectOf(raw).id, 'courier'))), PATHS);
}

export async function renewCourierSecretAction(raw: unknown) {
  return await runDelivery('couriers:manage', async (ctx) => dataOf(await getContainer().courierAccounts.newWebhookSecret({ companyId: ctx.companyId, userId: ctx.userId }, idOf(objectOf(raw).id, 'courier'))), PATHS);
}

/** Tries a failed booking or cancellation with the courier again, now. */
export async function retryCourierAction(raw: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => dataOf(await getContainer().courierSync.retry({ companyId: ctx.companyId, userId: ctx.userId }, idOf(objectOf(raw).deliveryId, 'delivery'))), PATHS);
}

/** Asks the courier about a parcel now. */
export async function refreshCourierAction(raw: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => {
    const done = dataOf(await getContainer().courierSync.refresh({ companyId: ctx.companyId, userId: ctx.userId }, idOf(objectOf(raw).deliveryId, 'delivery')));
    void getContainer().deliveryMessages.flush(5).catch((e: unknown) => console.error('[delivery.messages] flush', e));
    return done;
  }, PATHS);
}
