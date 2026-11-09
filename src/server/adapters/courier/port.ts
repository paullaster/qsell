/**
 * The courier port: what the delivery module needs from a courier company, so that a courier's own system can be plugged in later
 * without the module changing. The first adapter is manual: a person types in the tracking number and the courier's news, so nothing
 * waits for an integration. A courier that cannot be reached never blocks the sale: the delivery carries on with what was typed.
 */
import { COURIER_STATES, COURIER_STATE_WORDS, isCourierState, type CourierState } from '@/lib/courier-states';

export { COURIER_STATES, COURIER_STATE_WORDS, isCourierState, type CourierState };

export interface CourierShipmentRequest {
  deliveryNumber: string;
  courierName: string;
  /** What the person typed, when the courier gave one. */
  trackingNumber: string | null;
  recipientName: string;
  recipientPhone: string | null;
  destination: string;
  parcels: number;
}

export interface CourierBooking {
  /** The courier's own id for the booking, when it gives one apart from the tracking number. */
  externalId?: string | null;
  trackingNumber: string | null;
  /** A courier's own tracking page, when the adapter knows it. */
  trackingUrl: string | null;
  labelUrl: string | null;
}

export interface CourierNews {
  state: CourierState;
  note: string | null;
  /** The courier's own time for it, kept beside ours and never used to order anything. */
  at: Date | null;
  /** Who signed for it, and a link to the courier's proof of delivery (a photo or signature), when they gave them. */
  receivedBy?: string | null;
  proofUrl?: string | null;
  trackingNumber?: string | null;
}

/** One piece of news the courier pushed to us, with an id so the same one sent twice counts once. */
export interface CourierPush {
  trackingNumber: string;
  eventId: string;
  news: CourierNews;
}

/** A courier's answer that is a refusal or a failure, in words that are safe to show; nothing of the courier's own error text or key. */
export class CourierError extends Error {
  constructor(
    message: string,
    /** Whether trying again later could help (a timeout, the courier being down) or not (the courier refused the parcel). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CourierError';
  }
}

export interface CourierPort {
  readonly id: string;
  /** Books the parcel. Manual: records what was typed. */
  book(request: CourierShipmentRequest): Promise<CourierBooking>;
  /** The courier's latest news, or null when there is none to fetch (manual: the news is typed in). */
  track(trackingNumber: string): Promise<CourierNews | null>;
  /** Cancels the booking where the courier allows it. Manual: nothing to cancel. */
  cancel(trackingNumber: string): Promise<void>;
  /** Reads what the courier pushed to us, or null when it is not news about a parcel. Adapters that are only asked (never told) leave this out. */
  parseWebhook?(body: string): CourierPush | null;
}
