import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { orderSlaBreaches, orderSlaSettings, orderStageTargets, orders } from '@/server/db/drizzle/schema';
import { WAITING_STAGES, effectiveTargets, waitedMinutes, type StageTarget } from '@/lib/order-sla';
import { SettingsError } from '@/server/domains/settings/errors';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import type { OrderSlaNotifier } from './sla-notifier';

/** Orders raised, escalated and resolved in one run are limited so a run stays short; the next run carries on. */
const BATCH = 500;
export const BREACH_RETENTION_MONTHS = 13;
const PAGE = 25;

export interface SlaSettings {
  targets: StageTarget[];
  raiseEmails: string[];
  escalateEmails: string[];
}

export interface BreachView {
  id: string;
  orderId: string;
  orderNumber: string;
  stage: string;
  enteredAt: string;
  raisedAt: string;
  escalatedAt: string | null;
  acknowledgedAt: string | null;
  note: string | null;
  targetMinutes: number;
  waitedMinutes: number;
}

export interface SweepResult {
  raised: number;
  escalated: number;
  resolved: number;
}

const iso = (d: Date) => d.toISOString();
type Row = Record<string, unknown>;
const rowsOf = (res: Iterable<Row>): Row[] => [...res];

/**
 * Turns "an order waited too long in a stage" into a record, a mail and an escalation, exactly once per wait.
 * Design: docs/architecture/order-stage-timeline.md §14. Every step is idempotent: a sweep that runs twice, or on two workers,
 * changes nothing the second time, because the wait itself (order, stage, time it entered the stage) is the key.
 */
