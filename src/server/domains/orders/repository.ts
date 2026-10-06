import { and, desc, eq, or } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { orders, orderItems, type OrderRow } from '@/server/db/drizzle/schema';
import type { Order, OrderItem, OrderStatus, PaymentStatus, PaymentProvider } from '@/types/index';

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
    kraTransmissionStatus:
      (row.kraTransmissionStatus as NonNullable<Order['kraTransmissionStatus']>) || 'not_applicable',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class OrderRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(order: Order, branchId?: string | null): Promise<Order> {
    await this.db.insert(orders).values({
      id: order.id,
      orderNumber: order.orderNumber,
      userId: order.userId || null,
      branchId: branchId || null,
      customerName: order.customerName,
      customerEmail: order.customerEmail.toLowerCase(),
      customerPhone: order.customerPhone,
      shippingAddress: order.shippingAddress,
      subtotal: order.subtotal.toFixed(2),
      tax: order.tax.toFixed(2),
      shippingFee: order.shippingFee.toFixed(2),
      totalAmount: order.totalAmount.toFixed(2),
      currency: order.currency,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
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
    });

    if (order.items.length) {
      await this.db.insert(orderItems).values(
        order.items.map((item) => ({
          orderId: order.id,
          productId: item.productId,
          productName: item.productName,
          sku: item.sku,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toFixed(2),
          totalPrice: item.totalPrice.toFixed(2),
          imageUrl: item.imageUrl || '',
        })),
      );
    }

    return order;
  }

  async getById(id: string): Promise<Order | null> {
    const rows = await this.db.select().from(orders).where(eq(orders.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const items = await this.loadItems(id);
    return mapOrderRow(row, items);
  }

  async listAll(limit = 500): Promise<Order[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(limit);
    return Promise.all(
      rows.map(async (row) => mapOrderRow(row, await this.loadItems(row.id))),
    );
  }

  async listByUserId(userId: string): Promise<Order[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt));
    return Promise.all(
      rows.map(async (row) => mapOrderRow(row, await this.loadItems(row.id))),
    );
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
    patch: Partial<{
      status: OrderStatus;
      paymentStatus: PaymentStatus;
      paymentMethod: PaymentProvider;
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
    const rows = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    return rows.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      sku: r.sku,
      quantity: r.quantity,
      unitPrice: num(r.unitPrice),
      totalPrice: num(r.totalPrice),
      imageUrl: r.imageUrl,
    }));
  }
}
