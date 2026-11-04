import { roundQty } from '@/lib/decimal';

/**
 * The delivery document: what an order's delivery looks like once it is being got ready and sent. An order can have several (a
 * delivery of what is on the shelf now, another later), each with its own states, and the order's own delivery status is worked out
 * from them. These are the rules only: states, who may do what from where, how an order is split into deliveries and how a short pick
 * leaves the rest open. The database, the timeline and the screens follow them.
 */

export const DELIVERY_STATUSES = ['draft', 'released', 'picking', 'packed', 'ready', 'out_for_delivery', 'delivered', 'failed_attempt', 'returned', 'cancelled'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const isDeliveryStatus = (value: unknown): value is DeliveryStatus => typeof value === 'string' && (DELIVERY_STATUSES as readonly string[]).includes(value);

/** The ways of getting an order to the customer that have a delivery document (collecting has its own code; visits come later). */
export const DOCUMENT_METHODS = ['own_fleet', 'courier'] as const;
export type DocumentMethod = (typeof DOCUMENT_METHODS)[number];
export const isDocumentMethod = (value: unknown): value is DocumentMethod => typeof value === 'string' && (DOCUMENT_METHODS as readonly string[]).includes(value);

export const DELIVERY_ACTIONS = ['release', 'start_picking', 'record_picked', 'mark_packed', 'mark_ready', 'dispatch', 'deliver', 'fail_attempt', 'reattempt', 'return', 'cancel'] as const;
export type DeliveryAction = (typeof DELIVERY_ACTIONS)[number];

/** From each state, what can be done and where it leads. Nothing leaves delivered, returned or cancelled. */
const TRANSITIONS: Record<DeliveryStatus, Partial<Record<DeliveryAction, DeliveryStatus>>> = {
  draft: { release: 'released', cancel: 'cancelled' },
  released: { start_picking: 'picking', cancel: 'cancelled' },
  // Recording what was picked leaves the delivery picking until it is packed, so a count can be corrected.
  picking: { record_picked: 'picking', mark_packed: 'packed', cancel: 'cancelled' },
  packed: { mark_ready: 'ready', cancel: 'cancelled' },
  ready: { dispatch: 'out_for_delivery', cancel: 'cancelled' },
  out_for_delivery: { deliver: 'delivered', fail_attempt: 'failed_attempt' },
  failed_attempt: { reattempt: 'ready', return: 'returned' },
  delivered: {},
  returned: {},
  cancelled: {},
};

export const nextStatus = (status: DeliveryStatus, action: DeliveryAction): DeliveryStatus | null => TRANSITIONS[status][action] ?? null;
export const actionsFrom = (status: DeliveryStatus): DeliveryAction[] => (Object.keys(TRANSITIONS[status]) as DeliveryAction[]);
export const isOver = (status: DeliveryStatus): boolean => actionsFrom(status).length === 0;
/** A delivery that still has goods to bring: it counts against what the order has left to deliver. */
export const isLive = (status: DeliveryStatus): boolean => status !== 'cancelled' && status !== 'returned';

export const STATUS_WORDS: Record<DeliveryStatus, string> = {
  draft: 'Draft',
  released: 'Released',
  picking: 'Being picked',
  packed: 'Packed',
  ready: 'Ready to go',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  failed_attempt: 'Attempt failed',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

export const ACTION_WORDS: Record<DeliveryAction, string> = {
  release: 'Release for picking',
  start_picking: 'Start picking',
  record_picked: 'Record what was picked',
  mark_packed: 'Mark packed',
  mark_ready: 'Mark ready to go',
  dispatch: 'Send out',
  deliver: 'Mark delivered',
  fail_attempt: 'Record a failed attempt',
  reattempt: 'Try again',
  return: 'Return to stock',
  cancel: 'Cancel',
};

/** The reasons a delivery attempt can fail, as the person records them. The order of the list is the order on the screen. */
/** How many times a delivery is tried before it must be returned. */
export const MAX_DELIVERY_ATTEMPTS = 3;

export const FAILURE_REASONS = [
  { code: 'customer_absent', words: 'Nobody was there' },
  { code: 'refused', words: 'The customer refused it' },
  { code: 'wrong_address', words: 'Wrong or incomplete address' },
  { code: 'unreachable', words: 'The customer could not be reached' },
  { code: 'damaged', words: 'The goods were damaged' },
  { code: 'not_safe', words: 'It was not safe to deliver' },
  { code: 'other', words: 'Another reason (say which)' },
] as const;
export const isFailureReason = (value: unknown): boolean => typeof value === 'string' && FAILURE_REASONS.some((r) => r.code === value);

/** The stages an action puts on the order's timeline, in order. The service writes them in the same transaction as the change. */
export const STAGES_FOR: Record<DeliveryAction, readonly string[]> = {
  release: ['released_for_fulfilment'],
  start_picking: ['pick_started'],
  record_picked: ['picked'],
  mark_packed: ['packed'],
  mark_ready: ['ready'],
  dispatch: ['dispatched', 'out_for_delivery'],
  // `delivered` or `part_delivered`, depending on whether anything of the order is left: the service decides.
  deliver: [],
  fail_attempt: ['delivery_attempted'],
  reattempt: [],
  // The stage that says stock was put back (`returned_to_stock`) is written by the goods issue and return slice, when stock really moves.
  return: ['delivery_failed'],
  cancel: [],
};

export interface QuantityLine {
  productId: string;
  quantity: number;
}

const sum = (lines: readonly QuantityLine[]): Map<string, number> => {
  const total = new Map<string, number>();
  for (const l of lines) total.set(l.productId, roundQty((total.get(l.productId) ?? 0) + l.quantity));
  return total;
};

/** What the order has left to put on a delivery: what was ordered less what live deliveries already carry. */
export function openQuantities(ordered: readonly QuantityLine[], committed: readonly QuantityLine[]): QuantityLine[] {
  const have = sum(committed);
  return [...sum(ordered)].flatMap(([productId, quantity]) => {
    const open = roundQty(quantity - (have.get(productId) ?? 0));
    return open > 0 ? [{ productId, quantity: open }] : [];
  });
}

export type Allocation = { ok: true; lines: QuantityLine[] } | { ok: false; error: string };

/**
 * What a new delivery carries. With nothing asked for it carries everything the order has left; with a list, each quantity must be
 * positive and no more than is left of that product (whether it has the decimals its unit allows is the service's check). Never more than the order, however many deliveries.
 */
export function allocate(ordered: readonly QuantityLine[], committed: readonly QuantityLine[], requested: readonly QuantityLine[] | null): Allocation {
  const open = openQuantities(ordered, committed);
  if (open.length === 0) return { ok: false, error: 'There is nothing left on this order to deliver.' };
  if (requested === null || requested.length === 0) return { ok: true, lines: open };
  const left = new Map(open.map((l) => [l.productId, l.quantity]));
  const lines: QuantityLine[] = [];
  const seen = new Set<string>();
  for (const r of requested) {
    if (seen.has(r.productId)) return { ok: false, error: 'Each product can be on a delivery once.' };
    seen.add(r.productId);
    if (!Number.isFinite(r.quantity) || r.quantity <= 0) return { ok: false, error: 'Each quantity on a delivery must be more than nothing.' };
    const available = left.get(r.productId);
    if (available === undefined) return { ok: false, error: 'One of those products is not on this order, or all of it is already on a delivery.' };
    const quantity = roundQty(r.quantity);
    if (quantity > available) return { ok: false, error: `Only ${String(available)} is left to deliver of one of those products.` };
    lines.push({ productId: r.productId, quantity });
  }
  return { ok: true, lines };
}

export type PickCheck = { ok: true; picked: QuantityLine[]; short: QuantityLine[] } | { ok: false; error: string };

/**
 * What was picked against what was planned. A line may be picked short; the difference is left open on the order (a back-order),
 * to be put on another delivery or cancelled. Nothing can be picked that was not planned, and every planned line must be answered.
 */
export function checkPicked(planned: readonly QuantityLine[], picked: readonly QuantityLine[]): PickCheck {
  const asked = new Map<string, number>();
  for (const p of picked) {
    if (asked.has(p.productId)) return { ok: false, error: 'Each product can be counted once.' };
    if (!Number.isFinite(p.quantity) || p.quantity < 0) return { ok: false, error: 'A picked quantity cannot be less than nothing.' };
    asked.set(p.productId, roundQty(p.quantity));
  }
  const short: QuantityLine[] = [];
  const done: QuantityLine[] = [];
  for (const line of planned) {
    const got = asked.get(line.productId);
    if (got === undefined) return { ok: false, error: 'Say how much of every product was picked, even if it is none.' };
    if (got > line.quantity) return { ok: false, error: 'More was picked than the delivery carries.' };
    done.push({ productId: line.productId, quantity: got });
    if (got < line.quantity) short.push({ productId: line.productId, quantity: roundQty(line.quantity - got) });
  }
  for (const productId of asked.keys()) if (!planned.some((l) => l.productId === productId)) return { ok: false, error: 'Something was counted that is not on this delivery.' };
  if (done.every((l) => l.quantity === 0)) return { ok: false, error: 'Nothing was picked. Cancel the delivery instead.' };
  return { ok: true, picked: done, short };
}

export interface DeliveryFacts {
  status: DeliveryStatus;
  lines: readonly { productId: string; quantity: number; picked: number | null; delivered: number }[];
}

/** What a live delivery still carries: what was picked if it was counted, else what was planned. */
const carried = (l: DeliveryFacts['lines'][number]): number => l.picked ?? l.quantity;

export type OrderDeliveryState = 'not_started' | 'in_progress' | 'partly_delivered' | 'delivered' | 'exceptions';

export interface OrderDeliveryStatus {
  state: OrderDeliveryState;
  /** Per product: what was ordered, what is on live deliveries, what has been delivered and what is still open. */
  lines: { productId: string; ordered: number; committed: number; delivered: number; open: number }[];
}

export const ORDER_STATE_WORDS: Record<OrderDeliveryState, string> = {
  not_started: 'Not started',
  in_progress: 'On its way to being delivered',
  partly_delivered: 'Partly delivered',
  delivered: 'Delivered',
  exceptions: 'Needs attention',
};

/** The order's delivery status, computed from its deliveries and never stored: it cannot disagree with them. */
export function orderDeliveryStatus(ordered: readonly QuantityLine[], deliveries: readonly DeliveryFacts[]): OrderDeliveryStatus {
  const live = deliveries.filter((d) => isLive(d.status));
  const lines = [...sum(ordered)].map(([productId, quantity]) => {
    let committed = 0;
    let delivered = 0;
    for (const d of live) {
      for (const l of d.lines) {
        if (l.productId !== productId) continue;
        // A delivery that arrived commits only what the customer took: a part they did not take is open on the order again.
        committed = roundQty(committed + (d.status === 'delivered' ? l.delivered : carried(l)));
        delivered = roundQty(delivered + l.delivered);
      }
    }
    return { productId, ordered: quantity, committed, delivered, open: roundQty(quantity - committed) };
  });
  const allDelivered = lines.length > 0 && lines.every((l) => l.delivered >= l.ordered);
  const anyDelivered = lines.some((l) => l.delivered > 0);
  let state: OrderDeliveryState = 'not_started';
  if (allDelivered) state = 'delivered';
  else if (live.some((d) => d.status === 'failed_attempt')) state = 'exceptions';
  else if (anyDelivered) state = 'partly_delivered';
  else if (live.length > 0) state = 'in_progress';
  return { state, lines };
}
