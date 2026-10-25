import { describe, expect, it } from 'vitest';
import type { Order } from '@/types/index';
import {
  blankAddress,
  formatAmount,
  formatOrderDate,
  itemCountLabel,
  orderStateOf,
  ownsOrder,
  paymentStateOf,
  readAddress,
  toCustomerOrder,
} from './storefront-account';

const order = {
  id: 'o1',
  orderNumber: 'SO-1',
  userId: 'acct-1',
  tradeCustomerId: 'trade-1',
  status: 'shipped',
  paymentStatus: 'paid',
  currency: 'KES',
  createdAt: '2026-10-01T00:00:00.000Z',
  subtotal: 100,
  tax: 16,
  shippingFee: 0,
  totalAmount: 116,
  shippingAddress: { street: 's', city: 'c', countyOrState: 'k', country: 'Kenya' },
  internalNotes: 'secret',
  customerEmail: 'a@b.c',
  discounts: { any: 1 },
  items: [
    {
      productId: 'p',
      productName: 'Cable',
      sku: 'C1',
      quantity: 2,
      unitPrice: 50,
      totalPrice: 100,
      imageUrl: '',
      unitCost: 30,
      priceTrace: { steps: [] },
    },
  ],
} as unknown as Order;

describe('toCustomerOrder', () => {
  it('keeps what the shopper needs', () => {
    const view = toCustomerOrder(order);
    expect(view.orderNumber).toBe('SO-1');
    expect(view.items[0]).toMatchObject({
      productName: 'Cable',
      quantity: 2,
      totalPrice: 100,
      isGift: false,
    });
  });
  it('leaves out everything internal', () => {
    const text = JSON.stringify(toCustomerOrder(order));
    for (const hidden of [
      'secret',
      'unitCost',
      'priceTrace',
      'discounts',
      'internalNotes',
      'userId',
      'tradeCustomerId',
    ]) {
      expect(text).not.toContain(hidden);
    }
  });
});

describe('ownsOrder', () => {
  const owner = { ids: ['acct-1', 'login-1'], email: 'Me@Shop.co', tradeCustomerId: 'trade-1' };
  it('matches by account id, login id, email or trade customer', () => {
    expect(ownsOrder({ userId: 'acct-1', tradeCustomerId: null }, owner)).toBe(true);
    expect(ownsOrder({ userId: 'login-1', tradeCustomerId: null }, owner)).toBe(true);
    expect(ownsOrder({ userId: 'me@shop.co', tradeCustomerId: null }, owner)).toBe(true);
    expect(ownsOrder({ userId: '', tradeCustomerId: 'trade-1' }, owner)).toBe(true);
  });
  it('refuses someone else’s order', () => {
    expect(ownsOrder({ userId: 'acct-2', tradeCustomerId: 'trade-2' }, owner)).toBe(false);
  });
  it('refuses an order with no owner mark', () => {
    expect(
      ownsOrder(
        { userId: '', tradeCustomerId: null },
        { ids: [''], email: '', tradeCustomerId: null },
      ),
    ).toBe(false);
  });
});

describe('states in plain words', () => {
  it('names order and payment states', () => {
    expect(orderStateOf('shipped').label).toBe('On its way');
    expect(orderStateOf('pending').tone).toBe('amber');
    expect(paymentStateOf('reconciled').label).toBe('Paid');
  });
  it('shows an unknown state as it is', () => {
    expect(orderStateOf('weird')).toMatchObject({ label: 'weird', tone: 'gray' });
  });
});

describe('readAddress', () => {
  const good = {
    ...blankAddress,
    label: ' Home ',
    recipientName: 'Ann',
    recipientPhone: '0712 345 678',
    street: '1 Rd',
    city: 'Nairobi',
    countyOrState: 'Nairobi',
  };
  it('trims a good address', () => {
    const result = readAddress(good);
    expect(result).toMatchObject({
      ok: true,
      address: { label: 'Home', country: 'Kenya', isDefault: false },
    });
  });
  it('says which field is missing', () => {
    const result = readAddress({ ...good, street: '  ' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('Street');
  });
  it('rejects a bad phone and over-long text', () => {
    expect(readAddress({ ...good, recipientPhone: 'abc' }).ok).toBe(false);
    expect(readAddress({ ...good, street: 'x'.repeat(201) }).ok).toBe(false);
  });
  it('rejects non-objects and ignores non-boolean default flags', () => {
    expect(readAddress(null).ok).toBe(false);
    expect(readAddress({ ...good, isDefault: 'yes' })).toMatchObject({
      ok: true,
      address: { isDefault: false },
    });
  });
});

describe('formatting', () => {
  it('groups amounts the same everywhere', () => {
    expect(formatAmount(1234.5, 'KES')).toBe('KES 1,234.50');
    expect(formatAmount(0, 'KES')).toBe('KES 0.00');
    expect(formatAmount(-5, 'USD')).toBe('-USD 5.00');
  });
  it('dates in Nairobi time', () => {
    expect(formatOrderDate('2026-10-23T22:30:00.000Z')).toBe('24 Oct 2026');
    expect(formatOrderDate('nope')).toBe('');
  });
  it('counts units', () => {
    expect(itemCountLabel({ items: [{ quantity: 2 }, { quantity: 1 }] } as never)).toBe('3 items');
    expect(itemCountLabel({ items: [{ quantity: 1 }] } as never)).toBe('1 item');
  });
});
