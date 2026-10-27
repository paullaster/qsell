import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, orderStageEvents, orders, paymentAttempts, type OrderRow } from '@/server/db/drizzle/schema';
import { currentContext } from '@/server/kernel/context';
import { backfillEvents } from '@/lib/order-stage-backfill';
import {
  STAGE_COLUMN_NAMES,
  STAGE_COLUMN_SQL,
  changesFor,
  moveProblem,
  stageEffect,
  type OrderStage,
  type StageChanges,
  type StageColumns,
  type StageEffect,
  type StageOutcome,
  type StageSource,
  type StageTimeColumn,
} from '@/lib/order-stages';

export type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface StageActor {
  type: 'user' | 'customer' | 'system' | 'job' | 'integration' | 'rider' | 'provider';
  id: string | null;
}

/** The order's other fields that may change in the same write as a stage (payment references, courier details, notes). Never the stage columns. */
export interface OrderFields {
  paymentMethod?: string;
  paymentMethodId?: string | null;
  paymentPhone?: string | null;
  transactionReference?: string | null;
  mpesaReceiptNumber?: string | null;
  pesapalTrackingId?: string | null;
  shippingCourier?: string | null;
  trackingNumber?: string | null;
  internalNotes?: string | null;
}

export interface MoveOptions {
  source?: StageSource;
  actor?: StageActor;
  reasonCode?: string;
  message?: string;
  /** The thing behind the stage (a payment attempt, a refund, an approval request). The same thing reaches the same stage once. */
  ref?: { type: string; id: string };
  attemptNo?: number;
  detail?: Record<string, unknown>;
  fields?: OrderFields;
  /** Columns to set beyond what the stage sets (a refund's resulting payment state, a cancellation that also fails the payment). */
  set?: Omit<StageEffect, 'stamps'>;
  /** Refuse the moves an order's approval state refuses (the administrator's status change). */
  checkHold?: boolean;
  clientTime?: Date;
  providerTime?: Date;
  backDated?: boolean;
}

export interface MoveResult {
  /** True when an event was written. False when the stage had already happened for this thing, or changed nothing. */
  recorded: boolean;
  order: OrderRow | null;
  event?: { id: number; sequence: number };
}

export class OrderMoveRefused extends Error {}

function sourceFromContext(): StageSource {
  const { actor } = currentContext();
  if (actor.type === 'job') return 'worker';
  if (actor.type === 'integration') return 'webhook';
  if (actor.type === 'user') return 'staff';
  return 'system';
}

function actorFromContext(): StageActor {
  const { actor } = currentContext();
  return { type: actor.type, id: actor.id };
}

const companyOfBranch = new Map<string, string | null>();

async function companyFor(tx: Tx, branchId: string | null): Promise<string | null> {
  if (branchId === null) return null;
  const known = companyOfBranch.get(branchId);
  if (known !== undefined) return known;
  const [row] = await tx.select({ companyId: branches.companyId }).from(branches).where(eq(branches.id, branchId)).limit(1);
  const companyId = row?.companyId ?? null;
  companyOfBranch.set(branchId, companyId);
  return companyId;
}

/** The changes as the events keep them: the database's column names, the same as the placement and the trigger write. */
function storedChanges(changes: StageChanges): Record<string, { from: string | null; to: string | null }> {
  const out: Record<string, { from: string | null; to: string | null }> = {};
  for (const column of STAGE_COLUMN_NAMES) {
    const change = changes[column];
    if (change !== undefined) out[STAGE_COLUMN_SQL[column]] = change;
  }
  return out;
}

const currentColumns = (row: OrderRow): StageColumns => ({
  status: row.status,
  paymentStatus: row.paymentStatus,
  approvalStatus: row.approvalStatus,
  kraTransmissionStatus: row.kraTransmissionStatus,
});

const stageTimes = (row: OrderRow): Record<StageTimeColumn, Date | null> => ({
  approvedAt: row.approvedAt,
  paymentStartedAt: row.paymentStartedAt,
  paidAt: row.paidAt,
  releasedAt: row.releasedAt,
  packedAt: row.packedAt,
  shippedAt: row.shippedAt,
  deliveredAt: row.deliveredAt,
  completedAt: row.completedAt,
  cancelledAt: row.cancelledAt,
  failedAt: row.failedAt,
  refundedAt: row.refundedAt,
});

/**
 * The one place an order's stage moves. Every change of `status`, `payment_status`, `approval_status` or
 * `kra_transmission_status`, every stage time and every event of the order's timeline is written here, in the caller's
 * transaction, under the order's row lock. A trigger on `orders` records and flags any change that goes round it.
 * Design: docs/architecture/order-stage-timeline.md.
 */
