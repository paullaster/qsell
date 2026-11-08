import type { DeliveryCosts } from './costs';
import { DEFAULT_AT_RISK_MINUTES, slaState, type SlaState } from '@/lib/delivery-sla';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveries, deliveryLines, deliveryRunStops, deliveryRuns, deliveryShipments, orderItems, orders, products } from '@/server/db/drizzle/schema';
import { RUN_ACTION_WORDS, RUN_STATUS_WORDS, canJoinRun, isReordering, isRunEditable, nearestNext, nextRunStatus, runActionsFrom, runCloseProblem, runTotals, waitingSince, type RunAction, type RunStatus, type RunTotals } from '@/lib/dispatch-run';
import { STATUS_WORDS, type DeliveryStatus } from '@/lib/delivery-document';
import { readGeoPoint, type GeoPoint } from '@/lib/geo';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import type { DeliveryDocuments, DocActor, DocRefusal, DocResult } from './documents';
import type { DeliveryRiders } from './riders';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 25;

export interface RunStopView {
  deliveryId: string;
  sequence: number;
  deliveryNumber: string;
  orderNumber: string;
  customerName: string;
  area: string;
  status: DeliveryStatus;
  statusWords: string;
  units: number;
  value: number;
  weightKg: number | null;
}

export interface RunView {
  id: string;
  number: string;
  branch: { id: string; name: string };
  runDate: string;
  riderName: string;
  /** The rider's account row when the run is given to someone who uses the rider app; null for a name typed in. */
  riderId: string | null;
  vehicle: string | null;
  notes: string | null;
  status: RunStatus;
  statusWords: string;
  version: number;
  startedAt: string | null;
  closedAt: string | null;
  stops: RunStopView[];
  totals: RunTotals;
  editable: boolean;
  actions: { action: RunAction; words: string }[];
}

export interface RunListItem {
  id: string;
  number: string;
  runDate: string;
  riderName: string;
  branchName: string;
  status: RunStatus;
  statusWords: string;
  stops: number;
}

export interface ReadyDelivery {
  deliveryId: string;
  number: string;
  orderNumber: string;
  customerName: string;
  area: string;
  branchId: string;
  branchName: string;
  units: number;
  value: number;
  waiting: { hours: number; late: boolean } | null;
  /** The day someone asked for it to be tried again, after a failed attempt. */
  scheduledFor: string | null;
  /** The window the customer was promised and where it stands against it, when a slot was booked. */
  promised: { start: string; end: string; state: SlaState } | null;
}

export interface WithCourier {
  deliveryId: string;
  number: string;
  orderNumber: string;
  customerName: string;
  courierName: string;
  trackingNumber: string | null;
  status: string;
  lastNote: string | null;
  lastUpdateAt: string;
  /** What is wrong between us and the courier's system (a booking or cancellation that failed), or null. */
  problem: string | null;
}

export interface DispatchBoard {
  /** Ready to go and on no run, oldest first. Courier deliveries are not here: they are handed over, not carried. */
  ready: ReadyDelivery[];
  /** Runs still to do or on the road, soonest first. */
  runs: RunListItem[];
  /** Deliveries out with a courier. */
  withCouriers: WithCourier[];
}

/** The window a delivery was promised and where it stands against it now (at the default warning time: the board does not read the company's setting for every row). */
const promisedOf = (d: { windowStart: Date | null; windowEnd: Date | null; status: string; deliveredAt: Date | null }, now: Date): ReadyDelivery['promised'] => {
  const state = slaState({ windowStart: d.windowStart, windowEnd: d.windowEnd, status: d.status, deliveredAt: d.deliveredAt, now, atRiskMinutes: DEFAULT_AT_RISK_MINUTES });
  return d.windowStart === null || d.windowEnd === null || state === null ? null : { start: d.windowStart.toISOString(), end: d.windowEnd.toISOString(), state };
};

const areaOf = (destination: { address: { area?: string | null; town?: string | null } | null }): string => [destination.address?.area, destination.address?.town].filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(', ');

