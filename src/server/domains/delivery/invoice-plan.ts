import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/server/domains/inventory/service';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveryBillingSettings, invoiceDocuments, orderDeliveries, orders, type OrderDeliveryRow } from '@/server/db/drizzle/schema';
import { isDeliveryBillingMode, planInvoices, planProblem, type DeliveryBillingMode, type InvoiceFigures, type InvoicePlan } from '@/lib/delivery-invoicing';

export type PlannedDocument = 'tax_invoice' | 'proforma' | 'delivery_invoice';

export interface OrderInvoicePlan {
  plan: InvoicePlan;
  /** The money of the document asked for. */
  figures: InvoiceFigures;
  delivery: OrderDeliveryRow | null;
  /** The item that stands for the delivery service, when the company has chosen one. */
  serviceProductId: string | null;
  mode: DeliveryBillingMode;
}

/**
 * How an order's money is laid out on its invoices, read from the order, the delivery it was given and the company's choice. The
 * invoice, its email and what is sent to KRA all come from here, so they cannot disagree. A layout that does not add up to the
 * order is refused. A proforma is one request for payment and always shows delivery with the goods.
 */
export async function invoicePlanFor(db: DrizzleDb, companyId: string, orderId: string, documentType: PlannedDocument): Promise<OrderInvoicePlan> {
  const [order] = await db.select({ subtotal: orders.subtotal, tax: orders.tax, shippingFee: orders.shippingFee, totalAmount: orders.totalAmount }).from(orders).where(eq(orders.id, orderId));
  if (order === undefined) throw new Error(`Order ${orderId} not found`);
  const [[delivery], [billing]] = await Promise.all([
    db.select().from(orderDeliveries).where(eq(orderDeliveries.orderId, orderId)),
    db.select().from(deliveryBillingSettings).where(eq(deliveryBillingSettings.companyId, companyId)),
  ]);
  const money = { subtotal: Number(order.subtotal), tax: Number(order.tax), shippingFee: Number(order.shippingFee), totalAmount: Number(order.totalAmount) };
  const mode: DeliveryBillingMode = documentType === 'proforma' ? 'with_goods' : (billing?.mode ?? 'with_goods');
  const plan = planInvoices(money, delivery === undefined ? null : { net: Number(delivery.chargeNet), tax: Number(delivery.chargeTax), gross: Number(delivery.chargeAmount), taxRate: Number(delivery.taxRate) }, mode);
  const problem = planProblem(money, plan);
  if (problem !== null) throw new Error(problem);
  const figures = documentType === 'delivery_invoice' ? plan.deliveryInvoice : plan.main;
  if (figures === null) throw new Error('This order has no separate delivery invoice: its delivery is billed with the goods, or there is no delivery charge.');
  return { plan, figures, delivery: delivery ?? null, serviceProductId: billing?.serviceProductId ?? null, mode };
}

/** How an order's tax invoice was actually laid out when it was issued; null for one issued before delivery had a layout. */
export interface InvoicedLayout {
  mode: DeliveryBillingMode;
  /** The item that stood for the delivery service on that invoice. */
  serviceProductId: string | null;
}

/**
 * What the issued tax invoice did with delivery, read from the invoice itself, not from today's setting. The company can change the
 * setting later; a credit note must reverse what was actually invoiced and signed.
 */
export async function invoicedLayout(db: DrizzleDb | Tx, orderId: string): Promise<InvoicedLayout | null> {
  const [doc] = await db
    .select({ meta: invoiceDocuments.meta })
    .from(invoiceDocuments)
    .where(and(eq(invoiceDocuments.orderId, orderId), eq(invoiceDocuments.documentType, 'tax_invoice')))
    .limit(1);
  const meta = doc?.meta ?? {};
  const mode = meta.deliveryBilling;
  if (!isDeliveryBillingMode(mode)) return null;
  const item = meta.deliveryServiceProductId;
  return { mode, serviceProductId: typeof item === 'string' && item !== '' ? item : null };
}