// A namespace of the writers of one thing, like the other domain services (eslint's no-extraneous-class does not suit it).
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class OrderStages {
  /** Moves an order in a transaction of its own. Use `moveIn` inside an existing one. */
  static async move(db: DrizzleDb, orderId: string, stage: OrderStage, outcome: StageOutcome, options: MoveOptions = {}): Promise<MoveResult> {
    return await db.transaction(async (tx) => await OrderStages.moveIn(tx, orderId, stage, outcome, options));
  }

  static async moveIn(tx: Tx, orderId: string, stage: OrderStage, outcome: StageOutcome, options: MoveOptions = {}): Promise<MoveResult> {
    let [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
    if (row === undefined) return { recorded: false, order: null };
    // An order that was made before the timeline existed gets its history rebuilt first, so its timeline is whole from the start.
    if (row.stageSeq === 0) row = await OrderStages.seedIn(tx, row);

    const effect: StageEffect = { ...stageEffect(stage, outcome), ...options.set };
    if (options.checkHold === true && effect.status !== undefined) {
      const problem = moveProblem(row, effect.status);
      if (problem !== null) throw new OrderMoveRefused(problem);
    }
    const changes = changesFor(currentColumns(row), effect);
    const times = stageTimes(row);
    const stamps = (stageEffect(stage, outcome).stamps ?? []).filter((column) => times[column] === null);
    const informational = Object.keys(stageEffect(stage, outcome)).length === 0 && options.set === undefined;

    let skip = false;
    if (options.ref !== undefined) {
      const [seen] = await tx
        .select({ id: orderStageEvents.id })
        .from(orderStageEvents)
        .where(
          and(
            eq(orderStageEvents.orderId, orderId),
            eq(orderStageEvents.stage, stage),
            eq(orderStageEvents.outcome, outcome),
            eq(orderStageEvents.refType, options.ref.type),
            eq(orderStageEvents.refId, options.ref.id),
          ),
        )
        .limit(1);
      skip = seen !== undefined;
    } else if (!informational && Object.keys(changes).length === 0 && stamps.length === 0) {
      skip = true;
    }
    if (skip) {
      // Nothing new happened to the stage. Whatever else came with it (a receipt number, courier details) is still saved.
      return { recorded: false, order: await OrderStages.saveFields(tx, row, options.fields) };
    }

    const set: Record<string, unknown> = {
      ...options.fields,
      stageSeq: sql`${orders.stageSeq} + 1`,
      currentStage: stage,
      currentStageSince: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    };
    for (const column of STAGE_COLUMN_NAMES) {
      const next = changes[column]?.to;
      if (next !== undefined && next !== null) set[column] = next;
    }
    for (const column of stamps) set[column] = sql`clock_timestamp()`;
    const [updated] = await tx.update(orders).set(set).where(eq(orders.id, orderId)).returning();
    if (updated === undefined) return { recorded: false, order: null };

    const ctx = currentContext();
    const actor = options.actor ?? actorFromContext();
    const [event] = await tx
      .insert(orderStageEvents)
      .values({
        companyId: await companyFor(tx, updated.branchId),
        orderId,
        sequence: updated.stageSeq,
        stage,
        outcome,
        fromStatus: changes.status?.from ?? null,
        toStatus: changes.status?.to ?? null,
        changes: storedChanges(changes),
        occurredAt: sql`clock_timestamp()`,
        recordedAt: sql`clock_timestamp()`,
        backDated: options.backDated ?? false,
        clientTime: options.clientTime ?? null,
        providerTime: options.providerTime ?? null,
        source: options.source ?? sourceFromContext(),
        actorType: actor.type,
        actorId: actor.id,
        reasonCode: options.reasonCode ?? null,
        message: options.message === undefined ? null : options.message.slice(0, 500),
        refType: options.ref?.type ?? null,
        refId: options.ref?.id ?? null,
        attemptNo: options.attemptNo ?? null,
        correlationId: ctx.correlationId,
        detail: options.detail ?? {},
      })
      .returning({ id: orderStageEvents.id, sequence: orderStageEvents.sequence });
    return { recorded: true, order: updated, event };
  }

  /** The non-stage fields of an order, saved on their own when a stage had nothing new to record. */
  private static async saveFields(tx: Tx, row: OrderRow, fields: OrderFields | undefined): Promise<OrderRow> {
    if (fields === undefined || Object.keys(fields).length === 0) return row;
    const [updated] = await tx.update(orders).set({ ...fields, updatedAt: sql`clock_timestamp()` }).where(eq(orders.id, row.id)).returning();
    return updated ?? row;
  }

  /**
   * Records that an order was placed, as the first event of its timeline, in the transaction that saved it. The order row itself is
   * written with `stage_seq = 1` and `current_stage = 'order_placed'`.
   */
  static async placedIn(
    tx: Tx,
    order: { id: string; status: string; paymentStatus: string; approvalStatus: string; kraTransmissionStatus: string; branchId: string | null },
    options: { source?: StageSource; actor?: StageActor; startedAt?: Date | null; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    const ctx = currentContext();
    const actor = options.actor ?? actorFromContext();
    await tx.insert(orderStageEvents).values({
      companyId: await companyFor(tx, order.branchId),
      orderId: order.id,
      sequence: 1,
      stage: 'order_placed',
      outcome: 'succeeded',
      changes: {
        status: { from: null, to: order.status },
        payment_status: { from: null, to: order.paymentStatus },
        approval_status: { from: null, to: order.approvalStatus },
        kra_transmission_status: { from: null, to: order.kraTransmissionStatus },
      },
      toStatus: order.status,
      occurredAt: sql`clock_timestamp()`,
      recordedAt: sql`clock_timestamp()`,
      source: options.source ?? sourceFromContext(),
      actorType: actor.type,
      actorId: actor.id,
      correlationId: ctx.correlationId,
      detail: { ...options.detail, ...(options.startedAt ? { checkoutStartedAt: options.startedAt.toISOString() } : {}) },
    });
  }

  /** Rebuilds the timeline of an order that existed before the timeline did. Idempotent: an order that has one is left alone. */
  static async seedIn(tx: Tx, locked: OrderRow): Promise<OrderRow> {
    if (locked.stageSeq !== 0) return locked;
    const [paid] = await tx
      .select({ at: sql<Date | null>`min(${paymentAttempts.paidAt})` })
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.orderId, locked.id), eq(paymentAttempts.status, 'successful')));
    const events = backfillEvents({
      createdAt: locked.createdAt,
      updatedAt: locked.updatedAt,
      status: locked.status,
      paymentStatus: locked.paymentStatus,
      approvalStatus: locked.approvalStatus,
      kraTransmissionStatus: locked.kraTransmissionStatus,
      shippedAt: locked.shippedAt,
      deliveredAt: locked.deliveredAt,
      paidAt: paid?.at ? new Date(paid.at) : null,
    });
    const companyId = await companyFor(tx, locked.branchId);
    await tx.insert(orderStageEvents).values(
      events.map((event, index) => ({
        companyId,
        orderId: locked.id,
        sequence: index + 1,
        stage: event.stage,
        outcome: event.outcome,
        changes: storedChanges(event.changes),
        occurredAt: event.occurredAt,
        source: 'migration',
        actorType: 'system',
        detail: event.detail,
        approximate: true,
      })),
    );
    const at = (stage: OrderStage): Date | null => events.find((event) => event.stage === stage)?.occurredAt ?? null;
    const lastEvent = events.at(-1);
    const [seeded] = await tx
      .update(orders)
      .set({
        stageSeq: events.length,
        currentStage: lastEvent?.stage ?? 'order_placed',
        currentStageSince: lastEvent?.occurredAt ?? locked.createdAt,
        approvedAt: locked.approvedAt ?? at('approval_approved'),
        paidAt: locked.paidAt ?? at('payment_confirmed'),
        completedAt: locked.completedAt ?? at('completed'),
        cancelledAt: locked.cancelledAt ?? at('cancelled'),
        failedAt: locked.failedAt ?? at('failed') ?? at('payment_failed'),
        refundedAt: locked.refundedAt ?? at('refunded'),
      })
      .where(eq(orders.id, locked.id))
      .returning();
    return seeded ?? locked;
  }

  /** Rebuilds the timelines of orders that have none, a batch at a time (the worker runs this until it finds nothing). Returns how many it did. */
  static async seedBatch(db: DrizzleDb, limit = 200): Promise<number> {
    const due = await db.select({ id: orders.id }).from(orders).where(eq(orders.stageSeq, 0)).orderBy(asc(orders.id)).limit(limit);
    let done = 0;
    for (const { id } of due) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(orders).where(and(eq(orders.id, id), eq(orders.stageSeq, 0))).for('update', { skipLocked: true }).limit(1);
        if (row !== undefined) {
          await OrderStages.seedIn(tx, row);
          done += 1;
        }
      });
    }
    return done;
  }

  /** The events of an order, in the order they happened. */
  static async timeline(db: DrizzleDb | Tx, orderId: string) {
    return await db.select().from(orderStageEvents).where(eq(orderStageEvents.orderId, orderId)).orderBy(asc(orderStageEvents.sequence));
  }

  /** How many orders are still waiting for their history to be rebuilt. */
  static async unseeded(db: DrizzleDb): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.stageSeq, 0));
    return row?.n ?? 0;
  }
}
