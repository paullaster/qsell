import { describe, expect, it } from 'vitest';
import { cartSummaryOf, guestSessionRef } from './checkout-attempts';

describe('a guest in the record of a checkout', () => {
  it('is a keyed hash: the same connection is the same value, another is not, and the address cannot be read back', () => {
    const a = guestSessionRef('41.1.1.1', 'Firefox', 'key');
    expect(a).toBe(guestSessionRef('41.1.1.1', 'Firefox', 'key'));
    expect(a).not.toBe(guestSessionRef('41.1.1.2', 'Firefox', 'key'));
    expect(a).not.toBe(guestSessionRef('41.1.1.1', 'Firefox', 'another-key'));
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(a).not.toContain('41.1.1.1');
  });
});

describe('a cart in the record of a checkout', () => {
  it('keeps product ids and quantities and the way to pay, and nothing that names the shopper', () => {
    const summary = cartSummaryOf({
      customerName: 'Wanjiru',
      customerPhone: '0711111111',
      customerEmail: 'a@b.c',
      shippingAddress: { street: '1 Moi Ave' },
      paymentMethod: 'mpesa_daraja',
      items: [{ productId: 'p1', quantity: 2, productName: 'Rice' }, { productId: 'p2', quantity: 'x' }, 'junk'],
    });
    expect(summary).toEqual({ lines: [{ productId: 'p1', quantity: 2 }], paymentMethod: 'mpesa_daraja' });
    expect(JSON.stringify(summary)).not.toMatch(/Wanjiru|0711|a@b\.c|Moi|Rice/);
  });
  it('copes with anything the browser sends', () => {
    expect(cartSummaryOf(null)).toEqual({ lines: [], paymentMethod: null });
    expect(cartSummaryOf({ items: 'nope' })).toEqual({ lines: [], paymentMethod: null });
    expect((cartSummaryOf({ items: Array.from({ length: 200 }, (_, i) => ({ productId: `p${String(i)}`, quantity: 1 })) }).lines as unknown[]).length).toBe(50);
  });
});
