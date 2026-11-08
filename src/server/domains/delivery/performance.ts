import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { readPeriod, type ReportPeriod } from '@/lib/delivery-cost';
import { averageMinutes, fillPercent, ratePercent } from '@/lib/delivery-performance';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { DocRefusal, DocResult } from './documents';

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const TZ = 'Africa/Nairobi';
const num = (v: unknown): number => Number(v ?? 0);

/** The headline figures of a set of deliveries (all, one rider's, one courier's). Rates are null with nothing to measure. */
export interface Tally {
  delivered: number;
  /** Delivered with a promised window, and how many of those were in time. */
  promised: number;
  onTime: number;
  onTimePercent: number | null;
  /** Delivered with no failed attempt before. */
  firstTryPercent: number | null;
  /** Average minutes from going out to being delivered. */
  averageTransitMinutes: number | null;
}

export interface DeliveryPerformance {
  period: ReportPeriod;
  total: Tally & {
    /** Average minutes late, of those delivered after the end of their window. */
    averageLateMinutes: number | null;
    /** Average minutes from the delivery being released to the warehouse until it was delivered. */
    averageTotalMinutes: number | null;
  };
  byRider: (Tally & { riderId: string; name: string })[];
  byCourier: { courier: string; sent: number; delivered: number; onTimePercent: number | null; promised: number; averageTransitMinutes: number | null; failedAttempts: number; problems: number }[];
  bySlot: { slotId: string; name: string; branch: string; times: string; active: boolean; capacity: number; openDays: number; offered: number; booked: number; fullDays: number; fillPercent: number | null }[];
  /** Times customers chose at checkout, and how many had gone by the time the delivery was made. */
  chosen: number;
  notKept: number;
}

/**
 * How well delivery is doing over a stretch of days. A delivery counts on the day it was delivered; on time means delivered by the end of
 * the window it was promised (deliveries promised nothing are left out of that rate, not counted as on time). A courier's row is about the
 * parcels sent in those days and what has become of them so far. A slot's room is its capacity for every day in the period it runs and is
 * not closed; the capacity counted is today's, so a slot whose capacity was changed shows the new one for old days.
 */
export class DeliveryPerformanceReports {
  constructor(private readonly db: DrizzleDb) {}

