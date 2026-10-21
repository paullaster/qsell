import { describe, expect, it } from 'vitest';
import {
  FULFILMENT_STATUSES,
  ORDER_STATUSES,
  STATUS_FILTERS,
  addressLine,
  heldForApproval,
  isOrderPaid,
  money,
  statusChoice,
  unitsIn,
} from './order-admin';

describe('the admin orders screen', () => {
  it('can narrow to every state an order has, and move an order by hand to the five that make sense', () => {
    expect(STATUS_FILTERS.map((s) => s.id).sort()).toEqual([...ORDER_STATUSES].sort());
    expect(FULFILMENT_STATUSES.map((s) => s.id)).toEqual([
      'pending',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
    ]);
    expect(statusChoice(STATUS_FILTERS, 'shipped')).toEqual({
      id: 'shipped',
      label: 'In transit / shipped',
    });
    expect(statusChoice(STATUS_FILTERS, 'odd')).toEqual({ id: 'odd', label: 'odd' });
  });

  it('is held until approved while approval is pending, refused or a draft', () => {
    expect(heldForApproval({ approvalStatus: 'pending' })).toBe(true);
    expect(heldForApproval({ approvalStatus: 'rejected' })).toBe(true);
    expect(heldForApproval({ approvalStatus: 'draft' })).toBe(true);
    expect(heldForApproval({ approvalStatus: 'approved' })).toBe(false);
    expect(heldForApproval({ approvalStatus: undefined })).toBe(false);
  });

  it('counts a paid or reconciled order as paid', () => {
    expect(isOrderPaid({ paymentStatus: 'paid' })).toBe(true);
    expect(isOrderPaid({ paymentStatus: 'reconciled' })).toBe(true);
    expect(isOrderPaid({ paymentStatus: 'unpaid' })).toBe(false);
  });

  it('writes money, units and addresses', () => {
    expect(money(1234.5, 'KES')).toBe('KES 1,234.50');
    expect(
      unitsIn({ items: [{ quantity: 0.1 }, { quantity: 0.2 }, { quantity: 3 }] as never }),
    ).toBe(3.3);
    expect(
      addressLine({ street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' }),
    ).toBe('1 Rd, Nairobi, Nairobi, Kenya');
    expect(addressLine(null)).toBe('No shipping address on file');
  });
});
