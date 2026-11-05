'use server';

import { getContainer } from '@/server/di/container';
import { canPermission } from '@/server/domains/access-control/guard';
import { objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import { ISSUE_MOMENTS, ISSUE_MOMENT_WORDS, type IssueMoment } from '@/lib/stock-issue';
import { StockError } from '@/server/domains/stock/errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = {
  not_found: 'NOT_FOUND',
  bad_input: 'BAD_INPUT',
  not_allowed: 'NOT_ALLOWED',
  conflict: 'CONFLICT',
  order_not_ready: 'NOT_ALLOWED',
  nothing_left: 'BAD_INPUT',
  wrong_method: 'BAD_INPUT',
};

/** A refusal shown in its words; a success gives its data. */
function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/deliveries', '/admin/orders'];

/** The id of a delivery or order from the browser: only its size is checked here, and every lookup is for this company alone. */
function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) throw new DeliveryError(`That ${what} could not be found.`, 'NOT_FOUND');
  return value;
}

const versionOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined);

export async function deliveriesPageAction(raw: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => await getContainer().deliveryDocuments.list(ctx.companyId, objectOf(raw)));
}

export async function deliveryAction(id: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const found = await getContainer().deliveryDocuments.get(ctx.companyId, idOf(id, 'delivery'));
    if (found === null) throw new DeliveryError('That delivery could not be found.', 'NOT_FOUND');
    return found;
  });
}

/** A short-lived link to the photo a rider took at the door. Opened on demand, never stored in the page. */
export async function proofPhotoLinkAction(proofId: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const { deliveryDocuments, media } = getContainer();
    const mediaId = await deliveryDocuments.proofPhoto(ctx.companyId, idOf(proofId, 'photo'));
    const url = mediaId === null ? null : await media.deliveryUrlById(mediaId);
    if (url === null) throw new DeliveryError('That photo could not be found.', 'NOT_FOUND');
    return { url };
  });
}

/** An order's deliveries and what it has left to deliver, for the order screen. */
export async function orderDeliveriesAction(orderId: unknown) {
  return await runDelivery('deliveries:read', async (ctx) => {
    const found = await getContainer().deliveryDocuments.forOrder(ctx.companyId, idOf(orderId, 'order'));
    if (found === null) throw new DeliveryError('That order could not be found.', 'NOT_FOUND');
    // Whether to show the forms: the person who may only look is not offered buttons that would be refused.
    return { ...found, canFulfil: await canPermission('deliveries:fulfil') };
  });
}

export async function createDeliveryAction(raw: unknown) {
  return await runDelivery(
    'deliveries:fulfil',
    async (ctx) => {
      const i = objectOf(raw);
      const lines = Array.isArray(i.lines)
        ? i.lines.map((l) => {
            const r = objectOf(l);
            return { productId: typeof r.productId === 'string' ? r.productId : '', quantity: typeof r.quantity === 'number' ? r.quantity : Number.NaN };
          })
        : null;
      return dataOf(await getContainer().deliveryDocuments.create({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.orderId, 'order'), { lines, notes: i.notes }));
    },
    PATHS,
  );
}

/**
 * One step of a delivery. The step is named, and only the steps the delivery's state allows are done; the rules, the lock and the
 * version check are the service's. The person must be allowed to fulfil deliveries.
 */