export class OrderSlaService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly notifier?: OrderSlaNotifier,
  ) {}

  async settings(companyId: string): Promise<SlaSettings> {
    const [stored, [mail]] = await Promise.all([
      this.db.select().from(orderStageTargets).where(eq(orderStageTargets.companyId, companyId)),
      this.db.select().from(orderSlaSettings).where(eq(orderSlaSettings.companyId, companyId)),
    ]);
    return { targets: effectiveTargets(stored), raiseEmails: mail?.raiseEmails ?? [], escalateEmails: mail?.escalateEmails ?? [] };
  }

  /** Saves every waiting stage's target and the two address lists together, or nothing. */
  async save(companyId: string, userId: string, targets: readonly StageTarget[], raiseEmails: readonly string[], escalateEmails: readonly string[]): Promise<void> {
    const seen = new Set(targets.map((t) => t.stage));
    if (seen.size !== targets.length) throw new SettingsError('A stage is listed twice.', 'DUPLICATE_STAGE');
    for (const t of targets) if (!(WAITING_STAGES as readonly string[]).includes(t.stage)) throw new SettingsError('Choose a stage that an order can wait in.', 'BAD_STAGE');
    await this.db.transaction(async (tx) => {
      for (const t of targets) {
        await tx
          .insert(orderStageTargets)
          .values({ companyId, stage: t.stage, targetMinutes: t.targetMinutes, escalateAfterMinutes: t.escalateAfterMinutes, enabled: t.enabled, updatedBy: userId })
          .onConflictDoUpdate({
            target: [orderStageTargets.companyId, orderStageTargets.stage],
            set: { targetMinutes: t.targetMinutes, escalateAfterMinutes: t.escalateAfterMinutes, enabled: t.enabled, updatedAt: sql`now()`, updatedBy: userId },
          });
      }
      await tx
        .insert(orderSlaSettings)
        .values({ companyId, raiseEmails: [...raiseEmails], escalateEmails: [...escalateEmails], updatedBy: userId })
        .onConflictDoUpdate({ target: orderSlaSettings.companyId, set: { raiseEmails: [...raiseEmails], escalateEmails: [...escalateEmails], updatedAt: sql`now()`, updatedBy: userId } });
    });
  }

  /** One pass: raise, escalate, resolve. `now` is passed in so a run can be repeated exactly. */
  async sweep(companyId: string, now: Date): Promise<SweepResult> {
    const settings = await this.settings(companyId);
    const raised = await this.raise(companyId, settings, now);
    const escalated = await this.escalate(companyId, settings, now);
    const resolved = await this.resolve(companyId, now);
    return { raised, escalated, resolved };
  }

  private async raise(companyId: string, settings: SlaSettings, now: Date): Promise<number> {
    const late: { orderNumber: string; stage: string; waitedMinutes: number }[] = [];
    let total = 0;
    for (const t of settings.targets.filter((x) => x.enabled)) {
      const cutoff = iso(new Date(now.getTime() - t.targetMinutes * 60_000));
      const rows = rowsOf(
        await this.db.execute<Row>(sql`
          WITH due AS (
            SELECT o.id, o.order_number, o.current_stage_since
            FROM orders o
            WHERE o.current_stage = ${t.stage}
              AND o.current_stage_since <= ${cutoff}::timestamptz
              AND NOT EXISTS (
                SELECT 1 FROM order_sla_breaches b
                WHERE b.order_id = o.id AND b.stage = ${t.stage} AND b.entered_at = o.current_stage_since)
            ORDER BY o.current_stage_since ASC
            LIMIT ${BATCH})
          INSERT INTO order_sla_breaches (company_id, order_id, stage, entered_at, target_minutes, escalate_after_minutes, raised_at)
          SELECT ${companyId}::uuid, due.id, ${t.stage}, due.current_stage_since, ${t.targetMinutes}, ${t.escalateAfterMinutes}, ${iso(now)}::timestamptz FROM due
          ON CONFLICT (order_id, stage, entered_at) DO NOTHING
          RETURNING order_id, entered_at,
            (SELECT order_number FROM orders WHERE id = order_sla_breaches.order_id) AS order_number`),
      );
      for (const r of rows) {
        total++;
        late.push({ orderNumber: String(r.order_number), stage: t.stage, waitedMinutes: waitedMinutes(new Date(r.entered_at as string | Date), now) });
      }
    }
    if (late.length > 0) await this.notifier?.send('raised', late, settings.raiseEmails);
    return total;
  }

  private async escalate(companyId: string, settings: SlaSettings, now: Date): Promise<number> {
    const rows = rowsOf(
      await this.db.execute<Row>(sql`
        WITH due AS (
          SELECT b.id FROM order_sla_breaches b
          WHERE b.company_id = ${companyId}::uuid AND b.resolved_at IS NULL AND b.escalated_at IS NULL
            AND b.raised_at + make_interval(mins => b.escalate_after_minutes) <= ${iso(now)}::timestamptz
          ORDER BY b.raised_at ASC LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED)
        UPDATE order_sla_breaches b SET escalated_at = ${iso(now)}::timestamptz
        FROM due WHERE b.id = due.id
        RETURNING b.stage, b.entered_at, (SELECT order_number FROM orders WHERE id = b.order_id) AS order_number`),
    );
    if (rows.length > 0) {
      await this.notifier?.send(
        'escalated',
        rows.map((r) => ({ orderNumber: String(r.order_number), stage: String(r.stage), waitedMinutes: waitedMinutes(new Date(r.entered_at as string | Date), now) })),
        settings.escalateEmails.length > 0 ? settings.escalateEmails : settings.raiseEmails,
      );
    }
    return rows.length;
  }

  /**
   * An open breach is over when its order has moved on. The end is the first event after the one that put the order in the stage
   * (the order's stage time is stamped just before that event is written, so "first event after the stage time" would be that event).
   */
  private async resolve(companyId: string, now: Date): Promise<number> {
    const rows = rowsOf(
      await this.db.execute<Row>(sql`
        WITH over AS (
          SELECT b.id FROM order_sla_breaches b
          JOIN orders o ON o.id = b.order_id
          WHERE b.company_id = ${companyId}::uuid AND b.resolved_at IS NULL
            AND (o.current_stage IS DISTINCT FROM b.stage OR o.current_stage_since IS DISTINCT FROM b.entered_at)
          ORDER BY b.raised_at ASC LIMIT ${BATCH}
          FOR UPDATE OF b SKIP LOCKED)
        UPDATE order_sla_breaches b SET resolved_at = coalesce(
            (SELECT e2.occurred_at FROM order_stage_events e2
              WHERE e2.order_id = b.order_id
                AND e2.sequence > (SELECT e1.sequence FROM order_stage_events e1
                                   WHERE e1.order_id = b.order_id AND e1.stage = b.stage AND e1.occurred_at >= b.entered_at
                                   ORDER BY e1.occurred_at ASC LIMIT 1)
              ORDER BY e2.sequence ASC LIMIT 1),
            ${iso(now)}::timestamptz)
        FROM over WHERE b.id = over.id
        RETURNING b.id`),
    );
    return rows.length;
  }

  /** The open breaches, oldest first, a page at a time. `now` gives each its running wait. */
  async open(companyId: string, cursor: string | null, now: Date, limit = PAGE): Promise<{ rows: BreachView[]; nextCursor: string | null }> {
    const after = cursor === null ? null : decodeCursor(cursor);
    const rows = await this.db
      .select({
        id: orderSlaBreaches.id,
        orderId: orderSlaBreaches.orderId,
        orderNumber: orders.orderNumber,
        stage: orderSlaBreaches.stage,
        enteredAt: orderSlaBreaches.enteredAt,
        raisedAt: orderSlaBreaches.raisedAt,
        escalatedAt: orderSlaBreaches.escalatedAt,
        acknowledgedAt: orderSlaBreaches.acknowledgedAt,
        note: orderSlaBreaches.note,
        targetMinutes: orderSlaBreaches.targetMinutes,
        raisedKey: sql<string>`to_char(${orderSlaBreaches.raisedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(orderSlaBreaches)
      .innerJoin(orders, eq(orders.id, orderSlaBreaches.orderId))
      .where(and(eq(orderSlaBreaches.companyId, companyId), isNull(orderSlaBreaches.resolvedAt), after === null ? undefined : sql`(${orderSlaBreaches.raisedAt}, ${orderSlaBreaches.id}) > (${after.k}::timestamptz, ${after.id}::uuid)`))
      .orderBy(asc(orderSlaBreaches.raisedAt), asc(orderSlaBreaches.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        stage: r.stage,
        enteredAt: r.enteredAt.toISOString(),
        raisedAt: r.raisedAt.toISOString(),
        escalatedAt: r.escalatedAt?.toISOString() ?? null,
        acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
        note: r.note,
        targetMinutes: r.targetMinutes,
        waitedMinutes: waitedMinutes(r.enteredAt, now),
      })),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ k: last.raisedKey, id: last.id }) : null,
    };
  }

  /** Someone has seen it and is on it. The first acknowledgement stands; a second changes nothing. */
  async acknowledge(companyId: string, userId: string, breachId: string, note: string): Promise<void> {
    const text = note.trim();
    if (text.length > 500) throw new SettingsError('Keep the note to 500 characters.', 'NOTE_TOO_LONG');
    const changed = await this.db
      .update(orderSlaBreaches)
      .set({ acknowledgedAt: sql`now()`, acknowledgedBy: userId, note: text === '' ? null : text })
      .where(and(eq(orderSlaBreaches.id, breachId), eq(orderSlaBreaches.companyId, companyId), isNull(orderSlaBreaches.resolvedAt), isNull(orderSlaBreaches.acknowledgedAt)))
      .returning({ id: orderSlaBreaches.id });
    if (changed.length > 0) return;
    const [row] = await this.db.select({ resolvedAt: orderSlaBreaches.resolvedAt, acknowledgedAt: orderSlaBreaches.acknowledgedAt }).from(orderSlaBreaches).where(and(eq(orderSlaBreaches.id, breachId), eq(orderSlaBreaches.companyId, companyId)));
    if (row === undefined) throw new SettingsError('That late order could not be found.', 'NOT_FOUND');
    if (row.resolvedAt !== null) throw new SettingsError('That order has moved on already.', 'RESOLVED');
  }

  /** Resolved breaches older than the retention are removed; open ones never are. */
  async purge(now: Date): Promise<number> {
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - BREACH_RETENTION_MONTHS);
    const rows = rowsOf(await this.db.execute<Row>(sql`DELETE FROM order_sla_breaches WHERE resolved_at IS NOT NULL AND resolved_at < ${iso(cutoff)}::timestamptz RETURNING id`));
    return rows.length;
  }
}
