import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_REFUSALS,
  ORDER_STAGES,
  ORDER_STAGE_NAMES,
  STAGE_OUTCOMES,
  STAGE_PHASES,
  STUCK_RULES,
  changesFor,
  customerTimeline,
  isOrderStage,
  moveProblem,
  stageEffect,
  stageForKra,
  stageForStatus,
  type OrderStage,
} from './order-stages';
import type { OrderStatus } from '@/types/index';

const ALL_STATUSES: OrderStatus[] = ['pending', 'processing', 'shipped', 'delivered', 'completed', 'failed', 'cancelled', 'refunded'];

describe('the stage catalogue', () => {
  it('names every stage once, with a phase and plain words', () => {
    expect(new Set(ORDER_STAGE_NAMES).size).toBe(ORDER_STAGE_NAMES.length);
    for (const name of ORDER_STAGE_NAMES) {
      const def = ORDER_STAGES[name];
      expect(STAGE_PHASES, name).toContain(def.phase);
      expect(def.label.length, name).toBeGreaterThan(2);
    }
    expect(isOrderStage('payment_confirmed')).toBe(true);
    expect(isOrderStage('toString')).toBe(false);
  });

  it('is exactly the list the database accepts (migration 0106), so the two cannot drift', () => {
    const sql = readFileSync('drizzle/0106_order_stage_timeline.sql', 'utf8');
    const inDb = /order_stage_events_stage_chk" CHECK \("stage" IN \(([^)]*)\)\)/.exec(sql)?.[1]?.split(',').map((s) => s.trim().replaceAll("'", '')) ?? [];
    expect([...inDb].sort()).toEqual([...ORDER_STAGE_NAMES].sort());
    const outcomes = /order_stage_events_outcome_chk" CHECK \("order_stage_events"."outcome" IN \(([^)]*)\)\)/.exec(sql)?.[1]?.split(',').map((s) => s.trim().replaceAll("'", '')) ?? [];
    expect([...outcomes].sort()).toEqual([...STAGE_OUTCOMES].sort());
  });

  it('lists a reason for every way a checkout can be refused', () => {
    expect(CHECKOUT_REFUSALS).toEqual(expect.arrayContaining(['quantity_limit', 'stock_short', 'rate_limited', 'invalid_input', 'credit_limit']));
  });

  it('has stuck-order rules only for real stages', () => {
    for (const rule of STUCK_RULES) expect(isOrderStage(rule.stage), rule.stage).toBe(true);
  });
});

describe('what a stage does to the order (the one table of transitions)', () => {
  it('moves the payment and the order together when a payment is confirmed, and stamps when it happened', () => {
    expect(stageEffect('payment_confirmed', 'succeeded')).toEqual({ paymentStatus: 'paid', status: 'processing', stamps: ['paidAt', 'releasedAt'] });
  });

  it('records a payment that could not be started without changing the order, which is still waiting for a payment', () => {
    expect(stageEffect('payment_started', 'failed')).toEqual({});
    expect(stageEffect('payment_started', 'entered')).toEqual({ paymentStatus: 'pending_verification', stamps: ['paymentStartedAt'] });
  });

  it('fails the payment and the order when a payment fails', () => {
    expect(stageEffect('payment_failed', 'failed')).toEqual({ paymentStatus: 'failed', status: 'failed', stamps: ['failedAt'] });
  });

  it('keeps the approval column in step with the approval stages', () => {
    const approval = (stage: OrderStage, outcome: 'entered' | 'succeeded' | 'failed' | 'cancelled') => stageEffect(stage, outcome).approvalStatus;
    expect(approval('approval_requested', 'entered')).toBe('pending');
    expect(approval('approval_approved', 'succeeded')).toBe('approved');
    expect(approval('approval_rejected', 'failed')).toBe('rejected');
    expect(approval('approval_reopened', 'entered')).toBe('draft');
    expect(approval('approval_withdrawn', 'cancelled')).toBe('draft');
  });

  it('keeps the KRA column in step with the KRA stages', () => {
    expect(stageEffect('kra_signed', 'succeeded').kraTransmissionStatus).toBe('transmitted');
    expect(stageEffect('kra_failed', 'failed').kraTransmissionStatus).toBe('failed');
    expect(stageEffect('kra_submitted', 'entered').kraTransmissionStatus).toBe('pending');
    expect(stageEffect('kra_submitted', 'skipped').kraTransmissionStatus).toBe('skipped');
  });

  it('changes nothing for stages that are facts (a prompt sent, an attempt at the door, a checkout refused)', () => {
    for (const stage of ['prompt_sent', 'delivery_attempted', 'checkout_refused', 'stock_reserved', 'invoice_issued'] as const) {
      expect(stageEffect(stage, 'entered'), stage).toEqual({});
    }
  });

  it('gives every status an administrator can choose a stage that leads to exactly that status', () => {
    for (const status of ALL_STATUSES) {
      const { stage, outcome } = stageForStatus(status);
      const effect = stageEffect(stage, outcome);
      if (status === 'pending') {
        // Back to pending is a correction: it names the status itself when it is applied.
        expect(stage).toBe('status_corrected');
      } else {
        expect(effect.status, status).toBe(status);
      }
    }
  });

  it('maps every KRA status the signing service reports', () => {
    expect(stageForKra('transmitted')).toEqual({ stage: 'kra_signed', outcome: 'succeeded' });
    expect(stageForKra('failed')).toEqual({ stage: 'kra_failed', outcome: 'failed' });
    expect(stageForKra('skipped')).toEqual({ stage: 'kra_submitted', outcome: 'skipped' });
    expect(stageForKra('pending')).toEqual({ stage: 'kra_submitted', outcome: 'entered' });
  });

  it('lists only the columns that would really change', () => {
    const now = { status: 'pending', paymentStatus: 'unpaid', approvalStatus: 'none', kraTransmissionStatus: 'not_applicable' };
    expect(changesFor(now, stageEffect('payment_confirmed', 'succeeded'))).toEqual({
      status: { from: 'pending', to: 'processing' },
      paymentStatus: { from: 'unpaid', to: 'paid' },
    });
    expect(changesFor({ ...now, status: 'processing', paymentStatus: 'paid' }, stageEffect('payment_confirmed', 'succeeded'))).toEqual({});
  });
});

