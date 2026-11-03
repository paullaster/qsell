import { describe, expect, it } from 'vitest';
import { renderDeliveryNotePdf } from '@/server/adapters/pdf/pdfkit-delivery-note.adapter';
import type { CompanyProfile } from '@/server/ports/communications';
import { buildDeliveryNote, deliveryNoteFileName } from './delivery-note';
import type { DeliveryView } from './documents';

const company: CompanyProfile = { legalName: 'Test Traders Ltd', tradingName: 'Test Traders', email: 'shop@example.test', phone: '0700000000', streetAddress: '1 Test Road', city: 'Nairobi', countyOrState: 'Nairobi', postalCode: '00100', country: 'Kenya', kraPin: 'P000000000X', invoicePrefix: 'INV', primaryColor: '#111827', accentColor: '#4F46E5' };

const view = (over: Partial<DeliveryView> = {}): DeliveryView => ({
    id: 'd1', number: 'DLV-26-0000000007', orderId: 'o1', orderNumber: 'ORD-77', customerName: 'Wanjiru Buyer', method: 'own_fleet', status: 'ready', statusWords: 'Ready', branch: { id: 'b1', name: 'Westlands Branch' },
    destination: { pin: null, address: { area: 'Westlands', town: 'Nairobi', county: 'Nairobi' }, positionFrom: 'address', approximate: true },
    recipientName: null, recipientPhone: null, notes: 'Gate code 4411', courierName: null, trackingNumber: null, receivedBy: null, failedAttempts: 0, version: 3, createdAt: '2026-11-03T09:00:00Z', releasedAt: null, dispatchedAt: null, deliveredAt: null,
    lines: [{ id: 'l1', productId: 'p1', productName: 'Salt 500g', sku: 'SALT-500', quantity: 5, picked: 4, delivered: 0, issued: 0, back: null }, { id: 'l2', productId: 'p2', productName: 'Rice 5kg', sku: 'RICE-5', quantity: 2, picked: 0, delivered: 0, issued: 0, back: null }],
    events: [], actions: [], ...over,
  });

describe('the delivery note', () => {
  it('carries what was picked (or planned), to whom, where, with the order street and phone when the delivery has none of its own', () => {
    const n = buildDeliveryNote(view(), { customerPhone: '0711000000', street: '1 Moi Avenue' }, company, '2026-11-04');
    expect(n.lines).toEqual([{ sku: 'SALT-500', name: 'Salt 500g', quantity: 4 }]);
    expect(n.deliverTo).toEqual({ name: 'Wanjiru Buyer', phone: '0711000000', address: ['1 Moi Avenue', 'Westlands', 'Nairobi', 'Nairobi'], instructions: 'Gate code 4411' });
    expect(n.courier).toBeNull();
    expect(n.printedOn).toBe('2026-11-04');
  });
  it('prefers the person named to receive it, and names the courier and tracking number', () => {
    const n = buildDeliveryNote(view({ method: 'courier', recipientName: 'Mama Wanjiku', recipientPhone: '0722000000', courierName: 'Swift Couriers', trackingNumber: 'SW123', status: 'out_for_delivery' }), { customerPhone: '0711000000', street: null }, company, '2026-11-04');
    expect(n.deliverTo.name).toBe('Mama Wanjiku');
    expect(n.deliverTo.phone).toBe('0722000000');
    expect(n.courier).toEqual({ name: 'Swift Couriers', tracking: 'SW123' });
    expect(n.deliverTo.address).toEqual(['Westlands', 'Nairobi', 'Nairobi']);
  });
  it('shows who received it and when, once delivered', () => {
    const n = buildDeliveryNote(view({ status: 'delivered', receivedBy: 'Gate guard', deliveredAt: '2026-11-04T10:15:00Z' }), { customerPhone: null, street: null }, company, '2026-11-05');
    expect(n.receivedBy).toBe('Gate guard');
    expect(n.deliveredOn).toBe('2026-11-04');
  });
  it('is not made for a draft or a cancelled delivery', () => {
    expect(() => buildDeliveryNote(view({ status: 'draft' }), { customerPhone: null, street: null }, company, 'x')).toThrow(/Release it/);
    expect(() => buildDeliveryNote(view({ status: 'cancelled' }), { customerPhone: null, street: null }, company, 'x')).toThrow(/no note/);
  });
  it('is named safely for a download', () => {
    expect(deliveryNoteFileName('DLV-26-0000000007')).toBe('delivery-note-DLV-26-0000000007.pdf');
    expect(deliveryNoteFileName('A/B "C"')).toBe('delivery-note-A_B__C_.pdf');
  });
  it('draws a PDF, over more than one page when there are many lines', async () => {
    const one = await renderDeliveryNotePdf(buildDeliveryNote(view(), { customerPhone: '0711000000', street: '1 Moi Avenue' }, company, '2026-11-04'));
    expect(one.subarray(0, 5).toString()).toBe('%PDF-');
    expect(one.length).toBeGreaterThan(1500);
    const lines = Array.from({ length: 60 }, (_, i) => ({ id: `l${String(i)}`, productId: `p${String(i)}`, productName: `Product ${String(i)}`, sku: `SKU-${String(i)}`, quantity: 1, picked: 1, delivered: 0, issued: 0, back: null }));
    const many = await renderDeliveryNotePdf(buildDeliveryNote(view({ lines }), { customerPhone: null, street: null }, company, '2026-11-04'));
    expect(many.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0).toBeGreaterThan(1);
  });
});