/**
 * Runs: a rider's trip with several ready deliveries, taken out together. A run is planned (deliveries put on it, taken off, put in
 * order), started (all its deliveries go out together, or none does) and closed once each has a result. Locked while it changes, with a
 * version for two people at once; every change is in the decision log. The deliveries themselves move through `DeliveryDocuments`, so
 * their history, the order's timeline and the stock are the same as for a delivery sent out on its own.
 */
export class DeliveryRuns {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly numbering: Pick<NumberSeriesService, 'assign'>,
    private readonly documents: Pick<DeliveryDocuments, 'dispatch'>,
    private readonly riders: Pick<DeliveryRiders, 'carrier'>,
    private readonly costs: Pick<DeliveryCosts, 'accrueDayIn' | 'accrueDeliveryIn'>,
  ) {}

  /** The rider a run is given to: someone from the rider list who may carry now (their name is kept on the run as it is today), or a name typed in. */
  private async riderFor(tx: Tx, companyId: string, input: { riderId?: unknown; riderName?: unknown }): Promise<DocResult<{ riderId: string | null; riderName: string }>> {
    if (typeof input.riderId === 'string' && input.riderId !== '') {
      const rider = await this.riders.carrier(tx, companyId, input.riderId);
      return rider === null ? fail('not_allowed', 'That rider cannot be given a run now: they are paused, have left, or their kind of rider is switched off.') : { ok: true, data: { riderId: rider.id, riderName: rider.name } };
    }
    const riderName = text(input.riderName, 120);
    return riderName === null ? fail('bad_input', 'Say who the rider is.') : { ok: true, data: { riderId: null, riderName } };
  }

  async create(actor: DocActor, input: { branchId?: unknown; runDate?: unknown; riderId?: unknown; riderName?: unknown; vehicle?: unknown; notes?: unknown }): Promise<DocResult<{ id: string; number: string }>> {
    const runDate = typeof input.runDate === 'string' && DATE.test(input.runDate) && !Number.isNaN(Date.parse(input.runDate)) ? input.runDate : null;
    if (runDate === null) return fail('bad_input', 'Choose the day of the run.');
    if (typeof input.branchId !== 'string' || input.branchId === '') return fail('bad_input', 'Choose the branch the run leaves from.');
    const branchId = input.branchId;
    return await this.db.transaction(async (tx): Promise<DocResult<{ id: string; number: string }>> => {
      const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.id, branchId), eq(branches.companyId, actor.companyId), eq(branches.isActive, true)));
      if (branch === undefined) return fail('not_found', 'That branch could not be found.');
      const who = await this.riderFor(tx, actor.companyId, input);
      if (!who.ok) return who;
      const { riderId, riderName } = who.data;
      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('delivery_run', { companyId: actor.companyId, date: businessDate(), document: { kind: 'delivery_run', id } }, tx);
      await tx.insert(deliveryRuns).values({ id, companyId: actor.companyId, number, branchId, runDate, riderName, riderId, vehicle: text(input.vehicle, 80), notes: text(input.notes, 300), createdBy: actor.userId });
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_run', id }, action: 'run.created', actor: { type: 'user', id: actor.userId }, to: 'planned', reason: { text: `${riderName}, ${runDate}` } }, tx);
      return { ok: true, data: { id, number } };
    });
  }

  /** Gives a run that has not gone out to another rider (from the list, or a name typed in). */
  async assignRider(actor: DocActor, runId: string, input: { riderId?: unknown; riderName?: unknown }, expectedVersion?: number): Promise<DocResult<RunView>> {
    return await this.db.transaction(async (tx): Promise<DocResult<RunView>> => {
      const run = await this.editable(tx, actor, runId, expectedVersion);
      if ('ok' in run) return run;
      const who = await this.riderFor(tx, actor.companyId, input);
      if (!who.ok) return who;
      await tx.update(deliveryRuns).set({ riderId: who.data.riderId, riderName: who.data.riderName, version: run.version + 1, updatedAt: new Date() }).where(eq(deliveryRuns.id, runId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_run', id: runId }, action: 'run.rider_changed', actor: { type: 'user', id: actor.userId }, reason: { text: `${run.riderName} to ${who.data.riderName}` } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, runId) };
    });
  }

  /** Locks a run and checks the version and that it can still be edited. */
  private async editable(tx: Tx, actor: DocActor, runId: string, expectedVersion?: number) {
    const [run] = await tx.select().from(deliveryRuns).where(and(eq(deliveryRuns.id, runId), eq(deliveryRuns.companyId, actor.companyId))).for('update');
    if (run === undefined) return fail('not_found', 'That run could not be found.');
    if (expectedVersion !== undefined && expectedVersion !== run.version) return fail('conflict', 'Someone else changed this run while you were looking. Reload it to see their change.');
    if (!isRunEditable(run.status)) return fail('not_allowed', 'A run that has gone out, or is finished, cannot be changed.');
    return run;
  }

  private async liveStops(tx: Tx | DrizzleDb, runId: string) {
    return await tx.select().from(deliveryRunStops).where(and(eq(deliveryRunStops.runId, runId), isNull(deliveryRunStops.leftAt))).orderBy(asc(deliveryRunStops.sequence));
  }

  async addStop(actor: DocActor, runId: string, deliveryId: string, expectedVersion?: number): Promise<DocResult<RunView>> {
    return await this.db.transaction(async (tx): Promise<DocResult<RunView>> => {
      const run = await this.editable(tx, actor, runId, expectedVersion);
      if ('ok' in run) return run;
      const [d] = await tx.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
      if (d === undefined) return fail('not_found', 'That delivery could not be found.');
      if (d.method !== 'own_fleet') return fail('wrong_method', 'A courier delivery is handed to the courier, not carried on a run.');
      const live = await this.liveStops(tx, runId);
      const [elsewhere] = await tx.select({ id: deliveryRunStops.id }).from(deliveryRunStops).where(and(eq(deliveryRunStops.deliveryId, deliveryId), isNull(deliveryRunStops.leftAt)));
      if (!canJoinRun(d.status, elsewhere !== undefined)) return fail('not_allowed', elsewhere === undefined ? 'Only a delivery that is ready to go can be put on a run.' : 'That delivery is already on a run.');
      if (d.branchId !== run.branchId) return fail('not_allowed', 'That delivery leaves from another branch, so it cannot go on this run.');
      await tx.insert(deliveryRunStops).values({ runId, deliveryId, sequence: live.length + 1, addedBy: actor.userId });
      await tx.update(deliveryRuns).set({ version: run.version + 1, updatedAt: new Date() }).where(eq(deliveryRuns.id, runId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_run', id: runId }, action: 'run.stop_added', actor: { type: 'user', id: actor.userId }, reason: { text: d.number } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, runId) };
    });
  }

  async removeStop(actor: DocActor, runId: string, deliveryId: string, expectedVersion?: number): Promise<DocResult<RunView>> {
    return await this.db.transaction(async (tx): Promise<DocResult<RunView>> => {
      const run = await this.editable(tx, actor, runId, expectedVersion);
      if ('ok' in run) return run;
      const live = await this.liveStops(tx, runId);
      const stop = live.find((s) => s.deliveryId === deliveryId);
      if (stop === undefined) return fail('not_found', 'That delivery is not on this run.');
      await tx.update(deliveryRunStops).set({ leftAt: new Date(), leftReason: 'taken off the run' }).where(eq(deliveryRunStops.id, stop.id));
      await this.renumber(tx, live.filter((s) => s.id !== stop.id).map((s) => s.id));
      await tx.update(deliveryRuns).set({ version: run.version + 1, updatedAt: new Date() }).where(eq(deliveryRuns.id, runId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_run', id: runId }, action: 'run.stop_removed', actor: { type: 'user', id: actor.userId }, reason: { text: deliveryId } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, runId) };
    });
  }

  private async renumber(tx: Tx, stopIds: string[]): Promise<void> {
    for (const [i, id] of stopIds.entries()) await tx.update(deliveryRunStops).set({ sequence: i + 1 }).where(eq(deliveryRunStops.id, id));
  }

  /** Puts the stops in the order given (delivery ids): exactly the stops of the run, each once. */
  async reorder(actor: DocActor, runId: string, deliveryIds: unknown, expectedVersion?: number): Promise<DocResult<RunView>> {
    if (!Array.isArray(deliveryIds) || deliveryIds.some((d) => typeof d !== 'string')) return fail('bad_input', 'Give the stops in the order they should be done.');
    const wanted = deliveryIds as string[];
    return await this.db.transaction(async (tx): Promise<DocResult<RunView>> => {
      const run = await this.editable(tx, actor, runId, expectedVersion);
      if ('ok' in run) return run;
      const live = await this.liveStops(tx, runId);
      if (!isReordering(live.map((s) => s.deliveryId), wanted)) return fail('bad_input', 'The order must have every delivery of the run, once each.');
      const byDelivery = new Map(live.map((s) => [s.deliveryId, s.id]));
      await this.renumber(tx, wanted.map((d) => byDelivery.get(d) ?? ''));
      await tx.update(deliveryRuns).set({ version: run.version + 1, updatedAt: new Date() }).where(eq(deliveryRuns.id, runId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_run', id: runId }, action: 'run.reordered', actor: { type: 'user', id: actor.userId } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, runId) };
    });
  }

  /** Puts the stops in the suggested order: nearest next from the branch. A person can still change it. */
  async arrange(actor: DocActor, runId: string, expectedVersion?: number): Promise<DocResult<RunView>> {
    const view = await this.get(actor.companyId, runId);
    if (view === null) return fail('not_found', 'That run could not be found.');
    const pins = await this.pinsOf(actor.companyId, runId, view.branch.id);
    const order = nearestNext(pins.start, pins.stops);
    return await this.reorder(actor, runId, order, expectedVersion);
  }

  private async pinsOf(companyId: string, runId: string, branchId: string): Promise<{ start: GeoPoint | null; stops: { id: string; point: GeoPoint | null }[] }> {
    const [branch] = await this.db.select({ latitude: branches.latitude, longitude: branches.longitude }).from(branches).where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)));
    const read = branch === undefined ? null : readGeoPoint(branch.latitude, branch.longitude);
    const start = read?.ok === true ? read.point : null;
    const rows = await this.db
      .select({ deliveryId: deliveryRunStops.deliveryId, destination: deliveries.destination })
      .from(deliveryRunStops)
      .innerJoin(deliveries, eq(deliveries.id, deliveryRunStops.deliveryId))
      .where(and(eq(deliveryRunStops.runId, runId), isNull(deliveryRunStops.leftAt)))
      .orderBy(asc(deliveryRunStops.sequence));
    return { start, stops: rows.map((r) => ({ id: r.deliveryId, point: r.destination.pin })) };
  }

  /**
   * Sends the run out: every delivery on it goes out together, in one transaction, so that a run does not leave half-started. If one
   * is refused (its order is unpaid, say) none goes and the message names it, to be taken off the run or put right.
   */
  async start(actor: DocActor, runId: string, expectedVersion?: number): Promise<DocResult<RunView>> {
    return await this.db.transaction(async (tx): Promise<DocResult<RunView>> => {
      const run = await this.editable(tx, actor, runId, expectedVersion);
      if ('ok' in run) return run;
      if (nextRunStatus(run.status, 'start') === null) return fail('not_allowed', 'This run cannot be started.');
      const live = await this.liveStops(tx, runId);
      if (live.length === 0) return fail('not_allowed', 'Put at least one delivery on the run before it goes out.');
      for (const stop of live) {
        const sent = await this.documents.dispatch(actor, stop.deliveryId, { note: `On run ${run.number} with ${run.riderName}`, detail: { run: run.number, rider: run.riderName } }, undefined, tx);
        if (!sent.ok) {
          const [d] = await tx.select({ number: deliveries.number }).from(deliveries).where(eq(deliveries.id, stop.deliveryId));
          // Throwing rolls the whole transaction back: nothing of the run has gone out.
          throw new RunRefusal(fail(sent.reason, `${d?.number ?? 'A delivery'}: ${sent.message} Take it off the run, or put it right, then start the run.`));
        }
      }
      await tx.update(deliveryRuns).set({ status: 'started', startedAt: new Date(), version: run.version + 1, updatedAt: new Date() }).where(eq(deliveryRuns.id, runId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_run', id: runId }, action: 'run.started', actor: { type: 'user', id: actor.userId }, from: 'planned', to: 'started', reason: { text: `${String(live.length)} deliveries with ${run.riderName}` } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, runId) };
    }).catch((error: unknown) => {
      if (error instanceof RunRefusal) return error.result;
      throw error;
    });
  }

  /** Closes a run once every delivery on it has a result. Deliveries that did not get through leave the run, to be sent again or returned. */
  async complete(actor: DocActor, runId: string, expectedVersion?: number): Promise<DocResult<RunView>> {
    return await this.db.transaction(async (tx): Promise<DocResult<RunView>> => {
      const [run] = await tx.select().from(deliveryRuns).where(and(eq(deliveryRuns.id, runId), eq(deliveryRuns.companyId, actor.companyId))).for('update');
      if (run === undefined) return fail('not_found', 'That run could not be found.');
      if (expectedVersion !== undefined && expectedVersion !== run.version) return fail('conflict', 'Someone else changed this run while you were looking. Reload it to see their change.');
      if (nextRunStatus(run.status, 'complete') === null) return fail('not_allowed', 'Only a run that is on the road can be closed.');
      const live = await this.liveStops(tx, runId);
      const states = await this.statusesOf(tx, live.map((s) => s.deliveryId));
      const problem = runCloseProblem(live.map((s) => ({ deliveryStatus: states.get(s.deliveryId) ?? '' })));
      if (problem !== null) return fail('not_allowed', problem);
      for (const s of live) {
        if (states.get(s.deliveryId) !== 'delivered') await tx.update(deliveryRunStops).set({ leftAt: new Date(), leftReason: 'did not get through' }).where(eq(deliveryRunStops.id, s.id));
      }
      await tx.update(deliveryRuns).set({ status: 'completed', closedAt: new Date(), version: run.version + 1, updatedAt: new Date() }).where(eq(deliveryRuns.id, runId));
      const delivered = live.filter((s) => states.get(s.deliveryId) === 'delivered').length;
      // A day on a run earns the rider's day pay once, when something was delivered on it.
      // A stop the office delivered on the rider's behalf still earned the rider the pay for a delivery (the same key, so nothing is counted twice).
      if (run.riderId !== null) {
        for (const s of live) if (states.get(s.deliveryId) === 'delivered') await this.costs.accrueDeliveryIn(tx, { companyId: actor.companyId, deliveryId: s.deliveryId, runId, riderId: run.riderId, actorId: actor.userId });
      }
      await this.costs.accrueDayIn(tx, { companyId: actor.companyId, runId, riderId: run.riderId, runDate: run.runDate, delivered, actorId: actor.userId });
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_run', id: runId }, action: 'run.completed', actor: { type: 'user', id: actor.userId }, from: 'started', to: 'completed', reason: { text: `${String(delivered)} of ${String(live.length)} delivered` } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, runId) };
    });
  }

  async cancel(actor: DocActor, runId: string, input: { reason?: unknown }, expectedVersion?: number): Promise<DocResult<RunView>> {
    const reason = text(input.reason, 300);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why the run is being cancelled, in a few words.');
    return await this.db.transaction(async (tx): Promise<DocResult<RunView>> => {
      const run = await this.editable(tx, actor, runId, expectedVersion);
      if ('ok' in run) return run;
      await tx.update(deliveryRunStops).set({ leftAt: new Date(), leftReason: 'the run was cancelled' }).where(and(eq(deliveryRunStops.runId, runId), isNull(deliveryRunStops.leftAt)));
      await tx.update(deliveryRuns).set({ status: 'cancelled', closedAt: new Date(), version: run.version + 1, updatedAt: new Date() }).where(eq(deliveryRuns.id, runId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_run', id: runId }, action: 'run.cancelled', actor: { type: 'user', id: actor.userId }, from: 'planned', to: 'cancelled', reason: { text: reason } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, runId) };
    });
  }

  private async statusesOf(db: Tx | DrizzleDb, ids: string[]): Promise<Map<string, DeliveryStatus>> {
    if (ids.length === 0) return new Map();
    const rows = await db.select({ id: deliveries.id, status: deliveries.status }).from(deliveries).where(inArray(deliveries.id, ids));
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  async get(companyId: string, runId: string): Promise<RunView | null> {
    return await this.viewIn(this.db, companyId, runId, true);
  }

  private async viewIn(db: Tx | DrizzleDb, companyId: string, runId: string): Promise<RunView>;
  private async viewIn(db: Tx | DrizzleDb, companyId: string, runId: string, nullable: true): Promise<RunView | null>;
  private async viewIn(db: Tx | DrizzleDb, companyId: string, runId: string, nullable = false): Promise<RunView | null> {
    const [row] = await db
      .select({ r: deliveryRuns, branchName: branches.name })
      .from(deliveryRuns)
      .innerJoin(branches, eq(branches.id, deliveryRuns.branchId))
      .where(and(eq(deliveryRuns.id, runId), eq(deliveryRuns.companyId, companyId)));
    if (row === undefined) {
      if (nullable) return null;
      throw new Error(`The run ${runId} vanished while it was locked.`);
    }
    const stops = await this.stopViews(db, runId);
    const r = row.r;
    return {
      id: r.id,
      number: r.number,
      branch: { id: r.branchId, name: row.branchName },
      runDate: r.runDate,
      riderName: r.riderName,
      riderId: r.riderId,
      vehicle: r.vehicle,
      notes: r.notes,
      status: r.status,
      statusWords: RUN_STATUS_WORDS[r.status],
      version: r.version,
      startedAt: r.startedAt?.toISOString() ?? null,
      closedAt: r.closedAt?.toISOString() ?? null,
      stops,
      totals: runTotals(stops.map((s) => ({ units: s.units, value: s.value, weightKg: s.weightKg }))),
      editable: isRunEditable(r.status),
      actions: runActionsFrom(r.status).map((action) => ({ action, words: RUN_ACTION_WORDS[action] })),
    };
  }

  /** The stops still on the run, with what each carries and is worth: one read for all of them. */
  private async stopViews(db: Tx | DrizzleDb, runId: string): Promise<RunStopView[]> {
    const rows = await db
      .select({ sequence: deliveryRunStops.sequence, d: deliveries, orderNumber: orders.orderNumber, customerName: orders.customerName })
      .from(deliveryRunStops)
      .innerJoin(deliveries, eq(deliveries.id, deliveryRunStops.deliveryId))
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .where(and(eq(deliveryRunStops.runId, runId), isNull(deliveryRunStops.leftAt)))
      .orderBy(asc(deliveryRunStops.sequence));
    const facts = await this.loadFacts(db, rows.map((r) => ({ deliveryId: r.d.id, orderId: r.d.orderId })));
    return rows.map((r) => ({
      deliveryId: r.d.id,
      sequence: r.sequence,
      deliveryNumber: r.d.number,
      orderNumber: r.orderNumber,
      customerName: r.customerName,
      area: areaOf(r.d.destination),
      status: r.d.status,
      statusWords: STATUS_WORDS[r.d.status],
      units: facts.get(r.d.id)?.units ?? 0,
      value: facts.get(r.d.id)?.value ?? 0,
      weightKg: facts.get(r.d.id)?.weightKg ?? null,
    }));
  }

  /** Units, worth (at the order's own prices) and weight of what each delivery carries. Two reads for any number of deliveries. */
  private async loadFacts(db: Tx | DrizzleDb, pairs: { deliveryId: string; orderId: string }[]): Promise<Map<string, { units: number; value: number; weightKg: number | null }>> {
    const out = new Map<string, { units: number; value: number; weightKg: number | null }>();
    if (pairs.length === 0) return out;
    const lines = await db
      .select({ deliveryId: deliveryLines.deliveryId, productId: deliveryLines.productId, quantity: deliveryLines.quantity, picked: deliveryLines.picked, weight: products.weight })
      .from(deliveryLines)
      .innerJoin(products, eq(products.id, deliveryLines.productId))
      .where(inArray(deliveryLines.deliveryId, pairs.map((p) => p.deliveryId)));
    const items = await db.select({ orderId: orderItems.orderId, productId: orderItems.productId, unitPrice: orderItems.unitPrice }).from(orderItems).where(inArray(orderItems.orderId, [...new Set(pairs.map((p) => p.orderId))]));
    const price = new Map(items.map((i) => [`${i.orderId}|${i.productId}`, Number(i.unitPrice)]));
    const orderOf = new Map(pairs.map((p) => [p.deliveryId, p.orderId]));
    for (const l of lines) {
      const q = Number(l.picked ?? l.quantity);
      const cur = out.get(l.deliveryId) ?? { units: 0, value: 0, weightKg: null };
      cur.units = Math.round((cur.units + q) * 1000) / 1000;
      cur.value = Math.round((cur.value + q * (price.get(`${orderOf.get(l.deliveryId) ?? ''}|${l.productId}`) ?? 0)) * 100) / 100;
      if (l.weight !== null) cur.weightKg = Math.round(((cur.weightKg ?? 0) + q * Number(l.weight)) * 1000) / 1000;
      out.set(l.deliveryId, cur);
    }
    return out;
  }

  /** The run a delivery is on now (or last got through on), for its own screen. */
  async runOf(companyId: string, deliveryId: string): Promise<{ id: string; number: string; riderName: string; status: RunStatus } | null> {
    const [r] = await this.db
      .select({ id: deliveryRuns.id, number: deliveryRuns.number, riderName: deliveryRuns.riderName, status: deliveryRuns.status })
      .from(deliveryRunStops)
      .innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryRunStops.runId))
      .where(and(eq(deliveryRunStops.deliveryId, deliveryId), eq(deliveryRuns.companyId, companyId)))
      .orderBy(desc(deliveryRunStops.addedAt))
      .limit(1);
    return r ?? null;
  }

  /** One page of runs, newest day first, by state. */
  async list(companyId: string, input: { status?: unknown; cursor?: unknown }): Promise<{ rows: RunListItem[]; nextCursor: string | null }> {
    const status = typeof input.status === 'string' && input.status !== '' ? input.status : null;
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const rows = await this.db
      .select({ r: deliveryRuns, branchName: branches.name, createdAtText: sql<string>`${deliveryRuns.createdAt}::text` })
      .from(deliveryRuns)
      .innerJoin(branches, eq(branches.id, deliveryRuns.branchId))
      .where(and(eq(deliveryRuns.companyId, companyId), status === null ? undefined : eq(deliveryRuns.status, status as RunStatus), after === null ? undefined : sql`(${deliveryRuns.createdAt}, ${deliveryRuns.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`))
      .orderBy(desc(deliveryRuns.createdAt), desc(deliveryRuns.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    const counts = await this.stopCounts(page.map((p) => p.r.id));
    const last = page[page.length - 1];
    return {
      rows: page.map((p) => ({ id: p.r.id, number: p.r.number, runDate: p.r.runDate, riderName: p.r.riderName, branchName: p.branchName, status: p.r.status, statusWords: RUN_STATUS_WORDS[p.r.status], stops: counts.get(p.r.id) ?? 0 })),
      nextCursor: rows.length > PAGE && last !== undefined ? encodeCursor({ k: last.createdAtText, id: last.r.id }) : null,
    };
  }

  private async stopCounts(runIds: string[]): Promise<Map<string, number>> {
    if (runIds.length === 0) return new Map();
    const rows = await this.db.select({ runId: deliveryRunStops.runId, n: sql<number>`count(*)::int` }).from(deliveryRunStops).where(and(inArray(deliveryRunStops.runId, runIds), isNull(deliveryRunStops.leftAt))).groupBy(deliveryRunStops.runId);
    return new Map(rows.map((r) => [r.runId, r.n]));
  }

  /** The dispatch board: what is ready and on no run, the runs still to do, and what is out with couriers. Three reads, however much there is. */
  async board(companyId: string, input: { branchId?: unknown }, now: Date): Promise<DispatchBoard> {
    const branchId = typeof input.branchId === 'string' && input.branchId !== '' ? input.branchId : null;
    const [ready, open, couriers] = await Promise.all([
      this.db
        .select({ d: deliveries, branchName: branches.name, orderNumber: orders.orderNumber, customerName: orders.customerName })
        .from(deliveries)
        .innerJoin(branches, eq(branches.id, deliveries.branchId))
        .innerJoin(orders, eq(orders.id, deliveries.orderId))
        .where(and(eq(deliveries.companyId, companyId), eq(deliveries.status, 'ready'), eq(deliveries.method, 'own_fleet'), branchId === null ? undefined : eq(deliveries.branchId, branchId), sql`NOT EXISTS (SELECT 1 FROM delivery_run_stops s WHERE s.delivery_id = ${deliveries.id} AND s.left_at IS NULL)`))
        .orderBy(asc(deliveries.readyAt), asc(deliveries.id))
        .limit(200),
      this.db
        .select({ r: deliveryRuns, branchName: branches.name })
        .from(deliveryRuns)
        .innerJoin(branches, eq(branches.id, deliveryRuns.branchId))
        .where(and(eq(deliveryRuns.companyId, companyId), inArray(deliveryRuns.status, ['planned', 'started']), branchId === null ? undefined : eq(deliveryRuns.branchId, branchId)))
        .orderBy(asc(deliveryRuns.runDate), asc(deliveryRuns.createdAt))
        .limit(100),
      this.db
        .select({ s: deliveryShipments, d: deliveries, orderNumber: orders.orderNumber, customerName: orders.customerName })
        .from(deliveryShipments)
        .innerJoin(deliveries, eq(deliveries.id, deliveryShipments.deliveryId))
        .innerJoin(orders, eq(orders.id, deliveries.orderId))
        .where(and(eq(deliveryShipments.companyId, companyId), eq(deliveries.status, 'out_for_delivery'), branchId === null ? undefined : eq(deliveries.branchId, branchId)))
        .orderBy(asc(deliveryShipments.lastUpdateAt))
        .limit(100),
    ]);
    const [facts, counts] = await Promise.all([this.loadFacts(this.db, ready.map((r) => ({ deliveryId: r.d.id, orderId: r.d.orderId }))), this.stopCounts(open.map((o) => o.r.id))]);
    return {
      ready: ready.map((r) => ({ deliveryId: r.d.id, number: r.d.number, orderNumber: r.orderNumber, customerName: r.customerName, area: areaOf(r.d.destination), branchId: r.d.branchId, branchName: r.branchName, units: facts.get(r.d.id)?.units ?? 0, value: facts.get(r.d.id)?.value ?? 0, waiting: waitingSince(r.d.readyAt, now), scheduledFor: r.d.scheduledFor, promised: promisedOf(r.d, now) })),
      runs: open.map((o) => ({ id: o.r.id, number: o.r.number, runDate: o.r.runDate, riderName: o.r.riderName, branchName: o.branchName, status: o.r.status, statusWords: RUN_STATUS_WORDS[o.r.status], stops: counts.get(o.r.id) ?? 0 })),
      withCouriers: couriers.map((c) => ({ deliveryId: c.d.id, number: c.d.number, orderNumber: c.orderNumber, customerName: c.customerName, courierName: c.s.courierName, trackingNumber: c.s.trackingNumber, status: c.s.status, lastNote: c.s.lastNote, lastUpdateAt: c.s.lastUpdateAt.toISOString(), problem: c.s.syncState === 'book_failed' || c.s.syncState === 'cancel_failed' ? (c.s.syncError ?? 'The courier could not be reached.') : null })),
    };
  }
}

/** Carries a refusal out of a transaction that must be rolled back. */
class RunRefusal extends Error {
  constructor(readonly result: { ok: false; reason: DocRefusal; message: string }) {
    super(result.message);
  }
}
