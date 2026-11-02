import type { DeliveryBillingMode } from './delivery-invoicing';

/**
 * What a credit note can reverse of an order's delivery. Pure.
 *
 * Delivery was invoiced one of two ways, and a credit follows what was actually issued (not today's setting):
 *   with_goods  delivery is a line of the goods invoice, so it is credited like any line of that invoice.
 *   separate    delivery has an invoice of its own, so it is credited against that invoice, in a credit note of its own.
 * An order invoiced before delivery had a layout, or with no delivery charge, has nothing of delivery to credit.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface DeliveryCreditTarget {
  mode: DeliveryBillingMode;
  /** The item that stood for the delivery service on the invoice. */
  productId: string;
  description: string;
  /** What the customer paid for delivery, tax included. */
  gross: number;
  net: number;
  tax: number;
}

export function deliveryCreditTarget(
  layout: { mode: DeliveryBillingMode; serviceProductId: string | null } | null,
  delivery: { gross: number; net: number; tax: number } | null,
): DeliveryCreditTarget | null {
  const productId = layout?.serviceProductId ?? null;
  if (layout === null || productId === null || delivery === null || !(delivery.gross > 0)) return null;
  return { mode: layout.mode, productId, description: 'Delivery', gross: delivery.gross, net: delivery.net, tax: delivery.tax };
}

/** The total of the goods invoice: the whole order, less delivery when delivery has an invoice of its own. */
export function goodsInvoiceTotal(orderTotal: number, target: DeliveryCreditTarget | null): number {
  return target?.mode === 'separate' ? round2(orderTotal - target.gross) : orderTotal;
}

/** Whether a credited line is the delivery line (and so has no goods to return, no rebate and no loyalty points). */
export const isDeliveryLine = (productId: string, target: DeliveryCreditTarget | null): boolean => target?.mode === 'with_goods' && target.productId === productId;
