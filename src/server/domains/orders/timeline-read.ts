import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { checkoutAttempts, orderStageEvents, orders } from '@/server/db/drizzle/schema';
import { ORDER_STAGES, STUCK_RULES, customerTimeline, isOrderStage } from '@/lib/order-stages';
import { effectiveTargets, type StageTarget } from '@/lib/order-sla';

/** One event of an order's timeline as a screen shows it. The staff-only parts are present only for someone allowed to see them. */
export interface TimelineEventView {
  sequence: number;
  stage: string;
  label: string;
  outcome: string;
  at: string;
  /** Milliseconds since the previous event; null for the first. */
  sincePreviousMs: number | null;
  approximate: boolean;
  statusFrom: string | null;
  statusTo: string | null;
  /** Staff-only. */
  detail?: {
    changes: Record<string, { from: string | null; to: string | null }>;
    source: string;
    actorType: string;
    actorId: string | null;
    reasonCode: string | null;
    message: string | null;
    refType: string | null;
    refId: string | null;
    attemptNo: number | null;
    clientTime: string | null;
    providerTime: string | null;
    backDated: boolean;
    data: Record<string, unknown>;
  };
}

export interface OrderTimelineView {
  orderId: string;
  currentStage: string | null;
  currentStageSince: string | null;
  events: TimelineEventView[];
  /** Whether the staff-only parts are included. */
  detailed: boolean;
}

export async function orderTimeline(db: DrizzleDb, orderId: string, detailed: boolean): Promise<OrderTimelineView | null> {
  const [order] = await db.select({ id: orders.id, currentStage: orders.currentStage, since: orders.currentStageSince }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order === undefined) return null;
  const rows = await db.select().from(orderStageEvents).where(eq(orderStageEvents.orderId, orderId)).orderBy(asc(orderStageEvents.sequence));
  const events = rows.map((row, index): TimelineEventView => {
    const before = rows[index - 1];
    return {
      sequence: row.sequence,
      stage: row.stage,
      label: isOrderStage(row.stage) ? ORDER_STAGES[row.stage].label : row.stage,
      outcome: row.outcome,
      at: row.occurredAt.toISOString(),
      sincePreviousMs: before === undefined ? null : row.occurredAt.getTime() - before.occurredAt.getTime(),
      approximate: row.approximate,
      statusFrom: row.fromStatus,
      statusTo: row.toStatus,
      ...(detailed
        ? {
            detail: {
              changes: row.changes,
              source: row.source,
              actorType: row.actorType,
              actorId: row.actorId,
              reasonCode: row.reasonCode,
              message: row.message,
              refType: row.refType,
              refId: row.refId,
              attemptNo: row.attemptNo,
              clientTime: row.clientTime?.toISOString() ?? null,
              providerTime: row.providerTime?.toISOString() ?? null,
              backDated: row.backDated,
              data: row.detail,
            },
          }
        : {}),
    };
  });
  return { orderId, currentStage: order.currentStage, currentStageSince: order.since?.toISOString() ?? null, events, detailed };
}

/** What the customer is shown of their own order: a few plain stages with their times, nothing else. */
export async function customerOrderTimeline(db: DrizzleDb, orderId: string): Promise<{ label: string; at: string }[]> {
  const rows = await db
    .select({ stage: orderStageEvents.stage, outcome: orderStageEvents.outcome, occurredAt: orderStageEvents.occurredAt })
    .from(orderStageEvents)
    .where(eq(orderStageEvents.orderId, orderId))
    .orderBy(asc(orderStageEvents.sequence));
  return customerTimeline(rows).map(({ label, at }) => ({ label, at }));
}

export interface OrderFlow {
  days: number;
  checkouts: { started: number; refused: number; placed: number; abandoned: number };
  refusals: { reason: string; count: number }[];
  /** How many orders reached each milestone in the period. */
  milestones: { stage: string; label: string; count: number }[];
  failures: { stage: string; label: string; reason: string; count: number }[];
  stuck: { orderId: string; orderNumber: string; stage: string; label: string; since: string }[];
  /** Changes of an order's stage that went round the stage writer. Should always be zero. */
  unrecorded: number;
}

