import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveryMessages, deliveryTextSettings, orderCollections, orders } from '@/server/db/drizzle/schema';
import { COLLECTION_ATTEMPT_LIMIT, generateCollectionCode, isWellFormedCollectionCode, normalizeCollectionCode } from '@/lib/collection-code';
import { decryptCredentials, encryptCredentials, fingerprintSecret } from '@/server/domains/payments/crypto';
import { OrderStages } from '@/server/domains/orders/stages';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { orderReadinessProblem } from './order-readiness';
import { DEFAULT_REMINDERS } from '@/lib/delivery-messages';
import type { DeliveryMessages } from './messages';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export type CollectionStatus = 'waiting' | 'ready' | 'collected' | 'locked' | 'cancelled';

/** Who is acting, for the order's timeline and the decision log. */
export interface CollectionActor {
  companyId: string;
  userId: string;
}

/** What is known about an order's collection, never including the code. */
export interface CollectionView {
  orderId: string;
  orderNumber: string;
  status: CollectionStatus;
  branch: { id: string; code: string; name: string; address: string; phone: string | null };
  attemptsLeft: number;
  readyAt: string | null;
  collectedAt: string | null;
  collectedHow: 'code' | 'id_check' | null;
}

export type CollectionRefusal =
  | 'not_found'
  | 'bad_input'
  | 'not_paid'
  | 'on_hold'
  | 'order_closed'
  | 'wrong_code'
  | 'locked'
  | 'already_collected'
  | 'not_collectable';

export type CollectionOutcome = { ok: true; view: CollectionView } | { ok: false; reason: CollectionRefusal; message: string; attemptsLeft?: number };

const fail = (reason: CollectionRefusal, message: string, attemptsLeft?: number): CollectionOutcome => ({ ok: false, reason, message, ...(attemptsLeft === undefined ? {} : { attemptsLeft }) });

/** The order states from which an order is not handed over, with what to say. */
function orderProblem(order: { status: string; paymentStatus: string; approvalStatus: string | null; paymentMethod: string }): CollectionOutcome | null {
  const problem = orderReadinessProblem(order);
  return problem === null ? null : fail(problem.reason, problem.message);
}

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Orders the customer comes to collect. Each gets a short code that is shown to the customer and checked at the counter: it is kept
 * sealed (so the customer can be shown it again) and as a keyed hash (so a typed code is checked without opening anything), it works
 * once, and a few wrong tries lock it until someone with the right permission gives a new one. Every step is a stage on the order's
 * timeline and a line in the decision log, wrong tries included.
 */
