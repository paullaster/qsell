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

const PATHS = ['/admin/delivery/slots', '/admin/delivery/deliveries'];

/** The slots and the days that are closed, for the settings screen. */
export async function slotsScreenAction() {
  return await runDelivery('delivery_slots:manage', async (ctx) => {
    const s = getContainer().deliverySlots;
    const [slots, closed, leads, sla] = await Promise.all([s.list(ctx.companyId), s.closedDays(ctx.companyId), s.leadTimes(ctx.companyId), getContainer().deliverySla.settings(ctx.companyId)]);
    return { slots, closed, leads, sla };
  });
}

export async function createSlotAction(raw: unknown) {
  return await runDelivery('delivery_slots:manage', async (ctx) => dataOf(await getContainer().deliverySlots.create({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

export async function updateSlotAction(raw: unknown) {
  return await runDelivery('delivery_slots:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliverySlots.update({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id, 'slot'), i));
  }, PATHS);
}

export async function setSlotActiveAction(raw: unknown) {
  return await runDelivery('delivery_slots:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliverySlots.setActive({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id, 'slot'), { isActive: i.isActive, expectedVersion: i.expectedVersion }));
  }, PATHS);
}

export async function setLeadTimeAction(raw: unknown) {
  return await runDelivery('delivery_slots:manage', async (ctx) => dataOf(await getContainer().deliverySlots.setLead({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw) as { kind: unknown; refId: unknown; minutes: unknown; note?: unknown })), PATHS);
}

export async function removeLeadTimeAction(raw: unknown) {
  return await runDelivery('delivery_slots:manage', async (ctx) => dataOf(await getContainer().deliverySlots.removeLead({ companyId: ctx.companyId, userId: ctx.userId }, idOf(objectOf(raw).id, 'lead time'))), PATHS);
}

export async function closeDayAction(raw: unknown) {
  return await runDelivery('delivery_slots:manage', async (ctx) => dataOf(await getContainer().deliverySlots.close({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw) as { day: unknown; branchId?: unknown; reason: unknown })), PATHS);
}

export async function reopenDayAction(raw: unknown) {
  return await runDelivery('delivery_slots:manage', async (ctx) => dataOf(await getContainer().deliverySlots.reopen({ companyId: ctx.companyId, userId: ctx.userId }, idOf(objectOf(raw).id, 'day'))), PATHS);
}

/** For a delivery's screen: the slot it holds, and what its branch offers over the days asked for. */
export async function deliverySlotAction(raw: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => {
    const i = objectOf(raw);
    const deliveryId = idOf(i.deliveryId, 'delivery');
    const c = getContainer();
    const delivery = await c.deliveryDocuments.get(ctx.companyId, deliveryId);
    if (delivery === null) throw new DeliveryError('That delivery could not be found.', 'NOT_FOUND');
    const [held, offer] = await Promise.all([c.deliverySlots.heldBy(ctx.companyId, deliveryId), c.deliverySlots.offer(ctx.companyId, { branchId: delivery.branch.id, from: i.from, days: 7, deliveryId })]);
    return { held, offer };
  });
}

export async function bookSlotAction(raw: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliverySlots.book({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.deliveryId, 'delivery'), { slotId: i.slotId, day: i.day }));
  }, PATHS);
}

export async function releaseSlotAction(raw: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliverySlots.release({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.deliveryId, 'delivery'), { reason: i.reason }));
  }, PATHS);
}

/** Deliveries at risk or late against their promised window, and the thresholds. */
export async function lateDeliveriesAction() {
  return await runDelivery('deliveries:dispatch', async (ctx) => {
    const sla = getContainer().deliverySla;
    const [late, settings] = await Promise.all([sla.overview(ctx.companyId), sla.settings(ctx.companyId)]);
    return { late, settings };
  });
}

export async function acknowledgeLateAction(raw: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliverySla.acknowledge({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.deliveryId, 'delivery'), { note: i.note }));
  }, ['/admin/delivery/late']);
}

export async function slaSettingsAction() {
  return await runDelivery('delivery_slots:manage', async (ctx) => await getContainer().deliverySla.settings(ctx.companyId));
}

export async function setSlaSettingsAction(raw: unknown) {
  return await runDelivery('delivery_slots:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().deliverySla.setSettings({ companyId: ctx.companyId, userId: ctx.userId }, { atRiskMinutes: i.atRiskMinutes, escalateAfterMinutes: i.escalateAfterMinutes, expectedVersion: i.expectedVersion }));
  }, PATHS);
}