describe('the rules for moving an order by hand', () => {
  it('lets an order with no approval hold move, and refuses a second cancellation', () => {
    expect(moveProblem({ status: 'pending', approvalStatus: 'none' }, 'shipped')).toBeNull();
    expect(moveProblem({ status: 'pending', approvalStatus: 'approved' }, 'processing')).toBeNull();
    expect(moveProblem({ status: 'cancelled', approvalStatus: 'none' }, 'cancelled')).toBe('Order is already cancelled');
  });

  it('holds an order that waits for approval or was refused, but always lets it be cancelled', () => {
    expect(moveProblem({ status: 'pending', approvalStatus: 'pending' }, 'shipped')).toContain('waiting for approval');
    expect(moveProblem({ status: 'pending', approvalStatus: 'rejected' }, 'shipped')).toContain('Approval for this order was refused');
    expect(moveProblem({ status: 'pending', approvalStatus: 'draft' }, 'processing')).toContain('Reopen it');
    expect(moveProblem({ status: 'pending', approvalStatus: 'pending' }, 'cancelled')).toBeNull();
  });
});

describe('what a customer is shown', () => {
  it('is a few plain stages with their times, once each, and never a failure or a staff-only stage', () => {
    const events = [
      { stage: 'order_placed', outcome: 'succeeded', occurredAt: '2026-01-01T10:00:00Z' },
      { stage: 'checkout_refused', outcome: 'failed', occurredAt: '2026-01-01T10:01:00Z' },
      { stage: 'payment_failed', outcome: 'failed', occurredAt: '2026-01-01T10:02:00Z' },
      { stage: 'payment_confirmed', outcome: 'succeeded', occurredAt: '2026-01-01T10:05:00Z' },
      { stage: 'payment_confirmed', outcome: 'succeeded', occurredAt: '2026-01-01T10:06:00Z' },
      { stage: 'approval_approved', outcome: 'succeeded', occurredAt: '2026-01-01T10:07:00Z' },
      { stage: 'dispatched', outcome: 'succeeded', occurredAt: '2026-01-01T11:00:00Z' },
    ];
    expect(customerTimeline(events)).toEqual([
      { stage: 'order_placed', label: 'Order placed', at: '2026-01-01T10:00:00.000Z' },
      { stage: 'payment_confirmed', label: 'Payment received', at: '2026-01-01T10:05:00.000Z' },
      { stage: 'dispatched', label: 'On its way', at: '2026-01-01T11:00:00.000Z' },
    ]);
  });
});
