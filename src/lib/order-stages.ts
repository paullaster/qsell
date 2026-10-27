import type { OrderStatus } from '@/types/index';

/**
 * Every stage an order goes through, and what each does to the order. This is the one place that says which stages exist, what a
 * stage changes (the order's status, payment status, approval status, KRA status, and which stage time is stamped), what a person
 * is told about it, and which moves are refused. Nothing else decides an order's stage.
 * Design: docs/architecture/order-stage-timeline.md.
 */

export const STAGE_OUTCOMES = ['entered', 'succeeded', 'failed', 'skipped', 'cancelled'] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export const STAGE_PHASES = ['initiation', 'placement', 'stock', 'approval', 'payment', 'fulfilment', 'billing', 'closure'] as const;
export type StagePhase = (typeof STAGE_PHASES)[number];

/** The order's stage times that the writer keeps beside the events (`shippedAt` and `deliveredAt` are part of the set). */
export const STAGE_TIME_COLUMNS = [
  'approvedAt',
  'paymentStartedAt',
  'paidAt',
  'releasedAt',
  'packedAt',
  'shippedAt',
  'deliveredAt',
  'completedAt',
  'cancelledAt',
  'failedAt',
  'refundedAt',
] as const;
export type StageTimeColumn = (typeof STAGE_TIME_COLUMNS)[number];

/** The four order columns that hold a stage. Only the stage writer changes them. */
export interface StageColumns {
  status: string;
  paymentStatus: string;
  approvalStatus: string;
  kraTransmissionStatus: string;
}
export const STAGE_COLUMN_NAMES = ['status', 'paymentStatus', 'approvalStatus', 'kraTransmissionStatus'] as const satisfies readonly (keyof StageColumns)[];
/** The same columns as the database and the events call them. */
export const STAGE_COLUMN_SQL: Record<keyof StageColumns, string> = {
  status: 'status',
  paymentStatus: 'payment_status',
  approvalStatus: 'approval_status',
  kraTransmissionStatus: 'kra_transmission_status',
};

export interface StageDef {
  phase: StagePhase;
  /** For staff: what happened, in plain words. */
  label: string;
  /** For the customer's timeline; absent means staff-only. */
  customerLabel?: string;
}

export const ORDER_STAGES = {
  // Initiation
  checkout_started: { phase: 'initiation', label: 'Checkout started' },
  checkout_validated: { phase: 'initiation', label: 'Checkout checked' },
  checkout_refused: { phase: 'initiation', label: 'Checkout refused' },
  // Placement
  order_placed: { phase: 'placement', label: 'Order placed', customerLabel: 'Order placed' },
  charge_quoted: { phase: 'placement', label: 'Delivery charge quoted' },
  pricing_applied: { phase: 'placement', label: 'Prices applied' },
  // Stock
  stock_reserved: { phase: 'stock', label: 'Stock reserved' },
  reservation_failed: { phase: 'stock', label: 'Stock could not be reserved' },
  stock_issued: { phase: 'stock', label: 'Stock issued' },
  stock_released: { phase: 'stock', label: 'Stock released' },
  stock_returned: { phase: 'stock', label: 'Stock returned' },
  // Approval
  approval_requested: { phase: 'approval', label: 'Approval requested' },
  approval_approved: { phase: 'approval', label: 'Approved' },
  approval_rejected: { phase: 'approval', label: 'Approval refused' },
  approval_escalated: { phase: 'approval', label: 'Approval escalated' },
  approval_reopened: { phase: 'approval', label: 'Approval reopened' },
  approval_withdrawn: { phase: 'approval', label: 'Approval withdrawn' },
  // Payment
  payment_started: { phase: 'payment', label: 'Payment started' },
  prompt_sent: { phase: 'payment', label: 'Payment prompt sent' },
  payment_pending_verification: { phase: 'payment', label: 'Payment waiting to be confirmed' },
  payment_confirmed: { phase: 'payment', label: 'Payment confirmed', customerLabel: 'Payment received' },
  payment_failed: { phase: 'payment', label: 'Payment failed' },
  payment_expired: { phase: 'payment', label: 'Payment expired' },
  payment_retried: { phase: 'payment', label: 'Payment tried again' },
  payment_reconciled: { phase: 'payment', label: 'Payment reconciled' },
  payment_discrepancy: { phase: 'payment', label: 'Payment discrepancy found' },
  refund_requested: { phase: 'payment', label: 'Refund requested' },
  refund_completed: { phase: 'payment', label: 'Refund paid', customerLabel: 'Refund paid' },
  refund_failed: { phase: 'payment', label: 'Refund did not go through' },
  // Fulfilment
  released_for_fulfilment: { phase: 'fulfilment', label: 'Released for fulfilment' },
  blocked: { phase: 'fulfilment', label: 'Held' },
  unblocked: { phase: 'fulfilment', label: 'Released from hold' },
  pick_started: { phase: 'fulfilment', label: 'Picking started' },
  picked: { phase: 'fulfilment', label: 'Picked' },
  packed: { phase: 'fulfilment', label: 'Packed', customerLabel: 'Packed' },
  ready: { phase: 'fulfilment', label: 'Ready' },
  dispatched: { phase: 'fulfilment', label: 'Dispatched', customerLabel: 'On its way' },
  out_for_delivery: { phase: 'fulfilment', label: 'Out for delivery', customerLabel: 'Out for delivery' },
  delivery_attempted: { phase: 'fulfilment', label: 'Delivery attempted' },
  delivered: { phase: 'fulfilment', label: 'Delivered', customerLabel: 'Delivered' },
  delivery_failed: { phase: 'fulfilment', label: 'Delivery failed' },
  returned_to_stock: { phase: 'fulfilment', label: 'Returned to stock' },
  collected: { phase: 'fulfilment', label: 'Collected', customerLabel: 'Collected' },
  // Billing and compliance
  invoice_issued: { phase: 'billing', label: 'Invoice issued' },
  kra_submitted: { phase: 'billing', label: 'Sent to KRA' },
  kra_signed: { phase: 'billing', label: 'Signed by KRA' },
  kra_failed: { phase: 'billing', label: 'KRA did not accept it' },
  credit_note_issued: { phase: 'billing', label: 'Credit note issued' },
  // Closure
  completed: { phase: 'closure', label: 'Completed' },
  cancelled: { phase: 'closure', label: 'Cancelled', customerLabel: 'Cancelled' },
  failed: { phase: 'closure', label: 'Failed' },
  refunded: { phase: 'closure', label: 'Refunded', customerLabel: 'Refunded' },
  // A status set by hand to something no specific stage describes (for example back to pending), and a change that went round the writer.
  status_corrected: { phase: 'closure', label: 'Status corrected' },
  unrecorded_change: { phase: 'closure', label: 'Changed without being recorded' },
} as const satisfies Record<string, StageDef>;

