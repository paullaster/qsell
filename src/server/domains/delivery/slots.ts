import { and, asc, eq, gte, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveries, deliveryClosedDays, deliveryLeadTimes, deliveryLines, deliveryMethods, deliverySlots, deliveryZones, orderDeliveries, orderSlotRequests, orders, products } from '@/server/db/drizzle/schema';
import { UNAVAILABLE_WORDS, checkLead, checkSlot, daysFrom, earliestReady, isDay, leadWords, nairobiDay, unavailable, weekdayOf, weekdaysWords, windowOf, type Lead, type SlotExtra, type SlotRule } from '@/lib/delivery-slot';
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
  maxWeightKg: number | null;
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
  /** What the slot can still carry that day in kg, when it has a weight limit. */
  weightLeftKg: number | null;
  available: boolean;
  why: string | null;
}

export interface OfferedDay {
  day: string;
  closedReason: string | null;
  slots: OfferedSlot[];
}

export interface LeadTimeView {
  id: string;
  kind: 'zone' | 'item';
  refId: string;
  name: string;
  minutes: number;
  words: string;
  note: string | null;
}

/** What is known of a delivery for booking: what it weighs and when its goods can first be ready, and what held them. */
interface Facts {
  weightKg: number;
  earliest: Date;
  by: string | null;
}

/** Goods and where they go, before any delivery exists. */
interface Basket {
  branchId: string;
  method: typeof deliveryMethods.$inferSelect['method'];
  zone: { id: string; name: string } | null;
  orderedAt: Date;
  lines: { productId: string; quantity: number }[];
}

