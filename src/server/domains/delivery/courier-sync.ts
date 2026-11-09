import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliveryShipments, orders, type DeliveryShipmentRow } from '@/server/db/drizzle/schema';
import { MAX_BOOKING_TRIES, bookingWaitMinutes, nextPollMinutes } from '@/lib/courier-http';
import { courierAdapter } from '@/server/adapters/courier/registry';
import { signatureValid } from '@/server/adapters/courier/http-json';
import { CourierError, type CourierPort } from '@/server/adapters/courier/port';
import type { CourierAccounts, Connection } from './courier-accounts';
import type { DeliveryDocuments, DocActor, DocRefusal, DocResult } from './documents';
import type { CourierShipments } from './shipments';

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const LEASE_MINUTES = 5;
const RETRY_STATE = { book_failed: 'book_pending', cancel_failed: 'cancel_pending' } as const;
const minutesFrom = (from: Date, minutes: number): Date => new Date(from.getTime() + minutes * 60_000);
/** The words kept for a failure: what went wrong in plain terms, never what the courier or the network said. */
const safe = (e: unknown): { message: string; retryable: boolean } => (e instanceof CourierError ? { message: e.message, retryable: e.retryable } : { message: 'The courier could not be reached.', retryable: true });

export interface SyncResult {
  booked: number;
  polled: number;
  cancelled: number;
  failed: number;
}

export interface PushReply {
  status: 200 | 202 | 401 | 404;
  message: string;
}

/**
 * Keeps our parcels and the couriers' systems in step, in the background, so that a courier being slow or down never holds up a sale or a dispatch:
 * a parcel is booked after it is sent out (tried again, with longer waits, and left visible as failed for a person to retry or to type in by hand),
 * asked about while it is on the road, told about when it is cancelled, and listened to when the courier pushes news. Every piece of news
 * goes through the same step as news typed in, once. A parcel is leased while it is being worked on, so two workers never do the same call.
 */
export class CourierSync {
  constructor(
    private readonly db: DrizzleDb,
    private readonly accounts: Pick<CourierAccounts, 'connectionFor' | 'connectionForWebhook'>,
    private readonly shipments: Pick<CourierShipments, 'receive'>,
    private readonly documents: Pick<DeliveryDocuments, 'recordNote'>,
    private readonly clock: () => Date = () => new Date(),
    /** Lets a test stand in for the courier's system. */
    private readonly adapterFor: (c: Connection) => CourierPort = (c) => courierAdapter(c.adapter, c.settings === null || c.key === null ? undefined : { settings: c.settings, key: c.key }),
  ) {}

  private actorOf(s: DeliveryShipmentRow): DocActor {
    return { companyId: s.companyId, userId: `courier:${s.accountId ?? 'none'}` };
  }

