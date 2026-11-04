import type { CourierBooking, CourierNews, CourierPort, CourierShipmentRequest } from './port';

/** The courier is told by phone or on their own site; the tracking number and every piece of news is typed in here. */
export class ManualCourierAdapter implements CourierPort {
  readonly id = 'manual';

  book(request: CourierShipmentRequest): Promise<CourierBooking> {
    return Promise.resolve({ trackingNumber: request.trackingNumber, trackingUrl: null, labelUrl: null });
  }

  track(): Promise<CourierNews | null> {
    return Promise.resolve(null);
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}
