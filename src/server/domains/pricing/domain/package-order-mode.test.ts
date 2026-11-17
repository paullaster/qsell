import { describe, expect, it } from 'vitest';
import { allowsCart, allowsQuote, orderModeOf, quoteOnlyRefusal } from './package-order-mode';

describe('how a package is ordered on the shop', () => {
  it('reads a missing or unknown setting as the cart, as before', () => {
    expect(orderModeOf(undefined)).toBe('cart');
    expect(orderModeOf('nonsense')).toBe('cart');
    expect(orderModeOf('quote')).toBe('quote');
    expect(orderModeOf('either')).toBe('either');
  });

  it('allows the cart and the quote request according to the mode', () => {
    expect([allowsCart('cart'), allowsQuote('cart')]).toEqual([true, false]);
    expect([allowsCart('quote'), allowsQuote('quote')]).toEqual([false, true]);
    expect([allowsCart('either'), allowsQuote('either')]).toEqual([true, true]);
  });

  it('says in words why the cart is closed', () => {
    expect(quoteOnlyRefusal('Wedding feast')).toContain('Wedding feast is ordered by quote request');
  });
});
