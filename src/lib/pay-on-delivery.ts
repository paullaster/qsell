/**
 * "Pay on delivery" at the shop's checkout: the shopper places the order now and pays the shop's own rider when it arrives, in cash or by
 * M-Pesa. The company switches it on, and may set the largest order it will take this way. These are the rules only: when it is offered
 * and when an order may be placed this way. The server checks them again when the order is made; the checkout only shows or hides.
 */

export const PAY_ON_DELIVERY = 'pay_on_delivery';
export const PAY_ON_DELIVERY_WORDS = 'Pay on delivery';
export const PAY_ON_DELIVERY_HELP = 'Pay the rider in cash or by M-Pesa when your order arrives. Keep your phone on.';

export interface PayOnDeliveryOffer {
  /** Switched on by the company, with cash at the door set up. */
  on: boolean;
  /** The largest order taken this way, in the company's currency; null means no limit. */
  max: number | null;
  currency: string;
}

export interface OrderFacts {
  /** How the shopper chose to have it delivered (`own_fleet`, `courier`, `pickup`), or null for no delivery. */
  deliveryMethod: string | null;
  /** The currency the order is in, and the total, as the server priced it (never what the browser says). */
  currency: string;
  total: number;
}

/** Why an order cannot be placed to be paid on delivery, in words for the shopper, or null when it can. */
export function payOnDeliveryProblem(offer: PayOnDeliveryOffer, order: OrderFacts): string | null {
  if (!offer.on) return 'Pay on delivery is not available. Please choose another way to pay.';
  if (order.deliveryMethod !== 'own_fleet') return 'Pay on delivery is only for orders we deliver ourselves. Please choose another way to pay.';
  if (order.currency.toUpperCase() !== offer.currency.toUpperCase()) return `Pay on delivery is only for orders in ${offer.currency}. Please choose another way to pay.`;
  if (offer.max !== null && order.total > offer.max) return `Pay on delivery is for orders up to ${offer.currency} ${offer.max.toFixed(2)}. Please choose another way to pay.`;
  return null;
}

/** Whether the checkout shows the option for what the shopper has chosen so far (an estimate: the total can still change). */
export function offerPayOnDelivery(offer: PayOnDeliveryOffer | null, deliveryMethod: string | null, payable: number): boolean {
  if (offer === null || !offer.on || deliveryMethod !== 'own_fleet') return false;
  return offer.max === null || payable <= offer.max;
}
