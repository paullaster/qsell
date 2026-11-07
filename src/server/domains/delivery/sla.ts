import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveries, deliverySlaAcks, deliverySlaEvents, deliverySlaSettings, orders } from '@/server/db/drizzle/schema';
import { DEFAULT_AT_RISK_MINUTES, DEFAULT_ESCALATE_MINUTES, LEVEL_WORDS, SLA_WORDS, checkSlaSettings, levelsReached, slaState, type EscalationLevel, type SlaState } from '@/lib/delivery-sla';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DocActor, DocRefusal, DocResult } from './documents';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface SlaSettingsView {
  atRiskMinutes: number;
  escalateAfterMinutes: number;
  version: number;
}

export interface LateDelivery {
  deliveryId: string;
  number: string;
  orderNumber: string;
  customerName: string;
  branchName: string;
  status: string;
  windowStart: string;
  windowEnd: string;
  state: SlaState;
  stateWords: string;
  /** Minutes past the end of the window, or 0 when it is only at risk. */
  minutesLate: number;
  /** The highest level reached so far and what it means in words. */
  level: EscalationLevel | null;
  levelWords: string | null;
  raisedAt: string | null;
  acknowledged: { by: string; at: string; note: string | null } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const ORDER_OF: Record<EscalationLevel, number> = { at_risk: 1, late: 2, escalated: 3 };
/** A delivery that is finished or cancelled is no longer expected, so it is not watched. */
const CLOSED = ['cancelled', 'returned', 'delivered'] as const;

/**
 * Lateness against the promised window. A worker scans the deliveries that were promised a window and raises an event the first time each
 * reaches a level (at risk, late, still late: the supervisor); people see them on the Late deliveries screen and acknowledge them with a
 * note. Events are raised once for each delivery, level and window, so scanning again changes nothing.
 */
export class DeliverySla {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async settings(companyId: string): Promise<SlaSettingsView> {
    const [row] = await this.db.select().from(deliverySlaSettings).where(eq(deliverySlaSettings.companyId, companyId));
    return { atRiskMinutes: row?.atRiskMinutes ?? DEFAULT_AT_RISK_MINUTES, escalateAfterMinutes: row?.escalateAfterMinutes ?? DEFAULT_ESCALATE_MINUTES, version: row?.version ?? 1 };
  }

