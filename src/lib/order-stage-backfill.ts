import type { OrderStage, StageChanges, StageOutcome } from '@/lib/order-stages';

/**
 * The timeline of an order that existed before the timeline did, rebuilt from what the order itself held: when it was made, the
 * time of the payment that confirmed it, when it was shipped and delivered, and when it last changed. Every event is marked
 * approximate. Nothing is invented where no time is known: a stage whose time is not held takes the order's last-changed time
 * and says so in its detail.
 */

export interface BackfillFacts {
  createdAt: Date;
  updatedAt: Date;
  status: string;
  paymentStatus: string;
  approvalStatus: string | null;
  kraTransmissionStatus: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  /** When a payment attempt confirmed it, if one did. */
  paidAt: Date | null;
}

export interface BackfilledEvent {
  stage: OrderStage;
  outcome: StageOutcome;
  occurredAt: Date;
  changes: StageChanges;
  detail: Record<string, unknown>;
}

const PAID_STATES = ['paid', 'reconciled', 'refunded', 'partially_refunded'];

export function backfillEvents(facts: BackfillFacts): BackfilledEvent[] {
  const events: BackfilledEvent[] = [];
  const unknown = { timeKnown: false };
  const placed = facts.createdAt;
  const last = facts.updatedAt.getTime() >= placed.getTime() ? facts.updatedAt : placed;
  const atLeast = (time: Date | null): Date => (time !== null && time.getTime() >= placed.getTime() ? time : last);

  events.push({
    stage: 'order_placed',
    outcome: 'succeeded',
    occurredAt: placed,
    changes: {},
    detail: { backfilled: true },
  });
  if (facts.approvalStatus !== null && facts.approvalStatus !== 'none') {
    events.push({ stage: 'approval_requested', outcome: 'entered', occurredAt: placed, changes: {}, detail: { backfilled: true, ...unknown } });
    if (facts.approvalStatus === 'approved') events.push({ stage: 'approval_approved', outcome: 'succeeded', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
    else if (facts.approvalStatus === 'rejected') events.push({ stage: 'approval_rejected', outcome: 'failed', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
  }
  if (PAID_STATES.includes(facts.paymentStatus)) {
    events.push({
      stage: 'payment_confirmed',
      outcome: 'succeeded',
      occurredAt: atLeast(facts.paidAt),
      changes: {},
      detail: { backfilled: true, ...(facts.paidAt === null ? unknown : {}) },
    });
  } else if (facts.paymentStatus === 'failed') {
    events.push({ stage: 'payment_failed', outcome: 'failed', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
  }
  if (facts.shippedAt !== null || ['shipped', 'delivered', 'completed'].includes(facts.status)) {
    events.push({ stage: 'dispatched', outcome: 'succeeded', occurredAt: atLeast(facts.shippedAt), changes: {}, detail: { backfilled: true, ...(facts.shippedAt === null ? unknown : {}) } });
  }
  if (facts.deliveredAt !== null || ['delivered', 'completed'].includes(facts.status)) {
    events.push({ stage: 'delivered', outcome: 'succeeded', occurredAt: atLeast(facts.deliveredAt), changes: {}, detail: { backfilled: true, ...(facts.deliveredAt === null ? unknown : {}) } });
  }
  switch (facts.status) {
    case 'completed':
      events.push({ stage: 'completed', outcome: 'succeeded', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
      break;
    case 'cancelled':
      events.push({ stage: 'cancelled', outcome: 'cancelled', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
      break;
    case 'failed':
      if (!events.some((e) => e.stage === 'payment_failed')) events.push({ stage: 'failed', outcome: 'failed', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
      break;
    case 'refunded':
      events.push({ stage: 'refunded', outcome: 'succeeded', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
      break;
    case 'processing':
      if (!events.some((e) => e.stage === 'payment_confirmed')) events.push({ stage: 'released_for_fulfilment', outcome: 'succeeded', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
      break;
    default:
      break;
  }
  if (facts.kraTransmissionStatus === 'transmitted') events.push({ stage: 'kra_signed', outcome: 'succeeded', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });
  else if (facts.kraTransmissionStatus === 'failed') events.push({ stage: 'kra_failed', outcome: 'failed', occurredAt: last, changes: {}, detail: { backfilled: true, ...unknown } });

  // A stage whose time is not held cannot be later than a later stage whose time is: it is capped by the next known time.
  const times = events.map((event) => event.occurredAt.getTime());
  let ceiling = Number.POSITIVE_INFINITY;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.detail.timeKnown === false) times[i] = Math.min(times[i] ?? 0, ceiling);
    else ceiling = Math.min(ceiling, times[i] ?? 0);
  }
  // And never out of order: a later stage is not before an earlier one.
  let previous = placed.getTime();
  return events.map((event, i) => {
    const time = Math.max(times[i] ?? 0, previous);
    previous = time;
    return { ...event, occurredAt: new Date(time) };
  });
}
