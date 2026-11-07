import { and, asc, eq, gte, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveries, deliveryClosedDays, deliverySlots } from '@/server/db/drizzle/schema';
import { UNAVAILABLE_WORDS, checkSlot, daysFrom, isDay, nairobiDay, unavailable, weekdayOf, weekdaysWords, windowOf, type SlotRule, type Unavailable } from '@/lib/delivery-slot';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DocActor, DocRefusal, DocResult } from './documents';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface SlotView {
  id: string;
  branchId: string;
  branchName: string;
  name: string;
  weekdays: number[];
  weekdaysWords: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  cutoffMinutes: number;
  isActive: boolean;
  version: number;
}

export interface ClosedDayView {
  id: string;
  day: string;
  branchId: string | null;
  branchName: string | null;
  reason: string;
}

export interface OfferedSlot {
  slotId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  left: number;
  available: boolean;
  why: string | null;
}

export interface OfferedDay {
  day: string;
  closedReason: string | null;
  slots: OfferedSlot[];
}

/** The slot a delivery holds, in words, or null when it holds none. */
export interface HeldSlot {
  slotId: string;
  name: string;
  day: string;
  windowStart: string;
  windowEnd: string;
  bookedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

class Refused extends Error {
  constructor(readonly refusal: { ok: false; reason: DocRefusal; message: string }) {
    super(refusal.message);
  }
}

/** A delivery that is finished or cancelled no longer holds room in a slot. */
const OFF = ['cancelled', 'returned'] as const;
/** The deliveries whose slot can still be chosen: not out, not over. */
const BOOKABLE = ['draft', 'released', 'picking', 'packed', 'ready', 'failed_attempt'];

const ruleOf = (s: typeof deliverySlots.$inferSelect): SlotRule => ({ weekdays: s.weekdays, startsAt: s.startsAt, endsAt: s.endsAt, capacity: s.capacity, cutoffMinutes: s.cutoffMinutes, isActive: s.isActive });

/**
 * Delivery slots with room for so many deliveries a day. Booking locks the slot while it counts, so two people booking the last place at the
 * same time cannot both get it. The window promised is kept on the delivery as it was when booked.
 */
export class DeliverySlots {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
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

  private view(s: typeof deliverySlots.$inferSelect, branchName: string): SlotView {
    return { id: s.id, branchId: s.branchId, branchName, name: s.name, weekdays: s.weekdays, weekdaysWords: weekdaysWords(s.weekdays), startsAt: s.startsAt, endsAt: s.endsAt, capacity: s.capacity, cutoffMinutes: s.cutoffMinutes, isActive: s.isActive, version: s.version };
  }

  async list(companyId: string, input: { branchId?: unknown } = {}): Promise<SlotView[]> {
    const branchId = typeof input.branchId === 'string' && UUID.test(input.branchId) ? input.branchId : null;
    const rows = await this.db
      .select({ s: deliverySlots, branchName: branches.name })
      .from(deliverySlots)
      .innerJoin(branches, eq(branches.id, deliverySlots.branchId))
      .where(and(eq(deliverySlots.companyId, companyId), branchId === null ? undefined : eq(deliverySlots.branchId, branchId)))
      .orderBy(asc(branches.name), asc(deliverySlots.startsAt), asc(deliverySlots.name))
      .limit(500);
    return rows.map((r) => this.view(r.s, r.branchName));
  }

