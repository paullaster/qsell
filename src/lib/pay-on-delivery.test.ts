import { describe, expect, it } from 'vitest';
import { offerPayOnDelivery, payOnDeliveryProblem, type PayOnDeliveryOffer } from './pay-on-delivery';

const offer: PayOnDeliveryOffer = { on: true, max: 20000, currency: 'KES' };

describe('pay on delivery at checkout', () => {
  it('is allowed for an order we deliver ourselves, in our currency, within the limit', () => {
    expect(payOnDeliveryProblem(offer, { deliveryMethod: 'own_fleet', currency: 'KES', total: 20000 })).toBeNull();
    expect(payOnDeliveryProblem({ ...offer, max: null }, { deliveryMethod: 'own_fleet', currency: 'kes', total: 9_999_999 })).toBeNull();
  });

  it('says why not', () => {
    expect(payOnDeliveryProblem({ ...offer, on: false }, { deliveryMethod: 'own_fleet', currency: 'KES', total: 100 })).toMatch(/not available/);
    for (const deliveryMethod of ['courier', 'pickup', null]) expect(payOnDeliveryProblem(offer, { deliveryMethod, currency: 'KES', total: 100 })).toMatch(/deliver ourselves/);
    expect(payOnDeliveryProblem(offer, { deliveryMethod: 'own_fleet', currency: 'USD', total: 100 })).toMatch(/only for orders in KES/);
    expect(payOnDeliveryProblem(offer, { deliveryMethod: 'own_fleet', currency: 'KES', total: 20000.01 })).toMatch(/up to KES 20000\.00/);
  });

  it('is shown for what has been chosen so far', () => {
    expect(offerPayOnDelivery(offer, 'own_fleet', 500)).toBe(true);
    expect(offerPayOnDelivery(offer, 'own_fleet', 30000)).toBe(false);
    expect(offerPayOnDelivery(offer, 'pickup', 500)).toBe(false);
    expect(offerPayOnDelivery(offer, null, 500)).toBe(false);
    expect(offerPayOnDelivery({ ...offer, on: false }, 'own_fleet', 500)).toBe(false);
    expect(offerPayOnDelivery(null, 'own_fleet', 500)).toBe(false);
    expect(offerPayOnDelivery({ ...offer, max: null }, 'own_fleet', 1e9)).toBe(true);
  });
});
