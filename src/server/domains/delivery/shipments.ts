import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliveryShipments } from '@/server/db/drizzle/schema';
import { isFailureReason } from '@/lib/delivery-document';
import { COURIER_STATE_WORDS, isCourierState, type CourierState } from '@/server/adapters/courier/port';
import type { DeliveryDocuments, DeliveryView, DocActor, DocRefusal, DocResult } from './documents';

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

export interface ShipmentView {
  courierName: string;
  trackingNumber: string | null;
  status: CourierState;
  statusWords: string;
  lastNote: string | null;
  lastUpdateAt: string;
  adapter: string;
}

/**
 * What a courier tells us about a parcel we handed over. Until a courier's own system is connected, a person types the news in; each
 * piece is turned into the delivery's own steps (delivered, or a failed attempt) in one transaction with the shipment's state, so the
 * delivery, the order's timeline and the shipment never disagree. A courier we cannot reach never blocks the sale.
 */
export class CourierShipments {
  constructor(
    private readonly db: DrizzleDb,
    private readonly documents: Pick<DeliveryDocuments, 'deliver' | 'failAttempt' | 'get' | 'recordNote'>,
  ) {}

  async forDelivery(companyId: string, deliveryId: string): Promise<ShipmentView | null> {
    const [s] = await this.db.select().from(deliveryShipments).where(and(eq(deliveryShipments.deliveryId, deliveryId), eq(deliveryShipments.companyId, companyId)));
    return s === undefined ? null : { courierName: s.courierName, trackingNumber: s.trackingNumber, status: s.status, statusWords: COURIER_STATE_WORDS[s.status], lastNote: s.lastNote, lastUpdateAt: s.lastUpdateAt.toISOString(), adapter: s.adapter };
  }

  /** The courier's news: with them, delivered (to whom), or a problem (what). */
  async news(actor: DocActor, deliveryId: string, input: { state?: unknown; note?: unknown; receivedBy?: unknown; trackingNumber?: unknown; reasonCode?: unknown }): Promise<DocResult<DeliveryView>> {
    if (!isCourierState(input.state) || input.state === 'booked') return fail('bad_input', 'Say what the courier reported: with them, delivered, or a problem.');
    const state = input.state;
    const note = text(input.note, 300);
    if (state === 'exception' && note === null) return fail('bad_input', 'Say what the courier reported went wrong.');
    const done = await this.db.transaction(async (tx): Promise<DocResult<null>> => {
      const [d] = await tx.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
      if (d === undefined) return fail('not_found', 'That delivery could not be found.');
      if (d.method !== 'courier') return fail('wrong_method', 'Only a delivery sent with a courier has news from one.');
      const [s] = await tx.select().from(deliveryShipments).where(eq(deliveryShipments.deliveryId, deliveryId)).for('update');
      if (s === undefined || d.status !== 'out_for_delivery') return fail('not_allowed', 'This parcel is not with a courier now.');
      const tracking = text(input.trackingNumber, 120) ?? s.trackingNumber;
      if (state === 'delivered') {
        const r = await this.documents.deliver(actor, deliveryId, { receivedBy: text(input.receivedBy, 120) ?? 'As told by the courier', note }, undefined, tx);
        if (!r.ok) return r;
      } else if (state === 'exception') {
        const r = await this.documents.failAttempt(actor, deliveryId, { reasonCode: isFailureReason(input.reasonCode) ? input.reasonCode : 'other', note }, undefined, tx);
        if (!r.ok) return r;
      } else {
        await this.documents.recordNote(tx, actor, deliveryId, 'courier_update', note, { state, trackingNumber: tracking });
      }
      await tx.update(deliveryShipments).set({ status: state, trackingNumber: tracking, lastNote: note, lastUpdateAt: new Date() }).where(eq(deliveryShipments.id, s.id));
      if (tracking !== d.trackingNumber) await tx.update(deliveries).set({ trackingNumber: tracking }).where(eq(deliveries.id, deliveryId));
      return { ok: true, data: null };
    });
    if (!done.ok) return done;
    const view = await this.documents.get(actor.companyId, deliveryId);
    return view === null ? fail('not_found', 'That delivery could not be found.') : { ok: true, data: view };
  }
}
