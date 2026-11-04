'use server';

import { getContainer } from '@/server/di/container';
import { objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'BAD_INPUT' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/riders'];

function idOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) throw new DeliveryError('That rider could not be found.', 'NOT_FOUND');
  return value;
}

/** Which kinds of rider the company uses, and how many of each are working. */
export async function riderSettingsAction() {
  return await runDelivery('riders:manage', async (ctx) => await getContainer().deliveryRiders.settings(ctx.companyId));
}

export async function setRiderKindsAction(raw: unknown) {
  return await runDelivery('riders:manage', async (ctx) => dataOf(await getContainer().deliveryRiders.setKinds({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

/** What a rider must show at the door: nothing, the customer's code, a photo, or either. */
export async function setRiderProofAction(raw: unknown) {
  return await runDelivery('riders:manage', async (ctx) => dataOf(await getContainer().deliveryRiders.setProof({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

export async function ridersPageAction(raw?: unknown) {
  return await runDelivery('riders:manage', async (ctx) => await getContainer().deliveryRiders.list(ctx.companyId, objectOf(raw)));
}

/** A member of staff starts riding with the account they have. */
export async function addStaffRiderAction(raw: unknown) {
  return await runDelivery('riders:manage', async (ctx) => dataOf(await getContainer().deliveryRiders.addStaff({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

/** An account made for riding, with a first password the rider changes at first sign-in. */
export async function createOwnRiderAction(raw: unknown) {
  return await runDelivery('riders:manage', async (ctx) => dataOf(await getContainer().deliveryRiders.createSeparate({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

export async function updateRiderAction(raw: unknown) {
  return await runDelivery(
    'riders:manage',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().deliveryRiders.update({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.riderId), i));
    },
    PATHS,
  );
}

/** Pause, resume or end a rider. */
export async function changeRiderAction(raw: unknown) {
  return await runDelivery(
    'riders:manage',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().deliveryRiders.change({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.riderId), i));
    },
    PATHS,
  );
}

export async function resetRiderPasswordAction(raw: unknown) {
  return await runDelivery(
    'riders:manage',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().deliveryRiders.resetPassword({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.riderId), i.password));
    },
    PATHS,
  );
}