  async summary(companyId: string, input: { from?: unknown; to?: unknown }): Promise<DocResult<DeliveryPerformance>> {
    const read = readPeriod(input.from, input.to, businessDate());
    if (!read.ok) return fail('bad_input', read.error);
    const { from, to } = read.period;
    const start = sql`(${from}::date)::timestamp AT TIME ZONE ${TZ}`;
    const end = sql`((${to}::date) + 1)::timestamp AT TIME ZONE ${TZ}`;
    const co = sql`${companyId}::uuid`;
    const done = sql`WITH done AS (
      SELECT d.id, d.window_end, d.delivered_at, d.dispatched_at, d.released_at,
             d.window_end IS NOT NULL AS promised,
             d.window_end IS NOT NULL AND d.delivered_at <= d.window_end AS on_time,
             NOT EXISTS (SELECT 1 FROM delivery_attempts a WHERE a.delivery_id = d.id AND a.result NOT IN ('delivered','part_accepted')) AS first_try,
             (SELECT a.rider_id FROM delivery_attempts a WHERE a.delivery_id = d.id AND a.result = 'delivered' ORDER BY a.attempt_no DESC LIMIT 1) AS rider_id
      FROM deliveries d WHERE d.company_id = ${co} AND d.status = 'delivered' AND d.delivered_at >= ${start} AND d.delivered_at < ${end})`;
    const minutes = (a: string, b: string) => sql.raw(`extract(epoch FROM (${a} - ${b})) / 60`);
    const transit = minutes('delivered_at', 'dispatched_at');

    const [totals, riders, couriers, slots, requests] = await Promise.all([
      this.db.execute(sql`${done}
        SELECT count(*)::int AS delivered, count(*) FILTER (WHERE promised)::int AS promised, count(*) FILTER (WHERE on_time)::int AS on_time,
               count(*) FILTER (WHERE first_try)::int AS first_try,
               COALESCE(sum(${transit}) FILTER (WHERE dispatched_at IS NOT NULL), 0) AS transit, count(*) FILTER (WHERE dispatched_at IS NOT NULL)::int AS transit_n,
               COALESCE(sum(${minutes('delivered_at', 'window_end')}) FILTER (WHERE promised AND NOT on_time), 0) AS late, count(*) FILTER (WHERE promised AND NOT on_time)::int AS late_n,
               COALESCE(sum(${minutes('delivered_at', 'released_at')}) FILTER (WHERE released_at IS NOT NULL), 0) AS whole, count(*) FILTER (WHERE released_at IS NOT NULL)::int AS whole_n
        FROM done`),
      this.db.execute(sql`${done}
        SELECT r.id AS rider_id, r.name, count(*)::int AS delivered, count(*) FILTER (WHERE x.promised)::int AS promised, count(*) FILTER (WHERE x.on_time)::int AS on_time,
               count(*) FILTER (WHERE x.first_try)::int AS first_try,
               COALESCE(sum(${minutes('x.delivered_at', 'x.dispatched_at')}) FILTER (WHERE x.dispatched_at IS NOT NULL), 0) AS transit, count(*) FILTER (WHERE x.dispatched_at IS NOT NULL)::int AS transit_n
        FROM done x JOIN delivery_riders r ON r.id = x.rider_id
        GROUP BY r.id, r.name ORDER BY count(*) DESC, r.name`),
      this.db.execute(sql`
        SELECT COALESCE(NULLIF(trim(s.courier_name), ''), 'Not named') AS courier, count(*)::int AS sent,
               count(*) FILTER (WHERE d.status = 'delivered')::int AS delivered,
               count(*) FILTER (WHERE d.status = 'delivered' AND d.window_end IS NOT NULL)::int AS promised,
               count(*) FILTER (WHERE d.status = 'delivered' AND d.window_end IS NOT NULL AND d.delivered_at <= d.window_end)::int AS on_time,
               COALESCE(sum(extract(epoch FROM (d.delivered_at - d.dispatched_at)) / 60) FILTER (WHERE d.status = 'delivered'), 0) AS transit, count(*) FILTER (WHERE d.status = 'delivered')::int AS transit_n,
               COALESCE(sum((SELECT count(*) FROM delivery_attempts a WHERE a.delivery_id = d.id AND a.result NOT IN ('delivered','part_accepted'))), 0)::int AS failed_attempts,
               count(*) FILTER (WHERE s.sync_state IN ('book_failed','cancel_failed'))::int AS problems
        FROM delivery_shipments s JOIN deliveries d ON d.id = s.delivery_id
        WHERE d.company_id = ${co} AND d.method = 'courier' AND d.dispatched_at >= ${start} AND d.dispatched_at < ${end}
        GROUP BY 1 ORDER BY count(*) DESC, 1`),
      this.db.execute(sql`
        WITH days AS (SELECT g::date AS day FROM generate_series(${from}::date, ${to}::date, interval '1 day') g),
        open AS (
          SELECT s.id, count(*)::int AS open_days FROM delivery_slots s JOIN days ON extract(isodow FROM days.day)::int = ANY(s.weekdays)
          WHERE s.company_id = ${co} AND NOT EXISTS (SELECT 1 FROM delivery_closed_days c WHERE c.company_id = s.company_id AND c.day = days.day AND (c.branch_id IS NULL OR c.branch_id = s.branch_id))
          GROUP BY s.id),
        perday AS (
          SELECT d.slot_id, d.slot_day, count(*)::int AS n FROM deliveries d
          WHERE d.company_id = ${co} AND d.slot_id IS NOT NULL AND d.slot_day BETWEEN ${from}::date AND ${to}::date AND d.status NOT IN ('cancelled','returned')
          GROUP BY 1, 2),
        booked AS (
          SELECT p.slot_id, sum(p.n)::int AS booked, count(*) FILTER (WHERE p.n >= s.capacity)::int AS full_days
          FROM perday p JOIN delivery_slots s ON s.id = p.slot_id GROUP BY p.slot_id)
        SELECT s.id, s.name, b.name AS branch, s.starts_at, s.ends_at, s.capacity, s.is_active, COALESCE(o.open_days, 0) AS open_days, COALESCE(k.booked, 0) AS booked, COALESCE(k.full_days, 0) AS full_days
        FROM delivery_slots s JOIN branches b ON b.id = s.branch_id LEFT JOIN open o ON o.id = s.id LEFT JOIN booked k ON k.slot_id = s.id
        WHERE s.company_id = ${co} AND (s.is_active OR k.slot_id IS NOT NULL)
        ORDER BY b.name, s.starts_at, s.name`),
      this.db.execute(sql`
        SELECT count(*)::int AS chosen, count(*) FILTER (WHERE outcome = 'unavailable')::int AS not_kept
        FROM order_slot_requests WHERE company_id = ${co} AND day BETWEEN ${from}::date AND ${to}::date AND outcome <> 'pending'`),
    ]);

    const t = totals[0];
    const delivered = num(t?.delivered);
    const tally = (r: Record<string, unknown> | undefined): Tally => ({
      delivered: num(r?.delivered),
      promised: num(r?.promised),
      onTime: num(r?.on_time),
      onTimePercent: ratePercent(num(r?.on_time), num(r?.promised)),
      firstTryPercent: ratePercent(num(r?.first_try), num(r?.delivered)),
      averageTransitMinutes: averageMinutes(num(r?.transit), num(r?.transit_n)),
    });
    return {
      ok: true,
      data: {
        period: read.period,
        total: { ...tally(t), delivered, averageLateMinutes: averageMinutes(num(t?.late), num(t?.late_n)), averageTotalMinutes: averageMinutes(num(t?.whole), num(t?.whole_n)) },
        byRider: riders.map((r) => ({ riderId: String(r.rider_id), name: String(r.name), ...tally(r) })),
        byCourier: couriers.map((r) => ({
          courier: String(r.courier),
          sent: num(r.sent),
          delivered: num(r.delivered),
          promised: num(r.promised),
          onTimePercent: ratePercent(num(r.on_time), num(r.promised)),
          averageTransitMinutes: averageMinutes(num(r.transit), num(r.transit_n)),
          failedAttempts: num(r.failed_attempts),
          problems: num(r.problems),
        })),
        bySlot: slots.map((r) => {
          const capacity = num(r.capacity);
          const openDays = num(r.open_days);
          const offered = capacity * openDays;
          const booked = num(r.booked);
          return { slotId: String(r.id), name: String(r.name), branch: String(r.branch), times: `${String(r.starts_at)} to ${String(r.ends_at)}`, active: r.is_active === true, capacity, openDays, offered, booked, fullDays: num(r.full_days), fillPercent: fillPercent(booked, offered) };
        }),
        chosen: num(requests[0]?.chosen),
        notKept: num(requests[0]?.not_kept),
      },
    };
  }
}
