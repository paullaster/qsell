import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, orders, deliveryAttemptLines, deliveryAttempts, deliveryLines, deliveryProofs, deliveryRiderSettings, deliveryRunStops, deliveryRuns, mediaAssets } from '@/server/db/drizzle/schema';
import { checkAcceptance, type AcceptedLine } from '@/lib/delivery-acceptance';
import { FAILURE_REASONS, STATUS_WORDS, type DeliveryStatus } from '@/lib/delivery-document';
import { MAX_CODE_TRIES, codesMatch, isClientKey, isProofRule, normaliseCode, placeFrom, proofProblem, proofsKept, ruleFor, usableClientTime, type ProofRule } from '@/lib/delivery-proof';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DeliveryDocuments, DocActor, DocRefusal, DocResult } from './documents';
import { collectedProblem } from '@/lib/door-payment';
import type { DeliveryCosts } from './costs';
import type { DoorPayments } from './door-payments';
import type { DeliveryRuns } from './runs';
import type { RiderSelf } from './riders';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = 'That stop could not be found on your run.';

/** Where the photos a rider takes at a door are kept. Private: a signed, expiring link is given only after an access check. */
export const PROOF_PURPOSE = 'delivery_proof';

/** Undoes the whole try: money that cannot be taken must not leave the delivery marked delivered. */
class DoorRollback extends Error {
  constructor(readonly refusal: { ok: false; reason: DocRefusal; message: string }) {
    super(refusal.message);
  }
}

export interface DoorInput {
  runId?: unknown;
  deliveryId?: unknown;
  /** Made by the phone once per try: the same key sent again is the same try. */
  clientKey?: unknown;
  clientTime?: unknown;
  lat?: unknown;
  lng?: unknown;
  note?: unknown;
  photoId?: unknown;
}

export interface DoorDeliverInput extends DoorInput {
  receivedBy?: unknown;
  code?: unknown;
  /** Cash collected, in shillings, for a delivery that is paid at the door. It must be exactly what is due. */
  cashCollected?: unknown;
  /** What the customer took of each product, when not all of it: `{ productId, quantity, reasonCode, note }` for every product. Left out means all of it. */
  accepted?: unknown;
}

interface TakenLine {
  productId: string;
  carried: number;
  accepted: number;
  reasonCode: string | null;
  note: string | null;
}

export interface DoorFailInput extends DoorInput {
  reasonCode?: unknown;
}

export interface DoorResult {
  attemptNo: number;
  status: DeliveryStatus;
  statusWords: string;
  /** True when this try had already been recorded: nothing was done a second time. */
  replayed: boolean;
}

/**
 * What a rider does at a door: mark the stop delivered (with the proof the company asks for) or say why it could not be done.
 * Every call is bound to the rider the server found for the signed-in person and to a run that is theirs and on the road; the
 * delivery's own step, the attempt, its proofs and the order's timeline are one transaction. The phone's key makes a repeat of the
 * same try (a dropped connection, a queue replayed later) one try, and its clock is only kept beside the server's.
 */
export class DoorWork {
  constructor(
    private readonly db: DrizzleDb,
    private readonly documents: Pick<DeliveryDocuments, 'deliver' | 'failAttempt'>,
    private readonly runs: Pick<DeliveryRuns, 'complete'>,
    private readonly decisions: DecisionLog,
    private readonly payments: Pick<DoorPayments, 'collectIn' | 'followUp'>,
    private readonly costs: Pick<DeliveryCosts, 'accrueDeliveryIn'>,
  ) {}

