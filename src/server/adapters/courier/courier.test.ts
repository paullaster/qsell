import { describe, expect, it } from 'vitest';
import { COURIER_ADAPTER_IDS, courierAdapter } from './registry';
import { isCourierState } from './port';

describe('the courier port and its manual adapter', () => {
  const request = { deliveryNumber: 'DLV-26-0000000001', courierName: 'Swift Couriers', trackingNumber: 'SW123', recipientName: 'Wanjiru', recipientPhone: '0711000000', destination: 'Westlands, Nairobi', parcels: 1 };
  it('records what was typed when a parcel is booked, and has nothing to fetch or cancel', async () => {
    const adapter = courierAdapter('manual');
    expect(adapter.id).toBe('manual');
    expect(await adapter.book(request)).toEqual({ trackingNumber: 'SW123', trackingUrl: null, labelUrl: null });
    expect(await adapter.book({ ...request, trackingNumber: null })).toMatchObject({ trackingNumber: null });
    expect(await adapter.track('SW123')).toBeNull();
    await expect(adapter.cancel('SW123')).resolves.toBeUndefined();
  });
  it('falls back to the manual adapter for an id that is not known, so a retired adapter never strands a delivery', () => {
    expect(courierAdapter('retired-courier').id).toBe('manual');
    expect(COURIER_ADAPTER_IDS).toContain('manual');
  });
  it('knows the courier states and nothing else', () => {
    expect(['booked', 'in_transit', 'delivered', 'exception'].every(isCourierState)).toBe(true);
    expect(isCourierState('lost')).toBe(false);
  });
});
