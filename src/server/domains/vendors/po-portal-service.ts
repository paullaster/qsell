import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { purchaseOrderLines, purchaseOrderVersions, purchaseOrders, vendorAdvancePayments, type PurchaseOrderStatus } from '@/server/db/drizzle/schema';
import { describeChanges, type Snapshot } from '@/lib/purchase-order';
import type { PurchaseOrderService } from './po-service';
import type { RgnService } from './rgn-service';
import { ProfileError, type PortalActor } from './profile-service';

/** An order is the vendor's once it has been sent: before that it is the buyer's own draft and approval. */
const VISIBLE: PurchaseOrderStatus[] = ['sent', 'confirmed', 'amendment_pending', 'partially_received', 'received', 'partially_invoiced', 'invoiced', 'closed', 'cancelled'];

/** The vendor's view of its purchase orders (design doc §9.5): the order, its versions and what changed, the advance, and confirming. */
export class PurchaseOrderPortalService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly orders: PurchaseOrderService,
    private readonly receipts?: RgnService,
  ) {}

  async list(vendorId: string, before: { sentAt: string; id: string } | null = null, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({ po: purchaseOrders, stamp: sql<string>`COALESCE(${purchaseOrders.sentAt}, ${purchaseOrders.createdAt})::text` })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.vendorId, vendorId), inArray(purchaseOrders.status, VISIBLE), before === null ? sql`true` : sql`(COALESCE(${purchaseOrders.sentAt}, ${purchaseOrders.createdAt})::text, ${purchaseOrders.id}::text) < (${before.sentAt}, ${before.id})`))
      .orderBy(sql`COALESCE(${purchaseOrders.sentAt}, ${purchaseOrders.createdAt}) DESC`, desc(purchaseOrders.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    return {
      rows: page.map((x) => ({ id: x.po.id, number: x.po.number, status: x.po.status, total: x.po.total, currency: x.po.currency, expectedDate: x.po.expectedDate, version: x.po.version, needsConfirmation: x.po.status === 'sent' })),
      next: found.length > take && last !== undefined ? { sentAt: last.stamp, id: last.po.id } : null,
    };
  }

  async load(actor: PortalActor, id: string) {
    const [po] = await this.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.vendorId, actor.vendorId), inArray(purchaseOrders.status, VISIBLE)));
    if (po === undefined) throw new ProfileError('NOT_FOUND', 'That order does not exist.');
    const [lines, versions, advances] = await Promise.all([
      this.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id)).orderBy(asc(purchaseOrderLines.position)),
      this.db.select().from(purchaseOrderVersions).where(eq(purchaseOrderVersions.poId, id)).orderBy(desc(purchaseOrderVersions.version)),
      this.db.select().from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.poId, id), inArray(vendorAdvancePayments.status, ['approved', 'paid', 'applied']))),
    ]);
    const changes = versions.map((v, i) => {
      const prev = versions[i + 1];
      return { version: v.version, reason: v.reason, at: v.createdAt.toISOString(), changes: prev === undefined ? [] : describeChanges(prev.snapshot as unknown as Snapshot, v.snapshot as unknown as Snapshot) };
    });
    return {
      id: po.id,
      number: po.number,
      version: po.version,
      status: po.status,
      currency: po.currency,
      orderDate: po.orderDate,
      expectedDate: po.expectedDate,
      paymentTerms: po.paymentTerms,
      deliveryTerms: po.deliveryTerms,
      notes: po.notesToVendor,
      subtotal: po.subtotal,
      taxTotal: po.taxTotal,
      total: po.total,
      cancelReason: po.status === 'cancelled' ? po.cancelReason : null,
      requiresAdvancePayment: po.requiresAdvancePayment,
      advance: advances[0] === undefined ? null : { amount: advances[0].amount, status: advances[0].status, dueDate: advances[0].dueDate },
      confirmedAt: po.confirmedAt?.toISOString() ?? null,
      canConfirm: po.status === 'sent' && (actor.portalRole === 'owner' || actor.portalRole === 'sales'),
      lines: lines.map((l) => ({ id: l.id, description: l.description, specification: l.specification, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRate: l.taxRate, lineTotal: l.lineTotal, expectedDate: l.expectedDate, received: l.receivedQuantity, invoiced: l.invoicedQuantity })),
      versions: changes,
      deliveries: (await this.receipts?.deliveries(id)) ?? [],
    };
  }

  /** The vendor accepts the order, or accepts its latest version. */
  async confirm(actor: PortalActor, id: string, companyId: string, now: Date = new Date()): Promise<void> {
    if (actor.portalRole !== 'owner' && actor.portalRole !== 'sales') throw new ProfileError('NOT_ALLOWED', 'Only the owner or the sales person can confirm an order.');
    const [po] = await this.db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.vendorId, actor.vendorId)));
    if (po === undefined) throw new ProfileError('NOT_FOUND', 'That order does not exist.');
    try {
      await this.orders.confirmIn(id, companyId, { type: 'user', id: actor.userId }, null, now);
    } catch (error) {
      if (isRecord(error) && error.code === 'NOT_SENT') throw new ProfileError('NOT_SENT', 'This order is not waiting for your confirmation.');
      throw error;
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