  async deliver(self: RiderSelf, input: DoorDeliverInput, now: Date = new Date()): Promise<DocResult<DoorResult>> {
    const receivedBy = text(input.receivedBy, 120);
    if (receivedBy === null) return fail('bad_input', 'Say who received it.');
    const paid: { orderId: string | null } = { orderId: null };
    const result = await this.atTheDoor(self, input, now, async (tx, ctx) => {
      // A delivery paid at the door is taken whole, and the cash collected is exactly what is due: both are checked before anything else is counted.
      const atDoor = ctx.row.doorAmount !== null;
      // Cash is taken only while the order is unpaid. Paid already (the customer paid by M-Pesa at the door, or some other way meanwhile) nothing is collected.
      let takesCash = false;
      if (atDoor) {
        const [owed] = await tx.select({ paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, ctx.row.orderId));
        const paidAlready = owed?.paymentStatus === 'paid';
        const saidCash = input.cashCollected !== undefined && input.cashCollected !== null && input.cashCollected !== '';
        if (paidAlready && saidCash) return fail('conflict', 'This order has already been paid, so no cash is to be taken. Tell the office.');
        takesCash = !paidAlready;
        if (takesCash) {
          const said = collectedProblem(ctx.row.doorAmount ?? '0', input.cashCollected);
          if (!said.ok) return fail('bad_input', said.error);
        }
        if (Array.isArray(input.accepted) && input.accepted.length > 0) return fail('bad_input', 'A delivery paid at the door is taken whole. If the customer will not take all of it, record that it could not be delivered.');
      }
      // What the customer took: all of it unless the rider says otherwise, and a shortfall needs its reason.
      const lineRows = await tx.select({ productId: deliveryLines.productId, quantity: deliveryLines.quantity, picked: deliveryLines.picked }).from(deliveryLines).where(eq(deliveryLines.deliveryId, ctx.row.id));
      const carried = lineRows.map((l) => ({ productId: l.productId, quantity: Number(l.picked ?? l.quantity) }));
      const given = Array.isArray(input.accepted) ? (input.accepted as AcceptedLine[]) : null;
      const acceptance = checkAcceptance(carried, given);
      if (!acceptance.ok) return fail('bad_input', acceptance.error);
      const [settings] = await tx.select({ proof: deliveryRiderSettings.proof }).from(deliveryRiderSettings).where(eq(deliveryRiderSettings.companyId, self.companyId));
      const company: ProofRule = settings !== undefined && isProofRule(settings.proof) ? settings.proof : 'none';
      const rule = ruleFor(company, ctx.row.handoverCode !== null);
      const typed = normaliseCode(input.code);
      let codeMatched = false;
      if (typed !== '') {
        if (ctx.row.codeTries >= MAX_CODE_TRIES) return fail('not_allowed', 'Too many wrong codes were tried at this door. Ask the office to help, or take a photo if that is enough.');
        codeMatched = codesMatch(typed, ctx.row.handoverCode);
        if (!codeMatched) {
          // Counted even though the try fails: this commits, so a six-digit code cannot be guessed.
          await tx.update(deliveries).set({ codeTries: sql`${deliveries.codeTries} + 1` }).where(eq(deliveries.id, ctx.row.id));
          await this.decisions.record({ companyId: self.companyId, subject: { type: 'delivery', id: ctx.row.id }, action: 'delivery.code_wrong', actor: { type: 'user', id: self.userId }, reason: { text: `try ${String(ctx.row.codeTries + 1)} of ${String(MAX_CODE_TRIES)}` } }, tx);
          const left = MAX_CODE_TRIES - ctx.row.codeTries - 1;
          return fail('bad_input', left > 0 ? `That is not the customer's code. ${String(left)} ${left === 1 ? 'try' : 'tries'} left.` : 'That is not the customer\'s code, and no tries are left. Ask the office to help.');
        }
      }
      const photo = await this.photo(tx, self, input.photoId);
      if (!photo.ok) return photo;
      const problem = proofProblem(rule, { codeMatched, hasPhoto: photo.data !== null });
      if (problem !== null) return fail('bad_input', problem);
      const done = await this.documents.deliver({ companyId: self.companyId, userId: self.userId }, ctx.row.id, { receivedBy, note: input.note, accepted: acceptance.whole ? null : given }, undefined, tx);
      if (!done.ok) return done;
      // The rider earns what the company pays for a delivery, counted in this same transaction.
      await this.costs.accrueDeliveryIn(tx, { companyId: self.companyId, deliveryId: ctx.row.id, runId: ctx.runId, riderId: self.riderId, actorId: self.userId });
      if (takesCash) {
        // The cash goes into the rider's custody and the order is paid in the same transaction as the delivery: both or neither.
        const taken = await this.payments.collectIn(tx, self, ctx.row);
        if (!taken.ok) throw new DoorRollback(taken);
        paid.orderId = taken.data.orderId;
      }
      const kept = proofsKept(rule, { codeMatched, hasPhoto: photo.data !== null });
      const reasonOf = new Map(acceptance.notAccepted.map((n) => [n.productId, n]));
      const taken: TakenLine[] = acceptance.whole ? [] : acceptance.accepted.map((a) => ({ productId: a.productId, carried: carried.find((c) => c.productId === a.productId)?.quantity ?? a.quantity, accepted: a.quantity, reasonCode: reasonOf.get(a.productId)?.reasonCode ?? null, note: reasonOf.get(a.productId)?.note ?? null }));
      return { ok: true, data: { result: acceptance.whole ? 'delivered' : 'part_accepted', receivedBy, kept, photoId: photo.data, status: done.data.status, taken } };
    });
    // After the commit: the order is stocked and its sale queued for the books. If that fails it is finished later (finishPosting).
    if (result.ok && !result.data.replayed && paid.orderId !== null) await this.payments.followUp(paid.orderId);
    return result;
  }