export type OrderStage = keyof typeof ORDER_STAGES;
export const ORDER_STAGE_NAMES = Object.keys(ORDER_STAGES) as OrderStage[];
export const isOrderStage = (value: string): value is OrderStage => Object.prototype.hasOwnProperty.call(ORDER_STAGES, value);

export const STAGE_SOURCES = ['shop', 'staff', 'pos', 'webhook', 'rider_app', 'worker', 'system', 'migration', 'trigger'] as const;
export type StageSource = (typeof STAGE_SOURCES)[number];

/** The reasons a checkout is refused before there is an order. */
export const CHECKOUT_REFUSALS = [
  'invalid_input',
  'rate_limited',
  'quantity_limit',
  'invalid_quantity',
  'stock_short',
  'not_for_sale',
  'not_found',
  'cannot_be_priced',
  'coupon_refused',
  'credit_limit',
  'approval_needed',
  'kit_error',
  'other',
] as const;
export type CheckoutRefusal = (typeof CHECKOUT_REFUSALS)[number];

/** What a stage does to the order's columns and stage times. `skip` leaves the column as it is. */
export interface StageEffect {
  status?: OrderStatus;
  paymentStatus?: string;
  approvalStatus?: string;
  kraTransmissionStatus?: string;
  stamps?: readonly StageTimeColumn[];
}

const NONE: StageEffect = {};

type EffectOf = StageEffect | ((outcome: StageOutcome) => StageEffect);

/** The columns each stage sets. Everything the order's status can do is in this table; a stage that is not here is a fact and changes nothing. */
const EFFECTS: Partial<Record<OrderStage, EffectOf>> = {
  approval_requested: { approvalStatus: 'pending' },
  approval_approved: { approvalStatus: 'approved', stamps: ['approvedAt'] },
  approval_rejected: { approvalStatus: 'rejected' },
  approval_reopened: { approvalStatus: 'draft' },
  approval_withdrawn: { approvalStatus: 'draft' },
  // A payment that could not even be started is on the timeline but changes nothing: the order is still waiting for a payment.
  payment_started: (outcome) => (outcome === 'failed' ? NONE : { paymentStatus: 'pending_verification', stamps: ['paymentStartedAt'] }),
  payment_failed: { paymentStatus: 'failed', status: 'failed', stamps: ['failedAt'] },
  payment_confirmed: { paymentStatus: 'paid', status: 'processing', stamps: ['paidAt', 'releasedAt'] },
  payment_reconciled: { paymentStatus: 'reconciled' },
  released_for_fulfilment: { status: 'processing', stamps: ['releasedAt'] },
  packed: { stamps: ['packedAt'] },
  dispatched: { status: 'shipped', stamps: ['shippedAt'] },
  delivered: { status: 'delivered', stamps: ['deliveredAt'] },
  collected: { status: 'delivered', stamps: ['deliveredAt'] },
  completed: { status: 'completed', stamps: ['deliveredAt', 'completedAt'] },
  cancelled: { status: 'cancelled', stamps: ['cancelledAt'] },
  failed: { status: 'failed', stamps: ['failedAt'] },
  refunded: { status: 'refunded', stamps: ['refundedAt'] },
  kra_submitted: (outcome) => ({ kraTransmissionStatus: outcome === 'skipped' ? 'skipped' : 'pending' }),
  kra_signed: { kraTransmissionStatus: 'transmitted' },
  kra_failed: { kraTransmissionStatus: 'failed' },
};