const MILESTONES = ['order_placed', 'payment_confirmed', 'dispatched', 'delivered', 'completed'] as const;

/** The funnel, the failures and the stuck orders over the last `days` days. The numbers come from events and attempts, with keyset-free aggregates over an indexed time range. */
export async function orderFlow(db: DrizzleDb, days = 7, now = new Date(), targets: readonly StageTarget[] = effectiveTargets([])): Promise<OrderFlow> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const attempts = await db
    .select({ outcome: checkoutAttempts.outcome, n: sql<number>`count(*)::int` })
    .from(checkoutAttempts)
    .where(gte(checkoutAttempts.startedAt, since))
    .groupBy(checkoutAttempts.outcome);
  const count = (outcome: string) => attempts.find((row) => row.outcome === outcome)?.n ?? 0;
  const refusals = await db
    .select({ reason: sql<string>`coalesce(${checkoutAttempts.reasonCode}, 'other')`, n: sql<number>`count(*)::int` })
    .from(checkoutAttempts)
    .where(and(gte(checkoutAttempts.startedAt, since), eq(checkoutAttempts.outcome, 'refused')))
    .groupBy(sql`coalesce(${checkoutAttempts.reasonCode}, 'other')`)
    .orderBy(desc(sql`count(*)`));
  const milestones = await db
    .select({ stage: orderStageEvents.stage, n: sql<number>`count(distinct ${orderStageEvents.orderId})::int` })
    .from(orderStageEvents)
    .where(and(gte(orderStageEvents.occurredAt, since), eq(orderStageEvents.approximate, false), inArray(orderStageEvents.stage, [...MILESTONES])))
    .groupBy(orderStageEvents.stage);
  const failures = await db
    .select({ stage: orderStageEvents.stage, reason: sql<string>`coalesce(${orderStageEvents.reasonCode}, 'unspecified')`, n: sql<number>`count(*)::int` })
    .from(orderStageEvents)
    .where(and(gte(orderStageEvents.occurredAt, since), eq(orderStageEvents.outcome, 'failed')))
    .groupBy(orderStageEvents.stage, sql`coalesce(${orderStageEvents.reasonCode}, 'unspecified')`)
    .orderBy(desc(sql`count(*)`))
    .limit(20);
  const watched = targets.filter((target) => target.enabled);
  const stuckRows =
    watched.length === 0
      ? []
      : await db
          .select({ id: orders.id, number: orders.orderNumber, stage: orders.currentStage, since: orders.currentStageSince })
          .from(orders)
          .where(
            or(
              ...watched.map((target) =>
                and(eq(orders.currentStage, target.stage), lt(orders.currentStageSince, new Date(now.getTime() - target.targetMinutes * 60_000))),
              ),
            ),
          )
          .orderBy(asc(orders.currentStageSince))
          .limit(50);
  const [unrecorded] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orderStageEvents)
    .where(and(eq(orderStageEvents.source, 'trigger'), gte(orderStageEvents.occurredAt, new Date(now.getTime() - 30 * 86_400_000))));
  return {
    days,
    checkouts: { started: count('started'), refused: count('refused'), placed: count('placed'), abandoned: count('abandoned_after_payment_start') },
    refusals: refusals.map((row) => ({ reason: row.reason, count: row.n })),
    milestones: MILESTONES.map((stage) => ({ stage, label: ORDER_STAGES[stage].label, count: milestones.find((row) => row.stage === stage)?.n ?? 0 })),
    failures: failures.flatMap((row) => (isOrderStage(row.stage) ? [{ stage: row.stage, label: ORDER_STAGES[row.stage].label, reason: row.reason, count: row.n }] : [])),
    stuck: stuckRows.flatMap((row) =>
      row.stage === null || row.since === null || !isOrderStage(row.stage)
        ? []
        : [{ orderId: row.id, orderNumber: row.number, stage: row.stage, label: STUCK_RULES.find((rule) => rule.stage === row.stage)?.label ?? ORDER_STAGES[row.stage].label, since: row.since.toISOString() }],
    ),
    unrecorded: unrecorded?.n ?? 0,
  };
}
