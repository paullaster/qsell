import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveries, deliveryRiderSettings, deliveryLines, deliveryRunStops, deliveryRuns, orders, products } from '@/server/db/drizzle/schema';
import { RUN_STATUS_WORDS, type RunStatus } from '@/lib/dispatch-run';
import { isProofRule, ruleFor, type ProofRule } from '@/lib/delivery-proof';
import { STATUS_WORDS, type DeliveryStatus } from '@/lib/delivery-document';
import type { GeoPoint } from '@/lib/geo';
import { callLink, chatLink, navigateLink } from '@/lib/rider-links';
import type { RiderSelf } from './riders';

export interface RiderStopView {
  sequence: number;
  deliveryId: string;
  number: string;
  orderNumber: string;
  status: DeliveryStatus;
  statusWords: string;
  receiver: { name: string; phone: string | null };
  address: string[];
  instructions: string | null;
  items: { productId: string; name: string; quantity: number }[];
  links: { call: string | null; chat: string | null; navigate: string | null };
  /** What the rider must show to mark this stop delivered. The code itself is the customer's, and never sent to the rider. */
  proof: ProofRule;
  /** The run is on the road and this stop is still to do. */
  open: boolean;
}

export interface RiderRunItem {
  id: string;
  number: string;
  runDate: string;
  branchName: string;
  status: RunStatus;
  statusWords: string;
  stops: number;
  vehicle: string | null;
}

export interface RiderRunView extends RiderRunItem {
  /** The rider's own id, so the phone keeps its unsent work apart from another rider's. */
  riderId: string;
  notes: string | null;
  items: RiderStopView[];
  /** On the road and every stop done or failed: the rider may close it. */
  canFinish: boolean;
}

const words = (parts: (string | null | undefined)[]): string[] => parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim());

/**
 * What a rider sees: their own runs and nothing else. Every read is bound to the rider the server found for the signed-in person,
 * never to an id sent from the phone, so another rider's run is simply "not found". A customer's address and phone are shown only
 * on a stop of the rider's own run.
 */
export class RiderRuns {
  constructor(private readonly db: DrizzleDb) {}

  /** The runs still to do (a planned one whose day has passed is still theirs, so it is not hidden), then the few finished most lately. */
  async mine(self: RiderSelf): Promise<{ open: RiderRunItem[]; recent: RiderRunItem[] }> {
    const rows = await this.db
      .select({ r: deliveryRuns, branchName: branches.name })
      .from(deliveryRuns)
      .innerJoin(branches, eq(branches.id, deliveryRuns.branchId))
      .where(and(eq(deliveryRuns.riderId, self.riderId), eq(deliveryRuns.companyId, self.companyId), inArray(deliveryRuns.status, ['planned', 'started'])))
      .orderBy(asc(deliveryRuns.runDate), asc(deliveryRuns.createdAt))
      .limit(30);
    const done = await this.db
      .select({ r: deliveryRuns, branchName: branches.name })
      .from(deliveryRuns)
      .innerJoin(branches, eq(branches.id, deliveryRuns.branchId))
      .where(and(eq(deliveryRuns.riderId, self.riderId), eq(deliveryRuns.companyId, self.companyId), eq(deliveryRuns.status, 'completed')))
      .orderBy(desc(deliveryRuns.closedAt))
      .limit(5);
    const counts = await this.stopCounts([...rows, ...done].map((x) => x.r.id));
    const item = (x: { r: typeof deliveryRuns.$inferSelect; branchName: string }): RiderRunItem => ({ id: x.r.id, number: x.r.number, runDate: x.r.runDate, branchName: x.branchName, status: x.r.status, statusWords: RUN_STATUS_WORDS[x.r.status], stops: counts.get(x.r.id) ?? 0, vehicle: x.r.vehicle });
    return { open: rows.map(item), recent: done.map(item) };
  }

  private async stopCounts(runIds: string[]): Promise<Map<string, number>> {
    if (runIds.length === 0) return new Map();
    const rows = await this.db.select({ runId: deliveryRunStops.runId, n: sql<number>`count(*)::int` }).from(deliveryRunStops).where(and(inArray(deliveryRunStops.runId, runIds), isNull(deliveryRunStops.leftAt))).groupBy(deliveryRunStops.runId);
    return new Map(rows.map((r) => [r.runId, r.n]));
  }

