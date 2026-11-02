import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, orderCollections, orders } from '@/server/db/drizzle/schema';
import { COLLECTION_ATTEMPT_LIMIT, generateCollectionCode, isWellFormedCollectionCode, normalizeCollectionCode } from '@/lib/collection-code';
import { decryptCredentials, encryptCredentials, fingerprintSecret } from '@/server/domains/payments/crypto';
import { OrderStages } from '@/server/domains/orders/stages';
import type { DecisionLog } from '@/server/kernel/decision-log/service';

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
function orderProblem(order: { status: string; paymentStatus: string; approvalStatus: string | null }): CollectionOutcome | null {
  if (order.status === 'cancelled' || order.status === 'refunded' || order.status === 'failed') return fail('order_closed', 'This order was cancelled or refunded, so it is not handed over.');
  if (order.approvalStatus === 'pending' || order.approvalStatus === 'rejected' || order.approvalStatus === 'draft') return fail('on_hold', 'This order is waiting for approval, so it is not handed over yet.');
  if (order.paymentStatus !== 'paid') return fail('not_paid', 'This order has not been paid for, so it is not handed over.');
  return null;
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
      const [order] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus }).from(orders).where(eq(orders.id, orderId));
      if (order === undefined) return fail('not_found', 'That order could not be found.');
      const problem = orderProblem(order);
      if (problem !== null) return problem;
      if (row.status === 'ready') return { ok: true, view: await this.requireView(tx, actor.companyId, orderId) };
      await tx.update(orderCollections).set({ status: 'ready', readyAt: new Date(), readyBy: actor.userId, updatedAt: new Date() }).where(eq(orderCollections.orderId, orderId));
      await OrderStages.moveIn(tx, orderId, 'ready', 'succeeded', { actor: { type: 'user', id: actor.userId }, message: 'Ready for collection', detail: { branchId: row.branchId } });
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
      const [order] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus }).from(orders).where(eq(orders.id, orderId));
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
      const [order] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus }).from(orders).where(eq(orders.id, orderId));
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
      return { ok: true as const, code, view: await this.requireView(tx, actor.companyId, orderId) };
    });
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
