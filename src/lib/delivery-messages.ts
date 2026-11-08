import type { DeliveryAction } from './delivery-document';

/** The messages a customer gets as their delivery moves. Pure: the words and the rules; the sending is the server's. */
export const MESSAGE_KINDS = ['out_for_delivery', 'delivered', 'part_delivered', 'attempt_failed', 'returned', 'slot_not_kept'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const isMessageKind = (value: unknown): value is MessageKind => typeof value === 'string' && (MESSAGE_KINDS as readonly string[]).includes(value);

/** Which message, if any, a delivery step sends. `whole` is whether the order is now delivered in full, for a delivery that arrived. */
export function kindForStep(action: DeliveryAction, whole: boolean): MessageKind | null {
  if (action === 'deliver') return whole ? 'delivered' : 'part_delivered';
  return SENT_BY_STEP[action] ?? null;
}

const SENT_BY_STEP: Partial<Record<DeliveryAction, MessageKind>> = { dispatch: 'out_for_delivery', fail_attempt: 'attempt_failed', return: 'returned' };

/** What each message is, for the shop's own list of what was sent. */
export const KIND_WORDS: Record<MessageKind, string> = { out_for_delivery: 'On its way', delivered: 'Delivered', part_delivered: 'Part delivered', attempt_failed: 'Could not deliver', returned: 'Coming back to us', slot_not_kept: 'Chosen time not kept' };

/** One message for one thing that happened, however often the step is retried: the same key is the same message. */
export const messageKey = (deliveryId: string, kind: MessageKind, attempt: number): string => `${deliveryId}:${kind}:${String(attempt)}`;

/** Why a delivery did not happen, in words for the customer (not the dispatcher's wording). */
const REASON_FOR_CUSTOMER: Record<string, string> = {
  customer_absent: 'nobody was there to receive it',
  refused: 'it was not accepted at the door',
  wrong_address: 'we could not find the address',
  unreachable: 'we could not reach you by phone',
  damaged: 'the goods were damaged on the way and need replacing',
  not_safe: 'we could not reach the place safely',
  other: 'something prevented the delivery',
};
export const reasonForCustomer = (code: string | null): string => (code !== null && Object.prototype.hasOwnProperty.call(REASON_FOR_CUSTOMER, code) ? (REASON_FOR_CUSTOMER[code] ?? REASON_FOR_CUSTOMER.other ?? '') : (REASON_FOR_CUSTOMER.other ?? ''));

export interface MessageFacts {
  tradingName: string;
  /** The first word of the customer's name, or empty. */
  firstName: string;
  orderNumber: string;
  deliveryNumber: string;
  /** The customer's own tracking page. */
  trackUrl: string;
  courierName: string | null;
  receivedBy: string | null;
  /** The six digits the customer says at the door, when the company asks for them as proof. Only the "on its way" message carries it. */
  handoverCode: string | null;
  reasonCode: string | null;
  /** How many tries are left, when a delivery failed and can be tried again. */
  triesLeft: number | null;
}

export interface MessageContent {
  subject: string;
  heading: string;
  greeting: string;
  body: string;
  details: readonly (readonly [string, string])[];
  cta: string;
}

/**
 * The words of a message. It carries only what the tracking page shows: the order and delivery numbers, the state, and (for a
 * courier) the courier's name. Never an address, a phone number or a payment detail.
 */
export function messageContent(kind: MessageKind, f: MessageFacts): MessageContent {
  const store = f.tradingName.trim() === '' ? 'the shop' : f.tradingName.trim();
  const greeting = f.firstName.trim() === '' ? 'Hello,' : `Hello ${f.firstName.trim()},`;
  const base: readonly (readonly [string, string])[] = [['Order', f.orderNumber], ['Delivery', f.deliveryNumber]];
  const withCourier = f.courierName === null ? base : [...base, ['Courier', f.courierName] as const];
  switch (kind) {
    case 'out_for_delivery':
      return {
        subject: `Your order ${f.orderNumber} is on its way · ${store}`,
        heading: 'Your order is on its way',
        greeting,
        body: `Your delivery has left us and is on its way to you. You can follow it on your tracking page.${f.handoverCode === null ? '' : ' Please give the rider the delivery code below when it arrives, and only then.'}`,
        details: f.handoverCode === null ? withCourier : [...withCourier, ['Delivery code', f.handoverCode] as const],
        cta: 'Track my delivery',
      };
    case 'delivered':
      return { subject: `Your order ${f.orderNumber} was delivered · ${store}`, heading: 'Your order was delivered', greeting, body: f.receivedBy === null ? 'Your order was delivered. Thank you for shopping with us.' : `Your order was delivered and ${f.receivedBy} received it. Thank you for shopping with us.`, details: base, cta: 'See my delivery' };
    case 'part_delivered':
      return { subject: `Part of your order ${f.orderNumber} was delivered · ${store}`, heading: 'Part of your order was delivered', greeting, body: 'Part of your order has been delivered. The rest will follow on another delivery, and you will hear from us when it leaves.', details: base, cta: 'See my delivery' };
    case 'attempt_failed':
      return { subject: `We could not deliver your order ${f.orderNumber} · ${store}`, heading: 'We could not deliver your order', greeting, body: `We tried to deliver your order, but ${reasonForCustomer(f.reasonCode)}.${f.triesLeft !== null && f.triesLeft > 0 ? ' We will try again; please keep your phone on.' : ' Please contact us so we can arrange it.'}`, details: base, cta: 'See my delivery' };
    case 'slot_not_kept':
      return {
        subject: `About the delivery time for your order ${f.orderNumber} · ${store}`,
        heading: 'We could not keep the delivery time you chose',
        greeting,
        body: 'The delivery time you chose for your order has since been taken or closed, so we could not hold it for you. Your order is still going ahead. We will be in touch to agree another time, and you can follow it on your tracking page.',
        details: base,
        cta: 'Track my delivery',
      };
    case 'returned':
      return { subject: `Your order ${f.orderNumber} is coming back to us · ${store}`, heading: 'We could not deliver, and it is coming back to us', greeting, body: 'We were not able to deliver your order and it is being returned to us. Please contact us so we can arrange another delivery or put it right.', details: base, cta: 'See my delivery' };
  }
}