/** What a stage does to the order's columns and stage times. */
export function stageEffect(stage: OrderStage, outcome: StageOutcome): StageEffect {
  const effect = EFFECTS[stage];
  if (effect === undefined) return NONE;
  return typeof effect === 'function' ? effect(outcome) : effect;
}

/** The stage that describes an administrator moving an order to a status. */
export function stageForStatus(target: OrderStatus): { stage: OrderStage; outcome: StageOutcome } {
  switch (target) {
    case 'processing':
      return { stage: 'released_for_fulfilment', outcome: 'succeeded' };
    case 'shipped':
      return { stage: 'dispatched', outcome: 'succeeded' };
    case 'delivered':
      return { stage: 'delivered', outcome: 'succeeded' };
    case 'completed':
      return { stage: 'completed', outcome: 'succeeded' };
    case 'cancelled':
      return { stage: 'cancelled', outcome: 'cancelled' };
    case 'failed':
      return { stage: 'failed', outcome: 'failed' };
    case 'refunded':
      return { stage: 'refunded', outcome: 'succeeded' };
    case 'pending':
      return { stage: 'status_corrected', outcome: 'succeeded' };
  }
}

/** The stage that mirrors a KRA transmission status the signing service reports. */
export function stageForKra(status: string): { stage: OrderStage; outcome: StageOutcome } {
  switch (status) {
    case 'transmitted':
      return { stage: 'kra_signed', outcome: 'succeeded' };
    case 'failed':
      return { stage: 'kra_failed', outcome: 'failed' };
    case 'skipped':
      return { stage: 'kra_submitted', outcome: 'skipped' };
    default:
      return { stage: 'kra_submitted', outcome: 'entered' };
  }
}

/** The order's current columns, as far as the move rules need them. */
export interface MoveFacts {
  status: string;
  approvalStatus: string | null;
}

/**
 * Why an administrator may not move an order to this status, in words; null when it may. An order waiting for approval, or refused,
 * cannot move along (it can still be cancelled), and an order already cancelled cannot be cancelled again.
 */
export function moveProblem(order: MoveFacts, next: OrderStatus): string | null {
  if (next === 'cancelled') return order.status === 'cancelled' ? 'Order is already cancelled' : null;
  const held = order.approvalStatus;
  if (held === 'pending') return 'This order is waiting for approval. It can move on once it is approved.';
  if (held === 'rejected' || held === 'draft') {
    return 'Approval for this order was refused. Reopen it and send it for approval again, or cancel it.';
  }
  return null;
}

/** The payment states a refund may leave an order in. */
export const REFUND_PAYMENT_STATES = ['refunded', 'partially_refunded'] as const;

export interface StageChange {
  from: string | null;
  to: string | null;
}
export type StageChanges = Partial<Record<keyof typeof STAGE_COLUMN_SQL, StageChange>>;

/** The columns this effect would change, given what the order holds now. Empty when it would change nothing. */
export function changesFor(current: StageColumns, effect: StageEffect): StageChanges {
  const out: StageChanges = {};
  for (const column of STAGE_COLUMN_NAMES) {
    const next = effect[column];
    if (next !== undefined && next !== current[column]) out[column] = { from: current[column], to: next };
  }
  return out;
}

/** The stages a customer is shown, in the words they are shown, from a list of events. Staff-only stages and failures' reasons are left out. */
export function customerTimeline(
  events: readonly { stage: string; outcome: string; occurredAt: Date | string }[],
): { stage: OrderStage; label: string; at: string }[] {
  const out: { stage: OrderStage; label: string; at: string }[] = [];
  for (const event of events) {
    if (!isOrderStage(event.stage) || event.outcome === 'failed') continue;
    const def: StageDef = ORDER_STAGES[event.stage];
    const label = def.customerLabel;
    if (label === undefined) continue;
    if (out.some((item) => item.stage === event.stage)) continue;
    out.push({ stage: event.stage, label, at: new Date(event.occurredAt).toISOString() });
  }
  return out;
}

/** Orders held in a stage longer than this are "stuck" on the operations view. Defaults until the per-stage targets of the next slice replace them. */
export const STUCK_RULES: readonly { stage: OrderStage; olderThanMinutes: number; label: string }[] = [
  { stage: 'payment_started', olderThanMinutes: 30, label: 'Payment not confirmed' },
  { stage: 'approval_requested', olderThanMinutes: 24 * 60, label: 'Waiting for approval' },
  { stage: 'payment_confirmed', olderThanMinutes: 24 * 60, label: 'Paid but not dispatched' },
  { stage: 'released_for_fulfilment', olderThanMinutes: 24 * 60, label: 'Released but not dispatched' },
  { stage: 'dispatched', olderThanMinutes: 72 * 60, label: 'On its way for three days' },
];