  /** One of the rider's runs with its stops in order, or null when it is not theirs (or does not exist). Four reads, however many stops. */
  async one(self: RiderSelf, runId: string): Promise<RiderRunView | null> {
    const [row] = await this.db
      .select({ r: deliveryRuns, branchName: branches.name })
      .from(deliveryRuns)
      .innerJoin(branches, eq(branches.id, deliveryRuns.branchId))
      .where(and(eq(deliveryRuns.id, runId), eq(deliveryRuns.riderId, self.riderId), eq(deliveryRuns.companyId, self.companyId)));
    if (row === undefined) return null;
    const stops = await this.db
      .select({ sequence: deliveryRunStops.sequence, d: deliveries, orderNumber: orders.orderNumber, orderPhone: orders.customerPhone, customerName: orders.customerName, address: orders.shippingAddress })
      .from(deliveryRunStops)
      .innerJoin(deliveries, eq(deliveries.id, deliveryRunStops.deliveryId))
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .where(and(eq(deliveryRunStops.runId, runId), isNull(deliveryRunStops.leftAt)))
      .orderBy(asc(deliveryRunStops.sequence));
    const lines = stops.length === 0 ? [] : await this.db
      .select({ deliveryId: deliveryLines.deliveryId, productId: deliveryLines.productId, name: products.name, quantity: deliveryLines.quantity, picked: deliveryLines.picked })
      .from(deliveryLines)
      .innerJoin(products, eq(products.id, deliveryLines.productId))
      .where(inArray(deliveryLines.deliveryId, stops.map((s) => s.d.id)))
      .orderBy(asc(products.name));
    const byDelivery = new Map<string, { productId: string; name: string; quantity: number }[]>();
    for (const l of lines) {
      const quantity = Number(l.picked ?? l.quantity);
      if (quantity <= 0) continue;
      byDelivery.set(l.deliveryId, [...(byDelivery.get(l.deliveryId) ?? []), { productId: l.productId, name: l.name, quantity }]);
    }
    const counts = new Map([[runId, stops.length]]);
    const r = row.r;
    const [setting] = await this.db.select({ proof: deliveryRiderSettings.proof }).from(deliveryRiderSettings).where(eq(deliveryRiderSettings.companyId, self.companyId));
    const company: ProofRule = setting !== undefined && isProofRule(setting.proof) ? setting.proof : 'none';
    const onTheRoad = r.status === 'started';
    return {
      id: r.id,
      number: r.number,
      runDate: r.runDate,
      branchName: row.branchName,
      status: r.status,
      statusWords: RUN_STATUS_WORDS[r.status],
      stops: counts.get(runId) ?? 0,
      vehicle: r.vehicle,
      riderId: self.riderId,
      notes: r.notes,
      items: stops.map((s): RiderStopView => {
        const place = s.d.destination.address;
        const street = typeof s.address.street === 'string' ? s.address.street : null;
        const address = words([street, place?.area, place?.town, place?.county]);
        const pin: GeoPoint | null = s.d.destination.pin;
        const phone = s.d.recipientPhone ?? s.orderPhone;
        return {
          sequence: s.sequence,
          deliveryId: s.d.id,
          number: s.d.number,
          orderNumber: s.orderNumber,
          status: s.d.status,
          statusWords: STATUS_WORDS[s.d.status],
          receiver: { name: s.d.recipientName ?? s.customerName, phone },
          address,
          instructions: s.d.notes,
          items: byDelivery.get(s.d.id) ?? [],
          links: { call: callLink(phone), chat: chatLink(phone), navigate: navigateLink(pin, address) },
          proof: ruleFor(company, s.d.handoverCode !== null),
          open: onTheRoad && s.d.status === 'out_for_delivery',
        };
      }),
      canFinish: onTheRoad && stops.length > 0 && stops.every((s) => s.d.status !== 'out_for_delivery'),
    };
  }
}
