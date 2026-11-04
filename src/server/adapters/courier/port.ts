/**
 * The courier port: what the delivery module needs from a courier company, so that a courier's own system can be plugged in later
 * without the module changing. The first adapter is manual: a person types in the tracking number and the courier's news, so nothing
 * waits for an integration. A courier that cannot be reached never blocks the sale: the delivery carries on with what was typed.
 */
export const COURIER_STATES = ['booked', 'in_transit', 'delivered', 'exception'] as const;
export type CourierState = (typeof COURIER_STATES)[number];
export const isCourierState = (value: unknown): value is CourierState => typeof value === 'string' && (COURIER_STATES as readonly string[]).includes(value);

export const COURIER_STATE_WORDS: Record<CourierState, string> = { booked: 'Booked with the courier', in_transit: 'With the courier', delivered: 'Courier says delivered', exception: 'Courier reports a problem' };

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
}

export interface CourierPort {
  readonly id: string;
  /** Books the parcel. Manual: records what was typed. */
  book(request: CourierShipmentRequest): Promise<CourierBooking>;
  /** The courier's latest news, or null when there is none to fetch (manual: the news is typed in). */
  track(trackingNumber: string): Promise<CourierNews | null>;
  /** Cancels the booking where the courier allows it. Manual: nothing to cancel. */
  cancel(trackingNumber: string): Promise<void>;
}
