/** Addresses that open one order, or the invoice of one order, on the orders screen. */

const ORDER_ID = /^[\w-]{1,100}$/;

export const orderHref = (orderId: string): string => `/admin/orders?order=${encodeURIComponent(orderId)}`;

/** The invoice of that order, opened over the order. */
export const invoiceHref = (orderId: string): string => `${orderHref(orderId)}&invoice=1`;

export interface OrderTarget {
  /** The order the address names, when it is shaped like an order id. */
  orderId: string | null;
  /** The invoice preview was asked for too. */
  invoice: boolean;
}

/** What the orders screen was asked to open. An id that is not shaped like one is ignored, never looked up. */
export function parseOrderTarget(params: { order?: string | string[]; invoice?: string | string[] }): OrderTarget {
  const order = typeof params.order === 'string' && ORDER_ID.test(params.order) ? params.order : null;
  return { orderId: order, invoice: order !== null && params.invoice === '1' };
}
