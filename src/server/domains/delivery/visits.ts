import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { orderVisitCrew, orderVisitItems, orderVisitMaterials, orderVisits, orders, products, stockLocations, users } from '@/server/db/drizzle/schema';
import { checkCrew, checkItems, checkWindow, checklistProblem, nextVisitStatus, reasonProblem, signOffProblem, type VisitAction, type VisitStatus } from '@/lib/visit';
import type { StockLedger } from '@/server/domains/stock/ledger';
import { StockError } from '@/server/domains/stock/errors';
import { OrderStages } from '@/server/domains/orders/stages';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import type { DocRefusal, DocResult } from './documents';
import { orderReadinessProblem } from './order-readiness';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** `crewOnly`: the person may act only on visits they are on the crew of (a member of the crew, not the scheduler). */
export interface VisitActor {
  companyId: string;
  userId: string;
  crewOnly: boolean;
}

export interface VisitView {
  id: string;
  orderId: string;
  orderNumber: string;
  status: VisitStatus;
  startsAt: string;
  endsAt: string;
  address: string;
  contactName: string | null;
  contactPhone: string | null;
  notes: string | null;
  crew: { userId: string; name: string }[];
  items: { id: string; label: string; done: boolean }[];
  materials: MaterialView[];
  startedAt: string | null;
  completedAt: string | null;
  signedOffAt: string | null;
  signedOffBy: string | null;
  cancelReason: string | null;
  version: number;
}

export interface MaterialView {
  id: string;
  productId: string;
  productName: string;
  locationName: string;
  /** Positive: used. Negative: given back. */
  quantity: number;
  note: string | null;
  givenBack: boolean;
  /** This line can still be given back (it is a use, not already undone). */
  canGiveBack: boolean;
  at: string;
}

export interface VisitPage {
  rows: VisitView[];
  nextCursor: string | null;
}

/** What the browser sent to book a visit: orderId, startsAt, endsAt, address, contactName, contactPhone, notes, items (words) and crewIds. All of it is checked here. */
export type BookInput = Record<string, unknown>;

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 25;

class Refused extends Error {
  constructor(readonly refusal: { ok: false; reason: DocRefusal; message: string }) {
    super(refusal.message);
  }
}

/**
 * Booked visits. One live visit per order; the steps follow `src/lib/visit.ts`. Everything that changes a visit locks it first, checks the
 * version where two people may edit, and records the step on the order's timeline and in the decision log in the same transaction.
 * A crew member (visits:work) acts only on visits they are on; the scheduler (visits:manage) acts on all.
 */
export class OrderVisits {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly ledger: StockLedger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async run<T>(work: (tx: Tx) => Promise<DocResult<T>>): Promise<DocResult<T>> {
    try {
      return await this.db.transaction(work);
    } catch (e) {
      if (e instanceof Refused) return e.refusal;
      throw e;
    }
  }

