import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliveryCosts, deliveryPaySettings, deliveryRiders, deliveryShipments, financeSettings } from '@/server/db/drizzle/schema';
import { COST_WORDS, courierChargeProblem, dayPayKey, deliveryPayKey, isCostKind, money, readPayRules, reversalKey, type CostKind } from '@/lib/delivery-cost';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import type { DocActor, DocRefusal, DocResult } from './documents';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);
const PAGE = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PayView {
  perDelivery: string;
  perDay: string;
  version: number;
}

export interface CostView {
  id: string;
  kind: CostKind;
  kindWords: string;
  amount: string;
  currency: string;
  deliveryNumber: string | null;
  riderName: string | null;
  courierName: string | null;
  note: string | null;
  reverses: string | null;
  reversed: boolean;
  createdAt: string;
}

/**
 * What delivery costs. Rider pay is earned by the rider's own work and counted as it happens, in the same transaction: a delivery made
 * earns the rule's amount for a delivery, and closing a run on which something was delivered earns the amount for a day (once for a
 * rider and a day, however many runs they work). A courier's charge is typed in by someone with the right to. Every cost is kept for good;
 * a mistake is put right by a reversing entry with its reason. Nothing here touches the books (that is the posting of costs).
 */
export class DeliveryCosts {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  // ── The rules ────────────────────────────────────────────────────────────────────────────────────────────────────

  async pay(companyId: string): Promise<PayView> {
    const [row] = await this.db.select().from(deliveryPaySettings).where(eq(deliveryPaySettings.companyId, companyId));
    return { perDelivery: row?.perDelivery ?? '0.00', perDay: row?.perDay ?? '0.00', version: row?.version ?? 0 };
  }

