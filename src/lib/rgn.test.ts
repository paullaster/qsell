import { describe, expect, it } from 'vitest';
import { acceptedOf, checkRgnHeader, checkRgnLine, mostAcceptable, receiptStatus, sameUnit } from './rgn';

describe('rgn rules', () => {
  it('needs a date and the vendor’s delivery note number', () => {
    expect(Object.keys(checkRgnHeader({ receivedDate: '', deliveryNoteNo: ' ', vehicle: '', notes: '' })).sort()).toEqual(['deliveryNoteNo', 'receivedDate']);
    expect(checkRgnHeader({ receivedDate: '2026-10-24', deliveryNoteNo: 'DN-778', vehicle: '', notes: '' })).toEqual({});
  });
  it('a refusal is part of what arrived and has a reason', () => {
    expect(checkRgnLine({ poLineId: 'a', delivered: '10', rejected: '', rejectReason: '' })).toEqual({});
    expect(checkRgnLine({ poLineId: 'a', delivered: '10', rejected: '11', rejectReason: 'damaged' }).rejected).toBeDefined();
    expect(checkRgnLine({ poLineId: 'a', delivered: '10', rejected: '2', rejectReason: '' }).rejectReason).toBeDefined();
    expect(checkRgnLine({ poLineId: 'a', delivered: 'ten', rejected: '', rejectReason: '' }).delivered).toBeDefined();
    expect(acceptedOf({ delivered: '10', rejected: '2.5' })).toBe(7.5);
  });
  it('what may be accepted is what is still to come plus the tolerance', () => {
    expect(mostAcceptable(10, 4, 0, 0)).toBe(6);
    expect(mostAcceptable(10, 4, 2, 0)).toBe(4);
    expect(mostAcceptable(10, 10, 0, 5)).toBe(0.5);
    expect(mostAcceptable(10, 12, 0, 0)).toBe(0);
  });
  it('an order is received when every line is', () => {
    expect(receiptStatus([{ quantity: 4, received: 4, cancelled: 0 }, { quantity: 10, received: 10, cancelled: 0 }])).toBe('received');
    expect(receiptStatus([{ quantity: 4, received: 4, cancelled: 0 }, { quantity: 10, received: 3, cancelled: 0 }])).toBe('partially_received');
    expect(receiptStatus([{ quantity: 4, received: 0, cancelled: 0 }])).toBe('none');
    expect(receiptStatus([{ quantity: 4, received: 2, cancelled: 2 }])).toBe('received');
  });
  it('matches the unit by code, name or symbol, ignoring case', () => {
    expect(sameUnit('KG', { code: 'kg', name: 'Kilogram', symbol: 'kg' })).toBe(true);
    expect(sameUnit('Kilogram', { code: 'kg', name: 'Kilogram', symbol: null })).toBe(true);
    expect(sameUnit('box', { code: 'kg', name: 'Kilogram', symbol: 'kg' })).toBe(false);
  });
});
