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

const PATHS = ['/admin/delivery/vehicles', '/admin/delivery/dispatch'];

/** The fleet's vehicles with the runs in each, for the Vehicles screen. */
export async function vehiclesScreenAction() {
  return await runDelivery('riders:manage', async (ctx) => await getContainer().deliveryVehicles.list(ctx.companyId));
}

export async function createVehicleAction(raw: unknown) {
  return await runDelivery('riders:manage', async (ctx) => dataOf(await getContainer().deliveryVehicles.create({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

export async function updateVehicleAction(raw: unknown) {
  return await runDelivery('riders:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliveryVehicles.update({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id, 'vehicle'), i));
  }, PATHS);
}

export async function setVehicleActiveAction(raw: unknown) {
  return await runDelivery('riders:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliveryVehicles.setActive({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id, 'vehicle'), { isActive: i.isActive, expectedVersion: i.expectedVersion }));
  }, PATHS);
}