  /** What a rider earns for a delivery and for a day. Versioned; every change is in the decision log. Pay already earned does not change. */
  async setPay(actor: DocActor, input: { perDelivery?: unknown; perDay?: unknown; expectedVersion?: unknown }): Promise<DocResult<PayView>> {
    const read = readPayRules(input.perDelivery, input.perDay);
    if (!read.ok) return fail('bad_input', read.error);
    const version = typeof input.expectedVersion === 'number' ? input.expectedVersion : 0;
    return await this.db.transaction(async (tx): Promise<DocResult<PayView>> => {
      await tx.insert(deliveryPaySettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliveryPaySettings).where(eq(deliveryPaySettings.companyId, actor.companyId)).for('update');
      if (row === undefined) return fail('not_found', 'The setting could not be found.');
      if (version !== 0 && version !== row.version) return fail('conflict', 'Someone else changed this while you were looking. Reload to see their change.');
      const next = { perDelivery: read.rules.perDelivery.toFixed(2), perDay: read.rules.perDay.toFixed(2) };
      if (row.perDelivery !== next.perDelivery || row.perDay !== next.perDay) {
        await tx.update(deliveryPaySettings).set({ ...next, version: row.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(deliveryPaySettings.companyId, actor.companyId));
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_pay', id: actor.companyId }, action: 'delivery_pay.rules_set', actor: { type: 'user', id: actor.userId }, from: `${row.perDelivery}/${row.perDay}`, to: `${next.perDelivery}/${next.perDay}` }, tx);
      }
      const changed = row.perDelivery !== next.perDelivery || row.perDay !== next.perDay;
      return { ok: true, data: { ...next, version: changed ? row.version + 1 : row.version } };
    });
  }

  private async currencyIn(tx: Tx | DrizzleDb, companyId: string): Promise<string> {
    const [fin] = await tx.select({ base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    return fin?.base ?? 'KES';
  }

  // ── Earned as it happens (inside the caller's transaction) ───────────────────────────────────────────────────────

  /** A rider made a delivery: the rule's amount for a delivery, once for that delivery. Nothing when the rule is nothing. */
  async accrueDeliveryIn(tx: Tx, input: { companyId: string; deliveryId: string; runId: string; riderId: string; actorId: string }): Promise<void> {
    const [rule] = await tx.select({ perDelivery: deliveryPaySettings.perDelivery }).from(deliveryPaySettings).where(eq(deliveryPaySettings.companyId, input.companyId));
    if (rule === undefined || Number(rule.perDelivery) <= 0) return;
    await tx
      .insert(deliveryCosts)
      .values({ companyId: input.companyId, kind: 'rider_delivery', amount: rule.perDelivery, currency: await this.currencyIn(tx, input.companyId), deliveryId: input.deliveryId, runId: input.runId, riderId: input.riderId, key: deliveryPayKey(input.deliveryId), actorId: input.actorId })
      .onConflictDoNothing();
  }

  /** A run was closed with something delivered on it: the rule's amount for a day, once for the rider and the day. */
  async accrueDayIn(tx: Tx, input: { companyId: string; runId: string; riderId: string | null; runDate: string; delivered: number; actorId: string }): Promise<void> {
    if (input.riderId === null || input.delivered <= 0) return;
    const [rule] = await tx.select({ perDay: deliveryPaySettings.perDay }).from(deliveryPaySettings).where(eq(deliveryPaySettings.companyId, input.companyId));
    if (rule === undefined || Number(rule.perDay) <= 0) return;
    await tx
      .insert(deliveryCosts)
      .values({ companyId: input.companyId, kind: 'rider_day', amount: rule.perDay, currency: await this.currencyIn(tx, input.companyId), runId: input.runId, riderId: input.riderId, key: dayPayKey(input.riderId, input.runDate), actorId: input.actorId })
      .onConflictDoNothing();
  }

  // ── Typed in ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** What a courier charged for a delivery sent with them. A delivery can have more than one charge (a surcharge, say). */
  async recordCourier(actor: DocActor, deliveryId: string, input: { amount?: unknown; note?: unknown }): Promise<DocResult<{ id: string }>> {
    const charge = courierChargeProblem(input.amount);
    if ('error' in charge) return fail('bad_input', charge.error);
    const note = text(input.note, 300);
    return await this.db.transaction(async (tx): Promise<DocResult<{ id: string }>> => {
      const [d] = await tx.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
      if (d === undefined) return fail('not_found', 'That delivery could not be found.');
      if (d.method !== 'courier') return fail('wrong_method', 'Only a delivery sent with a courier has a courier\'s charge.');
      const [s] = await tx.select({ courier: deliveryShipments.courierName }).from(deliveryShipments).where(eq(deliveryShipments.deliveryId, deliveryId));
      const courier = s?.courier ?? d.courierName;
      if (courier === null) return fail('not_allowed', 'Say which courier has it first (send the delivery out with a courier).');
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(deliveryCosts).where(and(eq(deliveryCosts.deliveryId, deliveryId), eq(deliveryCosts.kind, 'courier')));
      const [row] = await tx
        .insert(deliveryCosts)
        .values({ companyId: actor.companyId, kind: 'courier', amount: money(charge.cents), currency: await this.currencyIn(tx, actor.companyId), deliveryId, courierName: courier, note, key: `courier:${deliveryId}:${String(n + 1)}`, actorId: actor.userId })
        .returning({ id: deliveryCosts.id });
      if (row === undefined) throw new Error('The cost could not be saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id: deliveryId }, action: 'delivery.courier_cost', actor: { type: 'user', id: actor.userId }, outcome: { courier, amount: money(charge.cents) }, ...(note === null ? {} : { reason: { text: note } }) }, tx);
      return { ok: true, data: { id: row.id } };
    });
  }

  /** Takes a cost back, once, with the reason: a reversing entry for the same amount the other way. */
  async reverse(actor: DocActor, costId: string, input: { reason?: unknown }): Promise<DocResult<{ id: string }>> {
    const reason = text(input.reason, 300);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why this cost is being taken back, in a few words.');
    return await this.db.transaction(async (tx): Promise<DocResult<{ id: string }>> => {
      const [c] = await tx.select().from(deliveryCosts).where(and(eq(deliveryCosts.id, costId), eq(deliveryCosts.companyId, actor.companyId))).for('share');
      if (c === undefined) return fail('not_found', 'That cost could not be found.');
      if (c.reversesId !== null) return fail('not_allowed', 'That is already a reversal; it cannot be taken back.');
      const [again] = await tx.select({ id: deliveryCosts.id }).from(deliveryCosts).where(and(eq(deliveryCosts.companyId, actor.companyId), eq(deliveryCosts.key, reversalKey(costId))));
      if (again !== undefined) return fail('conflict', 'That cost has already been taken back.');
      const [row] = await tx
        .insert(deliveryCosts)
        .values({ companyId: actor.companyId, kind: c.kind, amount: money(-Math.round(Number(c.amount) * 100)), currency: c.currency, deliveryId: c.deliveryId, runId: c.runId, riderId: c.riderId, courierName: c.courierName, note: reason, key: reversalKey(costId), reversesId: c.id, actorId: actor.userId })
        .returning({ id: deliveryCosts.id });
      if (row === undefined) throw new Error('The reversal could not be saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_cost', id: costId }, action: 'delivery_cost.reversed', actor: { type: 'user', id: actor.userId }, reason: { text: reason }, outcome: { amount: c.amount } }, tx);
      return { ok: true, data: { id: row.id } };
    });
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private view(r: typeof deliveryCosts.$inferSelect, deliveryNumber: string | null, riderName: string | null, reversed: boolean): CostView {
    return { id: r.id, kind: r.kind, kindWords: COST_WORDS[r.kind], amount: r.amount, currency: r.currency, deliveryNumber, riderName, courierName: r.courierName, note: r.note, reverses: r.reversesId, reversed, createdAt: r.createdAt.toISOString() };
  }

  /** The costs of one delivery, oldest first, with those that have been taken back marked. */
  async forDelivery(companyId: string, deliveryId: string): Promise<CostView[]> {
    const rows = await this.db
      .select({ c: deliveryCosts, number: deliveries.number, rider: deliveryRiders.name })
      .from(deliveryCosts)
      .leftJoin(deliveries, eq(deliveries.id, deliveryCosts.deliveryId))
      .leftJoin(deliveryRiders, eq(deliveryRiders.id, deliveryCosts.riderId))
      .where(and(eq(deliveryCosts.companyId, companyId), eq(deliveryCosts.deliveryId, deliveryId)))
      .orderBy(deliveryCosts.createdAt, deliveryCosts.id);
    const taken = new Set(rows.flatMap((r) => (r.c.reversesId === null ? [] : [r.c.reversesId])));
    return rows.map((r) => this.view(r.c, r.number, r.rider, taken.has(r.c.id)));
  }

  /** Costs, newest first, one page at a time, by kind, rider and day range. */
  async list(companyId: string, input: { kind?: unknown; riderId?: unknown; from?: unknown; to?: unknown; cursor?: unknown }): Promise<{ rows: CostView[]; nextCursor: string | null }> {
    const kind = isCostKind(input.kind) ? input.kind : null;
    const riderId = typeof input.riderId === 'string' && input.riderId !== '' ? input.riderId : null;
    const from = typeof input.from === 'string' && DATE.test(input.from) ? input.from : null;
    const to = typeof input.to === 'string' && DATE.test(input.to) ? input.to : null;
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const rows = await this.db
      .select({ c: deliveryCosts, cursorKey: sql<string>`${deliveryCosts.createdAt}::text`, number: deliveries.number, rider: deliveryRiders.name })
      .from(deliveryCosts)
      .leftJoin(deliveries, eq(deliveries.id, deliveryCosts.deliveryId))
      .leftJoin(deliveryRiders, eq(deliveryRiders.id, deliveryCosts.riderId))
      .where(
        and(
          eq(deliveryCosts.companyId, companyId),
          kind === null ? undefined : eq(deliveryCosts.kind, kind),
          riderId === null ? undefined : eq(deliveryCosts.riderId, riderId),
          from === null ? undefined : gte(deliveryCosts.createdAt, sql`(${from}::date)::timestamptz`),
          to === null ? undefined : lt(deliveryCosts.createdAt, sql`((${to}::date) + 1)::timestamptz`),
          after === null ? undefined : sql`(${deliveryCosts.createdAt}, ${deliveryCosts.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(deliveryCosts.createdAt), desc(deliveryCosts.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    // Which of these have been taken back: one read of the reversals that name them, not of every reversal there is.
    const reversedIds = page.length === 0 ? new Set<string>() : new Set((await this.db.select({ r: deliveryCosts.reversesId }).from(deliveryCosts).where(and(eq(deliveryCosts.companyId, companyId), inArray(deliveryCosts.reversesId, page.map((p) => p.c.id))))).map((x) => x.r ?? ''));
    const last = page[page.length - 1];
    return { rows: page.map((r) => this.view(r.c, r.number, r.rider, reversedIds.has(r.c.id))), nextCursor: rows.length > PAGE && last !== undefined ? encodeCursor({ k: last.cursorKey, id: last.c.id }) : null };
  }
}