  async setSettings(actor: DocActor, input: { atRiskMinutes: unknown; escalateAfterMinutes: unknown; expectedVersion: unknown }): Promise<DocResult<SlaSettingsView>> {
    const checked = checkSlaSettings(input);
    if (!checked.ok) return fail('bad_input', checked.error);
    return await this.db.transaction(async (tx): Promise<DocResult<SlaSettingsView>> => {
      await tx.insert(deliverySlaSettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliverySlaSettings).where(eq(deliverySlaSettings.companyId, actor.companyId)).for('update');
      if (row === undefined) throw new Error('The settings could not be read.');
      if (input.expectedVersion !== row.version) return fail('conflict', 'Someone else changed these settings. Reload to see the latest.');
      const [saved] = await tx.update(deliverySlaSettings).set({ atRiskMinutes: checked.atRiskMinutes, escalateAfterMinutes: checked.escalateAfterMinutes, version: row.version + 1, updatedBy: actor.userId, updatedAt: this.clock() }).where(eq(deliverySlaSettings.companyId, actor.companyId)).returning();
      if (saved === undefined) throw new Error('The settings were not saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_sla_settings', id: actor.companyId }, action: 'delivery.sla_settings_changed', actor: { type: 'user', id: actor.userId }, inputs: { before: { atRiskMinutes: row.atRiskMinutes, escalateAfterMinutes: row.escalateAfterMinutes }, after: { atRiskMinutes: checked.atRiskMinutes, escalateAfterMinutes: checked.escalateAfterMinutes } } }, tx);
      return { ok: true, data: { atRiskMinutes: saved.atRiskMinutes, escalateAfterMinutes: saved.escalateAfterMinutes, version: saved.version } };
    });
  }

  /** Raises the events deliveries have reached by now. Cheap when nothing is late: only deliveries with a window not yet over are read. */
  async scan(now: Date = this.clock(), limit = 500): Promise<{ checked: number; raised: number }> {
    const rows = await this.db
      .select({ id: deliveries.id, companyId: deliveries.companyId, status: deliveries.status, windowStart: deliveries.windowStart, windowEnd: deliveries.windowEnd, deliveredAt: deliveries.deliveredAt, atRisk: sql<number>`coalesce(${deliverySlaSettings.atRiskMinutes}, ${DEFAULT_AT_RISK_MINUTES})`, escalate: sql<number>`coalesce(${deliverySlaSettings.escalateAfterMinutes}, ${DEFAULT_ESCALATE_MINUTES})` })
      .from(deliveries)
      .leftJoin(deliverySlaSettings, eq(deliverySlaSettings.companyId, deliveries.companyId))
      .where(and(isNotNull(deliveries.windowEnd), notInArray(deliveries.status, [...CLOSED]), sql`${deliveries.windowStart} - make_interval(mins => coalesce(${deliverySlaSettings.atRiskMinutes}, ${DEFAULT_AT_RISK_MINUTES})) <= ${now.toISOString()}::timestamptz`))
      .orderBy(asc(deliveries.windowEnd))
      .limit(limit);
    let raised = 0;
    for (const r of rows) {
      const end = r.windowEnd;
      if (end === null) continue;
      const state = slaState({ windowStart: r.windowStart, windowEnd: end, status: r.status, deliveredAt: r.deliveredAt, now, atRiskMinutes: r.atRisk });
      const levels = levelsReached({ state, windowEnd: end, now, escalateAfterMinutes: r.escalate });
      if (levels.length === 0) continue;
      const minutesLate = Math.max(0, Math.floor((now.getTime() - end.getTime()) / 60_000));
      const made = await this.db
        .insert(deliverySlaEvents)
        .values(levels.map((level) => ({ companyId: r.companyId, deliveryId: r.id, level, windowEnd: end, minutesLate: level === 'at_risk' ? 0 : minutesLate })))
        .onConflictDoNothing()
        .returning({ id: deliverySlaEvents.id, level: deliverySlaEvents.level });
      for (const e of made) {
        raised += 1;
        await this.decisions.record({ companyId: r.companyId, subject: { type: 'delivery', id: r.id }, action: `delivery.sla_${e.level}`, actor: { type: 'system', id: 'delivery-sla-scan' }, inputs: { windowEnd: end.toISOString(), minutesLate } });
      }
    }
    return { checked: rows.length, raised };
  }

  /** The deliveries that are at risk or late now, most overdue first, with the highest level raised and whether someone has acknowledged it. */
  async overview(companyId: string, now: Date = this.clock()): Promise<LateDelivery[]> {
    const settings = await this.settings(companyId);
    const rows = await this.db
      .select({ d: deliveries, orderNumber: orders.orderNumber, customerName: orders.customerName, branchName: branches.name })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .innerJoin(branches, eq(branches.id, deliveries.branchId))
      .where(and(eq(deliveries.companyId, companyId), isNotNull(deliveries.windowEnd), notInArray(deliveries.status, [...CLOSED]), sql`${deliveries.windowStart} - make_interval(mins => ${settings.atRiskMinutes}) <= ${now.toISOString()}::timestamptz`))
      .orderBy(asc(deliveries.windowEnd), asc(deliveries.id))
      .limit(200);
    if (rows.length === 0) return [];
    const events = await this.db
      .select({ e: deliverySlaEvents, ackBy: deliverySlaAcks.acknowledgedBy, ackAt: deliverySlaAcks.acknowledgedAt, ackNote: deliverySlaAcks.note })
      .from(deliverySlaEvents)
      .leftJoin(deliverySlaAcks, eq(deliverySlaAcks.eventId, deliverySlaEvents.id))
      .where(inArray(deliverySlaEvents.deliveryId, rows.map((r) => r.d.id)))
      .orderBy(desc(deliverySlaEvents.raisedAt));
    const out: LateDelivery[] = [];
    for (const r of rows) {
      const ws = r.d.windowStart;
      const we = r.d.windowEnd;
      if (ws === null || we === null) continue;
      const state = slaState({ windowStart: ws, windowEnd: we, status: r.d.status, deliveredAt: r.d.deliveredAt, now, atRiskMinutes: settings.atRiskMinutes });
      if (state !== 'at_risk' && state !== 'late') continue;
      const mine = events.filter((x) => x.e.deliveryId === r.d.id && x.e.windowEnd.getTime() === we.getTime());
      const top = [...mine].sort((a, b) => ORDER_OF[b.e.level] - ORDER_OF[a.e.level])[0];
      const acked = mine.find((x) => x.ackBy !== null && x.ackAt !== null);
      out.push({
        deliveryId: r.d.id,
        number: r.d.number,
        orderNumber: r.orderNumber,
        customerName: r.customerName,
        branchName: r.branchName,
        status: r.d.status,
        windowStart: ws.toISOString(),
        windowEnd: we.toISOString(),
        state,
        stateWords: SLA_WORDS[state],
        minutesLate: state === 'late' ? Math.floor((now.getTime() - we.getTime()) / 60_000) : 0,
        level: top?.e.level ?? null,
        levelWords: top === undefined ? null : LEVEL_WORDS[top.e.level],
        raisedAt: top?.e.raisedAt.toISOString() ?? null,
        acknowledged: acked?.ackBy == null || acked.ackAt === null ? null : { by: acked.ackBy, at: acked.ackAt.toISOString(), note: acked.ackNote },
      });
    }
    return out;
  }

  /** Says the lateness of a delivery has been seen, and what is being done about it. Covers every level raised so far for its current window. */
  async acknowledge(actor: DocActor, deliveryId: string, input: { note: unknown }): Promise<DocResult<{ acknowledged: number }>> {
    if (!UUID.test(deliveryId)) return fail('not_found', 'That delivery could not be found.');
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length < 5 || note.length > 300) return fail('bad_input', 'Say what is being done about it, in a few words.');
    return await this.db.transaction(async (tx: Tx): Promise<DocResult<{ acknowledged: number }>> => {
      const [d] = await tx.select({ windowEnd: deliveries.windowEnd }).from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('share');
      if (d?.windowEnd == null) return fail('not_found', 'That delivery has no promised window.');
      const open = await tx
        .select({ id: deliverySlaEvents.id })
        .from(deliverySlaEvents)
        .leftJoin(deliverySlaAcks, eq(deliverySlaAcks.eventId, deliverySlaEvents.id))
        .where(and(eq(deliverySlaEvents.deliveryId, deliveryId), eq(deliverySlaEvents.windowEnd, d.windowEnd), sql`${deliverySlaAcks.eventId} IS NULL`));
      if (open.length === 0) return fail('nothing_left', 'There is nothing to acknowledge: nothing has been raised for this delivery, or it has been acknowledged already.');
      await tx.insert(deliverySlaAcks).values(open.map((e) => ({ eventId: e.id, acknowledgedBy: actor.userId, acknowledgedAt: this.clock(), note }))).onConflictDoNothing();
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id: deliveryId }, action: 'delivery.sla_acknowledged', actor: { type: 'user', id: actor.userId }, reason: { text: note }, inputs: { events: open.length } }, tx);
      return { ok: true, data: { acknowledged: open.length } };
    });
  }
}