  /** One round of work. Safe to run often and from more than one place. */
  async run(limit = 25): Promise<SyncResult> {
    const now = this.clock();
    const at = now.toISOString();
    // A delivery that was cancelled: its parcel is cancelled with the courier too (or just closed, if it was never booked).
    await this.db.execute(sql`
      UPDATE delivery_shipments s
         SET sync_state = CASE WHEN s.tracking_number IS NULL THEN 'cancelled' ELSE 'cancel_pending' END,
             sync_next_at = CASE WHEN s.tracking_number IS NULL THEN NULL ELSE ${at}::timestamptz END,
             sync_tries = 0, sync_error = NULL
        FROM deliveries d
       WHERE d.id = s.delivery_id AND d.status = 'cancelled' AND s.account_id IS NOT NULL AND s.sync_state IN ('idle', 'book_pending', 'book_failed')`);
    const due = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ s: deliveryShipments })
        .from(deliveryShipments)
        .where(and(isNotNull(deliveryShipments.accountId), lte(deliveryShipments.syncNextAt, now), inArray(deliveryShipments.syncState, ['idle', 'book_pending', 'cancel_pending'])))
        .orderBy(deliveryShipments.syncNextAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      const ids = rows.map((r) => r.s.id);
      if (ids.length > 0) await tx.update(deliveryShipments).set({ syncNextAt: minutesFrom(now, LEASE_MINUTES) }).where(inArray(deliveryShipments.id, ids));
      return rows.map((r) => r.s);
    });
    const result: SyncResult = { booked: 0, polled: 0, cancelled: 0, failed: 0 };
    for (const s of due) {
      try {
        const done = await this.work(s, now);
        result[done] += 1;
      } catch (e) {
        // One parcel's trouble never stops the others; it is looked at again after the lease.
        console.error('[courier.sync]', s.id, e instanceof Error ? e.message : 'failed');
        result.failed += 1;
      }
    }
    return result;
  }

  private async work(s: DeliveryShipmentRow, now: Date): Promise<keyof SyncResult> {
    if (s.accountId === null) return 'failed';
    const conn = await this.accounts.connectionFor(s.companyId, s.accountId);
    if (s.syncState === 'book_pending') return await this.book(s, conn, now);
    if (s.syncState === 'cancel_pending') return await this.cancel(s, conn, now);
    return await this.poll(s, conn, now);
  }

  private async book(s: DeliveryShipmentRow, conn: Connection | null, now: Date): Promise<keyof SyncResult> {
    if (conn === null || conn.adapter === 'manual') return await this.failed(s, 'book_failed', 'The courier\'s connection is not complete. Check its address and key.', false, now);
    const [d] = await this.db
      .select({ number: deliveries.number, destination: deliveries.destination, recipientName: deliveries.recipientName, recipientPhone: deliveries.recipientPhone, customerName: orders.customerName, customerPhone: orders.customerPhone })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .where(eq(deliveries.id, s.deliveryId));
    if (d === undefined) return await this.failed(s, 'book_failed', 'The delivery could not be found.', false, now);
    const a = d.destination.address;
    const place = [a?.area, a?.town, a?.county].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(', ');
    const pin = d.destination.pin === null ? '' : ` (${String(d.destination.pin.latitude)}, ${String(d.destination.pin.longitude)})`;
    try {
      const booked = await this.adapterFor(conn).book({ deliveryNumber: d.number, courierName: conn.name, trackingNumber: s.trackingNumber, recipientName: d.recipientName ?? d.customerName, recipientPhone: d.recipientPhone ?? d.customerPhone, destination: `${place}${pin}`.trim() === '' ? 'See the pin' : `${place}${pin}`.trim(), parcels: 1 });
      await this.db.transaction(async (tx) => {
        await tx
          .update(deliveryShipments)
          .set({ trackingNumber: booked.trackingNumber ?? s.trackingNumber, trackingUrl: booked.trackingUrl, labelUrl: booked.labelUrl, syncState: 'idle', syncTries: 0, syncError: null, syncNextAt: minutesFrom(now, 15), lastNote: `Booked with ${conn.name}`, lastUpdateAt: now })
          .where(eq(deliveryShipments.id, s.id));
        if (booked.trackingNumber !== null) await tx.update(deliveries).set({ trackingNumber: booked.trackingNumber }).where(eq(deliveries.id, s.deliveryId));
        await this.documents.recordNote(tx, this.actorOf(s), s.deliveryId, 'courier_update', `Booked with ${conn.name}${booked.trackingNumber === null ? '' : `, tracking ${booked.trackingNumber}`}`, { state: 'booked', trackingNumber: booked.trackingNumber });
      });
      return 'booked';
    } catch (e) {
      const f = safe(e);
      return await this.failed(s, 'book_failed', f.message, f.retryable, now);
    }
  }

  private async cancel(s: DeliveryShipmentRow, conn: Connection | null, now: Date): Promise<keyof SyncResult> {
    if (conn === null || s.trackingNumber === null) return await this.failed(s, 'cancel_failed', 'The courier\'s connection is not complete, so the cancellation was not sent.', false, now);
    try {
      await this.adapterFor(conn).cancel(s.trackingNumber);
      await this.db.update(deliveryShipments).set({ syncState: 'cancelled', syncTries: 0, syncError: null, syncNextAt: null, lastNote: `Cancelled with ${conn.name}`, lastUpdateAt: now }).where(eq(deliveryShipments.id, s.id));
      return 'cancelled';
    } catch (e) {
      const f = safe(e);
      return await this.failed(s, 'cancel_failed', f.message, f.retryable, now);
    }
  }

  private async poll(s: DeliveryShipmentRow, conn: Connection | null, now: Date): Promise<keyof SyncResult> {
    // A parcel that is not on the road any more, or has no tracking number to ask about, is left alone.
    if (conn === null || conn.adapter === 'manual' || s.trackingNumber === null || (s.status !== 'booked' && s.status !== 'in_transit')) {
      await this.db.update(deliveryShipments).set({ syncNextAt: null }).where(eq(deliveryShipments.id, s.id));
      return 'polled';
    }
    const waitMinutes = nextPollMinutes((now.getTime() - s.lastUpdateAt.getTime()) / 60_000);
    try {
      const news = await this.adapterFor(conn).track(s.trackingNumber);
      if (news !== null) {
        const id = createHash('sha256').update(`${news.state}|${news.note ?? ''}|${news.at?.toISOString() ?? ''}`).digest('hex').slice(0, 40);
        await this.shipments.receive(this.actorOf(s), s.id, news, 'poll', id);
      }
      await this.db.update(deliveryShipments).set({ syncError: null, syncNextAt: minutesFrom(now, waitMinutes) }).where(eq(deliveryShipments.id, s.id));
      return 'polled';
    } catch (e) {
      await this.db.update(deliveryShipments).set({ syncError: safe(e).message, syncNextAt: minutesFrom(now, Math.max(waitMinutes, 30)) }).where(eq(deliveryShipments.id, s.id));
      return 'failed';
    }
  }

  /** A try that failed: another later while it might still work, and then left as failed, visibly, for a person. */
  private async failed(s: DeliveryShipmentRow, state: 'book_failed' | 'cancel_failed', message: string, retryable: boolean, now: Date): Promise<keyof SyncResult> {
    const tries = s.syncTries + 1;
    const again = retryable && tries < MAX_BOOKING_TRIES;
    await this.db
      .update(deliveryShipments)
      .set({ syncState: again ? RETRY_STATE[state] : state, syncTries: tries, syncError: message, syncNextAt: again ? minutesFrom(now, bookingWaitMinutes(tries)) : null })
      .where(eq(deliveryShipments.id, s.id));
    return 'failed';
  }

  private async shipmentOf(companyId: string, deliveryId: string): Promise<DeliveryShipmentRow | null> {
    const [s] = await this.db.select().from(deliveryShipments).where(and(eq(deliveryShipments.deliveryId, deliveryId), eq(deliveryShipments.companyId, companyId)));
    return s ?? null;
  }

  /** Tries again at a booking or a cancellation that failed, now. */
  async retry(actor: DocActor, deliveryId: string): Promise<DocResult<null>> {
    const s = await this.shipmentOf(actor.companyId, deliveryId);
    if (s === null) return fail('not_found', 'That parcel could not be found.');
    if (s.accountId === null || (s.syncState !== 'book_failed' && s.syncState !== 'cancel_failed')) return fail('not_allowed', 'There is nothing to try again for this parcel.');
    await this.db.update(deliveryShipments).set({ syncState: s.syncState === 'book_failed' ? 'book_pending' : 'cancel_pending', syncTries: 0, syncError: null, syncNextAt: this.clock() }).where(eq(deliveryShipments.id, s.id));
    return { ok: true, data: null };
  }

  /** Asks the courier about a parcel now, instead of waiting for the next round. */
  async refresh(actor: DocActor, deliveryId: string): Promise<DocResult<null>> {
    const s = await this.shipmentOf(actor.companyId, deliveryId);
    if (s?.accountId == null) return fail('not_found', 'That parcel is not followed by a courier\'s system.');
    if (s.syncState !== 'idle') return fail('not_allowed', 'This parcel is being booked or cancelled; ask again in a moment.');
    const conn = await this.accounts.connectionFor(s.companyId, s.accountId);
    await this.poll(s, conn, this.clock());
    const after = await this.shipmentOf(actor.companyId, deliveryId);
    if (after?.syncError != null) return fail('conflict', after.syncError);
    return { ok: true, data: null };
  }

  /** What a courier pushed to its address: checked against the secret it signs with, then applied like any other news. */
  async receivePush(webhookKey: string, rawBody: string, signature: string | null): Promise<PushReply> {
    if (rawBody.length > 100_000) return { status: 202, message: 'Too large; ignored.' };
    const conn = await this.accounts.connectionForWebhook(webhookKey);
    if (conn?.adapter !== 'http_json' || conn.webhookSecret === null) return { status: 404, message: 'Not found.' };
    if (!signatureValid(conn.webhookSecret, rawBody, signature)) return { status: 401, message: 'The signature is not right.' };
    const push = this.adapterFor(conn).parseWebhook?.(rawBody) ?? null;
    if (push === null) return { status: 202, message: 'Not news about a parcel; ignored.' };
    const [s] = await this.db
      .select()
      .from(deliveryShipments)
      .where(and(eq(deliveryShipments.companyId, conn.companyId), eq(deliveryShipments.accountId, conn.accountId), eq(deliveryShipments.trackingNumber, push.trackingNumber)));
    if (s === undefined) return { status: 202, message: 'We have no such parcel; ignored.' };
    const r = await this.shipments.receive(this.actorOf(s), s.id, push.news, 'webhook', push.eventId);
    return { status: 200, message: r.applied ? 'Applied.' : (r.reason ?? 'Noted.') };
  }
}
