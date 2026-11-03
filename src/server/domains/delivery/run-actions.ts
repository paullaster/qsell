'use server';

import { getContainer } from '@/server/di/container';
import { canPermission } from '@/server/domains/access-control/guard';
import { objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'BAD_INPUT' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/dispatch', '/admin/delivery/deliveries'];

function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) throw new DeliveryError(`That ${what} could not be found.`, 'NOT_FOUND');
  return value;
}

const versionOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined);

/** The dispatch board: what is ready, the runs still to do, and the parcels out with couriers. */
export async function dispatchBoardAction(raw?: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => await getContainer().deliveryRuns.board(ctx.companyId, objectOf(raw), new Date()));
}

export async function runsPageAction(raw?: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => await getContainer().deliveryRuns.list(ctx.companyId, objectOf(raw)));
}

export async function runAction(id: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => {
    const found = await getContainer().deliveryRuns.get(ctx.companyId, idOf(id, 'run'));
    if (found === null) throw new DeliveryError('That run could not be found.', 'NOT_FOUND');
    return found;
  });
}

export async function createRunAction(raw: unknown) {
  return await runDelivery('deliveries:dispatch', async (ctx) => dataOf(await getContainer().deliveryRuns.create({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

/** One step of a run: put a delivery on it, take one off, order the stops, start it, close it, or cancel it. */
export async function runStepAction(raw: unknown) {
  return await runDelivery(
    'deliveries:dispatch',
    async (ctx) => {
      const i = objectOf(raw);
      const actor = { companyId: ctx.companyId, userId: ctx.userId };
      const id = idOf(i.runId, 'run');
      const version = versionOf(i.expectedVersion);
      const runs = getContainer().deliveryRuns;
      const sent = <T,>(value: T): T => {
        void getContainer().deliveryMessages.flush(20).catch((e: unknown) => console.error('[delivery.messages] flush', e));
        return value;
      };
      switch (i.step) {
        case 'add_stop':
          return dataOf(await runs.addStop(actor, id, idOf(i.deliveryId, 'delivery'), version));
        case 'remove_stop':
          return dataOf(await runs.removeStop(actor, id, idOf(i.deliveryId, 'delivery'), version));
        case 'reorder':
          return dataOf(await runs.reorder(actor, id, i.order, version));
        case 'arrange':
          return dataOf(await runs.arrange(actor, id, version));
        case 'start':
          return sent(dataOf(await runs.start(actor, id, version)));
        case 'complete':
          return dataOf(await runs.complete(actor, id, version));
        case 'cancel':
          return dataOf(await runs.cancel(actor, id, { reason: i.reason }, version));
        default:
          throw new DeliveryError('That step is not one a run has.', 'BAD_INPUT');
      }
    },
    PATHS,
  );
}

/** What a courier reported about a parcel: with them, delivered, or a problem. Typed in until a courier's own system is connected. */
export async function courierNewsAction(raw: unknown) {
  return await runDelivery(
    'deliveries:dispatch',
    async (ctx) => {
      const i = objectOf(raw);
      const done = dataOf(await getContainer().courierShipments.news({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.deliveryId, 'delivery'), { state: i.state, note: i.note, receivedBy: i.receivedBy, trackingNumber: i.trackingNumber, reasonCode: i.reasonCode }));
      void getContainer().deliveryMessages.flush(5).catch((e: unknown) => console.error('[delivery.messages] flush', e));
      return done;
    },
    [...PATHS, '/admin/orders'],
  );
}

/** The courier shipment and the run of a delivery, for its own screen. */
export async function deliveryExtrasAction(deliveryId: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const id = idOf(deliveryId, 'delivery');
    const c = getContainer();
    const [shipment, run, canDispatch, messages] = await Promise.all([c.courierShipments.forDelivery(ctx.companyId, id), c.deliveryRuns.runOf(ctx.companyId, id), canPermission('deliveries:dispatch'), c.deliveryMessages.forDelivery(ctx.companyId, id)]);
    return { shipment, run, canDispatch, messages };
  });
}
