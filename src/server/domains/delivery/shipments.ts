import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { courierEvents, deliveries, deliveryShipments } from '@/server/db/drizzle/schema';
import { isFailureReason } from '@/lib/delivery-document';
import { COURIER_STATE_WORDS, isCourierState, type CourierNews, type CourierState } from '@/server/adapters/courier/port';
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
  /** Whether the courier's own system is connected for this parcel (so it is booked and followed without anyone typing). */
  connected: boolean;
  trackingUrl: string | null;
  labelUrl: string | null;
  podUrl: string | null;
  podName: string | null;
  /** What the background worker is doing for this parcel, in words, and what went wrong if it did. */
  syncWords: string | null;
  syncError: string | null;
  canRetry: boolean;
}

const SYNC_WORDS: Record<string, string> = { book_pending: 'Being booked with the courier', book_failed: 'The courier could not be booked', cancel_pending: 'Being cancelled with the courier', cancel_failed: 'The courier could not be told it is cancelled', cancelled: 'Cancelled with the courier' };

class Refused extends Error {
  constructor(readonly refusal: { ok: false; reason: DocRefusal; message: string }) {
    super(refusal.message);
  }
}

/** One piece of news in the form the delivery's steps take. */
export interface NewsInput {
  state: CourierState;
  note: string | null;
  receivedBy?: string | null;
  trackingNumber?: string | null;
  reasonCode?: unknown;
  proofUrl?: string | null;
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
    return s === undefined ? null : { courierName: s.courierName, trackingNumber: s.trackingNumber, status: s.status, statusWords: COURIER_STATE_WORDS[s.status], lastNote: s.lastNote, lastUpdateAt: s.lastUpdateAt.toISOString(), adapter: s.adapter, connected: s.accountId !== null && s.adapter !== 'manual', trackingUrl: s.trackingUrl, labelUrl: s.labelUrl, podUrl: s.podUrl, podName: s.podName, syncWords: SYNC_WORDS[s.syncState] ?? null, syncError: s.syncError, canRetry: s.accountId !== null && (s.syncState === 'book_failed' || s.syncState === 'cancel_failed') };
  }

  /** The courier's news, typed in: with them, delivered (to whom), or a problem (what). */
  async news(actor: DocActor, deliveryId: string, input: { state?: unknown; note?: unknown; receivedBy?: unknown; trackingNumber?: unknown; reasonCode?: unknown }): Promise<DocResult<DeliveryView>> {
    if (!isCourierState(input.state) || input.state === 'booked') return fail('bad_input', 'Say what the courier reported: with them, delivered, or a problem.');
    const state = input.state;
    const note = text(input.note, 300);
    if (state === 'exception' && note === null) return fail('bad_input', 'Say what the courier reported went wrong.');
    const done = await this.db.transaction(async (tx): Promise<DocResult<null>> => await this.applyIn(tx, actor, deliveryId, { state, note, receivedBy: text(input.receivedBy, 120), trackingNumber: text(input.trackingNumber, 120), reasonCode: input.reasonCode }));
    if (!done.ok) return done;
    const view = await this.documents.get(actor.companyId, deliveryId);
    return view === null ? fail('not_found', 'That delivery could not be found.') : { ok: true, data: view };
  }

  /**
   * News the courier's own system gave us, asked for or pushed. It is kept as it came (the same piece twice is kept and applied once), and then
   * becomes the delivery's own step in a savepoint, so a piece of news the delivery cannot take (it is already delivered, say) changes nothing
   * but is still on record. Returns whether it changed anything.
   */
  async receive(actor: DocActor, shipmentId: string, news: CourierNews, source: 'webhook' | 'poll', eventId: string): Promise<{ applied: boolean; reason: string | null }> {
    return await this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(deliveryShipments).where(and(eq(deliveryShipments.id, shipmentId), eq(deliveryShipments.companyId, actor.companyId))).for('update');
      if (s === undefined) return { applied: false, reason: 'No such parcel.' };
      const kept = await tx.insert(courierEvents).values({ companyId: actor.companyId, shipmentId, source, dedupKey: eventId.slice(0, 120), state: news.state, note: news.note, courierAt: news.at }).onConflictDoNothing().returning({ id: courierEvents.id });
      if (kept.length === 0) return { applied: false, reason: 'Already had this news.' };
      if (news.state === 'booked') return { applied: false, reason: null };
      try {
        await tx.transaction(async (inner) => {
          const r = await this.applyIn(inner, actor, s.deliveryId, { state: news.state, note: news.note, receivedBy: news.receivedBy ?? null, trackingNumber: news.trackingNumber ?? null, proofUrl: news.proofUrl ?? null });
          if (!r.ok) throw new Refused(r);
        });
      } catch (e) {
        if (e instanceof Refused) return { applied: false, reason: e.refusal.message };
        throw e;
      }
      return { applied: true, reason: null };
    });
  }

  private async applyIn(tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0], actor: DocActor, deliveryId: string, input: NewsInput): Promise<DocResult<null>> {
    const { state, note } = input;
    const [d] = await tx.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
    if (d === undefined) return fail('not_found', 'That delivery could not be found.');
    if (d.method !== 'courier') return fail('wrong_method', 'Only a delivery sent with a courier has news from one.');
    const [s] = await tx.select().from(deliveryShipments).where(eq(deliveryShipments.deliveryId, deliveryId)).for('update');
    if (s === undefined || d.status !== 'out_for_delivery') return fail('not_allowed', 'This parcel is not with a courier now.');
    const tracking = input.trackingNumber ?? s.trackingNumber;
    if (state === 'delivered') {
      const r = await this.documents.deliver(actor, deliveryId, { receivedBy: input.receivedBy ?? 'As told by the courier', note }, undefined, tx);
      if (!r.ok) return r;
    } else if (state === 'exception') {
      const r = await this.documents.failAttempt(actor, deliveryId, { reasonCode: isFailureReason(input.reasonCode) ? input.reasonCode : 'other', note: note ?? 'The courier reported a problem.' }, undefined, tx);
      if (!r.ok) return r;
    } else {
      await this.documents.recordNote(tx, actor, deliveryId, 'courier_update', note, { state, trackingNumber: tracking });
    }
    const proof = state === 'delivered' && input.proofUrl !== undefined && input.proofUrl !== null ? { podUrl: input.proofUrl, podName: input.receivedBy ?? null } : {};
    await tx.update(deliveryShipments).set({ status: state, trackingNumber: tracking, lastNote: note, lastUpdateAt: new Date(), ...proof }).where(eq(deliveryShipments.id, s.id));
    if (tracking !== d.trackingNumber) await tx.update(deliveries).set({ trackingNumber: tracking }).where(eq(deliveries.id, deliveryId));
    return { ok: true, data: null };
  }
}