export async function deliveryStepAction(raw: unknown) {
  return await runDelivery(
    'deliveries:fulfil',
    async (ctx) => {
      const i = objectOf(raw);
      const actor = { companyId: ctx.companyId, userId: ctx.userId };
      const id = idOf(i.deliveryId, 'delivery');
      const version = versionOf(i.expectedVersion);
      const docs = getContainer().deliveryDocuments;
      // After the step is committed, whatever it queued for the customer is sent (and never holds the step up).
      const sendSoon = () => void getContainer().deliveryMessages.flush(5).catch((e: unknown) => console.error('[delivery.messages] flush', e));
      const sent = <T,>(value: T): T => {
        sendSoon();
        return value;
      };
      switch (i.step) {
        case 'release':
          return dataOf(await docs.release(actor, id, version));
        case 'start_picking':
          return dataOf(await docs.startPicking(actor, id, version));
        case 'record_picked':
          return dataOf(await docs.recordPicked(actor, id, { picked: i.picked, note: i.note }, version));
        case 'mark_packed':
          return dataOf(await docs.markPacked(actor, id, version));
        case 'mark_ready':
          return dataOf(await docs.markReady(actor, id, version));
        case 'dispatch':
          return sent(dataOf(await docs.dispatch(actor, id, { courierName: i.courierName, trackingNumber: i.trackingNumber }, version)));
        case 'deliver':
          return sent(dataOf(await docs.deliver(actor, id, { receivedBy: i.receivedBy, note: i.note }, version)));
        case 'fail_attempt':
          return sent(dataOf(await docs.failAttempt(actor, id, { reasonCode: i.reasonCode, note: i.note }, version)));
        case 'reattempt':
          return dataOf(await docs.reattempt(actor, id, { note: i.note, day: i.day }, version));
        case 'return':
          return sent(dataOf(await docs.returnToStock(actor, id, { reason: i.reason }, version)));
        case 'cancel':
          return dataOf(await docs.cancel(actor, id, { reason: i.reason }, version));
        case 'correct_return':
          return dataOf(await docs.correctReturn(actor, id, { productId: i.productId, quantity: i.quantity, disposition: i.disposition, reason: i.reason }));
        case 'receive_return':
          return dataOf(await docs.receiveReturn(actor, id, { lines: i.lines, note: i.note }));
        case 'amend':
          return dataOf(await docs.amend(actor, id, { recipientName: i.recipientName, recipientPhone: i.recipientPhone, notes: i.notes }, version));
        default:
          throw new DeliveryError('That step is not one this delivery has.', 'BAD_INPUT');
      }
    },
    PATHS,
  );
}

export interface StockTimingView {
  moment: IssueMoment;
  /** Whether stock is kept by location, which the later moments need. */
  byLocation: boolean;
  options: { id: IssueMoment; name: string; means: string }[];
  canChange: boolean;
}

/** When the stock of a delivered order leaves the shelf, and whether this person can change it. */
export async function stockTimingAction() {
  return await runDelivery('deliveries:read', async (): Promise<StockTimingView> => {
    const c = getContainer();
    const mode = await c.stockSettings.get();
    return { moment: mode.issueMoment, byLocation: mode.ledgerMode, options: ISSUE_MOMENTS.map((id) => ({ id, ...ISSUE_MOMENT_WORDS[id] })), canChange: await canPermission('stock:cutover') };
  });
}

/** Chooses when the stock of a delivered order leaves the shelf. It applies to orders paid from now on, and is kept in the decision log. */
export async function setStockTimingAction(raw: unknown) {
  return await runDelivery(
    'stock:cutover',
    async (ctx): Promise<StockTimingView> => {
      const c = getContainer();
      const before = (await c.stockSettings.get()).issueMoment;
      let moment: IssueMoment;
      try {
        moment = await c.stockSettings.setIssueMoment(ctx.companyId, objectOf(raw).moment);
      } catch (error) {
        if (error instanceof StockError) throw new DeliveryError(error.message, 'BAD_INPUT');
        throw error;
      }
      if (moment !== before) await c.decisionLog.record({ companyId: ctx.companyId, subject: { type: 'stock_settings', id: ctx.companyId }, action: 'stock.issue_moment', actor: { type: 'user', id: ctx.userId }, from: before, to: moment, reason: { text: `Stock now leaves the shelf: ${ISSUE_MOMENT_WORDS[moment].name.toLowerCase()}.` } });
      return { moment, byLocation: true, options: ISSUE_MOMENTS.map((id) => ({ id, ...ISSUE_MOMENT_WORDS[id] })), canChange: true };
    },
    ['/admin/delivery/stock'],
  );
}

/** How many orders were paid before the stock timing was chosen, with goods that have not left yet. */
export async function stockReissuePreviewAction() {
  return await runDelivery('stock:cutover', async (ctx) => {
    const c = getContainer();
    return await c.stockReissue.preview(ctx.companyId, (await c.stockSettings.get()).issueMoment);
  });
}

/** Counts the stock of those orders back and holds it for their deliveries, a batch at a time. */
export async function stockReissueApplyAction(raw?: unknown) {
  return await runDelivery(
    'stock:cutover',
    async (ctx) => {
      const c = getContainer();
      const skip = Array.isArray(objectOf(raw).skip) ? (objectOf(raw).skip as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 1000) : [];
      return await c.stockReissue.apply({ companyId: ctx.companyId, userId: ctx.userId }, (await c.stockSettings.get()).issueMoment, skip);
    },
    ['/admin/delivery/stock'],
  );
}
