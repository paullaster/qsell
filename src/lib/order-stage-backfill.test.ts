import { describe, expect, it } from 'vitest';
import { backfillEvents, type BackfillFacts } from './order-stage-backfill';

const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
const facts = (over: Partial<BackfillFacts> = {}): BackfillFacts => ({
  createdAt: t(8),
  updatedAt: t(20),
  status: 'pending',
  paymentStatus: 'unpaid',
  approvalStatus: 'none',
  kraTransmissionStatus: 'not_applicable',
  shippedAt: null,
  deliveredAt: null,
  paidAt: null,
  ...over,
});
const stages = (f: BackfillFacts) => backfillEvents(f).map((e) => e.stage);

describe('rebuilding the timeline of an order that is older than the timeline', () => {
  it('starts every order with when it was placed', () => {
    const events = backfillEvents(facts());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'order_placed', outcome: 'succeeded', occurredAt: t(8) });
  });

  it('uses the time it holds (the payment, the shipping, the delivery) and says when it does not know one', () => {
    const events = backfillEvents(facts({ status: 'delivered', paymentStatus: 'paid', paidAt: t(9), shippedAt: t(12), deliveredAt: t(15) }));
    expect(events.map((e) => [e.stage, e.occurredAt.getUTCHours()])).toEqual([['order_placed', 8], ['payment_confirmed', 9], ['dispatched', 12], ['delivered', 15]]);
    expect(events.every((e) => e.detail.backfilled === true)).toBe(true);
    expect(events.some((e) => e.detail.timeKnown === false)).toBe(false);
    const unknown = backfillEvents(facts({ status: 'processing', paymentStatus: 'paid' }));
    const paid = unknown.find((e) => e.stage === 'payment_confirmed');
    expect(paid?.occurredAt).toEqual(t(20));
    expect(paid?.detail.timeKnown).toBe(false);
  });

  it('does not let a time it does not know push a time it does know later', () => {
    const events = backfillEvents(facts({ status: 'shipped', paymentStatus: 'paid', shippedAt: t(12) }));
    expect(events.map((e) => [e.stage, e.occurredAt.getUTCHours()])).toEqual([['order_placed', 8], ['payment_confirmed', 12], ['dispatched', 12]]);
    expect(events[1]?.detail.timeKnown).toBe(false);
  });

  it('records a failed payment, a cancellation, a refund and a completed order as what they are', () => {
    expect(stages(facts({ status: 'failed', paymentStatus: 'failed' }))).toEqual(['order_placed', 'payment_failed']);
    expect(stages(facts({ status: 'cancelled' }))).toEqual(['order_placed', 'cancelled']);
    expect(stages(facts({ status: 'refunded', paymentStatus: 'refunded', paidAt: t(9) }))).toEqual(['order_placed', 'payment_confirmed', 'refunded']);
    expect(stages(facts({ status: 'completed', paymentStatus: 'reconciled', paidAt: t(9), deliveredAt: t(15) }))).toEqual(['order_placed', 'payment_confirmed', 'dispatched', 'delivered', 'completed']);
  });

  it('records the approval and the KRA outcome the order holds', () => {
    expect(stages(facts({ approvalStatus: 'approved', kraTransmissionStatus: 'transmitted' }))).toEqual(['order_placed', 'approval_requested', 'approval_approved', 'kra_signed']);
    expect(stages(facts({ approvalStatus: 'rejected', kraTransmissionStatus: 'failed' }))).toEqual(['order_placed', 'approval_requested', 'approval_rejected', 'kra_failed']);
  });

  it('never puts a stage before the one that came first, even when a held time is out of order', () => {
    const events = backfillEvents(facts({ status: 'delivered', paymentStatus: 'paid', paidAt: t(1), shippedAt: t(2), deliveredAt: t(3) }));
    const times = events.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[0]).toBe(t(8).getTime());
  });
});
