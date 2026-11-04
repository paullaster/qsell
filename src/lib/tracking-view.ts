import type { DeliveryStatus, OrderDeliveryState } from './delivery-document';

/** What a customer sees of a delivery, in their words. The dispatcher's finer states are folded into the few a customer cares about. */
export const CUSTOMER_STATUS_WORDS: Record<DeliveryStatus, string> = {
  draft: 'Being prepared',
  released: 'Being prepared',
  picking: 'Being prepared',
  packed: 'Packed and nearly ready',
  ready: 'Ready to go',
  out_for_delivery: 'On its way',
  delivered: 'Delivered',
  failed_attempt: 'We could not deliver it this time',
  returned: 'Coming back to us',
  cancelled: 'Cancelled',
};

export type CustomerTone = 'progress' | 'good' | 'attention' | 'ended';

export const customerTone = (status: DeliveryStatus): CustomerTone => {
  if (status === 'delivered') return 'good';
  if (status === 'failed_attempt' || status === 'returned') return 'attention';
  if (status === 'cancelled') return 'ended';
  return 'progress';
};

/** The one sentence at the top of the page, from where the whole order stands. */
export const HEADLINE: Record<OrderDeliveryState, string> = {
  not_started: 'We are getting your order ready',
  in_progress: 'Your order is on its way to you',
  partly_delivered: 'Part of your order has been delivered',
  delivered: 'Your order has been delivered',
  exceptions: 'We had a problem delivering your order',
};

export interface TrackedDelivery {
  number: string;
  status: DeliveryStatus;
  items: { name: string; quantity: number }[];
  courier: { name: string; trackingNumber: string | null } | null;
  /** Who received it and when, once delivered. */
  receivedBy: string | null;
  deliveredAt: string | null;
  failedAttempts: number;
  /** While it is out for delivery: the code to give the rider, when the company asks for one. */
  handoverCode: string | null;
}

export interface TrackedCollection {
  branchName: string;
  status: 'waiting' | 'ready' | 'collected' | 'locked' | 'cancelled';
}

export interface TrackedOrder {
  storeName: string;
  orderNumber: string;
  placedAt: string;
  /** Delivered by the shop or a courier, or collected from a branch. */
  kind: 'delivery' | 'collection';
  state: OrderDeliveryState;
  deliveries: TrackedDelivery[];
  /** Goods not on any delivery yet. */
  waiting: { name: string; quantity: number }[];
  /** For an order that is collected. Never the code: that is shown only to someone who also knows the order's contact. */
  collection: TrackedCollection | null;
}

/** What a customer reads about an order they collect, from where it stands. */
export function collectionWords(c: TrackedCollection): { headline: string; detail: string } {
  switch (c.status) {
    case 'waiting':
      return { headline: 'We are getting your order ready', detail: `You will collect it from ${c.branchName}. We will have it ready for you there.` };
    case 'ready':
      return { headline: 'Your order is ready to collect', detail: `Come to ${c.branchName} with your collection code.` };
    case 'collected':
      return { headline: 'Your order was collected', detail: `It was handed over at ${c.branchName}.` };
    case 'locked':
      return { headline: 'Please see the branch', detail: `Your collection at ${c.branchName} needs a person to look at it. Please call or visit the branch.` };
    case 'cancelled':
      return { headline: 'This collection was cancelled', detail: `Please contact ${c.branchName} if you did not expect this.` };
  }
}

export interface TrackingStep {
  label: string;
  done: boolean;
  current: boolean;
}

const STAGE_OF: Record<DeliveryStatus, number> = { draft: 0, released: 0, picking: 0, packed: 1, ready: 1, out_for_delivery: 2, failed_attempt: 2, returned: 2, delivered: 3, cancelled: 0 };

/**
 * The strip of steps for a delivery: made ready, on its way, delivered. The current step is the one the delivery is at; a
 * delivery that could not be made shows where it stopped, not a step it never reached.
 */
export function trackingSteps(status: DeliveryStatus): TrackingStep[] {
  const stage = STAGE_OF[status];
  const labels = ['Being prepared', 'Ready to go', 'On its way', 'Delivered'];
  return labels.map((label, i) => ({ label, done: i < stage || (i === stage && status === 'delivered'), current: i === stage && status !== 'delivered' && status !== 'cancelled' }));
}
