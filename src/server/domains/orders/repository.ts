import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import { matching } from '@/server/domains/settings/paging';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { orders, orderItems, type OrderRow } from '@/server/db/drizzle/schema';
import type { Order, OrderItem, OrderStatus, PaymentStatus, PaymentProvider } from '@/types/index';
import { OrderStages, type StageActor } from './stages';
import type { StageSource } from '@/lib/order-stages';

function num(v: string | number): number {
  return typeof v === 'number' ? v : Number(v);
}

export function mapOrderRow(row: OrderRow, items: OrderItem[]): Order {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    userId: row.userId || '',
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    paymentPhone: row.paymentPhone,
    shippingAddress: row.shippingAddress,
    items,
    subtotal: num(row.subtotal),
    tax: num(row.tax),
    shippingFee: num(row.shippingFee),
    totalAmount: num(row.totalAmount),
    currency: (row.currency as 'KES' | 'USD') || 'KES',
    status: row.status as OrderStatus,
    paymentStatus: row.paymentStatus as PaymentStatus,
    paymentMethod: row.paymentMethod as PaymentProvider,
    shippingCourier: row.shippingCourier || undefined,
    trackingNumber: row.trackingNumber || undefined,
    internalNotes: row.internalNotes || undefined,
    shippedAt: row.shippedAt?.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString(),
    transactionReference: row.transactionReference || undefined,
    mpesaReceiptNumber: row.mpesaReceiptNumber || undefined,
    pesapalTrackingId: row.pesapalTrackingId || undefined,
    dimensionSetId: row.dimensionSetId || null,
    dimensionCodes: row.dimensionCodes || { global: {}, shortcut: {} },
    tradeCustomerId: row.tradeCustomerId || null,
    customerAccountType: (row.customerAccountType as 'cash' | 'credit' | null) || null,
    transmitInvoicesToKra: row.transmitInvoicesToKra,
    salesModule: row.salesModule,
    approvalStatus: row.approvalStatus,
    discounts: row.discounts ?? null,
    tenderedAmount: num(row.tenderedAmount),
    kraTransmissionStatus:
      (row.kraTransmissionStatus as NonNullable<Order['kraTransmissionStatus']>) ||
      'not_applicable',
    currentStage: row.currentStage,
    currentStageSince: row.currentStageSince?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export class OrderRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Saves the order and its lines atomically. When `assignNumber` is given it runs inside the same
   * transaction, so a gap-free order series gives its number back if the save fails.
   */
  async create(
    order: Order,
    branchId?: string | null,
    assignNumber?: (tx: Tx) => Promise<string>,
    /** Runs after the order and its lines are saved, in the same transaction (e.g. asking for approval). */
    afterSave?: (tx: Tx, order: Order) => Promise<void>,
    /** Who placed it and from where: the first event of the order's timeline says so. */
    placed?: { source?: StageSource; actor?: StageActor; startedAt?: Date | null; detail?: Record<string, unknown> },
  ): Promise<Order> {
    return this.db.transaction(async (tx) => {
      if (assignNumber) order.orderNumber = await assignNumber(tx);
      await tx.insert(orders).values({
        id: order.id,
        orderNumber: order.orderNumber,
        userId: order.userId || null,
        branchId: branchId || null,
        customerName: order.customerName,
        customerEmail: order.customerEmail.toLowerCase(),
        customerPhone: order.customerPhone,
        paymentPhone: order.paymentPhone ?? null,
        shippingAddress: order.shippingAddress,
        subtotal: order.subtotal.toFixed(2),
        tax: order.tax.toFixed(2),
        shippingFee: order.shippingFee.toFixed(2),
        totalAmount: order.totalAmount.toFixed(2),
        currency: order.currency,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        // The finance payment method this payment stands for: the branch's own method first, then one for
        // every branch; one through the provider of that code before one that only carries the old code.
        paymentMethodId: sql`(
          SELECT m.id FROM payment_methods m JOIN payment_provider_configs p ON p.id = m.provider_id
          WHERE (m.legacy_codes ? ${order.paymentMethod} OR p.provider_code = ${order.paymentMethod})
            AND (m.branch_id IS NULL OR m.branch_id = ${branchId || null}::uuid)
          ORDER BY m.enabled DESC, (m.branch_id IS NULL) ASC, (p.provider_code = ${order.paymentMethod}) DESC, m.sort_order ASC LIMIT 1)`,
        shippingCourier: order.shippingCourier,
        trackingNumber: order.trackingNumber,
        internalNotes: order.internalNotes,
        transactionReference: order.transactionReference,
        mpesaReceiptNumber: order.mpesaReceiptNumber,
        pesapalTrackingId: order.pesapalTrackingId,
        dimensionSetId: order.dimensionSetId || null,
        dimensionCodes: order.dimensionCodes || { global: {}, shortcut: {} },
        tradeCustomerId: order.tradeCustomerId || null,
        customerAccountType: order.customerAccountType || null,
        transmitInvoicesToKra: order.transmitInvoicesToKra ?? true,
        salesModule: order.salesModule ?? 'ecommerce',
        kraTransmissionStatus: order.kraTransmissionStatus || 'not_applicable',
        approvalStatus: order.approvalStatus ?? 'none',
        discounts: order.discounts ?? null,
        // The first event of the order's timeline is written below, in this transaction.
        stageSeq: 1,
        currentStage: 'order_placed',
        currentStageSince: sql`clock_timestamp()`,
      });
      await OrderStages.placedIn(
        tx,
        {
          id: order.id,
          status: order.status,
          paymentStatus: order.paymentStatus,
          approvalStatus: order.approvalStatus ?? 'none',
          kraTransmissionStatus: order.kraTransmissionStatus ?? 'not_applicable',
          branchId: typeof branchId === 'string' && branchId !== '' ? branchId : null,
        },
        { ...placed, detail: { salesModule: order.salesModule ?? 'ecommerce', paymentMethod: order.paymentMethod, total: order.totalAmount, currency: order.currency, items: order.items.length, ...placed?.detail } },
      );

      if (order.items.length) {
        await tx.insert(orderItems).values(
          order.items.map((item) => ({
            orderId: order.id,
            productId: item.productId,
            productName: item.productName,
            sku: item.sku,
            quantity: item.quantity,
            unitPrice: item.unitPrice.toFixed(2),
            totalPrice: item.totalPrice.toFixed(2),
            imageUrl: item.imageUrl || '',
            priceTrace: item.priceTrace ?? null,
            isGift: item.isGift ?? false,
            unitCost: item.unitCost == null ? null : item.unitCost.toFixed(4),
            unitId: item.unitId ?? null,
            unitCode: item.unitCode ?? null,
            enteredQuantity: item.enteredQuantity ?? null,
            qtyPerUnit: item.qtyPerUnit ?? null,
            enteredUnitPrice: item.enteredUnitPrice == null ? null : item.enteredUnitPrice.toFixed(4),
          })),
        );
      }

      await afterSave?.(tx, order);
      return order;
    });
  }

  async getById(id: string): Promise<Order | null> {
    const rows = await this.db.select().from(orders).where(eq(orders.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const items = await this.loadItems(id);
    return mapOrderRow(row, items);
  }

  async listAll(limit = 500): Promise<Order[]> {
    const rows = await this.db.select().from(orders).orderBy(desc(orders.createdAt)).limit(limit);
    return await this.withItems(rows);
  }

  /**
   * One page of orders, newest first, narrowed by text (order number, customer, phone, email, tracking) and by status. The place to
   * start the next page is the database's own text for the time of the last order, so no microsecond is lost; their items are read in one query.
   */
  async page(input: { query?: string; status?: OrderStatus | null; cursor?: string | null; limit?: number }): Promise<{ rows: Order[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const text = (input.query ?? '').trim().slice(0, 100);
    const found = await this.db
      .select({ row: orders, cursor: sql<string>`${orders.createdAt}::text` })
      .from(orders)
      .where(
        and(
          input.status == null ? undefined : eq(orders.status, input.status),
          matching(text, [orders.orderNumber, orders.customerName, orders.customerPhone, orders.paymentPhone, orders.customerEmail, orders.trackingNumber]),
          after === null ? undefined : sql`(${orders.createdAt}, ${orders.id}) < (${after.k}::timestamptz, ${after.id})`,
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: await this.withItems(page.map((f) => f.row)),
      nextCursor: found.length > limit && last !== undefined ? encodeCursor({ k: last.cursor, id: last.row.id }) : null,
    };
  }

  /**
   * One page of a shopper's own orders, newest first. The shopper is matched on every mark an order may carry
   * (store account, login, email, trade customer); paging uses the same keyset as the admin list.
   */
  async pageForOwner(input: {
    ids: readonly string[];
    tradeCustomerId: string | null;
    cursor?: string | null;
    limit?: number;
  }): Promise<{ rows: Order[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const marks = input.ids.filter((id) => id !== '');
    const mine = or(
      marks.length === 0 ? undefined : inArray(orders.userId, [...marks]),
      input.tradeCustomerId === null ? undefined : eq(orders.tradeCustomerId, input.tradeCustomerId),
    );
    if (mine === undefined) return { rows: [], nextCursor: null };
    const found = await this.db
      .select({ row: orders, cursor: sql<string>`${orders.createdAt}::text` })
      .from(orders)
      .where(and(mine, after === null ? undefined : sql`(${orders.createdAt}, ${orders.id}) < (${after.k}::timestamptz, ${after.id})`))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: await this.withItems(page.map((f) => f.row)),
      nextCursor: found.length > limit && last !== undefined ? encodeCursor({ k: last.cursor, id: last.row.id }) : null,
    };
  }

  async listByUserId(userId: string): Promise<Order[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt));
    return await this.withItems(rows);
  }

  /** The orders with their items, all items read in one query however many orders there are. */
  private async withItems(rows: OrderRow[]): Promise<Order[]> {
    if (rows.length === 0) return [];
    const items = await this.db.select().from(orderItems).where(inArray(orderItems.orderId, rows.map((r) => r.id)));
    const byOrder = new Map<string, OrderItem[]>();
    for (const r of items) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), toItem(r)]);
    return rows.map((row) => mapOrderRow(row, byOrder.get(row.id) ?? []));
  }

  async findByNumberAndContact(orderNumber: string, contact: string): Promise<Order | null> {
    const q = contact.toLowerCase().trim();
    const rows = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.orderNumber, orderNumber.trim()),
          or(eq(orders.customerEmail, q), eq(orders.customerPhone, contact.trim())),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return mapOrderRow(row, await this.loadItems(row.id));
  }

  async update(
    id: string,
    // The stage columns (status, payment status, approval status, KRA status) are not here: only the order stage writer
    // (`OrderStages`) changes them, so every change of stage leaves its event.
    patch: Partial<{
      paymentMethod: PaymentProvider;
      paymentMethodId: string | null;
      paymentPhone: string | null;
      transactionReference: string | null;
      mpesaReceiptNumber: string | null;
      pesapalTrackingId: string | null;
      shippingCourier: string | null;
      trackingNumber: string | null;
      internalNotes: string | null;
      shippedAt: Date | null;
      deliveredAt: Date | null;
    }>,
  ): Promise<Order | null> {
    const [row] = await this.db
      .update(orders)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, id))
      .returning();
    if (!row) return null;
    return mapOrderRow(row, await this.loadItems(id));
  }

  private async loadItems(orderId: string): Promise<OrderItem[]> {
    const rows = await this.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    return rows.map(toItem);
  }
}

function toItem(r: typeof orderItems.$inferSelect): OrderItem {
  return {
    productId: r.productId,
    productName: r.productName,
    sku: r.sku,
    quantity: r.quantity,
    unitPrice: num(r.unitPrice),
    totalPrice: num(r.totalPrice),
    imageUrl: r.imageUrl,
    priceTrace: r.priceTrace ?? null,
    isGift: r.isGift,
    unitCost: r.unitCost == null ? null : Number(r.unitCost),
    unitId: r.unitId,
    unitCode: r.unitCode,
    enteredQuantity: r.enteredQuantity,
    qtyPerUnit: r.qtyPerUnit,
    enteredUnitPrice: r.enteredUnitPrice == null ? null : Number(r.enteredUnitPrice),
  };
}
