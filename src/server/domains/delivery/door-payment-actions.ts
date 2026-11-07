'use server';

import { getContainer } from '@/server/di/container';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { canPermission } from '@/server/domains/access-control/guard';
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
  return await runDelivery('door_payments:manage', async (ctx) => {
    const c = getContainer();
    const [method, differences, canHandIn, canApprove, waiting] = await Promise.all([c.doorPayments.settings(ctx.companyId), c.doorHandIns.differences(ctx.companyId), canPermission('door_payments:handin'), canPermission('door_payments:approve'), c.doorHandIns.waiting(ctx.companyId)]);
    return { ...method, differences, canHandIn, canApprove, waiting };
  });
}

export async function setDoorCashMethodAction(raw: unknown) {
  return await runDelivery('door_payments:manage', async (ctx) => dataOf(await getContainer().doorPayments.setCashMethod({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), SETTINGS_PATHS);
}

/** Lets shoppers choose "Pay on delivery" at checkout, with the largest order taken that way. */
export async function setPayOnDeliveryAction(raw: unknown) {
  return await runDelivery('door_payments:manage', async (ctx) => dataOf(await getContainer().doorPayments.setPayOnDelivery({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), SETTINGS_PATHS);
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

// ── Handing the cash in ──────────────────────────────────────────────────────────────────────────────────────────────

export async function doorDifferencesAction() {
  return await runDelivery('door_payments:manage', async (ctx) => await getContainer().doorHandIns.differences(ctx.companyId));
}

/** How large a difference may be before it needs approval, and the account it is written to. */
export async function setDoorDifferencesAction(raw: unknown) {
  return await runDelivery('door_payments:manage', async (ctx) => dataOf(await getContainer().doorHandIns.setDifferences({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), SETTINGS_PATHS);
}

/** Riders who hold cash, for choosing who is handing in. */
export async function ridersWithCashAction() {
  return await runDelivery('door_payments:handin', async (ctx) => await getContainer().doorHandIns.ridersWithCash(ctx.companyId));
}

/** Hand-ins, newest first, or only the ones waiting for a second person. */
export async function handInsAction(raw?: unknown) {
  return await runDelivery('door_payments:manage', async (ctx) => await getContainer().doorHandIns.list(ctx.companyId, objectOf(raw)));
}

/** Records what a rider handed in, counted in front of a witness. */
export async function recordHandInAction(raw: unknown) {
  return await runDelivery('door_payments:handin', async (ctx) => dataOf(await getContainer().doorHandIns.record({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), SETTINGS_PATHS);
}

/** A second person accepts a hand-in whose count was out. Never the person who recorded it. */
export async function approveHandInAction(raw: unknown) {
  return await runDelivery(
    'door_payments:approve',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().doorHandIns.approve({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.handInId, 'hand-in')));
    },
    SETTINGS_PATHS,
  );
}

export async function refuseHandInAction(raw: unknown) {
  return await runDelivery(
    'door_payments:approve',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().doorHandIns.reject({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.handInId, 'hand-in'), i));
    },
    SETTINGS_PATHS,
  );
}
