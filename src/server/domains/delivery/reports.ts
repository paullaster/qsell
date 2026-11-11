import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { FAILURE_REASONS } from '@/lib/delivery-document';
import { marginCents, money, readPeriod, sharePercent, type ReportPeriod } from '@/lib/delivery-cost';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { DocRefusal, DocResult } from './documents';

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const TZ = 'Africa/Nairobi';
const cents = (v: unknown): number => Math.round(Number(v ?? 0) * 100);

export interface DeliveryReport {
  period: ReportPeriod;
  /** Deliveries delivered in the period, attempts that failed, and parts of an order not taken. */
  delivered: number;
  failedAttempts: number;
  partlyTaken: number;
  /** What the customers paid for delivery (before tax) on deliveries delivered in the period, and what delivery cost in the period. */
  charge: string;
  riderPay: string;
  courierCharges: string;
  fuelCosts: string;
  vehicleCosts: string;
  otherCosts: string;
  cost: string;
  margin: string;
  /** Margin as a share of the charge, or null with no charge. */
  marginPercent: number | null;
  byRider: { riderId: string; name: string; delivered: number; failed: number; pay: string }[];
  byCourier: { courier: string; deliveries: number; charged: string }[];
  byZone: { zone: string; delivered: number; charge: string; directCost: string }[];
  /** Each vehicle that ran deliveries or had running costs in the period. A cost not tied to a vehicle is counted in `untiedRunningCosts`, so the table and the total reconcile. */
  byVehicle: { vehicleId: string; name: string; runs: number; delivered: number; fuel: string; repairs: string; other: string; total: string; perDelivery: string | null }[];
  untiedRunningCosts: string;
  failures: { code: string; words: string; count: number }[];
}

/**
 * What delivery earned and what it cost over a stretch of days. A delivery counts on the day it was delivered; the customer's delivery
 * charge (before tax) counts once for an order, on the first of its deliveries that was delivered, so splitting an order in two does not
 * count its charge twice. Costs count on the day they were earned or typed in, and a cost taken back counts against it. The margin is the
 * difference over the whole period, not matched delivery by delivery. A zone's direct cost is what can be tied to its deliveries (pay for a
 * delivery and a courier's charge); pay for a day on a run belongs to the rider and the day, not to a zone.
 */
export class DeliveryReports {
  constructor(private readonly db: DrizzleDb) {}