export class OrderCollections {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly randomSource: (count: number) => Uint8Array = (count) => new Uint8Array(randomBytes(count)),
    /** Tells the customer, by mail and (when the company has it on) text, that the order is ready to collect. */
    private readonly messages: Pick<DeliveryMessages, 'enqueueIn'> | null = null,
  ) {}

  private fingerprint(orderId: string, code: string): string {
    return fingerprintSecret(`${orderId}:${normalizeCollectionCode(code)}`);
  }

  private newCode(): string {
    return generateCollectionCode(this.randomSource);
  }

  /** Puts the order waiting at the branch with a new code, in the order's own transaction. The code is returned for showing; it is not kept in the clear. */
  async issue(tx: Tx, input: { companyId: string; orderId: string; branchId: string; actor: { type: 'user' | 'system'; id: string | null } }): Promise<{ code: string }> {
    const code = this.newCode();
    await tx.insert(orderCollections).values({
      orderId: input.orderId,
      companyId: input.companyId,
      branchId: input.branchId,
      status: 'waiting',
      codeSealed: encryptCredentials({ code }),
      codeFingerprint: this.fingerprint(input.orderId, code),
    });
    await this.decisions.record(
      { companyId: input.companyId, subject: { type: 'order', id: input.orderId }, action: 'delivery.collection_code_issued', actor: input.actor, reason: { text: 'Collection from a branch' }, inputs: { branchId: input.branchId } },
      tx,
    );
    return { code };
  }

  async view(companyId: string, orderId: string): Promise<CollectionView | null> {
    return await this.viewIn(this.db, companyId, orderId);
  }

  private async viewIn(db: DrizzleDb | Tx, companyId: string, orderId: string): Promise<CollectionView | null> {
    const [row] = await db
      .select({ c: orderCollections, orderNumber: orders.orderNumber, code: branches.code, name: branches.name, street: branches.streetAddress, city: branches.city, county: branches.countyOrState, phone: branches.phone })
      .from(orderCollections)
      .innerJoin(orders, eq(orders.id, orderCollections.orderId))
      .innerJoin(branches, eq(branches.id, orderCollections.branchId))
      .where(and(eq(orderCollections.orderId, orderId), eq(orderCollections.companyId, companyId)));
    if (row === undefined) return null;
    const address = [row.street, row.city, row.county].filter((part): part is string => part !== null && part.trim() !== '').join(', ');
    return {
      orderId,
      orderNumber: row.orderNumber,
      status: row.c.status,
      branch: { id: row.c.branchId, code: row.code, name: row.name, address, phone: row.phone },
      attemptsLeft: Math.max(0, COLLECTION_ATTEMPT_LIMIT - row.c.failedAttempts),
      readyAt: row.c.readyAt?.toISOString() ?? null,
      collectedAt: row.c.collectedAt?.toISOString() ?? null,
      collectedHow: row.c.collectedHow,
    };
  }

  /** The view of a collection whose row this transaction holds: it exists, or something is badly wrong. */
  private async requireView(db: DrizzleDb | Tx, companyId: string, orderId: string): Promise<CollectionView> {
    const view = await this.viewIn(db, companyId, orderId);
    if (view === null) throw new Error(`The collection of order ${orderId} vanished while it was locked.`);
    return view;
  }

  /** The code, for the customer who owns the order. Not once it is collected, locked or cancelled: there is nothing left to show it for. */
  async codeFor(companyId: string, orderId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ status: orderCollections.status, sealed: orderCollections.codeSealed })
      .from(orderCollections)
      .where(and(eq(orderCollections.orderId, orderId), eq(orderCollections.companyId, companyId)));
    if (row === undefined || (row.status !== 'waiting' && row.status !== 'ready')) return null;
    const opened = decryptCredentials(row.sealed);
    return typeof opened?.code === 'string' ? opened.code : null;
  }

  /** Staff: the order is packed and waiting at the counter. */
  async markReady(actor: CollectionActor, orderId: string): Promise<CollectionOutcome> {
    const done = await this.db.transaction(async (tx): Promise<CollectionOutcome> => {
      const [row] = await tx.select().from(orderCollections).where(and(eq(orderCollections.orderId, orderId), eq(orderCollections.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That order is not waiting to be collected.');
      if (row.status === 'collected') return fail('already_collected', 'This order has already been collected.');
      if (row.status === 'locked') return fail('locked', 'This order’s code is locked. Give the customer a new code first.');
      if (row.status !== 'waiting' && row.status !== 'ready') return fail('not_collectable', 'This order is not waiting to be collected.');
      const [order] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus, paymentMethod: orders.paymentMethod }).from(orders).where(eq(orders.id, orderId));
      if (order === undefined) return fail('not_found', 'That order could not be found.');
      const problem = orderProblem(order);
      if (problem !== null) return problem;
      if (row.status === 'ready') return { ok: true, view: await this.requireView(tx, actor.companyId, orderId) };
      await tx.update(orderCollections).set({ status: 'ready', readyAt: new Date(), readyBy: actor.userId, updatedAt: new Date() }).where(eq(orderCollections.orderId, orderId));
      await OrderStages.moveIn(tx, orderId, 'ready', 'succeeded', { actor: { type: 'user', id: actor.userId }, message: 'Ready for collection', detail: { branchId: row.branchId } });
      // In the same transaction, so there is never a ready order whose customer was never to be told (and never a message for a step that was undone).
      await this.messages?.enqueueIn(tx, { companyId: actor.companyId, orderId, deliveryId: null, kind: 'ready_for_collection', key: `${orderId}:ready_for_collection:0` });
      return { ok: true, view: await this.requireView(tx, actor.companyId, orderId) };
    });
    return done;
  }

  /** Staff: the customer shows the code. A wrong code is recorded, counted, and locks the order's code after a few tries. */
  async collectWithCode(actor: CollectionActor, orderId: string, typed: unknown): Promise<CollectionOutcome> {
    if (typeof typed !== 'string' || typed.length > 40) return fail('bad_input', 'Type the code the customer shows.');
    const normalized = normalizeCollectionCode(typed);
    return await this.db.transaction(async (tx): Promise<CollectionOutcome> => {
      const [row] = await tx.select().from(orderCollections).where(and(eq(orderCollections.orderId, orderId), eq(orderCollections.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That order is not waiting to be collected.');
      const refused = this.statusProblem(row.status);
      if (refused !== null) return refused;
      const [order] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus, paymentMethod: orders.paymentMethod }).from(orders).where(eq(orders.id, orderId));
      if (order === undefined) return fail('not_found', 'That order could not be found.');
      const problem = orderProblem(order);
      if (problem !== null) return problem;

      const right = isWellFormedCollectionCode(normalized) && sameSecret(this.fingerprint(orderId, normalized), row.codeFingerprint);
      if (!right) {
        const failed = row.failedAttempts + 1;
        const locked = failed >= COLLECTION_ATTEMPT_LIMIT;
        await tx.update(orderCollections).set({ failedAttempts: failed, status: locked ? 'locked' : row.status, updatedAt: new Date() }).where(eq(orderCollections.orderId, orderId));
        await OrderStages.moveIn(tx, orderId, 'delivery_attempted', 'failed', {
          actor: { type: 'user', id: actor.userId },
          reasonCode: locked ? 'code_locked' : 'wrong_code',
          message: locked ? 'The collection code was typed wrongly too many times and is locked' : 'The collection code did not match',
          detail: { attempt: failed },
        });
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'order', id: orderId }, action: 'delivery.collection_code_refused', actor: { type: 'user', id: actor.userId }, reason: { code: locked ? 'code_locked' : 'wrong_code' }, outcome: { failed, locked } }, tx);
        const left = Math.max(0, COLLECTION_ATTEMPT_LIMIT - failed);
        return locked
          ? fail('locked', 'That code was wrong too many times, so it is locked. Give the customer a new code.', 0)
          : fail('wrong_code', `That is not the code for this order. ${String(left)} ${left === 1 ? 'try' : 'tries'} left.`, left);
      }
      return await this.hand(tx, actor, orderId, 'code', null);
    });
  }

  /** Staff, with the permission for it: the customer has no code, so someone looked at their ID. What was seen and why is kept. */
  async collectWithIdCheck(actor: CollectionActor, orderId: string, input: { idSeen: unknown; reason: unknown }): Promise<CollectionOutcome> {
    const idSeen = typeof input.idSeen === 'string' ? input.idSeen.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (idSeen.length < 4 || idSeen.length > 120) return fail('bad_input', 'Say what ID you saw, for example “National ID ending 4321”.');
    if (reason.length < 5 || reason.length > 300) return fail('bad_input', 'Say why the code was not used, in a few words. It is kept with the hand-over.');
    return await this.db.transaction(async (tx): Promise<CollectionOutcome> => {
      const [row] = await tx.select().from(orderCollections).where(and(eq(orderCollections.orderId, orderId), eq(orderCollections.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That order is not waiting to be collected.');
      // A locked code is a reason to look at ID, so it does not stop this path; anything else that is over does.
      const refused = row.status === 'locked' ? null : this.statusProblem(row.status);
      if (refused !== null) return refused;
      const [order] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus, paymentMethod: orders.paymentMethod }).from(orders).where(eq(orders.id, orderId));
      if (order === undefined) return fail('not_found', 'That order could not be found.');
      const problem = orderProblem(order);
      if (problem !== null) return problem;
      return await this.hand(tx, actor, orderId, 'id_check', { idSeen, reason });
    });
  }

  /** Staff, with the permission for it: the customer lost the code, or it was locked. The old code stops working. */
  async reissue(actor: CollectionActor, orderId: string, reasonText: unknown): Promise<{ ok: true; code: string; view: CollectionView } | { ok: false; reason: CollectionRefusal; message: string }> {
    const reason = typeof reasonText === 'string' ? reasonText.trim() : '';
    if (reason.length < 5 || reason.length > 300) return { ok: false, reason: 'bad_input', message: 'Say why a new code is needed, in a few words.' };
    return await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(orderCollections).where(and(eq(orderCollections.orderId, orderId), eq(orderCollections.companyId, actor.companyId))).for('update');
      if (row === undefined) return { ok: false as const, reason: 'not_found' as const, message: 'That order is not waiting to be collected.' };
      if (row.status === 'collected') return { ok: false as const, reason: 'already_collected' as const, message: 'This order has already been collected.' };
      if (row.status === 'cancelled') return { ok: false as const, reason: 'not_collectable' as const, message: 'This order is not waiting to be collected.' };
      const code = this.newCode();
      await tx
        .update(orderCollections)
        .set({ codeSealed: encryptCredentials({ code }), codeFingerprint: this.fingerprint(orderId, code), failedAttempts: 0, status: row.status === 'locked' ? 'waiting' : row.status, updatedAt: new Date() })
        .where(eq(orderCollections.orderId, orderId));
      await OrderStages.moveIn(tx, orderId, 'delivery_attempted', 'entered', { actor: { type: 'user', id: actor.userId }, message: 'A new collection code was given', detail: { by: actor.userId } });
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'order', id: orderId }, action: 'delivery.collection_code_reissued', actor: { type: 'user', id: actor.userId }, from: row.status, to: row.status === 'locked' ? 'waiting' : row.status, reason: { text: reason } }, tx);
      // A customer who was already told the order is ready holds a code that no longer works: send the new one. Before that, the first
      // message carries whatever the code is when it goes, so there is nothing to correct.
      if (row.readyAt !== null && this.messages !== null) {
        const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(deliveryMessages).where(and(eq(deliveryMessages.orderId, orderId), eq(deliveryMessages.kind, 'ready_for_collection'), eq(deliveryMessages.channel, 'email')));
        // Anything not yet sent would carry the new code too, so it is replaced rather than sent twice.
        await tx.update(deliveryMessages).set({ status: 'skipped', lastError: 'A newer message with the new code replaces it.' }).where(and(eq(deliveryMessages.orderId, orderId), eq(deliveryMessages.kind, 'ready_for_collection'), inArray(deliveryMessages.status, ['queued', 'failed'])));
        await this.messages.enqueueIn(tx, { companyId: actor.companyId, orderId, deliveryId: null, kind: 'ready_for_collection', key: `${orderId}:ready_for_collection:${String(counted?.n ?? 1)}` });
      }
      return { ok: true as const, code, view: await this.requireView(tx, actor.companyId, orderId) };
    });
  }

  /**
   * Orders that have sat ready at the counter past the days their company chose (3, and then 6, unless changed or turned off) get a
   * reminder, once for each stage: the message key carries the stage, so a repeated or overlapping scan queues nothing new, and a scan
   * that was down for days queues only the latest stage that is due. An order that is collected, cancelled or has had its last
   * reminder drops out of the search. Returns how many reminders were queued.
   */
  async remindUncollected(now: Date = new Date(), limit = 200): Promise<number> {
    const first = sql`coalesce(${deliveryTextSettings.collectionReminderFirstDays}, ${DEFAULT_REMINDERS.firstDays})`;
    const stages = sql`case when ${deliveryTextSettings.companyId} is null then 2 when ${deliveryTextSettings.collectionReminderSecondDays} is null then 1 else 2 end`;
    const candidates = await this.db
      .select({
        orderId: orderCollections.orderId,
        companyId: orderCollections.companyId,
        readyAt: orderCollections.readyAt,
        first: sql<number>`${first}::int`,
        second: sql<number | null>`case when ${deliveryTextSettings.companyId} is null then ${DEFAULT_REMINDERS.secondDays ?? 0}::int else ${deliveryTextSettings.collectionReminderSecondDays} end`,
      })
      .from(orderCollections)
      .leftJoin(deliveryTextSettings, eq(deliveryTextSettings.companyId, orderCollections.companyId))
      .where(
        and(
          inArray(orderCollections.status, ['ready', 'locked']),
          sql`coalesce(${deliveryTextSettings.collectionRemindersOn}, true)`,
          lte(orderCollections.readyAt, sql`${now.toISOString()}::timestamptz - make_interval(days => ${first})`),
          // Not when the last stage has already been queued.
          sql`coalesce((select max((substring(m.message_key from ':collection_reminder:([0-9]+)'))::int) from ${deliveryMessages} m where m.company_id = ${orderCollections.companyId} and m.order_id = ${orderCollections.orderId} and m.kind = 'collection_reminder'), 0) < ${stages}`,
        ),
      )
      .orderBy(orderCollections.readyAt)
      .limit(limit);
    let queued = 0;
    for (const c of candidates) {
      if (c.readyAt === null || this.messages === null) continue;
      const waited = (now.getTime() - c.readyAt.getTime()) / 86_400_000;
      const last = c.second === null ? 1 : 2;
      const reachedFirst = waited >= c.first;
      const stage = c.second !== null && waited >= c.second ? 2 : Number(reachedFirst);
      if (stage === 0) continue;
      const messages = this.messages;
      const made = await this.db.transaction(async (tx) => {
        // Look again under the lock: it may have been collected since the search.
        const [row] = await tx.select({ status: orderCollections.status }).from(orderCollections).where(and(eq(orderCollections.orderId, c.orderId), eq(orderCollections.companyId, c.companyId))).for('update');
        if (row === undefined || (row.status !== 'ready' && row.status !== 'locked')) return false;
        const [had] = await tx.select({ n: sql<number>`coalesce(max((substring(${deliveryMessages.messageKey} from ':collection_reminder:([0-9]+)'))::int), 0)` }).from(deliveryMessages).where(and(eq(deliveryMessages.companyId, c.companyId), eq(deliveryMessages.orderId, c.orderId), eq(deliveryMessages.kind, 'collection_reminder')));
        if ((had?.n ?? 0) >= stage) return false;
        const key = `${c.orderId}:collection_reminder:${String(stage)}${stage === last ? ':last' : ''}`;
        await messages.enqueueIn(tx, { companyId: c.companyId, orderId: c.orderId, deliveryId: null, kind: 'collection_reminder', key, textAs: 'ready_for_collection' });
        return true;
      });
      if (made) queued += 1;
    }
    return queued;
  }

  private statusProblem(status: CollectionStatus): CollectionOutcome | null {
    if (status === 'collected') return fail('already_collected', 'This order has already been collected.');
    if (status === 'locked') return fail('locked', 'This order’s code is locked. Give the customer a new code first.', 0);
    if (status !== 'waiting' && status !== 'ready') return fail('not_collectable', 'This order is not waiting to be collected.');
    return null;
  }

  /** The hand-over itself, in the transaction that holds the collection's lock: once, whatever else is racing. */
  private async hand(tx: Tx, actor: CollectionActor, orderId: string, how: 'code' | 'id_check', check: { idSeen: string; reason: string } | null): Promise<CollectionOutcome> {
    await tx
      .update(orderCollections)
      .set({ status: 'collected', collectedAt: new Date(), collectedBy: actor.userId, collectedHow: how, idSeen: check?.idSeen ?? null, failedAttempts: 0, updatedAt: new Date() })
      .where(eq(orderCollections.orderId, orderId));
    await OrderStages.moveIn(tx, orderId, 'collected', 'succeeded', {
      actor: { type: 'user', id: actor.userId },
      message: how === 'code' ? 'Collected with the code' : `Collected after an ID check: ${check?.idSeen ?? ''}`,
      detail: { how, ...(check === null ? {} : { idSeen: check.idSeen, reason: check.reason }) },
    });
    await this.decisions.record(
      { companyId: actor.companyId, subject: { type: 'order', id: orderId }, action: 'delivery.collected', actor: { type: 'user', id: actor.userId }, reason: check === null ? { code: 'code' } : { code: 'id_check', text: check.reason }, inputs: check === null ? {} : { idSeen: check.idSeen } },
      tx,
    );
    return { ok: true, view: await this.requireView(tx, actor.companyId, orderId) };
  }
}
