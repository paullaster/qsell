'use server';

import { getContainer } from '@/server/di/container';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { idOf, objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'BAD_INPUT' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const SETTINGS_PATHS = ['/admin/delivery/door-payments'];
const DELIVERY_PATHS = ['/admin/delivery/deliveries', '/admin/orders'];

/** How cash taken at the door is received. */
export async function doorSettingsAction() {
  return await runDelivery('door_payments:manage', async (ctx) => await getContainer().doorPayments.settings(ctx.companyId));
}

export async function setDoorCashMethodAction(raw: unknown) {
  return await runDelivery('door_payments:manage', async (ctx) => dataOf(await getContainer().doorPayments.setCashMethod({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), SETTINGS_PATHS);
}

/** What each rider holds now. */
export async function doorBalancesAction() {
  return await runDelivery('door_payments:manage', async (ctx) => await getContainer().doorPayments.balances(ctx.companyId, businessDate()));
}

/** The custody ledger, newest first. */
export async function doorEntriesAction(raw?: unknown) {
  return await runDelivery('door_payments:manage', async (ctx) => await getContainer().doorPayments.entries(ctx.companyId, objectOf(raw)));
}

/** Cash that was collected but whose order was not yet stocked or booked is finished now. */
export async function finishDoorPostingAction() {
  return await runDelivery('door_payments:manage', async (ctx) => await getContainer().doorPayments.finishPosting(ctx.companyId), SETTINGS_PATHS);
}

/** Lets a delivery go out to be paid in cash at the door. */
export async function markDoorPaymentAction(raw: unknown) {
  return await runDelivery(
    'door_payments:allow',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().doorPayments.mark({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.deliveryId, 'delivery'), i));
    },
    DELIVERY_PATHS,
  );
}

/** Takes that back before the delivery goes out. */
export async function unmarkDoorPaymentAction(raw: unknown) {
  return await runDelivery(
    'door_payments:allow',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().doorPayments.unmark({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.deliveryId, 'delivery'), i));
    },
    DELIVERY_PATHS,
  );
}