  async summary(companyId: string, input: { from?: unknown; to?: unknown }): Promise<DocResult<DeliveryReport>> {
    const read = readPeriod(input.from, input.to, businessDate());
    if (!read.ok) return fail('bad_input', read.error);
    const { from, to } = read.period;
    const start = sql`(${from}::date)::timestamp AT TIME ZONE ${TZ}`;
    const end = sql`((${to}::date) + 1)::timestamp AT TIME ZONE ${TZ}`;

    const [counts, charges, costs, riders, couriers, zones, failures, vehicles, untied] = await Promise.all([
      this.db.execute(sql`
        SELECT (SELECT count(*) FROM deliveries d WHERE d.company_id = ${companyId}::uuid AND d.status = 'delivered' AND d.delivered_at >= ${start} AND d.delivered_at < ${end})::int AS delivered,
               (SELECT count(*) FROM delivery_attempts a WHERE a.company_id = ${companyId}::uuid AND a.result NOT IN ('delivered','part_accepted') AND a.occurred_at >= ${start} AND a.occurred_at < ${end})::int AS failed,
               (SELECT count(*) FROM delivery_attempts a WHERE a.company_id = ${companyId}::uuid AND a.result = 'part_accepted' AND a.occurred_at >= ${start} AND a.occurred_at < ${end})::int AS partly`),
      this.db.execute(sql`
        WITH firsts AS (
          SELECT d.id, d.delivered_at, row_number() OVER (PARTITION BY d.order_id ORDER BY d.delivered_at, d.id) AS n
          FROM deliveries d WHERE d.company_id = ${companyId}::uuid AND d.status = 'delivered')
        SELECT COALESCE(sum(od.charge_net), 0) AS charge
        FROM firsts f JOIN deliveries d ON d.id = f.id JOIN order_deliveries od ON od.order_id = d.order_id
        WHERE f.n = 1 AND f.delivered_at >= ${start} AND f.delivered_at < ${end}`),
      this.db.execute(sql`
        SELECT kind, COALESCE(sum(amount), 0) AS total FROM delivery_costs
        WHERE company_id = ${companyId}::uuid AND created_at >= ${start} AND created_at < ${end} GROUP BY kind`),
      this.db.execute(sql`
        SELECT r.id AS rider_id, r.name,
               (SELECT count(*) FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id AND a.result = 'delivered' WHERE a.rider_id = r.id AND d.status = 'delivered' AND a.occurred_at >= ${start} AND a.occurred_at < ${end})::int AS delivered,
               (SELECT count(*) FROM delivery_attempts a WHERE a.rider_id = r.id AND a.result NOT IN ('delivered','part_accepted') AND a.occurred_at >= ${start} AND a.occurred_at < ${end})::int AS failed,
               COALESCE((SELECT sum(c.amount) FROM delivery_costs c WHERE c.rider_id = r.id AND c.created_at >= ${start} AND c.created_at < ${end}), 0) AS pay
        FROM delivery_riders r WHERE r.company_id = ${companyId}::uuid
        AND (EXISTS (SELECT 1 FROM delivery_attempts a WHERE a.rider_id = r.id AND a.occurred_at >= ${start} AND a.occurred_at < ${end}) OR EXISTS (SELECT 1 FROM delivery_costs c WHERE c.rider_id = r.id AND c.created_at >= ${start} AND c.created_at < ${end}))
        ORDER BY r.name`),
      this.db.execute(sql`
        SELECT c.courier_name AS courier, count(DISTINCT c.delivery_id)::int AS deliveries, COALESCE(sum(c.amount), 0) AS charged
        FROM delivery_costs c WHERE c.company_id = ${companyId}::uuid AND c.kind = 'courier' AND c.created_at >= ${start} AND c.created_at < ${end}
        GROUP BY c.courier_name ORDER BY c.courier_name`),
      this.db.execute(sql`
        WITH firsts AS (
          SELECT d.id, d.order_id, d.delivered_at, row_number() OVER (PARTITION BY d.order_id ORDER BY d.delivered_at, d.id) AS n
          FROM deliveries d WHERE d.company_id = ${companyId}::uuid AND d.status = 'delivered'),
        delivered AS (
          SELECT f.id, COALESCE(od.charge->'zone'->>'name', 'No zone') AS zone, CASE WHEN f.n = 1 THEN od.charge_net ELSE 0 END AS charge
          FROM firsts f JOIN order_deliveries od ON od.order_id = f.order_id WHERE f.delivered_at >= ${start} AND f.delivered_at < ${end}),
        direct AS (
          SELECT COALESCE(od.charge->'zone'->>'name', 'No zone') AS zone, sum(c.amount) AS cost
          FROM delivery_costs c JOIN deliveries d ON d.id = c.delivery_id JOIN order_deliveries od ON od.order_id = d.order_id
          WHERE c.company_id = ${companyId}::uuid AND c.created_at >= ${start} AND c.created_at < ${end} GROUP BY 1)
        SELECT z.zone, z.delivered, z.charge, COALESCE(x.cost, 0) AS cost FROM (SELECT zone, count(*)::int AS delivered, sum(charge) AS charge FROM delivered GROUP BY zone) z LEFT JOIN direct x ON x.zone = z.zone
        UNION ALL
        SELECT x.zone, 0, 0, x.cost FROM direct x WHERE NOT EXISTS (SELECT 1 FROM delivered dd WHERE dd.zone = x.zone)
        ORDER BY 1`),
      this.db.execute(sql`
        SELECT a.result AS code, count(*)::int AS n FROM delivery_attempts a
        WHERE a.company_id = ${companyId}::uuid AND a.result NOT IN ('delivered','part_accepted') AND a.occurred_at >= ${start} AND a.occurred_at < ${end}
        GROUP BY a.result ORDER BY count(*) DESC, a.result`),
      // A delivery counts for the vehicle of the run it was delivered on; a cost counts for the vehicle it was typed against (or its run's).
      this.db.execute(sql`
        WITH ran AS (
          SELECT r.vehicle_id, count(DISTINCT r.id)::int AS runs, count(DISTINCT d.id)::int AS delivered
          FROM deliveries d JOIN delivery_run_stops s ON s.delivery_id = d.id AND s.left_at IS NULL JOIN delivery_runs r ON r.id = s.run_id
          WHERE d.company_id = ${companyId}::uuid AND d.status = 'delivered' AND d.delivered_at >= ${start} AND d.delivered_at < ${end} AND r.vehicle_id IS NOT NULL
          GROUP BY r.vehicle_id),
        spent AS (
          SELECT c.vehicle_id,
                 COALESCE(sum(c.amount) FILTER (WHERE c.kind = 'fuel'), 0) AS fuel,
                 COALESCE(sum(c.amount) FILTER (WHERE c.kind = 'vehicle'), 0) AS repairs,
                 COALESCE(sum(c.amount) FILTER (WHERE c.kind = 'other'), 0) AS other
          FROM delivery_costs c WHERE c.company_id = ${companyId}::uuid AND c.vehicle_id IS NOT NULL AND c.created_at >= ${start} AND c.created_at < ${end}
          GROUP BY c.vehicle_id)
        SELECT v.id AS vehicle_id, v.name, COALESCE(ran.runs, 0) AS runs, COALESCE(ran.delivered, 0) AS delivered,
               COALESCE(spent.fuel, 0) AS fuel, COALESCE(spent.repairs, 0) AS repairs, COALESCE(spent.other, 0) AS other
        FROM delivery_vehicles v LEFT JOIN ran ON ran.vehicle_id = v.id LEFT JOIN spent ON spent.vehicle_id = v.id
        WHERE v.company_id = ${companyId}::uuid AND (ran.vehicle_id IS NOT NULL OR spent.vehicle_id IS NOT NULL)
        ORDER BY v.name, v.id`),
      this.db.execute(sql`
        SELECT COALESCE(sum(amount), 0) AS total FROM delivery_costs
        WHERE company_id = ${companyId}::uuid AND vehicle_id IS NULL AND kind IN ('fuel','vehicle','other') AND created_at >= ${start} AND created_at < ${end}`),
    ]);

    const kind = new Map<string, number>(costs.map((r) => [String(r.kind), cents(r.total)]));
    const riderPay = (kind.get('rider_delivery') ?? 0) + (kind.get('rider_day') ?? 0);
    const courier = kind.get('courier') ?? 0;
    const fuel = kind.get('fuel') ?? 0;
    const vehicle = kind.get('vehicle') ?? 0;
    const other = kind.get('other') ?? 0;
    const chargeCents = cents(charges[0]?.charge);
    const costCents = riderPay + courier + fuel + vehicle + other;
    const margin = marginCents(chargeCents, costCents);
    return {
      ok: true,
      data: {
        period: read.period,
        delivered: Number(counts[0]?.delivered ?? 0),
        failedAttempts: Number(counts[0]?.failed ?? 0),
        partlyTaken: Number(counts[0]?.partly ?? 0),
        charge: money(chargeCents),
        riderPay: money(riderPay),
        courierCharges: money(courier),
        fuelCosts: money(fuel),
        vehicleCosts: money(vehicle),
        otherCosts: money(other),
        cost: money(costCents),
        margin: money(margin),
        marginPercent: sharePercent(margin, chargeCents),
        byRider: riders.map((r) => ({ riderId: String(r.rider_id), name: String(r.name), delivered: Number(r.delivered), failed: Number(r.failed), pay: money(cents(r.pay)) })),
        byCourier: couriers.map((r) => ({ courier: typeof r.courier === 'string' ? r.courier : '', deliveries: Number(r.deliveries), charged: money(cents(r.charged)) })),
        byZone: zones.map((r) => ({ zone: String(r.zone), delivered: Number(r.delivered), charge: money(cents(r.charge)), directCost: money(cents(r.cost)) })),
        byVehicle: vehicles.map((r) => {
          const fuelC = cents(r.fuel);
          const repairsC = cents(r.repairs);
          const otherC = cents(r.other);
          const totalC = fuelC + repairsC + otherC;
          const delivered = Number(r.delivered);
          return { vehicleId: String(r.vehicle_id), name: String(r.name), runs: Number(r.runs), delivered, fuel: money(fuelC), repairs: money(repairsC), other: money(otherC), total: money(totalC), perDelivery: delivered === 0 ? null : money(Math.round(totalC / delivered)) };
        }),
        untiedRunningCosts: money(cents(untied[0]?.total)),
        failures: failures.map((r) => ({ code: String(r.code), words: FAILURE_REASONS.find((f) => f.code === r.code)?.words ?? String(r.code), count: Number(r.n) })),
      },
    };
  }
}