/** What the shop's checkout knows of a basket, so slots can be offered for it. */
export interface BasketForSlots {
  method: Basket['method'];
  zone: Basket['zone'];
  lines: Basket['lines'];
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

const kgOf = (value: string | null): number | null => (value === null ? null : Number(value));
const ruleOf = (s: typeof deliverySlots.$inferSelect): SlotRule => ({ weekdays: s.weekdays, startsAt: s.startsAt, endsAt: s.endsAt, capacity: s.capacity, cutoffMinutes: s.cutoffMinutes, maxWeightKg: kgOf(s.maxWeightKg), isActive: s.isActive });
const storedKg = (kg: number | null): string | null => (kg === null ? null : kg.toFixed(2));
const nairobiWords = (d: Date): string => d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });

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
    return { id: s.id, branchId: s.branchId, branchName, name: s.name, weekdays: s.weekdays, weekdaysWords: weekdaysWords(s.weekdays), startsAt: s.startsAt, endsAt: s.endsAt, capacity: s.capacity, cutoffMinutes: s.cutoffMinutes, maxWeightKg: kgOf(s.maxWeightKg), isActive: s.isActive, version: s.version };
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
      const [made] = await tx.insert(deliverySlots).values({ companyId: actor.companyId, branchId, ...checked.value, maxWeightKg: storedKg(checked.value.maxWeightKg), createdBy: actor.userId }).returning();
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
      const [saved] = await tx.update(deliverySlots).set({ ...checked.value, maxWeightKg: storedKg(checked.value.maxWeightKg), version: row.version + 1, updatedAt: this.clock() }).where(eq(deliverySlots.id, id)).returning();
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

  /** How many deliveries hold each (slot, day), and what they weigh, in one query for all of them. A delivery's own hold is left out when it is the one being booked. */
  private async taken(db: DrizzleDb | Tx, slotIds: string[], days: string[], except?: string): Promise<Map<string, { n: number; kg: number }>> {
    if (slotIds.length === 0 || days.length === 0) return new Map();
    const rows = await db
      .select({ slotId: deliveries.slotId, day: deliveries.slotDay, n: sql<number>`count(distinct ${deliveries.id})::int`, kg: sql<string>`coalesce(sum(${deliveryLines.quantity} * ${products.weight}), 0)::text` })
      .from(deliveries)
      .leftJoin(deliveryLines, eq(deliveryLines.deliveryId, deliveries.id))
      .leftJoin(products, eq(products.id, deliveryLines.productId))
      .where(and(inArray(deliveries.slotId, slotIds), inArray(deliveries.slotDay, days), notInArray(deliveries.status, [...OFF]), except === undefined ? undefined : sql`${deliveries.id} <> ${except}::uuid`))
      .groupBy(deliveries.slotId, deliveries.slotDay);
    return new Map(rows.map((r) => [`${r.slotId ?? ''}|${r.day ?? ''}`, { n: r.n, kg: Number(r.kg) }]));
  }

  /** What a delivery weighs (goods without a weight count as nothing), and the earliest its goods can be ready: the order's time plus the longest of the branch's handling time, its zone's and its items'. */
  private async factsOf(db: DrizzleDb | Tx, companyId: string, deliveryId: string): Promise<Facts | null> {
    const [d] = await db
      .select({ branchId: deliveries.branchId, method: deliveries.method, orderedAt: orders.createdAt, charge: orderDeliveries.charge })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .leftJoin(orderDeliveries, eq(orderDeliveries.orderId, deliveries.orderId))
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, companyId)));
    if (d === undefined) return null;
    const lines = await db.select({ productId: deliveryLines.productId, quantity: deliveryLines.quantity }).from(deliveryLines).where(eq(deliveryLines.deliveryId, deliveryId));
    return await this.factsFrom(db, companyId, { branchId: d.branchId, method: d.method, zone: d.charge?.zone ?? null, orderedAt: d.orderedAt, lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) });
  }

  /** The same facts for goods that have no delivery yet: a basket being offered slots at the checkout, or an order about to be placed. */
  private async factsFrom(db: DrizzleDb | Tx, companyId: string, b: Basket): Promise<Facts> {
    const ids = [...new Set(b.lines.map((l) => l.productId))];
    const items = ids.length === 0 ? [] : await db.select({ id: products.id, weight: products.weight, name: products.name }).from(products).where(inArray(products.id, ids));
    const itemOf = new Map(items.map((i) => [i.id, i]));
    const zoneId = b.zone?.id ?? null;
    const refs = [...(zoneId === null ? [] : [zoneId]), ...ids];
    const [method, leads] = await Promise.all([
      db.select({ minutes: deliveryMethods.leadTimeMinutes }).from(deliveryMethods).where(and(eq(deliveryMethods.branchId, b.branchId), eq(deliveryMethods.method, b.method))),
      refs.length === 0 ? Promise.resolve([]) : db.select().from(deliveryLeadTimes).where(and(eq(deliveryLeadTimes.companyId, companyId), inArray(deliveryLeadTimes.refId, refs))),
    ]);
    const all: Lead[] = [{ label: 'The branch\'s own handling time', minutes: method[0]?.minutes ?? 0 }];
    for (const l of leads) {
      if (l.kind === 'zone' && l.refId === zoneId) all.push({ label: `The ${b.zone?.name ?? 'delivery'} zone`, minutes: l.minutes });
      if (l.kind === 'item') all.push({ label: itemOf.get(l.refId)?.name ?? 'An item', minutes: l.minutes });
    }
    const ready = earliestReady(b.orderedAt, all);
    return { weightKg: b.lines.reduce((n, l) => n + l.quantity * Number(itemOf.get(l.productId)?.weight ?? 0), 0), earliest: ready.at, by: ready.by };
  }

  /** The words for why a slot cannot be taken, with the time the goods are ready when that is why. */
  private whyWords(why: NonNullable<ReturnType<typeof unavailable>>, facts: Facts | null): string {
    if (why === 'too_soon' && facts !== null) return `The goods will not be ready until ${nairobiWords(facts.earliest)}${facts.by === null ? '' : ` (${facts.by})`}.`;
    return UNAVAILABLE_WORDS[why];
  }

  private extraFor(facts: Facts | null, takenKg: number): SlotExtra {
    return facts === null ? {} : { earliest: facts.earliest, weight: { kg: facts.weightKg, takenKg } };
  }

  private async closures(db: DrizzleDb | Tx, companyId: string, branchId: string, days: string[]): Promise<Map<string, string>> {
    const rows = await db
      .select({ day: deliveryClosedDays.day, reason: deliveryClosedDays.reason })
      .from(deliveryClosedDays)
      .where(and(eq(deliveryClosedDays.companyId, companyId), inArray(deliveryClosedDays.day, days), or(isNull(deliveryClosedDays.branchId), eq(deliveryClosedDays.branchId, branchId))));
    return new Map(rows.map((r) => [r.day, r.reason]));
  }

  private async factsForOffer(companyId: string, branchId: string, deliveryId: string | undefined, basket: BasketForSlots | undefined, now: Date): Promise<Facts | null> {
    if (deliveryId !== undefined) return await this.factsOf(this.db, companyId, deliveryId);
    return basket === undefined ? null : await this.factsFrom(this.db, companyId, { ...basket, branchId, orderedAt: now });
  }

  /** The slots a branch offers over some days from a day on, with the room left in each. */
  async offer(companyId: string, input: { branchId: unknown; from?: unknown; days?: unknown; deliveryId?: unknown; basket?: BasketForSlots }): Promise<OfferedDay[]> {
    if (typeof input.branchId !== 'string' || !UUID.test(input.branchId)) return [];
    const now = this.clock();
    const today = nairobiDay(now);
    const from = isDay(input.from) && input.from >= today ? input.from : today;
    const days = daysFrom(from, typeof input.days === 'number' ? input.days : 7);
    const slots = await this.db.select().from(deliverySlots).where(and(eq(deliverySlots.companyId, companyId), eq(deliverySlots.branchId, input.branchId), eq(deliverySlots.isActive, true))).orderBy(asc(deliverySlots.startsAt), asc(deliverySlots.name));
    const deliveryId = typeof input.deliveryId === 'string' && UUID.test(input.deliveryId) ? input.deliveryId : undefined;
    const [taken, closed, facts] = await Promise.all([this.taken(this.db, slots.map((s) => s.id), days, deliveryId), this.closures(this.db, companyId, input.branchId, days), this.factsForOffer(companyId, input.branchId, deliveryId, input.basket, now)]);
    return days.map((day) => ({
      day,
      closedReason: closed.get(day) ?? null,
      slots: slots
        .filter((s) => s.weekdays.includes(weekdayOf(day)))
        .map((s) => {
          const used = taken.get(`${s.id}|${day}`) ?? { n: 0, kg: 0 };
          const rule = ruleOf(s);
          const why = unavailable(rule, day, now, used.n, closed.get(day) ?? null, this.extraFor(facts, used.kg));
          return { slotId: s.id, name: s.name, startsAt: s.startsAt, endsAt: s.endsAt, capacity: s.capacity, left: Math.max(0, s.capacity - used.n), weightLeftKg: rule.maxWeightKg === null ? null : Math.max(0, Math.round((rule.maxWeightKg - used.kg) * 100) / 100), available: why === null, why: why === null ? null : this.whyWords(why, facts) };
        }),
    }));
  }

  /** The lead times set for zones and items, with the names they stand for. */
  async leadTimes(companyId: string): Promise<LeadTimeView[]> {
    const rows = await this.db.select().from(deliveryLeadTimes).where(eq(deliveryLeadTimes.companyId, companyId)).orderBy(asc(deliveryLeadTimes.kind), asc(deliveryLeadTimes.updatedAt)).limit(500);
    const zoneIds = rows.filter((r) => r.kind === 'zone' && UUID.test(r.refId)).map((r) => r.refId);
    const itemIds = rows.filter((r) => r.kind === 'item').map((r) => r.refId);
    const [zones, items] = await Promise.all([
      zoneIds.length === 0 ? Promise.resolve([]) : this.db.select({ id: deliveryZones.id, name: deliveryZones.name }).from(deliveryZones).where(inArray(deliveryZones.id, zoneIds)),
      itemIds.length === 0 ? Promise.resolve([]) : this.db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, itemIds)),
    ]);
    const names = new Map([...zones, ...items].map((x) => [x.id, x.name]));
    return rows.map((r) => ({ id: r.id, kind: r.kind, refId: r.refId, name: names.get(r.refId) ?? r.refId, minutes: r.minutes, words: leadWords(r.minutes), note: r.note }));
  }

  /** Sets how long the goods need before a delivery to a zone, or of an item, can go: a new one or a change to the one there. */
  async setLead(actor: DocActor, input: { kind: unknown; refId: unknown; minutes: unknown; note?: unknown }): Promise<DocResult<LeadTimeView>> {
    if (input.kind !== 'zone' && input.kind !== 'item') return fail('bad_input', 'Say whether the time is for a zone or an item.');
    const checked = checkLead(input.minutes, input.note);
    if (!checked.ok) return fail('bad_input', checked.error);
    if (typeof input.refId !== 'string' || input.refId === '' || input.refId.length > 100 || (input.kind === 'zone' && !UUID.test(input.refId))) return fail('bad_input', `Choose the ${input.kind}.`);
    const kind = input.kind;
    const refId = input.refId;
    return await this.run(async (tx) => {
      let name: string;
      if (kind === 'zone') {
        const [z] = await tx.select({ name: deliveryZones.name }).from(deliveryZones).where(and(eq(deliveryZones.id, refId), eq(deliveryZones.companyId, actor.companyId)));
        if (z === undefined) return fail('bad_input', 'Choose one of your delivery zones.');
        name = z.name;
      } else {
        const [p] = await tx.select({ name: products.name }).from(products).where(and(eq(products.id, refId), isNull(products.deletedAt)));
        if (p === undefined) return fail('bad_input', 'Choose one of your products.');
        name = p.name;
      }
      const [saved] = await tx
        .insert(deliveryLeadTimes)
        .values({ companyId: actor.companyId, kind, refId, minutes: checked.minutes, note: checked.note, updatedBy: actor.userId })
        .onConflictDoUpdate({ target: [deliveryLeadTimes.companyId, deliveryLeadTimes.kind, deliveryLeadTimes.refId], set: { minutes: checked.minutes, note: checked.note, updatedBy: actor.userId, updatedAt: this.clock() } })
        .returning();
      if (saved === undefined) throw new Error('The lead time was not saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_lead_time', id: saved.id }, action: 'delivery.lead_time_set', actor: { type: 'user', id: actor.userId }, inputs: { kind, refId, minutes: checked.minutes } }, tx);
      return { ok: true, data: { id: saved.id, kind, refId, name, minutes: saved.minutes, words: leadWords(saved.minutes), note: saved.note } };
    });
  }

  async removeLead(actor: DocActor, id: string): Promise<DocResult<{ id: string }>> {
    if (!UUID.test(id)) return fail('not_found', 'That lead time could not be found.');
    return await this.run(async (tx) => {
      const gone = await tx.delete(deliveryLeadTimes).where(and(eq(deliveryLeadTimes.id, id), eq(deliveryLeadTimes.companyId, actor.companyId))).returning({ kind: deliveryLeadTimes.kind, refId: deliveryLeadTimes.refId });
      if (gone.length === 0) return fail('not_found', 'That lead time could not be found.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_lead_time', id }, action: 'delivery.lead_time_removed', actor: { type: 'user', id: actor.userId }, inputs: gone[0] }, tx);
      return { ok: true, data: { id } };
    });
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
    return await this.run(async (tx) => await this.bookIn(tx, actor.companyId, deliveryId, slotId, day, { type: 'user', id: actor.userId }));
  }

  /**
   * The booking itself, inside a transaction the caller owns. `asOf` is the time cut-offs are judged at: a shopper's choice is judged at the time they
   * made it, so the hours staff take to make the delivery do not cost them the slot (a day already gone is still refused).
   */
  private async bookIn(tx: Tx, companyId: string, deliveryId: string, slotId: string, day: string, by: { type: 'user' | 'system'; id: string | null }, asOf?: Date): Promise<DocResult<HeldSlot>> {
    const now = this.clock();
    const [d] = await tx.select({ id: deliveries.id, status: deliveries.status, branchId: deliveries.branchId, version: deliveries.version, scheduledFor: deliveries.scheduledFor, orderId: deliveries.orderId }).from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, companyId))).for('update');
    if (d === undefined) return fail('not_found', 'That delivery could not be found.');
    if (!BOOKABLE.includes(d.status)) return fail('not_allowed', 'This delivery is already out or over, so its slot cannot be chosen.');
    const [slot] = await tx.select().from(deliverySlots).where(and(eq(deliverySlots.id, slotId), eq(deliverySlots.companyId, companyId))).for('update');
    if (slot === undefined) return fail('not_found', 'That slot could not be found.');
    if (slot.branchId !== d.branchId) return fail('bad_input', 'This delivery leaves from another branch, so it cannot take that branch\'s slot.');
    const w = windowOf(day, slot);
    if (asOf !== undefined && w.end <= now) return fail('not_allowed', 'That slot has already passed.');
    const [taken, closed, facts] = await Promise.all([this.taken(tx, [slotId], [day], deliveryId), this.closures(tx, companyId, slot.branchId, [day]), this.factsOf(tx, companyId, deliveryId)]);
    const used = taken.get(`${slotId}|${day}`) ?? { n: 0, kg: 0 };
    const why = unavailable(ruleOf(slot), day, asOf ?? now, used.n, closed.get(day) ?? null, this.extraFor(facts, used.kg));
    if (why !== null) return fail(why === 'full' || why === 'too_heavy' ? 'conflict' : 'not_allowed', this.whyWords(why, facts));
    await tx.update(deliveries).set({ slotId, slotDay: day, windowStart: w.start, windowEnd: w.end, slotBookedAt: now, slotBookedBy: by.id, scheduledFor: day, version: d.version + 1, updatedAt: now }).where(eq(deliveries.id, deliveryId));
    await this.decisions.record({ companyId, subject: { type: 'delivery', id: deliveryId }, action: 'delivery.slot_booked', actor: by, inputs: { slotId, day, windowStart: w.start.toISOString(), windowEnd: w.end.toISOString(), orderId: d.orderId, ...(asOf === undefined ? {} : { chosenAt: asOf.toISOString() }) } }, tx);
    return { ok: true, data: { slotId, name: slot.name, day, windowStart: w.start.toISOString(), windowEnd: w.end.toISOString(), bookedAt: now.toISOString() } };
  }

  // ── The shopper's choice at the checkout ─────────────────────────────────────────────────────────────────────────

  /**
   * Before an order is placed: whether the slot a shopper chose can take these goods from this branch. Nothing is held yet, so this is a look,
   * not a promise; the answer is the reason in words, or null when the slot is fine.
   */
  async checkRequest(companyId: string, input: { branchId: string; basket: BasketForSlots; slotId: unknown; day: unknown }): Promise<string | null> {
    if (typeof input.slotId !== 'string' || !UUID.test(input.slotId) || !isDay(input.day)) return 'Choose one of the delivery times shown.';
    const now = this.clock();
    const [slot] = await this.db.select().from(deliverySlots).where(and(eq(deliverySlots.id, input.slotId), eq(deliverySlots.companyId, companyId), eq(deliverySlots.branchId, input.branchId)));
    if (slot === undefined) return 'That delivery time is not offered for your order. Please choose another.';
    const [taken, closed, facts] = await Promise.all([this.taken(this.db, [slot.id], [input.day]), this.closures(this.db, companyId, slot.branchId, [input.day]), this.factsFrom(this.db, companyId, { ...input.basket, branchId: input.branchId, orderedAt: now })]);
    const used = taken.get(`${slot.id}|${input.day}`) ?? { n: 0, kg: 0 };
    const why = unavailable(ruleOf(slot), input.day, now, used.n, closed.get(input.day) ?? null, this.extraFor(facts, used.kg));
    return why === null ? null : `${this.whyWords(why, facts)} Please choose another delivery time.`;
  }

  /** Keeps the shopper's choice with the order, in the order's own transaction. It becomes a booking when the delivery is made. */
  async recordRequest(tx: Tx, companyId: string, orderId: string, input: { slotId: string; day: string }, actor: { type: 'user' | 'system'; id: string | null }): Promise<void> {
    await tx.insert(orderSlotRequests).values({ orderId, companyId, slotId: input.slotId, day: input.day });
    await this.decisions.record({ companyId, subject: { type: 'order', id: orderId }, action: 'order.slot_requested', actor, inputs: { slotId: input.slotId, day: input.day } }, tx);
  }

  /**
   * When a delivery is made for an order whose shopper chose a slot: books it. If the slot has filled or closed since, the delivery is made without
   * one and the request records why, so dispatch can call the customer; the sale and the delivery are never held back for a slot.
   */
  async honourRequest(tx: Tx, companyId: string, orderId: string, deliveryId: string): Promise<void> {
    const [req] = await tx.select().from(orderSlotRequests).where(and(eq(orderSlotRequests.orderId, orderId), eq(orderSlotRequests.companyId, companyId), eq(orderSlotRequests.outcome, 'pending'))).for('update');
    if (req === undefined) return;
    const now = this.clock();
    // A booking that fails writes nothing before it fails, so the transaction carries on with the delivery.
    const result = await this.bookIn(tx, companyId, deliveryId, req.slotId, req.day, { type: 'system', id: null }, req.requestedAt);
    await tx.update(orderSlotRequests).set(result.ok ? { outcome: 'booked', deliveryId, settledAt: now } : { outcome: 'unavailable', deliveryId, outcomeNote: result.message.slice(0, 300), settledAt: now }).where(eq(orderSlotRequests.orderId, orderId));
    if (!result.ok) await this.decisions.record({ companyId, subject: { type: 'delivery', id: deliveryId }, action: 'delivery.slot_request_unavailable', actor: { type: 'system', id: null }, reason: { code: result.reason, text: result.message }, inputs: { slotId: req.slotId, day: req.day, orderId } }, tx);
  }

  /** What the shopper asked for on an order and what became of it, or null when they chose nothing. */
  async requestFor(companyId: string, orderId: string): Promise<{ day: string; slotName: string; startsAt: string; endsAt: string; outcome: 'pending' | 'booked' | 'unavailable'; note: string | null } | null> {
    const [r] = await this.db
      .select({ day: orderSlotRequests.day, name: deliverySlots.name, startsAt: deliverySlots.startsAt, endsAt: deliverySlots.endsAt, outcome: orderSlotRequests.outcome, note: orderSlotRequests.outcomeNote })
      .from(orderSlotRequests)
      .innerJoin(deliverySlots, eq(deliverySlots.id, orderSlotRequests.slotId))
      .where(and(eq(orderSlotRequests.orderId, orderId), eq(orderSlotRequests.companyId, companyId)));
    return r === undefined ? null : { day: r.day, slotName: r.name, startsAt: r.startsAt, endsAt: r.endsAt, outcome: r.outcome, note: r.note };
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