  async fail(self: RiderSelf, input: DoorFailInput, now: Date = new Date()): Promise<DocResult<DoorResult>> {
    const code = typeof input.reasonCode === 'string' ? input.reasonCode : '';
    if (!FAILURE_REASONS.some((r) => r.code === code)) return fail('bad_input', 'Choose why the delivery did not happen.');
    return await this.atTheDoor(self, input, now, async (tx, ctx) => {
      const photo = await this.photo(tx, self, input.photoId);
      if (!photo.ok) return photo;
      const done = await this.documents.failAttempt({ companyId: self.companyId, userId: self.userId }, ctx.row.id, { reasonCode: code, note: input.note }, undefined, tx);
      if (!done.ok) return done;
      return { ok: true, data: { result: code, receivedBy: null, kept: photo.data === null ? [] : ['photo' as const], photoId: photo.data, status: done.data.status, taken: [] } };
    });
  }

  /** The rider has done every stop: close the run. Stops not delivered leave it, as they do when the office closes it. */
  async finish(self: RiderSelf, runId: unknown): Promise<DocResult<{ delivered: number; notDelivered: number }>> {
    if (typeof runId !== 'string' || !UUID.test(runId)) return fail('not_found', 'That run could not be found.');
    const [run] = await this.db.select().from(deliveryRuns).where(and(eq(deliveryRuns.id, runId), eq(deliveryRuns.companyId, self.companyId), eq(deliveryRuns.riderId, self.riderId)));
    if (run === undefined) return fail('not_found', 'That run could not be found.');
    if (run.status !== 'started') return fail('not_allowed', run.status === 'planned' ? 'This run has not gone out yet.' : 'This run is already closed.');
    const stops = await this.db
      .select({ status: deliveries.status })
      .from(deliveryRunStops)
      .innerJoin(deliveries, eq(deliveries.id, deliveryRunStops.deliveryId))
      .where(and(eq(deliveryRunStops.runId, runId), isNull(deliveryRunStops.leftAt)));
    const waiting = stops.filter((s) => s.status === 'out_for_delivery').length;
    if (waiting > 0) return fail('not_allowed', `${String(waiting)} ${waiting === 1 ? 'stop is' : 'stops are'} still to do. Deliver ${waiting === 1 ? 'it' : 'them'}, or say why not, before you finish.`);
    const closed = await this.runs.complete({ companyId: self.companyId, userId: self.userId }, runId, run.version);
    if (!closed.ok) return closed;
    const delivered = stops.filter((s) => s.status === 'delivered').length;
    return { ok: true, data: { delivered, notDelivered: stops.length - delivered } };
  }

  // ── Shared by the two ways a stop can end ──────────────────────────────────────────────────────────────────────────