  /** Staff who can go on a crew: the ones named must all be active members of staff. */
  private async crewNames(tx: Tx, ids: string[]): Promise<Map<string, string> | null> {
    if (ids.some((id) => !UUID.test(id))) return null;
    const rows = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(inArray(users.id, ids), eq(users.status, 'active'), eq(users.isActive, true), sql`(${users.role} = 'super_admin' OR EXISTS (SELECT 1 FROM roles r WHERE r.key = ${users.role} AND r.is_staff AND r.is_active))`));
    return rows.length === ids.length ? new Map(rows.map((r) => [r.id, r.name])) : null;
  }

  private async viewsIn(db: DrizzleDb | Tx, companyId: string, where: SQL | undefined, limit: number): Promise<VisitView[]> {
    const rows = await db
      .select({ v: orderVisits, orderNumber: orders.orderNumber })
      .from(orderVisits)
      .innerJoin(orders, eq(orders.id, orderVisits.orderId))
      .where(and(eq(orderVisits.companyId, companyId), where))
      .orderBy(asc(orderVisits.startsAt), asc(orderVisits.id))
      .limit(limit);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.v.id);
    const [crew, items, materials] = await Promise.all([
      db.select().from(orderVisitCrew).where(inArray(orderVisitCrew.visitId, ids)).orderBy(asc(orderVisitCrew.addedAt), asc(orderVisitCrew.name)),
      db.select().from(orderVisitItems).where(inArray(orderVisitItems.visitId, ids)).orderBy(asc(orderVisitItems.position)),
      db
        .select({ m: orderVisitMaterials, productName: products.name, locationName: stockLocations.name })
        .from(orderVisitMaterials)
        .innerJoin(products, eq(products.id, orderVisitMaterials.productId))
        .innerJoin(stockLocations, eq(stockLocations.id, orderVisitMaterials.locationId))
        .where(inArray(orderVisitMaterials.visitId, ids))
        .orderBy(asc(orderVisitMaterials.createdAt), asc(orderVisitMaterials.id)),
    ]);
    const undone = new Set(materials.map((r) => r.m.reversesId).filter((x): x is string => x !== null));
    return rows.map(({ v, orderNumber }) => ({
      id: v.id,
      orderId: v.orderId,
      orderNumber,
      status: v.status,
      startsAt: v.startsAt.toISOString(),
      endsAt: v.endsAt.toISOString(),
      address: v.address,
      contactName: v.contactName,
      contactPhone: v.contactPhone,
      notes: v.notes,
      crew: crew.filter((c) => c.visitId === v.id).map((c) => ({ userId: c.userId, name: c.name })),
      items: items.filter((i) => i.visitId === v.id).map((i) => ({ id: i.id, label: i.label, done: i.done })),
      materials: materials
        .filter((r) => r.m.visitId === v.id)
        .map((r) => ({ id: r.m.id, productId: r.m.productId, productName: r.productName, locationName: r.locationName, quantity: Number(r.m.quantity), note: r.m.note, givenBack: undone.has(r.m.id), canGiveBack: Number(r.m.quantity) > 0 && !undone.has(r.m.id), at: r.m.createdAt.toISOString() })),
      startedAt: v.startedAt?.toISOString() ?? null,
      completedAt: v.completedAt?.toISOString() ?? null,
      signedOffAt: v.signedOffAt?.toISOString() ?? null,
      signedOffBy: v.signedOffBy,
      cancelReason: v.cancelReason,
      version: v.version,
    }));
  }

  async view(actor: VisitActor, id: string): Promise<VisitView | null> {
    if (!UUID.test(id)) return null;
    const [view] = await this.viewsIn(this.db, actor.companyId, eq(orderVisits.id, id), 1);
    if (view === undefined) return null;
    return actor.crewOnly && !view.crew.some((c) => c.userId === actor.userId) ? null : view;
  }

  async forOrder(companyId: string, orderId: string): Promise<VisitView[]> {
    return await this.viewsIn(this.db, companyId, eq(orderVisits.orderId, orderId), 20);
  }

  /** Visits by their time, soonest first. A crew member sees theirs only. `status` narrows to one state; the live ones are the default. */
  async list(actor: VisitActor, input: { status?: VisitStatus | 'live'; cursor?: string | null } = {}): Promise<VisitPage> {
    const live = input.status === undefined || input.status === 'live';
    const mine = actor.crewOnly ? sql`EXISTS (SELECT 1 FROM order_visit_crew c WHERE c.visit_id = ${orderVisits.id} AND c.user_id = ${actor.userId}::uuid)` : sql`true`;
    const status = input.status === undefined || input.status === 'live' ? 'scheduled' : input.status;
    const state = live ? sql`${orderVisits.status} NOT IN ('signed_off','cancelled')` : eq(orderVisits.status, status);
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const seek = after === null || !UUID.test(after.id) || Number.isNaN(new Date(after.k).getTime()) ? sql`true` : sql`(${orderVisits.startsAt}, ${orderVisits.id}) > (${after.k}::timestamptz, ${after.id}::uuid)`;
    const rows = await this.viewsIn(this.db, actor.companyId, and(state, mine, seek), PAGE + 1);
    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return { rows: page, nextCursor: rows.length > PAGE && last !== undefined ? encodeCursor({ k: last.startsAt, id: last.id }) : null };
  }

  /** The visit, locked, with the rules every step shares: it is this company's, the person may act on it, and the step is allowed from where it is. */
  private async locked(tx: Tx, actor: VisitActor, id: string, action: VisitAction, expectedVersion?: unknown): Promise<typeof orderVisits.$inferSelect & { next: VisitStatus }> {
    if (!UUID.test(id)) throw new Refused(fail('not_found', 'That visit could not be found.'));
    const [row] = await tx.select().from(orderVisits).where(and(eq(orderVisits.id, id), eq(orderVisits.companyId, actor.companyId))).for('update');
    if (row === undefined) throw new Refused(fail('not_found', 'That visit could not be found.'));
    if (actor.crewOnly) {
      const [mine] = await tx.select({ u: orderVisitCrew.userId }).from(orderVisitCrew).where(and(eq(orderVisitCrew.visitId, id), eq(orderVisitCrew.userId, actor.userId)));
      if (mine === undefined) throw new Refused(fail('not_found', 'That visit could not be found.'));
    }
    if (expectedVersion !== undefined && expectedVersion !== row.version) throw new Refused(fail('conflict', 'Someone else changed this visit. Open it again to see the latest.'));
    const next = nextVisitStatus(row.status, action);
    if (next === null) throw new Refused(fail('not_allowed', `This visit is ${row.status === 'signed_off' ? 'signed off' : row.status.replace('_', ' ')}, so that cannot be done now.`));
    return { ...row, next };
  }

  private async note(tx: Tx, actor: VisitActor, orderId: string, visitId: string, action: string, detail: Record<string, unknown>, reason?: string): Promise<void> {
    await this.decisions.record(
      { companyId: actor.companyId, subject: { type: 'order', id: orderId }, action: `visit.${action}`, actor: { type: 'user', id: actor.userId }, ...(reason === undefined ? {} : { reason: { text: reason } }), inputs: { visitId, ...detail } },
      tx,
    );
  }

  async book(actor: VisitActor, input: BookInput): Promise<DocResult<VisitView>> {
    if (typeof input.orderId !== 'string' || input.orderId === '' || input.orderId.length > 100) return fail('bad_input', 'Choose the order the visit is for.');
    const window = checkWindow(input.startsAt, input.endsAt, this.clock());
    if (!window.ok) return fail('bad_input', window.error);
    const address = text(input.address, 300);
    if (address === null) return fail('bad_input', 'Write the address the crew goes to.');
    const items = checkItems(input.items);
    if (!items.ok) return fail('bad_input', items.error);
    const crew = input.crewIds === undefined || (Array.isArray(input.crewIds) && input.crewIds.length === 0) ? null : checkCrew(input.crewIds);
    if (crew !== null && !crew.ok) return fail('bad_input', crew.error);
    const orderId = input.orderId;
    return await this.run(async (tx) => {
      const [order] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus, paymentMethod: orders.paymentMethod }).from(orders).where(eq(orders.id, orderId)).for('update');
      if (order === undefined) return fail('not_found', 'That order could not be found.');
      const problem = orderReadinessProblem(order);
      if (problem !== null) return fail('order_not_ready', problem.message);
      const names = crew === null ? new Map<string, string>() : await this.crewNames(tx, crew.ids);
      if (names === null) return fail('bad_input', 'Everyone on the crew must be an active member of staff.');
      const [live] = await tx.select({ id: orderVisits.id }).from(orderVisits).where(and(eq(orderVisits.orderId, orderId), sql`${orderVisits.status} <> 'cancelled'`));
      if (live !== undefined) return fail('conflict', 'This order already has a visit booked. Move it or cancel it first.');
      const status: VisitStatus = crew === null ? 'scheduled' : 'crew_assigned';
      const [made] = await tx
        .insert(orderVisits)
        .values({
          companyId: actor.companyId,
          orderId,
          status,
          startsAt: window.start,
          endsAt: window.end,
          address,
          contactName: text(input.contactName, 120),
          contactPhone: text(input.contactPhone, 40),
          notes: text(input.notes, 600),
          createdBy: actor.userId,
        })
        .returning({ id: orderVisits.id });
      if (made === undefined) throw new Error('The visit was not saved.');
      await tx.insert(orderVisitItems).values(items.items.map((label, i) => ({ visitId: made.id, position: i + 1, label })));
      if (crew !== null) await tx.insert(orderVisitCrew).values(crew.ids.map((userId) => ({ visitId: made.id, userId, name: names.get(userId) ?? '' })));
      await this.note(tx, actor, orderId, made.id, 'booked', { startsAt: window.start.toISOString(), endsAt: window.end.toISOString(), crew: crew?.ids ?? [] });
      if (crew !== null) await this.dispatched(tx, actor, orderId, made.id);
      const [view] = await this.viewsIn(tx, actor.companyId, eq(orderVisits.id, made.id), 1);
      if (view === undefined) throw new Error('The visit vanished.');
      return { ok: true, data: view };
    });
  }

  /** The order is on its way once a crew is named (once, however many times the crew is changed after). */
  private async dispatched(tx: Tx, actor: VisitActor, orderId: string, visitId: string): Promise<void> {
    await OrderStages.moveIn(tx, orderId, 'dispatched', 'succeeded', { actor: { type: 'user', id: actor.userId }, message: 'A visit is booked and a crew is assigned', ref: { type: 'visit', id: visitId }, detail: { method: 'scheduled_visit' } });
  }

  async assign(actor: VisitActor, id: string, input: { crewIds: unknown; expectedVersion: unknown }): Promise<DocResult<VisitView>> {
    const crew = checkCrew(input.crewIds);
    if (!crew.ok) return fail('bad_input', crew.error);
    return await this.run(async (tx) => {
      const row = await this.locked(tx, actor, id, 'assign', input.expectedVersion);
      const names = await this.crewNames(tx, crew.ids);
      if (names === null) return fail('bad_input', 'Everyone on the crew must be an active member of staff.');
      await tx.delete(orderVisitCrew).where(eq(orderVisitCrew.visitId, id));
      await tx.insert(orderVisitCrew).values(crew.ids.map((userId) => ({ visitId: id, userId, name: names.get(userId) ?? '' })));
      await tx.update(orderVisits).set({ status: row.next, version: row.version + 1, updatedAt: this.clock() }).where(eq(orderVisits.id, id));
      await this.note(tx, actor, row.orderId, id, 'crew_assigned', { crew: crew.ids });
      if (row.status === 'scheduled') await this.dispatched(tx, actor, row.orderId, id);
      return await this.reloaded(tx, actor, id);
    });
  }

  async reschedule(actor: VisitActor, id: string, input: { startsAt: unknown; endsAt: unknown; reason: unknown; expectedVersion: unknown }): Promise<DocResult<VisitView>> {
    const window = checkWindow(input.startsAt, input.endsAt, this.clock());
    if (!window.ok) return fail('bad_input', window.error);
    const why = reasonProblem(input.reason, 'the visit is moved');
    if (why !== null) return fail('bad_input', why);
    return await this.run(async (tx) => {
      const row = await this.locked(tx, actor, id, 'reschedule', input.expectedVersion);
      await tx.update(orderVisits).set({ startsAt: window.start, endsAt: window.end, version: row.version + 1, updatedAt: this.clock() }).where(eq(orderVisits.id, id));
      await this.note(tx, actor, row.orderId, id, 'moved', { from: row.startsAt.toISOString(), startsAt: window.start.toISOString(), endsAt: window.end.toISOString() }, String(input.reason).trim());
      return await this.reloaded(tx, actor, id);
    });
  }

  async start(actor: VisitActor, id: string): Promise<DocResult<VisitView>> {
    return await this.run(async (tx) => {
      const row = await this.locked(tx, actor, id, 'start');
      const now = this.clock();
      await tx.update(orderVisits).set({ status: row.next, startedAt: now, version: row.version + 1, updatedAt: now }).where(eq(orderVisits.id, id));
      await OrderStages.moveIn(tx, row.orderId, 'out_for_delivery', 'succeeded', { actor: { type: 'user', id: actor.userId }, message: 'The crew is on site', ref: { type: 'visit', id }, detail: { method: 'scheduled_visit' } });
      await this.note(tx, actor, row.orderId, id, 'on_site', {});
      return await this.reloaded(tx, actor, id);
    });
  }

  /** Ticks or unticks one checklist item, while the crew is on site. */
  async tick(actor: VisitActor, id: string, itemId: string, done: boolean): Promise<DocResult<VisitView>> {
    if (!UUID.test(itemId)) return fail('not_found', 'That item could not be found.');
    return await this.run(async (tx) => {
      const row = await this.locked(tx, actor, id, 'complete');
      if (row.status !== 'on_site') return fail('not_allowed', 'The checklist is ticked while the crew is on site.');
      const now = this.clock();
      const changed = await tx
        .update(orderVisitItems)
        .set(done ? { done: true, doneAt: now, doneBy: actor.userId } : { done: false, doneAt: null, doneBy: null })
        .where(and(eq(orderVisitItems.id, itemId), eq(orderVisitItems.visitId, id)))
        .returning({ id: orderVisitItems.id });
      if (changed.length === 0) return fail('not_found', 'That item is not on this visit\'s checklist.');
      return await this.reloaded(tx, actor, id);
    });
  }

  async complete(actor: VisitActor, id: string): Promise<DocResult<VisitView>> {
    return await this.run(async (tx) => {
      const row = await this.locked(tx, actor, id, 'complete');
      const items = await tx.select({ done: orderVisitItems.done }).from(orderVisitItems).where(eq(orderVisitItems.visitId, id));
      const problem = checklistProblem(items);
      if (problem !== null) return fail('nothing_left', problem);
      const now = this.clock();
      await tx.update(orderVisits).set({ status: row.next, completedAt: now, version: row.version + 1, updatedAt: now }).where(eq(orderVisits.id, id));
      await this.note(tx, actor, row.orderId, id, 'completed', { items: items.length });
      return await this.reloaded(tx, actor, id);
    });
  }

  /** The customer's sign-off, recorded by the crew or the office: who signed, and when. The order is delivered. */
  async signOff(actor: VisitActor, id: string, input: { name: unknown }): Promise<DocResult<VisitView>> {
    const problem = signOffProblem(input.name);
    if (problem !== null) return fail('bad_input', problem);
    const name = String(input.name).trim().slice(0, 120);
    return await this.run(async (tx) => {
      const row = await this.locked(tx, actor, id, 'sign_off');
      const now = this.clock();
      await tx.update(orderVisits).set({ status: row.next, signedOffAt: now, signedOffBy: name, version: row.version + 1, updatedAt: now }).where(eq(orderVisits.id, id));
      await OrderStages.moveIn(tx, row.orderId, 'delivered', 'succeeded', { actor: { type: 'user', id: actor.userId }, message: `The customer signed the work off (${name})`, ref: { type: 'visit', id }, detail: { method: 'scheduled_visit', signedOffBy: name } });
      await this.note(tx, actor, row.orderId, id, 'signed_off', { signedOffBy: name });
      return await this.reloaded(tx, actor, id);
    });
  }

  async cancel(actor: VisitActor, id: string, input: { reason: unknown; expectedVersion: unknown }): Promise<DocResult<VisitView>> {
    const why = reasonProblem(input.reason, 'the visit is cancelled');
    if (why !== null) return fail('bad_input', why);
    const reason = String(input.reason).trim().slice(0, 300);
    return await this.run(async (tx) => {
      const row = await this.locked(tx, actor, id, 'cancel', input.expectedVersion);
      const now = this.clock();
      await tx.update(orderVisits).set({ status: row.next, cancelledAt: now, cancelReason: reason, version: row.version + 1, updatedAt: now }).where(eq(orderVisits.id, id));
      // A crew had been sent: that is a delivery that did not happen, with its reason, on the order's timeline.
      if (row.status !== 'scheduled') await OrderStages.moveIn(tx, row.orderId, 'delivery_failed', 'failed', { actor: { type: 'user', id: actor.userId }, reasonCode: 'visit_cancelled', message: `The visit was cancelled: ${reason}`, ref: { type: 'visit', id }, detail: { method: 'scheduled_visit' } });
      await this.note(tx, actor, row.orderId, id, 'cancelled', {}, reason);
      return await this.reloaded(tx, actor, id);
    });
  }

  /** Materials are used while the crew is on site, and until the work is signed off. */
  private async materialsOpen(tx: Tx, actor: VisitActor, id: string): Promise<typeof orderVisits.$inferSelect> {
    if (!UUID.test(id)) throw new Refused(fail('not_found', 'That visit could not be found.'));
    const [row] = await tx.select().from(orderVisits).where(and(eq(orderVisits.id, id), eq(orderVisits.companyId, actor.companyId))).for('update');
    if (row === undefined) throw new Refused(fail('not_found', 'That visit could not be found.'));
    if (actor.crewOnly) {
      const [mine] = await tx.select({ u: orderVisitCrew.userId }).from(orderVisitCrew).where(and(eq(orderVisitCrew.visitId, id), eq(orderVisitCrew.userId, actor.userId)));
      if (mine === undefined) throw new Refused(fail('not_found', 'That visit could not be found.'));
    }
    if (row.status !== 'on_site' && row.status !== 'completed') throw new Refused(fail('not_allowed', 'Materials are recorded once the crew is on site, until the work is signed off.'));
    return row;
  }

  /** Takes materials from a stock location for the visit: the stock leaves the shelf now, once for each line, and costs what the product costs now. */
  async useMaterial(actor: VisitActor, id: string, input: { productId: unknown; locationId?: unknown; quantity: unknown; note?: unknown }): Promise<DocResult<VisitView>> {
    const quantity = typeof input.quantity === 'number' ? input.quantity : Number.NaN;
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100_000 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-6) return fail('bad_input', 'Say how much was used: more than nothing, to at most three decimals.');
    if (typeof input.productId !== 'string' || input.productId === '' || input.productId.length > 100) return fail('bad_input', 'Choose the product that was used.');
    const productId = input.productId;
    if (input.locationId !== undefined && input.locationId !== null && input.locationId !== '' && (typeof input.locationId !== 'string' || !UUID.test(input.locationId))) return fail('bad_input', 'Choose where the materials were taken from.');
    return await this.run(async (tx) => {
      const row = await this.materialsOpen(tx, actor, id);
      const locationId = typeof input.locationId === 'string' && input.locationId !== '' ? input.locationId : (await this.ledger.defaultLocationIn(tx)).locationId;
      const [product] = await tx.select({ cost: products.costPrice, name: products.name }).from(products).where(eq(products.id, productId));
      if (product === undefined) return fail('not_found', 'That product could not be found.');
      const [made] = await tx
        .insert(orderVisitMaterials)
        .values({ visitId: id, productId, locationId, quantity: String(quantity), unitCost: product.cost, note: text(input.note, 200), recordedBy: actor.userId })
        .returning({ id: orderVisitMaterials.id });
      if (made === undefined) throw new Error('The material was not saved.');
      try {
        await this.ledger.post(tx, { companyId: actor.companyId, productId, locationId, type: 'sale_issue', quantity: -quantity, unitCost: Number(product.cost), documentType: 'visit', documentId: id, documentLineId: made.id, actor: { type: 'user', id: actor.userId }, note: `Used on the visit to order ${row.orderId}` });
      } catch (e) {
        // Thrown, not returned: the line just written must roll back with the refusal.
        if (e instanceof StockError) throw new Refused(fail(e.code === 'INSUFFICIENT' || e.code === 'NOT_FOUND' || e.code === 'INACTIVE' || e.code === 'NOT_INVENTORY' ? 'bad_input' : 'not_allowed', e.message));
        throw e;
      }
      await this.note(tx, actor, row.orderId, id, 'material_used', { productId, locationId, quantity });
      return await this.reloaded(tx, actor, id);
    });
  }

  /** Material that was not used goes back to where it came from. A line can be given back once, and in full. */
  async giveBackMaterial(actor: VisitActor, id: string, materialId: string, input: { reason: unknown }): Promise<DocResult<VisitView>> {
    if (!UUID.test(materialId)) return fail('not_found', 'That material could not be found.');
    const why = reasonProblem(input.reason, 'it is given back');
    if (why !== null) return fail('bad_input', why);
    const reason = String(input.reason).trim().slice(0, 200);
    return await this.run(async (tx) => {
      const row = await this.materialsOpen(tx, actor, id);
      const [line] = await tx.select().from(orderVisitMaterials).where(and(eq(orderVisitMaterials.id, materialId), eq(orderVisitMaterials.visitId, id))).for('update');
      if (line === undefined) return fail('not_found', 'That material is not on this visit.');
      if (Number(line.quantity) <= 0) return fail('not_allowed', 'That line is already a giving back.');
      const [again] = await tx.select({ id: orderVisitMaterials.id }).from(orderVisitMaterials).where(eq(orderVisitMaterials.reversesId, materialId));
      if (again !== undefined) return fail('conflict', 'That material was already given back.');
      const [made] = await tx
        .insert(orderVisitMaterials)
        .values({ visitId: id, productId: line.productId, locationId: line.locationId, quantity: String(-Number(line.quantity)), unitCost: line.unitCost, reversesId: line.id, note: reason, recordedBy: actor.userId })
        .returning({ id: orderVisitMaterials.id });
      if (made === undefined) throw new Error('The giving back was not saved.');
      await this.ledger.post(tx, { companyId: actor.companyId, productId: line.productId, locationId: line.locationId, type: 'sale_return', quantity: Number(line.quantity), unitCost: Number(line.unitCost), documentType: 'visit', documentId: id, documentLineId: made.id, actor: { type: 'user', id: actor.userId }, note: `Given back from the visit to order ${row.orderId}: ${reason}` });
      await this.note(tx, actor, row.orderId, id, 'material_given_back', { materialId, quantity: Number(line.quantity) }, reason);
      return await this.reloaded(tx, actor, id);
    });
  }

  private async reloaded(tx: Tx, actor: VisitActor, id: string): Promise<DocResult<VisitView>> {
    const [view] = await this.viewsIn(tx, actor.companyId, eq(orderVisits.id, id), 1);
    if (view === undefined) throw new Error('The visit vanished while it was locked.');
    return { ok: true, data: view };
  }
}