  async create(actor: DocActor, input: Record<string, unknown>): Promise<DocResult<SlotView>> {
    const checked = checkSlot(input);
    if (!checked.ok) return fail('bad_input', checked.error);
    if (typeof input.branchId !== 'string' || !UUID.test(input.branchId)) return fail('bad_input', 'Choose the branch the slot is for.');
    const branchId = input.branchId;
    return await this.run(async (tx) => {
      const [branch] = await tx.select({ name: branches.name, isActive: branches.isActive }).from(branches).where(and(eq(branches.id, branchId), eq(branches.companyId, actor.companyId)));
      if (branch?.isActive !== true) return fail('bad_input', 'Choose one of your open branches.');
      const [same] = await tx.select({ id: deliverySlots.id }).from(deliverySlots).where(and(eq(deliverySlots.companyId, actor.companyId), eq(deliverySlots.branchId, branchId), eq(deliverySlots.name, checked.value.name)));
      if (same !== undefined) return fail('conflict', 'This branch already has a slot with that name.');
      const [made] = await tx.insert(deliverySlots).values({ companyId: actor.companyId, branchId, ...checked.value, createdBy: actor.userId }).returning();
      if (made === undefined) throw new Error('The slot was not saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_slot', id: made.id }, action: 'delivery.slot_created', actor: { type: 'user', id: actor.userId }, inputs: { ...checked.value, branchId } }, tx);
      return { ok: true, data: this.view(made, branch.name) };
    });
  }

  /** Changes what a slot offers from now on. Deliveries already promised it keep the window they were promised. */
  async update(actor: DocActor, id: string, input: Record<string, unknown>): Promise<DocResult<SlotView>> {
    if (!UUID.test(id)) return fail('not_found', 'That slot could not be found.');
    const checked = checkSlot(input);
    if (!checked.ok) return fail('bad_input', checked.error);
    return await this.run(async (tx) => {
      const [row] = await tx.select().from(deliverySlots).where(and(eq(deliverySlots.id, id), eq(deliverySlots.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That slot could not be found.');
      if (input.expectedVersion !== row.version) return fail('conflict', 'Someone else changed this slot. Reload to see the latest.');
      const [same] = await tx.select({ id: deliverySlots.id }).from(deliverySlots).where(and(eq(deliverySlots.companyId, actor.companyId), eq(deliverySlots.branchId, row.branchId), eq(deliverySlots.name, checked.value.name)));
      if (same !== undefined && same.id !== id) return fail('conflict', 'This branch already has a slot with that name.');
      const [saved] = await tx.update(deliverySlots).set({ ...checked.value, version: row.version + 1, updatedAt: this.clock() }).where(eq(deliverySlots.id, id)).returning();
      if (saved === undefined) throw new Error('The slot was not saved.');
      const [branch] = await tx.select({ name: branches.name }).from(branches).where(eq(branches.id, row.branchId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_slot', id }, action: 'delivery.slot_changed', actor: { type: 'user', id: actor.userId }, inputs: { before: { name: row.name, weekdays: row.weekdays, startsAt: row.startsAt, endsAt: row.endsAt, capacity: row.capacity, cutoffMinutes: row.cutoffMinutes }, after: checked.value } }, tx);
      return { ok: true, data: this.view(saved, branch?.name ?? '') };
    });
  }

  /** Stops offering a slot, or offers it again. */
  async setActive(actor: DocActor, id: string, input: { isActive: unknown; expectedVersion: unknown }): Promise<DocResult<SlotView>> {
    if (!UUID.test(id)) return fail('not_found', 'That slot could not be found.');
    if (typeof input.isActive !== 'boolean') return fail('bad_input', 'Say whether the slot is offered.');
    const on = input.isActive;
    return await this.run(async (tx) => {
      const [row] = await tx.select().from(deliverySlots).where(and(eq(deliverySlots.id, id), eq(deliverySlots.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That slot could not be found.');
      if (input.expectedVersion !== row.version) return fail('conflict', 'Someone else changed this slot. Reload to see the latest.');
      const [saved] = await tx.update(deliverySlots).set({ isActive: on, version: row.version + 1, updatedAt: this.clock() }).where(eq(deliverySlots.id, id)).returning();
      if (saved === undefined) throw new Error('The slot was not saved.');
      const [branch] = await tx.select({ name: branches.name }).from(branches).where(eq(branches.id, row.branchId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_slot', id }, action: on ? 'delivery.slot_resumed' : 'delivery.slot_stopped', actor: { type: 'user', id: actor.userId } }, tx);
      return { ok: true, data: this.view(saved, branch?.name ?? '') };
    });
  }

  async closedDays(companyId: string, now: Date = this.clock()): Promise<ClosedDayView[]> {
    const rows = await this.db
      .select({ c: deliveryClosedDays, branchName: branches.name })
      .from(deliveryClosedDays)
      .leftJoin(branches, eq(branches.id, deliveryClosedDays.branchId))
      .where(and(eq(deliveryClosedDays.companyId, companyId), gte(deliveryClosedDays.day, nairobiDay(now))))
      .orderBy(asc(deliveryClosedDays.day), asc(deliveryClosedDays.id))
      .limit(200);
    return rows.map((r) => ({ id: r.c.id, day: r.c.day, branchId: r.c.branchId, branchName: r.branchName, reason: r.c.reason }));
  }

  /** No slot is offered on this day, at one branch or at all of them. Deliveries already promised that day are not moved. */
  async close(actor: DocActor, input: { day: unknown; branchId?: unknown; reason: unknown }): Promise<DocResult<ClosedDayView>> {
    if (!isDay(input.day)) return fail('bad_input', 'Choose the day.');
    const reason = text(input.reason, 120);
    if (reason === null || reason.length < 3) return fail('bad_input', 'Say why, for example "Public holiday".');
    if (input.day < nairobiDay(this.clock())) return fail('bad_input', 'That day has passed.');
    const branchId = typeof input.branchId === 'string' && input.branchId !== '' ? input.branchId : null;
    if (branchId !== null && !UUID.test(branchId)) return fail('bad_input', 'Choose one of your branches, or leave it empty for all.');
    const day = input.day;
    return await this.run(async (tx) => {
      let branchName: string | null = null;
      if (branchId !== null) {
        const [b] = await tx.select({ name: branches.name }).from(branches).where(and(eq(branches.id, branchId), eq(branches.companyId, actor.companyId)));
        if (b === undefined) return fail('bad_input', 'Choose one of your branches, or leave it empty for all.');
        branchName = b.name;
      }
      const [same] = await tx.select({ id: deliveryClosedDays.id }).from(deliveryClosedDays).where(and(eq(deliveryClosedDays.companyId, actor.companyId), eq(deliveryClosedDays.day, day), branchId === null ? isNull(deliveryClosedDays.branchId) : eq(deliveryClosedDays.branchId, branchId)));
      if (same !== undefined) return fail('conflict', 'That day is already closed.');
      const [made] = await tx.insert(deliveryClosedDays).values({ companyId: actor.companyId, branchId, day, reason, createdBy: actor.userId }).returning();
      if (made === undefined) throw new Error('The day was not saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_closed_day', id: made.id }, action: 'delivery.day_closed', actor: { type: 'user', id: actor.userId }, reason: { text: reason }, inputs: { day, branchId } }, tx);
      return { ok: true, data: { id: made.id, day, branchId, branchName, reason } };
    });
  }

  async reopen(actor: DocActor, id: string): Promise<DocResult<{ id: string }>> {
    if (!UUID.test(id)) return fail('not_found', 'That day could not be found.');
    return await this.run(async (tx) => {
      const gone = await tx.delete(deliveryClosedDays).where(and(eq(deliveryClosedDays.id, id), eq(deliveryClosedDays.companyId, actor.companyId))).returning({ day: deliveryClosedDays.day });
      if (gone.length === 0) return fail('not_found', 'That day could not be found.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_closed_day', id }, action: 'delivery.day_reopened', actor: { type: 'user', id: actor.userId }, inputs: { day: gone[0]?.day } }, tx);
      return { ok: true, data: { id } };
    });
  }

  /** How many deliveries hold each (slot, day), in one query for all of them. A delivery's own hold is left out when it is the one being booked. */
  private async taken(db: DrizzleDb | Tx, slotIds: string[], days: string[], except?: string): Promise<Map<string, number>> {
    if (slotIds.length === 0 || days.length === 0) return new Map();
    const rows = await db
      .select({ slotId: deliveries.slotId, day: deliveries.slotDay, n: sql<number>`count(*)::int` })
      .from(deliveries)
      .where(and(inArray(deliveries.slotId, slotIds), inArray(deliveries.slotDay, days), notInArray(deliveries.status, [...OFF]), except === undefined ? undefined : sql`${deliveries.id} <> ${except}::uuid`))
      .groupBy(deliveries.slotId, deliveries.slotDay);
    return new Map(rows.map((r) => [`${r.slotId ?? ''}|${r.day ?? ''}`, r.n]));
  }

  private async closures(db: DrizzleDb | Tx, companyId: string, branchId: string, days: string[]): Promise<Map<string, string>> {
    const rows = await db
      .select({ day: deliveryClosedDays.day, reason: deliveryClosedDays.reason })
      .from(deliveryClosedDays)
      .where(and(eq(deliveryClosedDays.companyId, companyId), inArray(deliveryClosedDays.day, days), or(isNull(deliveryClosedDays.branchId), eq(deliveryClosedDays.branchId, branchId))));
    return new Map(rows.map((r) => [r.day, r.reason]));
  }

  /** The slots a branch offers over some days from a day on, with the room left in each. */
  async offer(companyId: string, input: { branchId: unknown; from?: unknown; days?: unknown }): Promise<OfferedDay[]> {
    if (typeof input.branchId !== 'string' || !UUID.test(input.branchId)) return [];
    const now = this.clock();
    const today = nairobiDay(now);
    const from = isDay(input.from) && input.from >= today ? input.from : today;
    const days = daysFrom(from, typeof input.days === 'number' ? input.days : 7);
    const slots = await this.db.select().from(deliverySlots).where(and(eq(deliverySlots.companyId, companyId), eq(deliverySlots.branchId, input.branchId), eq(deliverySlots.isActive, true))).orderBy(asc(deliverySlots.startsAt), asc(deliverySlots.name));
    const [taken, closed] = await Promise.all([this.taken(this.db, slots.map((s) => s.id), days), this.closures(this.db, companyId, input.branchId, days)]);
    return days.map((day) => ({
      day,
      closedReason: closed.get(day) ?? null,
      slots: slots
        .filter((s) => s.weekdays.includes(weekdayOf(day)))
        .map((s) => {
          const used = taken.get(`${s.id}|${day}`) ?? 0;
          const why: Unavailable | null = unavailable(ruleOf(s), day, now, used, closed.get(day) ?? null);
          return { slotId: s.id, name: s.name, startsAt: s.startsAt, endsAt: s.endsAt, capacity: s.capacity, left: Math.max(0, s.capacity - used), available: why === null, why: why === null ? null : UNAVAILABLE_WORDS[why] };
        }),
    }));
  }

  /** The slot a delivery holds now, or null. */
  async heldBy(companyId: string, deliveryId: string): Promise<HeldSlot | null> {
    if (!UUID.test(deliveryId)) return null;
    const [row] = await this.db
      .select({ slotId: deliveries.slotId, name: deliverySlots.name, day: deliveries.slotDay, ws: deliveries.windowStart, we: deliveries.windowEnd, at: deliveries.slotBookedAt })
      .from(deliveries)
      .leftJoin(deliverySlots, eq(deliverySlots.id, deliveries.slotId))
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, companyId)));
    if (row?.slotId == null || row.day === null || row.ws === null || row.we === null || row.at === null) return null;
    return { slotId: row.slotId, name: row.name ?? '', day: row.day, windowStart: row.ws.toISOString(), windowEnd: row.we.toISOString(), bookedAt: row.at.toISOString() };
  }

  /** Promises a delivery a slot on a day (replacing the one it held). The slot is locked while it is counted, so the last place goes to one. */
  async book(actor: DocActor, deliveryId: string, input: { slotId: unknown; day: unknown }): Promise<DocResult<HeldSlot>> {
    if (!UUID.test(deliveryId)) return fail('not_found', 'That delivery could not be found.');
    if (typeof input.slotId !== 'string' || !UUID.test(input.slotId)) return fail('bad_input', 'Choose a slot.');
    if (!isDay(input.day)) return fail('bad_input', 'Choose the day.');
    const slotId = input.slotId;
    const day = input.day;
    return await this.run(async (tx) => {
      const [d] = await tx.select({ id: deliveries.id, status: deliveries.status, branchId: deliveries.branchId, version: deliveries.version, scheduledFor: deliveries.scheduledFor, orderId: deliveries.orderId }).from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
      if (d === undefined) return fail('not_found', 'That delivery could not be found.');
      if (!BOOKABLE.includes(d.status)) return fail('not_allowed', 'This delivery is already out or over, so its slot cannot be chosen.');
      const [slot] = await tx.select().from(deliverySlots).where(and(eq(deliverySlots.id, slotId), eq(deliverySlots.companyId, actor.companyId))).for('update');
      if (slot === undefined) return fail('not_found', 'That slot could not be found.');
      if (slot.branchId !== d.branchId) return fail('bad_input', 'This delivery leaves from another branch, so it cannot take that branch\'s slot.');
      const [taken, closed] = await Promise.all([this.taken(tx, [slotId], [day], deliveryId), this.closures(tx, actor.companyId, slot.branchId, [day])]);
      const why = unavailable(ruleOf(slot), day, this.clock(), taken.get(`${slotId}|${day}`) ?? 0, closed.get(day) ?? null);
      if (why !== null) return fail(why === 'full' ? 'conflict' : 'not_allowed', UNAVAILABLE_WORDS[why]);
      const w = windowOf(day, slot);
      const now = this.clock();
      await tx.update(deliveries).set({ slotId, slotDay: day, windowStart: w.start, windowEnd: w.end, slotBookedAt: now, slotBookedBy: actor.userId, scheduledFor: day, version: d.version + 1, updatedAt: now }).where(eq(deliveries.id, deliveryId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id: deliveryId }, action: 'delivery.slot_booked', actor: { type: 'user', id: actor.userId }, inputs: { slotId, day, windowStart: w.start.toISOString(), windowEnd: w.end.toISOString(), orderId: d.orderId } }, tx);
      return { ok: true, data: { slotId, name: slot.name, day, windowStart: w.start.toISOString(), windowEnd: w.end.toISOString(), bookedAt: now.toISOString() } };
    });
  }

  /** Lets go of the slot a delivery holds, with a reason, so another can have it. */
  async release(actor: DocActor, deliveryId: string, input: { reason: unknown }): Promise<DocResult<{ id: string }>> {
    if (!UUID.test(deliveryId)) return fail('not_found', 'That delivery could not be found.');
    const reason = text(input.reason, 200);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why the slot is let go, in a few words.');
    return await this.run(async (tx) => {
      const [d] = await tx.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
      if (d === undefined) return fail('not_found', 'That delivery could not be found.');
      if (d.slotId === null) return fail('not_allowed', 'This delivery holds no slot.');
      if (!BOOKABLE.includes(d.status)) return fail('not_allowed', 'This delivery is already out or over, so its slot cannot be let go.');
      await tx.update(deliveries).set({ slotId: null, slotDay: null, windowStart: null, windowEnd: null, slotBookedAt: null, slotBookedBy: null, scheduledFor: d.scheduledFor === d.slotDay ? null : d.scheduledFor, version: d.version + 1, updatedAt: this.clock() }).where(eq(deliveries.id, deliveryId));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id: deliveryId }, action: 'delivery.slot_released', actor: { type: 'user', id: actor.userId }, reason: { text: reason }, inputs: { slotId: d.slotId, day: d.slotDay } }, tx);
      return { ok: true, data: { id: deliveryId } };
    });
  }
}