  private async atTheDoor(
    self: RiderSelf,
    input: DoorInput,
    now: Date,
    work: (tx: Tx, ctx: { row: typeof deliveries.$inferSelect; runId: string }) => Promise<DocResult<{ result: string; receivedBy: string | null; kept: ('code' | 'photo')[]; photoId: string | null; status: DeliveryStatus; taken: TakenLine[] }>>,
  ): Promise<DocResult<DoorResult>> {
    if (typeof input.runId !== 'string' || !UUID.test(input.runId) || typeof input.deliveryId !== 'string' || !UUID.test(input.deliveryId)) return fail('not_found', NOT_FOUND);
    if (!isClientKey(input.clientKey)) return fail('bad_input', 'This try could not be told apart from another. Reload the app and try again.');
    const { runId, deliveryId, clientKey } = { runId: input.runId, deliveryId: input.deliveryId, clientKey: input.clientKey };
    const actor: DocActor = { companyId: self.companyId, userId: self.userId };
    try {
    return await this.db.transaction(async (tx): Promise<DocResult<DoorResult>> => {
      // The same try sent again: say what happened the first time, and do nothing more.
      const [again] = await tx.select().from(deliveryAttempts).where(and(eq(deliveryAttempts.companyId, actor.companyId), eq(deliveryAttempts.clientKey, clientKey)));
      if (again !== undefined) {
        if (again.riderId !== self.riderId || again.deliveryId !== deliveryId) return fail('not_found', NOT_FOUND);
        const [now1] = await tx.select({ status: deliveries.status }).from(deliveries).where(eq(deliveries.id, deliveryId));
        const status = now1?.status ?? 'delivered';
        return { ok: true, data: { attemptNo: again.attemptNo, status, statusWords: STATUS_WORDS[status], replayed: true } };
      }
      const [run] = await tx.select().from(deliveryRuns).where(and(eq(deliveryRuns.id, runId), eq(deliveryRuns.companyId, actor.companyId), eq(deliveryRuns.riderId, self.riderId)));
      if (run === undefined) return fail('not_found', NOT_FOUND);
      if (run.status !== 'started') return fail('not_allowed', run.status === 'planned' ? 'This run has not gone out yet.' : 'This run is closed.');
      const [stop] = await tx.select({ id: deliveryRunStops.id }).from(deliveryRunStops).where(and(eq(deliveryRunStops.runId, runId), eq(deliveryRunStops.deliveryId, deliveryId), isNull(deliveryRunStops.leftAt)));
      if (stop === undefined) return fail('not_found', NOT_FOUND);
      const [row] = await tx.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', NOT_FOUND);
      if (row.status !== 'out_for_delivery') return fail('not_allowed', `This stop is ${STATUS_WORDS[row.status].toLowerCase()}, so it cannot be done again.`);

      const outcome = await work(tx, { row, runId });
      if (!outcome.ok) return outcome;
      const place = placeFrom(input.lat, input.lng);
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(deliveryAttempts).where(eq(deliveryAttempts.deliveryId, deliveryId));
      const [attempt] = await tx
        .insert(deliveryAttempts)
        .values({
          companyId: actor.companyId,
          deliveryId,
          runId,
          riderId: self.riderId,
          attemptNo: n + 1,
          result: outcome.data.result,
          receivedBy: outcome.data.receivedBy,
          note: text(input.note, 300),
          latitude: place?.lat ?? null,
          longitude: place?.lng ?? null,
          clientKey,
          clientTime: usableClientTime(input.clientTime, now),
        })
        .returning({ id: deliveryAttempts.id });
      if (attempt === undefined) throw new Error('The attempt could not be saved.');
      for (const t of outcome.data.taken) await tx.insert(deliveryAttemptLines).values({ attemptId: attempt.id, productId: t.productId, carried: t.carried, accepted: t.accepted, reasonCode: t.reasonCode, note: t.note });
      for (const kind of outcome.data.kept) await tx.insert(deliveryProofs).values({ attemptId: attempt.id, kind, mediaId: kind === 'photo' ? outcome.data.photoId : null });
      // A photo that is kept is no longer an unused upload, so the sweep leaves it.
      if (outcome.data.photoId !== null) await tx.update(mediaAssets).set({ status: 'ready', updatedAt: new Date() }).where(eq(mediaAssets.id, outcome.data.photoId));
      return { ok: true, data: { attemptNo: n + 1, status: outcome.data.status, statusWords: STATUS_WORDS[outcome.data.status], replayed: false } };
    });
    } catch (error) {
      if (error instanceof DoorRollback) return error.refusal;
      throw error;
    }
  }

  /**
   * A photo the rider just took: theirs (they uploaded it), private, of the right kind, and not used for anything yet. Anything else
   * is refused in the same words, so an id from the phone cannot be used to learn about, or borrow, another photo.
   */
  private async photo(tx: Tx, self: RiderSelf, photoId: unknown): Promise<DocResult<string | null>> {
    if (photoId === undefined || photoId === null || photoId === '') return { ok: true, data: null };
    const bad = fail('bad_input', 'That photo could not be used. Take it again.');
    if (typeof photoId !== 'string' || photoId.length > 100) return bad;
    const [asset] = await tx
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, photoId), eq(mediaAssets.purpose, PROOF_PURPOSE), eq(mediaAssets.visibility, 'private'), eq(mediaAssets.createdBy, self.userId), isNull(mediaAssets.deletedAt)));
    if (asset === undefined) return bad;
    const [used] = await tx.select({ id: deliveryProofs.id }).from(deliveryProofs).where(eq(deliveryProofs.mediaId, photoId));
    return used === undefined ? { ok: true, data: photoId } : bad;
  }
}
