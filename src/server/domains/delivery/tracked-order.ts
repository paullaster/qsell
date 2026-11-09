import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliveryLines, deliveryShipments, orderDeliveries, orders, products } from '@/server/db/drizzle/schema';
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/delivery-document';
import type { TrackedOrder } from '@/lib/tracking-view';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { DeliveryDocuments } from './documents';
import type { OrderCollections } from './collection';

/**
 * An order as its customer sees it: how it stands, each delivery in their words, and what is still to be sent. Only what the tracking
 * page may show: no address, no phone number, no price, no rider, no stock or branch detail but the name of the branch to collect from.
 * Drafts and cancelled deliveries are the shop's own business and are left out.
 */
export class TrackedOrders {
  constructor(
    private readonly db: DrizzleDb,
    private readonly company: Pick<CompanySettingsRepository, 'ensureSeeded'>,
    private readonly documents: Pick<DeliveryDocuments, 'forOrder'>,
    private readonly collections: Pick<OrderCollections, 'view'>,
  ) {}

  async forOrder(companyId: string, orderId: string): Promise<TrackedOrder | null> {
    const [order] = await this.db.select({ number: orders.orderNumber, createdAt: orders.createdAt }).from(orders).where(eq(orders.id, orderId));
    if (order === undefined) return null;
    const settings = await this.company.ensureSeeded();
    const storeName = settings.tradingName.trim() === '' ? 'the shop' : settings.tradingName.trim();
    const [method] = await this.db.select({ method: orderDeliveries.method }).from(orderDeliveries).where(and(eq(orderDeliveries.orderId, orderId), eq(orderDeliveries.companyId, companyId)));
    const base = { storeName, orderNumber: order.number, placedAt: order.createdAt.toISOString() };
    // An order with no delivery record of this company is not one that can be followed here.
    if (method === undefined) return null;

    if (method.method === 'pickup') {
      const c = await this.collections.view(companyId, orderId);
      return { ...base, kind: 'collection', state: 'not_started', deliveries: [], waiting: [], collection: c === null ? null : { branchName: c.branch.name, status: c.status } };
    }

    const [overview, rows] = await Promise.all([
      this.documents.forOrder(companyId, orderId),
      this.db
        .select({ d: deliveries, productId: deliveryLines.productId, lineProduct: products.name, lineQuantity: deliveryLines.quantity, linePicked: deliveryLines.picked, lineDelivered: deliveryLines.delivered })
        .from(deliveries)
        .innerJoin(deliveryLines, eq(deliveryLines.deliveryId, deliveries.id))
        .innerJoin(products, eq(products.id, deliveryLines.productId))
        .where(and(eq(deliveries.orderId, orderId), eq(deliveries.companyId, companyId), ne(deliveries.status, 'cancelled'), ne(deliveries.status, 'draft')))
        .orderBy(asc(deliveries.createdAt), asc(deliveries.id), asc(products.name)),
    ]);
    const ids = [...new Set(rows.map((r) => r.d.id))];
    const shipments = ids.length === 0 ? [] : await this.db.select({ deliveryId: deliveryShipments.deliveryId, courierName: deliveryShipments.courierName, trackingNumber: deliveryShipments.trackingNumber, trackingUrl: deliveryShipments.trackingUrl }).from(deliveryShipments).where(inArray(deliveryShipments.deliveryId, ids));
    const shipment = new Map(shipments.map((s) => [s.deliveryId, s]));
    const byId = new Map<string, TrackedOrder['deliveries'][number]>();
    // What the customer can see on a delivery; the rest is still to be sent, whether or not the shop has begun to prepare it.
    const visible = new Map<string, number>();
    for (const r of rows) {
      const carried = Number(r.linePicked ?? r.lineQuantity);
      visible.set(r.productId, (visible.get(r.productId) ?? 0) + carried);
      const cur = byId.get(r.d.id) ?? { number: r.d.number, status: r.d.status, items: [], courier: null, receivedBy: r.d.status === 'delivered' ? r.d.receivedBy : null, deliveredAt: r.d.deliveredAt?.toISOString() ?? null, failedAttempts: r.d.failedAttempts, handoverCode: r.d.status === 'out_for_delivery' ? r.d.handoverCode : null, canReschedule: r.d.status === 'failed_attempt' && r.d.failedAttempts < MAX_DELIVERY_ATTEMPTS, scheduledFor: r.d.scheduledFor, window: r.d.windowStart === null || r.d.windowEnd === null ? null : { start: r.d.windowStart.toISOString(), end: r.d.windowEnd.toISOString() } };
      const quantity = Number(r.d.status === 'delivered' ? r.lineDelivered : (r.linePicked ?? r.lineQuantity));
      if (quantity > 0) cur.items.push({ name: r.lineProduct, quantity });
      const s = shipment.get(r.d.id);
      if (s !== undefined && cur.courier === null) cur.courier = { name: s.courierName, trackingNumber: s.trackingNumber, trackingUrl: s.trackingUrl };
      byId.set(r.d.id, cur);
    }
    return {
      ...base,
      kind: 'delivery',
      state: overview?.state ?? 'not_started',
      deliveries: [...byId.values()],
      waiting: (overview?.lines ?? []).map((l) => ({ name: l.productName, quantity: Math.round((l.ordered - (visible.get(l.productId) ?? 0)) * 1000) / 1000 })).filter((w) => w.quantity > 0),
      collection: null,
    };
  }
}
