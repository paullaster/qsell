/** Where a parcel stands with a courier, in our words. */
export const COURIER_STATES = ['booked', 'in_transit', 'delivered', 'exception'] as const;
export type CourierState = (typeof COURIER_STATES)[number];
export const isCourierState = (value: unknown): value is CourierState => typeof value === 'string' && (COURIER_STATES as readonly string[]).includes(value);

export const COURIER_STATE_WORDS: Record<CourierState, string> = { booked: 'Booked with the courier', in_transit: 'With the courier', delivered: 'Courier says delivered', exception: 'Courier reports a problem' };
